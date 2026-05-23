/**
 * Thermal Studio — 2D MEMS micro-hotplate simulator with full vector CAD.
 *
 * Architecture
 * ────────────
 *   Vector CAD layer  (entities[], in µm, painter's z-order)
 *           │   tools draw / edit / boolean / offset / fillet / mirror /
 *           │   rotate / translate / scale / SVG · DXF import / undo · redo
 *           ▼
 *     rasterizeEntitiesToGrid → materialIdx + heaterMask  (Uint8Arrays)
 *           │
 *           ▼
 *   thermalWorker (off-thread)  → snapshot Float64 T[] back to UI
 *           │
 *           ▼
 *   Heatmap canvas (putImageData) + entity SVG overlay (selection, marquee,
 *   draft shapes) + probe pin + colormap legend + T(t) chart.
 *
 * Coordinates: domain spans [-L/2, +L/2]² µm, centred on origin. Cells are
 * dx = L/Nx µm/side. The CAD canvas (SVG) and the heatmap canvas share the
 * same viewport / transform so vector + raster line up exactly.
 */

import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    Tooltip as RechartsTooltip,
    ResponsiveContainer,
    CartesianGrid,
    ReferenceLine,
} from 'recharts';
import {
    MousePointer2,
    Square,
    Circle as CircleIcon,
    Hexagon,
    PenLine,
    Spline,
    Minus as LineIcon,
    Eraser,
    Crosshair,
    Flame,
    Play,
    Pause,
    RotateCcw,
    Thermometer,
    Layers as LayersIcon,
    Zap,
    Activity,
    HelpCircle,
    Combine,
    Diff as SubtractIcon,
    SquareAsterisk,
    Shuffle,
    Shapes,
    MoveHorizontal,
    FlipHorizontal,
    RotateCw,
    Trash2,
    Upload,
    Undo2,
    Redo2,
    Brush,
    Magnet,
    FilePlus,
    Save,
    FolderOpen,
    Settings2,
} from 'lucide-react';
import {
    THERMAL_MATERIALS,
    THERMAL_MATERIAL_IDS,
    materialIndex,
    materialPropsByIndex,
    isHeaterMaterialIndex,
} from '../thermal/materials.js';
import {
    THERMAL_CAD_TEMPLATES,
    createThermalRect,
    createThermalCircle,
    createThermalEllipse,
    createThermalPolygon,
    createThermalPolyline,
    createThermalArc,
} from '../thermal/thermalCadTemplates.js';
import {
    tagAsThermal,
    thermalUnion,
    thermalSubtract,
    thermalIntersect,
    thermalXor,
    thermalOffset,
    thermalFilletVertex,
    thermalTranslate,
    thermalRotate,
    thermalMirror,
    thermalScale,
    hitEntity,
    allEntitiesBBox,
    entitiesCentroid,
    entityCentroid,
    sampleArc3Point,
    polylineLengthUm,
    estimateEntityResistanceOhm,
} from '../thermal/thermalEntity.js';
import { rasterizeEntitiesToGrid, countMaskCells } from '../thermal/thermalRaster.js';
import { parseSvgToEntities } from '../flowlab/importers/svg.js';
import { parseDxfToEntities } from '../flowlab/importers/dxf.js';
import { COLORMAPS, COLORMAP_NAMES, sample as sampleColormap } from '../flowlab/colormap.js';
import {
    THERMAL_DOC_SCHEMA,
    newThermalDoc,
    isThermalDoc,
    migrateThermalDoc,
    serializeThermalDoc,
    thermalDocFileName,
} from '../thermal/thermalDoc.js';
import {
    THERMAL_STUDIO_WORKSPACE_FOLDER_NAME,
    THERMAL_STUDIO_FILE_SUFFIX,
} from '../utils/workspaceFilename.js';
import './ThermalStudio.css';

const KELVIN_OFFSET = 273.15;
const KtoC = (k) => k - KELVIN_OFFSET;
const CtoK = (c) => c + KELVIN_OFFSET;

const DEFAULTS = Object.freeze({
    domainUm: 1000,
    Nx: 100,
    Ny: 100,
    thicknessUm: 1.0,
    heaterPowerMW: 30,
    ambientC: 25,
    hTop: 10,
    hBot: 10,
    colormap: 'inferno',
});

/** Tool ids — mirror Flow Lab's vocabulary so the UX is familiar. */
const TOOLS = {
    SELECT: 'select',
    RECT: 'rect',
    CIRCLE: 'circle',
    ELLIPSE: 'ellipse',
    POLYGON: 'polygon',
    POLYLINE: 'polyline',
    LINE: 'line',
    ARC: 'arc',
    BRUSH: 'brush',
    PROBE: 'probe',
    MEASURE: 'measure',
};

const HISTORY_LIMIT = 50;

export default function ThermalStudio({
    workspaceFiles = [],
    onSaveJson = null,
    onDeleteFile = null,
} = {}) {
    /* ───────── project / file management ─────────
       The Thermal Studio doc is a JSON file in the "Thermal Studio" workspace
       folder. We keep four pieces of state so Save can update in place vs.
       Save As (which calls onSaveJson with a new fileName + clears the id). */
    const [projectName, setProjectName] = useState('untitled');
    const [projectCreatedAt, setProjectCreatedAt] = useState(null);
    const [projectFileId, setProjectFileId] = useState(null);
    const [projectFileName, setProjectFileName] = useState(null);
    const [showLanding, setShowLanding] = useState(true);
    const [isDirty, setIsDirty] = useState(false);

    /* ───────── simulation mode ───────── */
    const [simulationMode, setSimulationMode] = useState('thermal'); // 'thermal' | 'electrothermal'

    /* ───────── geometry / domain ───────── */
    const [domainUm, setDomainUm] = useState(DEFAULTS.domainUm);
    const [Nx, setNx] = useState(DEFAULTS.Nx);
    const [Ny, setNy] = useState(DEFAULTS.Ny);
    const dxM = (domainUm * 1e-6) / Nx;

    /* ───────── physics ───────── */
    const [thicknessUm, setThicknessUm] = useState(DEFAULTS.thicknessUm);
    const [heaterPowerMW, setHeaterPowerMW] = useState(DEFAULTS.heaterPowerMW);
    const [ambientC, setAmbientC] = useState(DEFAULTS.ambientC);
    const [hTop, setHTop] = useState(DEFAULTS.hTop);
    const [hBot, setHBot] = useState(DEFAULTS.hBot);

    /* ───────── electrical drive (V / I / P) ─────────
       The user picks a coil entity (or all heater entities) and a drive mode.
       The worker computes Joule heat = V²/R(T) or I²·R(T) on every step and
       distributes it over the heater mask. R(T) = R₀·(1 + α·(T_avg − T_ref)). */
    const [driveMode, setDriveMode] = useState('P'); // 'V' | 'I' | 'P'
    const [driveValue, setDriveValue] = useState(30); // V, mA, or mW depending on mode
    const [driveRefC, setDriveRefC] = useState(25);
    const [driveR0Override, setDriveR0Override] = useState(null); // null = auto
    const [driveTcrOverride, setDriveTcrOverride] = useState(null);
    const [driveMaxPowerMW, setDriveMaxPowerMW] = useState(null); // null = no clamp
    const [driveTraceWidthUm, setDriveTraceWidthUm] = useState(20);
    const [driveReadout, setDriveReadout] = useState(null); // live R/V/I/P from worker

    /* ───────── vector entities (CAD layer) ─────────
       Start with an empty stack — the landing screen prompts the user to
       create a New design or load a Template before they see anything on
       the canvas. */
    const [entities, setEntities] = useState(() => []);
    const undoStack = useRef([]);
    const redoStack = useRef([]);

    const commitEntities = useCallback(
        (next) => {
            undoStack.current.push(entities);
            if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
            redoStack.current = [];
            setEntities(next);
            setIsDirty(true);
        },
        [entities]
    );
    const undo = useCallback(() => {
        if (!undoStack.current.length) return;
        const prev = undoStack.current.pop();
        redoStack.current.push(entities);
        setEntities(prev);
    }, [entities]);
    const redo = useCallback(() => {
        if (!redoStack.current.length) return;
        const next = redoStack.current.pop();
        undoStack.current.push(entities);
        setEntities(next);
    }, [entities]);

    /* ───────── selection (set of entity ids), pick order array for booleans ───────── */
    const [selection, setSelection] = useState(() => new Set());
    const pickOrderRef = useRef([]);

    /* ───────── tool state ───────── */
    const [activeTool, setActiveTool] = useState(TOOLS.SELECT);
    const [activeMatId, setActiveMatId] = useState('platinum');
    const [activeIsHeater, setActiveIsHeater] = useState(true);
    const [snapEnabled, setSnapEnabled] = useState(true);
    const [snapStepUm, setSnapStepUm] = useState(10);
    const [openStrokeUm, setOpenStrokeUm] = useState(8);

    /* ───────── ephemeral draft state ───────── */
    const [draft, setDraft] = useState(null); // {kind, ...} for in-progress shape
    const [marqueeBox, setMarqueeBox] = useState(null);
    const [draftPolygon, setDraftPolygon] = useState(null); // points in µm
    const [draftPolyline, setDraftPolyline] = useState(null);
    const [draftArc3, setDraftArc3] = useState(null); // 3-point arc construction

    /* ───────── view ───────── */
    const [viewMode, setViewMode] = useState('materials');
    const [colormap, setColormap] = useState(DEFAULTS.colormap);
    const [tempRangeMode, setTempRangeMode] = useState('auto');
    const [manualMinC, setManualMinC] = useState(20);
    const [manualMaxC, setManualMaxC] = useState(300);
    const [showEntities, setShowEntities] = useState(true);

    /* ───────── solver state ───────── */
    const [Tfield, setTfield] = useState(null);
    const [stats, setStats] = useState(null);
    const [running, setRunning] = useState(false);
    const [simT, setSimT] = useState(0);
    const [history, setHistory] = useState([]);
    const [steadyResult, setSteadyResult] = useState(null);
    const [statusLine, setStatusLine] = useState('Ready · vector CAD on');
    const [solverError, setSolverError] = useState(null);
    const [probeIJ, setProbeIJ] = useState(() => ({
        i: Math.floor(DEFAULTS.Nx / 2),
        j: Math.floor(DEFAULTS.Ny / 2),
    }));
    const [measureA, setMeasureA] = useState(null);
    const [measureB, setMeasureB] = useState(null);

    const workerRef = useRef(null);
    const canvasRef = useRef(null);
    const overlayRef = useRef(null);
    const containerRef = useRef(null);
    const fileInputRef = useRef(null);
    const [canvasPx, setCanvasPx] = useState({ w: 600, h: 600 });

    /* ───────── derived: rasterized material grid + heater mask + BC layers ───────── */
    const raster = useMemo(
        () =>
            rasterizeEntitiesToGrid(entities, {
                Nx,
                Ny,
                domainUm,
                thicknessUm,
                baseMaterial: 'air',
                defaultStrokeUm: openStrokeUm,
                ambientC,
            }),
        [entities, Nx, Ny, domainUm, thicknessUm, openStrokeUm, ambientC]
    );
    const materialIdx = raster.materialIdx;
    const heaterMask = raster.heaterMask;

    /* ───────── worker plumbing ───────── */
    useEffect(() => {
        const w = new Worker(new URL('../thermal/thermalWorker.js', import.meta.url), {
            type: 'module',
        });
        workerRef.current = w;
        w.onmessage = (ev) => {
            const m = ev.data;
            if (m.type === 'ready') {
                setStatusLine(`Solver ready · ${m.Nx}×${m.Ny} grid`);
                return;
            }
            if (m.type === 'error') {
                setSolverError(m.message);
                setStatusLine(`Solver error: ${m.message}`);
                setRunning(false);
                return;
            }
            if (m.type === 'steady-done') {
                setTfield(new Float64Array(m.T));
                setStats(m.stats);
                setSteadyResult(m.result);
                setRunning(false);
                setSimT(0);
                if (m.drive) setDriveReadout(m.drive);
                setStatusLine(
                    `Steady · ${m.result.iters} it · max|ΔT|=${m.result.residualK.toExponential(2)}K · T_max=${KtoC(m.stats.maxK).toFixed(1)}°C`
                );
                setViewMode('temperature');
                return;
            }
            if (m.type === 'transient-snapshot') {
                setTfield(new Float64Array(m.T));
                setStats(m.stats);
                setSimT(m.simT);
                setHistory(m.history);
                if (m.drive) setDriveReadout(m.drive);
                return;
            }
            if (m.type === 'paused') {
                setRunning(false);
                setStatusLine(`Paused @ t=${(m.simT * 1000).toFixed(2)} ms`);
                if (m.drive) setDriveReadout(m.drive);
                return;
            }
        };
        return () => {
            w.terminate();
            workerRef.current = null;
        };
    }, []);

    const sendInit = useCallback(() => {
        const w = workerRef.current;
        if (!w) return;
        w.postMessage({
            type: 'init',
            opts: {
                Nx,
                Ny,
                dx: dxM,
                thicknessUm,
                ambientK: CtoK(ambientC),
                hTop,
                hBot,
                materialIdx: materialIdx.buffer.slice(0),
            },
        });
        w.postMessage({
            type: 'set-heater',
            heaterMask: heaterMask.buffer.slice(0),
            totalPowerW: heaterPowerMW * 1e-3,
        });
        w.postMessage({ type: 'set-probe', i: probeIJ.i, j: probeIJ.j });
        setSimT(0);
        setHistory([]);
        setSteadyResult(null);
        setTfield(null);
        setStats(null);
    }, [Nx, Ny, dxM, thicknessUm, ambientC, hTop, hBot, materialIdx, heaterMask, heaterPowerMW, probeIJ]);

    /* Re-init only when topology changes; push BC / material updates separately. */
    useEffect(() => {
        sendInit();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [Nx, Ny]);

    useEffect(() => {
        const w = workerRef.current;
        if (!w) return;
        w.postMessage({ type: 'set-materials', materialIdx: materialIdx.buffer.slice(0) });
        w.postMessage({
            type: 'set-heater',
            heaterMask: heaterMask.buffer.slice(0),
            totalPowerW: heaterPowerMW * 1e-3,
        });
        /* Stream the per-cell BC layers built by the rasterizer. */
        w.postMessage({
            type: 'set-source-q',
            sourceQwPerM3: raster.sourceQwPerM3.buffer.slice(0),
        });
        w.postMessage({
            type: 'set-dirichlet',
            pinMask: raster.pinTMask.buffer.slice(0),
            pinValueK: raster.pinTValueK.buffer.slice(0),
        });
        w.postMessage({
            type: 'set-initial',
            initialMask: raster.initialTMask.buffer.slice(0),
            initialValueK: raster.initialTValueK.buffer.slice(0),
        });
    }, [materialIdx, heaterMask, heaterPowerMW, raster]);

    useEffect(() => {
        const w = workerRef.current;
        if (!w) return;
        w.postMessage({
            type: 'set-bcs',
            ambientK: CtoK(ambientC),
            hTop,
            hBot,
            thicknessUm,
        });
    }, [ambientC, hTop, hBot, thicknessUm]);

    /* ───────── canvas sizing ───────── */
    useLayoutEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            for (const e of entries) {
                const w = Math.max(200, Math.floor(e.contentRect.width));
                const h = Math.max(200, Math.floor(e.contentRect.height));
                const side = Math.min(w, h);
                setCanvasPx({ w: side, h: side });
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    /* ───────── view-coords ↔ µm helpers ───────── */
    const halfL = domainUm / 2;
    const pxToUm = useCallback(
        (px, py) => ({
            x: (px / canvasPx.w) * domainUm - halfL,
            y: (py / canvasPx.h) * domainUm - halfL,
        }),
        [canvasPx.w, canvasPx.h, domainUm, halfL]
    );
    const umToPx = useCallback(
        (x, y) => ({
            x: ((x + halfL) / domainUm) * canvasPx.w,
            y: ((y + halfL) / domainUm) * canvasPx.h,
        }),
        [canvasPx.w, canvasPx.h, domainUm, halfL]
    );

    const snap = useCallback(
        (v) => {
            if (!snapEnabled || !(snapStepUm > 0)) return v;
            return Math.round(v / snapStepUm) * snapStepUm;
        },
        [snapEnabled, snapStepUm]
    );

    /* ───────── temperature range for colormap ───────── */
    const tempRange = useMemo(() => {
        if (tempRangeMode === 'manual') return { minK: CtoK(manualMinC), maxK: CtoK(manualMaxC) };
        if (stats) return { minK: stats.minK, maxK: stats.maxK };
        return { minK: CtoK(20), maxK: CtoK(60) };
    }, [tempRangeMode, manualMinC, manualMaxC, stats]);

    /* ───────── heatmap / material raster paint ───────── */
    useEffect(() => {
        const c = canvasRef.current;
        if (!c) return;
        const ctx = c.getContext('2d', { alpha: false });
        if (!ctx) return;
        const w = canvasPx.w;
        const h = canvasPx.h;
        c.width = Nx;
        c.height = Ny;
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
        const img = ctx.createImageData(Nx, Ny);
        const data = img.data;

        if (viewMode === 'temperature' && Tfield && Tfield.length === Nx * Ny) {
            const lut = COLORMAPS[colormap] || COLORMAPS.inferno;
            const range = Math.max(0.01, tempRange.maxK - tempRange.minK);
            for (let p = 0; p < Tfield.length; p++) {
                const t = Math.max(0, Math.min(1, (Tfield[p] - tempRange.minK) / range));
                const [r, g, b] = sampleColormap(lut, t);
                data[4 * p] = r;
                data[4 * p + 1] = g;
                data[4 * p + 2] = b;
                data[4 * p + 3] = 255;
            }
        } else {
            for (let p = 0; p < materialIdx.length; p++) {
                const m = materialPropsByIndex(materialIdx[p]);
                const col = m?.color || '#0f172a';
                data[4 * p] = parseInt(col.slice(1, 3), 16);
                data[4 * p + 1] = parseInt(col.slice(3, 5), 16);
                data[4 * p + 2] = parseInt(col.slice(5, 7), 16);
                data[4 * p + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
    }, [viewMode, Tfield, materialIdx, Nx, Ny, canvasPx.w, canvasPx.h, colormap, tempRange.minK, tempRange.maxK]);

    /* ───────── pick / hit-test ───────── */
    const tolUm = useMemo(() => Math.max(2, domainUm / 200), [domainUm]);
    const pickAt = useCallback(
        (x, y) => {
            for (let i = entities.length - 1; i >= 0; i--) {
                const ent = entities[i];
                const hit = hitEntity(ent, x, y, tolUm);
                if (hit) return { entity: ent, hit, index: i };
            }
            return null;
        },
        [entities, tolUm]
    );

    /* ───────── pointer interaction (SVG overlay handles pointer events) ───────── */
    const draftRef = useRef(null);
    draftRef.current = draft;

    const handlePointerDown = useCallback(
        (ev) => {
            ev.currentTarget.setPointerCapture?.(ev.pointerId);
            const rect = ev.currentTarget.getBoundingClientRect();
            const px = ev.clientX - rect.left;
            const py = ev.clientY - rect.top;
            const { x: rawX, y: rawY } = pxToUm(px, py);
            const x = snap(rawX);
            const y = snap(rawY);

            if (activeTool === TOOLS.SELECT) {
                const picked = pickAt(rawX, rawY);
                if (picked) {
                    if (ev.shiftKey) {
                        setSelection((prev) => {
                            const n = new Set(prev);
                            if (n.has(picked.entity.id)) {
                                n.delete(picked.entity.id);
                                pickOrderRef.current = pickOrderRef.current.filter(
                                    (id) => id !== picked.entity.id
                                );
                            } else {
                                n.add(picked.entity.id);
                                pickOrderRef.current.push(picked.entity.id);
                            }
                            return n;
                        });
                    } else {
                        setSelection(new Set([picked.entity.id]));
                        pickOrderRef.current = [picked.entity.id];
                    }
                    return;
                }
                /* empty space → marquee */
                if (!ev.shiftKey) {
                    setSelection(new Set());
                    pickOrderRef.current = [];
                }
                setMarqueeBox({ x0: rawX, y0: rawY, x1: rawX, y1: rawY });
                return;
            }
            if (activeTool === TOOLS.RECT || activeTool === TOOLS.CIRCLE || activeTool === TOOLS.ELLIPSE) {
                setDraft({ kind: activeTool, x0: x, y0: y, x1: x, y1: y });
                return;
            }
            if (activeTool === TOOLS.LINE) {
                setDraft({ kind: 'line', x0: x, y0: y, x1: x, y1: y });
                return;
            }
            if (activeTool === TOOLS.POLYGON) {
                setDraftPolygon((prev) => {
                    const pts = prev ? [...prev] : [];
                    if (pts.length >= 3) {
                        const first = pts[0];
                        if (Math.hypot(first.x - x, first.y - y) <= tolUm * 2) {
                            commitEntities([
                                ...entities,
                                createThermalPolygon(pts, {
                                    materialId: activeMatId,
                                    isHeater: activeIsHeater,
                                }),
                            ]);
                            return null;
                        }
                    }
                    pts.push({ x, y });
                    return pts;
                });
                return;
            }
            if (activeTool === TOOLS.POLYLINE) {
                setDraftPolyline((prev) => {
                    const pts = prev ? [...prev] : [];
                    pts.push({ x, y });
                    return pts;
                });
                return;
            }
            if (activeTool === TOOLS.ARC) {
                setDraftArc3((prev) => {
                    const pts = prev ? [...prev] : [];
                    pts.push({ x, y });
                    if (pts.length === 3) {
                        const arcPts = sampleArc3Point(pts[0], pts[1], pts[2], 64);
                        if (arcPts?.points?.length >= 2) {
                            commitEntities([
                                ...entities,
                                createThermalPolyline(arcPts.points, {
                                    materialId: activeMatId,
                                    isHeater: activeIsHeater,
                                    openTraceWidthUm: openStrokeUm,
                                }),
                            ]);
                        }
                        return null;
                    }
                    return pts;
                });
                return;
            }
            if (activeTool === TOOLS.PROBE) {
                const i = Math.max(0, Math.min(Nx - 1, Math.floor((rawX + halfL) / (domainUm / Nx))));
                const j = Math.max(0, Math.min(Ny - 1, Math.floor((rawY + halfL) / (domainUm / Ny))));
                setProbeIJ({ i, j });
                workerRef.current?.postMessage({ type: 'set-probe', i, j });
                return;
            }
            if (activeTool === TOOLS.MEASURE) {
                if (!measureA || (measureA && measureB)) {
                    setMeasureA({ x: rawX, y: rawY });
                    setMeasureB(null);
                } else {
                    setMeasureB({ x: rawX, y: rawY });
                }
                return;
            }
            if (activeTool === TOOLS.BRUSH) {
                /* Quick raster brush — fast tweaks; bakes a small rect into the
                   entity stack so it integrates cleanly with the CAD flow. */
                const brushSizeUm = Math.max(domainUm / Nx, snapStepUm);
                const ent = createThermalRect(
                    rawX - brushSizeUm,
                    rawY - brushSizeUm,
                    rawX + brushSizeUm,
                    rawY + brushSizeUm,
                    { materialId: activeMatId, isHeater: activeIsHeater }
                );
                commitEntities([...entities, ent]);
                setDraft({ kind: 'brush', x: rawX, y: rawY });
                return;
            }
        },
        [
            activeTool,
            entities,
            commitEntities,
            pickAt,
            pxToUm,
            snap,
            tolUm,
            activeMatId,
            activeIsHeater,
            openStrokeUm,
            measureA,
            measureB,
            Nx,
            Ny,
            halfL,
            domainUm,
            snapStepUm,
        ]
    );

    const handlePointerMove = useCallback(
        (ev) => {
            const rect = ev.currentTarget.getBoundingClientRect();
            const { x: rawX, y: rawY } = pxToUm(ev.clientX - rect.left, ev.clientY - rect.top);
            const x = snap(rawX);
            const y = snap(rawY);

            if (marqueeBox) {
                setMarqueeBox((prev) => ({ ...prev, x1: rawX, y1: rawY }));
                return;
            }
            if (draft && (draft.kind === TOOLS.RECT || draft.kind === TOOLS.CIRCLE || draft.kind === TOOLS.ELLIPSE || draft.kind === 'line')) {
                setDraft({ ...draft, x1: x, y1: y });
                return;
            }
            if (draft && draft.kind === 'brush' && ev.buttons & 1) {
                const brushSizeUm = Math.max(domainUm / Nx, snapStepUm);
                const ent = createThermalRect(
                    rawX - brushSizeUm,
                    rawY - brushSizeUm,
                    rawX + brushSizeUm,
                    rawY + brushSizeUm,
                    { materialId: activeMatId, isHeater: activeIsHeater }
                );
                /* Append without committing every move — debounce by direct setEntities. */
                setEntities((prev) => [...prev, ent]);
                setDraft({ kind: 'brush', x: rawX, y: rawY });
            }
        },
        [marqueeBox, draft, pxToUm, snap, activeMatId, activeIsHeater, domainUm, Nx, snapStepUm]
    );

    const handlePointerUp = useCallback(
        (ev) => {
            ev.currentTarget.releasePointerCapture?.(ev.pointerId);

            if (marqueeBox) {
                /* Select all entities whose bbox intersects the marquee. */
                const xmin = Math.min(marqueeBox.x0, marqueeBox.x1);
                const xmax = Math.max(marqueeBox.x0, marqueeBox.x1);
                const ymin = Math.min(marqueeBox.y0, marqueeBox.y1);
                const ymax = Math.max(marqueeBox.y0, marqueeBox.y1);
                const next = new Set(selection);
                for (const ent of entities) {
                    const bb = (() => {
                        let mn = { x: Infinity, y: Infinity };
                        let mx = { x: -Infinity, y: -Infinity };
                        for (const p of ent.points || []) {
                            mn.x = Math.min(mn.x, p.x);
                            mn.y = Math.min(mn.y, p.y);
                            mx.x = Math.max(mx.x, p.x);
                            mx.y = Math.max(mx.y, p.y);
                        }
                        return Number.isFinite(mn.x) ? { mn, mx } : null;
                    })();
                    if (!bb) continue;
                    const inter =
                        bb.mn.x <= xmax && bb.mx.x >= xmin && bb.mn.y <= ymax && bb.mx.y >= ymin;
                    if (inter) {
                        next.add(ent.id);
                        if (!pickOrderRef.current.includes(ent.id)) pickOrderRef.current.push(ent.id);
                    }
                }
                setSelection(next);
                setMarqueeBox(null);
                return;
            }
            if (draft) {
                if (draft.kind === TOOLS.RECT) {
                    if (Math.abs(draft.x1 - draft.x0) > 0.5 && Math.abs(draft.y1 - draft.y0) > 0.5) {
                        commitEntities([
                            ...entities,
                            createThermalRect(draft.x0, draft.y0, draft.x1, draft.y1, {
                                materialId: activeMatId,
                                isHeater: activeIsHeater,
                            }),
                        ]);
                    }
                } else if (draft.kind === TOOLS.CIRCLE) {
                    const r = Math.hypot(draft.x1 - draft.x0, draft.y1 - draft.y0);
                    if (r > 0.5) {
                        commitEntities([
                            ...entities,
                            createThermalCircle(draft.x0, draft.y0, r, {
                                materialId: activeMatId,
                                isHeater: activeIsHeater,
                            }),
                        ]);
                    }
                } else if (draft.kind === TOOLS.ELLIPSE) {
                    if (Math.abs(draft.x1 - draft.x0) > 0.5 && Math.abs(draft.y1 - draft.y0) > 0.5) {
                        const e = createThermalEllipse(draft.x0, draft.y0, draft.x1, draft.y1, {
                            materialId: activeMatId,
                            isHeater: activeIsHeater,
                        });
                        if (e) commitEntities([...entities, e]);
                    }
                } else if (draft.kind === 'line') {
                    const len = Math.hypot(draft.x1 - draft.x0, draft.y1 - draft.y0);
                    if (len > 0.5) {
                        commitEntities([
                            ...entities,
                            createThermalPolyline(
                                [
                                    { x: draft.x0, y: draft.y0 },
                                    { x: draft.x1, y: draft.y1 },
                                ],
                                {
                                    materialId: activeMatId,
                                    isHeater: activeIsHeater,
                                    openTraceWidthUm: openStrokeUm,
                                }
                            ),
                        ]);
                    }
                }
                setDraft(null);
            }
        },
        [
            marqueeBox,
            draft,
            selection,
            entities,
            commitEntities,
            activeMatId,
            activeIsHeater,
            openStrokeUm,
        ]
    );

    /* Polygon / polyline finish on Enter / dbl-click ─ also Esc clears drafts. */
    useEffect(() => {
        const onKey = (ev) => {
            const meta = ev.metaKey || ev.ctrlKey;
            if (meta && ev.key === 'z') {
                ev.preventDefault();
                if (ev.shiftKey) redo();
                else undo();
                return;
            }
            if (meta && ev.key === 'y') {
                ev.preventDefault();
                redo();
                return;
            }
            if (ev.key === 'Escape') {
                setDraft(null);
                setDraftPolygon(null);
                setDraftPolyline(null);
                setDraftArc3(null);
                setMarqueeBox(null);
                setMeasureA(null);
                setMeasureB(null);
                return;
            }
            if (ev.key === 'Enter') {
                if (draftPolygon && draftPolygon.length >= 3) {
                    commitEntities([
                        ...entities,
                        createThermalPolygon(draftPolygon, {
                            materialId: activeMatId,
                            isHeater: activeIsHeater,
                        }),
                    ]);
                    setDraftPolygon(null);
                    return;
                }
                if (draftPolyline && draftPolyline.length >= 2) {
                    commitEntities([
                        ...entities,
                        createThermalPolyline(draftPolyline, {
                            materialId: activeMatId,
                            isHeater: activeIsHeater,
                            openTraceWidthUm: openStrokeUm,
                        }),
                    ]);
                    setDraftPolyline(null);
                    return;
                }
            }
            if (ev.key === 'Delete' || ev.key === 'Backspace') {
                const t = ev.target;
                if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
                if (selection.size === 0) return;
                ev.preventDefault();
                commitEntities(entities.filter((e) => !selection.has(e.id)));
                setSelection(new Set());
                pickOrderRef.current = pickOrderRef.current.filter((id) => !selection.has(id));
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [
        undo,
        redo,
        draftPolygon,
        draftPolyline,
        entities,
        commitEntities,
        activeMatId,
        activeIsHeater,
        openStrokeUm,
        selection,
    ]);

    /* ───────── edit ops on selection ───────── */
    const selectedEntities = useMemo(
        () => entities.filter((e) => selection.has(e.id)),
        [entities, selection]
    );
    const selectedOrdered = useMemo(() => {
        const order = pickOrderRef.current.filter((id) => selection.has(id));
        return order.map((id) => entities.find((e) => e.id === id)).filter(Boolean);
    }, [entities, selection]);

    const replaceSelection = useCallback(
        (newOnes) => {
            const next = entities.filter((e) => !selection.has(e.id)).concat(newOnes);
            commitEntities(next);
            const ids = new Set(newOnes.map((e) => e.id));
            setSelection(ids);
            pickOrderRef.current = newOnes.map((e) => e.id);
        },
        [entities, selection, commitEntities]
    );

    const doBoolean = useCallback(
        (op) => {
            if (selectedOrdered.length < 2) {
                setStatusLine('Pick ≥2 closed shapes (Shift sets order for subtract / xor)');
                return;
            }
            const closed = selectedOrdered.filter((e) => e.closed !== false);
            if (closed.length < 2) {
                setStatusLine('Boolean ops need closed polygons');
                return;
            }
            let out = [];
            if (op === 'union') out = thermalUnion(closed);
            else if (op === 'subtract') out = thermalSubtract(closed);
            else if (op === 'intersect') out = thermalIntersect(closed);
            else if (op === 'xor') out = thermalXor(closed);
            if (!out.length) {
                setStatusLine(`${op}: empty result`);
                return;
            }
            replaceSelection(out);
            setStatusLine(`${op}: ${out.length} polygon(s)`);
        },
        [selectedOrdered, replaceSelection]
    );

    const [offsetUm, setOffsetUm] = useState(5);
    const doOffset = useCallback(
        (sign) => {
            if (!selectedEntities.length) return;
            const dist = sign * Math.abs(Number(offsetUm) || 0);
            if (dist === 0) {
                setStatusLine('Set offset distance ≠ 0');
                return;
            }
            const out = [];
            for (const ent of selectedEntities) {
                if (ent.closed === false) {
                    out.push(ent);
                    continue;
                }
                const o = thermalOffset(ent, dist);
                out.push(...(o.length ? o : [ent]));
            }
            replaceSelection(out);
            setStatusLine(`Offset Δ ${dist} µm`);
        },
        [selectedEntities, offsetUm, replaceSelection]
    );

    const doMirror = useCallback(
        (axis) => {
            if (!selectedEntities.length) return;
            const c = entitiesCentroid(selectedEntities) || { x: 0, y: 0 };
            const a = { x: c.x, y: c.y };
            const b = axis === 'h' ? { x: c.x + 1, y: c.y } : { x: c.x, y: c.y + 1 };
            const out = selectedEntities.map((e) => thermalMirror(e, a, b));
            replaceSelection(out);
            setStatusLine(`Mirror (${axis === 'h' ? 'horizontal' : 'vertical'})`);
        },
        [selectedEntities, replaceSelection]
    );

    const doRotate = useCallback(
        (deg) => {
            if (!selectedEntities.length) return;
            const c = entitiesCentroid(selectedEntities) || { x: 0, y: 0 };
            const out = selectedEntities.map((e) => thermalRotate(e, c.x, c.y, deg));
            replaceSelection(out);
            setStatusLine(`Rotate ${deg}°`);
        },
        [selectedEntities, replaceSelection]
    );

    const [translateUm, setTranslateUm] = useState({ dx: 50, dy: 0 });
    const doTranslate = useCallback(() => {
        if (!selectedEntities.length) return;
        const out = selectedEntities.map((e) => thermalTranslate(e, translateUm.dx, translateUm.dy));
        replaceSelection(out);
        setStatusLine(`Translate Δ(${translateUm.dx}, ${translateUm.dy}) µm`);
    }, [selectedEntities, translateUm, replaceSelection]);

    const [scaleFactor, setScaleFactor] = useState(1.1);
    const doScale = useCallback(() => {
        if (!selectedEntities.length) return;
        const c = entitiesCentroid(selectedEntities) || { x: 0, y: 0 };
        const f = Number(scaleFactor) || 1;
        const out = selectedEntities.map((e) => thermalScale(e, c.x, c.y, f, f));
        replaceSelection(out);
        setStatusLine(`Scale ×${f}`);
    }, [selectedEntities, scaleFactor, replaceSelection]);

    const [filletRadiusUm, setFilletRadiusUm] = useState(20);
    const doFilletAllVertices = useCallback(() => {
        if (!selectedEntities.length) return;
        const out = selectedEntities.map((e) => {
            if (e.closed === false || !e.points || e.points.length < 3) return e;
            let cur = e;
            const n = e.points.length;
            for (let v = n - 1; v >= 0; v--) {
                cur = thermalFilletVertex(cur, v, Number(filletRadiusUm) || 5);
                if (!cur || !cur.points) {
                    cur = e;
                    break;
                }
            }
            return cur;
        });
        replaceSelection(out);
        setStatusLine(`Fillet r=${filletRadiusUm} µm on all vertices`);
    }, [selectedEntities, filletRadiusUm, replaceSelection]);

    const setSelectionMaterial = useCallback(
        (matId) => {
            if (!selectedEntities.length) return;
            const isHeater = isHeaterMaterialIndex(materialIndex(matId));
            const out = entities.map((e) => {
                if (!selection.has(e.id)) return e;
                return tagAsThermal(e, { materialId: matId, isHeater });
            });
            commitEntities(out);
            setStatusLine(`Selection → ${THERMAL_MATERIALS[matId].name}`);
        },
        [selectedEntities, entities, selection, commitEntities]
    );

    const toggleHeaterFlag = useCallback(() => {
        if (!selectedEntities.length) return;
        const out = entities.map((e) => {
            if (!selection.has(e.id)) return e;
            return { ...e, isHeater: !e.isHeater };
        });
        commitEntities(out);
        setStatusLine(`Heater flag toggled on ${selectedEntities.length} entit(y/ies)`);
    }, [selectedEntities, entities, selection, commitEntities]);

    /* ───────── importers ───────── */
    const handleImportFile = useCallback(
        async (file) => {
            if (!file) return;
            try {
                const text = await file.text();
                const isDxf = /\.dxf$/i.test(file.name) || /^\s*\d+\s+SECTION/i.test(text.slice(0, 200));
                const parsed = isDxf ? parseDxfToEntities(text) : parseSvgToEntities(text);
                if (!parsed?.entities?.length) {
                    setStatusLine('Imported file had no usable shapes.');
                    return;
                }
                /* Flow Lab returns mm; thermal works in µm. Scale ×1000 and tag. */
                const scale = 1000;
                const tagged = parsed.entities.map((e) => {
                    const pts = e.points.map((p) => ({ x: p.x * scale, y: p.y * scale }));
                    return tagAsThermal(
                        { ...e, points: pts },
                        { materialId: activeMatId, isHeater: activeIsHeater }
                    );
                });
                commitEntities([...entities, ...tagged]);
                setStatusLine(
                    `Imported ${tagged.length} ${isDxf ? 'DXF' : 'SVG'} shape(s) → ${activeMatId}`
                );
            } catch (err) {
                setStatusLine(`Import failed: ${err.message || err}`);
            }
        },
        [entities, commitEntities, activeMatId, activeIsHeater]
    );

    /* ───────── run controls ───────── */
    const runSteady = useCallback(() => {
        const w = workerRef.current;
        if (!w) return;
        setRunning(true);
        setStatusLine('Solving steady…');
        w.postMessage({ type: 'run-steady', opts: { tolK: 1e-3, maxIters: 30000, omega: 1.7 } });
    }, []);
    const startTransient = useCallback(() => {
        const w = workerRef.current;
        if (!w) return;
        setRunning(true);
        setStatusLine('Running transient…');
        /* Auto-switch the canvas to the temperature heatmap so the user
           sees the live colour evolution; flip the manual-range mode to
           auto so the LUT tracks the rising max-T as it climbs. */
        setViewMode('temperature');
        setTempRangeMode('auto');
        w.postMessage({ type: 'start-transient', stepsPerFrame: 50, snapshotEveryMs: 16 });
    }, []);
    const pause = useCallback(() => workerRef.current?.postMessage({ type: 'pause' }), []);
    const resetField = useCallback(() => {
        workerRef.current?.postMessage({ type: 'reset' });
        setSimT(0);
        setHistory([]);
        setSteadyResult(null);
        setStatusLine('Field reset');
    }, []);

    const handleApplyTemplate = useCallback(
        (id) => {
            const tpl = THERMAL_CAD_TEMPLATES.find((t) => t.id === id);
            if (!tpl) return;
            commitEntities(tpl.build(domainUm));
            setSelection(new Set());
            pickOrderRef.current = [];
            setStatusLine(`Loaded template: ${tpl.label}`);
        },
        [domainUm, commitEntities]
    );

    /* ───────── project file management ───────── */

    /**
     * Replace ALL editor state with the contents of a Thermal-Studio doc.
     * Used by both Open-from-workspace and Open-from-disk.
     */
    const loadDocIntoEditor = useCallback((doc, fileMeta = null) => {
        const migrated = migrateThermalDoc(doc);
        if (!migrated) {
            window.alert('That file is not a Thermal Studio project (.thermal.json).');
            return false;
        }
        setProjectName(migrated.name || 'untitled');
        setProjectCreatedAt(migrated.createdAt || new Date().toISOString());
        setProjectFileId(fileMeta?.id ?? null);
        setProjectFileName(fileMeta?.name ?? null);
        setShowLanding(false);

        if (migrated.domain) {
            if (Number.isFinite(migrated.domain.domainUm)) setDomainUm(migrated.domain.domainUm);
            if (Number.isFinite(migrated.domain.Nx)) setNx(migrated.domain.Nx);
            if (Number.isFinite(migrated.domain.Ny)) setNy(migrated.domain.Ny);
            if (Number.isFinite(migrated.domain.thicknessUm)) setThicknessUm(migrated.domain.thicknessUm);
        }
        if (migrated.physics) {
            if (Number.isFinite(migrated.physics.ambientC)) setAmbientC(migrated.physics.ambientC);
            if (Number.isFinite(migrated.physics.hTop)) setHTop(migrated.physics.hTop);
            if (Number.isFinite(migrated.physics.hBot)) setHBot(migrated.physics.hBot);
        }
        if (migrated.simulation?.mode === 'electrothermal' || migrated.simulation?.mode === 'thermal') {
            setSimulationMode(migrated.simulation.mode);
        }
        if (migrated.drive) {
            const d = migrated.drive;
            if (d.mode === 'V' || d.mode === 'I' || d.mode === 'P') setDriveMode(d.mode);
            if (Number.isFinite(d.value)) setDriveValue(d.value);
            if (Number.isFinite(d.refC)) setDriveRefC(d.refC);
            setDriveR0Override(Number.isFinite(d.R0Override) ? d.R0Override : null);
            setDriveTcrOverride(Number.isFinite(d.tcrOverride) ? d.tcrOverride : null);
            if (Number.isFinite(d.traceWidthUm)) setDriveTraceWidthUm(d.traceWidthUm);
            setDriveMaxPowerMW(Number.isFinite(d.maxPowerMW) ? d.maxPowerMW : null);
        }
        const ents = Array.isArray(migrated.entities) ? migrated.entities : [];
        undoStack.current = [];
        redoStack.current = [];
        setEntities(ents);
        setSelection(new Set());
        pickOrderRef.current = [];
        setIsDirty(false);
        setStatusLine(
            `Opened ${fileMeta?.name ?? migrated.name}.thermal.json · ${ents.length} entit${ents.length === 1 ? 'y' : 'ies'}`
        );
        return true;
    }, []);

    /** Build a fresh project from the membrane template (or blank). */
    const handleNewProject = useCallback(
        ({ templateId = 'blank', name } = {}) => {
            const fresh = newThermalDoc({ name: name || 'untitled' });
            const tpl = THERMAL_CAD_TEMPLATES.find((t) => t.id === templateId);
            const ents = tpl ? tpl.build(fresh.domain.domainUm) : [];
            loadDocIntoEditor({ ...fresh, entities: ents });
            setProjectFileId(null);
            setProjectFileName(null);
            setIsDirty(true);
        },
        [loadDocIntoEditor]
    );

    /** Build a JSON doc out of current editor state. */
    const buildDoc = useCallback(
        () =>
            serializeThermalDoc({
                name: projectName,
                createdAt: projectCreatedAt,
                domainUm,
                Nx,
                Ny,
                thicknessUm,
                ambientC,
                hTop,
                hBot,
                simulationMode,
                drive: {
                    mode: driveMode,
                    value: driveValue,
                    refC: driveRefC,
                    R0Override: driveR0Override,
                    tcrOverride: driveTcrOverride,
                    traceWidthUm: driveTraceWidthUm,
                    maxPowerMW: driveMaxPowerMW,
                },
                entities,
            }),
        [
            projectName,
            projectCreatedAt,
            domainUm,
            Nx,
            Ny,
            thicknessUm,
            ambientC,
            hTop,
            hBot,
            simulationMode,
            driveMode,
            driveValue,
            driveRefC,
            driveR0Override,
            driveTcrOverride,
            driveTraceWidthUm,
            driveMaxPowerMW,
            entities,
        ]
    );

    const handleSaveProject = useCallback(async () => {
        if (!onSaveJson) {
            setStatusLine('Save unavailable — workspace is not connected.');
            return;
        }
        const doc = buildDoc();
        const fileName = projectFileName || thermalDocFileName(projectName);
        try {
            const res = await onSaveJson({
                folderName: THERMAL_STUDIO_WORKSPACE_FOLDER_NAME,
                fileName,
                json: doc,
            });
            if (res?.fileId) setProjectFileId(res.fileId);
            setProjectFileName(fileName);
            setIsDirty(false);
            setStatusLine(`Saved → ${THERMAL_STUDIO_WORKSPACE_FOLDER_NAME}/${fileName}`);
        } catch (err) {
            setStatusLine(`Save failed: ${err?.message ?? err}`);
        }
    }, [onSaveJson, buildDoc, projectFileName, projectName]);

    const handleSaveAsProject = useCallback(async () => {
        const inputName = window.prompt('Save As — project name:', projectName || 'untitled');
        if (!inputName) return;
        const trimmed = inputName.trim();
        if (!trimmed) return;
        setProjectName(trimmed);
        setProjectFileId(null);
        const fileName = thermalDocFileName(trimmed);
        if (!onSaveJson) {
            setStatusLine('Save unavailable — workspace is not connected.');
            return;
        }
        const doc = serializeThermalDoc({
            name: trimmed,
            createdAt: projectCreatedAt,
            domainUm,
            Nx,
            Ny,
            thicknessUm,
            ambientC,
            hTop,
            hBot,
            simulationMode,
            drive: {
                mode: driveMode,
                value: driveValue,
                refC: driveRefC,
                R0Override: driveR0Override,
                tcrOverride: driveTcrOverride,
                traceWidthUm: driveTraceWidthUm,
                maxPowerMW: driveMaxPowerMW,
            },
            entities,
        });
        try {
            const res = await onSaveJson({
                folderName: THERMAL_STUDIO_WORKSPACE_FOLDER_NAME,
                fileName,
                json: doc,
            });
            if (res?.fileId) setProjectFileId(res.fileId);
            setProjectFileName(fileName);
            setIsDirty(false);
            setStatusLine(`Saved As → ${THERMAL_STUDIO_WORKSPACE_FOLDER_NAME}/${fileName}`);
        } catch (err) {
            setStatusLine(`Save failed: ${err?.message ?? err}`);
        }
    }, [
        onSaveJson,
        projectName,
        projectCreatedAt,
        domainUm,
        Nx,
        Ny,
        thicknessUm,
        ambientC,
        hTop,
        hBot,
        simulationMode,
        driveMode,
        driveValue,
        driveRefC,
        driveR0Override,
        driveTcrOverride,
        driveTraceWidthUm,
        driveMaxPowerMW,
        entities,
    ]);

    /** Workspace files filtered to Thermal Studio docs (.thermal.json). */
    const thermalProjectsInWorkspace = useMemo(() => {
        if (!Array.isArray(workspaceFiles)) return [];
        return workspaceFiles
            .filter((f) => {
                if (!f || f.isFolder) return false;
                const folder = f.folderName || '';
                if (folder !== THERMAL_STUDIO_WORKSPACE_FOLDER_NAME) return false;
                if (typeof f.name === 'string' && f.name.endsWith(THERMAL_STUDIO_FILE_SUFFIX)) return true;
                if (f.data && f.data.schema === THERMAL_DOC_SCHEMA) return true;
                return false;
            })
            .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
    }, [workspaceFiles]);

    const handleOpenWorkspaceProject = useCallback(
        (file) => {
            if (!file?.data) {
                setStatusLine('That workspace file has no JSON content yet.');
                return;
            }
            if (!isThermalDoc(file.data)) {
                window.alert('Selected file is not a Thermal Studio project.');
                return;
            }
            loadDocIntoEditor(file.data, { id: file.id, name: file.name });
        },
        [loadDocIntoEditor]
    );

    const handleOpenLocalFile = useCallback(
        async (file) => {
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!isThermalDoc(data)) {
                    window.alert('That file is not a Thermal Studio project (.thermal.json).');
                    return;
                }
                loadDocIntoEditor(data, { id: null, name: file.name });
            } catch (err) {
                window.alert(`Could not parse JSON: ${err?.message ?? err}`);
            }
        },
        [loadDocIntoEditor]
    );

    const projectFileInputRef = useRef(null);

    /* ───────── electrothermal: auto R₀ from heater entities ───────── */
    const heaterEntities = useMemo(
        () => entities.filter((e) => e.isHeater),
        [entities]
    );
    /** Aggregate R₀ across all heater entities (parallel: 1/R = Σ 1/Ri). */
    const autoR0Ohm = useMemo(() => {
        if (!heaterEntities.length) return null;
        let invR = 0;
        for (const ent of heaterEntities) {
            const matId = ent.materialId || 'platinum';
            const m = THERMAL_MATERIALS[matId];
            if (!m?.rhoElecOhmM) continue;
            const w = ent.openTraceWidthUm || driveTraceWidthUm;
            const Ri = estimateEntityResistanceOhm(ent, w, thicknessUm, m.rhoElecOhmM);
            if (!(Ri > 0)) continue;
            invR += 1 / Ri;
        }
        return invR > 0 ? 1 / invR : null;
    }, [heaterEntities, driveTraceWidthUm, thicknessUm]);
    /** Aggregate TCR (weighted by 1/R, so dominant low-R material drives feedback). */
    const autoTCR = useMemo(() => {
        if (!heaterEntities.length) return 0;
        let num = 0;
        let den = 0;
        for (const ent of heaterEntities) {
            const m = THERMAL_MATERIALS[ent.materialId || 'platinum'];
            if (!m?.rhoElecOhmM) continue;
            const w = ent.openTraceWidthUm || driveTraceWidthUm;
            const Ri = estimateEntityResistanceOhm(ent, w, thicknessUm, m.rhoElecOhmM);
            if (!(Ri > 0)) continue;
            num += (m.tcrPerK ?? 0) / Ri;
            den += 1 / Ri;
        }
        return den > 0 ? num / den : 0;
    }, [heaterEntities, driveTraceWidthUm, thicknessUm]);
    const totalHeaterLengthUm = useMemo(
        () =>
            heaterEntities
                .filter((e) => e.closed === false)
                .reduce((s, e) => s + polylineLengthUm(e), 0),
        [heaterEntities]
    );
    const driveR0Ohm = driveR0Override !== null && Number.isFinite(driveR0Override)
        ? Math.max(1e-6, driveR0Override)
        : autoR0Ohm;
    const driveTcrPerK = driveTcrOverride !== null && Number.isFinite(driveTcrOverride)
        ? driveTcrOverride
        : autoTCR;

    /** Push the drive parameters to the worker. In pure 'thermal' mode the
        drive is disabled — the heater region (if any) just uses heaterPowerMW
        as a constant power, which is what `set-heater` already wires. */
    useEffect(() => {
        const w = workerRef.current;
        if (!w) return;
        if (simulationMode !== 'electrothermal') {
            w.postMessage({ type: 'set-drive', drive: null });
            return;
        }
        if (driveMode === 'P') {
            /* In Power mode we still use the drive path so V/I/R update correctly,
               but it doesn't depend on R for P. */
            w.postMessage({
                type: 'set-drive',
                drive: {
                    mode: 'P',
                    value: Math.max(0, Number(driveValue) || 0) * 1e-3,
                    R0Ohm: driveR0Ohm || 1,
                    tcrPerK: driveTcrPerK || 0,
                    refK: CtoK(driveRefC),
                    maxPowerW: driveMaxPowerMW ? driveMaxPowerMW * 1e-3 : null,
                },
            });
        } else {
            const valueSI = driveMode === 'V'
                ? Number(driveValue) || 0
                : (Number(driveValue) || 0) * 1e-3; // mA → A
            if (!(driveR0Ohm > 0)) {
                w.postMessage({ type: 'set-drive', drive: null });
                return;
            }
            w.postMessage({
                type: 'set-drive',
                drive: {
                    mode: driveMode,
                    value: valueSI,
                    R0Ohm: driveR0Ohm,
                    tcrPerK: driveTcrPerK || 0,
                    refK: CtoK(driveRefC),
                    maxPowerW: driveMaxPowerMW ? driveMaxPowerMW * 1e-3 : null,
                },
            });
        }
    }, [simulationMode, driveMode, driveValue, driveR0Ohm, driveTcrPerK, driveRefC, driveMaxPowerMW]);

    /* ───────── derived ───────── */
    const heaterCells = useMemo(() => countMaskCells(heaterMask), [heaterMask]);
    const heaterAreaUm2 = (heaterCells * (domainUm / Nx) * (domainUm / Nx)).toFixed(0);
    const dieMaxC = stats ? KtoC(stats.maxK) : null;
    const dieMeanC = stats ? KtoC(stats.meanK) : null;
    const chartData = useMemo(
        () =>
            history.map((h) => ({
                tMs: h.t * 1000,
                Tc: KtoC(h.Tprobe),
                Pmw: h.P != null ? h.P * 1000 : null,
                Rohm: h.R != null ? h.R : null,
                Vv: h.V != null ? h.V : null,
                ImA: h.I != null ? h.I * 1000 : null,
            })),
        [history]
    );

    /* ───────── SVG entity rendering ───────── */
    /**
     * In Materials view we want filled, easy-to-distinguish swatches; in
     * Temperature view we want the heatmap to read clearly so we drop the fill
     * to ~0 and just keep a thin outline (heaters get a dashed red outline so
     * the user can still see where the source is).
     */
    const renderEntitySvg = useCallback(
        (ent) => {
            if (!ent?.points?.length) return null;
            const isClosed = ent.closed !== false;
            const sel = selection.has(ent.id);
            const matColor = ent.materialId
                ? THERMAL_MATERIALS[ent.materialId]?.color || '#94a3b8'
                : '#94a3b8';
            const onHeatmap = viewMode === 'temperature';
            const stroke = sel ? '#38bdf8' : ent.isHeater ? '#f87171' : onHeatmap ? '#0f172a' : '#cbd5e1';
            const sw = sel ? 2 : onHeatmap ? 0.8 : 1;
            const fillOpacity = onHeatmap ? 0 : 0.18;
            const strokeOpacity = onHeatmap ? (ent.isHeater || sel ? 0.85 : 0.35) : 0.9;
            const ptsAttr = ent.points.map((p) => {
                const q = umToPx(p.x, p.y);
                return `${q.x.toFixed(2)},${q.y.toFixed(2)}`;
            }).join(' ');
            return isClosed ? (
                <polygon
                    key={ent.id}
                    points={ptsAttr}
                    fill={matColor}
                    fillOpacity={fillOpacity}
                    stroke={stroke}
                    strokeOpacity={strokeOpacity}
                    strokeWidth={sw}
                    strokeDasharray={ent.isHeater ? '4 3' : undefined}
                />
            ) : (
                <polyline
                    key={ent.id}
                    points={ptsAttr}
                    fill="none"
                    stroke={stroke}
                    strokeOpacity={strokeOpacity}
                    strokeWidth={Math.max(sw, (ent.openTraceWidthUm / domainUm) * canvasPx.w / 2)}
                />
            );
        },
        [selection, umToPx, domainUm, canvasPx.w, viewMode]
    );

    const draftSvg = useMemo(() => {
        if (!draft) return null;
        if (draft.kind === TOOLS.RECT) {
            const a = umToPx(Math.min(draft.x0, draft.x1), Math.min(draft.y0, draft.y1));
            const b = umToPx(Math.max(draft.x0, draft.x1), Math.max(draft.y0, draft.y1));
            return (
                <rect
                    x={a.x}
                    y={a.y}
                    width={b.x - a.x}
                    height={b.y - a.y}
                    fill="rgba(56, 189, 248, 0.18)"
                    stroke="#7dd3fc"
                    strokeDasharray="4 4"
                />
            );
        }
        if (draft.kind === TOOLS.CIRCLE) {
            const c = umToPx(draft.x0, draft.y0);
            const r = Math.hypot(
                umToPx(draft.x1, 0).x - c.x,
                umToPx(0, draft.y1).y - c.y
            );
            return (
                <circle cx={c.x} cy={c.y} r={r} fill="rgba(56, 189, 248, 0.18)" stroke="#7dd3fc" strokeDasharray="4 4" />
            );
        }
        if (draft.kind === TOOLS.ELLIPSE) {
            const a = umToPx(Math.min(draft.x0, draft.x1), Math.min(draft.y0, draft.y1));
            const b = umToPx(Math.max(draft.x0, draft.x1), Math.max(draft.y0, draft.y1));
            return (
                <ellipse
                    cx={(a.x + b.x) / 2}
                    cy={(a.y + b.y) / 2}
                    rx={(b.x - a.x) / 2}
                    ry={(b.y - a.y) / 2}
                    fill="rgba(56, 189, 248, 0.18)"
                    stroke="#7dd3fc"
                    strokeDasharray="4 4"
                />
            );
        }
        if (draft.kind === 'line') {
            const a = umToPx(draft.x0, draft.y0);
            const b = umToPx(draft.x1, draft.y1);
            return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#7dd3fc" strokeWidth={2} strokeDasharray="4 4" />;
        }
        return null;
    }, [draft, umToPx]);

    const draftPolySvg = useMemo(() => {
        if (!draftPolygon?.length) return null;
        const pts = draftPolygon.map((p) => umToPx(p.x, p.y));
        return (
            <>
                <polyline
                    points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="rgba(56,189,248,0.12)"
                    stroke="#7dd3fc"
                    strokeWidth={2}
                />
                {pts.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={3} fill="#38bdf8" />
                ))}
            </>
        );
    }, [draftPolygon, umToPx]);

    const draftPolylineSvg = useMemo(() => {
        if (!draftPolyline?.length) return null;
        const pts = draftPolyline.map((p) => umToPx(p.x, p.y));
        return (
            <>
                <polyline
                    points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke="#7dd3fc"
                    strokeWidth={2}
                />
                {pts.map((p, i) => (
                    <circle key={i} cx={p.x} cy={p.y} r={3} fill="#38bdf8" />
                ))}
            </>
        );
    }, [draftPolyline, umToPx]);

    const draftArcSvg = useMemo(() => {
        if (!draftArc3?.length) return null;
        return draftArc3.map((p, i) => {
            const q = umToPx(p.x, p.y);
            return <circle key={i} cx={q.x} cy={q.y} r={4} fill="#fb923c" />;
        });
    }, [draftArc3, umToPx]);

    const probeSvg = useMemo(() => {
        const px = ((probeIJ.i + 0.5) / Nx) * canvasPx.w;
        const py = ((probeIJ.j + 0.5) / Ny) * canvasPx.h;
        return (
            <g>
                <circle cx={px} cy={py} r={8} fill="rgba(15,23,42,0.7)" stroke="#38bdf8" strokeWidth={2.4} />
                <circle cx={px} cy={py} r={2} fill="#38bdf8" />
            </g>
        );
    }, [probeIJ, Nx, Ny, canvasPx.w, canvasPx.h]);

    const measureSvg = useMemo(() => {
        if (!measureA) return null;
        const a = umToPx(measureA.x, measureA.y);
        const b = measureB ? umToPx(measureB.x, measureB.y) : null;
        return (
            <g pointerEvents="none">
                <circle cx={a.x} cy={a.y} r={4} fill="#fbbf24" />
                {b && (
                    <>
                        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#fbbf24" strokeDasharray="4 3" strokeWidth={1.5} />
                        <circle cx={b.x} cy={b.y} r={4} fill="#fbbf24" />
                        <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} fill="#fbbf24" fontSize={11} textAnchor="middle">
                            {Math.hypot(measureB.x - measureA.x, measureB.y - measureA.y).toFixed(1)} µm
                        </text>
                    </>
                )}
            </g>
        );
    }, [measureA, measureB, umToPx]);

    const marqueeSvg = useMemo(() => {
        if (!marqueeBox) return null;
        const a = umToPx(Math.min(marqueeBox.x0, marqueeBox.x1), Math.min(marqueeBox.y0, marqueeBox.y1));
        const b = umToPx(Math.max(marqueeBox.x0, marqueeBox.x1), Math.max(marqueeBox.y0, marqueeBox.y1));
        return (
            <rect
                x={a.x}
                y={a.y}
                width={b.x - a.x}
                height={b.y - a.y}
                fill="rgba(56, 189, 248, 0.08)"
                stroke="#38bdf8"
                strokeDasharray="3 3"
            />
        );
    }, [marqueeBox, umToPx]);

    /* ───────── landing screen ───────── */
    if (showLanding) {
        return (
            <div className="ts-page ts-landing-mode">
                <div className="ts-landing">
                    <div className="ts-landing-card">
                        <div className="ts-landing-head">
                            <Thermometer size={26} aria-hidden />
                            <div>
                                <div className="ts-landing-title">Thermal Studio</div>
                                <div className="ts-landing-sub">
                                    2D MEMS heat-equation solver · vector CAD · electrothermal coupling
                                </div>
                            </div>
                        </div>

                        <div className="ts-landing-grid">
                            <button
                                className="ts-landing-tile ts-landing-tile--primary"
                                onClick={() => {
                                    const name = window.prompt('New design name:', 'untitled');
                                    if (name === null) return;
                                    handleNewProject({ templateId: 'blank', name: name.trim() || 'untitled' });
                                }}
                            >
                                <FilePlus size={20} aria-hidden />
                                <div className="ts-landing-tile-title">Start fresh</div>
                                <div className="ts-landing-tile-sub">
                                    Empty Si block — draw your own geometry
                                </div>
                            </button>
                            {THERMAL_CAD_TEMPLATES.filter((t) => t.id !== 'blank').map((tpl) => (
                                <button
                                    key={tpl.id}
                                    className="ts-landing-tile"
                                    onClick={() => {
                                        const name = window.prompt('New design name:', tpl.label);
                                        if (name === null) return;
                                        handleNewProject({ templateId: tpl.id, name: name.trim() || tpl.label });
                                    }}
                                >
                                    <Shapes size={20} aria-hidden />
                                    <div className="ts-landing-tile-title">{tpl.label}</div>
                                    <div className="ts-landing-tile-sub">{tpl.description}</div>
                                </button>
                            ))}
                            <button
                                className="ts-landing-tile"
                                onClick={() => projectFileInputRef.current?.click()}
                            >
                                <FolderOpen size={20} aria-hidden />
                                <div className="ts-landing-tile-title">Open from disk</div>
                                <div className="ts-landing-tile-sub">
                                    Load a {THERMAL_STUDIO_FILE_SUFFIX} you've saved or downloaded
                                </div>
                            </button>
                        </div>

                        <input
                            type="file"
                            accept=".thermal.json,.json"
                            ref={projectFileInputRef}
                            style={{ display: 'none' }}
                            onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleOpenLocalFile(f);
                                e.target.value = '';
                            }}
                        />

                        {thermalProjectsInWorkspace.length > 0 && (
                            <div className="ts-landing-list">
                                <div className="ts-landing-list-title">
                                    Recent in workspace · {THERMAL_STUDIO_WORKSPACE_FOLDER_NAME}
                                </div>
                                <ul>
                                    {thermalProjectsInWorkspace.slice(0, 8).map((f) => (
                                        <li key={f.id}>
                                            <button
                                                className="ts-toolbtn"
                                                onClick={() => handleOpenWorkspaceProject(f)}
                                                title={`Open ${f.name}`}
                                            >
                                                <FolderOpen size={12} aria-hidden /> {f.name}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        <div className="ts-landing-tip">
                            Pick <strong>Thermal</strong> mode for pure heat-conduction simulations
                            (define heat sources or fixed-T regions on shapes, watch them spread).
                            Pick <strong>Electrothermal</strong> mode to drive a coil with V or I and
                            see Joule heating with R(T) feedback. You can switch any time from the
                            <em> Sim</em> toolbar.
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    /* ───────── render ───────── */
    return (
        <div className="ts-page">
            {/* TOP TOOLBAR */}
            <div className="ts-toolbar">
                <div className="ts-tg">
                    <div className="ts-tg-label">App</div>
                    <div className="ts-tg-body">
                        <span className="ts-mode-pill">
                            <Thermometer size={14} aria-hidden /> Thermal Studio
                        </span>
                        {projectName && !showLanding && (
                            <span className="ts-project-name" title={projectFileName ? `${THERMAL_STUDIO_WORKSPACE_FOLDER_NAME}/${projectFileName}` : 'unsaved (use Save As to write to workspace)'}>
                                {projectName}{isDirty ? ' *' : ''}
                            </span>
                        )}
                    </div>
                </div>
                <div className="ts-sep" />
                <div className="ts-tg">
                    <div className="ts-tg-label">Project</div>
                    <div className="ts-tg-body">
                        <input
                            type="file"
                            accept=".thermal.json,.json"
                            ref={projectFileInputRef}
                            style={{ display: 'none' }}
                            onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleOpenLocalFile(f);
                                e.target.value = '';
                            }}
                        />
                        <button
                            className="ts-toolbtn"
                            onClick={() => {
                                if (isDirty && !window.confirm('Discard unsaved changes and start a new design?')) return;
                                setShowLanding(true);
                            }}
                            title="Show landing screen — start fresh, load template, or open from workspace"
                        >
                            <FilePlus size={14} /> New
                        </button>
                        <button
                            className={`ts-toolbtn${isDirty ? ' ts-toolbtn--primary' : ''}`}
                            onClick={handleSaveProject}
                            disabled={!onSaveJson || showLanding}
                            title={projectFileName ? `Save changes to ${projectFileName}` : 'Save to workspace → Thermal Studio folder'}
                        >
                            <Save size={14} /> Save{isDirty ? ' *' : ''}
                        </button>
                        <button
                            className="ts-toolbtn"
                            onClick={handleSaveAsProject}
                            disabled={!onSaveJson || showLanding}
                            title="Save under a new name"
                        >
                            Save As
                        </button>
                        <button
                            className="ts-toolbtn"
                            onClick={() => projectFileInputRef.current?.click()}
                            title="Open a .thermal.json file from disk"
                        >
                            <FolderOpen size={14} /> Open
                        </button>
                    </div>
                </div>
                <div className="ts-sep" />
                <div className="ts-tg">
                    <div className="ts-tg-label">Edit</div>
                    <div className="ts-tg-body">
                        <input
                            type="file"
                            accept=".svg,.dxf"
                            ref={fileInputRef}
                            style={{ display: 'none' }}
                            onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleImportFile(f);
                                e.target.value = '';
                            }}
                        />
                        <button
                            className="ts-toolbtn"
                            onClick={() => fileInputRef.current?.click()}
                            title="Import SVG / DXF (mm coords scaled to µm)"
                        >
                            <Upload size={14} /> Import CAD
                        </button>
                        <button className="ts-toolbtn" onClick={undo} title="Undo (Cmd/Ctrl+Z)">
                            <Undo2 size={14} /> Undo
                        </button>
                        <button className="ts-toolbtn" onClick={redo} title="Redo (Cmd/Ctrl+Shift+Z)">
                            <Redo2 size={14} /> Redo
                        </button>
                    </div>
                </div>
                <div className="ts-sep" />
                <div className="ts-tg">
                    <div className="ts-tg-label">Sim</div>
                    <div className="ts-tg-body">
                        <button
                            className={`ts-toolbtn${simulationMode === 'thermal' ? ' is-active' : ''}`}
                            onClick={() => setSimulationMode('thermal')}
                            title="Pure thermal: heat sources + fixed-T regions; no electrical drive."
                        >
                            <Thermometer size={13} /> Thermal
                        </button>
                        <button
                            className={`ts-toolbtn${simulationMode === 'electrothermal' ? ' is-active' : ''}`}
                            onClick={() => setSimulationMode('electrothermal')}
                            title="Electrothermal: drive a coil with V or I, R(T) feedback, Joule heating."
                        >
                            <Zap size={13} /> Electrothermal
                        </button>
                    </div>
                </div>
                <div className="ts-sep" />
                <div className="ts-tg">
                    <div className="ts-tg-label">Templates</div>
                    <div className="ts-tg-body">
                        {THERMAL_CAD_TEMPLATES.map((t) => (
                            <button
                                key={t.id}
                                className="ts-toolbtn"
                                onClick={() => handleApplyTemplate(t.id)}
                                title={t.description}
                            >
                                {t.label.split(' ')[0]}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="ts-sep" />
                <div className="ts-tg">
                    <div className="ts-tg-label">Run</div>
                    <div className="ts-tg-body">
                        <button className="ts-toolbtn ts-toolbtn--primary" onClick={runSteady} disabled={running} title="Steady-state Gauss-Seidel SOR">
                            <Zap size={14} /> Steady
                        </button>
                        {!running ? (
                            <button className="ts-toolbtn" onClick={startTransient} title="Transient FTCS">
                                <Play size={14} /> Transient
                            </button>
                        ) : (
                            <button className="ts-toolbtn ts-toolbtn--warn" onClick={pause} title="Pause">
                                <Pause size={14} /> Pause
                            </button>
                        )}
                        <button className="ts-toolbtn" onClick={resetField} title="Reset T to ambient">
                            <RotateCcw size={14} /> Reset
                        </button>
                    </div>
                </div>
                <div className="ts-sep" />
                <div className="ts-tg">
                    <div className="ts-tg-label">View</div>
                    <div className="ts-tg-body">
                        <button className={`ts-toolbtn${viewMode === 'materials' ? ' is-active' : ''}`} onClick={() => setViewMode('materials')}>
                            <LayersIcon size={13} /> Materials
                        </button>
                        <button className={`ts-toolbtn${viewMode === 'temperature' ? ' is-active' : ''}`} onClick={() => setViewMode('temperature')} disabled={!Tfield}>
                            <Flame size={13} /> Temp
                        </button>
                        <button className={`ts-toolbtn${showEntities ? ' is-active' : ''}`} onClick={() => setShowEntities((v) => !v)} title="Show / hide vector entity overlay">
                            <Shapes size={13} /> Vectors
                        </button>
                        <select className="ts-select" value={colormap} onChange={(e) => setColormap(e.target.value)}>
                            {COLORMAP_NAMES.map((n) => (
                                <option key={n} value={n}>{n}</option>
                            ))}
                        </select>
                    </div>
                </div>
                <div className="ts-spacer" />
                <div className="ts-tg">
                    <div className="ts-tg-label">Help</div>
                    <div className="ts-tg-body">
                        <span className="ts-help" title={
                            'Vector CAD canvas (µm). Tools: select / rect / circle / ellipse / polygon / polyline / line / arc / brush / probe / measure.\n' +
                            'Edit ops: union (∪), subtract (−), intersect (∩), xor (⊕), offset, fillet, mirror H/V, rotate, translate, scale.\n' +
                            'Entities are rasterised on every change → solver gets material grid + heater mask.\n\n' +
                            'Hotkeys: Cmd/Ctrl+Z undo · Shift+Cmd/Ctrl+Z redo · Esc cancel · Enter finish polygon/polyline · Del remove selection.\n' +
                            'Shift-click to multi-select; pick order matters for Subtract & XOR.'
                        }>
                            <HelpCircle size={14} />
                        </span>
                    </div>
                </div>
            </div>

            {/* MAIN GRID */}
            <div className="ts-main">
                {/* LEFT PALETTE */}
                <aside className="ts-palette">
                    <div className="ts-pal-section">
                        <div className="ts-pal-title">Tools</div>
                        <div className="ts-tool-row ts-tool-row--three">
                            <ToolButton icon={<MousePointer2 size={14} />} label="Select" active={activeTool === TOOLS.SELECT} onClick={() => setActiveTool(TOOLS.SELECT)} />
                            <ToolButton icon={<Square size={14} />} label="Rect" active={activeTool === TOOLS.RECT} onClick={() => setActiveTool(TOOLS.RECT)} />
                            <ToolButton icon={<CircleIcon size={14} />} label="Circle" active={activeTool === TOOLS.CIRCLE} onClick={() => setActiveTool(TOOLS.CIRCLE)} />
                            <ToolButton icon={<CircleIcon size={14} />} label="Ellipse" active={activeTool === TOOLS.ELLIPSE} onClick={() => setActiveTool(TOOLS.ELLIPSE)} />
                            <ToolButton icon={<Hexagon size={14} />} label="Polygon" active={activeTool === TOOLS.POLYGON} onClick={() => setActiveTool(TOOLS.POLYGON)} />
                            <ToolButton icon={<PenLine size={14} />} label="Polyline" active={activeTool === TOOLS.POLYLINE} onClick={() => setActiveTool(TOOLS.POLYLINE)} />
                            <ToolButton icon={<LineIcon size={14} />} label="Line" active={activeTool === TOOLS.LINE} onClick={() => setActiveTool(TOOLS.LINE)} />
                            <ToolButton icon={<Spline size={14} />} label="Arc" active={activeTool === TOOLS.ARC} onClick={() => setActiveTool(TOOLS.ARC)} />
                            <ToolButton icon={<Brush size={14} />} label="Brush" active={activeTool === TOOLS.BRUSH} onClick={() => setActiveTool(TOOLS.BRUSH)} />
                            <ToolButton icon={<Crosshair size={14} />} label="Probe" active={activeTool === TOOLS.PROBE} onClick={() => setActiveTool(TOOLS.PROBE)} />
                            <ToolButton icon={<MoveHorizontal size={14} />} label="Measure" active={activeTool === TOOLS.MEASURE} onClick={() => setActiveTool(TOOLS.MEASURE)} />
                            <ToolButton icon={<Eraser size={14} />} label="Delete" active={false} onClick={() => {
                                if (selection.size === 0) {
                                    setStatusLine('Select something to delete');
                                    return;
                                }
                                commitEntities(entities.filter((e) => !selection.has(e.id)));
                                setSelection(new Set());
                                pickOrderRef.current = [];
                            }} />
                        </div>
                        <label className="ts-row">
                            <span><Magnet size={11} /> Snap</span>
                            <input type="checkbox" checked={snapEnabled} onChange={(e) => setSnapEnabled(e.target.checked)} />
                            <input
                                type="number"
                                step={1}
                                min={0}
                                value={snapStepUm}
                                onChange={(e) => setSnapStepUm(Math.max(0, Number(e.target.value) || 0))}
                                disabled={!snapEnabled}
                            />
                        </label>
                        <label className="ts-row">
                            <span>Trace w</span>
                            <input
                                type="number"
                                step={1}
                                min={1}
                                value={openStrokeUm}
                                onChange={(e) => setOpenStrokeUm(Math.max(1, Number(e.target.value) || 1))}
                            />
                            <span className="ts-num">µm</span>
                        </label>
                    </div>

                    <div className="ts-pal-section">
                        <div className="ts-pal-title">Edit (selection)</div>
                        <div className="ts-tool-row ts-tool-row--two">
                            <ToolButton icon={<Combine size={13} />} label="∪ Union" active={false} onClick={() => doBoolean('union')} />
                            <ToolButton icon={<SubtractIcon size={13} />} label="− Subtract" active={false} onClick={() => doBoolean('subtract')} />
                            <ToolButton icon={<SquareAsterisk size={13} />} label="∩ Intersect" active={false} onClick={() => doBoolean('intersect')} />
                            <ToolButton icon={<Shuffle size={13} />} label="⊕ XOR" active={false} onClick={() => doBoolean('xor')} />
                        </div>
                        <label className="ts-row">
                            <span>Offset</span>
                            <input
                                type="number"
                                step={1}
                                value={offsetUm}
                                onChange={(e) => setOffsetUm(Number(e.target.value) || 0)}
                            />
                            <span className="ts-num">µm</span>
                        </label>
                        <div className="ts-tool-row ts-tool-row--two">
                            <ToolButton icon={<>+</>} label="Grow" active={false} onClick={() => doOffset(+1)} />
                            <ToolButton icon={<>−</>} label="Shrink" active={false} onClick={() => doOffset(-1)} />
                        </div>
                        <label className="ts-row">
                            <span>Fillet r</span>
                            <input
                                type="number"
                                step={1}
                                value={filletRadiusUm}
                                onChange={(e) => setFilletRadiusUm(Number(e.target.value) || 0)}
                            />
                            <span className="ts-num">µm</span>
                        </label>
                        <ToolButton icon={<Spline size={13} />} label="Fillet vertices" active={false} onClick={doFilletAllVertices} />
                        <div className="ts-tool-row ts-tool-row--two">
                            <ToolButton icon={<FlipHorizontal size={13} />} label="Mirror H" active={false} onClick={() => doMirror('h')} />
                            <ToolButton icon={<FlipHorizontal size={13} style={{ transform: 'rotate(90deg)' }} />} label="Mirror V" active={false} onClick={() => doMirror('v')} />
                        </div>
                        <div className="ts-tool-row ts-tool-row--two">
                            <ToolButton icon={<RotateCw size={13} />} label="Rot 90°" active={false} onClick={() => doRotate(90)} />
                            <ToolButton icon={<RotateCw size={13} style={{ transform: 'scaleX(-1)' }} />} label="Rot −90°" active={false} onClick={() => doRotate(-90)} />
                        </div>
                        <label className="ts-row">
                            <span>Δx, Δy</span>
                            <input
                                type="number"
                                value={translateUm.dx}
                                onChange={(e) => setTranslateUm((p) => ({ ...p, dx: Number(e.target.value) || 0 }))}
                            />
                            <input
                                type="number"
                                value={translateUm.dy}
                                onChange={(e) => setTranslateUm((p) => ({ ...p, dy: Number(e.target.value) || 0 }))}
                            />
                        </label>
                        <ToolButton icon={<MoveHorizontal size={13} />} label="Translate" active={false} onClick={doTranslate} />
                        <label className="ts-row">
                            <span>Scale</span>
                            <input
                                type="number"
                                step={0.05}
                                value={scaleFactor}
                                onChange={(e) => setScaleFactor(Number(e.target.value) || 1)}
                            />
                        </label>
                        <ToolButton icon={<Shapes size={13} />} label="Apply scale" active={false} onClick={doScale} />
                        <ToolButton icon={<Trash2 size={13} />} label="Delete sel" active={false} onClick={() => {
                            if (!selection.size) return;
                            commitEntities(entities.filter((e) => !selection.has(e.id)));
                            setSelection(new Set());
                            pickOrderRef.current = [];
                        }} />
                    </div>

                    <div className="ts-pal-section">
                        <div className="ts-pal-title">Material palette</div>
                        <label className="ts-row ts-row--inline">
                            <input
                                type="checkbox"
                                checked={activeIsHeater}
                                onChange={(e) => setActiveIsHeater(e.target.checked)}
                            />
                            <span>flag as heater</span>
                        </label>
                        {selection.size > 0 && (
                            <div className="ts-tool-row ts-tool-row--two">
                                <ToolButton
                                    icon={<Flame size={12} />}
                                    label="Sel → heater"
                                    active={false}
                                    onClick={toggleHeaterFlag}
                                />
                                <ToolButton
                                    icon={<Brush size={12} />}
                                    label="Sel → mat"
                                    active={false}
                                    onClick={() => setSelectionMaterial(activeMatId)}
                                />
                            </div>
                        )}
                        <div className="ts-mat-grid">
                            {THERMAL_MATERIAL_IDS.map((mid) => {
                                const m = THERMAL_MATERIALS[mid];
                                const sel = activeMatId === mid;
                                return (
                                    <button
                                        key={mid}
                                        className={`ts-mat${sel ? ' is-active' : ''}`}
                                        onClick={() => setActiveMatId(mid)}
                                        title={`${m.name}\n  k = ${m.kWmK} W/(m·K)\n  ρ = ${m.rhoKgM3} kg/m³\n  c = ${m.cJkgK} J/(kg·K)`}
                                    >
                                        <span className="ts-mat-swatch" style={{ background: m.color }} />
                                        <span className="ts-mat-name">{m.name}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="ts-pal-section">
                        <div className="ts-pal-title">Geometry / physics</div>
                        <label className="ts-row">
                            <span>Domain</span>
                            <input
                                type="number"
                                min={50}
                                max={50000}
                                step={50}
                                value={domainUm}
                                onChange={(e) => setDomainUm(Math.max(50, Number(e.target.value) || 0))}
                            />
                            <span className="ts-num">µm</span>
                        </label>
                        <label className="ts-row">
                            <span>Cells</span>
                            <input
                                type="number"
                                min={16}
                                max={250}
                                step={4}
                                value={Nx}
                                onChange={(e) => {
                                    const n = Math.max(16, Math.min(250, parseInt(e.target.value || '0', 10)));
                                    setNx(n);
                                    setNy(n);
                                }}
                            />
                            <span className="ts-num">N</span>
                        </label>
                        <div className="ts-hint">dx ≈ {(domainUm / Nx).toFixed(2)} µm/cell</div>
                        <label className="ts-row">
                            <span>P heater</span>
                            <input
                                type="number"
                                min={0}
                                step={1}
                                value={heaterPowerMW}
                                onChange={(e) => setHeaterPowerMW(Math.max(0, Number(e.target.value) || 0))}
                            />
                            <span className="ts-num">mW</span>
                        </label>
                        <label className="ts-row">
                            <span>Thickness</span>
                            <input
                                type="number"
                                min={0.05}
                                step={0.1}
                                value={thicknessUm}
                                onChange={(e) => setThicknessUm(Math.max(0.05, Number(e.target.value) || 0))}
                            />
                            <span className="ts-num">µm</span>
                        </label>
                        <label className="ts-row">
                            <span>T<sub>amb</sub></span>
                            <input type="number" step={1} value={ambientC} onChange={(e) => setAmbientC(Number(e.target.value) || 0)} />
                            <span className="ts-num">°C</span>
                        </label>
                        <label className="ts-row">
                            <span>h<sub>top</sub></span>
                            <input type="number" min={0} step={1} value={hTop} onChange={(e) => setHTop(Math.max(0, Number(e.target.value) || 0))} />
                            <span className="ts-num">W/m²K</span>
                        </label>
                        <label className="ts-row">
                            <span>h<sub>bot</sub></span>
                            <input type="number" min={0} step={1} value={hBot} onChange={(e) => setHBot(Math.max(0, Number(e.target.value) || 0))} />
                            <span className="ts-num">W/m²K</span>
                        </label>
                    </div>
                </aside>

                {/* CENTER CANVAS */}
                <div className="ts-canvas-col">
                    <div className="ts-canvas-wrap" ref={containerRef}>
                        <div className="ts-canvas-stack" style={{ width: canvasPx.w, height: canvasPx.h }}>
                            <canvas ref={canvasRef} className="ts-canvas-base" style={{ imageRendering: 'pixelated' }} />
                            <svg
                                ref={overlayRef}
                                className="ts-canvas-overlay"
                                width={canvasPx.w}
                                height={canvasPx.h}
                                onPointerDown={handlePointerDown}
                                onPointerMove={handlePointerMove}
                                onPointerUp={handlePointerUp}
                                onPointerCancel={handlePointerUp}
                                style={{ touchAction: 'none' }}
                            >
                                {showEntities && entities.map(renderEntitySvg)}
                                {draftSvg}
                                {draftPolySvg}
                                {draftPolylineSvg}
                                {draftArcSvg}
                                {marqueeSvg}
                                {measureSvg}
                                {probeSvg}
                            </svg>
                            {running && (
                                <div className="ts-live-badge" title="Solver is running — values update in real time">
                                    <span className="ts-live-dot" /> LIVE
                                    <span className="ts-live-meta">
                                        t = {(simT * 1000).toFixed(1)} ms · T<sub>max</sub> ={' '}
                                        {dieMaxC !== null ? `${dieMaxC.toFixed(1)} °C` : '—'}
                                    </span>
                                </div>
                            )}
                            {Tfield && viewMode !== 'temperature' && (
                                <button
                                    className="ts-view-hint"
                                    onClick={() => setViewMode('temperature')}
                                    title="Show the live temperature heatmap"
                                >
                                    <Flame size={12} aria-hidden /> Show temperature heatmap
                                </button>
                            )}
                        </div>
                    </div>
                    <div className="ts-canvas-legend">
                        {viewMode === 'temperature' && (
                            <div className="ts-cmap-legend">
                                <div className="ts-cmap-strip" style={{ background: cmapStripCss(colormap) }} />
                                <div className="ts-cmap-ticks">
                                    <span>{KtoC(tempRange.minK).toFixed(0)} °C</span>
                                    <span>{KtoC((tempRange.minK + tempRange.maxK) / 2).toFixed(0)} °C</span>
                                    <span>{KtoC(tempRange.maxK).toFixed(0)} °C</span>
                                </div>
                                <div className="ts-cmap-mode">
                                    <button className={`ts-toolbtn ts-toolbtn--xs${tempRangeMode === 'auto' ? ' is-active' : ''}`} onClick={() => setTempRangeMode('auto')}>auto</button>
                                    <button className={`ts-toolbtn ts-toolbtn--xs${tempRangeMode === 'manual' ? ' is-active' : ''}`} onClick={() => setTempRangeMode('manual')}>manual</button>
                                    {tempRangeMode === 'manual' && (
                                        <>
                                            <input type="number" value={manualMinC} onChange={(e) => setManualMinC(Number(e.target.value) || 0)} />
                                            <input type="number" value={manualMaxC} onChange={(e) => setManualMaxC(Number(e.target.value) || 0)} />
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* RIGHT RESULTS */}
                <aside className="ts-results">
                    <div className="ts-pal-section">
                        <div className="ts-pal-title">Status</div>
                        <div className="ts-stat-row"><span>Solver</span><strong>{running ? 'running…' : 'idle'}</strong></div>
                        <div className="ts-stat-row"><span>t</span><strong>{(simT * 1000).toFixed(2)} ms</strong></div>
                        <div className="ts-stat-row"><span>T<sub>max</sub></span><strong>{dieMaxC !== null ? `${dieMaxC.toFixed(1)} °C` : '—'}</strong></div>
                        <div className="ts-stat-row"><span>T<sub>mean</sub></span><strong>{dieMeanC !== null ? `${dieMeanC.toFixed(1)} °C` : '—'}</strong></div>
                        <div className="ts-stat-row"><span>Heater</span><strong>{heaterCells} cells · {heaterAreaUm2} µm²</strong></div>
                        <div className="ts-stat-row"><span>Entities</span><strong>{entities.length} · sel {selection.size}</strong></div>
                        {steadyResult && (
                            <div className="ts-stat-row ts-stat-row--accent">
                                <span>Steady</span>
                                <strong>{steadyResult.iters} it · {steadyResult.converged ? 'conv' : 'NOT'}</strong>
                            </div>
                        )}
                    </div>

                    {simulationMode === 'electrothermal' && (
                    <div className="ts-pal-section">
                        <div className="ts-pal-title">
                            <Zap size={13} aria-hidden /> Electrical drive
                        </div>
                        <div className="ts-drive-modes">
                            {[
                                { id: 'V', label: 'Voltage [V]', hint: 'Drive coil at fixed V; I = V/R(T)' },
                                { id: 'I', label: 'Current [mA]', hint: 'Drive coil at fixed I; V = I·R(T)' },
                                { id: 'P', label: 'Power [mW]', hint: 'Constant power; no electrothermal feedback' },
                            ].map((m) => (
                                <button
                                    key={m.id}
                                    type="button"
                                    className={`ts-toolbtn ts-toolbtn--xs${driveMode === m.id ? ' is-active' : ''}`}
                                    onClick={() => setDriveMode(m.id)}
                                    title={m.hint}
                                >
                                    {m.label}
                                </button>
                            ))}
                        </div>
                        <label className="ts-row">
                            <span>{driveMode === 'V' ? 'V' : driveMode === 'I' ? 'I' : 'P'}</span>
                            <input
                                type="number"
                                step={driveMode === 'V' ? 0.1 : driveMode === 'I' ? 0.5 : 1}
                                min={0}
                                value={driveValue}
                                onChange={(e) => setDriveValue(Math.max(0, Number(e.target.value) || 0))}
                            />
                            <span className="ts-num">{driveMode === 'V' ? 'V' : driveMode === 'I' ? 'mA' : 'mW'}</span>
                        </label>
                        <label className="ts-row">
                            <span>Trace w</span>
                            <input
                                type="number"
                                min={1}
                                step={1}
                                value={driveTraceWidthUm}
                                onChange={(e) => setDriveTraceWidthUm(Math.max(1, Number(e.target.value) || 1))}
                                title="Coil trace width — used for auto R0 estimate (rectangular cross section: w × thickness)"
                            />
                            <span className="ts-num">µm</span>
                        </label>
                        <label className="ts-row">
                            <span>R₀</span>
                            <input
                                type="number"
                                step={0.1}
                                value={driveR0Override ?? (autoR0Ohm ? autoR0Ohm.toFixed(2) : '')}
                                placeholder={autoR0Ohm ? `auto: ${autoR0Ohm.toFixed(2)}` : 'no heater'}
                                onChange={(e) => {
                                    const v = e.target.value.trim();
                                    if (v === '') setDriveR0Override(null);
                                    else setDriveR0Override(Number(v));
                                }}
                                title="Resistance at T_ref. Leave blank to auto-compute from heater geometry × material ρₑ."
                            />
                            <span className="ts-num">Ω</span>
                        </label>
                        <label className="ts-row">
                            <span>α (TCR)</span>
                            <input
                                type="number"
                                step={0.0005}
                                value={driveTcrOverride ?? (autoTCR ? autoTCR.toFixed(5) : '')}
                                placeholder={autoTCR ? `auto: ${autoTCR.toExponential(2)}` : '0'}
                                onChange={(e) => {
                                    const v = e.target.value.trim();
                                    if (v === '') setDriveTcrOverride(null);
                                    else setDriveTcrOverride(Number(v));
                                }}
                                title="Temperature coefficient of resistance. R(T) = R₀·(1 + α·(T − T_ref))"
                            />
                            <span className="ts-num">/K</span>
                        </label>
                        <label className="ts-row">
                            <span>T<sub>ref</sub></span>
                            <input
                                type="number"
                                value={driveRefC}
                                onChange={(e) => setDriveRefC(Number(e.target.value) || 0)}
                            />
                            <span className="ts-num">°C</span>
                        </label>
                        <label className="ts-row">
                            <span>P<sub>max</sub></span>
                            <input
                                type="number"
                                min={0}
                                step={1}
                                value={driveMaxPowerMW ?? ''}
                                placeholder="—"
                                onChange={(e) => {
                                    const v = e.target.value.trim();
                                    setDriveMaxPowerMW(v === '' ? null : Math.max(0, Number(v) || 0));
                                }}
                                title="Optional compliance / safety clamp on dissipated power. Leave blank for none."
                            />
                            <span className="ts-num">mW</span>
                        </label>
                        <div className="ts-hint">
                            heater length {totalHeaterLengthUm.toFixed(0)} µm · {heaterEntities.length}{' '}
                            entit{heaterEntities.length === 1 ? 'y' : 'ies'}
                        </div>
                        {driveReadout && (
                            <div className="ts-drive-readout">
                                <div className="ts-stat-row"><span>R(T)</span><strong>{driveReadout.R.toFixed(2)} Ω</strong></div>
                                <div className="ts-stat-row"><span>V</span><strong>{driveReadout.V.toFixed(3)} V</strong></div>
                                <div className="ts-stat-row"><span>I</span><strong>{(driveReadout.I * 1000).toFixed(2)} mA</strong></div>
                                <div className="ts-stat-row ts-stat-row--accent"><span>P</span><strong>{(driveReadout.P * 1000).toFixed(2)} mW</strong></div>
                                <div className="ts-stat-row"><span>T<sub>avg</sub> coil</span><strong>{KtoC(driveReadout.Tavg).toFixed(1)} °C</strong></div>
                            </div>
                        )}
                    </div>
                    )}

                    {/* Boundary-condition inspector for selected entity (or first selected). */}
                    {selectedEntities.length > 0 && (
                        <div className="ts-pal-section">
                            <div className="ts-pal-title">
                                <Settings2 size={13} aria-hidden /> Boundary conditions
                            </div>
                            <BcInspector
                                entities={entities}
                                selection={selection}
                                commitEntities={commitEntities}
                                ambientC={ambientC}
                                setStatusLine={setStatusLine}
                            />
                        </div>
                    )}

                    <div className="ts-pal-section">
                        <div className="ts-pal-title">
                            <Activity size={13} aria-hidden /> Probe T(t)
                        </div>
                        <div className="ts-stat-row">
                            <span>Cell</span>
                            <strong>({probeIJ.i}, {probeIJ.j})</strong>
                        </div>
                        <div className="ts-chart-wrap">
                            <ResponsiveContainer width="100%" height={170}>
                                <LineChart data={chartData} margin={{ left: 10, right: 12, top: 10, bottom: 22 }}>
                                    <CartesianGrid stroke="rgba(255,255,255,0.07)" />
                                    <XAxis dataKey="tMs" type="number" domain={['dataMin', 'dataMax']} tick={{ fill: '#94a3b8', fontSize: 10 }} label={{ value: 't (ms)', fill: '#94a3b8', fontSize: 10, position: 'insideBottom', offset: -2 }} />
                                    <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} label={{ value: 'T (°C)', angle: -90, fill: '#94a3b8', fontSize: 10, position: 'insideLeft' }} />
                                    <RechartsTooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0' }} />
                                    <ReferenceLine y={ambientC} stroke="#475569" strokeDasharray="3 3" label={{ position: 'right', value: 'amb', fill: '#64748b', fontSize: 10 }} />
                                    <Line type="monotone" dataKey="Tc" stroke="#fb923c" strokeWidth={2} dot={false} isAnimationActive={false} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {chartData.some((d) => d.Pmw != null) && (
                        <div className="ts-pal-section">
                            <div className="ts-pal-title">
                                <Zap size={13} aria-hidden /> Joule power P(t)
                            </div>
                            <div className="ts-chart-wrap">
                                <ResponsiveContainer width="100%" height={150}>
                                    <LineChart data={chartData} margin={{ left: 10, right: 12, top: 10, bottom: 22 }}>
                                        <CartesianGrid stroke="rgba(255,255,255,0.07)" />
                                        <XAxis dataKey="tMs" type="number" domain={['dataMin', 'dataMax']} tick={{ fill: '#94a3b8', fontSize: 10 }} label={{ value: 't (ms)', fill: '#94a3b8', fontSize: 10, position: 'insideBottom', offset: -2 }} />
                                        <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} label={{ value: 'P (mW)', angle: -90, fill: '#94a3b8', fontSize: 10, position: 'insideLeft' }} />
                                        <RechartsTooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0' }} />
                                        <Line type="monotone" dataKey="Pmw" stroke="#f87171" strokeWidth={2} dot={false} isAnimationActive={false} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    )}

                    <div className="ts-pal-section">
                        <div className="ts-pal-title">Selection</div>
                        {selectedEntities.length === 0 ? (
                            <div className="ts-hint">(none)</div>
                        ) : (
                            <ul className="ts-tips">
                                {selectedEntities.slice(0, 6).map((e) => {
                                    const m = THERMAL_MATERIALS[e.materialId] || THERMAL_MATERIALS.air;
                                    return (
                                        <li key={e.id}>
                                            <span style={{ color: m.color }}>●</span> {m.name}
                                            {e.thermalRole ? ` · ${e.thermalRole}` : ''}
                                            {e.isHeater ? ' · heater' : ''} · {e.points.length} pts
                                        </li>
                                    );
                                })}
                                {selectedEntities.length > 6 && <li>… and {selectedEntities.length - 6} more</li>}
                            </ul>
                        )}
                    </div>
                </aside>
            </div>

            <div className="ts-statusbar">
                <span className="ts-status-text">{statusLine}</span>
                {solverError && <span className="ts-status-err">⚠ {solverError}</span>}
            </div>
        </div>
    );
}

/** Tool button with icon + label. */
function ToolButton({ icon, label, active, onClick, title }) {
    return (
        <button
            className={`ts-tool${active ? ' is-active' : ''}`}
            onClick={onClick}
            title={title || label}
            type="button"
        >
            {icon}
            <span>{label}</span>
        </button>
    );
}

/**
 * Per-entity boundary-condition editor.
 *
 *   role 'none'        → no extra BC (entity is just a material region)
 *   role 'source'      → injects total Q [mW] uniformly over its cells
 *   role 'dirichlet'   → cells are pinned at fixedTC °C (Dirichlet)
 *   initialTC          → optional initial-condition override (applied at t=0 / Reset)
 *
 * Editing rules: when one entity is selected we expose all controls; when many
 * are selected we apply the same role/values to all of them on each change.
 */
function BcInspector({ entities, selection, commitEntities, ambientC, setStatusLine }) {
    const selIds = useMemo(() => new Set(selection), [selection]);
    const selEnts = useMemo(() => entities.filter((e) => selIds.has(e.id)), [entities, selIds]);

    /* Use the first selected entity's BC as the displayed values (if all match). */
    const firstBc = selEnts[0]?.bc || {};
    const role = firstBc.role || 'none';
    const sourceMW = Number.isFinite(firstBc.sourceMW) ? firstBc.sourceMW : 5;
    const fixedTC = Number.isFinite(firstBc.fixedTC) ? firstBc.fixedTC : 100;
    const initialTC = Number.isFinite(firstBc.initialTC) ? firstBc.initialTC : null;

    const updateSelection = (mut) => {
        const next = entities.map((e) => {
            if (!selIds.has(e.id)) return e;
            const oldBc = e.bc || {};
            const newBc = { ...oldBc, ...mut };
            /* Drop empty BC (role=none + no initial override) so saves stay tidy. */
            const empty = newBc.role === 'none' && !Number.isFinite(newBc.initialTC);
            return empty ? { ...e, bc: undefined } : { ...e, bc: newBc };
        });
        commitEntities(next);
    };

    const handleRole = (newRole) => {
        if (newRole === role) return;
        updateSelection({ role: newRole });
        setStatusLine(`BC role: ${newRole} on ${selEnts.length} entit${selEnts.length === 1 ? 'y' : 'ies'}`);
    };

    return (
        <div className="ts-bc-inspector">
            <div className="ts-stat-row">
                <span>Sel</span>
                <strong>
                    {selEnts.length === 1
                        ? selEnts[0].thermalRole || selEnts[0].materialId
                        : `${selEnts.length} entities`}
                </strong>
            </div>
            <div className="ts-tool-row ts-tool-row--three">
                <button className={`ts-tool${role === 'none' ? ' is-active' : ''}`} onClick={() => handleRole('none')} title="No BC; just a material region.">
                    None
                </button>
                <button className={`ts-tool${role === 'source' ? ' is-active' : ''}`} onClick={() => handleRole('source')} title="Inject total power [mW] uniformly across the region (e.g. an embedded heat source).">
                    Source
                </button>
                <button className={`ts-tool${role === 'dirichlet' ? ' is-active' : ''}`} onClick={() => handleRole('dirichlet')} title="Pin cells in this region at a fixed temperature (Dirichlet BC).">
                    Fixed T
                </button>
            </div>
            {role === 'source' && (
                <label className="ts-row">
                    <span>Q</span>
                    <input
                        type="number"
                        min={0}
                        step={1}
                        value={sourceMW}
                        onChange={(e) => updateSelection({ sourceMW: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span className="ts-num">mW</span>
                </label>
            )}
            {role === 'dirichlet' && (
                <label className="ts-row">
                    <span>T<sub>fix</sub></span>
                    <input
                        type="number"
                        step={1}
                        value={fixedTC}
                        onChange={(e) => updateSelection({ fixedTC: Number(e.target.value) || 0 })}
                    />
                    <span className="ts-num">°C</span>
                </label>
            )}
            <label className="ts-row">
                <span>T<sub>init</sub></span>
                <input
                    type="number"
                    step={1}
                    placeholder={`${ambientC} (amb)`}
                    value={initialTC ?? ''}
                    onChange={(e) => {
                        const v = e.target.value.trim();
                        updateSelection({ initialTC: v === '' ? null : Number(v) || 0 });
                    }}
                    title="Optional initial T at this region (applied on Reset / start of transient). Leave blank for ambient."
                />
                <span className="ts-num">°C</span>
            </label>
            <div className="ts-hint">
                Sources spread heat outward over time; Fixed-T regions act as ideal heat sinks/sources.
                Use Initial-T to pre-warm a region before pressing Transient.
            </div>
        </div>
    );
}

function cmapStripCss(name) {
    const lut = COLORMAPS[name] || COLORMAPS.inferno;
    const stops = [];
    for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const idx = Math.min(255, Math.round(t * 255));
        stops.push(`rgb(${lut[3 * idx]}, ${lut[3 * idx + 1]}, ${lut[3 * idx + 2]}) ${(t * 100).toFixed(0)}%`);
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
}
