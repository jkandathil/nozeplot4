import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
} from 'lucide-react';
import {
    emptyPcbDoc,
    newId,
    applyBridgePayload,
    migratePcbDoc,
    activeCopperLayerIds,
    COPPER_LAYER_COUNT_OPTIONS,
    PCB_GRID_PRESETS_MM,
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
import { getFootprint, listFootprintSummaries } from '../pcb/footprintLib.js';
import { buildPcbFabricationZip, triggerBlobDownload } from '../pcb/gerberZip.js';
import { runDRC } from '../pcb/pcbDrc.js';
import { autoRoute } from '../pcb/autoRouter.js';
import OnlineComponentModal from './OnlineComponentModal.jsx';
import FootprintImportModal from './FootprintImportModal.jsx';
import './PcbStudioPage.css';

const PCB_STORAGE_KEY = 'nozePcbDoc:v1';

const PCB_LAYER_COLORS = {
    'F.Cu': '#ef4444',
    'In1.Cu': '#f59e0b',
    'In2.Cu': '#eab308',
    'In3.Cu': '#22c55e',
    'In4.Cu': '#06b6d4',
    'In5.Cu': '#3b82f6',
    'In6.Cu': '#6366f1',
    'B.Cu': '#a855f7',
};

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

function clientToSvgMm(svgEl, clientX, clientY) {
    if (!svgEl) return [0, 0];
    const pt = svgEl.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return [0, 0];
    const p = pt.matrixTransform(ctm.inverse());
    return [p.x, p.y];
}

function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
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
    /** @type {Array<{ kind: 'placement' | 'track' | 'via' | 'polygon', id: string }>} */
    const [selected, setSelected] = useState([]);
    const [routeDraft, setRouteDraft] = useState(null);
    const [polygonDraft, setPolygonDraft] = useState(null);
    const [drag, setDrag] = useState(null);
    const [exportBusy, setExportBusy] = useState(false);
    const [drcViolations, setDrcViolations] = useState([]);
    const [showOnlineSearch, setShowOnlineSearch] = useState(false);
    const [showFootprintImport, setShowFootprintImport] = useState(false);
    const [libVersion, setLibVersion] = useState(0);
    /** True after opening from the Circuit Studio "schematic → Gerber" tutorial demo. */
    const [pcbWorkflowDemo, setPcbWorkflowDemo] = useState(false);
    const svgRef = useRef(null);
    const canvasWrapRef = useRef(null);
    const boardSizeRef = useRef({ W: 80, H: 50 });
    const clipboardRef = useRef(null);
    const lastPointerBoardRef = useRef([20, 20]);
    const snapRef = useRef({ gridMm: 0.5, snapToGrid: true });

    const snap = useCallback(
        (v) => snapBoard(v, doc.meta?.gridMm ?? 0.5, doc.meta?.snapToGrid !== false),
        [doc.meta?.gridMm, doc.meta?.snapToGrid],
    );

    useEffect(() => {
        snapRef.current = { gridMm: doc.meta?.gridMm ?? 0.5, snapToGrid: doc.meta?.snapToGrid !== false };
    }, [doc.meta?.gridMm, doc.meta?.snapToGrid]);

    const docRef = useRef(doc);
    const selectedRef = useRef(selected);
    useEffect(() => {
        docRef.current = doc;
        selectedRef.current = selected;
    }, [doc, selected]);

    /** Highlights driven by Circuit Studio selection (designator + nets). */
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

    const fpSummaries = useMemo(() => listFootprintSummaries(), [libVersion]);
    const copperStack = useMemo(() => activeCopperLayerIds(doc), [doc.meta?.copperLayerCount]);

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

    /** Board view: zoom ≥1 = zoomed in (smaller viewBox window). Pan is viewBox min corner (mm). */
    const [pcbViewport, setPcbViewport] = useState({ zoom: 1, panX: 0, panY: 0 });
    const [pcbViewDrag, setPcbViewDrag] = useState(false);

    useEffect(() => {
        boardSizeRef.current = { W, H };
    }, [W, H]);

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

    const viewBoxStr = useMemo(() => {
        const vw = W / pcbViewport.zoom;
        const vh = H / pcbViewport.zoom;
        return `${pcbViewport.panX} ${pcbViewport.panY} ${vw} ${vh}`;
    }, [W, H, pcbViewport]);

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
        const el = canvasWrapRef.current;
        if (!el) return;
        const onWheel = (e) => {
            const { W: Wb, H: Hb } = boardSizeRef.current;
            const svg = svgRef.current;
            if (!svg || Wb < 1 || Hb < 1) return;
            e.preventDefault();
            const [cx, cy] = clientToSvgMm(svg, e.clientX, e.clientY);
            const delta = e.deltaY;
            const factor = delta > 0 ? 0.92 : 1 / 0.92;
            setPcbViewport((vp) => {
                const z = clamp(vp.zoom * factor, 0.2, 32);
                const vw0 = Wb / vp.zoom;
                const vh0 = Hb / vp.zoom;
                const vw1 = Wb / z;
                const vh1 = Hb / z;
                const u = vw0 > 1e-9 ? (cx - vp.panX) / vw0 : 0.5;
                const v = vh0 > 1e-9 ? (cy - vp.panY) / vh0 : 0.5;
                let panX = cx - u * vw1;
                let panY = cy - v * vh1;
                panX = clamp(panX, 0, Math.max(0, Wb - vw1));
                panY = clamp(panY, 0, Math.max(0, Hb - vh1));
                return { zoom: z, panX, panY };
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    useEffect(() => {
        if (!pcbViewDrag) return;
        const onMove = (ev) => {
            const svg = svgRef.current;
            if (!svg) return;
            const rect = svg.getBoundingClientRect();
            const { W: Wb, H: Hb } = boardSizeRef.current;
            setPcbViewport((vp) => {
                const vw = Wb / vp.zoom;
                const vh = Hb / vp.zoom;
                const dx = -(ev.movementX / Math.max(rect.width, 1)) * vw;
                const dy = -(ev.movementY / Math.max(rect.height, 1)) * vh;
                const panX = clamp(vp.panX + dx, 0, Math.max(0, Wb - vw));
                const panY = clamp(vp.panY + dy, 0, Math.max(0, Hb - vh));
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
    }, [pcbViewDrag]);

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
        const newTracks = autoRoute(doc, padCentersByNet);
        setDoc((d) => ({
            ...d,
            tracks: [...(d.tracks || []), ...newTracks],
        }));
    }, [doc, padCentersByNet]);

    const handleExportZip = useCallback(async () => {
        setExportBusy(true);
        try {
            const blob = await buildPcbFabricationZip(doc, doc.meta?.name || 'pcb');
            triggerBlobDownload(blob, `${(doc.meta?.name || 'pcb').replace(/[^\w\-]+/g, '_')}_gerber.zip`);
        } catch (e) {
            window.alert(e?.message || String(e));
        } finally {
            setExportBusy(false);
        }
    }, [doc]);

    const pickPlacementAt = useCallback(
        (x, y) => {
            for (let i = (doc.placements || []).length - 1; i >= 0; i--) {
                const pl = doc.placements[i];
                const b = footprintBBox(pl);
                if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return pl;
            }
            return null;
        },
        [doc.placements],
    );

    const onSvgDown = useCallback(
        (ev) => {
            if (ev.button === 1) {
                ev.preventDefault();
                setPcbViewDrag(true);
                return;
            }
            if (tool === 'pan' && ev.button === 0) {
                ev.preventDefault();
                setPcbViewDrag(true);
                return;
            }
            if (ev.button !== 0) return;

            const [mx, my] = clientToSvgMm(svgRef.current, ev.clientX, ev.clientY);
            const { gridMm, snapToGrid } = snapRef.current;
            const x = snapBoard(mx, gridMm, snapToGrid);
            const y = snapBoard(my, gridMm, snapToGrid);
            lastPointerBoardRef.current = [x, y];

            if (tool === 'place') {
                setDoc((d) => ({
                    ...d,
                    placements: [
                        ...d.placements,
                        {
                            id: newId('fp'),
                            footprintId: placeFootprintId,
                            ref: `FP${d.placements.length + 1}`,
                            x,
                            y,
                            rot: 0,
                            padNets: {},
                        },
                    ],
                }));
                return;
            }
            if (tool === 'via') {
                setDoc((d) => ({
                    ...d,
                    vias: [
                        ...d.vias,
                        {
                            id: newId('via'),
                            x,
                            y,
                            drillMm: d.meta.defaultViaDrillMm,
                            diamMm: d.meta.defaultViaDiamMm,
                            net: '',
                        },
                    ],
                }));
                return;
            }
            if (tool === 'route') {
                setRouteDraft((prev) => {
                    const next = prev ? [...prev, [x, y]] : [[x, y]];
                    return next;
                });
                return;
            }
            if (tool === 'polygon') {
                setPolygonDraft((prev) => {
                    const next = prev ? [...prev, [x, y]] : [[x, y]];
                    return next;
                });
                return;
            }

            const viaHit = pickViaAt(doc, mx, my);
            const trHit = pickTrackAt(doc, mx, my);
            const polyHit = pickPolygonAt(doc, mx, my);
            const pl = pickPlacementAt(mx, my);

            if (viaHit) {
                const item = { kind: 'via', id: viaHit.id };
                setSelected((prev) => (ev.shiftKey ? toggleSelectionItem(prev, item) : [item]));
                setDrag(null);
                return;
            }
            if (trHit) {
                const item = { kind: 'track', id: trHit.id };
                setSelected((prev) => (ev.shiftKey ? toggleSelectionItem(prev, item) : [item]));
                setDrag(null);
                return;
            }
            if (polyHit) {
                const item = { kind: 'polygon', id: polyHit.id };
                setSelected((prev) => (ev.shiftKey ? toggleSelectionItem(prev, item) : [item]));
                setDrag(null);
                return;
            }
            if (pl) {
                const item = { kind: 'placement', id: pl.id };
                setSelected((prev) => (ev.shiftKey ? toggleSelectionItem(prev, item) : [item]));
                setDrag({
                    id: pl.id,
                    ox: pl.x,
                    oy: pl.y,
                    sx: mx,
                    sy: my,
                });
                return;
            }
            if (!ev.shiftKey) setSelected([]);
            setDrag(null);
        },
        [tool, placeFootprintId, pickPlacementAt, doc],
    );

    const viewCenterBoard = useMemo(() => {
        const vw = W / pcbViewport.zoom;
        const vh = H / pcbViewport.zoom;
        return [pcbViewport.panX + vw / 2, pcbViewport.panY + vh / 2];
    }, [W, H, pcbViewport]);

    useEffect(() => {
        if (!drag) return;
        const onMove = (ev) => {
            const [mx, my] = clientToSvgMm(svgRef.current, ev.clientX, ev.clientY);
            const { gridMm, snapToGrid } = snapRef.current;
            setDoc((d) => ({
                ...d,
                placements: d.placements.map((p) => {
                    if (p.id !== drag.id) return p;
                    const dx = snapBoard(mx - drag.sx, gridMm, snapToGrid);
                    const dy = snapBoard(my - drag.sy, gridMm, snapToGrid);
                    return {
                        ...p,
                        x: snapBoard(drag.ox + dx, gridMm, snapToGrid),
                        y: snapBoard(drag.oy + dy, gridMm, snapToGrid),
                    };
                }),
            }));
        };
        const onUp = () => setDrag(null);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [drag]);

    const buildClipboardFromSelection = useCallback(
        (d, sel) => {
            const idSet = new Set(sel.map(selectionKey));
            const placements = (d.placements || [])
                .filter((p) => idSet.has(`placement:${p.id}`))
                .map(({ id, ...rest }) => ({ ...rest }));
            const tracks = (d.tracks || [])
                .filter((t) => idSet.has(`track:${t.id}`))
                .map(({ id, ...rest }) => ({ ...rest, points: (rest.points || []).map((pt) => [...pt]) }));
            const vias = (d.vias || [])
                .filter((v) => idSet.has(`via:${v.id}`))
                .map(({ id, ...rest }) => ({ ...rest }));
            const polygons = (d.polygons || [])
                .filter((p) => idSet.has(`polygon:${p.id}`))
                .map(({ id, ...rest }) => ({ ...rest, points: (rest.points || []).map((pt) => [...pt]) }));
            return { placements, tracks, vias, polygons };
        },
        [],
    );

    const handleCopy = useCallback(() => {
        setDoc((d) => {
            const buf = buildClipboardFromSelection(d, selected);
            if (
                buf.placements.length + buf.tracks.length + buf.vias.length + buf.polygons.length ===
                0
            ) {
                return d;
            }
            clipboardRef.current = buf;
            return d;
        });
    }, [selected, buildClipboardFromSelection]);

    const handlePaste = useCallback(() => {
        const buf = clipboardRef.current;
        if (!buf) return;
        const [tx, ty] = lastPointerBoardRef.current;
        const [cx, cy] = centroidClipboard(buf);
        const ox = tx - cx;
        const oy = ty - cy;
        setDoc((d) => {
            const { gridMm, snapToGrid } = {
                gridMm: d.meta?.gridMm ?? 0.5,
                snapToGrid: d.meta?.snapToGrid !== false,
            };
            const snapPt = ([px, py]) => [snapBoard(px + ox, gridMm, snapToGrid), snapBoard(py + oy, gridMm, snapToGrid)];
            const next = { ...d };
            next.placements = [...(d.placements || [])];
            next.tracks = [...(d.tracks || [])];
            next.vias = [...(d.vias || [])];
            next.polygons = [...(d.polygons || [])];
            for (const p of buf.placements || []) {
                const id = newId('fp');
                const [x, y] = snapPt([p.x, p.y]);
                next.placements.push({
                    ...p,
                    id,
                    x,
                    y,
                    ref: `${p.ref || 'FP'}_copy`,
                });
            }
            for (const t of buf.tracks || []) {
                next.tracks.push({
                    ...t,
                    id: newId('tr'),
                    points: (t.points || []).map((pt) => snapPt(pt)),
                });
            }
            for (const v of buf.vias || []) {
                const [x, y] = snapPt([v.x, v.y]);
                next.vias.push({ ...v, id: newId('via'), x, y });
            }
            for (const po of buf.polygons || []) {
                next.polygons.push({
                    ...po,
                    id: newId('poly'),
                    points: (po.points || []).map((pt) => snapPt(pt)),
                });
            }
            return next;
        });
        setSelected([]);
    }, []);

    useEffect(() => {
        const onKey = (ev) => {
            const t = ev.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;

            const mod = ev.metaKey || ev.ctrlKey;

            if (ev.key === 'Escape') {
                setRouteDraft(null);
                setPolygonDraft(null);
                setPcbViewDrag(false);
                return;
            }

            if (!mod && (ev.key === '+' || ev.key === '=')) {
                ev.preventDefault();
                zoomViewportAt(1.12, viewCenterBoard[0], viewCenterBoard[1]);
                return;
            }
            if (!mod && ev.key === '-') {
                ev.preventDefault();
                zoomViewportAt(1 / 1.12, viewCenterBoard[0], viewCenterBoard[1]);
                return;
            }
            if (!mod && ev.key === '0') {
                ev.preventDefault();
                fitViewport();
                return;
            }

            if (ev.key === 'Enter' && tool === 'route' && routeDraft?.length >= 2) {
                const pts = routeDraft.map(([px, py]) => [snap(px), snap(py)]);
                setDoc((d) => ({
                    ...d,
                    tracks: [
                        ...d.tracks,
                        {
                            id: newId('tr'),
                            layer: activeLayer,
                            widthMm: d.meta.defaultTrackMm,
                            net: '',
                            points: pts,
                        },
                    ],
                }));
                setRouteDraft(null);
                return;
            }

            if (ev.key === 'Enter' && tool === 'polygon' && polygonDraft?.length >= 3) {
                const pts = polygonDraft.map(([px, py]) => [snap(px), snap(py)]);
                setDoc((d) => ({
                    ...d,
                    polygons: [
                        ...(d.polygons || []),
                        {
                            id: newId('poly'),
                            layer: activeLayer,
                            net: '',
                            points: pts,
                        },
                    ],
                }));
                setPolygonDraft(null);
                return;
            }

            if (mod && ev.key.toLowerCase() === 'c') {
                ev.preventDefault();
                handleCopy();
                return;
            }
            if (mod && ev.key.toLowerCase() === 'v') {
                ev.preventDefault();
                handlePaste();
                return;
            }
            if (mod && ev.key.toLowerCase() === 'd') {
                ev.preventDefault();
                const buf = buildClipboardFromSelection(docRef.current, selectedRef.current);
                if (
                    buf.placements.length + buf.tracks.length + buf.vias.length + buf.polygons.length ===
                    0
                ) {
                    return;
                }
                clipboardRef.current = buf;
                handlePaste();
                return;
            }

            if ((ev.key === 'r' || ev.key === 'R') && selected.length) {
                ev.preventDefault();
                setDoc((d) => ({
                    ...d,
                    placements: d.placements.map((p) =>
                        isItemSelected(selected, 'placement', p.id)
                            ? { ...p, rot: (((Number(p.rot) || 0) + 90) % 360) }
                            : p,
                    ),
                }));
                return;
            }

            if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected.length) {
                ev.preventDefault();
                const idSet = new Set(selected.map(selectionKey));
                setDoc((d) => ({
                    ...d,
                    placements: (d.placements || []).filter((p) => !idSet.has(`placement:${p.id}`)),
                    tracks: (d.tracks || []).filter((tr) => !idSet.has(`track:${tr.id}`)),
                    vias: (d.vias || []).filter((v) => !idSet.has(`via:${v.id}`)),
                    polygons: (d.polygons || []).filter((p) => !idSet.has(`polygon:${p.id}`)),
                }));
                setSelected([]);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [
        tool,
        routeDraft,
        polygonDraft,
        activeLayer,
        selected,
        snap,
        handleCopy,
        handlePaste,
        buildClipboardFromSelection,
        viewCenterBoard,
        zoomViewportAt,
        fitViewport,
    ]);

    const gridLines = useMemo(() => {
        const raw = Number(doc.meta?.gridMm) > 0 ? Number(doc.meta.gridMm) : 0.5;
        const displayStep = Math.max(raw, Math.max(W, H) / 100);
        const els = [];
        let ix = 0;
        for (let gx = 0; gx <= W + 1e-9; gx += displayStep, ix += 1) {
            els.push(
                <line
                    key={`gv${ix}`}
                    x1={gx}
                    y1={0}
                    x2={gx}
                    y2={H}
                    stroke={ix % 5 === 0 ? 'rgba(148,163,184,0.16)' : 'rgba(148,163,184,0.06)'}
                    strokeWidth={0.05}
                />,
            );
        }
        let iy = 0;
        for (let gy = 0; gy <= H + 1e-9; gy += displayStep, iy += 1) {
            els.push(
                <line
                    key={`gh${iy}`}
                    x1={0}
                    y1={gy}
                    x2={W}
                    y2={gy}
                    stroke={iy % 5 === 0 ? 'rgba(148,163,184,0.16)' : 'rgba(148,163,184,0.06)'}
                    strokeWidth={0.05}
                />,
            );
        }
        return els;
    }, [W, H, doc.meta?.gridMm]);

    const ratsnest = useMemo(() => {
        const out = [];
        for (const [net, pts] of padCentersByNet) {
            if (pts.length < 2) continue;
            const hub = pts[0];
            const linkNet = schCrossNets.has(String(net).toLowerCase());
            for (let i = 1; i < pts.length; i++) {
                out.push(
                    <line
                        key={`rn-${net}-${i}`}
                        x1={hub[0]}
                        y1={hub[1]}
                        x2={pts[i][0]}
                        y2={pts[i][1]}
                        stroke={linkNet ? 'rgba(192,132,252,0.55)' : 'rgba(168,85,247,0.22)'}
                        strokeWidth={linkNet ? 0.14 : 0.08}
                        strokeDasharray="0.4 0.25"
                    />,
                );
            }
        }
        return out;
    }, [padCentersByNet, schCrossNets]);

    const cursorClass = pcbViewDrag
        ? 'pcb-cursor-grabbing'
        : tool === 'pan'
          ? 'pcb-cursor-grab'
          : tool === 'select'
            ? drag
                ? 'pcb-cursor-move'
                : 'pcb-cursor-select'
            : tool === 'polygon' || tool === 'route' || tool === 'place' || tool === 'via'
              ? 'pcb-cursor-cross'
              : '';

    const inspectorTarget = useMemo(() => {
        if (selected.length !== 1) return null;
        const s = selected[0];
        if (s.kind === 'placement') {
            const p = (doc.placements || []).find((x) => x.id === s.id);
            return p ? { kind: 'placement', p } : null;
        }
        if (s.kind === 'track') {
            const t = (doc.tracks || []).find((x) => x.id === s.id);
            return t ? { kind: 'track', t } : null;
        }
        if (s.kind === 'via') {
            const v = (doc.vias || []).find((x) => x.id === s.id);
            return v ? { kind: 'via', v } : null;
        }
        if (s.kind === 'polygon') {
            const po = (doc.polygons || []).find((x) => x.id === s.id);
            return po ? { kind: 'polygon', po } : null;
        }
        return null;
    }, [selected, doc.placements, doc.tracks, doc.vias, doc.polygons]);

    return (
        <div className="pcb-root">
            <header className="pcb-topbar">
                <h1>PCB Studio</h1>
                {onBackToSchematic ? (
                    <div className="pcb-view-switch" role="group" aria-label="Schematic or board">
                        <button type="button" className="pcb-view-switch-btn" onClick={() => onBackToSchematic()}>
                            <Home size={13} /> Schematic
                        </button>
                        <span className="pcb-view-switch-btn is-active" aria-current="page">
                            <CircuitBoard size={13} /> Board
                        </span>
                    </div>
                ) : null}
                <span className="pcb-sep" />
                <label className="pcb-field pcb-field-stack">
                    Stack
                    <select
                        value={doc.meta.copperLayerCount}
                        onChange={(e) => {
                            const v = Number(e.target.value);
                            if (!COPPER_LAYER_COUNT_OPTIONS.includes(v)) return;
                            setDoc((d) => ({ ...d, meta: { ...d.meta, copperLayerCount: v } }));
                        }}
                        title="Copper layer count (2–8)"
                    >
                        {COPPER_LAYER_COUNT_OPTIONS.map((n) => (
                            <option key={n} value={n}>
                                {n} layers
                            </option>
                        ))}
                    </select>
                </label>
                <label className="pcb-field">
                    W mm
                    <input
                        type="number"
                        min={20}
                        max={500}
                        value={doc.meta.boardWmm}
                        onChange={(e) => {
                            const v = Number(e.target.value);
                            setDoc((d) => ({ ...d, meta: { ...d.meta, boardWmm: Number.isFinite(v) ? v : d.meta.boardWmm } }));
                        }}
                    />
                </label>
                <label className="pcb-field">
                    H mm
                    <input
                        type="number"
                        min={20}
                        max={500}
                        value={doc.meta.boardHmm}
                        onChange={(e) => {
                            const v = Number(e.target.value);
                            setDoc((d) => ({ ...d, meta: { ...d.meta, boardHmm: Number.isFinite(v) ? v : d.meta.boardHmm } }));
                        }}
                    />
                </label>
                <span className="pcb-sep" />
                <button type="button" className="pcb-topbtn" onClick={handleRunDRC}>
                    <AlertTriangle size={14} color={drcViolations.length > 0 ? '#ef4444' : 'currentColor'} /> DRC{' '}
                    {drcViolations.length > 0 ? `(${drcViolations.length})` : ''}
                </button>
                <button type="button" className="pcb-topbtn" disabled={exportBusy} onClick={() => void handleExportZip()}>
                    <Download size={14} /> {exportBusy ? '…' : 'Gerber ZIP'}
                </button>
                <button type="button" className="pcb-topbtn" onClick={() => setShowOnlineSearch(true)} title="Search LCSC / SnapEDA style parts">
                    <Download size={14} /> Find parts
                </button>
                <button type="button" className="pcb-topbtn" onClick={() => setShowFootprintImport(true)} title="JSON, KiCad mod, or URL">
                    Import footprint
                </button>
                <button
                    type="button"
                    className="pcb-topbtn"
                    onClick={() => {
                        if (!window.confirm('Clear saved board and reset?')) return;
                        const fresh = migratePcbDoc(emptyPcbDoc());
                        setDoc(fresh);
                        setPcbWorkflowDemo(false);
                        try {
                            localStorage.removeItem(PCB_STORAGE_KEY);
                        } catch {
                            /* */
                        }
                    }}
                >
                    <Trash2 size={14} /> New board
                </button>
            </header>

            {pcbWorkflowDemo ? (
                <div className="pcb-demo-banner" role="region" aria-label="Gerber walkthrough tips">
                    <div className="pcb-demo-banner-icon" aria-hidden>
                        <Route size={18} />
                    </div>
                    <div className="pcb-demo-banner-body">
                        <strong>Gerber walkthrough</strong>
                        <span className="pcb-demo-banner-lead">
                            You opened this board from the Circuit Studio tutorial demo. Finish the flow here:
                        </span>
                        <ol className="pcb-demo-banner-steps">
                            <li>
                                <Zap size={14} aria-hidden /> Click <strong>Auto-route</strong> (lightning) in the left tool rail to add copper between pads on the same net.
                            </li>
                            <li>
                                <Download size={14} aria-hidden /> Click <strong>Gerber ZIP</strong> above — your browser downloads fabrication layers (open in a Gerber viewer or fab upload).
                            </li>
                            <li>
                                Optional: run <strong>DRC</strong> for a quick clearance check (demo router is simple, not production-grade).
                            </li>
                        </ol>
                    </div>
                    <button
                        type="button"
                        className="pcb-demo-banner-dismiss"
                        onClick={() => setPcbWorkflowDemo(false)}
                        aria-label="Dismiss walkthrough tips"
                    >
                        <X size={16} />
                    </button>
                </div>
            ) : null}

            <div className="pcb-workspace">
                <nav className="pcb-command-rail" aria-label="Tools">
                    <button
                        type="button"
                        className={`pcb-rail-btn${tool === 'select' ? ' is-active' : ''}`}
                        title="Select / move — Shift+click multi-select"
                        onClick={() => {
                            setTool('select');
                            setRouteDraft(null);
                            setPolygonDraft(null);
                        }}
                    >
                        <MousePointer2 size={18} />
                    </button>
                    <button
                        type="button"
                        className={`pcb-rail-btn${tool === 'place' ? ' is-active' : ''}`}
                        title="Place footprint"
                        onClick={() => {
                            setTool('place');
                            setRouteDraft(null);
                            setPolygonDraft(null);
                        }}
                    >
                        <MapPin size={18} />
                    </button>
                    <button
                        type="button"
                        className={`pcb-rail-btn${tool === 'route' ? ' is-active' : ''}`}
                        title="Track — polyline, Enter to finish"
                        onClick={() => {
                            setTool('route');
                            setRouteDraft(null);
                            setPolygonDraft(null);
                        }}
                    >
                        <GitBranch size={18} />
                    </button>
                    <button
                        type="button"
                        className={`pcb-rail-btn${tool === 'polygon' ? ' is-active' : ''}`}
                        title="Copper pour — vertices, Enter (≥3) closes polygon"
                        onClick={() => {
                            setTool('polygon');
                            setRouteDraft(null);
                            setPolygonDraft(null);
                        }}
                    >
                        <Pentagon size={18} />
                    </button>
                    <button
                        type="button"
                        className={`pcb-rail-btn${tool === 'via' ? ' is-active' : ''}`}
                        title="Place via"
                        onClick={() => {
                            setTool('via');
                            setRouteDraft(null);
                            setPolygonDraft(null);
                        }}
                    >
                        <CircleDot size={18} />
                    </button>
                    <div className="pcb-rail-spacer" />
                    <button type="button" className="pcb-rail-btn" title="Auto-route nets (uses all copper layers)" onClick={handleAutoRoute}>
                        <Zap size={18} />
                    </button>
                </nav>

                <aside className="pcb-sidebar">
                    <div className="pcb-sidebar-head">
                        <h2>Library</h2>
                        <button type="button" className="pcb-sidebar-import" onClick={() => setShowFootprintImport(true)}>
                            + Import
                        </button>
                    </div>
                    <p className="pcb-sidebar-lead">Pick a footprint, then Place on the board.</p>
                    <h3 className="pcb-subh">
                        <Layers size={12} /> Active copper
                    </h3>
                    <div className="pcb-layer-chips">
                        {copperStack.map((ly) => (
                            <button
                                key={ly}
                                type="button"
                                className={`pcb-layer-chip${activeLayer === ly ? ' is-active' : ''}`}
                                onClick={() => setActiveLayer(ly)}
                                title="Tracks you draw go on this layer"
                            >
                                {ly.replace('.Cu', '')}
                            </button>
                        ))}
                    </div>
                    <h3 className="pcb-subh">Board &amp; grid</h3>
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
                    <h3 className="pcb-subh">Edit</h3>
                    <div className="pcb-edit-row">
                        <button type="button" onClick={handleCopy} title="Copy selection (⌘C / Ctrl+C)">
                            <Copy size={12} /> Copy
                        </button>
                        <button type="button" onClick={handlePaste} title="Paste at last click (⌘V)">
                            <ClipboardPaste size={12} /> Paste
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                if (!selected.length) return;
                                setDoc((d) => ({
                                    ...d,
                                    placements: d.placements.map((p) =>
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
                        ⌘/Ctrl+C copy · V paste at pointer · D duplicate · R rotate · Shift+click multi · Del delete
                    </p>
                    <h3 className="pcb-subh">Footprints</h3>
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
                </aside>
                <div className="pcb-canvas-wrap" ref={canvasWrapRef}>
                    <svg
                        ref={svgRef}
                        className={`pcb-board-svg ${cursorClass}`}
                        width={Math.min(920, Math.max(320, W * 8))}
                        height={Math.min(640, Math.max(240, H * 8))}
                        viewBox={viewBoxStr}
                        onMouseDown={onSvgDown}
                    >
                        <rect x={0} y={0} width={W} height={H} fill="#1a1520" stroke="#4c1d95" strokeWidth={0.12} />
                        {gridLines}
                        <g className="pcb-ratsnest">{ratsnest}</g>
                        {(doc.polygons || []).map((poly) => {
                            const pts = poly.points || [];
                            if (pts.length < 3) return null;
                            const dPath = `${pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ')} Z`;
                            const baseCol = PCB_LAYER_COLORS[poly.layer] || '#94a3b8';
                            const isSel = isItemSelected(selected, 'polygon', poly.id);
                            const schLink =
                                poly.net && schCrossNets.has(String(poly.net).toLowerCase());
                            const stroke = isSel ? '#f472b6' : schLink ? '#c084fc' : baseCol;
                            return (
                                <path
                                    key={poly.id}
                                    d={dPath}
                                    fill={baseCol}
                                    fillOpacity={0.12}
                                    stroke={stroke}
                                    strokeWidth={isSel ? 0.12 : schLink ? 0.1 : 0.06}
                                    opacity={poly.layer === activeLayer ? 1 : 0.35}
                                    onMouseDown={(e) => {
                                        e.stopPropagation();
                                        const item = { kind: 'polygon', id: poly.id };
                                        setSelected((prev) => (e.shiftKey ? toggleSelectionItem(prev, item) : [item]));
                                        setDrag(null);
                                    }}
                                    style={{ cursor: 'pointer' }}
                                />
                            );
                        })}
                        {(doc.tracks || []).map((tr) => {
                            const pts = tr.points || [];
                            if (pts.length < 2) return null;
                            const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ');
                            const isSel = isItemSelected(selected, 'track', tr.id);
                            const baseCol = PCB_LAYER_COLORS[tr.layer] || '#94a3b8';
                            const schLink =
                                tr.net && schCrossNets.has(String(tr.net).toLowerCase());
                            const stroke = isSel ? '#f472b6' : schLink ? '#c084fc' : baseCol;
                            return (
                                <path
                                    key={tr.id}
                                    d={d}
                                    fill="none"
                                    stroke={stroke}
                                    strokeWidth={(tr.widthMm || 0.35) * (schLink && !isSel ? 1.45 : 1)}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    opacity={tr.layer === activeLayer ? 1 : 0.35}
                                    onMouseDown={(e) => {
                                        e.stopPropagation();
                                        const item = { kind: 'track', id: tr.id };
                                        setSelected((prev) => (e.shiftKey ? toggleSelectionItem(prev, item) : [item]));
                                        setDrag(null);
                                    }}
                                    style={{ cursor: 'pointer' }}
                                />
                            );
                        })}
                        {(doc.vias || []).map((v) => {
                            const isSel = isItemSelected(selected, 'via', v.id);
                            const schLink = v.net && schCrossNets.has(String(v.net).toLowerCase());
                            return (
                                <g key={v.id} style={{ cursor: 'pointer' }}>
                                    <circle
                                        cx={v.x}
                                        cy={v.y}
                                        r={(v.diamMm || 0.8) / 2}
                                        fill={
                                            isSel
                                                ? 'rgba(244,114,182,0.5)'
                                                : schLink
                                                  ? 'rgba(192,132,252,0.45)'
                                                  : 'rgba(250,204,21,0.35)'
                                        }
                                        stroke={schLink && !isSel ? '#c084fc' : '#facc15'}
                                        strokeWidth={0.06}
                                        onMouseDown={(e) => {
                                            e.stopPropagation();
                                            const item = { kind: 'via', id: v.id };
                                            setSelected((prev) => (e.shiftKey ? toggleSelectionItem(prev, item) : [item]));
                                            setDrag(null);
                                        }}
                                    />
                                </g>
                            );
                        })}
                        {(doc.placements || []).map((pl) => {
                            const fp = getFootprint(pl.footprintId);
                            const isSel = isItemSelected(selected, 'placement', pl.id);
                            const b = footprintBBox(pl);
                            const schRef =
                                pl.ref && schCrossRefs.has(String(pl.ref).toUpperCase());
                            return (
                                <g
                                    key={pl.id}
                                    onMouseDown={(e) => {
                                        if (tool === 'route' || tool === 'polygon') e.stopPropagation();
                                    }}
                                >
                                    {isSel ? (
                                        <rect
                                            x={b.minX - 0.3}
                                            y={b.minY - 0.3}
                                            width={b.maxX - b.minX + 0.6}
                                            height={b.maxY - b.minY + 0.6}
                                            fill="none"
                                            stroke="#f472b6"
                                            strokeWidth={0.08}
                                            strokeDasharray="0.2 0.15"
                                        />
                                    ) : schRef ? (
                                        <rect
                                            x={b.minX - 0.35}
                                            y={b.minY - 0.35}
                                            width={b.maxX - b.minX + 0.7}
                                            height={b.maxY - b.minY + 0.7}
                                            fill="none"
                                            stroke="#a855f7"
                                            strokeWidth={0.1}
                                            strokeDasharray="0.25 0.18"
                                        />
                                    ) : null}
                                    {fp?.pads?.map((pad) => {
                                        const [px, py] = padWorld(pl, pad);
                                        return (
                                            <rect
                                                key={pad.id}
                                                x={px - pad.w / 2}
                                                y={py - pad.h / 2}
                                                width={pad.w}
                                                height={pad.h}
                                                fill="#334155"
                                                stroke="#94a3b8"
                                                strokeWidth={0.04}
                                            />
                                        );
                                    })}
                                    <text
                                        x={pl.x}
                                        y={pl.y - 2}
                                        textAnchor="middle"
                                        fill="#e2e8f0"
                                        fontSize="0.9px"
                                        style={{ fontFamily: 'system-ui, sans-serif' }}
                                    >
                                        {pl.ref}
                                    </text>
                                </g>
                            );
                        })}
                        {routeDraft?.length ? (
                            <path
                                d={routeDraft.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ')}
                                fill="none"
                                stroke="#a855f7"
                                strokeWidth={doc.meta.defaultTrackMm}
                                strokeDasharray="0.3 0.2"
                                strokeLinecap="round"
                            />
                        ) : null}
                        {polygonDraft?.length ? (
                            <path
                                d={polygonDraft.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ')}
                                fill="none"
                                stroke="#34d399"
                                strokeWidth={0.15}
                                strokeDasharray="0.25 0.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        ) : null}
                        {drcViolations.map((v, i) => (
                            <g key={`drc-${i}`}>
                                <circle cx={v.x} cy={v.y} r={1.5} fill="none" stroke="#ef4444" strokeWidth={0.3} strokeDasharray="0.5 0.5" />
                                <text x={v.x} y={v.y - 2} fill="#ef4444" fontSize="1px" textAnchor="middle">{v.type}</text>
                            </g>
                        ))}
                    </svg>
                </div>
                <p className="pcb-hint">
                    Library → place → route / copper pour → Gerber. Snap grid {doc.meta.gridMm ?? 0.5} mm
                    {doc.meta.snapToGrid === false ? ' (snap off)' : ''}. Selection in Circuit Studio highlights matching refs / nets here (violet). Send-to-PCB
                    still merges once when you open this page from the schematic.
                </p>
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
        </div>
    );
}

export default PcbStudioPage;
