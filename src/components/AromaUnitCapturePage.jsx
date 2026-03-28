import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Usb, Radio, Square, Plug } from 'lucide-react';
import {
    AU_DEVICE_PROFILES,
    getAuProfile,
    normalizeCaptureRows,
    drainJsonObjectsFromBuffer,
    auDeviceFolderNameFromSn,
} from '../utils/siacDeviceProfiles';
import './AromaUnitCapturePage.css';

function webSerialSupported() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
}

export default function AromaUnitCapturePage({ onSaveToWorkspace }) {
    const [profileKey, setProfileKey] = useState('SIAC32_V2');
    const profile = getAuProfile(profileKey);
    const [durationSec, setDurationSec] = useState(60);
    const [portHint, setPortHint] = useState('');
    const [connected, setConnected] = useState(false);
    const [recording, setRecording] = useState(false);
    const [lineCount, setLineCount] = useState(0);
    const [parseErrors, setParseErrors] = useState(0);
    const [error, setError] = useState('');
    const [lastPreview, setLastPreview] = useState('');
    const [lastParseHint, setLastParseHint] = useState('');
    const [savedOk, setSavedOk] = useState('');

    const portRef = useRef(null);
    const rowsRef = useRef([]);
    const stopRef = useRef(false);
    const readerRef = useRef(null);

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
        try {
            await portRef.current?.close();
        } catch {
            /* ignore */
        }
        portRef.current = null;
        setConnected(false);
        setPortHint('');
    }, [releaseReader]);

    useEffect(() => () => {
        disconnectPort();
    }, [disconnectPort]);

    const connectPort = async () => {
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
            await disconnectPort();
            const port = await navigator.serial.requestPort();
            await port.open({
                baudRate: profile.baudRate,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
            });
            portRef.current = port;
            const info = port.getInfo?.() || {};
            const vid = info.usbVendorId != null ? ` VID 0x${info.usbVendorId.toString(16)}` : '';
            const pid = info.usbProductId != null ? ` PID 0x${info.usbProductId.toString(16)}` : '';
            setPortHint(`Open @ ${profile.baudRate} baud${vid}${pid}`);
            setConnected(true);
        } catch (e) {
            if (e?.name === 'NotFoundError') return;
            setError(e?.message || 'Could not open serial port.');
        }
    };

    const stopCapture = () => {
        stopRef.current = true;
        readerRef.current?.cancel?.();
    };

    const startRecording = async () => {
        const port = portRef.current;
        setError('');
        setSavedOk('');
        if (!port) {
            setError('Connect a serial port first (USB aroma unit).');
            return;
        }
        if (profile.disabled || !profile.parseLine) {
            setError('This device profile is not supported yet.');
            return;
        }
        const sec = Math.max(1, Math.min(86400, Number(durationSec) || 60));

        rowsRef.current = [];
        setLineCount(0);
        setParseErrors(0);
        setLastPreview('');
        setLastParseHint('');
        stopRef.current = false;
        setRecording(true);

        const endAt = Date.now() + sec * 1000;
        let buffer = '';
        const parseLine = profile.parseLine;

        try {
            const textStream = port.readable.pipeThrough(new TextDecoderStream());
            const reader = textStream.getReader();
            readerRef.current = reader;

            const consumeBuffer = (isFinal) => {
                const { chunks, rest } = drainJsonObjectsFromBuffer(buffer);
                for (const jsonStr of chunks) {
                    const ts = new Date().toISOString();
                    try {
                        const row = parseLine(jsonStr, ts);
                        if (row) {
                            rowsRef.current.push(row);
                            const n = rowsRef.current.length;
                            if (n % 10 === 0) setLineCount(n);
                            if (n % 5 === 0) {
                                const last = rowsRef.current[n - 1];
                                setLastPreview(JSON.stringify(last).slice(0, 280));
                            }
                        }
                    } catch (e) {
                        setParseErrors((x) => x + 1);
                        const msg = e?.message || 'parse error';
                        const bit = jsonStr.slice(0, 120);
                        setLastParseHint(`${msg} — sample: ${bit}${jsonStr.length > 120 ? '…' : ''}`);
                    }
                }
                buffer = isFinal ? '' : rest;
            };

            while (true) {
                if (Date.now() >= endAt || stopRef.current) {
                    try {
                        await reader.cancel();
                    } catch {
                        /* ignore */
                    }
                    break;
                }
                let chunk;
                try {
                    chunk = await reader.read();
                } catch {
                    break;
                }
                const { value, done } = chunk;
                if (done) break;
                if (value) {
                    buffer += value;
                    consumeBuffer(false);
                    setLineCount(rowsRef.current.length);
                }
            }

            consumeBuffer(true);
            setLineCount(rowsRef.current.length);
        } catch (e) {
            setError(e?.message || 'Serial read failed.');
        } finally {
            await releaseReader();
            try {
                await port.close();
            } catch {
                /* ignore */
            }
            portRef.current = null;
            setConnected(false);
            setRecording(false);
        }

        const rawRows = rowsRef.current;
        if (rawRows.length === 0) {
            setError((prev) => prev || 'No data lines captured. Check wiring, baud rate, or try a longer window.');
            return;
        }

        const { data } = normalizeCaptureRows(rawRows);
        const folderName = auDeviceFolderNameFromSn(data[0]?.sn);
        const t0 = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const folderStamp = `${t0.getFullYear()}-${pad(t0.getMonth() + 1)}-${pad(t0.getDate())}_${pad(t0.getHours())}${pad(t0.getMinutes())}${pad(t0.getSeconds())}`;
        const fileName = `capture_${folderStamp}.csv`;

        try {
            await onSaveToWorkspace({ folderName, fileName, data });
            setSavedOk(
                `Saved to workspace folder "${folderName}" as ${fileName} (${data.length} rows, ${Object.keys(data[0] || {}).length} columns). Reuses the same folder for this device serial.`
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
                            type="number"
                            min={1}
                            max={86400}
                            value={durationSec}
                            onChange={(e) => setDurationSec(Number(e.target.value))}
                            disabled={recording}
                        />
                    </div>
                </div>

                <div className="au-capture-card">
                    <h3>Serial (Web Serial API)</h3>
                    <p className="au-status">
                        {webSerialSupported() ? (
                            <>
                                Choose your USB serial device when the browser prompts. Typical SiAC bridge:{' '}
                                <strong>115200</strong> 8N1. Data are JSON objects like{' '}
                                <code>{'{"sn":"...","t":[{"CHR0":1},...]}'}</code> — the reader reassembles frames when USB splits
                                them across reads (not only at line breaks).
                            </>
                        ) : (
                            <strong>This browser does not expose Web Serial.</strong>
                        )}
                    </p>
                    <div className="au-btn-row">
                        <button
                            type="button"
                            className="au-btn au-btn-secondary"
                            onClick={connectPort}
                            disabled={recording || !webSerialSupported() || profile.disabled}
                        >
                            <Plug size={16} />
                            Connect USB serial…
                        </button>
                        <button
                            type="button"
                            className="au-btn au-btn-primary"
                            onClick={startRecording}
                            disabled={recording || !connected || profile.disabled}
                        >
                            <Usb size={16} />
                            Start capture
                        </button>
                        {recording ? (
                            <button type="button" className="au-btn au-btn-danger" onClick={stopCapture}>
                                <Square size={16} />
                                Stop early
                            </button>
                        ) : null}
                    </div>
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
                        <p className="au-hint">Recording… use Stop early or wait for the timer. The port closes after capture; connect again for another run.</p>
                    ) : null}
                    {lastPreview ? <div className="au-preview">{lastPreview}</div> : null}
                    {lastParseHint ? <p className="au-error" style={{ marginTop: 8 }}>{lastParseHint}</p> : null}
                    <p className="au-hint">
                        Each CSV row is one received line with a <code>timestamp</code> (ISO, browser receive time),{' '}
                        <code>sn</code>, and all sensor fields from the JSON (e.g. CHR0–CHR31, T0, H0, …). Captures are
                        saved under one workspace folder per device <code>sn</code> (created if needed); newest files
                        appear first when you expand that folder.
                    </p>
                </div>
            </div>
        </div>
    );
}
