import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
    Cpu,
    Usb,
    Unplug,
    Upload,
    Zap,
    RefreshCw,
    Trash2,
    Plus,
    FileCode2,
    Save,
    Settings2,
    Send,
    Loader2,
    HardDrive,
} from 'lucide-react';
import { BOARDS, DEFAULT_BOARD_ID, getBoardById, KNOWN_USB_VENDORS } from '../arduino/boards.js';
import { flashAvr } from '../arduino/stk500.js';
import { flashEsp } from '../arduino/esptoolFlasher.js';
import { parseIntelHex, looksLikeIntelHex } from '../arduino/intelHex.js';
import { compileSketch, getCompileServerUrl, setCompileServerUrl } from '../arduino/compileClient.js';
import { isWebSerialSupported } from '../arduino/serialIO.js';
import {
    registerArduinoEditorApi,
    registerArduinoAgentActions,
    extractBestArduinoSketch,
} from '../utils/arduinoStudioBridge.js';
import ArduinoAiPanel from './ArduinoAiPanel.jsx';
import './CodeStudioPage.css';
import './ArduinoFlasherPage.css';

const LS_FILES = 'arduino:files:v1';
const LS_ACTIVE = 'arduino:active-file';
const LS_BOARD = 'arduino:board';

const DEFAULT_SKETCH = `// Blink — works on Uno/Nano (LED_BUILTIN) and most ESP32 boards.
#ifndef LED_BUILTIN
#define LED_BUILTIN 2  // common ESP32 onboard LED
#endif

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("NozePlot MCU: hello!");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
  Serial.println("blink");
}
`;

const BAUD_RATES = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];

function loadFiles() {
    try {
        const raw = localStorage.getItem(LS_FILES);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length) return arr;
        }
    } catch {
        /* ignore */
    }
    return [{ id: 'blink', name: 'blink.ino', content: DEFAULT_SKETCH }];
}

function persistFiles(files) {
    try {
        localStorage.setItem(LS_FILES, JSON.stringify(files));
    } catch {
        /* ignore */
    }
}

function portLabel(port, index) {
    try {
        const info = port.getInfo?.() || {};
        if (info.usbVendorId != null) {
            const vendor = KNOWN_USB_VENDORS[info.usbVendorId] || `VID ${info.usbVendorId.toString(16).padStart(4, '0')}`;
            const pid = info.usbProductId != null ? ` · PID ${info.usbProductId.toString(16).padStart(4, '0')}` : '';
            return `${vendor}${pid}`;
        }
    } catch {
        /* ignore */
    }
    return `Port ${index + 1}`;
}

export default function ArduinoFlasherPage({ onSaveSketch, onSaveBinary }) {
    const supported = isWebSerialSupported();
    const [files, setFiles] = useState(loadFiles);
    const [activeId, setActiveId] = useState(() => {
        try {
            return localStorage.getItem(LS_ACTIVE) || loadFiles()[0].id;
        } catch {
            return loadFiles()[0].id;
        }
    });
    const [boardId, setBoardId] = useState(() => {
        try {
            return localStorage.getItem(LS_BOARD) || DEFAULT_BOARD_ID;
        } catch {
            return DEFAULT_BOARD_ID;
        }
    });
    const [compileUrl, setCompileUrl] = useState(() => getCompileServerUrl());
    const [showSettings, setShowSettings] = useState(false);

    const [portName, setPortName] = useState('');
    const [monitorBaud, setMonitorBaud] = useState(115200);
    const [monitorConnected, setMonitorConnected] = useState(false);
    const [serialLines, setSerialLines] = useState([]);
    const [sendText, setSendText] = useState('');
    const [sendEnding, setSendEnding] = useState('nl');

    const [flashLog, setFlashLog] = useState('');
    const [progress, setProgress] = useState(null); // { written, total }
    const [busy, setBusy] = useState('');
    const [bottomTab, setBottomTab] = useState('console');
    const [lastArtifact, setLastArtifact] = useState(null); // { kind, hexText?, parts?, name }

    const editorRef = useRef(null);
    const monacoRef = useRef(null);
    const portRef = useRef(null);
    const monitorReaderRef = useRef(null);
    const monitorWriterRef = useRef(null);
    const monitorOpenRef = useRef(false);
    const serialLinesRef = useRef([]);
    const flashLogRef = useRef('');
    const lastArtifactRef = useRef(null);
    const fileInputRef = useRef(null);

    const board = useMemo(() => getBoardById(boardId) || BOARDS[0], [boardId]);
    const activeFile = files.find((f) => f.id === activeId) || files[0];

    useEffect(() => {
        serialLinesRef.current = serialLines;
    }, [serialLines]);
    useEffect(() => {
        flashLogRef.current = flashLog;
    }, [flashLog]);
    useEffect(() => {
        lastArtifactRef.current = lastArtifact;
    }, [lastArtifact]);
    useEffect(() => persistFiles(files), [files]);
    useEffect(() => {
        try {
            localStorage.setItem(LS_ACTIVE, activeId);
        } catch {
            /* ignore */
        }
    }, [activeId]);
    useEffect(() => {
        try {
            localStorage.setItem(LS_BOARD, boardId);
        } catch {
            /* ignore */
        }
    }, [boardId]);

    const appendLog = useCallback((text) => {
        setFlashLog((prev) => {
            const next = (prev ? `${prev}\n` : '') + text;
            return next.length > 60000 ? next.slice(-60000) : next;
        });
    }, []);

    const pushSerial = useCallback((line) => {
        setSerialLines((prev) => {
            const next = [...prev, { t: Date.now(), text: line }];
            return next.length > 4000 ? next.slice(-4000) : next;
        });
    }, []);

    /* ── Editor ─────────────────────────────────────────────────────── */
    const beforeMount = useCallback((monaco) => {
        monaco.editor.defineTheme('noze-code', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
                'editor.background': '#0c1117',
                'editor.lineHighlightBackground': '#121922',
                'editorCursor.foreground': '#00DE93',
            },
        });
    }, []);

    const onEditorMount = useCallback((editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
    }, []);

    const updateActiveContent = useCallback(
        (value) => {
            setFiles((prev) => prev.map((f) => (f.id === activeId ? { ...f, content: value ?? '' } : f)));
        },
        [activeId]
    );

    /* ── AI editor bridge ───────────────────────────────────────────── */
    useEffect(() => {
        registerArduinoEditorApi({
            applyFromMarkdown: (md) => {
                const block = extractBestArduinoSketch(md);
                if (!block) return { ok: false, reason: 'no_code' };
                setFiles((prev) => prev.map((f) => (f.id === activeId ? { ...f, content: block.body } : f)));
                if (editorRef.current) editorRef.current.setValue(block.body);
                return { ok: true };
            },
        });
        return () => registerArduinoEditorApi(null);
    }, [activeId]);

    /* ── Ports & serial monitor ─────────────────────────────────────── */
    const requestPort = useCallback(async () => {
        if (!supported) return null;
        try {
            const p = await navigator.serial.requestPort();
            portRef.current = p;
            setPortName(portLabel(p, 0));
            return p;
        } catch (e) {
            if (e?.name !== 'NotFoundError') appendLog(`[port] ${e?.message || e}`);
            return null;
        }
    }, [supported, appendLog]);

    const stopMonitor = useCallback(async () => {
        try {
            if (monitorReaderRef.current) {
                await monitorReaderRef.current.cancel().catch(() => {});
                monitorReaderRef.current.releaseLock();
            }
        } catch {
            /* ignore */
        }
        try {
            if (monitorWriterRef.current) monitorWriterRef.current.releaseLock();
        } catch {
            /* ignore */
        }
        try {
            if (monitorOpenRef.current && portRef.current) await portRef.current.close();
        } catch {
            /* ignore */
        }
        monitorReaderRef.current = null;
        monitorWriterRef.current = null;
        monitorOpenRef.current = false;
        setMonitorConnected(false);
    }, []);

    const startMonitor = useCallback(async () => {
        if (!supported) return;
        let p = portRef.current;
        if (!p) p = await requestPort();
        if (!p) return;
        try {
            await p.open({ baudRate: monitorBaud });
            monitorOpenRef.current = true;
            setMonitorConnected(true);
            monitorWriterRef.current = p.writable.getWriter();
            const reader = p.readable.getReader();
            monitorReaderRef.current = reader;
            const decoder = new TextDecoder();
            let buffer = '';
            (async () => {
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        if (value && value.byteLength) {
                            buffer += decoder.decode(value, { stream: true });
                            const parts = buffer.split(/\r?\n/);
                            buffer = parts.pop();
                            for (const part of parts) pushSerial(part);
                        }
                    }
                } catch {
                    /* reader cancelled */
                }
            })();
        } catch (e) {
            appendLog(`[monitor] ${e?.message || e}`);
            monitorOpenRef.current = false;
            setMonitorConnected(false);
        }
    }, [supported, monitorBaud, requestPort, pushSerial, appendLog]);

    const handleSendSerial = useCallback(async () => {
        if (!monitorWriterRef.current) return;
        const ending = sendEnding === 'nl' ? '\n' : sendEnding === 'crnl' ? '\r\n' : '';
        try {
            await monitorWriterRef.current.write(new TextEncoder().encode(sendText + ending));
            pushSerial(`» ${sendText}`);
            setSendText('');
        } catch (e) {
            appendLog(`[monitor tx] ${e?.message || e}`);
        }
    }, [sendText, sendEnding, pushSerial, appendLog]);

    useEffect(() => () => void stopMonitor(), [stopMonitor]);

    /* ── Compile ────────────────────────────────────────────────────── */
    const runCompile = useCallback(async () => {
        const sketch = (files.find((f) => f.id === activeId) || {}).content || '';
        appendLog(`[compile] ${board.name} (${board.fqbn}) …`);
        setBusy('compile');
        setBottomTab('console');
        try {
            const res = await compileSketch({ fqbn: board.fqbn, sketch });
            if (res.stdout) appendLog(res.stdout.trim());
            if (res.stderr) appendLog(res.stderr.trim());
            if (!res.ok) {
                appendLog('[compile] FAILED');
                return { ok: false, log: res.stderr || res.stdout || 'compile failed' };
            }
            let artifact = null;
            if (res.hexText) {
                parseIntelHex(res.hexText); // validate
                artifact = { kind: 'avr', hexText: res.hexText, name: `${activeFile?.name || 'sketch'}.hex` };
            } else if (res.parts?.length) {
                artifact = { kind: 'esp', parts: res.parts, name: `${activeFile?.name || 'sketch'}.bin` };
            }
            if (!artifact) {
                appendLog('[compile] Server returned no hex/bin/parts.');
                return { ok: false, log: 'no artifact returned' };
            }
            setLastArtifact(artifact);
            lastArtifactRef.current = artifact;
            appendLog(`[compile] OK → ${artifact.name}`);
            return { ok: true, log: res.stdout || 'compiled', artifact };
        } catch (e) {
            appendLog(`[compile] ${e?.message || e}`);
            return { ok: false, log: e?.message || String(e) };
        } finally {
            setBusy('');
        }
    }, [files, activeId, board, activeFile, appendLog]);

    /* ── Flash ──────────────────────────────────────────────────────── */
    const onFlashProgress = useCallback(
        (p) => {
            if (p.message) appendLog(`[flash] ${p.message}`);
            if (p.phase === 'log' && p.message) return; // already logged
            if (typeof p.written === 'number' && typeof p.total === 'number' && p.total > 0) {
                setProgress({ written: p.written, total: p.total });
            }
            if (p.phase === 'done') setProgress(null);
        },
        [appendLog]
    );

    const flashArtifact = useCallback(
        async (artifact) => {
            if (board.protocol === 'unsupported') {
                appendLog(`[flash] ${board.unsupportedReason || 'In-browser flashing not supported for this board.'}`);
                return { ok: false, log: board.unsupportedReason || 'unsupported board' };
            }
            if (!artifact) {
                appendLog('[flash] No firmware. Compile (set a server) or upload a .hex/.bin first.');
                return { ok: false, log: 'no firmware' };
            }
            let p = portRef.current;
            if (!p) p = await requestPort();
            if (!p) {
                appendLog('[flash] No serial port selected.');
                return { ok: false, log: 'no port' };
            }

            const wasMonitoring = monitorOpenRef.current;
            await stopMonitor();
            setBusy('flash');
            setBottomTab('console');
            setProgress({ written: 0, total: 1 });
            try {
                if (board.protocol === 'esptool') {
                    let fileArray;
                    if (artifact.parts?.length) {
                        fileArray = artifact.parts.map((part) => ({ data: part.data, address: part.address }));
                    } else if (artifact.kind === 'esp' && artifact.bytes) {
                        fileArray = [{ data: artifact.bytes, address: board.appOffset || 0x10000 }];
                    } else {
                        throw new Error('This artifact is not an ESP binary. Pick the matching board.');
                    }
                    await flashEsp(p, board, fileArray, onFlashProgress);
                } else if (board.protocol === 'stk500v1') {
                    if (!artifact.hexText) throw new Error('AVR flashing needs an Intel HEX (.hex). Pick the matching board.');
                    await flashAvr(p, board, artifact.hexText, onFlashProgress);
                }
                appendLog('[flash] SUCCESS ✓');
                return { ok: true, log: 'flash ok' };
            } catch (e) {
                appendLog(`[flash] ERROR: ${e?.message || e}`);
                return { ok: false, log: e?.message || String(e) };
            } finally {
                setBusy('');
                setProgress(null);
                if (wasMonitoring) {
                    setTimeout(() => void startMonitor(), 400);
                }
            }
        },
        [board, requestPort, stopMonitor, startMonitor, onFlashProgress, appendLog]
    );

    const flashCurrent = useCallback(async () => {
        const wantKind = board.protocol === 'esptool' ? 'esp' : 'avr';
        let artifact = lastArtifactRef.current;
        // Recompile if there's no matching artifact and a compile server is configured.
        if ((!artifact || artifact.kind !== wantKind) && getCompileServerUrl()) {
            const c = await runCompile();
            if (!c.ok) return c;
            artifact = c.artifact;
        }
        return flashArtifact(artifact);
    }, [board, runCompile, flashArtifact]);

    /* ── Upload precompiled binary ──────────────────────────────────── */
    const handleUploadBinary = useCallback(
        async (file) => {
            if (!file) return;
            const name = file.name;
            try {
                if (/\.hex$/i.test(name)) {
                    const text = await file.text();
                    if (!looksLikeIntelHex(text)) throw new Error('Not a valid Intel HEX file.');
                    parseIntelHex(text);
                    const a = { kind: 'avr', hexText: text, name };
                    setLastArtifact(a);
                    lastArtifactRef.current = a;
                    appendLog(`[upload] AVR HEX loaded: ${name}. Pick an AVR board, then Flash.`);
                } else if (/\.bin$/i.test(name)) {
                    const buf = new Uint8Array(await file.arrayBuffer());
                    const a = { kind: 'esp', bytes: buf, parts: [{ address: board.appOffset || 0x10000, data: buf }], name };
                    setLastArtifact(a);
                    lastArtifactRef.current = a;
                    appendLog(`[upload] ESP binary loaded: ${name} (${buf.length} B) @ 0x${(board.appOffset || 0x10000).toString(16)}.`);
                } else {
                    throw new Error('Unsupported file. Use .hex (AVR) or .bin (ESP).');
                }
            } catch (e) {
                appendLog(`[upload] ${e?.message || e}`);
            }
        },
        [board, appendLog]
    );

    /* ── Agent action registration ──────────────────────────────────── */
    useEffect(() => {
        registerArduinoAgentActions({
            getSketch: () => (files.find((f) => f.id === activeId) || {}).content || '',
            compile: () => runCompile(),
            flash: () => flashCurrent(),
            readSerial: async (ms) => {
                if (!monitorOpenRef.current) await startMonitor();
                const before = serialLinesRef.current.length;
                await new Promise((r) => setTimeout(r, ms));
                return serialLinesRef.current
                    .slice(before)
                    .map((l) => l.text)
                    .join('\n');
            },
            getState: () => ({
                boardName: board.name,
                portConnected: !!portRef.current,
                compileConfigured: !!getCompileServerUrl(),
            }),
        });
        return () => registerArduinoAgentActions(null);
    }, [files, activeId, runCompile, flashCurrent, startMonitor, board]);

    /* ── File ops ───────────────────────────────────────────────────── */
    const addFile = useCallback(() => {
        const n = files.length + 1;
        const id = `sketch_${Date.now()}`;
        const name = `sketch_${n}.ino`;
        setFiles((prev) => [...prev, { id, name, content: '// new sketch\nvoid setup() {}\nvoid loop() {}\n' }]);
        setActiveId(id);
    }, [files]);

    const deleteFile = useCallback(
        (id) => {
            setFiles((prev) => {
                const next = prev.filter((f) => f.id !== id);
                const final = next.length ? next : [{ id: 'blink', name: 'blink.ino', content: DEFAULT_SKETCH }];
                if (id === activeId) setActiveId(final[0].id);
                return final;
            });
        },
        [activeId]
    );

    const renameFile = useCallback((id, name) => {
        setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)));
    }, []);

    const handleSaveToWorkspace = useCallback(() => {
        const f = files.find((x) => x.id === activeId);
        if (!f) return;
        if (onSaveSketch) {
            onSaveSketch(f.name, f.content);
            appendLog(`[workspace] Saved ${f.name}.`);
        }
    }, [files, activeId, onSaveSketch, appendLog]);

    const handleSaveFirmware = useCallback(() => {
        if (!lastArtifact || !onSaveBinary) return;
        if (lastArtifact.hexText) {
            onSaveBinary(lastArtifact.name || 'firmware.hex', new TextEncoder().encode(lastArtifact.hexText));
        } else if (lastArtifact.bytes) {
            onSaveBinary(lastArtifact.name || 'firmware.bin', lastArtifact.bytes);
        } else if (lastArtifact.parts?.length === 1) {
            onSaveBinary(lastArtifact.name || 'firmware.bin', lastArtifact.parts[0].data);
        }
        appendLog('[workspace] Firmware saved.');
    }, [lastArtifact, onSaveBinary, appendLog]);

    const pct = progress && progress.total > 0 ? Math.round((progress.written / progress.total) * 100) : null;
    const boardUnsupported = board.protocol === 'unsupported';

    if (!supported) {
        return (
            <div className="arduino-page arduino-page--unsupported">
                <Cpu size={40} />
                <h2>Web Serial not available</h2>
                <p>
                    The Arduino &amp; ESP32 programmer needs the <strong>Web Serial API</strong>. Open NozePlot in a Chromium browser
                    (Chrome, Edge, Opera) over HTTPS or localhost.
                </p>
            </div>
        );
    }

    return (
        <div className="arduino-page">
            <header className="arduino-toolbar">
                <div className="arduino-toolbar-left">
                    <span className="arduino-brand">
                        <Cpu size={16} /> MCU Flash
                    </span>
                    <select
                        className="arduino-select"
                        value={boardId}
                        onChange={(e) => setBoardId(e.target.value)}
                        title="Target board"
                    >
                        <optgroup label="AVR (Arduino)">
                            {BOARDS.filter((b) => b.arch === 'avr').map((b) => (
                                <option key={b.id} value={b.id}>
                                    {b.name}
                                </option>
                            ))}
                        </optgroup>
                        <optgroup label="ESP32 / ESP8266">
                            {BOARDS.filter((b) => b.arch !== 'avr').map((b) => (
                                <option key={b.id} value={b.id}>
                                    {b.name}
                                </option>
                            ))}
                        </optgroup>
                    </select>
                </div>

                <div className="arduino-toolbar-right">
                    <button className="arduino-btn" onClick={() => void requestPort()} title="Choose serial port">
                        <Usb size={14} /> {portName || 'Select port'}
                    </button>
                    {monitorConnected ? (
                        <button className="arduino-btn arduino-btn--warn" onClick={() => void stopMonitor()}>
                            <Unplug size={14} /> Disconnect
                        </button>
                    ) : (
                        <button className="arduino-btn" onClick={() => void startMonitor()} title="Open serial monitor">
                            <RefreshCw size={14} /> Monitor
                        </button>
                    )}
                    <select
                        className="arduino-select arduino-select--baud"
                        value={monitorBaud}
                        onChange={(e) => setMonitorBaud(Number(e.target.value))}
                        title="Monitor baud rate"
                    >
                        {BAUD_RATES.map((b) => (
                            <option key={b} value={b}>
                                {b}
                            </option>
                        ))}
                    </select>

                    {getCompileServerUrl() ? (
                        <button
                            className="arduino-btn"
                            disabled={!!busy}
                            onClick={() => void runCompile()}
                            title="Compile via remote server"
                        >
                            {busy === 'compile' ? <Loader2 className="arduino-spin" size={14} /> : <FileCode2 size={14} />} Verify
                        </button>
                    ) : null}
                    <button
                        className="arduino-btn arduino-btn--primary"
                        disabled={!!busy || boardUnsupported}
                        onClick={() => void flashCurrent()}
                        title={boardUnsupported ? board.unsupportedReason : 'Compile (if server set) and flash'}
                    >
                        {busy === 'flash' ? <Loader2 className="arduino-spin" size={14} /> : <Zap size={14} />} Flash
                    </button>
                    <button className="arduino-btn" onClick={() => fileInputRef.current?.click()} title="Upload precompiled .hex/.bin">
                        <Upload size={14} /> Binary
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".hex,.bin"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void handleUploadBinary(f);
                            e.target.value = '';
                        }}
                    />
                    <button
                        className={`arduino-btn ${showSettings ? 'arduino-btn--active' : ''}`}
                        onClick={() => setShowSettings((s) => !s)}
                        title="Settings"
                    >
                        <Settings2 size={14} />
                    </button>
                </div>
            </header>

            {showSettings ? (
                <div className="arduino-settings">
                    <label className="arduino-settings-row">
                        <span>Remote compile server URL</span>
                        <input
                            type="text"
                            placeholder="https://your-arduino-cli-server.example.com"
                            value={compileUrl}
                            onChange={(e) => setCompileUrl(e.target.value)}
                            onBlur={() => setCompileServerUrl(compileUrl.trim())}
                        />
                    </label>
                    <p className="arduino-settings-hint">
                        Optional. Lets the AI compile sketches to firmware. The server must accept <code>POST /compile</code> with{' '}
                        <code>{'{ fqbn, sketch }'}</code> and return base64 <code>hex</code> (AVR) or <code>bin</code>/<code>parts</code>{' '}
                        (ESP). Without it, write the sketch here and flash a precompiled <code>.hex</code>/<code>.bin</code>.
                    </p>
                    {boardUnsupported ? <p className="arduino-settings-warn">{board.unsupportedReason}</p> : null}
                </div>
            ) : null}

            <div className="arduino-body">
                <aside className="arduino-files">
                    <div className="arduino-files-head">
                        <span>Sketches</span>
                        <button className="arduino-icon-btn" onClick={addFile} title="New sketch">
                            <Plus size={15} />
                        </button>
                    </div>
                    <ul className="arduino-file-list">
                        {files.map((f) => (
                            <li key={f.id} className={f.id === activeId ? 'is-active' : ''}>
                                <button className="arduino-file-btn" onClick={() => setActiveId(f.id)} title={f.name}>
                                    <FileCode2 size={13} /> {f.name}
                                </button>
                                <button className="arduino-icon-btn arduino-file-del" onClick={() => deleteFile(f.id)} title="Delete">
                                    <Trash2 size={13} />
                                </button>
                            </li>
                        ))}
                    </ul>
                    <div className="arduino-files-foot">
                        <input
                            className="arduino-rename"
                            value={activeFile?.name || ''}
                            onChange={(e) => renameFile(activeId, e.target.value)}
                            title="Rename active sketch"
                        />
                        {onSaveSketch ? (
                            <button className="arduino-icon-btn" onClick={handleSaveToWorkspace} title="Save sketch to workspace">
                                <Save size={14} />
                            </button>
                        ) : null}
                        {onSaveBinary && lastArtifact ? (
                            <button className="arduino-icon-btn" onClick={handleSaveFirmware} title="Save firmware to workspace">
                                <HardDrive size={14} />
                            </button>
                        ) : null}
                    </div>
                </aside>

                <main className="arduino-editor-col">
                    <div className="arduino-editor-wrap">
                        <Editor
                            theme="noze-code"
                            language="cpp"
                            path={activeFile?.name}
                            value={activeFile?.content || ''}
                            beforeMount={beforeMount}
                            onMount={onEditorMount}
                            onChange={updateActiveContent}
                            options={{
                                fontSize: 14,
                                minimap: { enabled: true },
                                wordWrap: 'on',
                                tabSize: 2,
                                automaticLayout: true,
                                scrollBeyondLastLine: false,
                                bracketPairColorization: { enabled: true },
                            }}
                        />
                    </div>

                    <section className="arduino-bottom">
                        <div className="arduino-bottom-tabs">
                            <button
                                className={bottomTab === 'console' ? 'is-active' : ''}
                                onClick={() => setBottomTab('console')}
                            >
                                Console
                            </button>
                            <button
                                className={bottomTab === 'serial' ? 'is-active' : ''}
                                onClick={() => setBottomTab('serial')}
                            >
                                Serial Monitor {monitorConnected ? '●' : ''}
                            </button>
                            <span className="arduino-bottom-spacer" />
                            {pct != null ? <span className="arduino-progress-label">{pct}%</span> : null}
                            <button
                                className="arduino-icon-btn"
                                onClick={() => (bottomTab === 'serial' ? setSerialLines([]) : setFlashLog(''))}
                                title="Clear"
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                        {pct != null ? (
                            <div className="arduino-progress">
                                <div className="arduino-progress-bar" style={{ width: `${pct}%` }} />
                            </div>
                        ) : null}
                        {bottomTab === 'console' ? (
                            <pre className="arduino-console">{flashLog || 'Ready. Select a board and a port.\nWrite or generate a sketch, then Flash.'}</pre>
                        ) : (
                            <div className="arduino-serial">
                                <pre className="arduino-serial-out">
                                    {serialLines.length
                                        ? serialLines.map((l) => l.text).join('\n')
                                        : monitorConnected
                                        ? '(waiting for serial data…)'
                                        : 'Not connected. Click Monitor to open the serial port.'}
                                </pre>
                                <div className="arduino-serial-send">
                                    <input
                                        type="text"
                                        placeholder="Send to device…"
                                        value={sendText}
                                        disabled={!monitorConnected}
                                        onChange={(e) => setSendText(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') void handleSendSerial();
                                        }}
                                    />
                                    <select value={sendEnding} onChange={(e) => setSendEnding(e.target.value)} disabled={!monitorConnected}>
                                        <option value="nl">NL</option>
                                        <option value="crnl">CR+NL</option>
                                        <option value="none">None</option>
                                    </select>
                                    <button className="arduino-btn" disabled={!monitorConnected} onClick={() => void handleSendSerial()}>
                                        <Send size={14} />
                                    </button>
                                </div>
                            </div>
                        )}
                    </section>
                </main>

                <ArduinoAiPanel
                    boardName={board.name}
                    getSketch={() => (files.find((f) => f.id === activeId) || {}).content || ''}
                    getConsole={() => `${flashLogRef.current}\n${serialLinesRef.current.slice(-40).map((l) => l.text).join('\n')}`}
                />
            </div>
        </div>
    );
}
