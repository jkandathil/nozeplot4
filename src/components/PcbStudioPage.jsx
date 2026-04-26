import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
    Home,
    CircuitBoard,
    MousePointer2,
    MapPin,
    GitBranch,
    CircleDot,
    Download,
    Trash2,
    Layers,
    Eye,
    EyeOff,
    FileJson,
    FileCode2,
    Upload,
    AlertTriangle,
    Zap,
    Copy,
    ClipboardPaste,
    RotateCw,
    Pentagon,
    Hand,
    ZoomIn,
    ZoomOut,
    Maximize2,
    X,
    Route,
    LayoutTemplate,
    Ruler,
    Grid3x3,
    Lock,
    Unlock,
    RotateCcw,
    Search,
    FileText,
    Package,
    Undo2,
    Redo2,
    List,
    SquareDashed,
} from 'lucide-react';
import {
    emptyPcbDoc,
    newId,
    applyBridgePayload,
    migratePcbDoc,
    parsePcbDocJson,
    activeCopperLayerIds,
    COPPER_LAYER_COUNT_OPTIONS,
    PCB_GRID_PRESETS_MM,
    isCopperLayerVisible,
} from '../pcb/pcbDoc.js';
import {
    snapBoard,
    pickTrackAt,
    pickViaAt,
    pickPolygonAt,
    centroidClipboard,
} from '../pcb/pcbEditorUtils.js';
import {
    PCB_BRIDGE_KEY,
    PCB_BRIDGE_READY_EVENT,
    PCB_WORKFLOW_DEMO_ID,
} from '../pcb/schematicBridge.js';
import {
    CROSS_SELECT_EVENT,
    broadcastCrossSelect,
    readCrossSelectPayload,
    collectPcbCrossPayload,
} from '../pcb/crossSelectBridge.js';
import { getFootprint, listFootprintSummaries, searchFootprints } from '../pcb/footprintLib.js';
import { buildPcbFabricationZip, triggerBlobDownload } from '../pcb/gerberZip.js';
import { exportPcbDocToKicadPcb } from '../pcb/kicadPcbExport.js';
import { runDRC } from '../pcb/pcbDrc.js';
import { autoRoute } from '../pcb/autoRouter.js';
import { renderPcbCanvas, canvasToBoard, boardToCanvas, PCB_LAYER_COLORS } from '../pcb/canvasRenderer.js';
import { createUndoManager } from '../pcb/undoManager.js';
import { generateBomCsv, generatePickAndPlaceCsv, generateIpcD356, downloadTextFile } from '../pcb/bomExport.js';
import OnlineComponentModal from './OnlineComponentModal.jsx';
import FootprintImportModal from './FootprintImportModal.jsx';
import BoardPreviewModal from './BoardPreviewModal.jsx';
import './PcbStudioPage.css';

const PCB_STORAGE_KEY = 'nozePcbDoc:v1';

function selectionKey(sel) {
    return `${sel.kind}:${sel.id}`;
}

function toggleSelectionItem(list, item) {
    const k = selectionKey(item);
    const idx = list.findIndex((s) => selectionKey(s) === k);
    if (idx >= 0) return list.filter((_, i) => i !== idx);
    return [...list, item];
}

function isItemSelected(selected, kind, id) {
    return selected.some((s) => s.kind === kind && s.id === id);
}

function rotLocal(x, y, deg) {
    const r = ((Number(deg) || 0) * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [x * c - y * s, x * s + y * c];
}

function padWorld(pl, pad) {
    const [lx, ly] = rotLocal(pad.x, pad.y, pl.rot || 0);
    return [lx + pl.x, ly + pl.y];
}

function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
}

const MM_PER_MIL = 0.0254;

function mmToMil(mm) {
    return mm / MM_PER_MIL;
}

function footprintBBox(pl) {
    const fp = getFootprint(pl.footprintId);
    if (!fp?.pads?.length) {
        return { minX: pl.x - 2, maxX: pl.x + 2, minY: pl.y - 2, maxY: pl.y + 2 };
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const pad of fp.pads) {
        const [x, y] = padWorld(pl, pad);
        minX = Math.min(minX, x - pad.w / 2);
        maxX = Math.max(maxX, x + pad.w / 2);
        minY = Math.min(minY, y - pad.h / 2);
        maxY = Math.max(maxY, y + pad.h / 2);
    }
    return { minX, maxX, minY, maxY };
}

function PcbStudioPage({ onBackToSchematic }) {
    const [doc, setDoc] = useState(() => emptyPcbDoc());
    const [tool, setTool] = useState('select');
    const [activeLayer, setActiveLayer] = useState('F.Cu');
    const [placeFootprintId, setPlaceFootprintId] = useState('R_0805');
    const [selected, setSelected] = useState([]);
    const [routeDraft, setRouteDraft] = useState(null);
    const [polygonDraft, setPolygonDraft] = useState(null);
    const [drag, setDrag] = useState(null);
    const [exportBusy, setExportBusy] = useState(false);
    const [drcViolations, setDrcViolations] = useState([]);
    const [showOnlineSearch, setShowOnlineSearch] = useState(false);
    const [showFootprintImport, setShowFootprintImport] = useState(false);
    const [libVersion, setLibVersion] = useState(0);
    const [pcbWorkflowDemo, setPcbWorkflowDemo] = useState(false);
    const [showBoardPreview, setShowBoardPreview] = useState(false);
    const [boardPreview, setBoardPreview] = useState({
        solderMask: true,
        brightInactiveLayers: true,
        boldSilk: true,
    });
    const [boardCursorMm, setBoardCursorMm] = useState(null);
    const [showBoardGrid, setShowBoardGrid] = useState(true);
    const [displayUnits, setDisplayUnits] = useState('mm');
    const [relativeOriginMm, setRelativeOriginMm] = useState(null);
    const [selectionFilter, setSelectionFilter] = useState({
        placement: true,
        track: true,
        via: true,
        polygon: true,
    });
    const [measureStart, setMeasureStart] = useState(null);
    const [measureEnd, setMeasureEnd] = useState(null);
    const [lockedLayers, setLockedLayers] = useState(new Set());
    const [footprintSearchQuery, setFootprintSearchQuery] = useState('');
    const [showNetClassesPanel, setShowNetClassesPanel] = useState(false);

    const canvasRef = useRef(null);
    const canvasWrapRef = useRef(null);
    const animFrameRef = useRef(null);
    const boardJsonImportRef = useRef(null);
    const clipboardRef = useRef(null);
    const lastPointerBoardRef = useRef([20, 20]);
    const undoMgrRef = useRef(createUndoManager(64));
    /** Refs for fast-changing state used in render loop (avoids effect restarts) */
    const boardCursorMmRef = useRef(null);
    const renderDirtyRef = useRef(true);

    const snap = useCallback(
        (v) => snapBoard(v, doc.meta?.gridMm ?? 0.5, doc.meta?.snapToGrid !== false),
        [doc.meta?.gridMm, doc.meta?.snapToGrid],
    );

    const docRef = useRef(doc);
    const selectedRef = useRef(selected);
    useEffect(() => {
        docRef.current = doc;
        selectedRef.current = selected;
    }, [doc, selected]);

    const [schCrossHighlight, setSchCrossHighlight] = useState({ refs: [], nets: [] });

    useEffect(() => {
        const apply = () => {
            const raw = readCrossSelectPayload();
            if (!raw || raw.from !== 'schematic') {
                setSchCrossHighlight({ refs: [], nets: [] });
                return;
            }
            setSchCrossHighlight({ refs: raw.refs || [], nets: raw.nets || [] });
        };
        apply();
        window.addEventListener(CROSS_SELECT_EVENT, apply);
        return () => window.removeEventListener(CROSS_SELECT_EVENT, apply);
    }, []);

    useEffect(() => {
        const { refs, nets } = collectPcbCrossPayload(doc, selected);
        broadcastCrossSelect({ from: 'pcb', refs, nets });
    }, [doc, selected]);

    const schCrossRefs = useMemo(
        () => new Set(schCrossHighlight.refs.map((r) => String(r).toUpperCase())),
        [schCrossHighlight.refs],
    );
    const schCrossNets = useMemo(
        () => new Set(schCrossHighlight.nets.map((n) => String(n).toLowerCase())),
        [schCrossHighlight.nets],
    );

    const fpSummaries = useMemo(() => {
        if (footprintSearchQuery.trim()) {
            return searchFootprints(footprintSearchQuery);
        }
        return listFootprintSummaries();
    }, [libVersion, footprintSearchQuery]);

    const copperStack = useMemo(() => activeCopperLayerIds(doc), [doc.meta?.copperLayerCount]);
    const layerDrawOrder = useMemo(() => [...copperStack].reverse(), [copperStack]);
    const inactiveCopperOpacity = boardPreview.brightInactiveLayers ? 0.9 : 0.4;
    const anyCopperLayerVisible = useMemo(
        () => copperStack.some((ly) => isCopperLayerVisible(doc, ly)),
        [copperStack, doc],
    );

    const toggleCopperLayerVisibility = useCallback((ly) => {
        setDoc((d) => {
            const stack = activeCopperLayerIds(d);
            const nVis = stack.filter((l) => isCopperLayerVisible(d, l)).length;
            if (nVis <= 1 && isCopperLayerVisible(d, ly)) return d;
            const vis = { ...(d.meta.layerVisibility || {}) };
            if (isCopperLayerVisible(d, ly)) vis[ly] = false;
            else delete vis[ly];
            return { ...d, meta: { ...d.meta, layerVisibility: vis } };
        });
    }, []);

    const handleRunDRC = useCallback(() => {
        const v = runDRC(doc, getFootprint);
        setDrcViolations(v);
        if (v.length === 0) {
            window.alert('DRC Passed! No clearance violations found.');
        }
    }, [doc]);

    useEffect(() => {
        const consumeBridge = () => {
            try {
                const raw = sessionStorage.getItem(PCB_BRIDGE_KEY);
                if (!raw) return false;
                const bridge = JSON.parse(raw);
                sessionStorage.removeItem(PCB_BRIDGE_KEY);
                setPcbWorkflowDemo(bridge.workflowDemo === PCB_WORKFLOW_DEMO_ID);
                setDoc(migratePcbDoc(applyBridgePayload(emptyPcbDoc(), bridge)));
                setDrcViolations([]);
                setSelected([]);
                return true;
            } catch {
                return false;
            }
        };

        const boot = () => {
            if (consumeBridge()) return;
            try {
                const saved = localStorage.getItem(PCB_STORAGE_KEY);
                if (saved) setDoc(migratePcbDoc(JSON.parse(saved)));
            } catch {
                /* ignore */
            }
        };

        boot();
        const onBridgeReady = () => {
            consumeBridge();
        };
        window.addEventListener(PCB_BRIDGE_READY_EVENT, onBridgeReady);
        return () => window.removeEventListener(PCB_BRIDGE_READY_EVENT, onBridgeReady);
    }, []);

    useEffect(() => {
        setActiveLayer((prev) => (copperStack.includes(prev) ? prev : copperStack[0]));
    }, [copperStack]);

    useEffect(() => {
        if (tool !== 'measure') {
            setMeasureStart(null);
            setMeasureEnd(null);
        }
    }, [tool]);

    useEffect(() => {
        if (!copperStack.length) return;
        if (!isCopperLayerVisible(doc, activeLayer)) {
            const next = copperStack.find((ly) => isCopperLayerVisible(doc, ly));
            if (next) setActiveLayer(next);
        }
    }, [doc.meta?.layerVisibility, copperStack, doc, activeLayer]);

    useEffect(() => {
        setDrcViolations([]);
        const t = setTimeout(() => {
            try {
                localStorage.setItem(PCB_STORAGE_KEY, JSON.stringify(doc));
            } catch {
                /* quota */
            }
        }, 400);
        return () => clearTimeout(t);
    }, [doc]);

    const W = Number(doc.meta?.boardWmm) || 80;
    const H = Number(doc.meta?.boardHmm) || 50;

    const [pcbViewport, setPcbViewport] = useState({ zoom: 1, panX: 0, panY: 0 });
    const [pcbViewDrag, setPcbViewDrag] = useState(false);
    const pcbViewportRef = useRef(pcbViewport);
    pcbViewportRef.current = pcbViewport;

    useEffect(() => {
        setPcbViewport((vp) => {
            const vw = W / vp.zoom;
            const vh = H / vp.zoom;
            return {
                ...vp,
                panX: clamp(vp.panX, 0, Math.max(0, W - vw)),
                panY: clamp(vp.panY, 0, Math.max(0, H - vh)),
            };
        });
    }, [W, H]);

    const fitViewport = useCallback(() => {
        setPcbViewport({ zoom: 1, panX: 0, panY: 0 });
    }, []);

    const zoomViewportAt = useCallback((factor, centerBoardX, centerBoardY) => {
        setPcbViewport((vp) => {
            const z = clamp(vp.zoom * factor, 0.2, 32);
            const vw0 = W / vp.zoom;
            const vh0 = H / vp.zoom;
            const vw1 = W / z;
            const vh1 = H / z;
            const u = vw0 > 1e-9 ? (centerBoardX - vp.panX) / vw0 : 0.5;
            const v = vh0 > 1e-9 ? (centerBoardY - vp.panY) / vh0 : 0.5;
            let panX = centerBoardX - u * vw1;
            let panY = centerBoardY - v * vh1;
            panX = clamp(panX, 0, Math.max(0, W - vw1));
            panY = clamp(panY, 0, Math.max(0, H - vh1));
            return { zoom: z, panX, panY };
        });
    }, [W, H]);

    useEffect(() => {
        const wrap = canvasWrapRef.current;
        if (!wrap) return;
        const onWheel = (e) => {
            if (!canvasRef.current || W < 1 || H < 1) return;
            e.preventDefault();
            const canvas = canvasRef.current;
            const rect = canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const vp = pcbViewportRef.current;
            const [cx, cy] = canvasToBoard(
                e.clientX - rect.left,
                e.clientY - rect.top,
                vp,
                canvas.width / dpr,
                canvas.height / dpr,
                W,
                H,
                dpr
            );
            const delta = e.deltaY;
            const factor = delta > 0 ? 0.92 : 1 / 0.92;
            setPcbViewport((vp) => {
                const z = clamp(vp.zoom * factor, 0.2, 32);
                const vw0 = W / vp.zoom;
                const vh0 = H / vp.zoom;
                const vw1 = W / z;
                const vh1 = H / z;
                const u = vw0 > 1e-9 ? (cx - vp.panX) / vw0 : 0.5;
                const v = vh0 > 1e-9 ? (cy - vp.panY) / vh0 : 0.5;
                let panX = cx - u * vw1;
                let panY = cy - v * vh1;
                panX = clamp(panX, 0, Math.max(0, W - vw1));
                panY = clamp(panY, 0, Math.max(0, H - vh1));
                return { zoom: z, panX, panY };
            });
        };
        wrap.addEventListener('wheel', onWheel, { passive: false });
        return () => wrap.removeEventListener('wheel', onWheel);
    }, [W, H]);

    useEffect(() => {
        if (!pcbViewDrag) return;
        const onMove = (ev) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            setPcbViewport((vp) => {
                const vw = W / vp.zoom;
                const vh = H / vp.zoom;
                const dx = -(ev.movementX / Math.max(rect.width, 1)) * vw;
                const dy = -(ev.movementY / Math.max(rect.height, 1)) * vh;
                const panX = clamp(vp.panX + dx, 0, Math.max(0, W - vw));
                const panY = clamp(vp.panY + dy, 0, Math.max(0, H - vh));
                return { ...vp, panX, panY };
            });
        };
        const onUp = () => setPcbViewDrag(false);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [pcbViewDrag, W, H]);

    const padCentersByNet = useMemo(() => {
        const map = new Map();
        for (const pl of doc.placements || []) {
            const fp = getFootprint(pl.footprintId);
            if (!fp) continue;
            const nets = pl.padNets || {};
            for (const pad of fp.pads || []) {
                const net = nets[pad.num] || nets[pad.id];
                if (!net || net === '0') continue;
                const [x, y] = padWorld(pl, pad);
                if (!map.has(net)) map.set(net, []);
                map.get(net).push([x, y]);
            }
        }
        return map;
    }, [doc.placements]);

    const handleAutoRoute = useCallback(() => {
        if (padCentersByNet.size === 0) {
            window.alert('No nets to route! Ensure your schematic components are wired together before sending to PCB Studio.');
            return;
        }
        undoMgrRef.current.push(doc);
        const result = autoRoute(doc, padCentersByNet);
        const newTracks = result.tracks || [];
        const newVias = result.vias || [];
        setDoc((d) => ({
            ...d,
            tracks: [...(d.tracks || []), ...newTracks],
            vias: [...(d.vias || []), ...newVias],
        }));
    }, [doc, padCentersByNet]);

    const handleExportZip = useCallback(async () => {
        if (exportBusy) return;
        setExportBusy(true);
        try {
            const fab = buildPcbFabricationZip(doc);
            triggerBlobDownload(fab, 'pcb-fab.zip');
        } catch (err) {
            console.error('Export failed:', err);
            window.alert('Export failed: ' + err.message);
        } finally {
            setExportBusy(false);
        }
    }, [doc, exportBusy]);

    const handleExportKicad = useCallback(() => {
        try {
            const kicadText = exportPcbDocToKicadPcb(doc);
            downloadTextFile(kicadText, 'board.kicad_pcb');
        } catch (err) {
            console.error('KiCad export failed:', err);
            window.alert('KiCad export failed: ' + err.message);
        }
    }, [doc]);

    const handleExportBom = useCallback(() => {
        try {
            const csv = generateBomCsv(doc, getFootprint);
            downloadTextFile(csv, 'bom.csv');
        } catch (err) {
            console.error('BOM export failed:', err);
            window.alert('BOM export failed: ' + err.message);
        }
    }, [doc]);

    const handleExportPickAndPlace = useCallback(() => {
        try {
            const csv = generatePickAndPlaceCsv(doc, getFootprint);
            downloadTextFile(csv, 'pick-place.csv');
        } catch (err) {
            console.error('Pick & Place export failed:', err);
            window.alert('Pick & Place export failed: ' + err.message);
        }
    }, [doc]);

    const handleExportIpcD356 = useCallback(() => {
        try {
            const txt = generateIpcD356(doc);
            downloadTextFile(txt, 'netlist.ipc');
        } catch (err) {
            console.error('IPC-D-356 export failed:', err);
            window.alert('IPC-D-356 export failed: ' + err.message);
        }
    }, [doc]);

    const handleCopy = useCallback(() => {
        if (!selected.length) return;
        const items = [];
        for (const sel of selected) {
            if (sel.kind === 'placement') {
                const p = doc.placements?.find((x) => x.id === sel.id);
                if (p) items.push({ kind: 'placement', obj: p });
            } else if (sel.kind === 'track') {
                const t = doc.tracks?.find((x) => x.id === sel.id);
                if (t) items.push({ kind: 'track', obj: t });
            } else if (sel.kind === 'via') {
                const v = doc.vias?.find((x) => x.id === sel.id);
                if (v) items.push({ kind: 'via', obj: v });
            } else if (sel.kind === 'polygon') {
                const p = doc.polygons?.find((x) => x.id === sel.id);
                if (p) items.push({ kind: 'polygon', obj: p });
            }
        }
        clipboardRef.current = items;
    }, [doc, selected]);

    const handlePaste = useCallback(() => {
        if (!clipboardRef.current?.length || !boardCursorMm) return;
        undoMgrRef.current.push(doc);
        const [pasteX, pasteY] = boardCursorMm;
        const items = clipboardRef.current;
        const refPoints = [];
        for (const item of items) {
            if (item.kind === 'placement') refPoints.push([item.obj.x, item.obj.y]);
            else if (item.kind === 'track' && item.obj.points?.length)
                refPoints.push(item.obj.points[0]);
            else if (item.kind === 'via') refPoints.push([item.obj.x, item.obj.y]);
            else if (item.kind === 'polygon' && item.obj.points?.length)
                refPoints.push(item.obj.points[0]);
        }
        const refX = refPoints.length ? refPoints[0][0] : 0;
        const refY = refPoints.length ? refPoints[0][1] : 0;
        const dx = pasteX - refX;
        const dy = pasteY - refY;
        const newSelections = [];
        setDoc((d) => {
            let newDoc = { ...d };
            for (const item of items) {
                if (item.kind === 'placement') {
                    const p = { ...item.obj, id: newId(), x: item.obj.x + dx, y: item.obj.y + dy };
                    newDoc = {
                        ...newDoc,
                        placements: [...(newDoc.placements || []), p],
                    };
                    newSelections.push({ kind: 'placement', id: p.id });
                } else if (item.kind === 'track') {
                    const t = {
                        ...item.obj,
                        id: newId(),
                        points: item.obj.points?.map((pt) => [pt[0] + dx, pt[1] + dy]) || [],
                    };
                    newDoc = {
                        ...newDoc,
                        tracks: [...(newDoc.tracks || []), t],
                    };
                    newSelections.push({ kind: 'track', id: t.id });
                } else if (item.kind === 'via') {
                    const v = { ...item.obj, id: newId(), x: item.obj.x + dx, y: item.obj.y + dy };
                    newDoc = {
                        ...newDoc,
                        vias: [...(newDoc.vias || []), v],
                    };
                    newSelections.push({ kind: 'via', id: v.id });
                } else if (item.kind === 'polygon') {
                    const pg = {
                        ...item.obj,
                        id: newId(),
                        points: item.obj.points?.map((pt) => [pt[0] + dx, pt[1] + dy]) || [],
                    };
                    newDoc = {
                        ...newDoc,
                        polygons: [...(newDoc.polygons || []), pg],
                    };
                    newSelections.push({ kind: 'polygon', id: pg.id });
                }
            }
            return newDoc;
        });
        setSelected(newSelections);
    }, [doc, boardCursorMm]);

    const handleUndo = useCallback(() => {
        if (!undoMgrRef.current.canUndo()) return;
        const prev = undoMgrRef.current.undo();
        if (prev) {
            setDoc(prev);
            setSelected([]);
        }
    }, []);

    const handleRedo = useCallback(() => {
        if (!undoMgrRef.current.canRedo()) return;
        const next = undoMgrRef.current.redo();
        if (next) {
            setDoc(next);
            setSelected([]);
        }
    }, []);

    /* ── Commit / cancel route draft ── */
    const commitRouteDraft = useCallback(() => {
        if (!routeDraft || routeDraft.length < 2) { setRouteDraft(null); return; }
        undoMgrRef.current.push(doc);
        const newTrack = {
            id: newId('tr'),
            layer: activeLayer,
            widthMm: doc.meta?.defaultTrackMm || 0.35,
            net: '',
            points: routeDraft,
        };
        setDoc((d) => ({ ...d, tracks: [...(d.tracks || []), newTrack] }));
        setRouteDraft(null);
    }, [routeDraft, doc, activeLayer]);

    const commitPolygonDraft = useCallback(() => {
        if (!polygonDraft || polygonDraft.length < 3) { setPolygonDraft(null); return; }
        undoMgrRef.current.push(doc);
        const newPoly = {
            id: newId('pg'),
            layer: activeLayer,
            net: '',
            points: polygonDraft,
        };
        setDoc((d) => ({ ...d, polygons: [...(d.polygons || []), newPoly] }));
        setPolygonDraft(null);
    }, [polygonDraft, doc, activeLayer]);

    /* ── Insert via at cursor and switch layer (V / top bar during routing) ── */
    const insertViaAndSwitchLayer = useCallback((opts = {}) => {
        const reverse = !!opts.reverseLayer;
        const cursor = boardCursorMmRef.current || lastPointerBoardRef.current;
        const pt = [snap(cursor[0]), snap(cursor[1])];
        const stack = activeCopperLayerIds(doc);
        const curIdx = Math.max(0, stack.indexOf(activeLayer));
        const dir = reverse ? -1 : 1;
        const targetLayer = stack[(curIdx + dir + stack.length) % stack.length];

        undoMgrRef.current.push(doc);

        // If routing, commit current segment up to the via point, add via, start new draft on other layer
        if (routeDraft && routeDraft.length >= 1) {
            const draftWithVia = [...routeDraft, pt];
            const newTrack = {
                id: newId('tr'),
                layer: activeLayer,
                widthMm: doc.meta?.defaultTrackMm || 0.35,
                net: '',
                points: draftWithVia,
            };
            const newVia = {
                id: newId('via'),
                x: pt[0],
                y: pt[1],
                drillMm: doc.meta?.defaultViaDrillMm || 0.4,
                diamMm: doc.meta?.defaultViaDiamMm || 0.8,
                net: '',
            };
            setDoc((d) => ({
                ...d,
                tracks: [...(d.tracks || []), newTrack],
                vias: [...(d.vias || []), newVia],
            }));
            setRouteDraft([pt]); // start new draft from via point on new layer
        } else {
            // Not routing — just add a standalone via
            const newVia = {
                id: newId('via'),
                x: pt[0],
                y: pt[1],
                drillMm: doc.meta?.defaultViaDrillMm || 0.4,
                diamMm: doc.meta?.defaultViaDiamMm || 0.8,
                net: '',
            };
            setDoc((d) => ({ ...d, vias: [...(d.vias || []), newVia] }));
        }
        setActiveLayer(targetLayer);
    }, [routeDraft, doc, activeLayer, snap]);

    useEffect(() => {
        // Don't capture keys when an input/select/textarea is focused
        const isInput = () => {
            const el = document.activeElement;
            return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA');
        };

        const onKeyDown = (e) => {
            /* ── Escape: cancel draft or clear selection ── */
            if (e.key === 'Escape') {
                if (routeDraft) { setRouteDraft(null); return; }
                if (polygonDraft) { setPolygonDraft(null); return; }
                if (measureStart || measureEnd) { setMeasureStart(null); setMeasureEnd(null); return; }
                if (selected.length > 0) { setSelected([]); return; }
                return;
            }
            /* ── Enter: commit draft ── */
            if (e.key === 'Enter') {
                if (routeDraft) { commitRouteDraft(); return; }
                if (polygonDraft) { commitPolygonDraft(); return; }
                return;
            }
            /* ── Ctrl+Z / Ctrl+Y ── */
            if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (e.shiftKey) handleRedo();
                else handleUndo();
                return;
            }
            if (e.key === 'y' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleRedo();
                return;
            }
            /* ── Ctrl+C / Ctrl+V ── */
            if (e.key === 'c' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleCopy(); return; }
            if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); handlePaste(); return; }

            if (isInput()) return; // Below this: letter keys that shouldn't fire in text fields

            /* ── V: insert via + next copper layer (Shift+V = previous layer) ── */
            if (e.key === 'v' || e.key === 'V') {
                if (tool === 'route') {
                    insertViaAndSwitchLayer({ reverseLayer: e.shiftKey });
                    return;
                }
            }
            /* ── Delete / Backspace ── */
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                // If routing, undo last point
                if (routeDraft && routeDraft.length > 0) {
                    if (routeDraft.length === 1) { setRouteDraft(null); }
                    else { setRouteDraft(routeDraft.slice(0, -1)); }
                    return;
                }
                if (selected.length > 0) {
                    undoMgrRef.current.push(doc);
                    setDoc((d) => ({
                        ...d,
                        placements: d.placements?.filter((p) => !isItemSelected(selected, 'placement', p.id)) || [],
                        tracks: d.tracks?.filter((t) => !isItemSelected(selected, 'track', t.id)) || [],
                        vias: d.vias?.filter((v) => !isItemSelected(selected, 'via', v.id)) || [],
                        polygons: d.polygons?.filter((pg) => !isItemSelected(selected, 'polygon', pg.id)) || [],
                    }));
                    setSelected([]);
                }
                return;
            }
            /* ── D: duplicate ── */
            if (e.key === 'd' || e.key === 'D') {
                if (selected.length > 0) {
                    undoMgrRef.current.push(doc);
                    const newSelections = [];
                    setDoc((d) => {
                        let newDoc = { ...d };
                        for (const sel of selected) {
                            if (sel.kind === 'placement') {
                                const p = newDoc.placements?.find((x) => x.id === sel.id);
                                if (p) {
                                    const dup = { ...p, id: newId('fp'), x: p.x + 2, y: p.y + 2 };
                                    newDoc = { ...newDoc, placements: [...(newDoc.placements || []), dup] };
                                    newSelections.push({ kind: 'placement', id: dup.id });
                                }
                            }
                        }
                        return newDoc;
                    });
                    setSelected(newSelections);
                }
                return;
            }
            /* ── R: rotate selected ── */
            if (e.key === 'r' || e.key === 'R') {
                if (selected.length > 0) {
                    undoMgrRef.current.push(doc);
                    setDoc((d) => ({
                        ...d,
                        placements: d.placements?.map((p) =>
                            isItemSelected(selected, 'placement', p.id)
                                ? { ...p, rot: (((Number(p.rot) || 0) + 90) % 360) }
                                : p,
                        ),
                    }));
                }
                return;
            }
            /* ── Arrow keys: nudge selected ── */
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                if (selected.length > 0) {
                    e.preventDefault();
                    undoMgrRef.current.push(doc);
                    const grid = doc.meta?.gridMm ?? 0.5;
                    let dx = 0, dy = 0;
                    if (e.key === 'ArrowUp') dy = -grid;
                    else if (e.key === 'ArrowDown') dy = grid;
                    else if (e.key === 'ArrowLeft') dx = -grid;
                    else if (e.key === 'ArrowRight') dx = grid;
                    setDoc((d) => ({
                        ...d,
                        placements: d.placements?.map((p) =>
                            isItemSelected(selected, 'placement', p.id)
                                ? { ...p, x: snap(p.x + dx), y: snap(p.y + dy) }
                                : p,
                        ),
                    }));
                }
                return;
            }
            /* ── 1-8: quick layer switch ── */
            if (e.key >= '1' && e.key <= '8') {
                const idx = parseInt(e.key) - 1;
                const stack = activeCopperLayerIds(doc);
                if (idx < stack.length) setActiveLayer(stack[idx]);
                return;
            }
            /* ── Tool shortcuts: S=select, T=route, P=place, M=measure, G=polygon ── */
            if (e.key === 's' || e.key === 'S') { setTool('select'); return; }
            if (e.key === 't' || e.key === 'T') { setTool('route'); return; }
            if (e.key === 'p' || e.key === 'P') { setTool('place'); return; }
            if (e.key === 'm' || e.key === 'M') { setTool('measure'); return; }
            if (e.key === 'g' || e.key === 'G') { setTool('polygon'); return; }
            /* ── F: fit view ── */
            if (e.key === 'f' || e.key === 'F') { fitViewport(); return; }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selected, doc, boardCursorMm, snap, handleCopy, handlePaste, handleUndo, handleRedo,
        routeDraft, polygonDraft, measureStart, measureEnd, tool, activeLayer,
        commitRouteDraft, commitPolygonDraft, insertViaAndSwitchLayer, fitViewport]);

    /* ── Hit testing helper ── */
    const pickAtPoint = useCallback((mx, my) => {
        if (selectionFilter.placement) {
            for (const pl of (doc.placements || []).slice().reverse()) {
                const bb = footprintBBox(pl);
                if (mx >= bb.minX && mx <= bb.maxX && my >= bb.minY && my <= bb.maxY) {
                    return { kind: 'placement', id: pl.id };
                }
            }
        }
        if (selectionFilter.track) {
            for (const tr of (doc.tracks || []).slice().reverse()) {
                if (!isCopperLayerVisible(doc, tr.layer)) continue;
                const w = (tr.widthMm || 0.35) / 2 + 0.1;
                const pts = tr.points || [];
                for (let i = 0; i < pts.length - 1; i++) {
                    const dist = pointToSegmentDistance([mx, my], pts[i], pts[i + 1]);
                    if (dist <= w) return { kind: 'track', id: tr.id };
                }
            }
        }
        if (selectionFilter.via) {
            for (const v of (doc.vias || []).slice().reverse()) {
                const diam = Number(v.diamMm) || Number(doc.meta?.defaultViaDiamMm) || 0.8;
                if (Math.hypot(mx - v.x, my - v.y) <= diam / 2 + 0.1) return { kind: 'via', id: v.id };
            }
        }
        if (selectionFilter.polygon) {
            for (const pg of (doc.polygons || []).slice().reverse()) {
                if (!isCopperLayerVisible(doc, pg.layer)) continue;
                if (pointInPolygon([mx, my], pg.points || [])) return { kind: 'polygon', id: pg.id };
            }
        }
        return null;
    }, [doc, selectionFilter]);

    /* ── Canvas → board coordinate helper (used in all mouse handlers) ── */
    const canvasToBoardAt = useCallback((ev) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        return canvasToBoard(
            ev.clientX - rect.left,
            ev.clientY - rect.top,
            pcbViewport,
            canvas.width / dpr,
            canvas.height / dpr,
            W, H, dpr,
        );
    }, [pcbViewport, W, H]);

    /* ── Drag state for moving placements ── */
    const [dragMove, setDragMove] = useState(null); // { id, startX, startY, origX, origY }

    const onCanvasMouseDown = useCallback((ev) => {
        const pt = canvasToBoardAt(ev);
        if (!pt) return;
        const [mx, my] = pt;
        lastPointerBoardRef.current = [mx, my];

        /* Right-click or middle-click: always pan */
        if (ev.button === 2 || ev.button === 1) {
            setPcbViewDrag(true);
            ev.preventDefault();
            return;
        }

        if (tool === 'pan') { setPcbViewDrag(true); return; }

        /* Measure tool */
        if (tool === 'measure') {
            if (!measureStart) { setMeasureStart([mx, my]); }
            else { setMeasureEnd([mx, my]); }
            return;
        }

        /* Place tool */
        if (tool === 'place') {
            undoMgrRef.current.push(doc);
            const newPl = {
                id: newId('fp'),
                ref: `?${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
                footprintId: placeFootprintId,
                x: snap(mx), y: snap(my), rot: 0, padNets: {},
            };
            setDoc((d) => ({ ...d, placements: [...(d.placements || []), newPl] }));
            setSelected([{ kind: 'placement', id: newPl.id }]);
            return;
        }

        /* Route tool */
        if (tool === 'route') {
            const spt = [snap(mx), snap(my)];
            if (!routeDraft) {
                // Start new route
                setRouteDraft([spt]);
            } else {
                // Add point to existing route
                setRouteDraft([...routeDraft, spt]);
            }
            return;
        }

        /* Polygon tool */
        if (tool === 'polygon') {
            const spt = [snap(mx), snap(my)];
            setPolygonDraft((prev) => [...(prev || []), spt]);
            return;
        }

        /* Select / BoxSelect tool */
        if (tool === 'select' || tool === 'boxselect') {
            const pickResult = pickAtPoint(mx, my);
            if (ev.shiftKey) {
                if (pickResult) setSelected((prev) => toggleSelectionItem(prev, pickResult));
            } else {
                if (pickResult) {
                    setSelected([pickResult]);
                    // Begin drag-to-move for placements
                    if (pickResult.kind === 'placement') {
                        const pl = doc.placements?.find((p) => p.id === pickResult.id);
                        if (pl) {
                            setDragMove({ id: pl.id, startX: mx, startY: my, origX: pl.x, origY: pl.y, pushed: false });
                        }
                    }
                } else {
                    setSelected([]);
                }
            }
        }
    }, [tool, doc, pcbViewport, W, H, snap, routeDraft, polygonDraft, placeFootprintId, measureStart, canvasToBoardAt, pickAtPoint]);

    /* ── Double-click: commit route/polygon ── */
    const onCanvasDoubleClick = useCallback((ev) => {
        if (tool === 'route' && routeDraft && routeDraft.length >= 2) {
            commitRouteDraft();
            return;
        }
        if (tool === 'polygon' && polygonDraft && polygonDraft.length >= 3) {
            commitPolygonDraft();
            return;
        }
    }, [tool, routeDraft, polygonDraft, commitRouteDraft, commitPolygonDraft]);

    const onCanvasMouseMove = useCallback((ev) => {
        const pt = canvasToBoardAt(ev);
        if (!pt) return;
        const [mx, my] = pt;
        setBoardCursorMm([mx, my]);
        boardCursorMmRef.current = [mx, my];
        renderDirtyRef.current = true;

        /* Drag-to-move placement */
        if (dragMove) {
            if (!dragMove.pushed) {
                undoMgrRef.current.push(doc);
                setDragMove((d) => d ? { ...d, pushed: true } : null);
            }
            const dx = mx - dragMove.startX;
            const dy = my - dragMove.startY;
            setDoc((d) => ({
                ...d,
                placements: d.placements?.map((p) =>
                    p.id === dragMove.id
                        ? { ...p, x: snap(dragMove.origX + dx), y: snap(dragMove.origY + dy) }
                        : p,
                ),
            }));
        }
    }, [pcbViewport, W, H, canvasToBoardAt, dragMove, doc, snap]);

    /* ── Global mouseup to finish drag ── */
    useEffect(() => {
        if (!dragMove) return;
        const onUp = () => setDragMove(null);
        window.addEventListener('mouseup', onUp);
        return () => window.removeEventListener('mouseup', onUp);
    }, [dragMove]);

    const onCanvasMouseLeave = useCallback(() => {
        setBoardCursorMm(null);
        boardCursorMmRef.current = null;
        renderDirtyRef.current = true;
    }, []);

    const onCanvasContextMenu = useCallback((ev) => {
        ev.preventDefault();
        // Right-click while routing: commit the route (like KiCad)
        if (tool === 'route' && routeDraft && routeDraft.length >= 2) {
            commitRouteDraft();
        }
    }, [tool, routeDraft, commitRouteDraft]);

    // Mark render dirty when any state changes
    useEffect(() => { renderDirtyRef.current = true; }, [
        doc, pcbViewport, activeLayer, selected, routeDraft, polygonDraft,
        boardPreview, showBoardGrid, drcViolations, padCentersByNet,
        schCrossRefs, schCrossNets, measureStart, measureEnd, lockedLayers,
    ]);

    // Stable refs for render loop (avoids restarting rAF)
    const renderStateRef = useRef({});
    renderStateRef.current = {
        doc, pcbViewport, activeLayer, selected, routeDraft, polygonDraft,
        boardPreview, showBoardGrid, drcViolations, padCentersByNet,
        schCrossRefs, schCrossNets, measureStart, measureEnd, lockedLayers,
    };

    // Single persistent rAF loop — never restarts
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        let running = true;

        const loop = () => {
            if (!running) return;
            if (renderDirtyRef.current && canvas.width > 0 && canvas.height > 0) {
                renderDirtyRef.current = false;
                const dpr = window.devicePixelRatio || 1;
                const s = renderStateRef.current;
                renderPcbCanvas(ctx, {
                    ...s,
                    viewport: s.pcbViewport,
                    canvasWidth: canvas.width / dpr,
                    canvasHeight: canvas.height / dpr,
                    boardCursorMm: boardCursorMmRef.current,
                    dpr,
                });
            }
            animFrameRef.current = requestAnimationFrame(loop);
        };
        loop();

        return () => { running = false; cancelAnimationFrame(animFrameRef.current); };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Canvas resize handler
    useEffect(() => {
        const canvas = canvasRef.current;
        const wrap = canvasWrapRef.current;
        if (!canvas || !wrap) return;

        const ro = new ResizeObserver(() => {
            const dpr = window.devicePixelRatio || 1;
            const rect = wrap.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) return;
            canvas.width = Math.round(rect.width * dpr);
            canvas.height = Math.round(rect.height * dpr);
            canvas.style.width = rect.width + 'px';
            canvas.style.height = rect.height + 'px';
            renderDirtyRef.current = true;
        });

        ro.observe(wrap);
        return () => ro.disconnect();
    }, []);

    const measureDistanceMm = useMemo(() => {
        if (measureStart && measureEnd) {
            return Math.hypot(measureEnd[0] - measureStart[0], measureEnd[1] - measureStart[1]);
        }
        return null;
    }, [measureStart, measureEnd]);

    const pcbRelativeDelta = useMemo(() => {
        if (!relativeOriginMm || !boardCursorMm) return null;
        const dx = boardCursorMm[0] - relativeOriginMm[0];
        const dy = boardCursorMm[1] - relativeOriginMm[1];
        const dist = Math.hypot(dx, dy);
        return { dx, dy, dist };
    }, [relativeOriginMm, boardCursorMm]);

    const cursorClass = pcbViewDrag ? 'pcb-cursor-grabbing'
        : dragMove ? 'pcb-cursor-move'
        : tool === 'pan' ? 'pcb-cursor-grab'
        : tool === 'route' || tool === 'polygon' || tool === 'measure' ? 'pcb-cursor-cross'
        : tool === 'place' ? 'pcb-cursor-cross'
        : 'pcb-cursor-select';

    const inspectorTarget = selected.length === 1 && selected[0].kind === 'placement'
        ? { kind: 'placement', p: doc.placements?.find((x) => x.id === selected[0].id) }
        : null;

    const toolButtons = [
        { id: 'select', icon: MousePointer2, label: 'Select' },
        { id: 'boxselect', icon: LayoutTemplate, label: 'Box Select' },
        { id: 'place', icon: CircleDot, label: 'Place' },
        { id: 'route', icon: Route, label: 'Route' },
        { id: 'polygon', icon: Pentagon, label: 'Polygon' },
        { id: 'measure', icon: Ruler, label: 'Measure' },
        { id: 'pan', icon: Hand, label: 'Pan' },
    ];

    return (
        <div className="pcb-root">
            <div className="pcb-topbar">
                <button type="button" className="pcb-topbtn" onClick={onBackToSchematic} title="Back to Circuit Studio">
                    <Home size={14} /> Back
                </button>
                <div className="pcb-sep" />
                <div className="pcb-tool-group">
                    {toolButtons.map((btn) => {
                        const Icon = btn.icon;
                        return (
                            <button
                                key={btn.id}
                                type="button"
                                className={`pcb-topbtn${tool === btn.id ? ' is-active' : ''}`}
                                onClick={() => setTool(btn.id)}
                                title={btn.label}
                            >
                                <Icon size={14} />
                            </button>
                        );
                    })}
                </div>
                {tool === 'route' ? (
                    <>
                        <div className="pcb-sep" />
                        <button
                            type="button"
                            className="pcb-topbtn"
                            onClick={(e) => insertViaAndSwitchLayer({ reverseLayer: e.shiftKey })}
                            title="Via + next copper layer (same as V). Commits the in-progress trace to the cursor, adds a via, switches to the next layer in the stack, and continues routing from the via. Shift+click or Shift+V: previous layer."
                        >
                            <CircleDot size={14} /> Via layer
                        </button>
                    </>
                ) : null}
                <div className="pcb-sep" />
                <button
                    type="button"
                    className="pcb-topbtn"
                    disabled={!undoMgrRef.current.canUndo()}
                    onClick={handleUndo}
                    title="Undo (Ctrl+Z)"
                >
                    <RotateCcw size={14} />
                </button>
                <button
                    type="button"
                    className="pcb-topbtn"
                    disabled={!undoMgrRef.current.canRedo()}
                    onClick={handleRedo}
                    title="Redo (Ctrl+Shift+Z)"
                >
                    <RotateCw size={14} />
                </button>
                <div className="pcb-sep" />
                <button
                    type="button"
                    className="pcb-topbtn"
                    onClick={() => setShowBoardPreview(true)}
                    title="Preview board appearance"
                >
                    <CircuitBoard size={14} /> Preview
                </button>
                <button
                    type="button"
                    className="pcb-topbtn"
                    onClick={handleRunDRC}
                    title="Run design rule check"
                >
                    <AlertTriangle size={14} /> DRC
                </button>
                <div className="pcb-export-menu">
                    <button type="button" className="pcb-topbtn" title="Export options">
                        <Download size={14} /> Export
                    </button>
                    <div className="pcb-dropdown">
                        <button type="button" onClick={handleExportZip} disabled={exportBusy}>
                            <FileCode2 size={13} /> Gerber ZIP {exportBusy ? '...' : ''}
                        </button>
                        <button type="button" onClick={handleExportKicad}>
                            <FileJson size={13} /> KiCad .kicad_pcb
                        </button>
                        <button type="button" onClick={handleExportBom}>
                            <List size={13} /> BOM (CSV)
                        </button>
                        <button type="button" onClick={handleExportPickAndPlace}>
                            <Package size={13} /> Pick &amp; Place (CSV)
                        </button>
                        <button type="button" onClick={handleExportIpcD356}>
                            <FileText size={13} /> IPC-D-356 Netlist
                        </button>
                    </div>
                </div>
                <div className="pcb-sep" />
                <button
                    type="button"
                    className="pcb-topbtn"
                    onClick={handleAutoRoute}
                    title="Auto-route unconnected nets"
                >
                    <Zap size={14} /> Route
                </button>
            </div>

            <div className="pcb-workspace">
                <aside className="pcb-sidebar">
                    <h2>Copper Layers</h2>
                    <p className="pcb-dr-hint">
                        <strong>Manual route:</strong> choose <strong>Route</strong> (T), pick the <strong>active layer</strong> below, then click the board to chain track points.
                        <strong> Change layer mid-route:</strong> move the cursor to the via location and press <kbd>V</kbd> or top bar <strong>Via layer</strong> — the current polyline is committed to that point, a via is added, the <strong>next</strong> copper layer in the stack is selected (wraps F→…→B), and routing continues from the via.
                        <strong> Shift+V</strong> selects the <strong>previous</strong> layer instead. Finish with <kbd>Enter</kbd>, double-click, or right-click. Avoid switching layer chips mid-polyline without a via (the whole run uses one layer until you finish or use Via layer).
                    </p>
                    <div className="pcb-layer-chips">
                        {copperStack.map((ly) => (
                            <button
                                key={ly}
                                type="button"
                                className={`pcb-layer-chip${activeLayer === ly ? ' is-active' : ''}`}
                                onClick={() => setActiveLayer(ly)}
                                title="Active layer for new tracks (use Via layer / V mid-route to hop layers with a via)"
                            >
                                {ly.replace('.Cu', '')}
                            </button>
                        ))}
                    </div>
                    <div className="pcb-layer-visibility" role="group" aria-label="Copper layer visibility">
                        <span className="pcb-layer-visibility-label">Show on canvas</span>
                        <div className="pcb-layer-visibility-row">
                            {copperStack.map((ly) => {
                                const on = isCopperLayerVisible(doc, ly);
                                const nVis = copperStack.filter((l) => isCopperLayerVisible(doc, l)).length;
                                const disableHide = nVis <= 1 && on;
                                const locked = lockedLayers.has(ly);
                                return (
                                    <button
                                        key={ly}
                                        type="button"
                                        className={`pcb-layer-eye${on ? ' is-on' : ''}`}
                                        disabled={disableHide}
                                        title={
                                            locked
                                                ? `${ly} is locked`
                                                : disableHide
                                                  ? 'At least one copper layer must stay visible'
                                                  : `${on ? 'Hide' : 'Show'} ${ly} on canvas`
                                        }
                                        onClick={() => {
                                            if (locked) {
                                                setLockedLayers((s) => {
                                                    const ns = new Set(s);
                                                    ns.delete(ly);
                                                    return ns;
                                                });
                                            } else {
                                                toggleCopperLayerVisibility(ly);
                                            }
                                        }}
                                    >
                                        {locked ? (
                                            <Lock size={13} />
                                        ) : (
                                            on ? <Eye size={13} /> : <EyeOff size={13} />
                                        )}
                                        <span>{ly.replace('.Cu', '')}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <h3 className="pcb-subh">Board appearance</h3>
                    <label className="pcb-field-row">
                        <input
                            type="checkbox"
                            checked={boardPreview.solderMask}
                            onChange={(e) => setBoardPreview((p) => ({ ...p, solderMask: e.target.checked }))}
                        />
                        Solder mask (green)
                    </label>
                    <label className="pcb-field-row">
                        <input
                            type="checkbox"
                            checked={boardPreview.brightInactiveLayers}
                            onChange={(e) => setBoardPreview((p) => ({ ...p, brightInactiveLayers: e.target.checked }))}
                        />
                        Bright inactive layers
                    </label>
                    <label className="pcb-field-row">
                        <input
                            type="checkbox"
                            checked={boardPreview.boldSilk}
                            onChange={(e) => setBoardPreview((p) => ({ ...p, boldSilk: e.target.checked }))}
                        />
                        Emphasize silkscreen
                    </label>

                    <h3 className="pcb-subh">Design rules</h3>
                    <label className="pcb-field-col">
                        Min copper clearance (mm)
                        <input
                            type="number"
                            min={0.05}
                            max={2}
                            step={0.05}
                            value={doc.meta.designRules?.minCopperClearanceMm ?? 0.2}
                            onChange={(e) => {
                                const v = Number(e.target.value);
                                if (!Number.isFinite(v)) return;
                                const c = Math.min(2, Math.max(0.05, v));
                                setDoc((d) => ({
                                    ...d,
                                    meta: {
                                        ...d.meta,
                                        designRules: { ...(d.meta.designRules || {}), minCopperClearanceMm: c },
                                    },
                                }));
                            }}
                        />
                    </label>
                    <label className="pcb-field-col">
                        Min track width (mm)
                        <input
                            type="number"
                            min={0.08}
                            max={2}
                            step={0.05}
                            value={doc.meta.designRules?.minTrackWidthMm ?? 0.15}
                            onChange={(e) => {
                                const v = Number(e.target.value);
                                if (!Number.isFinite(v)) return;
                                const c = Math.min(2, Math.max(0.08, v));
                                setDoc((d) => ({
                                    ...d,
                                    meta: {
                                        ...d.meta,
                                        designRules: { ...(d.meta.designRules || {}), minTrackWidthMm: c },
                                    },
                                }));
                            }}
                        />
                    </label>

                    <h3 className="pcb-subh">Selection filter</h3>
                    <div className="pcb-sel-filter" role="group" aria-label="Selection filter">
                        {[
                            { key: 'placement', label: 'Footprints' },
                            { key: 'track', label: 'Tracks' },
                            { key: 'via', label: 'Vias' },
                            { key: 'polygon', label: 'Zones' },
                        ].map(({ key, label }) => (
                            <label key={key} className="pcb-field-row pcb-sel-filter-row">
                                <input
                                    type="checkbox"
                                    checked={selectionFilter[key]}
                                    onChange={(e) => setSelectionFilter((f) => ({ ...f, [key]: e.target.checked }))}
                                />
                                {label}
                            </label>
                        ))}
                    </div>

                    <h3 className="pcb-subh">Board & grid</h3>
                    <label className="pcb-field-col">
                        Snap grid (mm)
                        <select
                            value={doc.meta.gridMm ?? 0.5}
                            onChange={(e) => {
                                const v = Number(e.target.value);
                                if (!PCB_GRID_PRESETS_MM.includes(v)) return;
                                setDoc((d) => ({ ...d, meta: { ...d.meta, gridMm: v } }));
                            }}
                        >
                            {PCB_GRID_PRESETS_MM.map((g) => (
                                <option key={g} value={g}>
                                    {g}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="pcb-field-row">
                        <input
                            type="checkbox"
                            checked={doc.meta.snapToGrid !== false}
                            onChange={(e) => setDoc((d) => ({ ...d, meta: { ...d.meta, snapToGrid: e.target.checked } }))}
                        />
                        Snap to grid
                    </label>
                    <label className="pcb-field-col">
                        New track width (mm)
                        <input
                            type="number"
                            min={0.1}
                            max={3}
                            step={0.05}
                            value={doc.meta.defaultTrackMm}
                            onChange={(e) => {
                                const v = Number(e.target.value);
                                setDoc((d) => ({
                                    ...d,
                                    meta: { ...d.meta, defaultTrackMm: Number.isFinite(v) ? Math.min(3, Math.max(0.1, v)) : d.meta.defaultTrackMm },
                                }));
                            }}
                        />
                    </label>
                    <label className="pcb-field-row">
                        <input
                            type="checkbox"
                            checked={showBoardGrid}
                            onChange={(e) => setShowBoardGrid(e.target.checked)}
                        />
                        Show grid
                    </label>

                    <h3 className="pcb-subh">Edit</h3>
                    <div className="pcb-edit-row">
                        <button type="button" onClick={handleCopy} title="Copy selection (⌘C / Ctrl+C)">
                            <Copy size={12} /> Copy
                        </button>
                        <button type="button" onClick={handlePaste} title="Paste at cursor (⌘V)">
                            <ClipboardPaste size={12} /> Paste
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                if (!selected.length) return;
                                undoMgrRef.current.push(doc);
                                setDoc((d) => ({
                                    ...d,
                                    placements: d.placements?.map((p) =>
                                        isItemSelected(selected, 'placement', p.id)
                                            ? { ...p, rot: (((Number(p.rot) || 0) + 90) % 360) }
                                            : p,
                                    ),
                                }));
                            }}
                            title="Rotate selected footprints 90° (R)"
                        >
                            <RotateCw size={12} /> Rotate
                        </button>
                    </div>
                    <p className="pcb-keys-hint">
                        ⌘/Ctrl+C copy · V paste · D duplicate · R rotate · arrows nudge · Shift+click multi · Del delete
                    </p>

                    {inspectorTarget?.kind === 'placement' ? (
                        <div className="pcb-sidebar-props">
                            <h3 className="pcb-subh">Placement</h3>
                            <p className="pcb-sel-meta">
                                <strong>{inspectorTarget.p.ref}</strong>
                                <span className="pcb-sel-fp">{inspectorTarget.p.footprintId}</span>
                            </p>
                            <label className="pcb-field-col">
                                X (mm)
                                <input
                                    type="number"
                                    step={0.01}
                                    value={inspectorTarget.p.x}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (!Number.isFinite(v)) return;
                                        const id = inspectorTarget.p.id;
                                        setDoc((d) => {
                                            const g = d.meta?.gridMm ?? 0.5;
                                            const sn = d.meta?.snapToGrid !== false;
                                            const x = snapBoard(v, g, sn);
                                            return {
                                                ...d,
                                                placements: d.placements?.map((p) => (p.id === id ? { ...p, x } : p)),
                                            };
                                        });
                                    }}
                                />
                            </label>
                            <label className="pcb-field-col">
                                Y (mm)
                                <input
                                    type="number"
                                    step={0.01}
                                    value={inspectorTarget.p.y}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (!Number.isFinite(v)) return;
                                        const id = inspectorTarget.p.id;
                                        setDoc((d) => {
                                            const g = d.meta?.gridMm ?? 0.5;
                                            const sn = d.meta?.snapToGrid !== false;
                                            const y = snapBoard(v, g, sn);
                                            return {
                                                ...d,
                                                placements: d.placements?.map((p) => (p.id === id ? { ...p, y } : p)),
                                            };
                                        });
                                    }}
                                />
                            </label>
                            <label className="pcb-field-col">
                                Rotation (°)
                                <input
                                    type="number"
                                    step={1}
                                    min={0}
                                    max={359}
                                    value={Number(inspectorTarget.p.rot) || 0}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (!Number.isFinite(v)) return;
                                        const id = inspectorTarget.p.id;
                                        let rot = Math.round(v) % 360;
                                        if (rot < 0) rot += 360;
                                        setDoc((d) => ({
                                            ...d,
                                            placements: d.placements?.map((p) => (p.id === id ? { ...p, rot } : p)),
                                        }));
                                    }}
                                />
                            </label>
                        </div>
                    ) : null}

                    <h3 className="pcb-subh">Footprints</h3>
                    <input
                        type="text"
                        placeholder="Search footprints..."
                        value={footprintSearchQuery}
                        onChange={(e) => setFootprintSearchQuery(e.target.value)}
                        className="pcb-fp-search"
                    />
                    <ul className="pcb-fp-list">
                        {fpSummaries.map((f) => (
                            <li key={f.id}>
                                <button
                                    type="button"
                                    className={placeFootprintId === f.id ? 'is-picked' : ''}
                                    onClick={() => setPlaceFootprintId(f.id)}
                                >
                                    <strong>{f.id}</strong>
                                    <div style={{ opacity: 0.75, fontSize: '0.65rem' }}>{f.name}</div>
                                </button>
                            </li>
                        ))}
                    </ul>

                    <button
                        type="button"
                        className="pcb-sidebar-action"
                        onClick={() => setShowOnlineSearch(true)}
                    >
                        <Zap size={12} /> Find components online
                    </button>
                    <button
                        type="button"
                        className="pcb-sidebar-action"
                        onClick={() => setShowFootprintImport(true)}
                    >
                        <Upload size={12} /> Import footprint
                    </button>
                </aside>

                <div className="pcb-stage">
                    <div className="pcb-canvas-wrap" ref={canvasWrapRef}>
                        <canvas
                            ref={canvasRef}
                            className={`pcb-board-canvas ${cursorClass}`}
                            onMouseDown={onCanvasMouseDown}
                            onDoubleClick={onCanvasDoubleClick}
                            onMouseMove={onCanvasMouseMove}
                            onMouseLeave={onCanvasMouseLeave}
                            onContextMenu={onCanvasContextMenu}
                        />
                        <p className="pcb-hint">
                            Scroll=zoom &middot; Right-drag=pan &middot; Grid {doc.meta.gridMm ?? 0.5}mm
                            {tool === 'route' && ' · Click=add point · Dbl-click/Enter/right=finish · V=via+next layer · Shift+V=prev layer · Esc=cancel'}
                            {tool === 'polygon' && ' · Click=add vertex · Dbl-click/Enter=close · Esc=cancel'}
                            {tool === 'select' && ' · Drag=move · R=rotate · D=dupe · Del=delete'}
                            {' · 1-8=layer · S/T/P/M/G=tool · F=fit'}
                        </p>
                    </div>

                    <footer className="pcb-statusbar" aria-live="polite">
                        <span className="pcb-statusbar-seg">
                            {boardCursorMm ? (
                                displayUnits === 'mm' ? (
                                    <>
                                        X <strong>{boardCursorMm[0].toFixed(2)}</strong> Y <strong>{boardCursorMm[1].toFixed(2)}</strong> mm
                                    </>
                                ) : (
                                    <>
                                        X <strong>{mmToMil(boardCursorMm[0]).toFixed(1)}</strong> Y{' '}
                                        <strong>{mmToMil(boardCursorMm[1]).toFixed(1)}</strong> mil
                                    </>
                                )
                            ) : (
                                <span className="pcb-statusbar-muted">—</span>
                            )}
                        </span>
                        {pcbRelativeDelta ? (
                            <span className="pcb-statusbar-seg">
                                dx{' '}
                                {displayUnits === 'mm'
                                    ? pcbRelativeDelta.dx.toFixed(2)
                                    : mmToMil(pcbRelativeDelta.dx).toFixed(1)}{' '}
                                dy{' '}
                                {displayUnits === 'mm'
                                    ? pcbRelativeDelta.dy.toFixed(2)
                                    : mmToMil(pcbRelativeDelta.dy).toFixed(1)}{' '}
                                dist{' '}
                                {displayUnits === 'mm'
                                    ? pcbRelativeDelta.dist.toFixed(3)
                                    : mmToMil(pcbRelativeDelta.dist).toFixed(2)}{' '}
                                {displayUnits === 'mm' ? 'mm' : 'mil'}
                            </span>
                        ) : relativeOriginMm ? (
                            <span className="pcb-statusbar-seg pcb-statusbar-muted">Move pointer for dx/dy</span>
                        ) : null}
                        <span className="pcb-statusbar-seg pcb-statusbar-muted">
                            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: PCB_LAYER_COLORS[activeLayer] || '#888', marginRight: 4, verticalAlign: 'middle' }} />
                            {activeLayer} · grid {doc.meta.gridMm ?? 0.5}mm · {displayUnits}
                        </span>
                        {routeDraft && (
                            <span className="pcb-statusbar-seg" style={{ color: '#a855f7' }}>
                                Routing: {routeDraft.length} pts
                            </span>
                        )}
                        {tool === 'measure' ? (
                            <span className="pcb-statusbar-seg pcb-statusbar-measure">
                                Measure:{' '}
                                {measureStart == null
                                    ? 'click A'
                                    : measureEnd == null
                                      ? 'click B'
                                      : displayUnits === 'mm'
                                        ? `${measureDistanceMm?.toFixed(3) ?? '—'} mm`
                                        : `${measureDistanceMm != null ? mmToMil(measureDistanceMm).toFixed(2) : '—'} mil`}
                            </span>
                        ) : null}
                        <span className="pcb-statusbar-actions">
                            <button
                                type="button"
                                className="pcb-statusbar-btn"
                                disabled={!boardCursorMm}
                                title="Set relative origin at cursor (dx/dy/dist from here)"
                                onClick={() => {
                                    if (!boardCursorMm) return;
                                    setRelativeOriginMm([boardCursorMm[0], boardCursorMm[1]]);
                                }}
                            >
                                Set rel
                            </button>
                            {relativeOriginMm ? (
                                <button
                                    type="button"
                                    className="pcb-statusbar-btn"
                                    title="Clear relative origin"
                                    onClick={() => setRelativeOriginMm(null)}
                                >
                                    Clear O
                                </button>
                            ) : null}
                        </span>
                    </footer>
                </div>
            </div>

            {showOnlineSearch && (
                <OnlineComponentModal
                    onClose={() => setShowOnlineSearch(false)}
                    onComponentDownloaded={(comp) => {
                        setPlaceFootprintId(comp.footprint.id);
                        setLibVersion((v) => v + 1);
                        setTool('place');
                    }}
                />
            )}
            {showFootprintImport && (
                <FootprintImportModal
                    onClose={() => setShowFootprintImport(false)}
                    onLibraryChanged={() => setLibVersion((v) => v + 1)}
                />
            )}
            {showBoardPreview && <BoardPreviewModal open={showBoardPreview} onClose={() => setShowBoardPreview(false)} />}
        </div>
    );
}

// Helper: point-to-segment distance
function pointToSegmentDistance(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const cx = a[0] + t * dx;
    const cy = a[1] + t * dy;
    return Math.hypot(p[0] - cx, p[1] - cy);
}

// Helper: point in polygon (ray casting)
function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const intersect = ((yi > p[1]) !== (yj > p[1])) && (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

export default PcbStudioPage;
