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
import { writeSiac64RpcLine, clampTelemetryPeriodMs } from '../utils/siac64RpcSerial';
import {
    buildSiAc64SetPumpFlowPayload,
    buildSiAc64PumpDisablePayload,
    buildSiAc64PumpQueryPayload,
    clampTargetFlowCcm,
} from '../utils/siac64PumpRpc';
import { buildAuCaptureFileName } from '../utils/auCaptureFilename.js';
import './AromaUnitCapturePage.css';

function webSerialSupported() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
}

export default function AromaUnitCapturePage({ onSaveToWorkspace }) {
    const [profileKey, setProfileKey] = useState('SIAC64_V03_RPC');
    const profile = getAuProfile(profileKey);
    const [baudRate, setBaudRate] = useState(profile.baudRate);

    const serialOpenOpts = useMemo(
        () => ({
            baudRate: baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            flowControl: 'none',
        }),
        [baudRate]
    );
    /** Avoid Windows `bufferSize` on long capture opens — can yield 0 bytes on some CDC stacks; scan still uses large buffer. */
    const captureOpenExtra = useMemo(() => ({ useLargeRxBuffer: false }), []);
    const [savedEvents, setSavedEvents] = useState(() => {
        try {
            const saved = localStorage.getItem('auSavedEvents');
            if (saved) return JSON.parse(saved);
        } catch { /* ignore */ }
        return ['Baseline', 'FeNoWindow', 'FeNOMeasurement', 'Recovery'];
    });
    const [captureSequence, setCaptureSequence] = useState([
        { id: 'initial-1', name: 'Baseline', durationStr: '60' }
    ]);
    const [newEventName, setNewEventName] = useState('');

    const saveCustomEvent = () => {
        const name = newEventName.trim();
        if (!name) return;
        if (!savedEvents.includes(name)) {
            const up = [...savedEvents, name];
            setSavedEvents(up);
            localStorage.setItem('auSavedEvents', JSON.stringify(up));
        }
        setNewEventName('');
    };
    const removeCustomEvent = (nameToRemove) => {
         const up = savedEvents.filter(name => name !== nameToRemove);
         setSavedEvents(up);
         localStorage.setItem('auSavedEvents', JSON.stringify(up));
    };

    const addSeqNode = () => {
        setCaptureSequence(prev => [
            ...prev,
            { id: Date.now().toString(36) + Math.random().toString(36).slice(2), name: savedEvents[0] || 'Event', durationStr: '60' }
        ]);
    };
    const removeSeqNode = (id) => {
        setCaptureSequence(prev => prev.filter(n => n.id !== id));
    };
    const updateSeqNode = (id, field, val) => {
        setCaptureSequence(prev => prev.map(n => n.id === id ? { ...n, [field]: val } : n));
    };
    
    const getTotalDurationSec = () => {
        let total = 0;
        for (const node of captureSequence) {
            const d = parseInt(node.durationStr, 10);
            if (Number.isFinite(d)) total += d;
        }
        return total > 0 ? total : 60; // default to 60 if empty or 0
    };

    /** SiAC64 RPC: TELEMETRY period in ms (device allows 10–1000; 0 = stop, used only on teardown). */

    /** SiAC64: TELEMETRY.params.period — default 1000 ms (once per second). */
    const [telemetryPeriodMsStr, setTelemetryPeriodMsStr] = useState('1000');
    /** SiAC64 pump: SET_PIEZO_PUMP setFlow (CCM); max from profile.pumpControl.maxCcm. */
    const [flowTargetCcm, setFlowTargetCcm] = useState(0);
    const [pumpFlowMsg, setPumpFlowMsg] = useState('');
    const [pumpFlowBusy, setPumpFlowBusy] = useState(false);
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
    const [currentEventStatus, setCurrentEventStatus] = useState('');

    useEffect(() => {
        const valid = new Set(discovered.map((d) => d.key));
        setSelectedKeysForMulti((prev) => prev.filter((k) => valid.has(k)));
    }, [discovered]);

    useEffect(() => {
        if (!connected) setPumpFlowMsg('');
    }, [connected]);

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

            let currentEv = '';
            if (w.schedule && w.schedule.length > 0) {
                for (const step of w.schedule) {
                    if (elapsed >= step.startOffsetMs && elapsed < step.startOffsetMs + step.durationMs) {
                        const stepSecLeft = Math.max(0, Math.ceil((step.startOffsetMs + step.durationMs - elapsed) / 1000));
                        currentEv = `${step.name} (${stepSecLeft}s left)`;
                        break;
                    }
                }
                if (!currentEv) currentEv = w.schedule[w.schedule.length - 1].name + ' (finishing…)';
            }
            setCurrentEventStatus(currentEv || 'Collecting…');
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
        if (!info) return 'VID — · PID —';
        const vid =
            info.usbVendorId != null ? `0x${info.usbVendorId.toString(16).padStart(4, '0')}` : '—';
        const pid =
            info.usbProductId != null ? `0x${info.usbProductId.toString(16).padStart(4, '0')}` : '—';
        return `VID ${vid} · PID ${pid}`;
    };

    const pumpMaxCcm = profile.pumpControl?.maxCcm ?? 500;
    const pumpSliderStep = profile.pumpControl?.sliderStep ?? 1;

    const applyPumpTargetFlow = async () => {
        const port = portRef.current;
        if (!port?.writable) {
            setPumpFlowMsg('Connect a USB port first (select a device from the scan list).');
            return;
        }
        if (recording) return;
        setPumpFlowBusy(true);
        setPumpFlowMsg('');
        try {
            await writeSiac64RpcLine(port, buildSiAc64SetPumpFlowPayload(flowTargetCcm, pumpMaxCcm));
            const v = clampTargetFlowCcm(flowTargetCcm, pumpMaxCcm);
            setFlowTargetCcm(v);
            setPumpFlowMsg(
                `Sent SET_PIEZO_PUMP setFlow=${v}, enable=1. Confirm in TELEMETRY (PZTFR0 / PZCFR0 / PZEN0).`
            );
        } catch (e) {
            setPumpFlowMsg(e?.message || 'RPC write failed.');
        } finally {
            setPumpFlowBusy(false);
        }
    };

    const applyPumpDisable = async () => {
        const port = portRef.current;
        if (!port?.writable) {
            setPumpFlowMsg('Connect a USB port first.');
            return;
        }
        if (recording) return;
        setPumpFlowBusy(true);
        setPumpFlowMsg('');
        try {
            await writeSiac64RpcLine(port, buildSiAc64PumpDisablePayload());
            setPumpFlowMsg('Sent SET_PIEZO_PUMP enable=0 (pump off).');
        } catch (e) {
            setPumpFlowMsg(e?.message || 'RPC write failed.');
        } finally {
            setPumpFlowBusy(false);
        }
    };

    const applyPumpQuery = async () => {
        const port = portRef.current;
        if (!port?.writable) {
            setPumpFlowMsg('Connect a USB port first.');
            return;
        }
        if (recording) return;
        setPumpFlowBusy(true);
        setPumpFlowMsg('');
        try {
            await writeSiac64RpcLine(port, buildSiAc64PumpQueryPayload());
            setPumpFlowMsg('Sent SET_PIEZO_PUMP (no params). Check serial response / next TELEMETRY.');
        } catch (e) {
            setPumpFlowMsg(e?.message || 'RPC write failed.');
        } finally {
            setPumpFlowBusy(false);
        }
    };

    const runDeviceScan = async () => {
        setError('');
        setSavedOk('');
        setPortHint('');
        if (!webSerialSupported()) {
            setPortHint('Web Serial is not available. Use Chrome or Edge on HTTPS or localhost, and allow the port when prompted.');
            return;
        }
        if (profile.disabled || !profile.parseLine) {
            setPortHint('This device profile is not available yet.');
            return;
        }
        setScanning(true);
        try {
            await disconnectPort();
            const ports = await navigator.serial.getPorts();
            if (ports.length === 0) {
                setDiscovered([]);
                portByKeyRef.current = new Map();
                setPortHint('No USB serial devices are linked to this site yet. Use “Link USB device” once per cable (browser security), then scan again.');
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
                const rpcProbeRaw = profile.rpcShell?.probePayload;
                const rpcProbe = typeof rpcProbeRaw === 'function' ? rpcProbeRaw() : (rpcProbeRaw ?? null);
                const { sn, error: probeError } = await scanProbeSerialPort(
                    port,
                    serialOpenOpts,
                    undefined,
                    rpcProbe,
                    profile.isFormatCompatible
                );
                
                if (sn) {
                    rows.push({
                        key,
                        sn,
                        vidPid,
                        error: probeError,
                    });
                }
            }

            portByKeyRef.current = map;
            setDiscovered(rows);

            if (rows.length === 0) {
                setPortHint(`No compatible ${profile.label} devices found. Ensure the correct hardware profile is selected and the unit is actively streaming.`);
            }

            // Auto-select if exactly one port is linked and not already connected
            if (rows.length === 1 && !connected) {
                selectDiscoveredDevice(rows[0]).catch(() => {});
            }
        } catch (e) {
            setError(e?.message || 'Scan failed.');
        } finally {
            setScanning(false);
        }
    };

    // Auto-scan any unverified or linked ports when the user switches model profile
    useEffect(() => {
        if (recording || scanning || discovered.length === 0) return;

        // Use a small timeout to avoid double-firing if the profile was set during a scan
        const id = setTimeout(() => {
            runDeviceScan().catch(() => {});
        }, 500);
        return () => clearTimeout(id);
    }, [profileKey]);

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
        
        const sec = getTotalDurationSec();
        const schedule = [];
        let currentOffsetMs = 0;
        for (const step of captureSequence) {
            const d = parseInt(step.durationStr, 10);
            if (!Number.isFinite(d) || d <= 0) continue;
            schedule.push({ name: step.name, startOffsetMs: currentOffsetMs, durationMs: d * 1000 });
            currentOffsetMs += d * 1000;
        }

        const getEventForOffset = (offsetMs) => {
            if (schedule.length === 0) return '';
            for (const step of schedule) {
                if (offsetMs >= step.startOffsetMs && offsetMs < step.startOffsetMs + step.durationMs) {
                    return step.name;
                }
            }
            return schedule[schedule.length - 1].name;
        };

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
                        if (profile.rpcShell) {
                            const periodMs = clampTelemetryPeriodMs(parseInt(telemetryPeriodMsStr, 10));
                            const startPayloadRaw = profile.rpcShell.captureStartPayload;
                            const startPayload = typeof startPayloadRaw === 'function' ? startPayloadRaw(periodMs) : startPayloadRaw;
                            await writeSiac64RpcLine(port, startPayload);
                            await serialDelay(t.win ? 200 : 100);
                        }
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
                                    const elapsedMs = captureProgressWindowRef.current ? Date.now() - captureProgressWindowRef.current.startMs : 0;
                                    row.Event = getEventForOffset(elapsedMs);
                                    rows.push(row);
                                    bumpLines();
                                    if (rows.length === 1) {
                                        console.info(`[Multi-AU Capture] First valid JSON row from ${key}:`, row);
                                    }
                                    if (rows.length % 5 === 0) {
                                        setLastPreview(JSON.stringify(rows[rows.length - 1]).slice(0, 280));
                                    }
                                } else {
                                    console.debug(`[Multi-AU Capture] JSON ignored (no sensors): ${jsonStr}`);
                                }
                            } catch (e) {
                                console.warn(`[Multi-AU Capture] Parse error for ${key}:`, e.message, "Raw chunk:", jsonStr);
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
                    if (profile.rpcShell?.captureStopPayload) {
                        try {
                            await writeSiac64RpcLine(port, profile.rpcShell.captureStopPayload);
                        } catch {
                            /* ignore */
                        }
                        await serialDelay(50);
                    }
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

                console.info(`[Multi-AU] Capture stream loops active ... Ends precisely at:`, new Date(endAt).toISOString());
                captureProgressWindowRef.current = { startMs: Date.now(), endMs: endAt, schedule };
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
                                    `${who}: only ${b} raw byte(s) in the whole window — stream never delivered a full JSON object.${seen} Typical causes: another program using the same COM port, USB hub power, wrong baud (${profile.label} uses ${profile.baudRate}), or capturing several AUs at once on Windows starving one port. Try one AU, close other serial tools, longer window, or a different USB socket.`
                                );
                            } else {
                                failures.push(
                                    `${who}: ${b} byte(s) but no complete JSON row with channel data.${seen} SiAC frames can be large; the stream may have ended mid-object — use a longer collection window or one AU at a time. Pick the correct model (SiAC32-V2 vs SiAC64 RPC).`
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
            if (profile.rpcShell) {
                const periodMs = clampTelemetryPeriodMs(parseInt(telemetryPeriodMsStr, 10));
                const startPayloadRaw = profile.rpcShell.captureStartPayload;
                const startPayload = typeof startPayloadRaw === 'function' ? startPayloadRaw(periodMs) : startPayloadRaw;
                await writeSiac64RpcLine(port, startPayload);
                await serialDelay(getSerialPlatformTiming().win ? 200 : 100);
            }

            setConnected(true);
            portRef.current = port;
            await primeSerialPortForSiAcRead(port);

            /** Full `sec` seconds of reading start only after USB is open + primed (not before). */
            console.info(`[Single-AU] Main capture loops running. Ends exactly at:`, new Date(readEndAt).toISOString());
            captureProgressWindowRef.current = { startMs: Date.now(), endMs: readEndAt, schedule };

            const consumeBuffer = (isFinal) => {
                const { chunks, rest } = drainJsonObjectsFromBuffer(buffer);
                for (const jsonStr of chunks) {
                    const ts = new Date().toISOString();
                    try {
                        const row = parseLine(jsonStr, ts);
                        if (row && captureRowHasSensorValues(row)) {
                            const elapsedMs = captureProgressWindowRef.current ? Date.now() - captureProgressWindowRef.current.startMs : 0;
                            row.Event = getEventForOffset(elapsedMs);
                            rowsRef.current.push(row);
                            const n = rowsRef.current.length;
                            if (n === 1) {
                                console.info(`[Capture] First valid JSON row:`, row);
                            }
                            if (n % 10 === 0) setLineCount(n);
                            if (n % 5 === 0) {
                                const last = rowsRef.current[n - 1];
                                setLastPreview(JSON.stringify(last).slice(0, 280));
                            }
                        } else {
                            console.debug(`[Capture] JSON ignored (no sensors): ${jsonStr}`);
                        }
                    } catch (e) {
                        console.warn(`[Capture] Parse error:`, e.message, "Raw chunk:", jsonStr);
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
            if (profile.rpcShell?.captureStopPayload) {
                try {
                    const stopPayloadRaw = profile.rpcShell.captureStopPayload;
                    const stopPayload = typeof stopPayloadRaw === 'function' ? stopPayloadRaw() : stopPayloadRaw;
                    await writeSiac64RpcLine(port, stopPayload);
                } catch {
                    /* ignore */
                }
                await serialDelay(50);
            }
            // Keep the port open for post-capture manual commands/pump setting
            portRef.current = port;
            setConnected(true);
            setRecording(false);
            // We do NOT call port.close() here for single-AU, 
            // allowing the user to 'connect and set flow rate' after capture ends.
        }

        const rawRows = rowsRef.current;
        if (rawRows.length === 0) {
            setError((prev) => {
                if (prev) return prev;
                if (bytesIn === 0) {
                    return `No data captured: 0 bytes in ${sec}s. Port is silent (device not streaming, wrong baud — use ${profile.baudRate} or 921600 for ${profile.label}, bad cable, or wrong COM device).`;
                }
                if (captureParseErrors > 0) {
                    return `No valid rows: ${bytesIn} byte(s) and ${captureParseErrors} parse error(s). Data may not match ${profile.label}. Check the browser console (Ctrl+Shift+J) for raw chunks or firmware issues.`;
                }
                const tail = describePartialSerialBuffer(orphanTail);
                const seen = tail ? ` Unparsed tail: ${tail}.` : '';
                if (bytesIn <= 16) {
                    return `No complete JSON: only ${bytesIn} raw byte(s) in ${sec}s.${seen} Often: another app on the same COM port, wrong baud (${profile.label} usually uses ${profile.baudRate} or 921600), USB hub, or multi-AU capture starving a port on Windows.`;
                }
                return `No complete JSON row with channel data: ${bytesIn} byte(s) received.${seen} SiAC frames can be large; if the tail shows "sn" or "method" mid-object, the frame was cut off — use a longer collection window (30s+). Check console for raw buffers. Ensure the device model matches (SiAC32-V2 vs SiAC64 TELEMETRY RPC).`;
            });
            return;
        }

        const rowsForSave = rawRows.filter(captureRowHasSensorValues);
        if (rowsForSave.length === 0) {
            setError(
                `Received ${rawRows.length} JSON object(s) in ${sec}s with timestamp/serial only — no channel readings (A1–H8 / CHR/RRF). Those lines are not saved; check the device stream.`
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
                    <h3>Step 1: Connection</h3>
                    <div className="au-field">
                        <label htmlFor="au-profile">Hardware Profile</label>
                        <div className="au-model-baud-row">
                            <select
                                id="au-profile"
                                value={profileKey}
                                onChange={(e) => {
                                    const k = e.target.value;
                                    setProfileKey(k);
                                    setBaudRate(AU_DEVICE_PROFILES[k].baudRate);
                                }}
                                disabled={recording}
                            >
                                {Object.entries(AU_DEVICE_PROFILES).map(([key, p]) => (
                                    <option key={key} value={key} disabled={!!p.disabled}>
                                        {p.label}
                                        {p.disabled ? ' — coming later' : ''}
                                    </option>
                                ))}
                            </select>
                            <label htmlFor="au-baud" className="sr-only">Baud Rate</label>
                            <select
                                id="au-baud"
                                value={baudRate}
                                onChange={(e) => setBaudRate(parseInt(e.target.value, 10))}
                                disabled={recording}
                                className="au-baud-select"
                            >
                                <option value={115200}>115200</option>
                                <option value={921600}>921600</option>
                                <option value={230400}>230400</option>
                            </select>
                        </div>
                    </div>
                    <div className="au-field">
                        <p className="au-status">
                            {webSerialSupported() ? 'Web Serial API is available.' : 'Web Serial is not supported.'}
                        </p>
                        <div className="au-btn-row">
                            <button
                                type="button"
                                className="au-btn au-btn-secondary"
                                onClick={linkNewUsbDevice}
                                disabled={recording || scanning || !webSerialSupported() || profile.disabled}
                            >
                                <Plug size={16} /> Link USB device…
                            </button>
                            <button
                                type="button"
                                className="au-btn au-btn-secondary"
                                onClick={runDeviceScan}
                                disabled={recording || scanning || !webSerialSupported() || profile.disabled}
                            >
                                <ScanSearch size={16} /> {scanning ? 'Scanning…' : 'Scan for units'}
                            </button>
                        </div>
                        {discovered.length > 0 ? (
                            <div className="au-device-list">
                                <div className="au-device-list-title">
                                    {multiAuCapture ? 'Select AUs for parallel capture' : 'Select a port to connect'}
                                </div>
                                <div className="au-device-list-items">
                                {discovered.map((res) => {
                                    const isSel = multiAuCapture ? selectedKeysForMulti.includes(res.key) : selectedKey === res.key;
                                    const body = (
                                        <>
                                            <div className="au-device-row-main">
                                                <div className="au-device-sn-line">
                                                    {multiAuCapture && (
                                                        <input
                                                            type="checkbox"
                                                            checked={isSel}
                                                            onChange={() => toggleMultiKey(res.key)}
                                                            disabled={recording}
                                                            className="au-multi-checkbox"
                                                        />
                                                    )}
                                                    {res.sn ? (
                                                        <div className="au-device-sn">
                                                            {res.sn} <span className="au-device-port-muted">({res.key.split('-').pop()})</span>
                                                        </div>
                                                    ) : (
                                                        <div className="au-device-sn au-device-sn--muted">
                                                            Hardware Port {res.key.split('-').pop()} (SN not read yet)
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </>
                                    );

                                    if (multiAuCapture) {
                                        return (
                                            <label key={res.key} className={`au-device-row au-device-row--multi${isSel ? ' au-device-row--checked' : ''}`}>
                                                <div className="au-device-row-body">{body}</div>
                                            </label>
                                        );
                                    }

                                    return (
                                        <button
                                            key={res.key}
                                            type="button"
                                            className={`au-device-row${isSel ? ' au-device-row--selected' : ''}`}
                                            onClick={() => selectDiscoveredDevice(res)}
                                            disabled={connected || recording}
                                        >
                                            {body}
                                        </button>
                                    );
                                })}
                                </div>
                            </div>
                        ) : null}
                        {portHint ? <p className="au-hint au-port-hint" style={{ color: portHint.startsWith('No ') || portHint.includes('not available') ? '#fbbf24' : undefined }}>{portHint}</p> : null}
                    </div>
                    <label className="au-multi-toggle">
                        <input type="checkbox" checked={multiAuCapture} onChange={(e) => setMultiAuCapture(e.target.checked)} disabled={recording || scanning || profile.disabled} />
                        <span>Enable Multi-AU parallel capture</span>
                    </label>
                </div>

                {profile.rpcShell ? (
                    <div className="au-capture-card">
                        <h3>Step 2: Settings</h3>
                        {profile.pumpControl ? (
                            <div className="au-field">
                                <label htmlFor="au-flow-slider">Pump Flow (CCM)</label>
                                <div className="au-flow-slider-row">
                                    <input id="au-flow-slider" type="range" min={0} max={pumpMaxCcm} step={pumpSliderStep} value={Math.min(flowTargetCcm, pumpMaxCcm)} onChange={(e) => setFlowTargetCcm(clampTargetFlowCcm(Number(e.target.value), pumpMaxCcm))} disabled={!connected || recording || pumpFlowBusy || profile.disabled} />
                                    <div className="au-flow-value-wrap">
                                        <input id="au-flow-number" className="au-flow-number-input" type="text" value={flowTargetCcm} onChange={(e) => { const val = e.target.value; if (val === '') { setFlowTargetCcm(''); return; } const n = parseFloat(val); if (!isNaN(n)) { setFlowTargetCcm(clampTargetFlowCcm(n, pumpMaxCcm)); } }} onFocus={(e) => e.target.select()} onBlur={() => { if (flowTargetCcm === '') setFlowTargetCcm(0); }} disabled={!connected || recording || pumpFlowBusy || profile.disabled} />
                                        <span className="au-flow-ccm-suffix">CCM</span>
                                    </div>
                                </div>
                                <div className="au-btn-row">
                                    <button type="button" className="au-btn au-btn-primary" onClick={() => applyPumpTargetFlow()} disabled={!connected || recording || pumpFlowBusy || profile.disabled}>Apply Flow</button>
                                    <button type="button" className="au-btn au-btn-secondary" onClick={() => applyPumpDisable()} disabled={!connected || recording || pumpFlowBusy || profile.disabled}>Pump Off</button>
                                    <button type="button" className="au-btn au-btn-secondary" onClick={() => applyPumpQuery()} disabled={!connected || recording || pumpFlowBusy || profile.disabled}>Query</button>
                                </div>
                                {pumpFlowMsg ? <p className="au-hint au-pump-flow-msg">{pumpFlowMsg}</p> : null}
                            </div>
                        ) : null}
                        <div className="au-field" style={{ marginTop: '1.5rem' }}>
                            <label htmlFor="au-telemetry-period">Telemetry Interval (ms)</label>
                            <div className="au-telemetry-row">
                                <input id="au-telemetry-period" type="text" value={telemetryPeriodMsStr} onChange={(e) => setTelemetryPeriodMsStr(e.target.value)} onFocus={(e) => e.target.select()} onBlur={() => { const n = parseInt(telemetryPeriodMsStr, 10); if (!Number.isFinite(n)) { setTelemetryPeriodMsStr('1000'); return; } setTelemetryPeriodMsStr(String(clampTelemetryPeriodMs(n))); }} disabled={recording} />
                                <div className="au-telemetry-presets">
                                    {[1000, 500, 250, 100].map((ms) => (
                                        <button key={ms} type="button" className="au-telemetry-preset-btn" disabled={recording} onClick={() => setTelemetryPeriodMsStr(String(ms))}>{ms}ms</button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}

                <div className="au-capture-card">
                    <h3>Step 3: Capture</h3>
                    <div className="au-events-manager">
                        <label>Collection Sequence</label>
                        <div className="au-sequence-list">
                            {captureSequence.map((seqNode, i) => (
                                <div key={seqNode.id} className="au-seq-row">
                                    <span className="au-seq-num">{i + 1}</span>
                                    <select
                                        className="au-seq-select"
                                        value={seqNode.name}
                                        onChange={(e) => updateSeqNode(seqNode.id, 'name', e.target.value)}
                                        disabled={recording}
                                    >
                                        {savedEvents.map(ev => <option key={ev} value={ev}>{ev}</option>)}
                                    </select>
                                    <input
                                        className="au-seq-dur"
                                        type="text"
                                        value={seqNode.durationStr}
                                        onChange={(e) => { const v = e.target.value; if (v === '' || /^\d+$/.test(v)) updateSeqNode(seqNode.id, 'durationStr', v); }}
                                        onBlur={(e) => { const n = parseInt(e.target.value, 10); if (!Number.isFinite(n) || n <= 0) updateSeqNode(seqNode.id, 'durationStr', '1'); else updateSeqNode(seqNode.id, 'durationStr', String(n)); }}
                                        disabled={recording}
                                    />
                                    <span className="au-seq-lbl">sec</span>
                                    <button type="button" className="au-seq-del" onClick={() => removeSeqNode(seqNode.id)} disabled={recording || captureSequence.length === 1}>×</button>
                                </div>
                            ))}
                        </div>
                        <div className="au-sequence-actions">
                            <button type="button" className="au-btn au-btn-secondary au-btn-small" onClick={addSeqNode} disabled={recording}>+ Add Phase</button>
                            <span className="au-seq-total">Total: {getTotalDurationSec()}s</span>
                        </div>
                        <div className="au-custom-event-add">
                            <input
                                type="text"
                                placeholder="New custom event name…"
                                value={newEventName}
                                onChange={(e) => setNewEventName(e.target.value)}
                                disabled={recording}
                            />
                            <button type="button" className="au-btn au-btn-primary au-btn-small" onClick={saveCustomEvent} disabled={recording || !newEventName.trim()}>Save Event</button>
                        </div>
                    </div>
                    <div className="au-btn-row" style={{ marginTop: '1.5rem' }}>
                         <button
                            type="button"
                            className="au-btn au-btn-primary"
                            onClick={startRecording}
                            disabled={recording || profile.disabled || (multiAuCapture ? selectedKeysForMulti.length === 0 : !connected)}
                        >
                            <Usb size={16} /> 
                            {recording 
                                ? 'Capturing…' 
                                : multiAuCapture 
                                    ? (selectedKeysForMulti.length === 0 ? 'Start Capture (Select AUs first)' : `Start Capture (${selectedKeysForMulti.length})`) 
                                    : (!connected ? 'Start Capture (Connect step 1 above)' : 'Start Capture')
                            }
                        </button>
                        {recording ? (
                            <button type="button" className="au-btn au-btn-danger" onClick={stopCapture}>
                                <Square size={16} /> Stop Early
                            </button>
                        ) : null}
                    </div>
                </div>

                <div className="au-capture-card">
                    <h3>Session Results</h3>
                    {savedOk ? <p className="au-status" style={{ color: '#34d399', marginBottom: '1rem' }}>{savedOk}</p> : null}
                    {error ? <p className="au-error" style={{ marginBottom: '1rem' }}>{error}</p> : null}

                    {recording ? (
                        <div className="au-collection-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={captureOpening ? undefined : Math.round(captureProgressPct)}>
                            <div className="au-collection-progress-top">
                                <span className="au-collection-progress-title">{captureOpening ? 'Opening ports…' : (currentEventStatus || 'Collecting…')}</span>
                                {!captureOpening ? <span className="au-collection-progress-stats">{Math.round(captureProgressPct)}% · {captureSecsLeft}s total left</span> : null}
                            </div>
                            <div className={`au-collection-progress-track${captureOpening ? ' au-collection-progress-track--busy' : ''}`}>
                                {captureOpening ? <div className="au-collection-progress-indeterminate" /> : <div className="au-collection-progress-fill" style={{ width: `${captureProgressPct}%` }} />}
                            </div>
                        </div>
                    ) : (
                        <p className="au-status" style={{ opacity: 0.7 }}>
                            <strong>Lines stored:</strong> {lineCount}
                            {parseErrors > 0 ? ` · Parse errors: ${parseErrors}` : null}
                        </p>
                    )}
                    {lastPreview ? <div className="au-preview" style={{ marginTop: '1rem' }}>{lastPreview}</div> : null}
                    {lastParseHint ? <p className="au-error" style={{ marginTop: 8 }}>{lastParseHint}</p> : null}
                </div>
            </div>
        </div>
    );
}
