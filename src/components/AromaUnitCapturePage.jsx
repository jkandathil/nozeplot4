import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Usb, Radio, Square, Plug, ScanSearch } from 'lucide-react';
import {
    AU_DEVICE_PROFILES,
    getAuProfile,
    normalizeCaptureRows,
    drainJsonObjectsFromBuffer,
    describePartialSerialBuffer,
    hasIncompleteLeadingJsonObject,
    coerceCaptureRowsSn,
    captureRowHasSensorValues,
    dropSensorColumnsEmptyInAllRows,
    auDeviceFolderNameFromSn,
} from '../utils/siacDeviceProfiles';
import {
    scanProbeSerialPort,
    getSerialPlatformTiming,
    delay as serialDelay,
    primeSerialPortForSiAcRead,
    openSerialPortForSiAc,
    readSiAcPortUtf8Until,
} from '../utils/siacSerialProbe';
import { buildAuCaptureFileName } from '../utils/auCaptureFilename.js';
import './AromaUnitCapturePage.css';

function webSerialSupported() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
}

export default function AromaUnitCapturePage({ onSaveToWorkspace }) {
    const [profileKey, setProfileKey] = useState('SIAC32_V2');
    const profile = getAuProfile(profileKey);
    const serialOpenOpts = useMemo(
        () => ({
            baudRate: profile.baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            flowControl: 'none',
        }),
        [profile.baudRate]
    );
    /** Avoid Windows `bufferSize` on long capture opens — can yield 0 bytes on some CDC stacks; scan still uses large buffer. */
    const captureOpenExtra = useMemo(() => ({ useLargeRxBuffer: false }), []);
    /** String so the field can be cleared while editing; parsed when capture starts. */
    const [durationSecStr, setDurationSecStr] = useState('60');
    const [portHint, setPortHint] = useState('');
    const [connected, setConnected] = useState(false);
    const [recording, setRecording] = useState(false);
    const [lineCount, setLineCount] = useState(0);
    const [parseErrors, setParseErrors] = useState(0);
    const [error, setError] = useState('');
    const [lastPreview, setLastPreview] = useState('');
    const [lastParseHint, setLastParseHint] = useState('');
    const [savedOk, setSavedOk] = useState('');
    const [scanning, setScanning] = useState(false);
    const [discovered, setDiscovered] = useState([]);
    const [selectedKey, setSelectedKey] = useState(null);
    const [multiAuCapture, setMultiAuCapture] = useState(false);
    const [selectedKeysForMulti, setSelectedKeysForMulti] = useState([]);

    const portRef = useRef(null);
    const portByKeyRef = useRef(new Map());
    const rowsRef = useRef([]);
    const stopRef = useRef(false);
    const readerRef = useRef(null);
    const multiReadersRef = useRef([]);
    const multiLineTickRef = useRef(0);
    const captureProgressWindowRef = useRef(null);
    const [captureProgressPct, setCaptureProgressPct] = useState(0);
    const [captureSecsLeft, setCaptureSecsLeft] = useState(0);
    /** Multi-AU: true while opening ports before the timed collection window. */
    const [captureOpening, setCaptureOpening] = useState(false);

    useEffect(() => {
        const valid = new Set(discovered.map((d) => d.key));
        setSelectedKeysForMulti((prev) => prev.filter((k) => valid.has(k)));
    }, [discovered]);

    useEffect(() => {
        if (!recording) {
            setCaptureProgressPct(0);
            setCaptureSecsLeft(0);
            setCaptureOpening(false);
            captureProgressWindowRef.current = null;
            return;
        }
        const tick = () => {
            if (captureOpening) return;
            const w = captureProgressWindowRef.current;
            if (!w || w.endMs <= w.startMs) return;
            const now = Date.now();
            const span = w.endMs - w.startMs;
            const pct = Math.min(100, Math.max(0, ((now - w.startMs) / span) * 100));
            const secsLeft = Math.max(0, Math.ceil((w.endMs - now) / 1000));
            setCaptureProgressPct(pct);
            setCaptureSecsLeft(secsLeft);
        };
        tick();
        const id = setInterval(tick, 120);
        return () => clearInterval(id);
    }, [recording, captureOpening]);

    const releaseReader = useCallback(async () => {
        const r = readerRef.current;
        readerRef.current = null;
        if (!r) return;
        try {
            await r.cancel();
        } catch {
            /* ignore */
        }
        try {
            r.releaseLock();
        } catch {
            /* ignore */
        }
    }, []);

    const disconnectPort = useCallback(async () => {
        await releaseReader();
        const t = getSerialPlatformTiming();
        await serialDelay(t.afterReaderReleasedMs);
        try {
            await portRef.current?.close();
        } catch {
            /* ignore */
        }
        await serialDelay(t.afterPortCloseMs);
        portRef.current = null;
        setConnected(false);
        setPortHint('');
        setSelectedKey(null);
    }, [releaseReader]);

    useEffect(() => () => {
        disconnectPort();
    }, [disconnectPort]);

    const fmtVidPid = (info) => {
        const vid =
            info.usbVendorId != null ? `0x${info.usbVendorId.toString(16).padStart(4, '0')}` : '—';
        const pid =
            info.usbProductId != null ? `0x${info.usbProductId.toString(16).padStart(4, '0')}` : '—';
        return `VID ${vid} · PID ${pid}`;
    };

    const runDeviceScan = async () => {
        setError('');
        setSavedOk('');
        if (!webSerialSupported()) {
            setError(
                'Web Serial is not available. Use Chrome or Edge on HTTPS or localhost, and allow the port when prompted.'
            );
            return;
        }
        if (profile.disabled || !profile.parseLine) {
            setError('This device profile is not available yet.');
            return;
        }
        setScanning(true);
        try {
            await disconnectPort();
            const ports = await navigator.serial.getPorts();
            if (ports.length === 0) {
                setDiscovered([]);
                portByKeyRef.current = new Map();
                setError(
                    'No USB serial devices are linked to this site yet. Use “Link USB device” once per cable (browser security), then scan again.'
                );
                return;
            }

            const map = new Map();
            const rows = [];
            const base = Date.now();

            for (let i = 0; i < ports.length; i++) {
                const port = ports[i];
                const key = `${base}-${i}`;
                const vidPid = fmtVidPid(port.getInfo?.() || {});
                map.set(key, port);
                const { sn, error: probeError } = await scanProbeSerialPort(port, serialOpenOpts);
                rows.push({
                    key,
                    sn,
                    vidPid,
                    error: probeError,
                });
            }

            portByKeyRef.current = map;
            setDiscovered(rows);
        } catch (e) {
            setError(e?.message || 'Scan failed.');
        } finally {
            setScanning(false);
        }
    };

    const linkNewUsbDevice = async () => {
        setError('');
        setSavedOk('');
        if (!webSerialSupported()) {
            setError(
                'Web Serial is not available. Use Chrome or Edge on HTTPS or localhost, and allow the port when prompted.'
            );
            return;
        }
        if (profile.disabled || !profile.parseLine) {
            setError('This device profile is not available yet.');
            return;
        }
        try {
            await navigator.serial.requestPort();
            const t = getSerialPlatformTiming();
            if (t.win) {
                await serialDelay(150);
            }
            await runDeviceScan();
        } catch (e) {
            if (e?.name === 'NotFoundError') return;
            setError(e?.message || 'Could not link USB device.');
        }
    };

    const selectDiscoveredDevice = async (row) => {
        setError('');
        setSavedOk('');
        if (!webSerialSupported() || profile.disabled || !profile.parseLine || recording) return;
        const port = portByKeyRef.current.get(row.key);
        if (!port) {
            setError('That port is no longer available. Run Scan again.');
            return;
        }
        try {
            await disconnectPort();
            const t = getSerialPlatformTiming();
            try {
                await port.close();
            } catch {
                /* ignore */
            }
            await serialDelay(t.postCloseBeforeOpenMs);
            await openSerialPortForSiAc(port, serialOpenOpts, captureOpenExtra);
            await primeSerialPortForSiAcRead(port);
            portRef.current = port;
            setConnected(true);
            setSelectedKey(row.key);
            if (row.sn) {
                setPortHint(`AU ID: ${row.sn} · ${profile.baudRate} baud (${row.vidPid})`);
            } else if (row.error) {
                setPortHint(
                    `Connected @ ${profile.baudRate} baud (${row.vidPid}) — scan issue: ${row.error}. Try capture if the unit is streaming.`
                );
            } else {
                setPortHint(
                    `Connected @ ${profile.baudRate} baud (${row.vidPid}) — AU ID not read during scan; use Start capture when the unit is sending JSON.`
                );
            }
        } catch (e) {
            setError(e?.message || 'Could not open this port.');
            setConnected(false);
            setSelectedKey(null);
            setPortHint('');
        }
    };

    const toggleMultiKey = (key) => {
        setSelectedKeysForMulti((prev) =>
            prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
        );
    };

    const stopCapture = () => {
        stopRef.current = true;
        readerRef.current?.cancel?.();
        for (const r of multiReadersRef.current) {
            try {
                r.cancel();
            } catch {
                /* ignore */
            }
        }
    };

    const startRecording = async () => {
        setError('');
        setSavedOk('');
        if (profile.disabled || !profile.parseLine) {
            setError('This device profile is not supported yet.');
            return;
        }
        const parsed = parseInt(durationSecStr, 10);
        const sec = Math.max(1, Math.min(86400, Number.isFinite(parsed) ? parsed : 60));
        const parseLine = profile.parseLine;

        if (multiAuCapture) {
            const keys = [...selectedKeysForMulti];
            if (keys.length === 0) {
                setError('Select one or more AUs (checkboxes) for simultaneous capture, or turn off multi-AU mode and connect one port.');
                return;
            }

            rowsRef.current = [];
            setLineCount(0);
            setParseErrors(0);
            setLastPreview('');
            setLastParseHint('');
            stopRef.current = false;
            multiReadersRef.current = [];
            multiLineTickRef.current = 0;
            setCaptureOpening(true);
            setRecording(true);

            const bumpLines = () => {
                multiLineTickRef.current += 1;
                if (multiLineTickRef.current % 20 === 0) {
                    setLineCount(multiLineTickRef.current);
                }
            };

            /**
             * Open + prime all ports in parallel. (A previous Windows-only sequential open left earlier
             * ports streaming with no `getReader()` for hundreds of ms per extra AU — CDC buffers overflow → 0 bytes.)
             */
            const openAllPorts = async () => {
                const t = getSerialPlatformTiming();
                const openOne = async (key) => {
                    const port = portByKeyRef.current.get(key);
                    if (!port) {
                        return { key, port: null, error: 'Port no longer available — scan again.' };
                    }
                    try {
                        try {
                            await port.close();
                        } catch {
                            /* ignore */
                        }
                        await serialDelay(t.postCloseBeforeOpenMs);
                        await openSerialPortForSiAc(port, serialOpenOpts, captureOpenExtra);
                        await primeSerialPortForSiAcRead(port);
                        return { key, port, error: null };
                    } catch (e) {
                        try {
                            await port.close();
                        } catch {
                            /* ignore */
                        }
                        await serialDelay(t.afterPortCloseMs);
                        return {
                            key,
                            port: null,
                            error: e?.message || 'Could not open port',
                        };
                    }
                };
                return Promise.all(keys.map((key) => openOne(key)));
            };

            const readFromOpenedPort = async (key, port, endAt) => {
                const rows = [];
                let localParseErrors = 0;
                let buffer = '';
                let bytesIn = 0;
                let orphanTail = '';
                try {
                    const consumeBuffer = (isFinal) => {
                        const { chunks, rest } = drainJsonObjectsFromBuffer(buffer);
                        for (const jsonStr of chunks) {
                            const ts = new Date().toISOString();
                            try {
                                const row = parseLine(jsonStr, ts);
                                if (row && captureRowHasSensorValues(row)) {
                                    rows.push(row);
                                    bumpLines();
                                    if (rows.length % 5 === 0) {
                                        setLastPreview(JSON.stringify(rows[rows.length - 1]).slice(0, 280));
                                    }
                                }
                            } catch (e) {
                                localParseErrors += 1;
                                setParseErrors((x) => x + 1);
                                const msg = e?.message || 'parse error';
                                const bit = jsonStr.slice(0, 120);
                                setLastParseHint(`${msg} — sample: ${bit}${jsonStr.length > 120 ? '…' : ''}`);
                            }
                        }
                        if (isFinal) {
                            orphanTail = rest;
                            buffer = '';
                        } else {
                            buffer = rest;
                        }
                    };

                    const r = await readSiAcPortUtf8Until(port, {
                        endAt,
                        shouldStop: () => stopRef.current,
                        registerInMultiListRef: multiReadersRef,
                        onChunk: (text) => {
                            buffer += text;
                            consumeBuffer(false);
                        },
                    });
                    bytesIn = r.bytesIn;
                    const tGrace = getSerialPlatformTiming();
                    const graceMs = tGrace.win ? 6000 : 4000;
                    if (hasIncompleteLeadingJsonObject(buffer)) {
                        const r2 = await readSiAcPortUtf8Until(port, {
                            endAt: Date.now() + graceMs,
                            shouldStop: () => stopRef.current,
                            registerInMultiListRef: multiReadersRef,
                            onChunk: (text) => {
                                buffer += text;
                                consumeBuffer(false);
                            },
                        });
                        bytesIn += r2.bytesIn;
                    }
                    consumeBuffer(true);
                } catch (e) {
                    return {
                        key,
                        rows,
                        parseErrors: localParseErrors,
                        error: e?.message || 'Serial read failed.',
                        bytesIn,
                        orphanTail: orphanTail || buffer,
                    };
                } finally {
                    const t = getSerialPlatformTiming();
                    await serialDelay(t.afterReaderReleasedMs);
                    try {
                        await port.close();
                    } catch {
                        /* ignore */
                    }
                    await serialDelay(t.afterPortCloseMs);
                }
                return { key, rows, parseErrors: localParseErrors, error: null, bytesIn, orphanTail };
            };

            try {
                const opened = await openAllPorts();
                if (stopRef.current) {
                    for (const o of opened) {
                        if (o.port) {
                            try {
                                await o.port.close();
                            } catch {
                                /* ignore */
                            }
                        }
                    }
                    await serialDelay(getSerialPlatformTiming().afterPortCloseMs);
                    setLineCount(0);
                    setError('Capture stopped before recording started.');
                    return;
                }

                const endAt = Date.now() + sec * 1000;
                captureProgressWindowRef.current = { startMs: Date.now(), endMs: endAt };
                setCaptureOpening(false);

                const results = await Promise.all(
                    opened.map((o) =>
                        o.port && !o.error
                            ? readFromOpenedPort(o.key, o.port, endAt)
                            : Promise.resolve({
                                  key: o.key,
                                  rows: [],
                                  parseErrors: 0,
                                  bytesIn: 0,
                                  orphanTail: '',
                                  error: o.error || 'Port not opened',
                              })
                    )
                );
                setLineCount(multiLineTickRef.current);

                const savingAt = new Date();

                const saves = [];
                const failures = [];
                const labelForKey = (key) => {
                    const d = discovered.find((x) => x.key === key);
                    if (!d) return 'one AU';
                    if (d.sn) return `AU ${d.sn}`;
                    return d.vidPid || 'one AU';
                };
                for (const res of results) {
                    if (res.error && res.rows.length === 0) {
                        failures.push(`${labelForKey(res.key)}: ${res.error}`);
                        continue;
                    }
                    if (res.rows.length === 0) {
                        const who = labelForKey(res.key);
                        const b = res.bytesIn ?? 0;
                        if (res.parseErrors > 0) {
                            failures.push(
                                `${who}: ${b} byte(s), no valid rows (${res.parseErrors} parse errors). Check profile/firmware or baud ${profile.baudRate}.`
                            );
                        } else if (b === 0) {
                            failures.push(
                                `${who}: 0 bytes in this window — Chrome read nothing from that COM port. Check ${profile.baudRate} baud, cable/USB, and that no other app uses the port; try one AU only to rule out hub/driver limits.`
                            );
                        } else {
                            const rawPrev = describePartialSerialBuffer(res.orphanTail || '');
                            const seen = rawPrev ? ` Unparsed tail: ${rawPrev}.` : '';
                            if (b <= 16) {
                                failures.push(
                                    `${who}: only ${b} raw byte(s) in the whole window — stream never delivered a full JSON object.${seen} Typical causes: another program using the same COM port, USB hub power, wrong baud (SiAC32-V2 uses ${profile.baudRate}), or capturing several AUs at once on Windows starving one port. Try one AU, close other serial tools, longer window, or a different USB socket.`
                                );
                            } else {
                                failures.push(
                                    `${who}: ${b} byte(s) but no complete {"sn":…} row.${seen} SiAC frames can be large; the stream may have ended mid-object — use a longer collection window or one AU at a time.`
                                );
                            }
                        }
                        continue;
                    }
                    const meaningfulMulti = res.rows.filter(captureRowHasSensorValues);
                    if (meaningfulMulti.length === 0) {
                        failures.push(
                            `${labelForKey(res.key)}: ${res.rows.length} JSON object(s) with no channel data (empty payload) — skipped.`
                        );
                        continue;
                    }
                    const scanSn = discovered.find((x) => x.key === res.key)?.sn ?? '';
                    const rowsWithSn = coerceCaptureRowsSn(meaningfulMulti, scanSn);
                    const { data } = normalizeCaptureRows(rowsWithSn);
                    const dataToSave = dropSensorColumnsEmptyInAllRows(data);
                    const folderName = auDeviceFolderNameFromSn(dataToSave[0]?.sn);
                    const fileName = buildAuCaptureFileName(dataToSave, savingAt);
                    try {
                        await onSaveToWorkspace({
                            folderName,
                            data: dataToSave,
                            savingAtMs: savingAt.getTime(),
                        });
                        saves.push({
                            folderName,
                            fileName,
                            rows: dataToSave.length,
                            cols: Object.keys(dataToSave[0] || {}).length,
                        });
                    } catch (err) {
                        failures.push(err?.message || 'Save failed');
                    }
                }

                if (saves.length === 0) {
                    setError(
                        failures[0] ||
                            'No data saved. Check wiring, baud rate, or try a longer window for each AU.'
                    );
                } else {
                    const ok = saves
                        .map(
                            (s) =>
                                `"${s.folderName}"/${s.fileName} (${s.rows} rows, ${s.cols} cols)`
                        )
                        .join(' · ');
                    setSavedOk(
                        `${saves.length} file(s) saved (AU_ID + same save time in each name): ${ok}. Each row is one complete JSON message from that AU; collection was ${sec}s on the wire per port after open.${
                            failures.length ? ` — note: ${failures.slice(0, 5).join('; ')}` : ''
                        }`
                    );
                }
            } catch (e) {
                setError(e?.message || 'Multi-AU capture failed.');
            } finally {
                captureProgressWindowRef.current = null;
                multiReadersRef.current = [];
                portRef.current = null;
                setConnected(false);
                setRecording(false);
                setSelectedKey(null);
                setPortHint('');
                await serialDelay(getSerialPlatformTiming().afterPortCloseMs);
            }
            return;
        }

        const port = portRef.current;
        if (!port) {
            setError('Connect a serial port first (USB aroma unit).');
            return;
        }

        rowsRef.current = [];
        setLineCount(0);
        setParseErrors(0);
        setLastPreview('');
        setLastParseHint('');
        stopRef.current = false;
        setRecording(true);

        let buffer = '';
        let bytesIn = 0;
        let captureParseErrors = 0;
        let orphanTail = '';

        try {
            const tOpen = getSerialPlatformTiming();
            try {
                await port.close();
            } catch {
                /* ignore */
            }
            await serialDelay(tOpen.postCloseBeforeOpenMs);
            await openSerialPortForSiAc(port, serialOpenOpts, captureOpenExtra);
            await primeSerialPortForSiAcRead(port);

            /** Full `sec` seconds of reading start only after USB is open + primed (not before). */
            const readEndAt = Date.now() + sec * 1000;
            captureProgressWindowRef.current = { startMs: Date.now(), endMs: readEndAt };

            const consumeBuffer = (isFinal) => {
                const { chunks, rest } = drainJsonObjectsFromBuffer(buffer);
                for (const jsonStr of chunks) {
                    const ts = new Date().toISOString();
                    try {
                        const row = parseLine(jsonStr, ts);
                        if (row && captureRowHasSensorValues(row)) {
                            rowsRef.current.push(row);
                            const n = rowsRef.current.length;
                            if (n % 10 === 0) setLineCount(n);
                            if (n % 5 === 0) {
                                const last = rowsRef.current[n - 1];
                                setLastPreview(JSON.stringify(last).slice(0, 280));
                            }
                        }
                    } catch (e) {
                        captureParseErrors += 1;
                        setParseErrors((x) => x + 1);
                        const msg = e?.message || 'parse error';
                        const bit = jsonStr.slice(0, 120);
                        setLastParseHint(`${msg} — sample: ${bit}${jsonStr.length > 120 ? '…' : ''}`);
                    }
                }
                if (isFinal) {
                    orphanTail = rest;
                    buffer = '';
                } else {
                    buffer = rest;
                }
            };

            const r = await readSiAcPortUtf8Until(port, {
                endAt: readEndAt,
                shouldStop: () => stopRef.current,
                registerForCancelRef: readerRef,
                onChunk: (text) => {
                    buffer += text;
                    consumeBuffer(false);
                    setLineCount(rowsRef.current.length);
                },
            });
            bytesIn = r.bytesIn;
            const tGraceSingle = getSerialPlatformTiming();
            const graceMsSingle = tGraceSingle.win ? 6000 : 4000;
            if (hasIncompleteLeadingJsonObject(buffer)) {
                const r2 = await readSiAcPortUtf8Until(port, {
                    endAt: Date.now() + graceMsSingle,
                    shouldStop: () => stopRef.current,
                    registerForCancelRef: readerRef,
                    onChunk: (text) => {
                        buffer += text;
                        consumeBuffer(false);
                        setLineCount(rowsRef.current.length);
                    },
                });
                bytesIn += r2.bytesIn;
            }
            consumeBuffer(true);
            setLineCount(rowsRef.current.length);
        } catch (e) {
            setError(e?.message || 'Serial read failed.');
        } finally {
            captureProgressWindowRef.current = null;
            await releaseReader();
            const t = getSerialPlatformTiming();
            await serialDelay(t.afterReaderReleasedMs);
            try {
                await port.close();
            } catch {
                /* ignore */
            }
            await serialDelay(t.afterPortCloseMs);
            portRef.current = null;
            setConnected(false);
            setRecording(false);
            setSelectedKey(null);
        }

        const rawRows = rowsRef.current;
        if (rawRows.length === 0) {
            setError((prev) => {
                if (prev) return prev;
                if (bytesIn === 0) {
                    return `No data captured: 0 bytes in ${sec}s. Port is silent (device not streaming, wrong baud — use ${profile.baudRate} for ${profile.label}, bad cable, or wrong COM device).`;
                }
                if (captureParseErrors > 0) {
                    return `No valid rows: ${bytesIn} byte(s) and ${captureParseErrors} parse error(s). Data may not be SiAC32-V2 JSON. Check the parse hint below or device firmware.`;
                }
                const tail = describePartialSerialBuffer(orphanTail);
                const seen = tail ? ` Unparsed tail: ${tail}.` : '';
                if (bytesIn <= 16) {
                    return `No complete JSON: only ${bytesIn} raw byte(s) in ${sec}s.${seen} Often: another app on the same COM port, wrong baud (${profile.baudRate} for ${profile.label}), USB hub, or multi-AU capture starving a port on Windows — try one AU, close serial terminals, different USB port, longer window.`;
                }
                return `No complete JSON row: ${bytesIn} byte(s) received.${seen} SiAC frames can be large; if the tail shows "sn" mid-object, the frame was cut off — use a longer collection window (the app already waits a few extra seconds when it sees an unfinished object).`;
            });
            return;
        }

        const rowsForSave = rawRows.filter(captureRowHasSensorValues);
        if (rowsForSave.length === 0) {
            setError(
                `Received ${rawRows.length} JSON object(s) in ${sec}s with timestamp/serial only — no channel readings (CHR/RRF). Those lines are not saved; check the device stream.`
            );
            return;
        }

        const scanSnSingle = discovered.find((x) => x.key === selectedKey)?.sn ?? '';
        const rowsWithSnSingle = coerceCaptureRowsSn(rowsForSave, scanSnSingle);
        const { data } = normalizeCaptureRows(rowsWithSnSingle);
        const dataToSave = dropSensorColumnsEmptyInAllRows(data);
        const folderName = auDeviceFolderNameFromSn(dataToSave[0]?.sn);
        const savingAt = new Date();
        const fileName = buildAuCaptureFileName(dataToSave, savingAt);

        try {
            await onSaveToWorkspace({
                folderName,
                data: dataToSave,
                savingAtMs: savingAt.getTime(),
            });
            setSavedOk(
                `Saved to workspace folder "${folderName}" as ${fileName} (${dataToSave.length} rows, ${Object.keys(dataToSave[0] || {}).length} columns). Only rows with channel data are saved. Collection ran ${sec}s on the wire after the port was ready.`
            );
        } catch (err) {
            setError(err?.message || 'Failed to save to workspace.');
        }
    };

    return (
        <div className="au-capture-page">
            <header className="au-capture-header">
                <div className="au-capture-title">
                    <Radio size={20} />
                    Aroma unit (serial)
                </div>
            </header>
            <div className="au-capture-body">
                <div className="au-capture-card">
                    <h3>Device</h3>
                    <div className="au-field">
                        <label htmlFor="au-profile">Model</label>
                        <select
                            id="au-profile"
                            value={profileKey}
                            onChange={(e) => setProfileKey(e.target.value)}
                            disabled={recording}
                        >
                            {Object.entries(AU_DEVICE_PROFILES).map(([key, p]) => (
                                <option key={key} value={key} disabled={!!p.disabled}>
                                    {p.label}
                                    {p.disabled ? ' — coming later' : ''}
                                </option>
                            ))}
                        </select>
                        {profile.disabled && profile.hint ? <p className="au-hint">{profile.hint}</p> : null}
                    </div>
                    <div className="au-field">
                        <label htmlFor="au-duration">Collection window (seconds)</label>
                        <input
                            id="au-duration"
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            autoComplete="off"
                            value={durationSecStr}
                            onChange={(e) => {
                                const v = e.target.value;
                                if (v === '' || /^\d+$/.test(v)) {
                                    setDurationSecStr(v);
                                }
                            }}
                            onBlur={() => {
                                const n = parseInt(durationSecStr, 10);
                                if (!Number.isFinite(n) || durationSecStr === '') {
                                    setDurationSecStr('60');
                                    return;
                                }
                                const clamped = Math.max(1, Math.min(86400, n));
                                setDurationSecStr(String(clamped));
                            }}
                            disabled={recording}
                        />
                        <p className="au-hint">
                            How long we read from the port after USB open + wake (not including that setup). Each saved
                            row is one complete JSON object from the AU — big/slow frames produce fewer rows per minute
                            than wall-clock seconds.
                        </p>
                    </div>
                </div>

                <div className="au-capture-card">
                    <h3>Serial (Web Serial API)</h3>
                    <p className="au-status">
                        {webSerialSupported() ? (
                            <>
                                <strong>Link</strong> each USB cable once (browser picker), then <strong>Scan</strong> to
                                list AUs. SiAC: <strong>115200</strong> 8N1. Click a row to connect one unit, or use{' '}
                                <strong>multi-AU</strong> below to record several with one timer. While capturing, you can
                                open the <strong>dashboard</strong>, <strong>Normalize</strong>, or other pages — collection
                                keeps running; return here to see progress and results.
                            </>
                        ) : (
                            <strong>This browser does not expose Web Serial.</strong>
                        )}
                    </p>
                    <label className="au-multi-toggle">
                        <input
                            type="checkbox"
                            checked={multiAuCapture}
                            onChange={(e) => {
                                const on = e.target.checked;
                                if (on) disconnectPort();
                                else setSelectedKeysForMulti([]);
                                setMultiAuCapture(on);
                            }}
                            disabled={recording || scanning || profile.disabled}
                        />
                        <span>Multi-AU capture</span>
                    </label>
                    <div className="au-btn-row">
                        <button
                            type="button"
                            className="au-btn au-btn-secondary"
                            onClick={linkNewUsbDevice}
                            disabled={recording || scanning || !webSerialSupported() || profile.disabled}
                        >
                            <Plug size={16} />
                            Link USB device…
                        </button>
                        <button
                            type="button"
                            className="au-btn au-btn-secondary"
                            onClick={runDeviceScan}
                            disabled={recording || scanning || !webSerialSupported() || profile.disabled}
                        >
                            <ScanSearch size={16} />
                            {scanning ? 'Scanning…' : 'Scan for aroma units'}
                        </button>
                        <button
                            type="button"
                            className="au-btn au-btn-primary"
                            onClick={startRecording}
                            disabled={
                                recording ||
                                profile.disabled ||
                                (multiAuCapture
                                    ? selectedKeysForMulti.length === 0
                                    : !connected)
                            }
                        >
                            <Usb size={16} />
                            {multiAuCapture && selectedKeysForMulti.length > 0
                                ? `Start capture (${selectedKeysForMulti.length} AUs)`
                                : 'Start capture'}
                        </button>
                        {recording ? (
                            <button type="button" className="au-btn au-btn-danger" onClick={stopCapture}>
                                <Square size={16} />
                                Stop early
                            </button>
                        ) : null}
                    </div>
                    {discovered.length > 0 ? (
                        <div className="au-device-list" aria-label="Detected aroma units">
                            <div className="au-device-list-header">
                                <div className="au-device-list-title">
                                    {multiAuCapture
                                        ? 'Select AUs (checked = included in next capture)'
                                        : 'Detected ports (click to connect)'}
                                </div>
                                {multiAuCapture ? (
                                    <div className="au-device-list-actions">
                                        <button
                                            type="button"
                                            className="au-link-btn"
                                            onClick={() =>
                                                setSelectedKeysForMulti(discovered.map((d) => d.key))
                                            }
                                            disabled={recording || scanning || profile.disabled}
                                        >
                                            Select all
                                        </button>
                                        <button
                                            type="button"
                                            className="au-link-btn"
                                            onClick={() => setSelectedKeysForMulti([])}
                                            disabled={
                                                recording ||
                                                scanning ||
                                                profile.disabled ||
                                                selectedKeysForMulti.length === 0
                                            }
                                        >
                                            Clear
                                        </button>
                                    </div>
                                ) : null}
                            </div>
                            {discovered.map((d) => {
                                const checked = selectedKeysForMulti.includes(d.key);
                                const body = (
                                    <>
                                        <div className="au-device-row-main">
                                            {d.sn ? (
                                                <>
                                                    <span className="au-device-sn">{d.sn}</span>
                                                    <span className="au-device-sub">AU ID</span>
                                                </>
                                            ) : (
                                                <>
                                                    <span className="au-device-sn au-device-sn--muted">
                                                        {d.error ? 'Port error' : 'AU ID not detected'}
                                                    </span>
                                                    <span className="au-device-sub">
                                                        {d.error || 'Power the unit or check baud'}
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                        <div className="au-device-row-meta">{d.vidPid}</div>
                                    </>
                                );
                                if (multiAuCapture) {
                                    return (
                                        <label
                                            key={d.key}
                                            className={`au-device-row au-device-row--multi${
                                                checked ? ' au-device-row--checked' : ''
                                            }`}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={() => toggleMultiKey(d.key)}
                                                disabled={recording || scanning || profile.disabled}
                                                aria-label={`Include ${d.sn || 'port'} in multi capture`}
                                            />
                                            <div className="au-device-row-body">{body}</div>
                                        </label>
                                    );
                                }
                                return (
                                    <button
                                        key={d.key}
                                        type="button"
                                        className={`au-device-row${
                                            selectedKey === d.key ? ' au-device-row--selected' : ''
                                        }`}
                                        onClick={() => selectDiscoveredDevice(d)}
                                        disabled={recording || scanning || profile.disabled}
                                    >
                                        {body}
                                    </button>
                                );
                            })}
                        </div>
                    ) : null}
                    {portHint ? (
                        <p className="au-status" style={{ marginTop: 10 }}>
                            <strong>Status:</strong> {connected ? 'Port open — ' : ''}
                            {portHint}
                        </p>
                    ) : null}
                    {error ? <p className="au-error">{error}</p> : null}
                    {savedOk ? <p className="au-status" style={{ color: '#34d399' }}>{savedOk}</p> : null}
                </div>

                <div className="au-capture-card">
                    <h3>Session</h3>
                    <p className="au-status">
                        <strong>Lines stored:</strong> {lineCount}
                        {parseErrors > 0 ? (
                            <>
                                {' '}
                                · <strong>Parse errors:</strong> {parseErrors}
                            </>
                        ) : null}
                    </p>
                    {recording ? (
                        <div
                            className="au-collection-progress"
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={captureOpening ? undefined : Math.round(captureProgressPct)}
                            aria-label={captureOpening ? 'Opening serial ports' : 'Collection time remaining'}
                        >
                            <div className="au-collection-progress-top">
                                <span className="au-collection-progress-title">
                                    {captureOpening ? 'Opening ports…' : 'Collecting'}
                                </span>
                                {!captureOpening ? (
                                    <span className="au-collection-progress-stats">
                                        {Math.round(captureProgressPct)}% · {captureSecsLeft}s left
                                    </span>
                                ) : null}
                            </div>
                            <div
                                className={`au-collection-progress-track${
                                    captureOpening ? ' au-collection-progress-track--busy' : ''
                                }`}
                            >
                                {captureOpening ? (
                                    <div className="au-collection-progress-indeterminate" />
                                ) : (
                                    <div
                                        className="au-collection-progress-fill"
                                        style={{ width: `${captureProgressPct}%` }}
                                    />
                                )}
                            </div>
                        </div>
                    ) : null}
                    {recording ? (
                        <p className="au-hint">
                            {multiAuCapture
                                ? 'Recording from all selected AUs in parallel with the same start and stop time (full window on each). Stop early closes every port.'
                                : 'Recording… use Stop early or wait for the timer. The port closes after capture; scan again and select the same AU for another run.'}
                        </p>
                    ) : null}
                    {lastPreview ? <div className="au-preview">{lastPreview}</div> : null}
                    {lastParseHint ? <p className="au-error" style={{ marginTop: 8 }}>{lastParseHint}</p> : null}
                </div>
            </div>
        </div>
    );
}
