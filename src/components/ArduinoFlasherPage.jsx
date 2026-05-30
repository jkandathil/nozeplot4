import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
    Cpu,
    Usb,
    Unplug,
    Zap,
    RefreshCw,
    Trash2,
    Plus,
    FileCode2,
    FolderPlus,
    Folder,
    FolderOpen,
    Save,
    Settings2,
    Send,
    Loader2,
    HardDrive,
    Star,
    Library,
    Download,
    ChevronRight,
    ChevronDown,
} from 'lucide-react';
import { BOARDS, DEFAULT_BOARD_ID, getBoardById, KNOWN_USB_VENDORS } from '../arduino/boards.js';
import {
    loadProjects,
    persistProjects,
    loadActiveProjectId,
    persistActiveProjectId,
    makeProject,
    makeFile,
    getMainFile,
    getSketchFileForBuild,
    extraFilesMap,
    uniqueFileName,
    isSketchFileName,
    isMainCandidate,
    DEFAULT_SKETCH,
} from '../arduino/projects.js';
import { flashAvr } from '../arduino/stk500.js';
import { flashEsp } from '../arduino/esptoolFlasher.js';
import { parseIntelHex } from '../arduino/intelHex.js';
import {
    compileSketch,
    getCompileServerUrl,
    setCompileServerUrl,
    resolveCompileBridgeUrl,
    hasCloudCompileService,
    getBuiltInCompileServerUrl,
    BUILD_SERVICE_UNAVAILABLE,
    DEV_COMPILE_BRIDGE_URL,
} from '../arduino/compileClient.js';
import { isWebSerialSupported } from '../arduino/serialIO.js';
import {
    registerArduinoEditorApi,
    registerArduinoAgentActions,
    extractNamedCodeFiles,
} from '../utils/arduinoStudioBridge.js';
import { fileBasename } from '../utils/workspaceFilename.js';
import ArduinoAiPanel from './ArduinoAiPanel.jsx';
import './CodeStudioPage.css';
import './ArduinoFlasherPage.css';

const LS_BOARD = 'arduino:board';
const BAUD_RATES = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];

function langForFile(name) {
    return /\.c$/i.test(name) ? 'c' : 'cpp';
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

/** Merge AI-extracted named files into a project's file list. */
function applyExtractedFiles(project, extracted) {
    let files = project.files.map((f) => ({ ...f }));
    let mainId = project.mainFileId;
    const mainName = getMainFile(project)?.name || 'main.ino';

    const named = extracted.filter((b) => b.name);
    const mainBlocks = extracted.filter((b) => !b.name && b.isMain);
    const looseBlocks = extracted.filter((b) => !b.name && !b.isMain);

    const upsert = (name, body, markMain) => {
        const idx = files.findIndex((f) => f.name.toLowerCase() === name.toLowerCase());
        if (idx >= 0) {
            files[idx] = { ...files[idx], content: body };
            if (markMain) mainId = files[idx].id;
        } else {
            const nf = makeFile(name, body);
            files.push(nf);
            if (markMain) mainId = nf.id;
        }
    };

    for (const b of named) upsert(b.name.split(/[\\/]/).pop(), b.body, b.isMain);
    for (const b of mainBlocks) upsert(mainName, b.body, true);
    // a single loose block with nothing else → replace main
    if (looseBlocks.length === 1 && named.length === 0 && mainBlocks.length === 0) {
        const idx = files.findIndex((f) => f.id === mainId);
        if (idx >= 0) files[idx] = { ...files[idx], content: looseBlocks[0].body };
    }
    return { files, mainId };
}

export default function ArduinoFlasherPage({ workspaceFiles, onSaveSketch, onSaveBinary }) {
    const supported = isWebSerialSupported();

    const [projects, setProjects] = useState(loadProjects);
    const [activeProjectId, setActiveProjectId] = useState(() => loadActiveProjectId(loadProjects()));
    const [activeFileId, setActiveFileId] = useState(null);
    const [expanded, setExpanded] = useState({});
    const [renamingId, setRenamingId] = useState(null);

    const [boardId, setBoardId] = useState(() => {
        try {
            return localStorage.getItem(LS_BOARD) || DEFAULT_BOARD_ID;
        } catch {
            return DEFAULT_BOARD_ID;
        }
    });
    const [compileUrl, setCompileUrl] = useState(() => getBuiltInCompileServerUrl() || getCompileServerUrl());
    const [compileServerReady, setCompileServerReady] = useState(false);
    const cloudCompile = hasCloudCompileService();
    const [showSettings, setShowSettings] = useState(false);
    const [showLibs, setShowLibs] = useState(false);
    const [libDraft, setLibDraft] = useState('');
    const [showWorkspaceImport, setShowWorkspaceImport] = useState(false);

    const [portName, setPortName] = useState('');
    const [monitorBaud, setMonitorBaud] = useState(115200);
    const [monitorConnected, setMonitorConnected] = useState(false);
    const [serialLines, setSerialLines] = useState([]);
    const [sendText, setSendText] = useState('');
    const [sendEnding, setSendEnding] = useState('nl');

    const [flashLog, setFlashLog] = useState('');
    const [progress, setProgress] = useState(null);
    const [busy, setBusy] = useState('');
    const [bottomTab, setBottomTab] = useState('console');
    const [lastArtifact, setLastArtifact] = useState(null);

    const editorRef = useRef(null);
    const portRef = useRef(null);
    const monitorReaderRef = useRef(null);
    const monitorWriterRef = useRef(null);
    const monitorOpenRef = useRef(false);
    const serialLinesRef = useRef([]);
    const flashLogRef = useRef('');
    const lastArtifactRef = useRef(null);
    const importInputRef = useRef(null);
    const projectsRef = useRef(projects);
    const activeProjectIdRef = useRef(activeProjectId);
    const activeFileIdRef = useRef(activeFileId);

    const board = useMemo(() => getBoardById(boardId) || BOARDS[0], [boardId]);
    const activeProject = projects.find((p) => p.id === activeProjectId) || projects[0];
    const activeFile =
        activeProject?.files.find((f) => f.id === activeFileId) || getMainFile(activeProject) || activeProject?.files[0];

    useEffect(() => {
        projectsRef.current = projects;
        persistProjects(projects);
    }, [projects]);
    useEffect(() => {
        activeProjectIdRef.current = activeProjectId;
    }, [activeProjectId]);
    useEffect(() => {
        activeFileIdRef.current = activeFileId;
    }, [activeFileId]);
    useEffect(() => persistActiveProjectId(activeProjectId), [activeProjectId]);
    useEffect(() => {
        serialLinesRef.current = serialLines;
    }, [serialLines]);
    useEffect(() => {
        flashLogRef.current = flashLog;
    }, [flashLog]);
    useEffect(() => {
        lastArtifactRef.current = lastArtifact;
    }, [lastArtifact]);
    useEffect(() => {
        try {
            localStorage.setItem(LS_BOARD, boardId);
        } catch {
            /* ignore */
        }
    }, [boardId]);
    useEffect(() => {
        // expand the active project by default
        if (activeProjectId) setExpanded((e) => ({ ...e, [activeProjectId]: e[activeProjectId] !== false }));
    }, [activeProjectId]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const found = await resolveCompileBridgeUrl();
            if (cancelled) return;
            if (found) {
                setCompileUrl(found);
                setCompileServerReady(true);
            } else {
                setCompileServerReady(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

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

    /* ── Project / file mutations ───────────────────────────────────── */
    const mutateProject = useCallback(
        (projId, fn) => {
            setProjects((prev) => prev.map((p) => (p.id === projId ? fn(p) : p)));
        },
        []
    );

    const setFileContent = useCallback(
        (value) => {
            if (!activeProject || !activeFile) return;
            mutateProject(activeProject.id, (p) => ({
                ...p,
                files: p.files.map((f) => (f.id === activeFile.id ? { ...f, content: value ?? '' } : f)),
            }));
        },
        [activeProject, activeFile, mutateProject]
    );

    const addProject = useCallback(() => {
        const proj = makeProject(`project_${projects.length + 1}`, [makeFile('main.ino', DEFAULT_SKETCH)]);
        setProjects((prev) => [...prev, proj]);
        setActiveProjectId(proj.id);
        setActiveFileId(proj.mainFileId);
        setExpanded((e) => ({ ...e, [proj.id]: true }));
    }, [projects.length]);

    const deleteProject = useCallback(
        (id) => {
            setProjects((prev) => {
                const next = prev.filter((p) => p.id !== id);
                const final = next.length ? next : [makeProject('Blink', [makeFile('blink.ino', DEFAULT_SKETCH)])];
                if (id === activeProjectId) {
                    setActiveProjectId(final[0].id);
                    setActiveFileId(final[0].mainFileId);
                }
                return final;
            });
        },
        [activeProjectId]
    );

    const renameProject = useCallback(
        (id, name) => mutateProject(id, (p) => ({ ...p, name })),
        [mutateProject]
    );

    const addFileToProject = useCallback(
        (projId, name, content = '// new file\n') => {
            const proj = projectsRef.current.find((p) => p.id === projId);
            const finalName = uniqueFileName(proj, name);
            const nf = makeFile(finalName, content);
            mutateProject(projId, (p) => ({ ...p, files: [...p.files, nf] }));
            setActiveProjectId(projId);
            setActiveFileId(nf.id);
            return nf;
        },
        [mutateProject]
    );

    const deleteFile = useCallback(
        (projId, fileId) => {
            mutateProject(projId, (p) => {
                const files = p.files.filter((f) => f.id !== fileId);
                const final = files.length ? files : [makeFile('main.ino', DEFAULT_SKETCH)];
                let mainFileId = p.mainFileId;
                if (fileId === p.mainFileId) mainFileId = (final.find(isMainCandidate) || final[0]).id;
                return { ...p, files: final, mainFileId };
            });
        },
        [mutateProject]
    );

    const renameFile = useCallback(
        (projId, fileId, name) => mutateProject(projId, (p) => ({ ...p, files: p.files.map((f) => (f.id === fileId ? { ...f, name } : f)) })),
        [mutateProject]
    );

    const setMainFile = useCallback(
        (projId, fileId) => mutateProject(projId, (p) => ({ ...p, mainFileId: fileId })),
        [mutateProject]
    );

    /* ── Libraries ──────────────────────────────────────────────────── */
    const addLibrary = useCallback(() => {
        const lib = libDraft.trim();
        if (!lib || !activeProject) return;
        mutateProject(activeProject.id, (p) => ({
            ...p,
            libraries: p.libraries.includes(lib) ? p.libraries : [...p.libraries, lib],
        }));
        setLibDraft('');
    }, [libDraft, activeProject, mutateProject]);

    const removeLibrary = useCallback(
        (lib) => {
            if (!activeProject) return;
            mutateProject(activeProject.id, (p) => ({ ...p, libraries: p.libraries.filter((l) => l !== lib) }));
        },
        [activeProject, mutateProject]
    );

    /* ── Import ─────────────────────────────────────────────────────── */
    const importDiskFiles = useCallback(
        async (fileList) => {
            if (!activeProject || !fileList?.length) return;
            for (const f of Array.from(fileList)) {
                try {
                    const text = await f.text();
                    addFileToProject(activeProject.id, fileBasename(f.name), text);
                    appendLog(`[import] Added ${f.name}`);
                } catch (e) {
                    appendLog(`[import] ${f.name}: ${e?.message || e}`);
                }
            }
        },
        [activeProject, addFileToProject, appendLog]
    );

    const workspaceArduinoFiles = useMemo(() => {
        if (!Array.isArray(workspaceFiles)) return [];
        const arduinoFolderIds = new Set(
            workspaceFiles.filter((f) => f.isFolder && String(f.name) === 'Arduino').map((f) => String(f.id))
        );
        return workspaceFiles.filter(
            (f) =>
                !f.isFolder &&
                isSketchFileName(f.name) &&
                (arduinoFolderIds.has(String(f.folderId)) || typeof f.csvText === 'string')
        );
    }, [workspaceFiles]);

    const importFromWorkspace = useCallback(
        (wf) => {
            if (!activeProject) return;
            const text = typeof wf.csvText === 'string' ? wf.csvText : '';
            if (!text) {
                appendLog(`[import] ${wf.name}: no text content available in workspace.`);
                return;
            }
            addFileToProject(activeProject.id, fileBasename(wf.name), text);
            appendLog(`[import] Loaded ${wf.name} from workspace.`);
            setShowWorkspaceImport(false);
        },
        [activeProject, addFileToProject, appendLog]
    );

    /* ── Save to workspace ──────────────────────────────────────────── */
    const saveProjectToWorkspace = useCallback(() => {
        if (!activeProject || !onSaveSketch) return;
        for (const f of activeProject.files) {
            onSaveSketch(`${activeProject.name}__${f.name}`, f.content);
        }
        appendLog(`[workspace] Saved ${activeProject.files.length} file(s) from "${activeProject.name}" to Arduino/.`);
    }, [activeProject, onSaveSketch, appendLog]);

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

    /* ── AI editor bridge (multi-file) ──────────────────────────────── */
    useEffect(() => {
        registerArduinoEditorApi({
            applyFromMarkdown: (md) => {
                const extracted = extractNamedCodeFiles(md);
                if (!extracted.length) return { ok: false, reason: 'no_code' };
                const proj = projectsRef.current.find((p) => p.id === activeProjectId);
                if (!proj) return { ok: false, reason: 'not_ready' };
                const { files, mainId } = applyExtractedFiles(proj, extracted);
                mutateProject(proj.id, (p) => ({ ...p, files, mainFileId: mainId }));
                // focus the main file so the editor shows the entry point
                setActiveFileId(mainId);
                return { ok: true };
            },
        });
        return () => registerArduinoEditorApi(null);
    }, [activeProjectId, mutateProject]);

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

    const getProjectSnapshotForBuild = useCallback(() => {
        const proj = projectsRef.current.find((p) => p.id === activeProjectIdRef.current) || projectsRef.current[0];
        if (!proj) return null;
        const editor = editorRef.current;
        const fileId = activeFileIdRef.current;
        if (!editor || !fileId) return proj;
        const live = editor.getValue();
        return {
            ...proj,
            files: proj.files.map((f) => (f.id === fileId ? { ...f, content: live } : f)),
        };
    }, []);

    /* ── Compile ────────────────────────────────────────────────────── */
    const runCompile = useCallback(async () => {
        const proj = getProjectSnapshotForBuild();
        if (!proj) return { ok: false, log: 'no project' };
        const sketchFile = getSketchFileForBuild(proj, activeFileIdRef.current);
        if (!sketchFile) {
            appendLog('[build] No .ino sketch to compile. Add a .ino file or open one in the editor.');
            return { ok: false, log: 'no sketch' };
        }
        const ext = board.protocol === 'esptool' ? '.bin' : '.hex';
        appendLog(`[build] Compiling ${sketchFile.name} → ${sketchFile.name.replace(/\.(ino|pde)$/i, ext)} (${board.name}, ${board.fqbn})`);
        setBusy('compile');
        setBottomTab('console');
        try {
            const res = await compileSketch({
                fqbn: board.fqbn,
                sketch: sketchFile.content || '',
                sketchName: sketchFile.name,
                files: extraFilesMap(proj, sketchFile.id),
                libraries: proj.libraries,
            });
            if (res.stdout) appendLog(res.stdout.trim());
            if (res.stderr) appendLog(res.stderr.trim());
            if (!res.ok) {
                appendLog('[build] FAILED');
                return { ok: false, log: res.stderr || res.stdout || 'compile failed' };
            }
            let artifact = null;
            if (res.hexText) {
                parseIntelHex(res.hexText);
                artifact = { kind: 'avr', hexText: res.hexText, name: `${sketchFile.name.replace(/\.(ino|pde)$/i, '')}.hex` };
            } else if (res.parts?.length) {
                artifact = { kind: 'esp', parts: res.parts, name: `${sketchFile.name.replace(/\.(ino|pde)$/i, '')}.bin` };
            }
            if (!artifact) {
                appendLog('[build] Server returned no hex/bin/parts.');
                return { ok: false, log: 'no artifact returned' };
            }
            setLastArtifact(artifact);
            lastArtifactRef.current = artifact;
            appendLog(`[build] OK → ${artifact.name}`);
            return { ok: true, log: res.stdout || 'compiled', artifact };
        } catch (e) {
            appendLog(`[build] ${e?.message || e}`);
            return { ok: false, log: e?.message || String(e) };
        } finally {
            setBusy('');
        }
    }, [board, appendLog, getProjectSnapshotForBuild]);

    /* ── Flash ──────────────────────────────────────────────────────── */
    const onFlashProgress = useCallback(
        (p) => {
            if (p.message) appendLog(`[flash] ${p.message}`);
            if (p.phase === 'log' && p.message) return;
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
                appendLog('[flash] No firmware artifact from build step.');
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
                if (wasMonitoring) setTimeout(() => void startMonitor(), 400);
            }
        },
        [board, requestPort, stopMonitor, startMonitor, onFlashProgress, appendLog]
    );

    const buildAndFlash = useCallback(async () => {
        setBottomTab('console');
        const snap = getProjectSnapshotForBuild();
        const sketch = snap ? getSketchFileForBuild(snap, activeFileIdRef.current) : null;
        appendLog(`[build] Build & Flash: ${sketch?.name || 'sketch'} on ${board.name}`);

        const url = await resolveCompileBridgeUrl({ timeoutMs: 8000 });
        if (!url) {
            setCompileServerReady(false);
            appendLog(`[build] ${BUILD_SERVICE_UNAVAILABLE}`);
            return { ok: false, log: 'no build service' };
        }
        setCompileUrl(url);
        setCompileServerReady(true);
        setCompileServerUrl(url);

        const c = await runCompile();
        if (!c.ok) return c;
        return flashArtifact(c.artifact);
    }, [board, runCompile, flashArtifact, appendLog, getProjectSnapshotForBuild]);

    /* ── Agent action registration ──────────────────────────────────── */
    useEffect(() => {
        registerArduinoAgentActions({
            getProject: () => {
                const proj = projectsRef.current.find((p) => p.id === activeProjectId) || projectsRef.current[0];
                return {
                    name: proj.name,
                    files: proj.files.map((f) => ({ name: f.name, content: f.content, isMain: f.id === proj.mainFileId })),
                    libraries: proj.libraries,
                };
            },
            compile: () => runCompile(),
            flash: () => buildAndFlash(),
            buildAndFlash: () => buildAndFlash(),
            readSerial: async (ms) => {
                if (!monitorOpenRef.current) await startMonitor();
                const before = serialLinesRef.current.length;
                await new Promise((r) => setTimeout(r, ms));
                return serialLinesRef.current.slice(before).map((l) => l.text).join('\n');
            },
            getState: () => ({
                boardName: board.name,
                portConnected: !!portRef.current,
                compileConfigured: !!getCompileServerUrl(),
            }),
        });
        return () => registerArduinoAgentActions(null);
    }, [activeProjectId, runCompile, buildAndFlash, startMonitor, board]);

    const handleSaveFirmware = useCallback(() => {
        if (!lastArtifact || !onSaveBinary) return;
        if (lastArtifact.hexText) onSaveBinary(lastArtifact.name || 'firmware.hex', new TextEncoder().encode(lastArtifact.hexText));
        else if (lastArtifact.bytes) onSaveBinary(lastArtifact.name || 'firmware.bin', lastArtifact.bytes);
        else if (lastArtifact.parts?.length === 1) onSaveBinary(lastArtifact.name || 'firmware.bin', lastArtifact.parts[0].data);
        appendLog('[workspace] Firmware saved.');
    }, [lastArtifact, onSaveBinary, appendLog]);

    const handleProbeCompileServer = useCallback(async () => {
        setBottomTab('console');
        appendLog('[build] Connecting to cloud build service…');
        const found = await resolveCompileBridgeUrl({ timeoutMs: 8000 });
        if (found) {
            setCompileUrl(found);
            setCompileServerUrl(found);
            setCompileServerReady(true);
            appendLog('[build] Build service ready.');
        } else {
            setCompileServerReady(false);
            appendLog(`[build] ${BUILD_SERVICE_UNAVAILABLE}`);
        }
    }, [appendLog]);

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
                    <select className="arduino-select" value={boardId} onChange={(e) => setBoardId(e.target.value)} title="Target board">
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
                    <button
                        className={`arduino-btn ${showLibs ? 'arduino-btn--active' : ''}`}
                        onClick={() => setShowLibs((s) => !s)}
                        title="External libraries for this project"
                    >
                        <Library size={14} /> Libraries{activeProject?.libraries.length ? ` (${activeProject.libraries.length})` : ''}
                    </button>
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

                    <button className="arduino-btn" disabled={!!busy} onClick={() => void runCompile()} title="Compile the open .ino to .hex or .bin">
                        {busy === 'compile' ? <Loader2 className="arduino-spin" size={14} /> : <FileCode2 size={14} />} Build
                    </button>
                    <button
                        className="arduino-btn arduino-btn--primary"
                        disabled={!!busy || boardUnsupported}
                        onClick={() => void buildAndFlash()}
                        title={boardUnsupported ? board.unsupportedReason : 'Compile editor source, then flash to the board'}
                    >
                        {busy === 'compile' || busy === 'flash' ? (
                            <Loader2 className="arduino-spin" size={14} />
                        ) : (
                            <Zap size={14} />
                        )}{' '}
                        Build &amp; Flash
                    </button>
                    {lastArtifact ? (
                        <span className="arduino-firmware-chip" title="Last built firmware">
                            {lastArtifact.name}
                        </span>
                    ) : null}
                    {compileServerReady ? (
                        <span className="arduino-bridge-chip" title="Cloud build service connected">
                            build ready
                        </span>
                    ) : (
                        <span className="arduino-bridge-chip arduino-bridge-chip--off" title="Cloud build service starting">
                            build offline
                        </span>
                    )}
                    <button className={`arduino-btn ${showSettings ? 'arduino-btn--active' : ''}`} onClick={() => setShowSettings((s) => !s)} title="Settings">
                        <Settings2 size={14} />
                    </button>
                </div>
            </header>

            {!compileServerReady ? (
                <div className="arduino-firmware-banner">
                    <strong>Cloud build service starting.</strong> Write your sketch, select board and port, then click{' '}
                    <strong>Build &amp; Flash</strong> — the app compiles your editor code and programs the board.
                    <span className="arduino-firmware-banner-actions">
                        <button type="button" className="arduino-btn" onClick={() => void handleProbeCompileServer()}>
                            <RefreshCw size={14} /> Retry connection
                        </button>
                    </span>
                </div>
            ) : null}

            {showLibs ? (
                <div className="arduino-libs">
                    <div className="arduino-libs-head">
                        <Library size={14} /> <strong>{activeProject?.name}</strong> libraries — installed by the cloud build service before compiling.
                    </div>
                    <div className="arduino-libs-input">
                        <input
                            type="text"
                            placeholder='e.g. ArduinoJson  or  "Adafruit GFX Library@1.11.9"'
                            value={libDraft}
                            onChange={(e) => setLibDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') addLibrary();
                            }}
                        />
                        <button className="arduino-btn" onClick={addLibrary}>
                            <Plus size={14} /> Add
                        </button>
                    </div>
                    <div className="arduino-libs-chips">
                        {activeProject?.libraries.length ? (
                            activeProject.libraries.map((lib) => (
                                <span key={lib} className="arduino-lib-chip">
                                    {lib}
                                    <button onClick={() => removeLibrary(lib)} title="Remove">
                                        ×
                                    </button>
                                </span>
                            ))
                        ) : (
                            <span className="arduino-libs-empty">No libraries. Add by name (Arduino Library Manager names) or name@version.</span>
                        )}
                    </div>
                </div>
            ) : null}

            {showSettings ? (
                <div className="arduino-settings">
                    <p className="arduino-settings-hint">
                        <strong>Build &amp; Flash</strong> compiles your editor source in the cloud to AVR <code>.hex</code> or ESP{' '}
                        <code>.bin</code>, then flashes over Web Serial. No Arduino IDE or manual file export needed.
                    </p>
                    {cloudCompile ? (
                        <p className="arduino-settings-ok">
                            Cloud build service configured{compileServerReady ? ' and connected' : ' (connecting…)'}.
                        </p>
                    ) : import.meta.env.DEV ? (
                        <>
                            <p className="arduino-settings-hint">Local dev: optional compile bridge URL (defaults to {DEV_COMPILE_BRIDGE_URL}).</p>
                            <label className="arduino-settings-row">
                                <span>Dev compile bridge URL</span>
                                <div className="arduino-settings-url-row">
                                    <input
                                        type="text"
                                        placeholder={DEV_COMPILE_BRIDGE_URL}
                                        value={compileUrl}
                                        onChange={(e) => setCompileUrl(e.target.value)}
                                        onBlur={() => setCompileServerUrl(compileUrl.trim())}
                                    />
                                    <button type="button" className="arduino-btn" onClick={() => void handleProbeCompileServer()}>
                                        Test
                                    </button>
                                </div>
                            </label>
                        </>
                    ) : (
                        <p className="arduino-settings-warn">Cloud build service is not configured for this deployment.</p>
                    )}
                    {compileServerReady ? (
                        <p className="arduino-settings-ok">Build service online.</p>
                    ) : (
                        <p className="arduino-settings-warn">{BUILD_SERVICE_UNAVAILABLE}</p>
                    )}
                    {boardUnsupported ? <p className="arduino-settings-warn">{board.unsupportedReason}</p> : null}
                </div>
            ) : null}

            <div className="arduino-body">
                <aside className="arduino-files">
                    <div className="arduino-files-head">
                        <span>Projects</span>
                        <span className="arduino-files-head-actions">
                            <button className="arduino-icon-btn" onClick={() => importInputRef.current?.click()} title="Import code files">
                                <Download size={15} />
                            </button>
                            <button className="arduino-icon-btn" onClick={addProject} title="New project">
                                <FolderPlus size={15} />
                            </button>
                        </span>
                    </div>
                    <input
                        ref={importInputRef}
                        type="file"
                        accept=".ino,.pde,.cpp,.cc,.cxx,.c,.h,.hpp,.hh"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(e) => {
                            void importDiskFiles(e.target.files);
                            e.target.value = '';
                        }}
                    />

                    <div className="arduino-tree">
                        {projects.map((proj) => {
                            const open = expanded[proj.id] !== false;
                            const isActiveProj = proj.id === activeProjectId;
                            return (
                                <div key={proj.id} className={`arduino-tree-proj ${isActiveProj ? 'is-active-proj' : ''}`}>
                                    <div className="arduino-tree-proj-row">
                                        <button
                                            className="arduino-tree-twisty"
                                            onClick={() => setExpanded((s) => ({ ...s, [proj.id]: !open }))}
                                            title={open ? 'Collapse' : 'Expand'}
                                        >
                                            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                        </button>
                                        {renamingId === proj.id ? (
                                            <input
                                                className="arduino-tree-rename"
                                                autoFocus
                                                defaultValue={proj.name}
                                                onBlur={(e) => {
                                                    if (e.target.value.trim()) renameProject(proj.id, e.target.value.trim());
                                                    setRenamingId(null);
                                                }}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') e.target.blur();
                                                    if (e.key === 'Escape') setRenamingId(null);
                                                }}
                                            />
                                        ) : (
                                            <button
                                                className="arduino-tree-proj-name"
                                                onClick={() => {
                                                    setActiveProjectId(proj.id);
                                                    setActiveFileId(getMainFile(proj)?.id);
                                                }}
                                                onDoubleClick={() => setRenamingId(proj.id)}
                                                title={`${proj.name} — double-click to rename`}
                                            >
                                                {open ? <FolderOpen size={13} /> : <Folder size={13} />} {proj.name}
                                            </button>
                                        )}
                                        <button
                                            className="arduino-icon-btn arduino-tree-add"
                                            onClick={() => addFileToProject(proj.id, 'newfile.h')}
                                            title="New file in project"
                                        >
                                            <Plus size={13} />
                                        </button>
                                        <button
                                            className="arduino-icon-btn arduino-tree-del"
                                            onClick={() => deleteProject(proj.id)}
                                            title="Delete project"
                                        >
                                            <Trash2 size={13} />
                                        </button>
                                    </div>
                                    {open ? (
                                        <ul className="arduino-tree-files">
                                            {proj.files.map((f) => {
                                                const isMain = f.id === proj.mainFileId;
                                                const isActive = isActiveProj && f.id === activeFile?.id;
                                                return (
                                                    <li key={f.id} className={isActive ? 'is-active' : ''}>
                                                        {renamingId === f.id ? (
                                                            <input
                                                                className="arduino-tree-rename"
                                                                autoFocus
                                                                defaultValue={f.name}
                                                                onBlur={(e) => {
                                                                    const v = e.target.value.trim();
                                                                    if (v && v !== f.name) renameFile(proj.id, f.id, uniqueFileName({ files: proj.files.filter((x) => x.id !== f.id) }, v));
                                                                    setRenamingId(null);
                                                                }}
                                                                onKeyDown={(e) => {
                                                                    if (e.key === 'Enter') e.target.blur();
                                                                    if (e.key === 'Escape') setRenamingId(null);
                                                                }}
                                                            />
                                                        ) : (
                                                            <button
                                                                className="arduino-file-btn"
                                                                onClick={() => {
                                                                    setActiveProjectId(proj.id);
                                                                    setActiveFileId(f.id);
                                                                }}
                                                                onDoubleClick={() => setRenamingId(f.id)}
                                                                title={`${f.name} — double-click to rename`}
                                                            >
                                                                <FileCode2 size={12} /> {f.name}
                                                                {isMain ? <Star size={10} className="arduino-main-star" /> : null}
                                                            </button>
                                                        )}
                                                        {!isMain ? (
                                                            <button
                                                                className="arduino-icon-btn arduino-file-main"
                                                                onClick={() => setMainFile(proj.id, f.id)}
                                                                title="Set as main sketch"
                                                            >
                                                                <Star size={12} />
                                                            </button>
                                                        ) : null}
                                                        <button
                                                            className="arduino-icon-btn arduino-file-del"
                                                            onClick={() => deleteFile(proj.id, f.id)}
                                                            title="Delete file"
                                                        >
                                                            <Trash2 size={12} />
                                                        </button>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>

                    <div className="arduino-files-foot">
                        <input
                            className="arduino-rename"
                            value={activeFile?.name || ''}
                            onChange={(e) => activeFile && renameFile(activeProject.id, activeFile.id, e.target.value)}
                            title="Rename active file"
                        />
                        {onSaveSketch ? (
                            <button className="arduino-icon-btn" onClick={saveProjectToWorkspace} title="Save whole project to workspace">
                                <Save size={14} />
                            </button>
                        ) : null}
                        {onSaveBinary && lastArtifact ? (
                            <button className="arduino-icon-btn" onClick={handleSaveFirmware} title="Save firmware to workspace">
                                <HardDrive size={14} />
                            </button>
                        ) : null}
                    </div>

                    {workspaceArduinoFiles.length ? (
                        <div className="arduino-ws-import">
                            <button className="arduino-ws-import-head" onClick={() => setShowWorkspaceImport((s) => !s)}>
                                {showWorkspaceImport ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Import from workspace (
                                {workspaceArduinoFiles.length})
                            </button>
                            {showWorkspaceImport ? (
                                <ul className="arduino-ws-list">
                                    {workspaceArduinoFiles.map((wf) => (
                                        <li key={wf.id}>
                                            <button onClick={() => importFromWorkspace(wf)} title={`Load ${wf.name}`}>
                                                <FileCode2 size={11} /> {fileBasename(wf.name)}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            ) : null}
                        </div>
                    ) : null}
                </aside>

                <main className="arduino-editor-col">
                    <div className="arduino-editor-wrap">
                        <Editor
                            theme="noze-code"
                            language={langForFile(activeFile?.name || 'x.cpp')}
                            path={`${activeProject?.id}/${activeFile?.name}`}
                            value={activeFile?.content || ''}
                            beforeMount={beforeMount}
                            onMount={(ed) => {
                                editorRef.current = ed;
                            }}
                            onChange={setFileContent}
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
                            <button className={bottomTab === 'console' ? 'is-active' : ''} onClick={() => setBottomTab('console')}>
                                Console
                            </button>
                            <button className={bottomTab === 'serial' ? 'is-active' : ''} onClick={() => setBottomTab('serial')}>
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
                            <pre className="arduino-console">{flashLog || 'Write or generate a sketch, select board and port, then Build & Flash.'}</pre>
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
                    getProject={() => {
                        const proj = projectsRef.current.find((p) => p.id === activeProjectId) || projectsRef.current[0];
                        return {
                            name: proj.name,
                            files: proj.files.map((f) => ({ name: f.name, content: f.content, isMain: f.id === proj.mainFileId })),
                            libraries: proj.libraries,
                        };
                    }}
                    getConsole={() => `${flashLogRef.current}\n${serialLinesRef.current.slice(-40).map((l) => l.text).join('\n')}`}
                />
            </div>
        </div>
    );
}
