import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Terminal, Usb, Unplug, Trash2, RefreshCw, Download, Send } from 'lucide-react';
import { saveAs } from 'file-saver';
import Papa from 'papaparse';
import { getSerialPlatformTiming, delay } from '../utils/siacSerialProbe';
import './AromaAnalysisPage.css';

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const MAX_LINES = 4000;
const SERIAL_WORKSPACE_FOLDER = 'serial_data';

function webSerialSupported() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
}

function formatPortLabel(port, index) {
    try {
        const info = port.getInfo?.() || {};
        if (info.usbVendorId != null && info.usbProductId != null) {
            const vid = info.usbVendorId.toString(16).padStart(4, '0');
            const pid = info.usbProductId.toString(16).padStart(4, '0');
            return `USB ${index + 1} (VID ${vid} · PID ${pid})`;
        }
    } catch {
        /* ignore */
    }
    return `Port ${index + 1}`;
}

function escapeCsvField(s) {
    const str = String(s);
    if (/[",\n\r\t]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * Split one serial line into fields: tab-separated first, else comma-separated (quoted CSV aware).
 */
function splitLineIntoFields(text) {
    const raw = String(text ?? '').replace(/\r$/, '');
    if (raw.includes('\t')) {
        return raw.split('\t').map((c) => c.trimEnd());
    }
    const res = Papa.parse(raw, {
        header: false,
        skipEmptyLines: false,
        delimiter: ',',
    });
    const first = res.data && res.data[0];
    if (Array.isArray(first) && first.length > 1) {
        return first.map((c) => (c == null ? '' : String(c)).replace(/\r$/, '').trimEnd());
    }
    return [raw];
}

/**
 * CSV with timestamp column + one column per delimited field. Drops the first log line (often a partial frame).
 */
function buildSerialLogCsv(rows) {
    const exportRows = rows.length > 1 ? rows.slice(1) : [];
    if (exportRows.length === 0) {
        return '\uFEFFtimestamp_iso\n';
    }

    const splitRows = exportRows.map(({ receivedAt, text }) => {
        const cells = splitLineIntoFields(text);
        return [receivedAt, ...cells];
    });
    const maxCols = Math.max(2, ...splitRows.map((r) => r.length));
    const header = [
        'timestamp_iso',
        ...Array.from({ length: maxCols - 1 }, (_, i) => `field_${i + 1}`),
    ];
    const padded = splitRows.map((r) => {
        const out = [...r];
        while (out.length < maxCols) out.push('');
        return out;
    });
    const linesOut = [header, ...padded].map((line) => line.map(escapeCsvField).join(','));
    return `\uFEFF${linesOut.join('\n')}\n`;
}

function buildSerialLogTxt(rows) {
    return rows.map(({ receivedAt, text }) => `${receivedAt}\t${text.replace(/\r?\n/g, ' ')}`).join('\n') + '\n';
}

function exportFileName(ext) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `serial-monitor-${stamp}.${ext}`;
}

export default function SerialMonitorPage({ onSaveSerialLogToWorkspace }) {
    const [ports, setPorts] = useState([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [baudRate, setBaudRate] = useState(115200);
    const [lines, setLines] = useState([]);
    const [status, setStatus] = useState('Disconnected');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [sendText, setSendText] = useState('');
    /** Appended after sendText as UTF-8 bytes (common for UART command lines). */
    const [sendLineEnding, setSendLineEnding] = useState('none');
    const [saveFeedback, setSaveFeedback] = useState(null);
    const [saveBusy, setSaveBusy] = useState(false);

    const portRef = useRef(null);
    const sendInFlightRef = useRef(false);
    const readerRef = useRef(null);
    const readLoopDoneRef = useRef(null);
    const logScrollRef = useRef(null);
    const lineIdRef = useRef(0);
    const totalReceivedRef = useRef(0);

    const refreshPorts = useCallback(async () => {
        if (!webSerialSupported()) return;
        try {
            const list = await navigator.serial.getPorts();
            setPorts(list);
            setSelectedIndex((i) => Math.min(i, Math.max(0, list.length - 1)));
        } catch (e) {
            setError(e?.message || 'Could not list serial ports.');
        }
    }, []);

    useEffect(() => {
        refreshPorts();
    }, [refreshPorts]);

    useEffect(() => {
        const id = requestAnimationFrame(() => {
            const el = logScrollRef.current;
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        });
        return () => cancelAnimationFrame(id);
    }, [lines]);

    const appendLines = useCallback((newRows) => {
        if (!newRows.length) return;
        setLines((prev) => {
            const withIds = newRows.map((text) => ({
                id: lineIdRef.current++,
                text,
                receivedAt: new Date().toISOString(),
            }));
            totalReceivedRef.current += newRows.length;
            const next = prev.concat(withIds);
            if (next.length > MAX_LINES) {
                return next.slice(-MAX_LINES);
            }
            return next;
        });
    }, []);

    const disconnect = useCallback(async () => {
        readLoopDoneRef.current = true;
        const reader = readerRef.current;
        readerRef.current = null;
        if (reader) {
            try {
                await reader.cancel();
            } catch {
                /* ignore */
            }
            try {
                reader.releaseLock();
            } catch {
                /* ignore */
            }
        }
        const port = portRef.current;
        portRef.current = null;
        if (port) {
            try {
                await port.close();
            } catch {
                /* ignore */
            }
            const t = getSerialPlatformTiming();
            await delay(t.afterPortCloseMs);
        }
        setStatus('Disconnected');
        setBusy(false);
    }, []);

    useEffect(() => () => {
        disconnect();
    }, [disconnect]);

    const handleLinkDevice = async () => {
        if (!webSerialSupported()) return;
        setError(null);
        try {
            await navigator.serial.requestPort();
            await refreshPorts();
        } catch (e) {
            if (e?.name !== 'NotFoundError') {
                setError(e?.message || 'Could not open the port picker.');
            }
        }
    };

    const handleConnect = async () => {
        if (!webSerialSupported() || busy || ports.length === 0) return;
        const port = ports[selectedIndex];
        if (!port) return;

        setError(null);
        setBusy(true);
        readLoopDoneRef.current = false;

        try {
            if (port.readable != null || port.writable != null) {
                setError(
                    'This port still looks open. Wait a second after disconnect, or close other apps using the same COM port.'
                );
                setBusy(false);
                return;
            }

            await port.open({ baudRate });
            portRef.current = port;
            setStatus(`Connected @ ${baudRate} baud`);

            /** Raw byte reader + TextDecoder — avoids pipeThrough(TextDecoderStream), which can leave the port locked after disconnect on some OS/browser builds (see siacSerialProbe). */
            const decoder = new TextDecoder();
            let buffer = '';
            const reader = port.readable.getReader();
            readerRef.current = reader;

            const pump = async () => {
                try {
                    while (!readLoopDoneRef.current) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        if (value && value.byteLength > 0) {
                            buffer += decoder.decode(value, { stream: true });
                            const parts = buffer.split(/\r?\n/);
                            buffer = parts.pop() ?? '';
                            const out = [];
                            for (const raw of parts) {
                                out.push(raw.replace(/\r+$/, ''));
                            }
                            if (out.length) appendLines(out);
                        }
                    }
                    try {
                        buffer += decoder.decode();
                    } catch {
                        /* ignore */
                    }
                    const tail = buffer.replace(/\r+$/, '');
                    if (tail.length > 0) {
                        appendLines([tail]);
                    }
                } catch (e) {
                    const intentional = readLoopDoneRef.current || e?.name === 'AbortError';
                    if (!intentional) {
                        setError(e?.message || 'Serial read error.');
                    }
                } finally {
                    await disconnect();
                }
            };
            pump();
        } catch (e) {
            setError(e?.message || 'Could not open serial port.');
            setBusy(false);
            setStatus('Disconnected');
            portRef.current = null;
        }
    };

    const handleDisconnect = async () => {
        readLoopDoneRef.current = true;
        await disconnect();
    };

    const isSerialConnected = busy && String(status).startsWith('Connected');

    const handleSendToPort = useCallback(async () => {
        if (sendInFlightRef.current) return;
        const port = portRef.current;
        if (!port?.writable) return;

        const suffix =
            sendLineEnding === 'lf' ? '\n' : sendLineEnding === 'crlf' ? '\r\n' : '';
        const raw = sendText;
        if (raw.length === 0 && suffix.length === 0) return;

        const encoder = new TextEncoder();
        const payload = raw + suffix;

        sendInFlightRef.current = true;
        setError(null);
        let writer;
        try {
            writer = port.writable.getWriter();
            await writer.write(encoder.encode(payload));
        } catch (e) {
            setError(e?.message || 'Failed to write to the serial port.');
            return;
        } finally {
            try {
                writer?.releaseLock();
            } catch {
                /* ignore */
            }
            sendInFlightRef.current = false;
        }

        const endingNote =
            sendLineEnding === 'lf' ? ' +LF' : sendLineEnding === 'crlf' ? ' +CRLF' : '';
        appendLines([`[TX] ${raw}${endingNote}`]);
    }, [sendText, sendLineEnding, appendLines]);

    const handleClear = () => {
        setLines([]);
        totalReceivedRef.current = 0;
    };

    const canSaveLog = lines.length > 0 && status === 'Disconnected' && !busy;

    const handleSaveLog = useCallback(
        async (format) => {
            if (!canSaveLog) return;
            const content = format === 'csv' ? buildSerialLogCsv(lines) : buildSerialLogTxt(lines);
            const fileName = exportFileName(format === 'csv' ? 'csv' : 'txt');
            if (onSaveSerialLogToWorkspace) {
                setSaveBusy(true);
                setSaveFeedback(null);
                try {
                    await onSaveSerialLogToWorkspace({ content, fileName });
                    setSaveFeedback(`Saved to workspace → ${SERIAL_WORKSPACE_FOLDER}/${fileName}`);
                    window.setTimeout(() => setSaveFeedback(null), 6000);
                } catch (e) {
                    setError(e?.message || 'Could not save to workspace.');
                } finally {
                    setSaveBusy(false);
                }
            } else {
                const mime =
                    format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8';
                saveAs(new Blob([content], { type: mime }), fileName);
            }
        },
        [canSaveLog, lines, onSaveSerialLogToWorkspace]
    );

    const supported = webSerialSupported();

    const panelChrome = { flexShrink: 0 };

    return (
        <div
            className="aroma-page-root serial-monitor-root"
            style={{
                boxSizing: 'border-box',
                maxWidth: 1100,
                margin: '0 auto',
                padding: '1rem 1.25rem',
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
            }}
        >
            <div className="aroma-header" style={{ ...panelChrome, marginBottom: '0.75rem', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div className="icon-wrapper" style={{ background: 'rgba(56, 189, 248, 0.12)' }}>
                        <Terminal size={18} color="#38bdf8" />
                    </div>
                    <div>
                        <h1 className="page-title" style={{ margin: 0 }}>Serial monitor</h1>
                        <p style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: '0.85rem', maxWidth: 640 }}>
                            Connect your serial device, send and receive data, and save the log with timestamps.
                        </p>
                    </div>
                </div>
            </div>

            {!supported && (
                <div
                    style={{
                        ...panelChrome,
                        padding: '12px 14px',
                        borderRadius: 8,
                        background: 'rgba(248, 113, 113, 0.12)',
                        border: '1px solid rgba(248, 113, 113, 0.35)',
                        color: '#fecaca',
                        marginBottom: 12,
                        fontSize: '0.9rem',
                    }}
                >
                    Web Serial is not available in this browser. Try Chrome or Edge.
                </div>
            )}

            {error && (
                <div
                    style={{
                        ...panelChrome,
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: 'rgba(251, 191, 36, 0.1)',
                        border: '1px solid rgba(251, 191, 36, 0.35)',
                        color: '#fcd34d',
                        marginBottom: 12,
                        fontSize: '0.85rem',
                    }}
                >
                    {error}
                </div>
            )}

            <div
                style={{
                    ...panelChrome,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 12,
                    alignItems: 'flex-end',
                    marginBottom: 12,
                    padding: '14px 16px',
                    borderRadius: 10,
                    border: '1px solid rgba(148, 163, 184, 0.2)',
                    background: 'rgba(15, 23, 42, 0.35)',
                }}
            >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200, flex: '1 1 200px' }}>
                    <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>Device</label>
                    <select
                        value={ports.length ? String(selectedIndex) : ''}
                        onChange={(e) => setSelectedIndex(Number(e.target.value))}
                        disabled={!supported || !ports.length || busy}
                        style={{
                            padding: '8px 10px',
                            borderRadius: 8,
                            border: '1px solid rgba(148, 163, 184, 0.25)',
                            background: 'rgba(2, 6, 23, 0.6)',
                            color: '#e2e8f0',
                            fontSize: '0.85rem',
                        }}
                    >
                        {ports.length === 0 ? (
                            <option value="">No devices linked yet</option>
                        ) : (
                            ports.map((p, i) => (
                                <option key={i} value={String(i)}>
                                    {formatPortLabel(p, i)}
                                </option>
                            ))
                        )}
                    </select>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 120 }}>
                    <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>Baud rate</label>
                    <select
                        value={baudRate}
                        onChange={(e) => setBaudRate(Number(e.target.value))}
                        disabled={!supported || busy}
                        style={{
                            padding: '8px 10px',
                            borderRadius: 8,
                            border: '1px solid rgba(148, 163, 184, 0.25)',
                            background: 'rgba(2, 6, 23, 0.6)',
                            color: '#e2e8f0',
                            fontSize: '0.85rem',
                        }}
                    >
                        {BAUD_RATES.map((b) => (
                            <option key={b} value={b}>
                                {b}
                            </option>
                        ))}
                    </select>
                </div>

                <button
                    type="button"
                    onClick={handleLinkDevice}
                    disabled={!supported || busy}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '9px 14px',
                        borderRadius: 8,
                        border: '1px solid rgba(45, 212, 191, 0.35)',
                        background: 'rgba(45, 212, 191, 0.12)',
                        color: '#5eead4',
                        fontWeight: 600,
                        fontSize: '0.8rem',
                        cursor: supported && !busy ? 'pointer' : 'not-allowed',
                        opacity: supported && !busy ? 1 : 0.5,
                    }}
                >
                    <Usb size={16} /> Link USB device
                </button>

                <button
                    type="button"
                    onClick={refreshPorts}
                    disabled={!supported || busy}
                    title="Refresh list of linked devices"
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid rgba(148, 163, 184, 0.25)',
                        background: 'rgba(30, 41, 59, 0.5)',
                        color: '#94a3b8',
                        cursor: supported && !busy ? 'pointer' : 'not-allowed',
                    }}
                >
                    <RefreshCw size={16} />
                </button>

                <button
                    type="button"
                    onClick={handleConnect}
                    disabled={!supported || busy || ports.length === 0}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '9px 18px',
                        borderRadius: 8,
                        border: 'none',
                        background: 'linear-gradient(135deg, #0ea5e9, #0284c7)',
                        color: '#fff',
                        fontWeight: 700,
                        fontSize: '0.82rem',
                        cursor: supported && !busy && ports.length ? 'pointer' : 'not-allowed',
                        opacity: supported && !busy && ports.length ? 1 : 0.45,
                    }}
                >
                    Connect
                </button>

                <button
                    type="button"
                    onClick={handleDisconnect}
                    disabled={status === 'Disconnected' && !busy}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '9px 14px',
                        borderRadius: 8,
                        border: '1px solid rgba(248, 113, 113, 0.35)',
                        background: 'rgba(248, 113, 113, 0.1)',
                        color: '#fca5a5',
                        fontWeight: 600,
                        fontSize: '0.8rem',
                        cursor: status !== 'Disconnected' || busy ? 'pointer' : 'not-allowed',
                        opacity: status !== 'Disconnected' || busy ? 1 : 0.45,
                    }}
                >
                    <Unplug size={16} /> Disconnect
                </button>

                <button
                    type="button"
                    onClick={handleClear}
                    disabled={lines.length === 0}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid rgba(148, 163, 184, 0.2)',
                        background: 'rgba(30, 41, 59, 0.4)',
                        color: '#cbd5e1',
                        fontSize: '0.8rem',
                        cursor: lines.length ? 'pointer' : 'not-allowed',
                        opacity: lines.length ? 1 : 0.45,
                    }}
                >
                    <Trash2 size={16} /> Clear log
                </button>

                <button
                    type="button"
                    onClick={() => void handleSaveLog('csv')}
                    disabled={!canSaveLog || saveBusy}
                    title={`Save CSV to ${SERIAL_WORKSPACE_FOLDER}: tab- or comma-separated lines → columns; first log line skipped (often partial)`}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid rgba(34, 197, 94, 0.35)',
                        background: 'rgba(34, 197, 94, 0.1)',
                        color: '#86efac',
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        cursor: canSaveLog ? 'pointer' : 'not-allowed',
                        opacity: canSaveLog ? 1 : 0.45,
                    }}
                >
                    <Download size={16} /> Save CSV
                </button>

                <button
                    type="button"
                    onClick={() => void handleSaveLog('txt')}
                    disabled={!canSaveLog || saveBusy}
                    title={`Save TXT to workspace folder ${SERIAL_WORKSPACE_FOLDER} (tab-separated timestamp + line)`}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid rgba(34, 197, 94, 0.25)',
                        background: 'rgba(34, 197, 94, 0.06)',
                        color: '#bbf7d0',
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        cursor: canSaveLog ? 'pointer' : 'not-allowed',
                        opacity: canSaveLog ? 1 : 0.45,
                    }}
                >
                    <Download size={16} /> Save TXT
                </button>
            </div>

            <div
                style={{
                    ...panelChrome,
                    marginBottom: 12,
                    padding: '14px 16px',
                    borderRadius: 10,
                    border: '1px solid rgba(56, 189, 248, 0.22)',
                    background: 'rgba(15, 23, 42, 0.45)',
                }}
            >
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>
                    Send to UART (UTF-8)
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                    <textarea
                        value={sendText}
                        onChange={(e) => setSendText(e.target.value)}
                        onKeyDown={(e) => {
                            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                                e.preventDefault();
                                handleSendToPort();
                            }
                        }}
                        disabled={!supported || !isSerialConnected}
                        placeholder={
                            isSerialConnected
                                ? 'Type bytes to send… (Ctrl+Enter or ⌘+Enter to send)'
                                : 'Connect first to enable sending'
                        }
                        rows={3}
                        style={{
                            flex: '1 1 240px',
                            minWidth: 200,
                            padding: '10px 12px',
                            borderRadius: 8,
                            border: '1px solid rgba(148, 163, 184, 0.25)',
                            background: 'rgba(2, 6, 23, 0.65)',
                            color: '#e2e8f0',
                            fontSize: '0.85rem',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                            resize: 'vertical',
                            opacity: isSerialConnected ? 1 : 0.55,
                        }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 130 }}>
                        <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                            After text
                        </label>
                        <select
                            value={sendLineEnding}
                            onChange={(e) => setSendLineEnding(e.target.value)}
                            disabled={!supported || !isSerialConnected}
                            style={{
                                padding: '8px 10px',
                                borderRadius: 8,
                                border: '1px solid rgba(148, 163, 184, 0.25)',
                                background: 'rgba(2, 6, 23, 0.6)',
                                color: '#e2e8f0',
                                fontSize: '0.85rem',
                            }}
                        >
                            <option value="none">No extra bytes</option>
                            <option value="lf">+ Line feed (LF)</option>
                            <option value="crlf">+ CR + LF (CRLF)</option>
                        </select>
                    </div>
                    <button
                        type="button"
                        onClick={handleSendToPort}
                        disabled={!supported || !isSerialConnected}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '10px 16px',
                            borderRadius: 8,
                            border: 'none',
                            background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                            color: '#fff',
                            fontWeight: 700,
                            fontSize: '0.82rem',
                            cursor: supported && isSerialConnected ? 'pointer' : 'not-allowed',
                            opacity: supported && isSerialConnected ? 1 : 0.45,
                        }}
                    >
                        <Send size={17} /> Send
                    </button>
                </div>
            </div>

            <div style={{ ...panelChrome, fontSize: '0.8rem', color: '#94a3b8', marginBottom: 8 }}>
                Status: <span style={{ color: '#e2e8f0' }}>{status}</span>
                {lines.length > 0 && (
                    <span style={{ marginLeft: 12 }}>
                        Lines in buffer: {lines.length}
                        {lines.length >= MAX_LINES && totalReceivedRef.current > MAX_LINES && (
                            <span style={{ color: '#64748b' }}> (older lines trimmed)</span>
                        )}
                    </span>
                )}
            </div>

            {saveFeedback && (
                <div
                    style={{
                        ...panelChrome,
                        padding: '8px 12px',
                        marginBottom: 8,
                        borderRadius: 8,
                        background: 'rgba(34, 197, 94, 0.12)',
                        border: '1px solid rgba(34, 197, 94, 0.35)',
                        color: '#86efac',
                        fontSize: '0.82rem',
                    }}
                >
                    {saveFeedback}
                </div>
            )}

            <div
                ref={logScrollRef}
                style={{
                    flex: 1,
                    minHeight: 140,
                    margin: 0,
                    padding: '14px 16px',
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    borderRadius: 10,
                    border: '1px solid rgba(51, 65, 85, 0.5)',
                    background: 'rgba(2, 6, 23, 0.85)',
                    color: '#a5f3fc',
                    fontSize: '0.8rem',
                    lineHeight: 1.45,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    WebkitOverflowScrolling: 'touch',
                }}
            >
                {lines.length === 0 ? (
                    <span style={{ color: '#64748b' }}>Incoming lines will appear here…</span>
                ) : (
                    lines.map(({ id, text }) => (
                        <div key={id}>{text}</div>
                    ))
                )}
            </div>
        </div>
    );
}
