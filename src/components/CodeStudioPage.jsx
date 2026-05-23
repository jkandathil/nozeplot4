import React, { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import { flushSync } from 'react-dom';
import Editor from '@monaco-editor/react';
import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Code2,
    Eraser,
    FilePlus,
    Package,
    PanelLeftClose,
    PanelLeftOpen,
    Play,
    Save,
    Terminal,
    Trash2,
} from 'lucide-react';
import { CODES_WORKSPACE_FOLDER_NAME } from '../utils/workspaceFilename.js';
import CodeStudioAiPanel from './CodeStudioAiPanel.jsx';
import {
    extractFencedCodeBlocks,
    fenceLangToMonacoLanguage,
    pickBestCodeBlock,
    registerCodeStudioEditorApi,
} from '../utils/codeStudioBridge.js';
import './CodeStudioPage.css';

/** Must match the `pyodide` npm version so the CDN assets match the JS API. */
const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';

/**
 * Browser note: stock C `time.sleep` does not yield to the UI. We line-buffer streams and patch
 * `time.sleep` to use `asyncio.sleep` via `pyodide.ffi.run_sync` when stack switching is available
 * (requires `runPythonAsync`, so the browser can paint between sleeps and stdout batches).
 * Falls back to `run_until_complete` if `can_run_sync()` is false (older browsers without JSPI).
 * Top-level `await` in the editor is allowed when using `runPythonAsync`.
 */
const PYODIDE_RUN_PRELUDE = `
import sys as __noze_sys
for __noze_stream in (__noze_sys.stdout, __noze_sys.stderr):
    try:
        __noze_stream.reconfigure(line_buffering=True)
    except Exception:
        pass

import time as __noze_time
import asyncio as __noze_asyncio

def __noze_sleep(seconds):
    sec = float(seconds)
    try:
        from pyodide.ffi import run_sync, can_run_sync
        if can_run_sync():
            run_sync(__noze_asyncio.sleep(sec))
            return
    except Exception:
        pass
    __noze_loop = __noze_asyncio.get_event_loop()
    __noze_loop.run_until_complete(__noze_asyncio.sleep(sec))

__noze_time.sleep = __noze_sleep

def __noze_configure_mpl():
    """If matplotlib is installed, prefer Pyodide HTML backends and mount into #code-studio-mpl-target."""
    try:
        import importlib.util
        if importlib.util.find_spec("matplotlib") is None:
            return
    except Exception:
        return
    try:
        from js import document
        _el = document.getElementById("code-studio-mpl-target")
        if _el is not None:
            document.pyodideMplTarget = _el
    except Exception:
        pass
    try:
        import matplotlib
        for _b in (
            "module://matplotlib_pyodide.html5_canvas_backend",
            "module://matplotlib_pyodide.wasm_backend",
            "webagg",
        ):
            try:
                matplotlib.use(_b, force=True)
                return
            except TypeError:
                try:
                    matplotlib.use(_b)
                    return
                except Exception:
                    continue
            except Exception:
                continue
    except Exception:
        pass

__noze_configure_mpl()
`.trim();

function languageFromFileName(name) {
    const n = String(name).toLowerCase();
    if (n.endsWith('.py')) return 'python';
    if (n.endsWith('.json')) return 'json';
    if (n.endsWith('.md')) return 'markdown';
    if (n.endsWith('.ts')) return 'typescript';
    if (n.endsWith('.tsx')) return 'typescript';
    if (n.endsWith('.js') || n.endsWith('.jsx') || n.endsWith('.mjs') || n.endsWith('.cjs')) return 'javascript';
    if (n.endsWith('.html') || n.endsWith('.htm')) return 'html';
    if (n.endsWith('.css')) return 'css';
    if (n.endsWith('.yaml') || n.endsWith('.yml')) return 'yaml';
    if (n.endsWith('.xml')) return 'xml';
    if (n.endsWith('.sql')) return 'sql';
    if (n.endsWith('.sh')) return 'shell';
    return 'plaintext';
}

async function readWorkspaceTextFile(fileObj) {
    if (!fileObj) return '';
    if (typeof fileObj.csvText === 'string') return fileObj.csvText;
    if (typeof fileObj.csvSnapshot === 'string') return fileObj.csvSnapshot;
    if (fileObj.file instanceof Blob) {
        try {
            return await fileObj.file.text();
        } catch {
            return '';
        }
    }
    return '';
}

function nextUntitledName(existing) {
    const set = new Set(existing.map((n) => String(n).toLowerCase()));
    const base = 'script';
    const ext = '.py';
    if (!set.has(`${base}${ext}`)) return `${base}${ext}`;
    let i = 2;
    while (set.has(`${base}_${i}${ext}`)) i += 1;
    return `${base}_${i}${ext}`;
}

const noopEvt = { stopPropagation() {} };

const LS_CODE_STUDIO_SHOW_FILES = 'noze-code-studio-show-file-list';
const LS_CODE_STUDIO_SHOW_OUTPUT = 'noze-code-studio-show-output-panel';

function readStoredBool(key, defaultValue) {
    if (typeof window === 'undefined') return defaultValue;
    try {
        const v = window.localStorage.getItem(key);
        if (v === '0' || v === 'false') return false;
        if (v === '1' || v === 'true') return true;
    } catch {
        /* ignore */
    }
    return defaultValue;
}

/** Split user input into requirement strings (names, pins, URLs). Not a full pip parser. */
function parsePackageSpecs(raw) {
    const t = String(raw ?? '').trim();
    if (!t) return [];
    const parts = t
        .split(/[,]+/)
        .flatMap((part) => part.trim().split(/\s+/))
        .map((s) => s.trim())
        .filter(Boolean);
    return [...new Set(parts)];
}

/**
 * Pyodide `setStdout({ batched })` with line-buffered streams often emits one logical line per
 * callback without a trailing `\n`. Concatenating those chunks merges runs onto one visual line;
 * insert a newline only when the boundary does not already include one.
 */
function appendCapturedStream(prev, chunk) {
    if (!chunk) return prev;
    if (!prev) return chunk;
    if (!prev.endsWith('\n') && !chunk.startsWith('\n')) {
        return `${prev}\n${chunk}`;
    }
    return prev + chunk;
}

export default function CodeStudioPage({ workspaceFiles = [], onSaveCode, onDeleteFile }) {
    const codesFolderId = useMemo(() => {
        const f = workspaceFiles.find((x) => x?.isFolder && String(x.name) === CODES_WORKSPACE_FOLDER_NAME);
        return f?.id ?? null;
    }, [workspaceFiles]);

    const codeFiles = useMemo(() => {
        if (!codesFolderId) return [];
        return workspaceFiles
            .filter((f) => f && !f.isFolder && String(f.folderId) === String(codesFolderId))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }, [workspaceFiles, codesFolderId]);

    const [activeFileId, setActiveFileId] = useState(null);
    const [editorValue, setEditorValue] = useState('');
    const [dirty, setDirty] = useState(false);
    const [status, setStatus] = useState('');
    const editorRef = useRef(null);
    const monacoRef = useRef(null);
    const saveHandlerRef = useRef(async () => {});
    const runHandlerRef = useRef(async () => {});
    const pyodideRef = useRef(null);
    const mplTargetRef = useRef(null);
    const [pyodideLoading, setPyodideLoading] = useState(false);
    const [runBusy, setRunBusy] = useState(false);
    const [installBusy, setInstallBusy] = useState(false);
    const [packageInput, setPackageInput] = useState('');
    const [output, setOutput] = useState('');
    const [showFileList, setShowFileList] = useState(() => readStoredBool(LS_CODE_STUDIO_SHOW_FILES, true));
    const [showOutputPanel, setShowOutputPanel] = useState(() => readStoredBool(LS_CODE_STUDIO_SHOW_OUTPUT, true));

    useEffect(() => {
        try {
            window.localStorage.setItem(LS_CODE_STUDIO_SHOW_FILES, showFileList ? '1' : '0');
        } catch {
            /* ignore */
        }
    }, [showFileList]);

    useEffect(() => {
        try {
            window.localStorage.setItem(LS_CODE_STUDIO_SHOW_OUTPUT, showOutputPanel ? '1' : '0');
        } catch {
            /* ignore */
        }
    }, [showOutputPanel]);

    const resolvedFileId = useMemo(() => {
        if (activeFileId && codeFiles.some((f) => f.id === activeFileId)) return activeFileId;
        return codeFiles[0]?.id ?? null;
    }, [activeFileId, codeFiles]);

    const activeMeta = useMemo(
        () => (resolvedFileId ? codeFiles.find((f) => f.id === resolvedFileId) || null : null),
        [codeFiles, resolvedFileId]
    );

    const language = activeMeta ? languageFromFileName(activeMeta.name) : 'python';
    const canRunPython = language === 'python';

    const loadIntoEditor = useCallback(async (fileObj) => {
        const text = await readWorkspaceTextFile(fileObj);
        startTransition(() => {
            setEditorValue(text);
            setDirty(false);
        });
    }, []);

    useEffect(() => {
        if (!resolvedFileId) {
            startTransition(() => {
                setEditorValue('');
                setDirty(false);
            });
            return;
        }
        const f = codeFiles.find((x) => x.id === resolvedFileId);
        if (f) void loadIntoEditor(f);
    }, [resolvedFileId, codeFiles, loadIntoEditor]);

    const handleSave = useCallback(async () => {
        if (!onSaveCode) return;
        const name = activeMeta?.name || nextUntitledName(codeFiles.map((f) => f.name));
        const content = editorRef.current?.getValue?.() ?? editorValue;
        try {
            setStatus('Saving…');
            const { fileId } = await onSaveCode({
                fileId: activeMeta?.id ?? null,
                fileName: name,
                content,
            });
            setDirty(false);
            setStatus('Saved');
            if (fileId) setActiveFileId(fileId);
            setTimeout(() => setStatus(''), 2000);
        } catch (e) {
            setStatus(e?.message || 'Save failed');
        }
    }, [activeMeta, codeFiles, editorValue, onSaveCode]);

    useEffect(() => {
        saveHandlerRef.current = handleSave;
    }, [handleSave]);

    const ensurePyodide = useCallback(async () => {
        if (pyodideRef.current) return pyodideRef.current;
        setPyodideLoading(true);
        try {
            const { loadPyodide } = await import('pyodide');
            const py = await loadPyodide({
                indexURL: PYODIDE_INDEX_URL,
                fullStdLib: false,
            });
            py.setStdout({
                batched: (s) => {
                    flushSync(() => {
                        setOutput((prev) => appendCapturedStream(prev, s));
                    });
                },
            });
            py.setStderr({
                batched: (s) => {
                    flushSync(() => {
                        const piece = s ? `[stderr] ${s}` : '';
                        setOutput((prev) => appendCapturedStream(prev, piece));
                    });
                },
            });
            pyodideRef.current = py;
            return py;
        } catch (e) {
            const msg = e?.message || String(e);
            setStatus(`Python runtime failed to load: ${msg}`);
            throw e;
        } finally {
            setPyodideLoading(false);
        }
    }, []);

    const handleInstallPackages = useCallback(async () => {
        const specs = parsePackageSpecs(packageInput);
        if (!specs.length) {
            setStatus('Enter at least one package name.');
            setTimeout(() => setStatus(''), 2500);
            return;
        }
        setInstallBusy(true);
        setStatus('');
        setOutput((prev) => `${prev}\n[packages] Installing: ${specs.join(', ')} …\n`);
        try {
            const py = await ensurePyodide();
            await py.loadPackage('micropip');
            const specJson = JSON.stringify(specs);
            await py.runPythonAsync(`
import micropip
await micropip.install(${specJson})
`);
            setOutput((prev) => `${prev}[packages] Installed (or already present): ${specs.join(', ')}\n`);
        } catch (e) {
            const msg = e?.message || String(e);
            setOutput((prev) => `${prev}[packages] Failed: ${msg}\n`);
            setStatus('Install failed — see output panel.');
        } finally {
            setInstallBusy(false);
        }
    }, [ensurePyodide, packageInput]);

    const handleRunPython = useCallback(async () => {
        if (language !== 'python') return;
        if (installBusy) return;
        const code = editorRef.current?.getValue?.() ?? editorValue;
        setOutput('');
        const mplEl = mplTargetRef.current;
        if (mplEl) {
            mplEl.replaceChildren();
            document.pyodideMplTarget = mplEl;
        } else {
            try {
                delete document.pyodideMplTarget;
            } catch {
                document.pyodideMplTarget = undefined;
            }
        }
        setRunBusy(true);
        setStatus('');
        try {
            const py = await ensurePyodide();
            if (mplEl) {
                document.pyodideMplTarget = mplEl;
            }
            try {
                await py.loadPackagesFromImports(code);
            } catch {
                /* micropip / missing wheels surface on run; avoid blocking Run on scan errors */
            }
            await py.runPythonAsync(`${PYODIDE_RUN_PRELUDE}\n\n${code}`);
            setOutput((prev) => (prev ? prev : '(no output)\n'));
        } catch (e) {
            const msg = e?.message || String(e);
            setOutput((prev) => `${prev}\n[Python error]\n${msg}\n`);
        } finally {
            setRunBusy(false);
        }
    }, [editorValue, ensurePyodide, installBusy, language]);

    useEffect(() => {
        runHandlerRef.current = handleRunPython;
    }, [handleRunPython]);

    const handleNew = useCallback(async () => {
        const name = nextUntitledName(codeFiles.map((f) => f.name));
        const starter = `# ${CODES_WORKSPACE_FOLDER_NAME} — NozePlot Code Studio (Python 3)\n\nprint("Hello")\n`;
        try {
            setStatus('Creating…');
            const { fileId } = await onSaveCode({ fileId: null, fileName: name, content: starter });
            if (fileId) {
                setActiveFileId(fileId);
                setEditorValue(starter);
                setDirty(false);
            }
            setStatus('');
        } catch (e) {
            setStatus(e?.message || 'Could not create file');
        }
    }, [codeFiles, onSaveCode]);

    const handleDelete = useCallback(
        async (e, id) => {
            e?.stopPropagation?.();
            if (!onDeleteFile || !id) return;
            if (!window.confirm('Delete this file from your workspace?')) return;
            onDeleteFile(noopEvt, id);
            if (id === resolvedFileId) {
                setActiveFileId(null);
            }
        },
        [resolvedFileId, onDeleteFile]
    );

    const getEditorCode = useCallback(
        () => editorRef.current?.getValue?.() ?? editorValue,
        [editorValue]
    );
    const getProgramOutput = useCallback(() => output, [output]);

    const handleClearConsole = useCallback(() => {
        setOutput('');
        const mplEl = mplTargetRef.current;
        if (mplEl) {
            mplEl.replaceChildren();
        }
    }, []);

    const applyFromMarkdown = useCallback(
        (markdown) => {
            const ed = editorRef.current;
            if (!ed) return { ok: false, reason: 'not_ready' };
            if (!resolvedFileId) return { ok: false, reason: 'no_file' };
            const pick = pickBestCodeBlock(extractFencedCodeBlocks(markdown));
            if (!pick) return { ok: false, reason: 'no_fence' };
            const model = ed.getModel();
            if (!model) return { ok: false, reason: 'not_ready' };
            const monaco = monacoRef.current;
            const monacoLang = fenceLangToMonacoLanguage(pick.lang);
            ed.pushUndoStop();
            ed.executeEdits('noze-ai-apply', [{ range: model.getFullModelRange(), text: pick.body }]);
            startTransition(() => {
                setEditorValue(pick.body);
                setDirty(true);
            });
            try {
                if (monaco?.editor?.setModelLanguage) {
                    monaco.editor.setModelLanguage(model, monacoLang);
                }
            } catch {
                /* ignore */
            }
            return { ok: true };
        },
        [resolvedFileId]
    );

    useEffect(() => {
        registerCodeStudioEditorApi({ applyFromMarkdown });
        return () => registerCodeStudioEditorApi(null);
    }, [applyFromMarkdown]);

    const beforeMount = useCallback((monaco) => {
        monaco.editor.defineTheme('noze-code', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
                'editor.background': '#0c1117',
                'editor.lineHighlightBackground': '#121922',
                'editorGutter.background': '#0c1117',
                'minimap.background': '#0c111704',
                focusBorder: '#00DE9366',
                'editorCursor.foreground': '#00DE93',
                'editor.selectionBackground': '#00DE9344',
                'editorLineNumber.activeForeground': '#00DE93',
                'editorLineNumber.foreground': '#475569',
            },
        });
    }, []);

    const showEditor = resolvedFileId != null;

    return (
        <div className="code-studio-page">
            <header className="code-studio-header">
                <div className="code-studio-header-top">
                    <div className="code-studio-title">
                        <Code2 size={22} className="code-studio-title-icon" aria-hidden />
                        <div>
                            <h1>Code Studio</h1>
                            <p className="code-studio-sub">
                                Files in <strong>{CODES_WORKSPACE_FOLDER_NAME}</strong>. Full tips are in <strong>Help</strong> → Code Studio.
                            </p>
                        </div>
                    </div>
                    <div className="code-studio-toolbar">
                        <button type="button" className="code-studio-btn code-studio-btn-primary" onClick={() => void handleNew()}>
                            <FilePlus size={16} /> New file
                        </button>
                        <button type="button" className="code-studio-btn" onClick={() => void saveHandlerRef.current()}>
                            <Save size={16} /> Save
                        </button>
                        <button
                            type="button"
                            className="code-studio-btn code-studio-btn-toggle"
                            aria-pressed={showFileList}
                            title={showFileList ? 'Hide file list (more editor width)' : 'Show file list'}
                            onClick={() => setShowFileList((v) => !v)}
                        >
                            {showFileList ? <PanelLeftClose size={16} aria-hidden /> : <PanelLeftOpen size={16} aria-hidden />}
                            Files
                        </button>
                        <button
                            type="button"
                            className="code-studio-btn code-studio-btn-toggle"
                            aria-pressed={showOutputPanel}
                            title={showOutputPanel ? 'Hide output & plots (taller editor)' : 'Show output & plots'}
                            onClick={() => setShowOutputPanel((v) => !v)}
                        >
                            <Terminal size={16} aria-hidden />
                            Output
                        </button>
                        {status ? <span className="code-studio-status">{status}</span> : null}
                        {pyodideLoading ? <span className="code-studio-status">Loading Python runtime (first run)…</span> : null}
                    </div>
                </div>
                <div className="code-studio-package-row">
                    <div className="code-studio-package-row-inner">
                        <label className="code-studio-package-label" htmlFor="code-studio-pip-input">
                            <Package size={14} aria-hidden /> Install packages (micropip)
                        </label>
                        <div className="code-studio-package-controls">
                            <input
                                id="code-studio-pip-input"
                                type="text"
                                className="code-studio-package-input"
                                placeholder="e.g. httpx  or  rich  or  package==1.2.3"
                                value={packageInput}
                                onChange={(e) => setPackageInput(e.target.value)}
                                disabled={installBusy || pyodideLoading}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !installBusy && !pyodideLoading) void handleInstallPackages();
                                }}
                            />
                            <button
                                type="button"
                                className="code-studio-btn code-studio-btn-primary code-studio-package-install-btn"
                                disabled={installBusy || pyodideLoading}
                                onClick={() => void handleInstallPackages()}
                            >
                                {installBusy ? 'Installing…' : 'Install'}
                            </button>
                        </div>
                        <p className="code-studio-package-hint">
                            Space- or comma-separated names. This uses <strong>micropip</strong> (Pyodide), not desktop{' '}
                            <strong>pip</strong>: only packages with compatible wheels work, and installs need network access.
                        </p>
                    </div>
                </div>
            </header>
            <div className={`code-studio-body${showFileList ? '' : ' code-studio-body--hide-files'}`}>
                <aside className="code-studio-files">
                    <div className="code-studio-files-head">
                        <span className="code-studio-files-head-label">{CODES_WORKSPACE_FOLDER_NAME}</span>
                        <button
                            type="button"
                            className="code-studio-files-head-shrink"
                            title="Shrink file list — a slim Codes strip appears on the editor edge to open it again"
                            aria-label="Hide file list"
                            onClick={() => setShowFileList(false)}
                        >
                            <ChevronLeft size={17} strokeWidth={2.25} aria-hidden />
                        </button>
                    </div>
                    {codeFiles.length === 0 ? (
                        <p className="code-studio-files-empty">
                            No files yet. Use <strong>New file</strong> to create your first script in this folder.
                        </p>
                    ) : (
                        <ul className="code-studio-file-list">
                            {codeFiles.map((f) => (
                                <li key={f.id}>
                                    <button
                                        type="button"
                                        className={`code-studio-file-tab${f.id === resolvedFileId ? ' is-active' : ''}`}
                                        onClick={() => setActiveFileId(f.id)}
                                    >
                                        <span className="code-studio-file-name">{f.name}</span>
                                        <span
                                            role="button"
                                            tabIndex={0}
                                            className="code-studio-file-del"
                                            onClick={(ev) => {
                                                ev.stopPropagation();
                                                void handleDelete(ev, f.id);
                                            }}
                                            onKeyDown={(ev) => {
                                                if (ev.key === 'Enter' || ev.key === ' ') {
                                                    ev.stopPropagation();
                                                    void handleDelete(ev, f.id);
                                                }
                                            }}
                                            title="Delete"
                                        >
                                            <Trash2 size={14} />
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </aside>
                <main className="code-studio-editor-wrap">
                    {!showFileList ? (
                        <button
                            type="button"
                            className="code-studio-collapsed-files-tab"
                            title="Show file list"
                            aria-expanded={showFileList}
                            onClick={() => setShowFileList(true)}
                        >
                            <ChevronRight size={18} aria-hidden />
                            <span className="code-studio-collapsed-files-tab-text">Codes</span>
                        </button>
                    ) : null}
                    <div className="code-studio-editor-core">
                    {showEditor ? (
                        <>
                            <div className="code-studio-editor-chrome">
                                <span className="code-studio-breadcrumb">{activeMeta?.name || 'untitled.py'}</span>
                                {dirty ? <span className="code-studio-dirty">● unsaved</span> : null}
                                <span className="code-studio-chrome-spacer" aria-hidden />
                                <button
                                    type="button"
                                    className="code-studio-btn-run"
                                    disabled={!canRunPython || runBusy || pyodideLoading || installBusy}
                                    title={canRunPython ? 'Run Python (Ctrl/⌘+Enter)' : 'Run is only available for Python (.py) files'}
                                    onClick={() => void runHandlerRef.current()}
                                >
                                    <Play size={15} fill="currentColor" />
                                    {runBusy ? 'Running…' : 'Run'}
                                </button>
                                <button
                                    type="button"
                                    className="code-studio-btn-ghost-sm"
                                    onClick={handleClearConsole}
                                    title="Clear output console and matplotlib figures"
                                >
                                    <Eraser size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                                    Clear output
                                </button>
                            </div>
                            <div className="code-studio-monaco">
                                <Editor
                                    key={resolvedFileId || 'buffer'}
                                    height="100%"
                                    theme="noze-code"
                                    path={activeMeta?.name || 'untitled.py'}
                                    language={language}
                                    value={editorValue}
                                    beforeMount={beforeMount}
                                    onChange={(v) => {
                                        setEditorValue(v ?? '');
                                        setDirty(true);
                                    }}
                                    onMount={(editor, monaco) => {
                                        editorRef.current = editor;
                                        monacoRef.current = monaco;
                                        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                                            void saveHandlerRef.current();
                                        });
                                        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
                                            void runHandlerRef.current();
                                        });
                                    }}
                                    options={{
                                        fontSize: 14,
                                        fontFamily: "var(--font-mono), 'JetBrains Mono', ui-monospace, monospace",
                                        fontLigatures: true,
                                        minimap: { enabled: true },
                                        scrollBeyondLastLine: false,
                                        smoothScrolling: true,
                                        cursorBlinking: 'smooth',
                                        padding: { top: 12, bottom: 12 },
                                        lineNumbers: 'on',
                                        renderLineHighlight: 'all',
                                        bracketPairColorization: { enabled: true },
                                        guides: { bracketPairs: true, indentation: true },
                                        tabSize: 4,
                                        insertSpaces: true,
                                        wordWrap: 'on',
                                        automaticLayout: true,
                                    }}
                                />
                            </div>
                            {showEditor && !showOutputPanel ? (
                                <div className="code-studio-collapsed-output-row" role="group" aria-label="Output panel collapsed">
                                    <button
                                        type="button"
                                        className="code-studio-collapsed-output-tab"
                                        title="Show output and matplotlib plots"
                                        aria-expanded={showOutputPanel}
                                        onClick={() => setShowOutputPanel(true)}
                                    >
                                        <ChevronUp size={16} aria-hidden />
                                        <span>Output & plots</span>
                                    </button>
                                    <button
                                        type="button"
                                        className="code-studio-collapsed-output-clear"
                                        title="Clear output console and matplotlib figures"
                                        onClick={handleClearConsole}
                                    >
                                        <Eraser size={14} aria-hidden />
                                        Clear
                                    </button>
                                </div>
                            ) : null}
                            <section
                                className={`code-studio-output-panel${showOutputPanel ? '' : ' code-studio-output-panel--hidden'}`}
                                aria-label="Program output"
                                aria-hidden={!showOutputPanel}
                            >
                                <div className="code-studio-output-head">
                                    <span className="code-studio-output-head-title">Output (stdout / stderr)</span>
                                    <div className="code-studio-output-head-actions">
                                        <button
                                            type="button"
                                            className="code-studio-output-head-clear"
                                            title="Clear output console and matplotlib figures"
                                            onClick={handleClearConsole}
                                        >
                                            <Eraser size={14} aria-hidden />
                                            <span>Clear</span>
                                        </button>
                                        <button
                                            type="button"
                                            className="code-studio-output-head-shrink"
                                            title="Shrink output and plots — click the bar under the editor to show again"
                                            aria-label="Hide output and plots"
                                            onClick={() => setShowOutputPanel(false)}
                                        >
                                            <ChevronDown size={17} strokeWidth={2.25} aria-hidden />
                                        </button>
                                    </div>
                                </div>
                                <pre
                                    className={`code-studio-output-body${output.trim() ? '' : ' is-empty'}`}
                                    role="log"
                                    aria-live="polite"
                                >
                                    {output.trim()
                                        ? output
                                        : canRunPython
                                          ? 'Run a .py file to see print() and errors here.'
                                          : 'Switch to a Python (.py) file to enable Run.'}
                                </pre>
                                {canRunPython ? (
                                    <div className="code-studio-mpl-wrap" aria-label="Matplotlib figures">
                                        <div className="code-studio-mpl-head">Plots (matplotlib)</div>
                                        <div
                                            id="code-studio-mpl-target"
                                            ref={mplTargetRef}
                                            className="code-studio-mpl-target"
                                        />
                                    </div>
                                ) : null}
                            </section>
                        </>
                    ) : (
                        <div className="code-studio-empty-editor">
                            <Code2 size={40} color="#475569" aria-hidden />
                            <p>Create your first file to open the editor. Everything is saved under {CODES_WORKSPACE_FOLDER_NAME} in your workspace.</p>
                            <button type="button" className="code-studio-btn code-studio-btn-primary" onClick={() => void handleNew()}>
                                <FilePlus size={16} /> New file
                            </button>
                        </div>
                    )}
                    </div>
                    <CodeStudioAiPanel
                        fileName={activeMeta?.name || ''}
                        language={language}
                        getCode={getEditorCode}
                        getOutput={getProgramOutput}
                    />
                </main>
            </div>
        </div>
    );
}
