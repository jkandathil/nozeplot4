import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    ScanLine,
    MousePointer2,
    Square,
    Trash2,
    Plus,
    Layers,
    Eye,
    EyeOff,
    Lock,
    Unlock,
    ChevronUp,
    ChevronDown,
    Grid3x3,
    ZoomIn,
    ZoomOut,
    Maximize2,
    Download,
    Upload,
    Save,
    RotateCcw,
    Pentagon,
    Circle,
    CircleDot,
    Undo2,
    Redo2,
    Minus,
    PenLine,
    MousePointerClick,
    GitMerge,
    Crop,
    Diff,
    Layers2,
    Expand,
    Ruler,
    Magnet,
    FolderOpen,
    HardDriveUpload,
    AlignLeft,
    Archive,
    AlignRight,
    ChevronsLeft,
    ChevronsRight,
    LayoutPanelLeft,
    AlignStartVertical,
    AlignEndVertical,
    AlignCenterHorizontal,
    AlignCenterVertical,
    AlignHorizontalSpaceBetween,
    AlignVerticalSpaceBetween,
    PanelRight,
    Disc,
} from 'lucide-react';
import {
    newMemsMaskDesignDoc,
    migrateMemsMaskDoc,
    bootstrapMemsMaskStudio,
    dieHalfExtentsUm,
    addLayer,
    removeLayer,
    reorderLayers,
    updateLayer,
    setActiveLayer,
    setActiveCell,
    setDisplayUnit,
    addRectangle,
    addPolygon,
    addEllipse,
    addLineReturningId,
    addPath,
    addPolygonSpecs,
    addDerivedLayer,
    addLibraryCell,
    addInstance,
    deleteEntitiesByIds,
    translateSelection,
    pasteEntityCopies,
    replaceEntity,
    findEntity,
    activeLayer,
    layoutLayers,
    allLayersFlat,
    dieWidthUm,
    dieHeightUm,
    projectDisplayUnit,
    projectName,
    setProjectDie,
    setProjectName,
    updateProjectMetadata,
    activeCell,
    setUserOriginUm,
    userOriginUm,
    globalToUserUm,
    viewBoxToFitActiveCellContent,
    expandProjectDieToCoverActiveCellContent,
} from '../mems/memsMaskDoc.js';
import { hitEntity, bboxIntersects } from '../mems/memsGeometry.js';
import {
    buildSnapIndex,
    snapWorldDetail,
    SNAP_TIER_GRID,
    SNAP_TIER_VERTEX,
    SNAP_TIER_FEATURE,
    SNAP_TIER_EDGE,
    SNAP_TIER_INTERSECTION,
    SNAP_TIER_GUIDE,
    constrainDragTarget,
} from '../mems/memsPrecisionSnap.js';
import {
    computeAlignDeltas,
    computeDistributeCenters,
    computeDistributeFixedGap,
    applyEntityMoves,
} from '../mems/memsCadAlign.js';
import { defaultDrcRuleSet, migrateDrcRuleSet } from '../mems/memsDrcSchema.js';
import {
    pickTransformOverlay,
    rotatedEntityFromGesture,
    resizedEntityFromCorner,
    centroidFromBBox,
} from '../mems/memsEditorInteraction.js';
import {
    booleanEntitiesNm,
    multiPolygonNmToPolygonSpecsUm,
    offsetEntitiesCombinedNm,
    openPathToMultiPolygonNm,
    MEMS_PLANAR_BOOLEAN_OPS,
} from '../mems/memsPolygonKernel.js';
import {
    hitEntityResolved,
    resolvedEntityBBox,
    flattenActiveCell,
    expandInstanceToWorldEntities,
    MEMS_INSTANCE_MAX_DEPTH,
    MEMS_GHOST_MAX_ENTITIES,
} from '../mems/memsHierarchy.js';
import { formatLengthUm, unitSuffix } from '../mems/memsUnits.js';
import { createUndoManager } from '../pcb/undoManager.js';
import MemsMaskInspector from './MemsMaskInspector.jsx';
import MemsDrcPanel from './MemsDrcPanel.jsx';
import WaferLayoutWizardModal from './WaferLayoutWizardModal.jsx';
import { importGdsToMemsDoc } from '../mems/memsGdsImport.js';
import { exportMemsDocToGds } from '../mems/memsGdsExport.js';
import { exportMemsDocToDxf, importDxfToMemsDoc } from '../mems/memsDxfIo.js';
import { validateFabricRoundTrip } from '../mems/memsFabAudit.js';
import {
    MEMS_MASKS_WORKSPACE_FOLDER_NAME,
    isMemsMaskWorkspaceDocJson,
} from '../utils/workspaceFilename.js';
import { buildMemsWorkspaceFileName, downloadMemsMasksFolderJsonZip } from '../utils/memsWorkspaceZip.js';
import {
    closingSegmentCrosses,
    newEdgeCrossesExistingOpen,
    minSegmentLengthUm,
    openPolylineSelfIntersects,
} from '../mems/memsPolygonValidate.js';
import { parseCommittedNumberInput } from '../mems/memsInputParse.js';
import {
    MEMS_HAIRLINE_OUTLINE_UM,
    MEMS_DEFAULT_OUTLINE_UM,
    MEMS_SELECTED_OUTLINE_UM,
    MEMS_DEFAULT_LINE_BAND_UM,
    MEMS_UI_OVERLAY_STROKE_UM,
    MEMS_SNAP_RING_R_MIN_UM,
    segmentToQuadPathD,
    openPolylineToStrokeBandPathD,
} from '../mems/memsWorldSpaceRender.js';
import './MemsMaskStudioPage.css';

const MEMS_HAIRLINE_OUTLINE_KEY = 'memsMaskHairlineOutline';

const MEMS_SAVE_SUBPATH_KEY = 'nozeMemsSaveSubpath';
const MEMS_LAYERS_PANEL_KEY = 'nozeMemsLayersPanelOpen';
const MEMS_INSPECTOR_PANEL_KEY = 'nozeMemsInspectorPanelOpen';

const STORAGE_KEY = 'nozeMemsMaskDoc:v7';
const LEGACY_STORAGE_KEYS = [
    'nozeMemsMaskDoc:v6',
    'nozeMemsMaskDoc:v5',
    'nozeMemsMaskDoc:v3',
    'nozeMemsMaskDoc:v2',
    'nozeMemsMaskDoc:v1',
];

const MEMS_BOOTSTRAP = bootstrapMemsMaskStudio(STORAGE_KEY, LEGACY_STORAGE_KEYS);

function initialGuidesState() {
    const pid = MEMS_BOOTSTRAP.doc.project?.id || 'default';
    let guides = loadGuidesFromStorage(pid);
    if (MEMS_BOOTSTRAP.guidesNeedCornerShift) {
        const dw = dieWidthUm(MEMS_BOOTSTRAP.doc);
        const dh = dieHeightUm(MEMS_BOOTSTRAP.doc);
        guides = {
            v: guides.v.map((x) => x - dw / 2),
            h: guides.h.map((y) => y - dh / 2),
        };
        saveGuidesToStorage(pid, guides);
        MEMS_BOOTSTRAP.guidesNeedCornerShift = false;
    }
    return guides;
}

function clampWorldToDie(wx, wy, doc) {
    const { hx, hy } = dieHalfExtentsUm(doc);
    return {
        x: Math.max(-hx, Math.min(hx, wx)),
        y: Math.max(-hy, Math.min(hy, wy)),
    };
}

function clipDraftRectToDie(r, doc) {
    const { hx, hy } = dieHalfExtentsUm(doc);
    const left = Math.max(-hx, r.x);
    const top = Math.max(-hy, r.y);
    const right = Math.min(hx, r.x + r.width);
    const bottom = Math.min(hy, r.y + r.height);
    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };
}

function isInsideDie(wx, wy, doc) {
    const { hx, hy } = dieHalfExtentsUm(doc);
    return wx >= -hx && wx <= hx && wy >= -hy && wy <= hy;
}

const MEMS_DRC_RULES_KEY = 'nozeMemsDrcRules:v1';

function loadDrcRuleSetFromStorage() {
    try {
        const raw = localStorage.getItem(MEMS_DRC_RULES_KEY);
        if (!raw) return defaultDrcRuleSet();
        return migrateDrcRuleSet(JSON.parse(raw));
    } catch {
        return defaultDrcRuleSet();
    }
}

const GUIDES_STORE_PREFIX = 'nozeMemsGuides:';

function loadGuidesFromStorage(projectId) {
    try {
        const raw = localStorage.getItem(GUIDES_STORE_PREFIX + (projectId || 'default'));
        if (!raw) return { h: [], v: [] };
        const j = JSON.parse(raw);
        return {
            h: Array.isArray(j.h) ? j.h.map(Number).filter(Number.isFinite) : [],
            v: Array.isArray(j.v) ? j.v.map(Number).filter(Number.isFinite) : [],
        };
    } catch {
        return { h: [], v: [] };
    }
}

function saveGuidesToStorage(projectId, guides) {
    try {
        localStorage.setItem(GUIDES_STORE_PREFIX + (projectId || 'default'), JSON.stringify(guides));
    } catch {
        /* quota */
    }
}

function niceStepUm(spanUm, targetTicks = 10) {
    const raw = spanUm / Math.max(4, targetTicks);
    if (!(raw > 0)) return 1;
    const exp = Math.floor(Math.log10(raw));
    const base = 10 ** exp;
    const f = raw / base;
    let nf = 1;
    if (f <= 1) nf = 1;
    else if (f <= 2) nf = 2;
    else if (f <= 5) nf = 5;
    else nf = 10;
    return nf * base;
}

function cloneDoc(d) {
    return JSON.parse(JSON.stringify(d));
}

/**
 * Map viewport (client/screen) pixels to SVG user space (layout µm).
 * Uses {@link SVGSVGElement#getScreenCTM} so `preserveAspectRatio` letterboxing and uniform scale
 * match the actual rendered SVG — linear mapping from getBoundingClientRect() alone is wrong when
 * the viewBox aspect ratio differs from the CSS box (“meet” bars).
 */
function clientToWorld(svgEl, clientX, clientY, vb) {
    if (!svgEl) return { x: vb.x, y: vb.y };
    try {
        const ctm = svgEl.getScreenCTM();
        if (ctm) {
            const inv = ctm.inverse();
            const pt = svgEl.createSVGPoint();
            pt.x = clientX;
            pt.y = clientY;
            const p = pt.matrixTransform(inv);
            return { x: p.x, y: p.y };
        }
    } catch {
        /* fall through */
    }
    const rect = svgEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: vb.x, y: vb.y };
    const rx = (clientX - rect.left) / rect.width;
    const ry = (clientY - rect.top) / rect.height;
    return {
        x: vb.x + rx * vb.w,
        y: vb.y + ry * vb.h,
    };
}

function normalizeRect(ax, ay, bx, by) {
    const x = Math.min(ax, bx);
    const y = Math.min(ay, by);
    const width = Math.abs(bx - ax);
    const height = Math.abs(by - ay);
    return { x, y, width, height };
}

/**
 * Pixel layout of the SVG user viewport when using preserveAspectRatio="xMidYMid meet"
 * (uniform scale + centered letterboxing). Matches {@link SVGSVGElement#getScreenCTM} mapping.
 * Used so HTML rulers align with world-space geometry inside the SVG.
 */
function meetLetterboxPixels(cssW, cssH, vb) {
    if (!(cssW > 0) || !(cssH > 0) || !(vb.w > 0) || !(vb.h > 0)) {
        return { cssW: Math.max(cssW, 1), cssH: Math.max(cssH, 1), tx: 0, ty: 0, scale: 1 };
    }
    const scale = Math.min(cssW / vb.w, cssH / vb.h);
    const tx = (cssW - vb.w * scale) / 2;
    const ty = (cssH - vb.h * scale) / 2;
    return { cssW, cssH, tx, ty, scale };
}

/** Map world X (µm) to horizontal position as fraction [0,1] of the SVG element width (meet). */
function worldXToSvgFracX(wx, vb, m) {
    if (!(m.cssW > 0)) return (wx - vb.x) / vb.w;
    return (m.tx + (wx - vb.x) * m.scale) / m.cssW;
}

/** Map world Y (µm) to vertical position as fraction [0,1] of the SVG element height (meet). */
function worldYToSvgFracY(wy, vb, m) {
    if (!(m.cssH > 0)) return (wy - vb.y) / vb.h;
    return (m.ty + (wy - vb.y) * m.scale) / m.cssH;
}

function hitTolUm(viewBoxW) {
    return Math.max(6, viewBoxW / 200);
}

/** Closing tolerance for line-chain → polygon / polygon → first vertex (µm, world-space). */
function chainCloseTolUm(snapTolUm) {
    return Math.max(Number(snapTolUm) || 14, 3);
}

/** Draft polygon vertices as snap targets (priority with scene geometry). */
function polygonDraftExtras(pts) {
    if (!pts?.length) return [];
    return pts.map((p, i) => ({
        x: p.x,
        y: p.y,
        sub: 'v',
        label: i === 0 ? 'First' : 'Draft',
    }));
}

/** @param {{ x: number, y: number }[]} candidates */
function nearestHardEndpoint(px, py, candidates, tol) {
    if (!candidates?.length || !(tol > 0)) return null;
    let best = null;
    let bestD = tol + 1;
    for (const p of candidates) {
        const d = Math.hypot(px - p.x, py - p.y);
        if (d <= tol && d < bestD - 1e-12) {
            bestD = d;
            best = { x: p.x, y: p.y };
        }
    }
    return best;
}

/** Line endpoints on a layer + optional first vertex (closing target). */
function collectLineHardSnapPoints(doc, layerId, chainFirst) {
    const pts = [];
    const layer = layoutLayers(doc).find((l) => l.id === layerId);
    if (layer) {
        for (const e of layer.entities || []) {
            if (e.type === 'line') {
                pts.push({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 });
            }
        }
    }
    if (chainFirst && Number.isFinite(chainFirst.x) && Number.isFinite(chainFirst.y)) {
        pts.push({ x: chainFirst.x, y: chainFirst.y });
    }
    return pts;
}

/** Draft polygon constraint: free, horizontal/vertical, or 45° steps. */
function polygonConstraintPoint(ox, oy, wx, wy, mode, shiftKey, altKey, angleSnapDeg) {
    if (shiftKey || mode === 'hv') {
        const dx = wx - ox;
        const dy = wy - oy;
        if (Math.abs(dx) >= Math.abs(dy)) return { x: wx, y: oy };
        return { x: ox, y: wy };
    }
    if (mode === '45') {
        const dx = wx - ox;
        const dy = wy - oy;
        const len = Math.hypot(dx, dy);
        if (len < 1e-12) return { x: wx, y: wy };
        let ang = Math.atan2(dy, dx);
        const step = Math.PI / 4;
        ang = Math.round(ang / step) * step;
        return { x: ox + len * Math.cos(ang), y: oy + len * Math.sin(ang) };
    }
    if (altKey && angleSnapDeg > 0) {
        return constrainDragTarget(ox, oy, wx, wy, false, true, angleSnapDeg);
    }
    return { x: wx, y: wy };
}

/** Validate open draft polyline before committing vertex moves while drawing a polygon. */
function validateDraftOpenPolyline(pts, snapGridUm) {
    const minL = Math.max(0.02, snapGridUm * 0.05);
    if (minSegmentLengthUm(pts, false) < minL) {
        window.alert(`Each segment must be at least ${minL.toFixed(3)} µm.`);
        return false;
    }
    if (pts.length >= 4 && openPolylineSelfIntersects(pts)) {
        window.alert('Draft outline self-intersects.');
        return false;
    }
    return true;
}

/** Bottom → top layer index order within the active cell (deterministic multi-layer picks). */
function stableSelectionOrder(doc, idSet) {
    const order = [];
    for (const layer of layoutLayers(doc)) {
        for (const e of layer.entities) {
            if (idSet.has(e.id)) order.push(e.id);
        }
    }
    return order;
}

/** SVG path `d` for outer + holes (even-odd fill). */
function ringsToPathD(rings) {
    let d = '';
    for (const ring of rings) {
        if (!ring?.length) continue;
        d += `M ${ring[0].x} ${ring[0].y}`;
        for (let i = 1; i < ring.length; i++) d += ` L ${ring[i].x} ${ring[i].y}`;
        d += ' Z ';
    }
    return d.trim();
}

/** @param {Set<string>} ids */
function refsForSelection(doc, ids) {
    const refs = [];
    for (const l of allLayersFlat(doc)) {
        for (const e of l.entities) {
            if (ids.has(e.id)) refs.push({ layerId: l.id, entityId: e.id });
        }
    }
    return refs;
}

function refsMovable(doc, refs) {
    const bad = new Set();
    for (const l of allLayersFlat(doc)) {
        if (l.locked || !l.selectable) bad.add(l.id);
    }
    return refs.filter((r) => !bad.has(r.layerId));
}

function removableEntityIds(doc, selectedIds) {
    const out = [];
    for (const l of allLayersFlat(doc)) {
        if (l.locked || !l.selectable) continue;
        for (const e of l.entities) {
            if (selectedIds.has(e.id)) out.push(e.id);
        }
    }
    return out;
}

/** Gap between repeated ⌘V placements along X (µm). */
const MEMS_PASTE_STREET_UM = 10;

/** Human-readable names for planar Boolean status lines (kernel ops in {@link MEMS_PLANAR_BOOLEAN_OPS}). */
const MEMS_BOOLEAN_STATUS_LABEL = {
    union: 'Union',
    intersection: 'Intersect',
    difference: 'Subtract',
    xor: 'XOR',
};

function unionBBoxMems(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
    };
}

export default function MemsMaskStudioPage({
    workspaceFiles = [],
    onSaveJsonToWorkspace,
}) {
    const svgRef = useRef(null);
    const fileImportRef = useRef(null);
    const fileFabImportRef = useRef(null);
    const undoRef = useRef(createUndoManager(80));
    const clipboardRef = useRef(null);
    /** Column index for repeated paste — resets on copy. */
    const pasteRepeatColRef = useRef(0);
    const spaceDownRef = useRef(false);
    const polygonDblRef = useRef(null);
    const polygonPointsRef = useRef(null);
    const polygonCtxMenuRef = useRef(null);
    const transformGestureRef = useRef(null);
    const dragToolRef = useRef(null);
    const drcWorkerRef = useRef(null);
    const drcNextIdRef = useRef(1);

    const moveBaseRef = useRef(null);
    const moveRefsRef = useRef(null);
    const moveOriginRef = useRef(null);

    const panRef = useRef(null);
    const lastPointerGlobalRef = useRef(null);

    const [doc, setDoc] = useState(() => MEMS_BOOTSTRAP.doc);
    const [tool, setTool] = useState('select');
    const [selectedIds, setSelectedIds] = useState(() => new Set());
    const selectionOrderRef = useRef([]);
    const [geomOffsetUm, setGeomOffsetUm] = useState(1);
    const [geomNewDerivedLayer, setGeomNewDerivedLayer] = useState(false);
    const [draftRect, setDraftRect] = useState(null);
    const [dragStart, setDragStart] = useState(null);
    const [draftEllipse, setDraftEllipse] = useState(false);
    const [polygonPoints, setPolygonPoints] = useState(null);
    /** Rubber-band tip while drawing polygon (world µm). */
    const [polygonRubberTip, setPolygonRubberTip] = useState(null);
    /** Pixel-space snap hover target for polygon tool. */
    const [polygonSnapPxHover, setPolygonSnapPxHover] = useState(null);
    /** free | hv | 45 — draft constraint (Shift/Alt still override). */
    const [polygonConstraintMode, setPolygonConstraintMode] = useState(() => 'free');
    const [polygonDraftSegIndex, setPolygonDraftSegIndex] = useState(null);
    const [polygonCtxMenu, setPolygonCtxMenu] = useState(null);
    const [pathPoints, setPathPoints] = useState(null);
    const [lineStart, setLineStart] = useState(null);
    const [lineDraftEnd, setLineDraftEnd] = useState(null);
    /** Chained line → polygon: first vertex, polygon corners, committed segment entity ids. */
    const [lineChain, setLineChain] = useState(null);
    /** Hover highlight for hard endpoint snap (line tool). */
    const [lineSnapHover, setLineSnapHover] = useState(null);
    /** Active magnetic snap target preview (µm world — vertices, edges, grid, guides). */
    const [snapTargetPreview, setSnapTargetPreview] = useState(null);

    useEffect(() => {
        polygonPointsRef.current = polygonPoints;
    }, [polygonPoints]);

    const pathPointsRef = useRef(null);
    useEffect(() => {
        pathPointsRef.current = pathPoints;
    }, [pathPoints]);
    const [marqueeBox, setMarqueeBox] = useState(null);
    const [marqueeStart, setMarqueeStart] = useState(null);
    const [showGrid, setShowGrid] = useState(true);
    const [snapEnabled, setSnapEnabled] = useState(true);
    const [snapGridUm, setSnapGridUm] = useState(10);
    const [objectSnapEnabled, setObjectSnapEnabled] = useState(true);
    const [snapGuideEnabled, setSnapGuideEnabled] = useState(true);
    const [snapTolUm, setSnapTolUm] = useState(14);
    const [angleSnapDeg, setAngleSnapDeg] = useState(15);
    const [nudgeStepUm, setNudgeStepUm] = useState(1);
    const [distributeGapUm, setDistributeGapUm] = useState(10);
    const [showRulers, setShowRulers] = useState(true);
    const [showGuideLines, setShowGuideLines] = useState(true);
    const [memsHairlineOutline, setMemsHairlineOutline] = useState(() => {
        try {
            return localStorage.getItem(MEMS_HAIRLINE_OUTLINE_KEY) === '1';
        } catch {
            return false;
        }
    });
    /** World-space tool / guide / preview stroke (µm). */
    const overlayStrokeUm = memsHairlineOutline
        ? MEMS_HAIRLINE_OUTLINE_UM
        : MEMS_UI_OVERLAY_STROKE_UM;
    const selectionOverlayStrokeUm = memsHairlineOutline
        ? MEMS_HAIRLINE_OUTLINE_UM
        : MEMS_SELECTED_OUTLINE_UM * 0.9;
    const [guides, setGuides] = useState(() => initialGuidesState());
    const [coordFrame, setCoordFrame] = useState('global');
    const [pointerReadout, setPointerReadout] = useState(null);
    /** Linked workspace row id for overwrite saves (sidebar `mems_masks/`). */
    const [memsWorkspaceFileId, setMemsWorkspaceFileId] = useState(null);
    /** Virtual folders under `mems_masks/`, e.g. `Imports` or `Runs/RevA` → file `Imports/name.json`. */
    const [memsWorkspaceSaveSubpath, setMemsWorkspaceSaveSubpath] = useState(() => {
        try {
            return localStorage.getItem(MEMS_SAVE_SUBPATH_KEY) || '';
        } catch {
            return '';
        }
    });
    const [memsZipExportBusy, setMemsZipExportBusy] = useState(false);

    const [layersPanelOpen, setLayersPanelOpen] = useState(() => {
        try {
            return localStorage.getItem(MEMS_LAYERS_PANEL_KEY) !== '0';
        } catch {
            return true;
        }
    });
    const [inspectorPanelOpen, setInspectorPanelOpen] = useState(() => {
        try {
            return localStorage.getItem(MEMS_INSPECTOR_PANEL_KEY) !== '0';
        } catch {
            return true;
        }
    });
    const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
    const [newDesignModalOpen, setNewDesignModalOpen] = useState(false);
    const [waferWizardOpen, setWaferWizardOpen] = useState(false);
    const [newDesignProjectName, setNewDesignProjectName] = useState('My design');
    const [newDesignLibraryName, setNewDesignLibraryName] = useState('Unit');
    const [newDesignPlaceInstance, setNewDesignPlaceInstance] = useState(true);
    const [measureA, setMeasureA] = useState(null);
    const [measureB, setMeasureB] = useState(null);
    const [statusLine, setStatusLine] = useState('');

    const [drcRuleSet, setDrcRuleSet] = useState(loadDrcRuleSetFromStorage);
    const [drcViolations, setDrcViolations] = useState([]);
    const [drcStats, setDrcStats] = useState(null);
    const [drcRealtime, setDrcRealtime] = useState(false);
    const [drcRunning, setDrcRunning] = useState(false);
    const [drcHighlightId, setDrcHighlightId] = useState(null);

    const [viewBox, setViewBox] = useState(() => {
        const d = MEMS_BOOTSTRAP.doc;
        const dw = dieWidthUm(d);
        const dh = dieHeightUm(d);
        return { x: -dw / 2, y: -dh / 2, w: dw, h: dh };
    });

    /** Matches SVG `meet` letterboxing so HTML rulers line up with world-space drawing. */
    const [svgMeet, setSvgMeet] = useState(() => ({ cssW: 1, cssH: 1, tx: 0, ty: 0, scale: 1 }));

    useLayoutEffect(() => {
        const el = svgRef.current;
        if (!el) return;
        const update = () => {
            const r = el.getBoundingClientRect();
            setSvgMeet(meetLetterboxPixels(r.width, r.height, viewBox));
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, [viewBox.x, viewBox.y, viewBox.w, viewBox.h]);

    useEffect(() => {
        try {
            localStorage.setItem(MEMS_SAVE_SUBPATH_KEY, memsWorkspaceSaveSubpath);
        } catch {
            /* quota */
        }
    }, [memsWorkspaceSaveSubpath]);

    useEffect(() => {
        try {
            localStorage.setItem(MEMS_LAYERS_PANEL_KEY, layersPanelOpen ? '1' : '0');
        } catch {
            /* quota */
        }
    }, [layersPanelOpen]);

    useEffect(() => {
        try {
            localStorage.setItem(MEMS_INSPECTOR_PANEL_KEY, inspectorPanelOpen ? '1' : '0');
        } catch {
            /* quota */
        }
    }, [inspectorPanelOpen]);

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
        } catch {
            /* quota */
        }
    }, [doc]);

    useEffect(() => {
        if (tool !== 'line') {
            setLineSnapHover(null);
            setLineChain(null);
            setLineStart(null);
            setLineDraftEnd(null);
        }
        if (tool !== 'polygon') {
            setPolygonPoints(null);
            setPolygonRubberTip(null);
            setPolygonSnapPxHover(null);
            setPolygonCtxMenu(null);
            setPolygonDraftSegIndex(null);
            setPolygonConstraintMode('free');
            polygonDblRef.current = null;
        }
    }, [tool]);

    useEffect(() => {
        if (!polygonPoints || polygonPoints.length < 2) {
            setPolygonDraftSegIndex(null);
            return;
        }
        const maxSeg = polygonPoints.length - 2;
        setPolygonDraftSegIndex((prev) => {
            if (prev == null || prev > maxSeg) return maxSeg;
            return prev;
        });
    }, [polygonPoints]);

    useEffect(() => {
        if (!polygonCtxMenu) return;
        const onDown = (ev) => {
            if (polygonCtxMenuRef.current?.contains(ev.target)) return;
            setPolygonCtxMenu(null);
        };
        window.addEventListener('pointerdown', onDown);
        return () => window.removeEventListener('pointerdown', onDown);
    }, [polygonCtxMenu]);

    useEffect(() => {
        const pid = doc.project?.id || 'default';
        // Sync guides from localStorage when switching projects (external persistence).
        setGuides(loadGuidesFromStorage(pid));
    }, [doc.project?.id]);

    useEffect(() => {
        const pid = doc.project?.id || 'default';
        saveGuidesToStorage(pid, guides);
    }, [guides, doc.project?.id]);

    const snapIndex = useMemo(() => buildSnapIndex(doc), [doc]);

    const getSnapDetail = useCallback(
        (wx, wy, excludeIds, extraTaggedPoints = []) => {
            const ex = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
            if (!snapEnabled && !objectSnapEnabled && !snapGuideEnabled) {
                return {
                    x: wx,
                    y: wy,
                    snapped: false,
                    tier: SNAP_TIER_GRID,
                    kind: 'Free',
                    distanceUm: 0,
                    fromGeometry: false,
                };
            }
            return snapWorldDetail(wx, wy, doc, {
                gridUm: snapGridUm,
                gridEnabled: snapEnabled && snapGridUm > 0,
                geometrySnapEnabled: objectSnapEnabled,
                guidesEnabled: snapGuideEnabled,
                tolUm: snapTolUm,
                guidesH: guides.h,
                guidesV: guides.v,
                excludeEntityIds: ex,
                snapIndex: ex.size ? null : snapIndex,
                extraTaggedPoints,
            });
        },
        [
            doc,
            snapIndex,
            snapEnabled,
            objectSnapEnabled,
            snapGuideEnabled,
            snapGridUm,
            snapTolUm,
            guides,
        ]
    );

    const snapWorldPoint = useCallback(
        (wx, wy, excludeIds, opts = {}) => {
            const d = getSnapDetail(wx, wy, excludeIds, opts.extraTaggedPoints || []);
            return { x: d.x, y: d.y };
        },
        [getSnapDetail]
    );

    const lineHardSnapCandidates = useMemo(
        () => collectLineHardSnapPoints(doc, doc.activeLayerId, lineChain?.first ?? null),
        [doc, doc.activeLayerId, lineChain]
    );

    const fitView = useCallback(() => {
        setViewBox(viewBoxToFitActiveCellContent(doc));
    }, [doc]);

    const applyWaferWizardResult = useCallback((nextDoc, { warnings, stats }) => {
        const expanded = expandProjectDieToCoverActiveCellContent(nextDoc);
        setDoc(expanded);
        setSelectedIds(new Set());
        selectionOrderRef.current = [];
        undoRef.current.clear();
        setMemsWorkspaceFileId(null);
        setViewBox(viewBoxToFitActiveCellContent(expanded));
        const bits = [];
        if (stats) {
            bits.push(
                `${stats.cols}×${stats.rows} dies · ${stats.maskLayerCount ?? 1} mask layer(s) · pitch ${Math.round(stats.diePitchXUm)}×${Math.round(stats.diePitchYUm)} µm`
            );
        }
        if (warnings?.length) {
            bits.push(`${warnings.length} note(s) — see alert`);
            window.alert(warnings.join('\n\n'));
        }
        setStatusLine(bits.length ? `Wafer layout · ${bits[0]}` : 'Wafer layout created');
    }, []);

    const pickEntityAt = useCallback(
        (wx, wy, tol) => {
            const t = tol ?? hitTolUm(viewBox.w);
            const stack = [...layoutLayers(doc)].reverse();
            for (const layer of stack) {
                if (!layer.visible || !layer.selectable) continue;
                for (let ei = layer.entities.length - 1; ei >= 0; ei--) {
                    const e = layer.entities[ei];
                    if (e.type === 'instance') continue;
                    if (hitEntity(wx, wy, e, t)) {
                        return { layerId: layer.id, entityId: e.id };
                    }
                }
            }
            for (const layer of stack) {
                if (!layer.visible || !layer.selectable) continue;
                for (let ei = layer.entities.length - 1; ei >= 0; ei--) {
                    const e = layer.entities[ei];
                    if (e.type !== 'instance') continue;
                    if (hitEntityResolved(doc, wx, wy, e, t)) {
                        return { layerId: layer.id, entityId: e.id };
                    }
                }
            }
            return null;
        },
        [doc, viewBox.w]
    );

    const commitDoc = useCallback((mutator, forceUndo = false) => {
        setDoc((d) => {
            undoRef.current.push(d, forceUndo);
            return expandProjectDieToCoverActiveCellContent(mutator(d));
        });
    }, []);

    const finalizePolygonFromDraft = useCallback(
        (ptsIn) => {
            const pts = ptsIn.map((p) => ({ x: p.x, y: p.y }));
            const layer = activeLayer(doc);
            if (!layer || layer.locked || pts.length < 3) return false;
            const minL = Math.max(0.02, snapGridUm * 0.05);
            if (minSegmentLengthUm(pts, true) < minL) {
                window.alert(
                    `Each segment must be at least ${minL.toFixed(3)} µm (based on grid / design rules).`
                );
                return false;
            }
            if (closingSegmentCrosses(pts)) {
                window.alert('The closing edge crosses another edge. Adjust vertices before finishing.');
                return false;
            }
            if (openPolylineSelfIntersects(pts)) {
                window.alert('Polygon outline self-intersects.');
                return false;
            }
            commitDoc((d) => addPolygon(d, layer.id, pts), true);
            setPolygonPoints(null);
            setPolygonRubberTip(null);
            setPolygonSnapPxHover(null);
            setPolygonDraftSegIndex(null);
            setPolygonCtxMenu(null);
            setSelectedIds(new Set());
            setStatusLine(`Polygon · ${pts.length} vertices`);
            return true;
        },
        [doc, commitDoc, snapGridUm]
    );

    const applyBooleanOp = useCallback(
        (op) => {
            const ordered = selectionOrderRef.current.filter((id) => selectedIds.has(id));
            if (ordered.length < 2) {
                setStatusLine(
                    op === 'difference'
                        ? 'Subtract: click subject first, then cutters (Shift)'
                        : 'Select at least 2 shapes (Shift adds to pick order)'
                );
                return;
            }
            const entities = [];
            const layerIds = [];
            for (const id of ordered) {
                const hit = findEntity(doc, id);
                if (!hit) continue;
                if (hit.layer.locked || !hit.layer.selectable) {
                    setStatusLine('Unlock layers and enable Selectable for geometry ops');
                    return;
                }
                if (hit.entity.type === 'instance') {
                    setStatusLine('Boolean ops: select primitives only (not cell instances)');
                    return;
                }
                entities.push(hit.entity);
                layerIds.push(hit.layer.id);
            }
            if (entities.length < 2) return;

            const mpNm = booleanEntitiesNm(op, entities, undefined, {});
            const specs = multiPolygonNmToPolygonSpecsUm(mpNm);
            if (!specs.length) {
                setStatusLine('Empty Boolean result');
                return;
            }

            commitDoc(
                (d) => {
                    let next = d;
                    let targetLayerId = d.activeLayerId;
                    if (geomNewDerivedLayer) {
                        next = addDerivedLayer(next, `${op}`, {
                            op,
                            sourceLayerIds: [...new Set(layerIds)],
                            sourceEntityIds: ordered,
                        });
                        targetLayerId = next.activeLayerId;
                    } else {
                        const L = activeLayer(next);
                        if (!L || L.locked) return d;
                        targetLayerId = L.id;
                    }
                    next = deleteEntitiesByIds(next, ordered);
                    return addPolygonSpecs(next, targetLayerId, specs);
                },
                true
            );
            setSelectedIds(new Set());
            selectionOrderRef.current = [];
            setStatusLine(
                `${MEMS_BOOLEAN_STATUS_LABEL[op] ?? op}: ${specs.length} polygon region(s)`
            );
        },
        [doc, selectedIds, geomNewDerivedLayer, commitDoc]
    );

    const applyOffsetGrowShrink = useCallback(
        (sign) => {
            const ordered = selectionOrderRef.current.filter((id) => selectedIds.has(id));
            if (!ordered.length) {
                setStatusLine('Select shape(s) to offset');
                return;
            }
            const dist = sign * Math.abs(Number(geomOffsetUm) || 0);
            if (dist === 0) {
                setStatusLine('Set offset distance (µm) ≠ 0');
                return;
            }
            const entities = [];
            const layerIds = [];
            for (const id of ordered) {
                const hit = findEntity(doc, id);
                if (!hit) continue;
                if (hit.layer.locked || !hit.layer.selectable) {
                    setStatusLine('Unlock layers for geometry ops');
                    return;
                }
                if (hit.entity.type === 'instance') {
                    setStatusLine('Offset: select primitives only (not cell instances)');
                    return;
                }
                entities.push(hit.entity);
                layerIds.push(hit.layer.id);
            }
            if (!entities.length) return;

            const mpNm = offsetEntitiesCombinedNm(entities, dist, {});
            const specs = multiPolygonNmToPolygonSpecsUm(mpNm);
            if (!specs.length) {
                setStatusLine('Empty offset result');
                return;
            }

            commitDoc(
                (d) => {
                    let next = d;
                    let targetLayerId = d.activeLayerId;
                    if (geomNewDerivedLayer) {
                        next = addDerivedLayer(next, `offset ${dist > 0 ? '+' : ''}${dist.toFixed(3)} µm`, {
                            op: 'offset',
                            sourceLayerIds: [...new Set(layerIds)],
                            sourceEntityIds: ordered,
                        });
                        targetLayerId = next.activeLayerId;
                    } else {
                        const L = activeLayer(next);
                        if (!L || L.locked) return d;
                        targetLayerId = L.id;
                    }
                    next = deleteEntitiesByIds(next, ordered);
                    return addPolygonSpecs(next, targetLayerId, specs);
                },
                true
            );
            setSelectedIds(new Set());
            selectionOrderRef.current = [];
            setStatusLine(`Offset ${dist > 0 ? '+' : ''}${dist.toFixed(3)} µm → ${specs.length} polygon(s)`);
        },
        [doc, selectedIds, geomOffsetUm, geomNewDerivedLayer, commitDoc]
    );

    const applyPathStrokeToPolygons = useCallback(() => {
        const ordered = selectionOrderRef.current.filter((id) => selectedIds.has(id));
        const halfW = Math.abs(Number(geomOffsetUm) || 0);
        if (!ordered.length || halfW <= 0) {
            setStatusLine('Select path(s) and set half-width (µm) > 0');
            return;
        }
        const specs = [];
        const dropIds = [];
        const layerIds = [];
        for (const id of ordered) {
            const hit = findEntity(doc, id);
            if (!hit || hit.entity.type !== 'path') continue;
            if (hit.layer.locked || !hit.layer.selectable) {
                setStatusLine('Unlock layers for geometry ops');
                return;
            }
            const mpNm = openPathToMultiPolygonNm(hit.entity.points || [], halfW, {});
            const parts = multiPolygonNmToPolygonSpecsUm(mpNm);
            if (parts.length) {
                specs.push(...parts);
                dropIds.push(id);
                layerIds.push(hit.layer.id);
            }
        }
        if (!specs.length) {
            setStatusLine('No paths in selection (or zero-area stroke)');
            return;
        }
        commitDoc(
            (d) => {
                let next = d;
                let targetLayerId = d.activeLayerId;
                if (geomNewDerivedLayer) {
                    next = addDerivedLayer(next, `path stroke ${halfW} µm`, {
                        op: 'pathStroke',
                        sourceLayerIds: [...new Set(layerIds)],
                        sourceEntityIds: dropIds,
                    });
                    targetLayerId = next.activeLayerId;
                } else {
                    const L = activeLayer(next);
                    if (!L || L.locked) return d;
                    targetLayerId = L.id;
                }
                next = deleteEntitiesByIds(next, dropIds);
                return addPolygonSpecs(next, targetLayerId, specs);
            },
            true
        );
        setSelectedIds(new Set());
        selectionOrderRef.current = [];
        setStatusLine(`Path → polygon (${specs.length} region(s), half ${halfW} µm)`);
    }, [doc, selectedIds, geomOffsetUm, geomNewDerivedLayer, commitDoc]);

    const doUndo = useCallback(() => {
        const prev = undoRef.current.undo(doc);
        if (prev) setDoc(prev);
    }, [doc]);

    const doRedo = useCallback(() => {
        const next = undoRef.current.redo(doc);
        if (next) setDoc(next);
    }, [doc]);

    const onPointerDown = useCallback(
        (ev) => {
            if (!svgRef.current) return;
            const svg = svgRef.current;
            const vb = viewBox;
            let { x: wx, y: wy } = clientToWorld(svg, ev.clientX, ev.clientY, vb);
            const cw = clampWorldToDie(wx, wy, doc);
            wx = cw.x;
            wy = cw.y;
            const lineExtra =
                tool === 'line' && lineChain?.first
                    ? [
                          {
                              x: lineChain.first.x,
                              y: lineChain.first.y,
                              sub: 'v',
                              label: 'Chain start',
                          },
                      ]
                    : [];
            const polyExtra =
                tool === 'polygon' && polygonPointsRef.current?.length
                    ? polygonDraftExtras(polygonPointsRef.current)
                    : [];
            const extraForSnap =
                tool === 'line' ? lineExtra : tool === 'polygon' ? polyExtra : [];
            const snappedPt = snapWorldPoint(wx, wy, new Set(), { extraTaggedPoints: extraForSnap });
            wx = snappedPt.x;
            wy = snappedPt.y;

            const panMode = ev.button === 1 || (ev.button === 0 && spaceDownRef.current);
            if (panMode) {
                ev.preventDefault();
                panRef.current = {
                    lastCx: ev.clientX,
                    lastCy: ev.clientY,
                    x: vb.x,
                    y: vb.y,
                    w: vb.w,
                    h: vb.h,
                };
                return;
            }

            if (tool === 'measure') {
                ev.preventDefault();
                if (!measureA || measureB) {
                    setMeasureA({ x: wx, y: wy });
                    setMeasureB(null);
                    setStatusLine('Measure · click second point');
                } else {
                    setMeasureB({ x: wx, y: wy });
                    const d = Math.hypot(wx - measureA.x, wy - measureA.y);
                    const du = projectDisplayUnit(doc);
                    setStatusLine(
                        `Distance ${d.toFixed(4)} µm (${formatLengthUm(d, du, 6)} ${unitSuffix(du)})`
                    );
                }
                return;
            }

            if (!isInsideDie(wx, wy, doc)) return;

            const layer = activeLayer(doc);
            if (!layer || layer.locked) {
                if (tool === 'select') {
                    const hit = pickEntityAt(wx, wy);
                    if (hit && hit.layerId !== doc.activeLayerId) {
                        setDoc((d) => setActiveLayer(d, hit.layerId));
                    }
                }
                return;
            }

            if (tool === 'select') {
                const overlay = pickTransformOverlay(wx, wy, doc, selectedIds, viewBox.w);
                if (overlay) {
                    const L = allLayersFlat(doc).find((l) => l.id === overlay.layerId);
                    if (L && !L.locked) {
                        undoRef.current.push(doc);
                        transformGestureRef.current = {
                            ...overlay,
                            baseDoc: cloneDoc(doc),
                            ox: wx,
                            oy: wy,
                        };
                        try {
                            svg.setPointerCapture(ev.pointerId);
                        } catch {
                            /* ignore */
                        }
                        return;
                    }
                }
                const hit = pickEntityAt(wx, wy);
                let nextSel = selectedIds;
                if (hit) {
                    if (ev.shiftKey) {
                        nextSel = new Set(selectedIds);
                        if (nextSel.has(hit.entityId)) {
                            nextSel.delete(hit.entityId);
                            selectionOrderRef.current = selectionOrderRef.current.filter(
                                (id) => id !== hit.entityId
                            );
                        } else {
                            nextSel.add(hit.entityId);
                            selectionOrderRef.current = [...selectionOrderRef.current, hit.entityId];
                        }
                    } else {
                        nextSel = new Set([hit.entityId]);
                        selectionOrderRef.current = [hit.entityId];
                    }
                    setSelectedIds(nextSel);
                    if (hit.layerId !== doc.activeLayerId) {
                        setDoc((d) => setActiveLayer(d, hit.layerId));
                    }
                    if (nextSel.has(hit.entityId)) {
                        const refs = refsMovable(doc, refsForSelection(doc, nextSel));
                        if (refs.length > 0) {
                            undoRef.current.push(doc);
                            moveBaseRef.current = cloneDoc(doc);
                            moveRefsRef.current = refs;
                            moveOriginRef.current = { x: wx, y: wy };
                        }
                    }
                } else {
                    if (!ev.shiftKey) {
                        setSelectedIds(new Set());
                        selectionOrderRef.current = [];
                    }
                    setMarqueeStart({ x: wx, y: wy });
                    setMarqueeBox({ minX: wx, minY: wy, maxX: wx, maxY: wy });
                }
                try {
                    svg.setPointerCapture(ev.pointerId);
                } catch {
                    /* ignore */
                }
                return;
            }

            if (tool === 'path') {
                setPathPoints((prev) => {
                    const next = prev ? [...prev, { x: wx, y: wy }] : [{ x: wx, y: wy }];
                    setStatusLine(`Path · ${next.length} points · Enter to finish · Esc cancel`);
                    return next;
                });
                return;
            }

            if (tool === 'line') {
                const layer = activeLayer(doc);
                if (!layer || layer.locked) return;

                const closeTol = chainCloseTolUm(snapTolUm);

                if (lineChain && lineChain.vertices.length >= 3) {
                    const dFirst = Math.hypot(wx - lineChain.first.x, wy - lineChain.first.y);
                    if (dFirst <= closeTol) {
                        const ids = lineChain.segmentIds;
                        const verts = lineChain.vertices.map((p) => ({ x: p.x, y: p.y }));
                        commitDoc((d) => {
                            let next = deleteEntitiesByIds(d, ids);
                            return addPolygon(next, layer.id, verts);
                        }, true);
                        setLineChain(null);
                        setLineStart(null);
                        setLineDraftEnd(null);
                        setLineSnapHover(null);
                        setSelectedIds(new Set());
                        setStatusLine(`Polygon closed · ${verts.length} vertices`);
                        return;
                    }
                }

                if (!lineStart) {
                    setLineStart({ x: wx, y: wy });
                    setLineChain({
                        first: { x: wx, y: wy },
                        vertices: [{ x: wx, y: wy }],
                        segmentIds: [],
                    });
                    setLineDraftEnd({ x: wx, y: wy });
                    setStatusLine(
                        `Line chain · next corner · snap ${snapTolUm} µm · green start closes (≤${Math.round(closeTol)} µm) · Enter finish · Esc ends chain (segments stay)`
                    );
                    return;
                }

                let c = constrainDragTarget(
                    lineStart.x,
                    lineStart.y,
                    wx,
                    wy,
                    ev.shiftKey,
                    ev.altKey,
                    angleSnapDeg
                );
                const chainExtra = lineChain?.first
                    ? [
                          {
                              x: lineChain.first.x,
                              y: lineChain.first.y,
                              sub: 'v',
                              label: 'Chain start',
                          },
                      ]
                    : [];
                const snapEnd = snapWorldPoint(c.x, c.y, new Set(), { extraTaggedPoints: chainExtra });
                c = { x: snapEnd.x, y: snapEnd.y };

                const minSegUm = 1e-3;
                if (Math.hypot(c.x - lineStart.x, c.y - lineStart.y) < minSegUm) {
                    setStatusLine('Segment too short — move farther or snap to an endpoint (cyan)');
                    return;
                }

                let newLineId = null;
                commitDoc((d) => {
                    const r = addLineReturningId(d, layer.id, {
                        x1: lineStart.x,
                        y1: lineStart.y,
                        x2: c.x,
                        y2: c.y,
                    });
                    newLineId = r.entityId;
                    return r.doc;
                }, true);

                setLineChain((prev) =>
                    prev
                        ? {
                              ...prev,
                              vertices: [...prev.vertices, { x: c.x, y: c.y }],
                              segmentIds: [...prev.segmentIds, newLineId],
                          }
                        : prev
                );
                setLineStart({ x: c.x, y: c.y });
                setLineDraftEnd({ x: c.x, y: c.y });
                const segN = (lineChain?.segmentIds?.length ?? 0) + 1;
                const segLen = Math.hypot(c.x - lineStart.x, c.y - lineStart.y);
                setStatusLine(
                    `Chain segment ${segN} · L ${segLen.toFixed(3)} µm · click next corner or close at green start`
                );
                return;
            }

            if (tool === 'polygon') {
                ev.preventDefault();
                const pts = polygonPointsRef.current;
                const layerPoly = activeLayer(doc);
                if (!layerPoly || layerPoly.locked) return;

                const now = Date.now();
                const pr = polygonDblRef.current;
                if (
                    pr &&
                    now - pr.t < 450 &&
                    Math.hypot(ev.clientX - pr.x, ev.clientY - pr.y) < 14 &&
                    pts &&
                    pts.length >= 3
                ) {
                    finalizePolygonFromDraft(pts);
                    polygonDblRef.current = null;
                    return;
                }
                polygonDblRef.current = { t: now, x: ev.clientX, y: ev.clientY };

                const last = pts?.length ? pts[pts.length - 1] : null;
                const constrained = last
                    ? polygonConstraintPoint(
                          last.x,
                          last.y,
                          wx,
                          wy,
                          polygonConstraintMode,
                          ev.shiftKey,
                          ev.altKey,
                          angleSnapDeg
                      )
                    : { x: wx, y: wy };
                const draftExtra = polygonDraftExtras(pts || []);
                const polySnap = getSnapDetail(constrained.x, constrained.y, new Set(), draftExtra);
                const place = { x: polySnap.x, y: polySnap.y };

                if (pts && pts.length >= 3) {
                    const closeTolPoly = chainCloseTolUm(snapTolUm);
                    const nearFirst =
                        Math.hypot(place.x - pts[0].x, place.y - pts[0].y) <= closeTolPoly;
                    if (nearFirst) {
                        finalizePolygonFromDraft(pts);
                        return;
                    }
                }

                if (pts?.length) {
                    const dLast = Math.hypot(place.x - pts[pts.length - 1].x, place.y - pts[pts.length - 1].y);
                    const minSeg = Math.max(1e-4, snapGridUm * 0.05);
                    if (dLast < minSeg) {
                        setStatusLine(`Segment too short (< ${minSeg.toFixed(3)} µm). Move farther or lower grid snap.`);
                        return;
                    }
                    if (newEdgeCrossesExistingOpen(pts, place)) {
                        setStatusLine('Segment would cross an existing edge — choose another point.');
                        return;
                    }
                }

                setPolygonPoints((prev) => {
                    const next = prev ? [...prev, { x: place.x, y: place.y }] : [{ x: place.x, y: place.y }];
                    const snapLabel = polySnap.kind !== 'Free' ? `${polySnap.kind} · ${snapTolUm} µm` : 'Free';
                    setStatusLine(
                        `Polygon · ${next.length} vertices · ${snapLabel} · 1–3 constraint · Enter close · dbl-click close · RMB menu`
                    );
                    return next;
                });
                return;
            }

            if (tool === 'rect' || tool === 'ellipse' || tool === 'circle') {
                dragToolRef.current = tool;
                setDraftEllipse(tool === 'ellipse' || tool === 'circle');
                setDragStart({ x: wx, y: wy });
                setDraftRect({ x: wx, y: wy, width: 0, height: 0 });
                try {
                    svg.setPointerCapture(ev.pointerId);
                } catch {
                    /* ignore */
                }
            }
        },
        [
            doc,
            tool,
            viewBox,
            pickEntityAt,
            snapWorldPoint,
            getSnapDetail,
            selectedIds,
            commitDoc,
            lineStart,
            lineChain,
            measureA,
            measureB,
            angleSnapDeg,
            lineHardSnapCandidates,
            finalizePolygonFromDraft,
            polygonConstraintMode,
            guides,
            snapGridUm,
            snapEnabled,
            snapTolUm,
        ]
    );

    const onPointerMove = useCallback(
        (ev) => {
            if (!svgRef.current) return;
            const svg = svgRef.current;
            const vb = viewBox;

            if (panRef.current) {
                const p = panRef.current;
                const wPrev = clientToWorld(svg, p.lastCx, p.lastCy, vb);
                const wCur = clientToWorld(svg, ev.clientX, ev.clientY, vb);
                const dwx = wCur.x - wPrev.x;
                const dwy = wCur.y - wPrev.y;
                setViewBox({ x: vb.x - dwx, y: vb.y - dwy, w: vb.w, h: vb.h });
                p.lastCx = ev.clientX;
                p.lastCy = ev.clientY;
                // After an incremental pan, the world point under the cursor matches the world at
                // the previous sample (wPrev). Re-querying with the stale pre-commit viewBox/CTM
                // would mis-report until React updates the DOM.
                const cw = clampWorldToDie(wPrev.x, wPrev.y, doc);
                lastPointerGlobalRef.current = { x: cw.x, y: cw.y };
                setPointerReadout({ gx: cw.x, gy: cw.y });
                setSnapTargetPreview(null);
                return;
            }

            let { x: wx, y: wy } = clientToWorld(svg, ev.clientX, ev.clientY, vb);
            const cw = clampWorldToDie(wx, wy, doc);
            const lineExtra =
                tool === 'line' && lineChain?.first
                    ? [
                          {
                              x: lineChain.first.x,
                              y: lineChain.first.y,
                              sub: 'v',
                              label: 'Chain start',
                          },
                      ]
                    : [];
            const polyExtra =
                tool === 'polygon' && polygonPointsRef.current?.length
                    ? polygonDraftExtras(polygonPointsRef.current)
                    : [];
            const extraForSnap =
                tool === 'line' ? lineExtra : tool === 'polygon' ? polyExtra : [];
            const exclude =
                tool === 'select' && moveBaseRef.current ? selectedIds : new Set();
            const snappedPos = snapWorldPoint(cw.x, cw.y, exclude, {
                extraTaggedPoints: extraForSnap,
            });
            wx = snappedPos.x;
            wy = snappedPos.y;
            lastPointerGlobalRef.current = { x: wx, y: wy };
            setPointerReadout({ gx: wx, gy: wy });

            if (tool === 'polygon') {
                const layerP = activeLayer(doc);
                if (layerP && !layerP.locked) {
                    const pts = polygonPointsRef.current;
                    const last = pts?.length ? pts[pts.length - 1] : null;
                    const constrained = last
                        ? polygonConstraintPoint(
                              last.x,
                              last.y,
                              wx,
                              wy,
                              polygonConstraintMode,
                              ev.shiftKey,
                              ev.altKey,
                              angleSnapDeg
                          )
                        : { x: wx, y: wy };
                    const td = getSnapDetail(
                        constrained.x,
                        constrained.y,
                        exclude,
                        polygonDraftExtras(pts || [])
                    );
                    setPolygonRubberTip({ x: td.x, y: td.y });
                    setPolygonSnapPxHover(td.kind !== 'Free' ? { wx: td.x, wy: td.y } : null);
                    lastPointerGlobalRef.current = { x: td.x, y: td.y };
                    setPointerReadout({ gx: td.x, gy: td.y });
                    setSnapTargetPreview(
                        snapEnabled || objectSnapEnabled || snapGuideEnabled
                            ? { x: td.x, y: td.y, kind: td.kind, tier: td.tier }
                            : null
                    );
                    setStatusLine(
                        `Polygon draft · ${td.kind} · tol ${snapTolUm} µm · mode ${polygonConstraintMode} (keys 1–3) · Shift H/V · Alt fine angle`
                    );
                    return;
                }
            }

            if (tool === 'line') {
                setLineSnapHover(nearestHardEndpoint(wx, wy, lineHardSnapCandidates, snapTolUm));
                if (lineStart) {
                    let c = constrainDragTarget(
                        lineStart.x,
                        lineStart.y,
                        wx,
                        wy,
                        ev.shiftKey,
                        ev.altKey,
                        angleSnapDeg
                    );
                    const chainExtra = lineChain?.first
                        ? [
                              {
                                  x: lineChain.first.x,
                                  y: lineChain.first.y,
                                  sub: 'v',
                                  label: 'Chain start',
                              },
                          ]
                        : [];
                    const snapEnd = snapWorldPoint(c.x, c.y, new Set(), {
                        extraTaggedPoints: chainExtra,
                    });
                    c = { x: snapEnd.x, y: snapEnd.y };
                    setLineDraftEnd({ x: c.x, y: c.y });
                    const ddx = c.x - lineStart.x;
                    const ddy = c.y - lineStart.y;
                    const segLen = Math.hypot(ddx, ddy);
                    const segAng = (Math.atan2(ddy, ddx) * 180) / Math.PI;
                    const closeTol = chainCloseTolUm(snapTolUm);
                    const nearClose =
                        lineChain &&
                        lineChain.vertices.length >= 3 &&
                        Math.hypot(c.x - lineChain.first.x, c.y - lineChain.first.y) <= closeTol;
                    const ld = getSnapDetail(c.x, c.y, new Set(), chainExtra);
                    setSnapTargetPreview(
                        snapEnabled || objectSnapEnabled || snapGuideEnabled
                            ? { x: ld.x, y: ld.y, kind: ld.kind, tier: ld.tier }
                            : null
                    );
                    setStatusLine(
                        nearClose
                            ? `Release near green start to close polygon (${lineChain.vertices.length} vertices)`
                            : `Chain · L ${segLen.toFixed(3)} µm · θ ${segAng.toFixed(2)}° · Δ ${ddx.toFixed(3)}, ${ddy.toFixed(3)} µm · snap ${snapTolUm} µm`
                    );
                    return;
                }
            } else if (lineSnapHover) {
                setLineSnapHover(null);
            }

            if (transformGestureRef.current) {
                setSnapTargetPreview(null);
                const tg = transformGestureRef.current;
                const entHit = findEntity(tg.baseDoc, tg.entityId);
                if (entHit) {
                    let nextEnt = entHit.entity;
                    if (tg.kind === 'rotate') {
                        nextEnt = rotatedEntityFromGesture(entHit.entity, wx, wy, tg.ox, tg.oy, tg.baseDoc);
                    } else {
                        nextEnt = resizedEntityFromCorner(entHit.entity, wx, wy);
                    }
                    setDoc(
                        expandProjectDieToCoverActiveCellContent(
                            replaceEntity(tg.baseDoc, tg.layerId, tg.entityId, nextEnt)
                        )
                    );
                }
                return;
            }

            if (tool === 'select' && moveBaseRef.current && moveOriginRef.current && moveRefsRef.current) {
                setSnapTargetPreview(null);
                const ox = moveOriginRef.current.x;
                const oy = moveOriginRef.current.y;
                let dx = wx - ox;
                let dy = wy - oy;
                if (ev.shiftKey) {
                    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
                    else dx = 0;
                }
                const base = moveBaseRef.current;
                const refs = moveRefsRef.current;
                setDoc(expandProjectDieToCoverActiveCellContent(translateSelection(base, refs, dx, dy)));
                setStatusLine(`Δ ${dx.toFixed(3)}, ${dy.toFixed(3)} µm`);
                return;
            }

            if (marqueeStart && tool === 'select') {
                setSnapTargetPreview(null);
                setMarqueeBox({
                    minX: Math.min(marqueeStart.x, wx),
                    minY: Math.min(marqueeStart.y, wy),
                    maxX: Math.max(marqueeStart.x, wx),
                    maxY: Math.max(marqueeStart.y, wy),
                });
                return;
            }

            if ((tool === 'rect' || tool === 'ellipse' || tool === 'circle') && dragStart) {
                let rx = wx;
                let ry = wy;
                if (ev.shiftKey || tool === 'circle') {
                    const dx = wx - dragStart.x;
                    const dy = wy - dragStart.y;
                    const s = Math.max(Math.abs(dx), Math.abs(dy));
                    const sx = dx === 0 && dy === 0 ? 0 : Math.sign(dx || dy || 1);
                    const sy = dx === 0 && dy === 0 ? 0 : Math.sign(dy || dx || 1);
                    rx = dragStart.x + sx * s;
                    ry = dragStart.y + sy * s;
                }
                setDraftRect(normalizeRect(dragStart.x, dragStart.y, rx, ry));
                setStatusLine(
                    `Δ ${Math.abs(rx - dragStart.x).toFixed(1)} × ${Math.abs(ry - dragStart.y).toFixed(1)} µm`
                );
            }

            const idlePreview = getSnapDetail(cw.x, cw.y, exclude, extraForSnap);
            setSnapTargetPreview(
                snapEnabled || objectSnapEnabled || snapGuideEnabled
                    ? {
                          x: idlePreview.x,
                          y: idlePreview.y,
                          kind: idlePreview.kind,
                          tier: idlePreview.tier,
                      }
                    : null
            );
        },
        [
            tool,
            dragStart,
            viewBox,
            doc,
            snapWorldPoint,
            getSnapDetail,
            marqueeStart,
            lineStart,
            lineChain,
            angleSnapDeg,
            selectedIds,
            lineHardSnapCandidates,
            snapTolUm,
            polygonConstraintMode,
            guides,
            snapGridUm,
            snapEnabled,
            objectSnapEnabled,
            snapGuideEnabled,
        ]
    );

    const finishMarquee = useCallback(
        (wx, wy, shiftKey) => {
            if (!marqueeStart) {
                setMarqueeStart(null);
                setMarqueeBox(null);
                return;
            }
            const box = {
                minX: Math.min(marqueeStart.x, wx),
                minY: Math.min(marqueeStart.y, wy),
                maxX: Math.max(marqueeStart.x, wx),
                maxY: Math.max(marqueeStart.y, wy),
            };
            if (box.maxX - box.minX < 2 && box.maxY - box.minY < 2) {
                setMarqueeStart(null);
                setMarqueeBox(null);
                return;
            }
            const picked = new Set();
            for (const layer of layoutLayers(doc)) {
                if (!layer.visible || !layer.selectable) continue;
                for (const e of layer.entities) {
                    const eb = resolvedEntityBBox(doc, e);
                    if (eb && bboxIntersects(box, eb)) picked.add(e.id);
                }
            }
            const stable = stableSelectionOrder(doc, picked);
            if (shiftKey) {
                setSelectedIds((prev) => new Set([...prev, ...picked]));
                selectionOrderRef.current = [
                    ...selectionOrderRef.current,
                    ...stable.filter((id) => !selectionOrderRef.current.includes(id)),
                ];
            } else {
                setSelectedIds(picked);
                selectionOrderRef.current = stable;
            }
            setMarqueeStart(null);
            setMarqueeBox(null);
        },
        [marqueeStart, doc]
    );

    const onPointerUp = useCallback(
        (ev) => {
            if (!svgRef.current) return;
            const svg = svgRef.current;

            if (panRef.current) {
                panRef.current = null;
                try {
                    svg.releasePointerCapture(ev.pointerId);
                } catch {
                    /* ignore */
                }
                setStatusLine('');
                return;
            }

            if (tool === 'select') {
                transformGestureRef.current = null;
                if (moveBaseRef.current) {
                    moveBaseRef.current = null;
                    moveRefsRef.current = null;
                    moveOriginRef.current = null;
                    setStatusLine('');
                }
                if (marqueeStart) {
                    const vb = viewBox;
                    let { x: wx, y: wy } = clientToWorld(svg, ev.clientX, ev.clientY, vb);
                    const cw = clampWorldToDie(wx, wy, doc);
                    wx = cw.x;
                    wy = cw.y;
                    finishMarquee(wx, wy, ev.shiftKey);
                }
                try {
                    svg.releasePointerCapture(ev.pointerId);
                } catch {
                    /* ignore */
                }
                return;
            }

            if ((tool === 'rect' || tool === 'ellipse' || tool === 'circle') && dragStart && draftRect) {
                const layer = activeLayer(doc);
                const tUsed = dragToolRef.current || tool;
                if (
                    layer &&
                    !layer.locked &&
                    draftRect.width >= 0.5 &&
                    draftRect.height >= 0.5
                ) {
                    const clipped = clipDraftRectToDie(draftRect, doc);
                    if (clipped.width >= 0.5 && clipped.height >= 0.5) {
                        if (tUsed === 'circle') {
                            const r = Math.min(clipped.width, clipped.height) / 2;
                            const cx = clipped.x + clipped.width / 2;
                            const cy = clipped.y + clipped.height / 2;
                            commitDoc(
                                (d) =>
                                    addEllipse(d, layer.id, {
                                        cx,
                                        cy,
                                        rx: r,
                                        ry: r,
                                        rotationDeg: 0,
                                    }),
                                true
                            );
                        } else if (draftEllipse || tUsed === 'ellipse') {
                            commitDoc(
                                (d) =>
                                    addEllipse(d, layer.id, {
                                        cx: clipped.x + clipped.width / 2,
                                        cy: clipped.y + clipped.height / 2,
                                        rx: clipped.width / 2,
                                        ry: clipped.height / 2,
                                        rotationDeg: 0,
                                    }),
                                true
                            );
                        } else {
                            commitDoc((d) => addRectangle(d, layer.id, clipped), true);
                        }
                        setSelectedIds(new Set());
                    }
                }
                setDragStart(null);
                setDraftRect(null);
                setDraftEllipse(false);
                dragToolRef.current = null;
                setStatusLine('');
                try {
                    svg.releasePointerCapture(ev.pointerId);
                } catch {
                    /* ignore */
                }
            }
        },
        [
            tool,
            dragStart,
            draftRect,
            draftEllipse,
            doc,
            finishMarquee,
            marqueeStart,
            viewBox,
            commitDoc,
        ]
    );

    useEffect(() => {
        const onKey = (e) => {
            if (e.code === 'Space') {
                if (e.type === 'keydown') {
                    const t = e.target;
                    if (
                        t === document.body ||
                        t === document.documentElement ||
                        svgRef.current?.contains(t)
                    )
                        e.preventDefault();
                }
                spaceDownRef.current = e.type === 'keydown';
                return;
            }
            if (e.type !== 'keydown') return;

            const meta = e.metaKey || e.ctrlKey;
            if (meta && e.key === 'z') {
                e.preventDefault();
                if (e.shiftKey) doRedo();
                else doUndo();
                return;
            }
            if (meta && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
                e.preventDefault();
                doRedo();
                return;
            }
            if (meta && e.key === 'c') {
                const refs = refsForSelection(doc, selectedIds);
                const entities = [];
                for (const r of refs) {
                    const L = allLayersFlat(doc).find((l) => l.id === r.layerId);
                    const ent = L?.entities.find((x) => x.id === r.entityId);
                    if (ent) entities.push(ent);
                }
                if (entities.length) {
                    e.preventDefault();
                    clipboardRef.current = entities.map((x) => JSON.parse(JSON.stringify(x)));
                    pasteRepeatColRef.current = 0;
                    setStatusLine(`Copied ${entities.length} shape(s)`);
                }
                return;
            }
            if (meta && e.key === 'v') {
                const templates = clipboardRef.current;
                if (!templates?.length) return;
                const layer = activeLayer(doc);
                if (!layer || layer.locked) return;
                e.preventDefault();
                let union = null;
                for (const t of templates) {
                    const b = resolvedEntityBBox(doc, t);
                    if (b) union = unionBBoxMems(union, b);
                }
                const w = union ? Math.max(0.01, union.maxX - union.minX) : 100;
                const col = pasteRepeatColRef.current;
                const dx = (col + 1) * (w + MEMS_PASTE_STREET_UM);
                pasteRepeatColRef.current = col + 1;
                commitDoc((d) => pasteEntityCopies(d, layer.id, templates, { dx, dy: 0 }), true);
                setSelectedIds(new Set());
                setStatusLine(
                    `Pasted ${templates.length} shape(s) · wafer column ${col + 1} (+${dx.toFixed(1)} µm)`
                );
                return;
            }
            if (e.altKey && e.shiftKey && !meta) {
                const t = e.target;
                if (
                    t &&
                    (t.tagName === 'INPUT' ||
                        t.tagName === 'TEXTAREA' ||
                        t.tagName === 'SELECT' ||
                        t.isContentEditable)
                )
                    return;
                const lk = e.key.toLowerCase();
                if (lk === 'u' || lk === 'i' || lk === 's' || lk === 'x') {
                    if (selectedIds.size < 2) {
                        setStatusLine(
                            lk === 's'
                                ? 'Subtract: Alt+Shift+S — pick subject first, then cutters (Shift)'
                                : 'Boolean: Alt+Shift+U/I/X — select ≥2 shapes (Shift sets pick order)'
                        );
                        return;
                    }
                    const map = {
                        u: 'union',
                        i: 'intersection',
                        s: 'difference',
                        x: 'xor',
                    };
                    const op = map[lk];
                    if (op) {
                        e.preventDefault();
                        applyBooleanOp(op);
                    }
                    return;
                }
            }
            if (e.key === 'Escape') {
                setPolygonPoints(null);
                setPolygonRubberTip(null);
                setPolygonSnapPxHover(null);
                setPolygonDraftSegIndex(null);
                setPolygonCtxMenu(null);
                setPolygonConstraintMode('free');
                polygonDblRef.current = null;
                setPathPoints(null);
                setLineChain(null);
                setLineStart(null);
                setLineDraftEnd(null);
                setLineSnapHover(null);
                setMarqueeStart(null);
                setMarqueeBox(null);
                setDragStart(null);
                setDraftRect(null);
                setMeasureA(null);
                setMeasureB(null);
                setStatusLine('');
                return;
            }
            if (
                tool === 'polygon' &&
                !meta &&
                (e.key === '1' || e.key === '2' || e.key === '3')
            ) {
                const t = e.target;
                if (
                    t &&
                    (t.tagName === 'INPUT' ||
                        t.tagName === 'TEXTAREA' ||
                        t.tagName === 'SELECT' ||
                        t.isContentEditable)
                )
                    return;
                e.preventDefault();
                const mode = e.key === '1' ? 'free' : e.key === '2' ? 'hv' : '45';
                setPolygonConstraintMode(mode);
                setStatusLine(`Polygon constraint: ${mode === 'free' ? 'free angle' : mode === 'hv' ? 'H/V (Shift also)' : '45° steps'}`);
                return;
            }
            if (
                ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) &&
                !meta
            ) {
                const t = e.target;
                if (
                    t &&
                    (t.tagName === 'INPUT' ||
                        t.tagName === 'TEXTAREA' ||
                        t.tagName === 'SELECT' ||
                        t.isContentEditable)
                )
                    return;
                const refs = refsMovable(doc, refsForSelection(doc, selectedIds));
                if (!refs.length) return;
                e.preventDefault();
                const step = nudgeStepUm * (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1);
                let dx = 0;
                let dy = 0;
                if (e.key === 'ArrowLeft') dx = -step;
                if (e.key === 'ArrowRight') dx = step;
                if (e.key === 'ArrowUp') dy = -step;
                if (e.key === 'ArrowDown') dy = step;
                commitDoc((d) => translateSelection(d, refs, dx, dy), true);
                setStatusLine(`Nudge Δ ${dx.toFixed(4)}, ${dy.toFixed(4)} µm`);
                return;
            }
            if (e.key === 'Enter' && tool === 'line' && lineChain) {
                const svgEl = svgRef.current;
                const closeTol = chainCloseTolUm(snapTolUm);
                const lp = lastPointerGlobalRef.current;
                const nearFirst =
                    lp &&
                    lineChain.vertices.length >= 3 &&
                    Math.hypot(lp.x - lineChain.first.x, lp.y - lineChain.first.y) <= closeTol;
                if (nearFirst) {
                    e.preventDefault();
                    const layer = activeLayer(doc);
                    if (layer && !layer.locked) {
                        const ids = lineChain.segmentIds;
                        const verts = lineChain.vertices.map((p) => ({ x: p.x, y: p.y }));
                        commitDoc((d) => {
                            let next = deleteEntitiesByIds(d, ids);
                            return addPolygon(next, layer.id, verts);
                        }, true);
                        setLineChain(null);
                        setLineStart(null);
                        setLineDraftEnd(null);
                        setLineSnapHover(null);
                        setSelectedIds(new Set());
                        setStatusLine(`Polygon closed · ${verts.length} vertices`);
                    }
                    return;
                }
                if (lineChain.segmentIds.length >= 1) {
                    e.preventDefault();
                    setLineChain(null);
                    setLineStart(null);
                    setLineDraftEnd(null);
                    setLineSnapHover(null);
                    setStatusLine('Open chain finished — line segments kept');
                    return;
                }
            }
            const polyPts = polygonPointsRef.current;
            const pathPts = pathPointsRef.current;
            if (e.key === 'Enter' && tool === 'path' && pathPts && pathPts.length >= 2) {
                e.preventDefault();
                const layer = activeLayer(doc);
                if (layer && !layer.locked) {
                    commitDoc((d) => addPath(d, layer.id, pathPts), true);
                    setPathPoints(null);
                    setStatusLine('');
                }
                return;
            }
            if (e.key === 'Enter' && tool === 'polygon' && polyPts && polyPts.length >= 3) {
                e.preventDefault();
                finalizePolygonFromDraft(polyPts);
                return;
            }
            if (e.key === 'Backspace') {
                if (tool === 'line' && lineChain?.segmentIds?.length) {
                    e.preventDefault();
                    const lastId = lineChain.segmentIds[lineChain.segmentIds.length - 1];
                    const newSeg = lineChain.segmentIds.slice(0, -1);
                    const newVerts = lineChain.vertices.slice(0, -1);
                    const anchor = newVerts[newVerts.length - 1];
                    commitDoc((d) => deleteEntitiesByIds(d, [lastId]), true);
                    setLineChain((prev) =>
                        prev
                            ? {
                                  ...prev,
                                  vertices: newVerts,
                                  segmentIds: newSeg,
                              }
                            : prev
                    );
                    if (anchor) {
                        setLineStart({ x: anchor.x, y: anchor.y });
                        setLineDraftEnd({ x: anchor.x, y: anchor.y });
                    } else {
                        setLineStart(null);
                        setLineDraftEnd(null);
                    }
                    setStatusLine('Removed last segment from chain');
                    return;
                }
                if (tool === 'path' && pathPts && pathPts.length > 0) {
                    e.preventDefault();
                    setPathPoints((prev) => (prev && prev.length > 1 ? prev.slice(0, -1) : null));
                    return;
                }
                if (tool === 'polygon' && polyPts && polyPts.length > 0) {
                    e.preventDefault();
                    setPolygonPoints((prev) => (prev && prev.length > 1 ? prev.slice(0, -1) : null));
                    return;
                }
            }
            if (e.key === 'Delete' || e.key === 'Backspace') {
                const ids = removableEntityIds(doc, selectedIds);
                if (ids.length === 0) return;
                e.preventDefault();
                commitDoc((d) => deleteEntitiesByIds(d, ids), true);
                setSelectedIds(new Set());
            }
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('keyup', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('keyup', onKey);
        };
    }, [
        doc,
        selectedIds,
        tool,
        lineChain,
        viewBox.w,
        doUndo,
        doRedo,
        commitDoc,
        nudgeStepUm,
        finalizePolygonFromDraft,
        applyBooleanOp,
    ]);

    const onWheel = useCallback(
        (ev) => {
            ev.preventDefault();
            if (!svgRef.current) return;
            const vb = viewBox;
            const z = ev.deltaY > 0 ? 1.08 : 1 / 1.08;
            const anchor = clientToWorld(svgRef.current, ev.clientX, ev.clientY, vb);
            let nw = vb.w * z;
            let nh = vb.h * z;
            nw = Math.max(50, Math.min(dieWidthUm(doc) * 4, nw));
            nh = Math.max(50, Math.min(dieHeightUm(doc) * 4, nh));
            const fx = (anchor.x - vb.x) / vb.w;
            const fy = (anchor.y - vb.y) / vb.h;
            const nx = anchor.x - fx * nw;
            const ny = anchor.y - fy * nh;
            setViewBox({ x: nx, y: ny, w: nw, h: nh });
        },
        [viewBox, doc]
    );

    const exportJson = useCallback(() => {
        const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const stem = projectName(doc).replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '') || 'mems_mask';
        a.download = `${stem}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        setStatusLine('Downloaded JSON to your computer');
    }, [doc]);

    const saveToWorkspace = useCallback(async () => {
        if (!onSaveJsonToWorkspace) {
            window.alert('Workspace save is not wired in this view.');
            return;
        }
        try {
            const stem = projectName(doc).replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '') || 'mems_mask';
            const fileName = buildMemsWorkspaceFileName(stem, memsWorkspaceSaveSubpath);
            const res = await onSaveJsonToWorkspace({
                folderName: MEMS_MASKS_WORKSPACE_FOLDER_NAME,
                fileName,
                json: doc,
                fileId: memsWorkspaceFileId || undefined,
            });
            if (res?.fileId) setMemsWorkspaceFileId(String(res.fileId));
            setStatusLine(
                res?.overwritten
                    ? `Workspace updated · ${MEMS_MASKS_WORKSPACE_FOLDER_NAME}/${fileName}`
                    : `Saved to workspace · ${MEMS_MASKS_WORKSPACE_FOLDER_NAME}/${fileName}`
            );
        } catch (e) {
            window.alert(String(e?.message || e || 'Save to workspace failed'));
        }
    }, [doc, onSaveJsonToWorkspace, memsWorkspaceFileId, memsWorkspaceSaveSubpath]);

    const downloadMemsWorkspaceFolderZip = useCallback(async () => {
        if (!Array.isArray(workspaceFiles) || workspaceFiles.length === 0) {
            window.alert('No workspace files are loaded.');
            return;
        }
        setMemsZipExportBusy(true);
        try {
            await downloadMemsMasksFolderJsonZip(workspaceFiles);
            setStatusLine('Downloaded mems_masks/ from workspace as a ZIP on your computer');
        } catch (e) {
            window.alert(String(e?.message || e));
        } finally {
            setMemsZipExportBusy(false);
        }
    }, [workspaceFiles]);

    const memsWorkspaceEntries = useMemo(() => {
        if (!Array.isArray(workspaceFiles) || workspaceFiles.length === 0) return [];
        const folders = workspaceFiles.filter(
            (f) =>
                f.isFolder &&
                String(f.name).toLowerCase() === MEMS_MASKS_WORKSPACE_FOLDER_NAME.toLowerCase()
        );
        const folderIds = new Set(folders.map((f) => String(f.id)));
        return workspaceFiles.filter(
            (f) =>
                !f.isFolder &&
                folderIds.has(String(f.folderId)) &&
                /\.json$/i.test(String(f.name || '')) &&
                isMemsMaskWorkspaceDocJson(f.data)
        );
    }, [workspaceFiles]);

    const applyLoadedDoc = useCallback(
        (nextDoc, opts = {}) => {
            const { workspaceId = null, clearWorkspaceLink = false } = opts;
            const expanded = expandProjectDieToCoverActiveCellContent(nextDoc);
            setDoc(expanded);
            setSelectedIds(new Set());
            selectionOrderRef.current = [];
            undoRef.current.clear();
            setViewBox(viewBoxToFitActiveCellContent(expanded));
            if (clearWorkspaceLink) setMemsWorkspaceFileId(null);
            else if (workspaceId != null) setMemsWorkspaceFileId(String(workspaceId));
            setWorkspacePickerOpen(false);
            setNewDesignModalOpen(false);
            setLineChain(null);
            setLineStart(null);
            setLineDraftEnd(null);
            setLineSnapHover(null);
            setPolygonPoints(null);
            setPolygonRubberTip(null);
            setPolygonSnapPxHover(null);
            setPolygonDraftSegIndex(null);
            setPolygonCtxMenu(null);
            setPolygonConstraintMode('free');
            polygonDblRef.current = null;
        },
        []
    );

    const loadDocFromWorkspaceFile = useCallback(
        (f) => {
            if (!f?.data || !isMemsMaskWorkspaceDocJson(f.data)) {
                window.alert('Not a valid MEMS mask document.');
                return;
            }
            try {
                const next = migrateMemsMaskDoc(f.data);
                applyLoadedDoc(next, { workspaceId: f.id });
                setStatusLine(`Opened “${f.name}” from workspace — use Save to workspace to update this file`);
            } catch {
                window.alert('Could not load this workspace file.');
            }
        },
        [applyLoadedDoc]
    );

    const commitNewDesignFromModal = useCallback(() => {
        const pn = String(newDesignProjectName || '').trim();
        if (!pn) {
            window.alert('Enter a design name.');
            return;
        }
        const lib = String(newDesignLibraryName || '').trim() || 'Unit';
        const next = newMemsMaskDesignDoc({
            projectName: pn,
            libraryMasterName: lib,
            placeFirstInstance: newDesignPlaceInstance,
        });
        applyLoadedDoc(next, { clearWorkspaceLink: true });
        setNewDesignModalOpen(false);
        setStatusLine(
            newDesignPlaceInstance
                ? `New design “${pn}” · library “${lib}” · starter instance on Root`
                : `New design “${pn}” · library “${lib}” — use Place instance when ready`
        );
    }, [
        applyLoadedDoc,
        newDesignProjectName,
        newDesignLibraryName,
        newDesignPlaceInstance,
    ]);

    const importJson = useCallback(
        (file) => {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const next = migrateMemsMaskDoc(JSON.parse(String(reader.result)));
                    applyLoadedDoc(next, { clearWorkspaceLink: true });
                    setStatusLine('Imported JSON from disk (not linked to a workspace row)');
                } catch {
                    window.alert('Could not parse MEMS mask JSON.');
                }
            };
            reader.readAsText(file);
        },
        [applyLoadedDoc]
    );

    const exportGds = useCallback(() => {
        const bytes = exportMemsDocToGds(doc);
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${projectName(doc).replace(/[^\w-]+/g, '_')}.gds`;
        a.click();
        URL.revokeObjectURL(a.href);
        const audit = validateFabricRoundTrip(doc, exportMemsDocToGds, importGdsToMemsDoc);
        if (!audit.ok) {
            window.alert(`GDS export audit failed — do not use this file for fabrication until fixed:\n\n${audit.errors.join('\n')}`);
        } else if (audit.warnings.length) {
            setStatusLine(`GDS exported · audit OK (${audit.warnings.length} warnings)`);
        } else {
            setStatusLine('GDS exported · audit OK');
        }
    }, [doc]);

    const exportDxf = useCallback(() => {
        const text = exportMemsDocToDxf(doc);
        const blob = new Blob([text], { type: 'application/dxf' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${projectName(doc).replace(/[^\w-]+/g, '_')}.dxf`;
        a.click();
        URL.revokeObjectURL(a.href);
        const audit = validateFabricRoundTrip(
            doc,
            (d) => new TextEncoder().encode(exportMemsDocToDxf(d)),
            (ab) => importDxfToMemsDoc(new TextDecoder().decode(ab))
        );
        if (!audit.ok) {
            window.alert(`DXF export audit failed:\n\n${audit.errors.join('\n')}`);
        } else if (audit.warnings.length) {
            setStatusLine(`DXF exported · audit OK (${audit.warnings.length} warnings)`);
        } else {
            setStatusLine('DXF exported · audit OK');
        }
    }, [doc]);

    const importFabFile = useCallback(
        (file) => {
            const name = (file?.name || '').toLowerCase();
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    if (name.endsWith('.gds')) {
                        const buf = reader.result;
                        const next = importGdsToMemsDoc(
                            buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer
                        );
                        const expanded = expandProjectDieToCoverActiveCellContent(next);
                        setDoc(expanded);
                        setMemsWorkspaceFileId(null);
                        setViewBox(viewBoxToFitActiveCellContent(expanded));
                    } else if (name.endsWith('.dxf')) {
                        const next = importDxfToMemsDoc(String(reader.result));
                        const expanded = expandProjectDieToCoverActiveCellContent(next);
                        setDoc(expanded);
                        setMemsWorkspaceFileId(null);
                        setViewBox(viewBoxToFitActiveCellContent(expanded));
                    } else {
                        window.alert('Choose a .gds or .dxf file.');
                        return;
                    }
                    setSelectedIds(new Set());
                    selectionOrderRef.current = [];
                    undoRef.current.clear();
                    setStatusLine(name.endsWith('.gds') ? 'Imported GDSII' : 'Imported DXF');
                } catch (err) {
                    window.alert(String(err?.message || err));
                }
            };
            if (name.endsWith('.gds')) reader.readAsArrayBuffer(file);
            else reader.readAsText(file);
        },
        []
    );

    const gridLines = useMemo(() => {
        if (!showGrid) return null;
        const step = Math.max(50, Math.round(Math.min(viewBox.w, viewBox.h) / 12 / 50) * 50 || 50);
        const minX = viewBox.x;
        const maxX = viewBox.x + viewBox.w;
        const minY = viewBox.y;
        const maxY = viewBox.y + viewBox.h;
        const lines = [];
        for (let x = Math.ceil(minX / step) * step; x <= maxX + 1e-6; x += step) {
            lines.push(
                <line
                    key={`gx-${x}`}
                    x1={x}
                    y1={minY}
                    x2={x}
                    y2={maxY}
                    className="mems-grid-line"
                />
            );
        }
        for (let y = Math.ceil(minY / step) * step; y <= maxY + 1e-6; y += step) {
            lines.push(
                <line
                    key={`gy-${y}`}
                    x1={minX}
                    y1={y}
                    x2={maxX}
                    y2={y}
                    className="mems-grid-line"
                />
            );
        }
        return lines;
    }, [showGrid, viewBox.x, viewBox.y, viewBox.w, viewBox.h]);

    const rulerTicks = useMemo(() => {
        const ou = userOriginUm(doc);
        const stepX = niceStepUm(viewBox.w, 10);
        const stepY = niceStepUm(viewBox.h, 10);
        const xt = [];
        const yt = [];
        let x = Math.ceil(viewBox.x / stepX) * stepX;
        const maxX = viewBox.x + viewBox.w;
        while (x <= maxX + stepX * 0.01) {
            xt.push(x);
            x += stepX;
        }
        let y = Math.ceil(viewBox.y / stepY) * stepY;
        const maxY = viewBox.y + viewBox.h;
        while (y <= maxY + stepY * 0.01) {
            yt.push(y);
            y += stepY;
        }
        return { xt, yt, oux: ou.x, ouy: ou.y };
    }, [viewBox, doc]);

    const guidesSvg = useMemo(() => {
        if (!showGuideLines) return null;
        const dh = dieHeightUm(doc);
        const dw = dieWidthUm(doc);
        const hx = dw / 2;
        const hy = dh / 2;
        const sw = overlayStrokeUm * 0.48;
        const els = [];
        for (const gx of guides.v) {
            if (gx < -hx || gx > hx) continue;
            els.push(
                <line
                    key={`gv-${gx}`}
                    x1={gx}
                    y1={-hy}
                    x2={gx}
                    y2={hy}
                    className="mems-guide-line mems-guide-line--v"
                    strokeWidth={sw}
                />
            );
        }
        for (const gy of guides.h) {
            if (gy < -hy || gy > hy) continue;
            els.push(
                <line
                    key={`gh-${gy}`}
                    x1={-hx}
                    y1={gy}
                    x2={hx}
                    y2={gy}
                    className="mems-guide-line mems-guide-line--h"
                    strokeWidth={sw}
                />
            );
        }
        return els.length ? <g pointerEvents="none">{els}</g> : null;
    }, [showGuideLines, guides, overlayStrokeUm, doc]);

    const measureSvg = useMemo(() => {
        if (!measureA || !measureB) return null;
        const sw = overlayStrokeUm * 1.05;
        const dotR = Math.max(5, viewBox.w / 240);
        const dotStroke = overlayStrokeUm * 0.55;
        const d = Math.hypot(measureB.x - measureA.x, measureB.y - measureA.y);
        const mx = (measureA.x + measureB.x) / 2;
        const my = (measureA.y + measureB.y) / 2;
        const du = projectDisplayUnit(doc);
        const label = `${d.toFixed(3)} µm · ${formatLengthUm(d, du, 5)} ${unitSuffix(du)}`;
        const fs = Math.max(10, viewBox.w / 180);
        return (
            <g pointerEvents="none">
                <line
                    x1={measureA.x}
                    y1={measureA.y}
                    x2={measureB.x}
                    y2={measureB.y}
                    stroke="#fbbf24"
                    strokeWidth={sw}
                    strokeDasharray="6 4"
                />
                <circle
                    cx={measureA.x}
                    cy={measureA.y}
                    r={dotR}
                    fill="#fbbf24"
                    stroke="#0f172a"
                    strokeWidth={dotStroke}
                />
                <circle
                    cx={measureB.x}
                    cy={measureB.y}
                    r={dotR}
                    fill="#fbbf24"
                    stroke="#0f172a"
                    strokeWidth={dotStroke}
                />
                <text
                    x={mx}
                    y={my - Math.max(8, viewBox.w / 150)}
                    fill="#fef3c7"
                    fontSize={fs}
                    textAnchor="middle"
                    stroke="#0f172a"
                    strokeWidth={0.35}
                    paintOrder="stroke"
                >
                    {label}
                </text>
            </g>
        );
    }, [measureA, measureB, viewBox.w, doc, overlayStrokeUm]);

    const polygonPreview = useMemo(() => {
        if (!polygonPoints || polygonPoints.length === 0) return null;
        const tail =
            polygonRubberTip && polygonPoints.length >= 1
                ? [...polygonPoints, polygonRubberTip]
                : polygonPoints;
        const ptsStr = tail.map((p) => `${p.x},${p.y}`).join(' ');
        return (
            <polyline
                points={ptsStr}
                fill="none"
                stroke="#f472b6"
                strokeWidth={overlayStrokeUm}
                strokeDasharray="8 6"
            />
        );
    }, [polygonPoints, polygonRubberTip, overlayStrokeUm]);

    const marqueeSvg =
        marqueeBox && marqueeBox.maxX > marqueeBox.minX && marqueeBox.maxY > marqueeBox.minY ? (
            <rect
                x={marqueeBox.minX}
                y={marqueeBox.minY}
                width={marqueeBox.maxX - marqueeBox.minX}
                height={marqueeBox.maxY - marqueeBox.minY}
                fill="rgba(248,250,252,0.06)"
                stroke="#94a3b8"
                strokeWidth={overlayStrokeUm}
                strokeDasharray="6 4"
                pointerEvents="none"
            />
        ) : null;

    const inspectorEntityId = useMemo(
        () => (selectedIds.size === 1 ? [...selectedIds][0] : null),
        [selectedIds]
    );

    const pathPreview = useMemo(() => {
        if (!pathPoints || pathPoints.length === 0) return null;
        const ptsStr = pathPoints.map((p) => `${p.x},${p.y}`).join(' ');
        return (
            <polyline
                points={ptsStr}
                fill="none"
                stroke="#fb923c"
                strokeWidth={overlayStrokeUm}
                strokeDasharray="6 5"
            />
        );
    }, [pathPoints, overlayStrokeUm]);

    const lineDraftSvg =
        lineStart && lineDraftEnd ? (
            <line
                x1={lineStart.x}
                y1={lineStart.y}
                x2={lineDraftEnd.x}
                y2={lineDraftEnd.y}
                stroke="#f472b6"
                strokeWidth={overlayStrokeUm}
                strokeDasharray="8 6"
            />
        ) : null;

    const lineChainPreviewSvg = useMemo(() => {
        if (!lineChain?.vertices?.length || tool !== 'line') return null;
        const r = Math.max(2.5, viewBox.w / 380);
        const vtxStroke = overlayStrokeUm * 0.55;
        const draftPts =
            lineDraftEnd && lineStart
                ? [...lineChain.vertices, lineDraftEnd]
                : lineChain.vertices;
        const ptsStr = draftPts.map((p) => `${p.x},${p.y}`).join(' ');
        return (
            <g pointerEvents="none" className="mems-line-chain-preview">
                <polyline
                    points={ptsStr}
                    fill="none"
                    stroke="#f472b6"
                    strokeWidth={overlayStrokeUm}
                    strokeDasharray="6 5"
                    opacity={0.88}
                />
                {lineChain.vertices.map((p, i) => (
                    <circle
                        key={`lcv-${i}`}
                        cx={p.x}
                        cy={p.y}
                        r={r}
                        fill={i === 0 ? '#34d399' : '#f472b6'}
                        stroke="#0f172a"
                        strokeWidth={vtxStroke}
                    />
                ))}
            </g>
        );
    }, [lineChain, lineDraftEnd, lineStart, viewBox.w, tool, overlayStrokeUm]);

    const lineSnapHoverSvg =
        tool === 'line' && lineSnapHover ? (
            <circle
                cx={lineSnapHover.x}
                cy={lineSnapHover.y}
                r={Math.max(MEMS_SNAP_RING_R_MIN_UM, viewBox.w / 90)}
                fill="rgba(34, 211, 238, 0.14)"
                stroke="#22d3ee"
                strokeWidth={overlayStrokeUm * 1.15}
                pointerEvents="none"
            />
        ) : null;

    const polygonSnapHoverSvg =
        tool === 'polygon' && polygonSnapPxHover ? (
            <circle
                cx={polygonSnapPxHover.wx}
                cy={polygonSnapPxHover.wy}
                r={Math.max(MEMS_SNAP_RING_R_MIN_UM, viewBox.w / 90)}
                fill="rgba(34, 211, 238, 0.12)"
                stroke="#22d3ee"
                strokeWidth={overlayStrokeUm * 1.15}
                pointerEvents="none"
            />
        ) : null;

    const snapTargetPreviewSvg =
        snapTargetPreview && (snapEnabled || objectSnapEnabled || snapGuideEnabled) ? (
            <g pointerEvents="none" className="mems-snap-target-preview" aria-hidden>
                <circle
                    cx={snapTargetPreview.x}
                    cy={snapTargetPreview.y}
                    r={Math.max(MEMS_SNAP_RING_R_MIN_UM * 0.65, viewBox.w / 160)}
                    fill="none"
                    stroke={
                        snapTargetPreview.tier === SNAP_TIER_VERTEX
                            ? '#34d399'
                            : snapTargetPreview.tier === SNAP_TIER_FEATURE
                              ? '#38bdf8'
                              : snapTargetPreview.tier === SNAP_TIER_EDGE
                                ? '#fbbf24'
                                : snapTargetPreview.tier === SNAP_TIER_INTERSECTION
                                  ? '#fb923c'
                                  : snapTargetPreview.tier === SNAP_TIER_GUIDE
                                    ? '#c084fc'
                                    : '#94a3b8'
                    }
                    strokeWidth={overlayStrokeUm * 1.2}
                    opacity={0.95}
                />
                <line
                    x1={snapTargetPreview.x - 6}
                    y1={snapTargetPreview.y}
                    x2={snapTargetPreview.x + 6}
                    y2={snapTargetPreview.y}
                    stroke="rgba(248,250,252,0.92)"
                    strokeWidth={overlayStrokeUm * 0.65}
                />
                <line
                    x1={snapTargetPreview.x}
                    y1={snapTargetPreview.y - 6}
                    x2={snapTargetPreview.x}
                    y2={snapTargetPreview.y + 6}
                    stroke="rgba(248,250,252,0.92)"
                    strokeWidth={overlayStrokeUm * 0.65}
                />
            </g>
        ) : null;

    const selectionDecor = useMemo(() => {
        if (!inspectorEntityId) return null;
        const hit = findEntity(doc, inspectorEntityId);
        if (!hit) return null;
        const b = resolvedEntityBBox(doc, hit.entity);
        if (!b) return null;
        const hw = selectionOverlayStrokeUm;
        const { x: cx } = centroidFromBBox(b);
        const rotY = b.minY - Math.max(24, viewBox.w / 60);
        const e = hit.entity;
        const isInst = e.type === 'instance';
        const outlineStroke = isInst ? '#fbbf24' : '#f8fafc';
        const dash = isInst ? '10 6' : '5 4';
        const canResize =
            !isInst && !(e.rotationDeg || 0) && (e.type === 'rect' || e.type === 'ellipse');
        const handleR = Math.max(5, viewBox.w / 130);
        const hStroke = overlayStrokeUm * 0.55;
        return (
            <g pointerEvents="none">
                <rect
                    x={b.minX}
                    y={b.minY}
                    width={b.maxX - b.minX}
                    height={b.maxY - b.minY}
                    fill="none"
                    stroke={outlineStroke}
                    strokeDasharray={dash}
                    strokeWidth={hw}
                    opacity={0.95}
                />
                <circle
                    cx={cx}
                    cy={rotY}
                    r={handleR}
                    fill="#fbbf24"
                    stroke="#0f172a"
                    strokeWidth={hStroke}
                />
                {canResize && (
                    <circle
                        cx={b.maxX}
                        cy={b.maxY}
                        r={handleR}
                        fill="#38bdf8"
                        stroke="#0f172a"
                        strokeWidth={hStroke}
                    />
                )}
                {e.type === 'polygon' && e.points && e.points.length >= 2 && (
                    <>
                        {e.points.map((p, i) => {
                            const vr = Math.max(2.5, viewBox.w / 380);
                            return (
                                <circle
                                    key={`sel-poly-v-${i}`}
                                    cx={p.x}
                                    cy={p.y}
                                    r={vr}
                                    fill="#38bdf8"
                                    stroke="#0f172a"
                                    strokeWidth={hStroke}
                                    opacity={0.95}
                                />
                            );
                        })}
                        {e.points.map((p, i) => {
                            const q = e.points[(i + 1) % e.points.length];
                            const vr = Math.max(2.5, viewBox.w / 380);
                            const mx = (p.x + q.x) / 2;
                            const my = (p.y + q.y) / 2;
                            return (
                                <circle
                                    key={`sel-poly-m-${i}`}
                                    cx={mx}
                                    cy={my}
                                    r={vr * 0.82}
                                    fill="#fbbf24"
                                    stroke="#0f172a"
                                    strokeWidth={hStroke}
                                    opacity={0.88}
                                />
                            );
                        })}
                    </>
                )}
            </g>
        );
    }, [doc, inspectorEntityId, viewBox.w, selectionOverlayStrokeUm, overlayStrokeUm]);

    const renderEntity = useCallback((layer, e, opts = {}) => {
        const ghost = !!opts.ghost;
        const rk = opts.reactKey ?? e.id;
        if (e.type === 'instance') return null;
        const sel = !ghost && selectedIds.has(e.id);
        const stroke = ghost ? '#64748b' : sel ? '#f8fafc' : layer.color;
        const hair = memsHairlineOutline;
        /** Outline only when needed — avoids AA “halo” that reads like a thick pixel stroke when zoomed out. */
        const showEdge = hair || ghost || sel;
        const outlineUm = hair
            ? MEMS_HAIRLINE_OUTLINE_UM
            : ghost
              ? MEMS_DEFAULT_OUTLINE_UM * 0.88
              : sel
                ? MEMS_SELECTED_OUTLINE_UM
                : MEMS_DEFAULT_OUTLINE_UM;
        const cursor = tool === 'select' ? 'pointer' : 'crosshair';
        const fillOp = ghost ? 0.12 : sel ? 0.62 : 0.88;
        const common = {
            fill: layer.color,
            fillOpacity: fillOp,
            stroke: showEdge ? stroke : 'none',
            strokeWidth: showEdge ? outlineUm : 0,
            strokeDasharray: ghost ? '5 4' : undefined,
            vectorEffect: 'none',
            style: { cursor: ghost ? 'default' : cursor },
        };
        if (e.type === 'rect') {
            const cx = e.x + e.width / 2;
            const cy = e.y + e.height / 2;
            const deg = e.rotationDeg || 0;
            const r = (
                <rect
                    {...common}
                    x={e.x}
                    y={e.y}
                    width={e.width}
                    height={e.height}
                />
            );
            if (!deg) return <g key={rk}>{r}</g>;
            return (
                <g key={rk} transform={`rotate(${deg}, ${cx}, ${cy})`}>
                    {r}
                </g>
            );
        }
        if (e.type === 'polygon') {
            const outer = e.points || [];
            const holes = e.holes || [];
            if (holes.length) {
                const d = ringsToPathD([outer, ...holes]);
                return (
                    <path
                        key={rk}
                        {...common}
                        d={d}
                        fillRule="evenodd"
                    />
                );
            }
            const pts = outer.map((p) => `${p.x},${p.y}`).join(' ');
            return <polygon key={rk} {...common} points={pts} />;
        }
        if (e.type === 'ellipse') {
            const deg = e.rotationDeg || 0;
            const el = (
                <ellipse
                    {...common}
                    cx={e.cx}
                    cy={e.cy}
                    rx={e.rx}
                    ry={e.ry}
                />
            );
            if (!deg) return <g key={rk}>{el}</g>;
            return (
                <g key={rk} transform={`rotate(${deg}, ${e.cx}, ${e.cy})`}>
                    {el}
                </g>
            );
        }
        if (e.type === 'line') {
            const halfBand = hair
                ? MEMS_HAIRLINE_OUTLINE_UM / 2
                : MEMS_DEFAULT_LINE_BAND_UM / 2;
            const d = segmentToQuadPathD(e.x1, e.y1, e.x2, e.y2, halfBand);
            if (!d) return null;
            const rimW = sel && !ghost ? MEMS_SELECTED_OUTLINE_UM * 0.45 : 0;
            return (
                <path
                    key={rk}
                    d={d}
                    fill={layer.color}
                    fillOpacity={ghost ? 0.12 : 0.88}
                    vectorEffect="none"
                    stroke={rimW > 0 ? '#f8fafc' : 'none'}
                    strokeWidth={rimW}
                    style={{ cursor: ghost ? 'default' : cursor }}
                />
            );
        }
        if (e.type === 'path') {
            const w = Number(e.widthUm);
            const half =
                Number.isFinite(w) && w > 0
                    ? w / 2
                    : hair
                      ? MEMS_HAIRLINE_OUTLINE_UM / 2
                      : MEMS_DEFAULT_LINE_BAND_UM / 2;
            const d = openPolylineToStrokeBandPathD(e.points || [], half);
            if (!d) return null;
            const rimW = sel && !ghost ? MEMS_SELECTED_OUTLINE_UM * 0.45 : 0;
            return (
                <path
                    key={rk}
                    d={d}
                    fill={layer.color}
                    fillOpacity={ghost ? 0.12 : 0.88}
                    fillRule="nonzero"
                    vectorEffect="none"
                    stroke={rimW > 0 ? '#f8fafc' : 'none'}
                    strokeWidth={rimW}
                    style={{ cursor: ghost ? 'default' : cursor }}
                />
            );
        }
        if (e.type === 'text') {
            const fs = Math.max(
                12,
                e.heightUm != null && e.heightUm > 0 ? e.heightUm : Math.max(80, viewBox.w / 35)
            );
            const deg = e.rotationDeg || 0;
            const txt = (
                <text
                    x={e.x}
                    y={e.y}
                    fill={ghost ? '#64748b' : stroke}
                    stroke="none"
                    fontSize={fs}
                    fontFamily="ui-sans-serif, system-ui, sans-serif"
                    transform={deg ? `rotate(${deg}, ${e.x}, ${e.y})` : undefined}
                    style={{ cursor: ghost ? 'default' : cursor }}
                    opacity={ghost ? 0.35 : 1}
                >
                    {e.text || ''}
                </text>
            );
            return <g key={rk}>{txt}</g>;
        }
        return null;
    }, [selectedIds, tool, memsHairlineOutline, viewBox.w]);

    const instanceGhostSvg = useMemo(() => {
        const layers = layoutLayers(doc);
        const libraryCell = doc.cells?.find((c) => c.kind === 'library');
        const nMask = Math.max(1, libraryCell?.layers?.length ?? 1);
        const out = [];
        let gk = 0;
        const ghostBudget = { remaining: MEMS_GHOST_MAX_ENTITIES };
        layerLoop: for (const layer of layers) {
            for (const inst of layer.entities) {
                if (inst.type !== 'instance') continue;
                if (ghostBudget.remaining <= 0) break layerLoop;
                const expanded = expandInstanceToWorldEntities(
                    doc,
                    inst,
                    MEMS_INSTANCE_MAX_DEPTH,
                    ghostBudget
                );
                for (const { entity: ge, masterLayerIndex } of expanded) {
                    const maskLi = Math.min(Math.max(0, masterLayerIndex), nMask - 1);
                    const maskLayer = layers[maskLi];
                    if (!maskLayer?.visible) continue;
                    const col = maskLayer.color ?? layer.color;
                    const fakeLayer = { ...layer, color: col };
                    const node = renderEntity(fakeLayer, ge, {
                        ghost: true,
                        reactKey: `ig-${inst.id}-${gk++}`,
                    });
                    if (node) out.push(node);
                }
                if (ghostBudget.remaining <= 0) break layerLoop;
            }
        }
        return (
            <g className="mems-instance-ghost" pointerEvents="none">
                {out}
            </g>
        );
    }, [doc, renderEntity]);

    useEffect(() => {
        drcWorkerRef.current = new Worker(new URL('../mems/memsDrcWorker.js', import.meta.url), { type: 'module' });
        
        drcWorkerRef.current.onmessage = (e) => {
            const { id, type, violations, stats, error } = e.data;
            if (id !== drcNextIdRef.current - 1) return; // Stale result
            
            if (type === 'success') {
                setDrcViolations(violations);
                setDrcStats(stats);
                const err = violations.filter((v) => v.severity === 'error').length;
                const warn = violations.filter((v) => v.severity === 'warning').length;
                setStatusLine(
                    `DRC: ${err} error(s), ${warn} warning(s) · ${(stats.durationMs ?? 0).toFixed(0)} ms`
                );
            } else {
                console.error(error);
                setStatusLine('DRC failed — see console');
                setDrcViolations([]);
                setDrcStats(null);
            }
            setDrcRunning(false);
        };
        
        return () => {
            if (drcWorkerRef.current) drcWorkerRef.current.terminate();
        };
    }, []);

    const runDrcNow = useCallback((overrideRuleSet) => {
        setDrcRunning(true);
        const rules = overrideRuleSet || drcRuleSet;
        const id = drcNextIdRef.current++;
        if (drcWorkerRef.current) {
            drcWorkerRef.current.postMessage({ id, doc, ruleSet: rules });
        } else {
            setDrcRunning(false);
        }
    }, [doc, drcRuleSet]);

    useEffect(() => {
        try {
            localStorage.setItem(MEMS_DRC_RULES_KEY, JSON.stringify(drcRuleSet));
        } catch {
            /* quota */
        }
    }, [drcRuleSet]);

    useEffect(() => {
        if (!drcRealtime) return;
        const t = window.setTimeout(() => runDrcNow(), 450);
        return () => window.clearTimeout(t);
    }, [doc, drcRealtime, drcRuleSet, runDrcNow]);

    const exportDrcRules = useCallback(() => {
        const blob = new Blob([JSON.stringify(drcRuleSet, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const base = (drcRuleSet.name || 'mems_drc_rules').replace(/[^\w-]+/g, '_');
        a.download = `${base}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    }, [drcRuleSet]);

    const importDrcRules = useCallback(
        (file) => {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const next = migrateDrcRuleSet(JSON.parse(String(reader.result)));
                    setDrcRuleSet(next);
                    setStatusLine(`Imported DRC rules “${next.name || 'rules'}”`);
                    runDrcNow(next);
                } catch {
                    window.alert('Could not parse DRC rules JSON.');
                }
            };
            reader.readAsText(file);
        },
        [doc]
    );

    const onPickDrcViolation = useCallback(
        (id) => {
            setDrcHighlightId(id || null);
            const v = drcViolations.find((x) => x.id === id);
            if (!v) return;
            const dw = dieWidthUm(doc);
            const dh = dieHeightUm(doc);
            const hx = dw / 2;
            const hy = dh / 2;
            const pad = 60;
            if (v.bboxUm) {
                const bw = Math.max(v.bboxUm.maxX - v.bboxUm.minX, 1);
                const bh = Math.max(v.bboxUm.maxY - v.bboxUm.minY, 1);
                const side = Math.min(dw, dh, Math.max(bw, bh) * 2 + pad * 2);
                const cx = (v.bboxUm.minX + v.bboxUm.maxX) / 2;
                const cy = (v.bboxUm.minY + v.bboxUm.maxY) / 2;
                const w = Math.min(dw, side);
                const h = Math.min(dh, side);
                setViewBox({
                    x: Math.max(-hx, Math.min(hx - w, cx - w / 2)),
                    y: Math.max(-hy, Math.min(hy - h, cy - h / 2)),
                    w,
                    h,
                });
            } else {
                const side = Math.min(dw, dh, Math.max(viewBox.w * 0.2, 120));
                const w = Math.min(dw, side);
                const h = Math.min(dh, side);
                setViewBox({
                    x: Math.max(-hx, Math.min(hx - w, v.xUm - w / 2)),
                    y: Math.max(-hy, Math.min(hy - h, v.yUm - h / 2)),
                    w,
                    h,
                });
            }
        },
        [drcViolations, doc, viewBox.w]
    );

    const drcOverlaySvg = useMemo(() => {
        if (!drcViolations.length) return null;
        const sw = overlayStrokeUm * 1.05;
        const dotR = Math.max(4, viewBox.w / 300);
        return (
            <g className="mems-drc-overlay" pointerEvents="none">
                {drcViolations
                    .filter((v) => v.rule !== 'memsNote')
                    .map((v) => (
                    <g key={v.id}>
                        {v.bboxUm && (
                            <rect
                                x={v.bboxUm.minX}
                                y={v.bboxUm.minY}
                                width={v.bboxUm.maxX - v.bboxUm.minX}
                                height={v.bboxUm.maxY - v.bboxUm.minY}
                                fill="none"
                                stroke={v.severity === 'error' ? '#f87171' : '#fbbf24'}
                                strokeWidth={sw}
                                strokeDasharray="5 4"
                                opacity={drcHighlightId === v.id ? 0.95 : 0.4}
                            />
                        )}
                        <circle
                            cx={v.xUm}
                            cy={v.yUm}
                            r={dotR}
                            fill={v.severity === 'error' ? '#ef4444' : '#f59e0b'}
                            stroke="#0f172a"
                            strokeWidth={sw * 0.85}
                            opacity={drcHighlightId === v.id ? 1 : 0.55}
                        />
                    </g>
                ))}
            </g>
        );
    }, [drcViolations, viewBox.w, drcHighlightId, overlayStrokeUm]);

    const runAlign = useCallback(
        (mode) => {
            const refs = refsMovable(doc, refsForSelection(doc, selectedIds));
            if (refs.length < 2) {
                setStatusLine('Align: select at least 2 movable objects');
                return;
            }
            const deltas = computeAlignDeltas(doc, refs, mode);
            if (!deltas.length) return;
            commitDoc((d) => applyEntityMoves(d, deltas), true);
            setStatusLine(`Aligned (${mode})`);
        },
        [doc, selectedIds, commitDoc]
    );

    const runDistribute = useCallback(
        (axis, mode) => {
            const refs = refsMovable(doc, refsForSelection(doc, selectedIds));
            if (mode === 'even') {
                if (refs.length < 3) {
                    setStatusLine('Distribute: select at least 3 objects');
                    return;
                }
                const deltas = computeDistributeCenters(doc, refs, axis);
                if (!deltas.length) return;
                commitDoc((d) => applyEntityMoves(d, deltas), true);
                setStatusLine(`Distributed (${axis === 'h' ? 'horizontal' : 'vertical'} · even)`);
                return;
            }
            if (refs.length < 2) {
                setStatusLine('Distribute: select at least 2 objects');
                return;
            }
            const deltas = computeDistributeFixedGap(doc, refs, axis, distributeGapUm);
            if (!deltas.length) return;
            commitDoc((d) => applyEntityMoves(d, deltas), true);
            setStatusLine(
                `Distributed (${axis === 'h' ? 'horizontal' : 'vertical'} · gap ${distributeGapUm} µm)`
            );
        },
        [doc, selectedIds, commitDoc, distributeGapUm]
    );

    const exportFlattenedJson = useCallback(() => {
        const cell = activeCell(doc);
        const layers = flattenActiveCell(doc, { maxExpandedEntities: Number.MAX_SAFE_INTEGER });
        const payload = {
            kind: 'memsMaskFlattened',
            version: doc.version,
            activeCellId: doc.activeCellId,
            activeCellName: cell?.name,
            project: doc.project,
            layers,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const base = `${projectName(doc).replace(/[^\w-]+/g, '_')}_${(cell?.name || 'cell').replace(/[^\w-]+/g, '_')}`;
        a.download = `${base}_flattened.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    }, [doc]);

    return (
        <div className="mems-mask-studio">
            <header className="mems-mask-studio__header">
                <div className="mems-mask-studio__brand-row">
                    <div className="mems-mask-studio__title">
                        <ScanLine size={18} />
                        <span>MEMS Mask Studio</span>
                        <span className="mems-mask-studio__subtitle">
                            layout · canonical µm · display {unitSuffix(projectDisplayUnit(doc))}
                        </span>
                    </div>
                    <div className="mems-layout-controls" role="toolbar" aria-label="Side panels">
                        <button
                            type="button"
                            className={`mems-layout-chip${layersPanelOpen ? ' mems-layout-chip--active' : ''}`}
                            onClick={() => setLayersPanelOpen((v) => !v)}
                            title={layersPanelOpen ? 'Hide layers panel' : 'Show layers panel'}
                        >
                            <LayoutPanelLeft size={14} aria-hidden />
                            <span>Layers</span>
                        </button>
                        <button
                            type="button"
                            className={`mems-layout-chip${inspectorPanelOpen ? ' mems-layout-chip--active' : ''}`}
                            onClick={() => setInspectorPanelOpen((v) => !v)}
                            title={inspectorPanelOpen ? 'Hide properties panel' : 'Show properties panel'}
                        >
                            <PanelRight size={14} aria-hidden />
                            <span>Props</span>
                        </button>
                        <button
                            type="button"
                            className="mems-layout-chip mems-layout-chip--accent"
                            onClick={() => {
                                setLayersPanelOpen(false);
                                setInspectorPanelOpen(false);
                            }}
                            title="Hide both side panels to maximize the canvas"
                        >
                            <Maximize2 size={14} aria-hidden />
                            <span>Canvas</span>
                        </button>
                        <button
                            type="button"
                            className="mems-layout-chip"
                            onClick={() => {
                                setLayersPanelOpen(true);
                                setInspectorPanelOpen(true);
                            }}
                            title="Show layers and properties panels"
                        >
                            <span className="mems-layout-chip__pair" aria-hidden>
                                <ChevronsLeft size={13} />
                                <ChevronsRight size={13} />
                            </span>
                            <span>Both</span>
                        </button>
                    </div>
                </div>
                <div className="mems-mask-studio__tools">
                    <button
                        type="button"
                        className={`mems-tool-btn${tool === 'select' ? ' is-active' : ''}`}
                        onClick={() => setTool('select')}
                        title="Select · drag move · Shift marquee · middle mouse / Space+drag pan"
                    >
                        <MousePointer2 size={16} /> Select
                    </button>
                    <button
                        type="button"
                        className={`mems-tool-btn${tool === 'rect' ? ' is-active' : ''}`}
                        onClick={() => setTool('rect')}
                        title="Rectangle"
                    >
                        <Square size={16} /> Rect
                    </button>
                    <button
                        type="button"
                        className={`mems-tool-btn${tool === 'polygon' ? ' is-active' : ''}`}
                        onClick={() => {
                            setTool('polygon');
                            setPolygonPoints(null);
                            setPolygonRubberTip(null);
                            setPolygonSnapPxHover(null);
                            setPolygonDraftSegIndex(null);
                            setPolygonCtxMenu(null);
                            setPolygonConstraintMode('free');
                            polygonDblRef.current = null;
                            setPathPoints(null);
                        }}
                        title="Polygon — vertices · Enter or click first point to close"
                    >
                        <Pentagon size={16} /> Poly
                    </button>
                    <button
                        type="button"
                        className={`mems-tool-btn${tool === 'ellipse' ? ' is-active' : ''}`}
                        onClick={() => setTool('ellipse')}
                        title="Ellipse — bounding box drag"
                    >
                        <Circle size={16} /> Ellipse
                    </button>
                    <button
                        type="button"
                        className={`mems-tool-btn${tool === 'circle' ? ' is-active' : ''}`}
                        onClick={() => setTool('circle')}
                        title="Circle — square drag, equal radii"
                    >
                        <CircleDot size={16} /> Circle
                    </button>
                    <button
                        type="button"
                        className={`mems-tool-btn${tool === 'line' ? ' is-active' : ''}`}
                        onClick={() => {
                            setTool('line');
                            setLineStart(null);
                            setLineDraftEnd(null);
                        }}
                        title="Line — two clicks"
                    >
                        <Minus size={16} /> Line
                    </button>
                    <button
                        type="button"
                        className={`mems-tool-btn${tool === 'path' ? ' is-active' : ''}`}
                        onClick={() => {
                            setTool('path');
                            setPathPoints(null);
                        }}
                        title="Path (open polyline) — Enter to finish"
                    >
                        <PenLine size={16} /> Path
                    </button>
                    <button
                        type="button"
                        className={`mems-tool-btn${tool === 'measure' ? ' is-active' : ''}`}
                        onClick={() => {
                            setTool('measure');
                            setMeasureA(null);
                            setMeasureB(null);
                            setStatusLine('Measure · two clicks · Esc clears');
                        }}
                        title="Measure distance between two points (µm)"
                    >
                        <Ruler size={16} /> Measure
                    </button>
                    <div
                        className="mems-geom-cluster"
                        title={`Planar booleans (${MEMS_PLANAR_BOOLEAN_OPS.join(', ')}), offset & stroke→poly · nm grid`}
                    >
                        <span className="mems-geom-cluster__label">Geom</span>
                        <div
                            className="mems-geom-cluster__bools"
                            role="group"
                            aria-label="Polygon Boolean operations"
                        >
                            <button
                                type="button"
                                className="mems-tool-btn mems-tool-btn--bool"
                                disabled={selectedIds.size < 2}
                                onClick={() => applyBooleanOp('union')}
                                title="Union (∪): combine all selected shapes into one region. Alt+Shift+U"
                            >
                                <GitMerge size={14} aria-hidden />
                                <span className="mems-bool-label">Union</span>
                                <span className="mems-bool-sym" aria-hidden>
                                    ∪
                                </span>
                            </button>
                            <button
                                type="button"
                                className="mems-tool-btn mems-tool-btn--bool"
                                disabled={selectedIds.size < 2}
                                onClick={() => applyBooleanOp('intersection')}
                                title="Intersect (∩): region common to all selected shapes. Alt+Shift+I"
                            >
                                <Crop size={14} aria-hidden />
                                <span className="mems-bool-label">Intersect</span>
                                <span className="mems-bool-sym" aria-hidden>
                                    ∩
                                </span>
                            </button>
                            <button
                                type="button"
                                className="mems-tool-btn mems-tool-btn--bool"
                                disabled={selectedIds.size < 2}
                                onClick={() => applyBooleanOp('difference')}
                                title="Subtract (−): first picked shape minus union of the rest (Shift pick order). Alt+Shift+S"
                            >
                                <Diff size={14} aria-hidden />
                                <span className="mems-bool-label">Subtract</span>
                                <span className="mems-bool-sym" aria-hidden>
                                    −
                                </span>
                            </button>
                            <button
                                type="button"
                                className="mems-tool-btn mems-tool-btn--bool"
                                disabled={selectedIds.size < 2}
                                onClick={() => applyBooleanOp('xor')}
                                title="XOR (⊕): symmetric difference (exclusive OR). Alt+Shift+X"
                            >
                                <Layers2 size={14} aria-hidden />
                                <span className="mems-bool-label">XOR</span>
                                <span className="mems-bool-sym" aria-hidden>
                                    ⊕
                                </span>
                            </button>
                        </div>
                        <label className="mems-geom-cluster__offset">
                            <Expand size={13} aria-hidden />
                            <input
                                type="number"
                                step="0.001"
                                min="0"
                                value={geomOffsetUm}
                                onChange={(ev) => {
                                    const v = parseCommittedNumberInput(ev.target.value);
                                    if (v === null) return;
                                    setGeomOffsetUm(Math.max(0, v));
                                }}
                                title="Offset distance / path half-width (µm)"
                            />
                            <span className="mems-geom-cluster__um">µm</span>
                        </label>
                        <button
                            type="button"
                            className="mems-tool-btn"
                            disabled={selectedIds.size < 1}
                            onClick={() => applyOffsetGrowShrink(1)}
                            title="Grow (buffer) selected shapes by distance"
                        >
                            +
                        </button>
                        <button
                            type="button"
                            className="mems-tool-btn"
                            disabled={selectedIds.size < 1}
                            onClick={() => applyOffsetGrowShrink(-1)}
                            title="Shrink selected shapes by distance"
                        >
                            −
                        </button>
                        <button
                            type="button"
                            className="mems-tool-btn"
                            disabled={selectedIds.size < 1}
                            onClick={applyPathStrokeToPolygons}
                            title="Convert selected path(s) to filled polygons (half-width = distance)"
                        >
                            Path→▮
                        </button>
                        <label className="mems-geom-cluster__derived">
                            <input
                                type="checkbox"
                                checked={geomNewDerivedLayer}
                                onChange={(ev) => setGeomNewDerivedLayer(ev.target.checked)}
                            />{' '}
                            derived layer
                        </label>
                    </div>
                    <button
                        type="button"
                        className={`mems-tool-btn${snapEnabled ? ' is-active' : ''}`}
                        onClick={() => setSnapEnabled((s) => !s)}
                        title="Snap to construction grid (µm)"
                    >
                        Grid
                    </button>
                    <button
                        type="button"
                        className={`mems-tool-btn${objectSnapEnabled ? ' is-active' : ''}`}
                        onClick={() => setObjectSnapEnabled((s) => !s)}
                        title="Snap to geometry: vertices, edges, intersections (world µm)"
                    >
                        <Magnet size={15} />
                    </button>
                    <button
                        type="button"
                        className={`mems-tool-btn${snapGuideEnabled ? ' is-active' : ''}`}
                        onClick={() => setSnapGuideEnabled((s) => !s)}
                        title="Snap to layout guides (world µm)"
                    >
                        <Ruler size={15} />
                    </button>
                    <button type="button" className="mems-tool-btn" onClick={doUndo} title="Undo ⌘Z">
                        <Undo2 size={16} />
                    </button>
                    <button type="button" className="mems-tool-btn" onClick={doRedo} title="Redo ⌘⇧Z">
                        <Redo2 size={16} />
                    </button>
                    <button
                        type="button"
                        className="mems-tool-btn"
                        onClick={() => setShowGrid((g) => !g)}
                        title="Toggle grid"
                    >
                        <Grid3x3 size={16} /> Grid
                    </button>
                    <button
                        type="button"
                        className="mems-tool-btn"
                        onClick={() => setViewBox((vb) => ({ ...vb, w: vb.w * 0.85, h: vb.h * 0.85 }))}
                    >
                        <ZoomIn size={16} /> In
                    </button>
                    <button
                        type="button"
                        className="mems-tool-btn"
                        onClick={() => setViewBox((vb) => ({ ...vb, w: vb.w * 1.15, h: vb.h * 1.15 }))}
                    >
                        <ZoomOut size={16} /> Out
                    </button>
                    <button type="button" className="mems-tool-btn" onClick={fitView} title="Zoom to fit all geometry (layout cell + instances)">
                        <Maximize2 size={16} /> Fit
                    </button>
                    <button
                        type="button"
                        className="mems-tool-btn"
                        title="Interactive wafer map: diameter, optional GDS device, dicing grid"
                        onClick={() => setWaferWizardOpen(true)}
                    >
                        <Disc size={16} /> Wafer layout…
                    </button>
                    <button
                        type="button"
                        className="mems-tool-btn"
                        title="Start a named design with a library cell (and optional first instance)"
                        onClick={() => {
                            setNewDesignProjectName('My design');
                            setNewDesignLibraryName('Unit');
                            setNewDesignPlaceInstance(true);
                            setNewDesignModalOpen(true);
                        }}
                    >
                        <RotateCcw size={16} /> New design…
                    </button>
                    <button
                        type="button"
                        className="mems-tool-btn mems-tool-btn--primary"
                        onClick={() => void saveToWorkspace()}
                        disabled={!onSaveJsonToWorkspace}
                        title={`Save layout JSON to workspace folder “${MEMS_MASKS_WORKSPACE_FOLDER_NAME}/” using the optional subpath below (IndexedDB). Opens in the sidebar under that folder.`}
                    >
                        <HardDriveUpload size={16} /> Workspace
                    </button>
                    <button
                        type="button"
                        className="mems-tool-btn"
                        onClick={() => setWorkspacePickerOpen(true)}
                        disabled={!memsWorkspaceEntries.length}
                        title="Open a layout saved under mems_masks/ in the workspace"
                    >
                        <FolderOpen size={16} /> Open…
                    </button>
                    <button type="button" className="mems-tool-btn mems-tool-btn--primary" onClick={exportJson}>
                        <Download size={16} /> Download JSON
                    </button>
                    <button
                        type="button"
                        className="mems-tool-btn"
                        onClick={exportFlattenedJson}
                        title="Export active cell with instances resolved to primitive geometry"
                    >
                        <Layers2 size={16} /> Flattened
                    </button>
                    <button type="button" className="mems-tool-btn" onClick={() => fileImportRef.current?.click()}>
                        <Upload size={16} /> Import file
                    </button>
                    <input
                        ref={fileImportRef}
                        type="file"
                        accept=".json,application/json"
                        className="mems-file-input-hidden"
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (f) importJson(f);
                        }}
                    />
                    <button
                        type="button"
                        className="mems-tool-btn mems-tool-btn--primary"
                        onClick={exportGds}
                        title="Export Calma GDSII stream (with post-export audit)"
                    >
                        <Save size={16} /> GDS
                    </button>
                    <button
                        type="button"
                        className="mems-tool-btn"
                        onClick={exportDxf}
                        title="Export ASCII DXF (layers ↔ DXF layers, mm units)"
                    >
                        <ScanLine size={16} /> DXF
                    </button>
                    <button
                        type="button"
                        className="mems-tool-btn"
                        onClick={() => fileFabImportRef.current?.click()}
                        title="Import GDSII or DXF mask exchange file"
                    >
                        <Upload size={16} /> GDS/DXF
                    </button>
                    <input
                        ref={fileFabImportRef}
                        type="file"
                        accept=".gds,.dxf,application/octet-stream,text/plain"
                        className="mems-file-input-hidden"
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (f) importFabFile(f);
                        }}
                    />
                </div>
                <div className="mems-mask-studio__workspace-bar">
                    <label className="mems-workspace-path">
                        <span className="mems-workspace-path__label">Save under</span>
                        <input
                            type="text"
                            className="mems-workspace-path__input"
                            placeholder="Imports or Projects/RevA (optional)"
                            value={memsWorkspaceSaveSubpath}
                            onChange={(e) => setMemsWorkspaceSaveSubpath(e.target.value)}
                            title="Virtual folders: saved as mems_masks/<path>/<project>.json in the workspace"
                            spellCheck={false}
                        />
                    </label>
                    <button
                        type="button"
                        className="mems-tool-btn"
                        disabled={memsZipExportBusy}
                        onClick={() => void downloadMemsWorkspaceFolderZip()}
                        title="Download the whole mems_masks workspace folder as a .zip to your computer"
                    >
                        <Archive size={16} /> ZIP workspace
                    </button>
                </div>
            </header>

            <div className="mems-mask-studio__body">
                <aside
                    className={`mems-mask-studio__layers${!layersPanelOpen ? ' mems-mask-studio__layers--collapsed' : ''}`}
                >
                    {!layersPanelOpen ? (
                        <button
                            type="button"
                            className="mems-panel-expand mems-panel-expand--left"
                            onClick={() => setLayersPanelOpen(true)}
                            title="Show layers panel"
                            aria-label="Show layers panel"
                        >
                            <Layers size={20} strokeWidth={1.75} aria-hidden />
                            <ChevronsRight size={15} aria-hidden />
                        </button>
                    ) : (
                        <>
                            <div className="mems-layers-head">
                                <span className="mems-layers-head__label">
                                    <Layers size={14} aria-hidden /> Layers
                                </span>
                                <div className="mems-layers-head__actions">
                                    <button
                                        type="button"
                                        className="mems-icon-btn"
                                        onClick={() => setDoc((d) => addLayer(d))}
                                        title="Add layer"
                                        aria-label="Add layer"
                                    >
                                        <Plus size={16} />
                                    </button>
                                    <button
                                        type="button"
                                        className="mems-icon-btn"
                                        onClick={() => setLayersPanelOpen(false)}
                                        title="Collapse layers panel"
                                        aria-label="Collapse layers panel"
                                    >
                                        <ChevronsLeft size={16} />
                                    </button>
                                </div>
                            </div>
                    <div className="mems-cell-strip">
                        <label className="mems-cell-strip__label">
                            Active cell
                            <select
                                className="mems-cell-strip__select mems-ui-select"
                                value={doc.activeCellId || ''}
                                onChange={(ev) =>
                                    setDoc((d) => setActiveCell(d, ev.target.value))
                                }
                            >
                                {(doc.cells || []).map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {c.name}
                                        {c.kind === 'library' ? ' (library)' : ''}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <div className="mems-cell-strip__actions">
                            <button
                                type="button"
                                className="mems-cell-strip__btn"
                                title="Create a new library cell and switch to it"
                                onClick={() => {
                                    const name = window.prompt('New library cell name', 'Library cell');
                                    if (name === null) return;
                                    setDoc((d) => addLibraryCell(d, name || undefined));
                                    setSelectedIds(new Set());
                                    selectionOrderRef.current = [];
                                }}
                            >
                                <Plus size={12} /> New cell
                            </button>
                            <button
                                type="button"
                                className="mems-cell-strip__btn"
                                title="Place an instance of a cell on the active layer"
                                onClick={() => {
                                    const masters = (doc.cells || []).filter((c) => c.id !== doc.activeCellId);
                                    if (!masters.length) {
                                        setStatusLine('Create another cell first to place as instance');
                                        return;
                                    }
                                    const layerId = doc.activeLayerId;
                                    if (!layerId) {
                                        setStatusLine('Select a layer');
                                        return;
                                    }
                                    const optList = masters.map((c, i) => `${i + 1}. ${c.name} (${c.id.slice(0, 6)}…)`).join('\n');
                                    const choice = window.prompt(
                                        `Place instance — enter number:\n${optList}`,
                                        '1'
                                    );
                                    if (choice === null) return;
                                    const n = parseInt(choice, 10);
                                    if (!Number.isFinite(n) || n < 1 || n > masters.length) {
                                        setStatusLine('Invalid cell choice');
                                        return;
                                    }
                                    const master = masters[n - 1];
                                    setDoc((d) =>
                                        expandProjectDieToCoverActiveCellContent(
                                            addInstance(d, layerId, { masterCellId: master.id, x: 0, y: 0 })
                                        )
                                    );
                                    setStatusLine(`Placed instance of “${master.name}”`);
                                }}
                            >
                                <Expand size={12} /> Place instance
                            </button>
                        </div>
                    </div>
                    <div className="mems-precision-panel">
                        <div className="mems-sublabel">CAD precision</div>
                        <label className="mems-precision-field">
                            Snap tol (µm, world-space)
                            <input
                                type="number"
                                min={0.5}
                                step={0.5}
                                value={snapTolUm}
                                onChange={(e) => {
                                    const v = parseCommittedNumberInput(e.target.value);
                                    if (v === null) return;
                                    setSnapTolUm(Math.max(0.5, v));
                                }}
                            />
                        </label>
                        <label className="mems-precision-field">
                            Angle snap (°)
                            <input
                                type="number"
                                min={0}
                                step={1}
                                value={angleSnapDeg}
                                onChange={(e) => {
                                    const v = parseCommittedNumberInput(e.target.value);
                                    if (v === null) return;
                                    setAngleSnapDeg(Math.max(0, v));
                                }}
                                title="Alt while drawing line — snap to this increment; 0 = off"
                            />
                        </label>
                        <label className="mems-precision-field">
                            Arrow nudge (µm)
                            <input
                                type="number"
                                min={0.001}
                                step={0.1}
                                value={nudgeStepUm}
                                onChange={(e) => {
                                    const v = parseCommittedNumberInput(e.target.value);
                                    if (v === null) return;
                                    setNudgeStepUm(Math.max(0.001, v));
                                }}
                                title="Arrow keys · Shift×10 · Alt×0.1"
                            />
                        </label>
                        <label className="mems-precision-field">
                            Distribute gap (µm)
                            <input
                                type="number"
                                min={0}
                                step={0.5}
                                value={distributeGapUm}
                                onChange={(e) => {
                                    const v = parseCommittedNumberInput(e.target.value);
                                    if (v === null) return;
                                    setDistributeGapUm(Math.max(0, v));
                                }}
                            />
                        </label>
                        <label className="mems-precision-field" title="Ultra-thin outlines (world µm) for layer edges & debugging">
                            <input
                                type="checkbox"
                                checked={memsHairlineOutline}
                                onChange={(e) => {
                                    const v = e.target.checked;
                                    setMemsHairlineOutline(v);
                                    try {
                                        localStorage.setItem(MEMS_HAIRLINE_OUTLINE_KEY, v ? '1' : '0');
                                    } catch {
                                        /* quota */
                                    }
                                }}
                            />{' '}
                            Hairline outlines (debug)
                        </label>
                        <div className="mems-precision-toggle-row">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={showRulers}
                                    onChange={(e) => setShowRulers(e.target.checked)}
                                />{' '}
                                Rulers
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={showGuideLines}
                                    onChange={(e) => setShowGuideLines(e.target.checked)}
                                />{' '}
                                Guides
                            </label>
                        </div>
                        <div className="mems-origin-panel">
                            <div className="mems-sublabel">Origins</div>
                            <p className="mems-origin-hint">
                                <strong>Global</strong> — fixed layout frame (stored geometry, export, DRC).{' '}
                                <strong>User</strong> — movable origin for rulers, inspector, and readouts; does not change
                                fabrication files.
                            </p>
                            <div className="mems-origin-frame-row">
                                <label className="mems-radio-inline">
                                    <input
                                        type="radio"
                                        name="mems-coord-frame"
                                        checked={coordFrame === 'global'}
                                        onChange={() => setCoordFrame('global')}
                                    />{' '}
                                    Global
                                </label>
                                <label className="mems-radio-inline">
                                    <input
                                        type="radio"
                                        name="mems-coord-frame"
                                        checked={coordFrame === 'user'}
                                        onChange={() => setCoordFrame('user')}
                                    />{' '}
                                    User
                                </label>
                            </div>
                            <label className="mems-precision-field">
                                User origin X (global µm)
                                <input
                                    type="number"
                                    step={0.01}
                                    value={userOriginUm(doc).x}
                                    onChange={(e) => {
                                        const v = parseCommittedNumberInput(e.target.value);
                                        if (v === null) return;
                                        commitDoc((d) => {
                                            const o = userOriginUm(d);
                                            return setUserOriginUm(d, v, o.y);
                                        });
                                    }}
                                />
                            </label>
                            <label className="mems-precision-field">
                                User origin Y (global µm)
                                <input
                                    type="number"
                                    step={0.01}
                                    value={userOriginUm(doc).y}
                                    onChange={(e) => {
                                        const v = parseCommittedNumberInput(e.target.value);
                                        if (v === null) return;
                                        commitDoc((d) => {
                                            const o = userOriginUm(d);
                                            return setUserOriginUm(d, o.x, v);
                                        });
                                    }}
                                />
                            </label>
                            <div className="mems-origin-actions">
                                <button
                                    type="button"
                                    className="mems-mini-btn mems-mini-btn--wide"
                                    title="Set user origin to last pointer position on die"
                                    onClick={() => {
                                        const p = lastPointerGlobalRef.current;
                                        if (!p) {
                                            setStatusLine('Move the pointer over the canvas first');
                                            return;
                                        }
                                        commitDoc((d) => setUserOriginUm(d, p.x, p.y), true);
                                        setStatusLine(
                                            `User origin → (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) µm global`
                                        );
                                    }}
                                >
                                    Set origin here
                                </button>
                                <button
                                    type="button"
                                    className="mems-mini-btn mems-mini-btn--wide"
                                    onClick={() => {
                                        commitDoc((d) => setUserOriginUm(d, 0, 0), true);
                                        setStatusLine('User origin reset (aligned with global)');
                                    }}
                                >
                                    Reset user origin
                                </button>
                            </div>
                        </div>
                        <div className="mems-align-row">
                            <button type="button" className="mems-mini-btn" title="Align left" onClick={() => runAlign('left')}>
                                <AlignLeft size={13} />
                            </button>
                            <button type="button" className="mems-mini-btn" title="Align right" onClick={() => runAlign('right')}>
                                <AlignRight size={13} />
                            </button>
                            <button type="button" className="mems-mini-btn" title="Align top" onClick={() => runAlign('top')}>
                                <AlignStartVertical size={13} />
                            </button>
                            <button type="button" className="mems-mini-btn" title="Align bottom" onClick={() => runAlign('bottom')}>
                                <AlignEndVertical size={13} />
                            </button>
                            <button type="button" className="mems-mini-btn" title="Align centers H" onClick={() => runAlign('centerH')}>
                                <AlignCenterHorizontal size={13} />
                            </button>
                            <button type="button" className="mems-mini-btn" title="Align centers V" onClick={() => runAlign('centerV')}>
                                <AlignCenterVertical size={13} />
                            </button>
                        </div>
                        <div className="mems-align-row">
                            <button
                                type="button"
                                className="mems-mini-btn mems-mini-btn--wide"
                                title="Distribute centers evenly (horizontal)"
                                onClick={() => runDistribute('h', 'even')}
                            >
                                <AlignHorizontalSpaceBetween size={13} /> Even H
                            </button>
                            <button
                                type="button"
                                className="mems-mini-btn mems-mini-btn--wide"
                                title="Distribute centers evenly (vertical)"
                                onClick={() => runDistribute('v', 'even')}
                            >
                                <AlignVerticalSpaceBetween size={13} /> Even V
                            </button>
                        </div>
                        <div className="mems-align-row">
                            <button
                                type="button"
                                className="mems-mini-btn mems-mini-btn--wide"
                                title="Fixed gap between shapes (horizontal)"
                                onClick={() => runDistribute('h', 'gap')}
                            >
                                Gap H
                            </button>
                            <button
                                type="button"
                                className="mems-mini-btn mems-mini-btn--wide"
                                title="Fixed gap between shapes (vertical)"
                                onClick={() => runDistribute('v', 'gap')}
                            >
                                Gap V
                            </button>
                        </div>
                        <div className="mems-guide-add-row">
                            <button
                                type="button"
                                className="mems-mini-btn"
                                onClick={() => {
                                    const v = window.prompt('Vertical guide X position (µm)', '0');
                                    if (v === null) return;
                                    const x = Number(v);
                                    if (!Number.isFinite(x)) return;
                                    setGuides((g) => ({ ...g, v: [...g.v, x].sort((a, b) => a - b) }));
                                }}
                            >
                                + V guide
                            </button>
                            <button
                                type="button"
                                className="mems-mini-btn"
                                onClick={() => {
                                    const v = window.prompt('Horizontal guide Y position (µm)', '0');
                                    if (v === null) return;
                                    const y = Number(v);
                                    if (!Number.isFinite(y)) return;
                                    setGuides((g) => ({ ...g, h: [...g.h, y].sort((a, b) => a - b) }));
                                }}
                            >
                                + H guide
                            </button>
                            <button
                                type="button"
                                className="mems-mini-btn mems-mini-btn--danger"
                                onClick={() => setGuides({ h: [], v: [] })}
                                title="Clear all guides"
                            >
                                Clear guides
                            </button>
                        </div>
                        <p className="mems-precision-hint">
                            Shift-drag move = orthogonal · Shift rect/ellipse = square · Line: Shift = H/V, Alt = angle · Arrows =
                            nudge.
                        </p>
                    </div>
                    <MemsDrcPanel
                        violations={drcViolations}
                        stats={drcStats}
                        realtime={drcRealtime}
                        onRealtimeChange={setDrcRealtime}
                        onRun={runDrcNow}
                        running={drcRunning}
                        onPickViolation={onPickDrcViolation}
                        highlightId={drcHighlightId}
                        onExportRules={exportDrcRules}
                        onImportRules={importDrcRules}
                    />
                    <ul className="mems-layer-list">
                        {[...layoutLayers(doc)].reverse().map((layer, revIdx) => {
                            const idx = layoutLayers(doc).length - 1 - revIdx;
                            const isActive = layer.id === doc.activeLayerId;
                            return (
                                <li key={layer.id} className={`mems-layer-row${isActive ? ' is-active' : ''}`}>
                                    <button
                                        type="button"
                                        className="mems-layer-main"
                                        onClick={() => setDoc((d) => setActiveLayer(d, layer.id))}
                                    >
                                        <span className="mems-layer-swatch" style={{ background: layer.color }} />
                                        <input
                                            className="mems-layer-name"
                                            value={layer.name}
                                            onChange={(e) =>
                                                setDoc((d) => updateLayer(d, layer.id, { name: e.target.value }))
                                            }
                                            onClick={(e) => e.stopPropagation()}
                                        />
                                    </button>
                                    <button
                                        type="button"
                                        className="mems-icon-btn"
                                        title={layer.visible ? 'Hide' : 'Show'}
                                        onClick={() =>
                                            setDoc((d) => updateLayer(d, layer.id, { visible: !layer.visible }))
                                        }
                                    >
                                        {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                                    </button>
                                    <button
                                        type="button"
                                        className="mems-icon-btn"
                                        title={layer.locked ? 'Unlock' : 'Lock'}
                                        onClick={() =>
                                            setDoc((d) => updateLayer(d, layer.id, { locked: !layer.locked }))
                                        }
                                    >
                                        {layer.locked ? <Lock size={14} /> : <Unlock size={14} />}
                                    </button>
                                    <button
                                        type="button"
                                        className={`mems-icon-btn${layer.selectable === false ? ' mems-icon-btn--warn' : ''}`}
                                        title={layer.selectable !== false ? 'Selectable' : 'Not selectable (reference)'}
                                        onClick={() =>
                                            setDoc((d) =>
                                                updateLayer(d, layer.id, { selectable: layer.selectable === false })
                                            )
                                        }
                                    >
                                        <MousePointerClick size={14} />
                                    </button>
                                    <button
                                        type="button"
                                        className="mems-icon-btn"
                                        disabled={idx >= layoutLayers(doc).length - 1}
                                        onClick={() => setDoc((d) => reorderLayers(d, idx, idx + 1))}
                                        title="Raise (toward top of stack)"
                                    >
                                        <ChevronUp size={14} />
                                    </button>
                                    <button
                                        type="button"
                                        className="mems-icon-btn"
                                        disabled={idx <= 0}
                                        onClick={() => setDoc((d) => reorderLayers(d, idx, idx - 1))}
                                        title="Lower"
                                    >
                                        <ChevronDown size={14} />
                                    </button>
                                    <button
                                        type="button"
                                        className="mems-icon-btn mems-icon-btn--danger"
                                        disabled={layoutLayers(doc).length <= 1}
                                        onClick={() => {
                                            if (window.confirm(`Delete layer "${layer.name}"?`))
                                                setDoc((d) => removeLayer(d, layer.id));
                                        }}
                                        title="Delete layer"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                    <div className="mems-active-layer-panel">
                        <div className="mems-sublabel">Active layer (mask stack)</div>
                        {(() => {
                            const al = activeLayer(doc);
                            if (!al) return null;
                            const lid = al.id;
                            return (
                                <>
                                    <label>
                                        Opacity
                                        <input
                                            type="range"
                                            min={0}
                                            max={1}
                                            step={0.05}
                                            value={al.opacity ?? 1}
                                            onChange={(e) =>
                                                setDoc((d) =>
                                                    updateLayer(d, lid, { opacity: Number(e.target.value) })
                                                )
                                            }
                                        />
                                    </label>
                                    <label className="mems-checkbox-row">
                                        <input
                                            type="checkbox"
                                            checked={al.selectable !== false}
                                            onChange={(e) =>
                                                setDoc((d) =>
                                                    updateLayer(d, lid, { selectable: e.target.checked })
                                                )
                                            }
                                        />
                                        Selectable in editor
                                    </label>
                                    <label>
                                        Material / film
                                        <input
                                            type="text"
                                            value={al.metadata?.material ?? ''}
                                            placeholder="e.g. Shipley SPR955"
                                            onChange={(e) =>
                                                setDoc((d) =>
                                                    updateLayer(d, lid, {
                                                        metadata: { material: e.target.value },
                                                    })
                                                )
                                            }
                                        />
                                    </label>
                                    <label>
                                        Process role
                                        <input
                                            type="text"
                                            value={al.metadata?.processRole ?? ''}
                                            placeholder="e.g. lithography, etch, lift-off"
                                            onChange={(e) =>
                                                setDoc((d) =>
                                                    updateLayer(d, lid, {
                                                        metadata: { processRole: e.target.value },
                                                    })
                                                )
                                            }
                                        />
                                    </label>
                                    <label>
                                        Purpose
                                        <input
                                            type="text"
                                            value={al.metadata?.purpose ?? ''}
                                            onChange={(e) =>
                                                setDoc((d) =>
                                                    updateLayer(d, lid, {
                                                        metadata: { purpose: e.target.value },
                                                    })
                                                )
                                            }
                                        />
                                    </label>
                                </>
                            );
                        })()}
                    </div>
                    <div className="mems-die-fields">
                        <div className="mems-sublabel">Project</div>
                        <label>
                            Technology / flow
                            <input
                                type="text"
                                value={doc.project?.metadata?.technology ?? ''}
                                onChange={(e) =>
                                    setDoc((d) =>
                                        updateProjectMetadata(d, { technology: e.target.value })
                                    )
                                }
                            />
                        </label>
                        <label>
                            Description
                            <textarea
                                rows={2}
                                value={doc.project?.metadata?.description ?? ''}
                                onChange={(e) =>
                                    setDoc((d) =>
                                        updateProjectMetadata(d, { description: e.target.value })
                                    )
                                }
                            />
                        </label>
                        <label className="mems-display-units">
                            Display units
                            <div className="mems-unit-toggle">
                                <button
                                    type="button"
                                    className={projectDisplayUnit(doc) !== 'mm' ? 'is-active' : ''}
                                    onClick={() => setDoc((d) => setDisplayUnit(d, 'um'))}
                                >
                                    µm
                                </button>
                                <button
                                    type="button"
                                    className={projectDisplayUnit(doc) === 'mm' ? 'is-active' : ''}
                                    onClick={() => setDoc((d) => setDisplayUnit(d, 'mm'))}
                                >
                                    mm
                                </button>
                            </div>
                        </label>
                        <label>
                            Snap grid (µm, internal)
                            <input
                                type="number"
                                min={1}
                                step={1}
                                value={snapGridUm}
                                onChange={(e) => {
                                    const v = parseCommittedNumberInput(e.target.value);
                                    if (v === null) return;
                                    setSnapGridUm(Math.max(1, v));
                                }}
                            />
                        </label>
                        <label>
                            Die width (µm)
                            <input
                                type="number"
                                min={100}
                                step={100}
                                value={dieWidthUm(doc)}
                                onChange={(e) => {
                                    const v = parseCommittedNumberInput(e.target.value);
                                    if (v === null) return;
                                    setDoc((d) =>
                                        setProjectDie(d, Math.max(100, v), dieHeightUm(d))
                                    );
                                }}
                            />
                        </label>
                        <label>
                            Die height (µm)
                            <input
                                type="number"
                                min={100}
                                step={100}
                                value={dieHeightUm(doc)}
                                onChange={(e) => {
                                    const v = parseCommittedNumberInput(e.target.value);
                                    if (v === null) return;
                                    setDoc((d) =>
                                        setProjectDie(d, dieWidthUm(d), Math.max(100, v))
                                    );
                                }}
                            />
                        </label>
                        <p className="mems-hint mems-die-hint">
                            <strong>Die</strong> is the symmetric layout outline (µm), centered on the global origin (0, 0). It
                            is used for the dimmed outline, export/DRC framing, and snap limits. The outline{' '}
                            <strong>grows automatically</strong> when shapes or instances extend past it; you can still set
                            larger values here for planned empty margin. To shrink the outline to the current drawings, lower
                            these fields or re-import / use a saved layout that already matches.
                        </p>
                        <label>
                            Design name
                            <input
                                type="text"
                                value={projectName(doc)}
                                onChange={(e) => setDoc((d) => setProjectName(d, e.target.value))}
                            />
                        </label>
                    </div>
                    <p className="mems-hint">
                        <strong>New design…</strong> names the project, adds a library cell, and can place a starter instance.
                        Save: <strong>Workspace</strong> → <code>{MEMS_MASKS_WORKSPACE_FOLDER_NAME}/</code> (browser IndexedDB). Use
                        the header <strong>Save under</strong> field for virtual folders (e.g. <code>Imports</code> → stored as
                        <code>Imports/Project.json</code>). <strong>ZIP workspace</strong> downloads the whole folder to your
                        computer. <strong>Download JSON</strong> saves only the current layout file; <strong>Open…</strong> reloads
                        from the workspace. Precision: grid / snap · guides · rulers · measure · align · nudge.
                    </p>
                        </>
                    )}
                </aside>

                <div
                    className={`mems-canvas-rulers${showRulers ? '' : ' mems-canvas-rulers--norulers'}`}
                    onWheel={onWheel}
                >
                    {showRulers && (
                        <>
                            <div className="mems-ruler-corner" aria-hidden />
                            <div className="mems-ruler-top">
                                {rulerTicks.xt.map((x) => (
                                    <span
                                        key={`rtx-${x}`}
                                        className="mems-ruler-tick"
                                        style={{
                                            left: `${worldXToSvgFracX(x, viewBox, svgMeet) * 100}%`,
                                        }}
                                    >
                                        <span className="mems-ruler-label">
                                            {Math.round(
                                                coordFrame === 'user' ? x - rulerTicks.oux : x
                                            )}
                                        </span>
                                    </span>
                                ))}
                            </div>
                            <div className="mems-ruler-left">
                                {rulerTicks.yt.map((y) => (
                                    <span
                                        key={`rty-${y}`}
                                        className="mems-ruler-tick mems-ruler-tick--y"
                                        style={{
                                            top: `${worldYToSvgFracY(y, viewBox, svgMeet) * 100}%`,
                                        }}
                                    >
                                        <span className="mems-ruler-label">
                                            {Math.round(
                                                coordFrame === 'user' ? y - rulerTicks.ouy : y
                                            )}
                                        </span>
                                    </span>
                                ))}
                            </div>
                        </>
                    )}
                    <div className="mems-mask-studio__canvas-wrap">
                    <svg
                        ref={svgRef}
                        className="mems-svg"
                        tabIndex={0}
                        vectorEffect="none"
                        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
                        preserveAspectRatio="xMidYMid meet"
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerLeave={(ev) => {
                            setPointerReadout(null);
                            if (panRef.current) return;
                            onPointerUp(ev);
                        }}
                        onContextMenu={(ev) => {
                            if (tool !== 'polygon') return;
                            const pts = polygonPointsRef.current;
                            if (!pts?.length) return;
                            ev.preventDefault();
                            setPolygonCtxMenu({ x: ev.clientX, y: ev.clientY });
                        }}
                    >
                        <rect
                            x={-dieWidthUm(doc) / 2}
                            y={-dieHeightUm(doc) / 2}
                            width={dieWidthUm(doc)}
                            height={dieHeightUm(doc)}
                            className="mems-die-outline"
                        />
                        <g className="mems-user-origin-g" pointerEvents="none" aria-hidden>
                            {(() => {
                                const o = userOriginUm(doc);
                                const arm = Math.max(14, viewBox.w / 95);
                                const sw = overlayStrokeUm * 0.95;
                                return (
                                    <>
                                        <line
                                            x1={o.x - arm}
                                            y1={o.y}
                                            x2={o.x + arm}
                                            y2={o.y}
                                            stroke="#f97316"
                                            strokeWidth={sw}
                                            opacity={0.85}
                                        />
                                        <line
                                            x1={o.x}
                                            y1={o.y - arm}
                                            x2={o.x}
                                            y2={o.y + arm}
                                            stroke="#f97316"
                                            strokeWidth={sw}
                                            opacity={0.85}
                                        />
                                    </>
                                );
                            })()}
                        </g>
                        {guidesSvg}
                        {gridLines}
                        {layoutLayers(doc).map((layer) => {
                            if (!layer.visible) return null;
                            return (
                                <g
                                    key={layer.id}
                                    className="mems-layer-g"
                                    opacity={layer.opacity ?? 1}
                                >
                                    {layer.entities.map((e) => renderEntity(layer, e))}
                                </g>
                            );
                        })}
                        {instanceGhostSvg}
                        {measureSvg}
                        {drcOverlaySvg}
                        {selectionDecor}
                        {marqueeSvg}
                        {polygonPreview}
                        {pathPreview}
                        {pathPoints &&
                            pathPoints.map((p, i) => (
                                <circle
                                    key={`pathv-${i}`}
                                    cx={p.x}
                                    cy={p.y}
                                    r={Math.max(2.5, viewBox.w / 380)}
                                    fill={i === 0 ? '#fb923c' : '#fdba74'}
                                    stroke="#0f172a"
                                    strokeWidth={overlayStrokeUm * 0.55}
                                    pointerEvents="none"
                                />
                            ))}
                        {polygonPoints &&
                            polygonPoints.map((p, i) => (
                                <circle
                                    key={`pv-${i}`}
                                    cx={p.x}
                                    cy={p.y}
                                    r={Math.max(2.5, viewBox.w / 380)}
                                    fill={i === 0 ? '#34d399' : '#f472b6'}
                                    stroke="#0f172a"
                                    strokeWidth={overlayStrokeUm * 0.55}
                                    pointerEvents="none"
                                />
                            ))}
                        {lineChainPreviewSvg}
                        {lineDraftSvg}
                        {snapTargetPreviewSvg}
                        {lineSnapHoverSvg}
                        {polygonSnapHoverSvg}
                        {draftRect && draftRect.width > 0 && draftRect.height > 0 && (
                            <rect
                                x={draftRect.x}
                                y={draftRect.y}
                                width={draftRect.width}
                                height={draftRect.height}
                                fill="none"
                                stroke="#f472b6"
                                strokeDasharray="8 6"
                                strokeWidth={overlayStrokeUm}
                                pointerEvents="none"
                            />
                        )}
                    </svg>
                </div>
                </div>

                <aside
                    className={`mems-mask-studio__inspector${!inspectorPanelOpen ? ' mems-mask-studio__inspector--collapsed' : ''}`}
                    aria-label="Properties"
                >
                    {!inspectorPanelOpen ? (
                        <button
                            type="button"
                            className="mems-panel-expand mems-panel-expand--right"
                            onClick={() => setInspectorPanelOpen(true)}
                            title="Show properties panel"
                            aria-label="Show properties panel"
                        >
                            <ChevronsLeft size={15} aria-hidden />
                            <span className="mems-panel-expand__label">Props</span>
                        </button>
                    ) : (
                        <>
                            <div className="mems-inspector-head">
                                <span>Properties</span>
                                <button
                                    type="button"
                                    className="mems-icon-btn"
                                    onClick={() => setInspectorPanelOpen(false)}
                                    title="Collapse properties panel"
                                    aria-label="Collapse properties panel"
                                >
                                    <ChevronsRight size={16} />
                                </button>
                            </div>
                    {tool === 'line' && lineChain && lineChain.segmentIds.length > 0 && (
                        <div className="mems-line-chain-panel">
                            <div className="mems-line-chain-panel__title">Active line chain</div>
                            <p className="mems-inspector-hint">
                                Click a segment to edit length & angle below. Backspace removes last segment.
                                Esc ends chain mode and keeps drawn segments. Enter finishes open chain; near green start +
                                Enter closes polygon.
                            </p>
                            <ul className="mems-line-chain-panel__list">
                                {lineChain.segmentIds.map((sid, idx) => {
                                    const hit = findEntity(doc, sid);
                                    const ent = hit?.entity;
                                    let lenUm = 0;
                                    let angDeg = 0;
                                    if (ent?.type === 'line') {
                                        const dx = ent.x2 - ent.x1;
                                        const dy = ent.y2 - ent.y1;
                                        lenUm = Math.hypot(dx, dy);
                                        angDeg = lenUm > 1e-15 ? (Math.atan2(dy, dx) * 180) / Math.PI : 0;
                                    }
                                    const sel = selectedIds.has(sid);
                                    return (
                                        <li key={sid}>
                                            <button
                                                type="button"
                                                className={`mems-line-chain-panel__seg${sel ? ' mems-line-chain-panel__seg--sel' : ''}`}
                                                onClick={() => {
                                                    setSelectedIds(new Set([sid]));
                                                    selectionOrderRef.current = [sid];
                                                }}
                                            >
                                                Segment {idx + 1}: L {lenUm.toFixed(3)} µm · θ {angDeg.toFixed(2)}°
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}
                    {tool === 'polygon' && polygonPoints && polygonPoints.length >= 2 && polygonDraftSegIndex != null && (
                        <div className="mems-line-chain-panel">
                            <div className="mems-line-chain-panel__title">Draft segment</div>
                            <p className="mems-inspector-hint">
                                Moves vertex {polygonDraftSegIndex + 2} along the edge from vertex{' '}
                                {polygonDraftSegIndex + 1}. Backspace removes last vertex.
                            </p>
                            <ul className="mems-line-chain-panel__list">
                                {Array.from({ length: polygonPoints.length - 1 }, (_, idx) => {
                                    const ax = polygonPoints[idx].x;
                                    const ay = polygonPoints[idx].y;
                                    const bx = polygonPoints[idx + 1].x;
                                    const by = polygonPoints[idx + 1].y;
                                    const lenUm = Math.hypot(bx - ax, by - ay);
                                    const angDeg =
                                        lenUm > 1e-15
                                            ? (Math.atan2(by - ay, bx - ax) * 180) / Math.PI
                                            : 0;
                                    const sel = idx === polygonDraftSegIndex;
                                    return (
                                        <li key={`draft-seg-${idx}`}>
                                            <button
                                                type="button"
                                                className={`mems-line-chain-panel__seg${sel ? ' mems-line-chain-panel__seg--sel' : ''}`}
                                                onClick={() => setPolygonDraftSegIndex(idx)}
                                            >
                                                Segment {idx + 1}: L {lenUm.toFixed(3)} µm · θ{' '}
                                                {angDeg.toFixed(2)}°
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                            {(() => {
                                const pts = polygonPoints;
                                const si = polygonDraftSegIndex;
                                if (si < 0 || si >= pts.length - 1) return null;
                                const ax = pts[si].x;
                                const ay = pts[si].y;
                                let bx = pts[si + 1].x;
                                let by = pts[si + 1].y;
                                const dx = bx - ax;
                                const dy = by - ay;
                                const lenUm = Math.hypot(dx, dy);
                                const angDeg =
                                    lenUm > 1e-15 ? (Math.atan2(dy, dx) * 180) / Math.PI : 0;
                                const pushEnd = (nx, ny) => {
                                    const next = pts.map((p) => ({ ...p }));
                                    next[si + 1] = { x: nx, y: ny };
                                    if (!validateDraftOpenPolyline(next, snapGridUm)) return;
                                    setPolygonPoints(next);
                                };
                                return (
                                    <div className="mems-inspector mems-inspector--nested">
                                        <label className="mems-inspector-field">
                                            Length (µm)
                                            <input
                                                type="number"
                                                step={0.001}
                                                value={Number(lenUm.toFixed(6))}
                                                onChange={(ev) => {
                                                    const L = parseCommittedNumberInput(ev.target.value);
                                                    if (L === null || L <= 0) return;
                                                    const L0 = Math.max(1e-9, lenUm);
                                                    const ux = dx / L0;
                                                    const uy = dy / L0;
                                                    pushEnd(ax + ux * L, ay + uy * L);
                                                }}
                                            />
                                        </label>
                                        <label className="mems-inspector-field">
                                            Angle from +X (°)
                                            <input
                                                type="number"
                                                step={0.01}
                                                value={Number(angDeg.toFixed(6))}
                                                onChange={(ev) => {
                                                    const deg = parseCommittedNumberInput(ev.target.value);
                                                    if (deg === null) return;
                                                    const L = Math.max(1e-9, lenUm);
                                                    const rad = (deg * Math.PI) / 180;
                                                    pushEnd(ax + L * Math.cos(rad), ay + L * Math.sin(rad));
                                                }}
                                            />
                                        </label>
                                        <label className="mems-inspector-field">
                                            End X (µm · global)
                                            <input
                                                type="number"
                                                step={0.001}
                                                value={Number(bx.toFixed(6))}
                                                onChange={(ev) => {
                                                    const v = parseCommittedNumberInput(ev.target.value);
                                                    if (v === null) return;
                                                    pushEnd(v, by);
                                                }}
                                            />
                                        </label>
                                        <label className="mems-inspector-field">
                                            End Y (µm · global)
                                            <input
                                                type="number"
                                                step={0.001}
                                                value={Number(by.toFixed(6))}
                                                onChange={(ev) => {
                                                    const v = parseCommittedNumberInput(ev.target.value);
                                                    if (v === null) return;
                                                    pushEnd(bx, v);
                                                }}
                                            />
                                        </label>
                                    </div>
                                );
                            })()}
                        </div>
                    )}
                    <MemsMaskInspector
                        doc={doc}
                        selectedId={inspectorEntityId}
                        displayUnit={projectDisplayUnit(doc)}
                        coordFrame={coordFrame}
                        commitDoc={commitDoc}
                        onOpenMasterCell={(cellId) => setDoc((d) => setActiveCell(d, cellId))}
                    />
                        </>
                    )}
                </aside>
            </div>

            {polygonCtxMenu && (
                <div
                    ref={polygonCtxMenuRef}
                    className="mems-polygon-ctx-menu"
                    style={{
                        position: 'fixed',
                        left: polygonCtxMenu.x,
                        top: polygonCtxMenu.y,
                        zIndex: 3000,
                        minWidth: 160,
                        padding: '6px 0',
                        background: '#1e293b',
                        border: '1px solid #334155',
                        borderRadius: 8,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                    }}
                    role="menu"
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        className="mems-polygon-ctx-menu__item"
                        role="menuitem"
                        disabled={!polygonPoints || polygonPoints.length < 3}
                        onClick={() => {
                            const pts = polygonPointsRef.current;
                            setPolygonCtxMenu(null);
                            if (pts && pts.length >= 3) finalizePolygonFromDraft(pts);
                        }}
                        style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            padding: '8px 14px',
                            background: 'transparent',
                            border: 'none',
                            color: '#f8fafc',
                            cursor: 'pointer',
                            font: 'inherit',
                        }}
                    >
                        Finish polygon
                    </button>
                    <button
                        type="button"
                        className="mems-polygon-ctx-menu__item"
                        role="menuitem"
                        onClick={() => {
                            setPolygonCtxMenu(null);
                            setPolygonPoints(null);
                            setPolygonRubberTip(null);
                            setPolygonSnapPxHover(null);
                            setPolygonDraftSegIndex(null);
                            polygonDblRef.current = null;
                            setStatusLine('Polygon draft cancelled');
                        }}
                        style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            padding: '8px 14px',
                            background: 'transparent',
                            border: 'none',
                            color: '#f8fafc',
                            cursor: 'pointer',
                            font: 'inherit',
                        }}
                    >
                        Cancel draft
                    </button>
                </div>
            )}

            {workspacePickerOpen && (
                <div
                    className="mems-ws-modal-backdrop"
                    role="presentation"
                    onClick={() => setWorkspacePickerOpen(false)}
                >
                    <div
                        className="mems-ws-modal"
                        role="dialog"
                        aria-labelledby="mems-ws-modal-title"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="mems-ws-modal__head">
                            <h3 id="mems-ws-modal-title">Open from workspace</h3>
                            <button
                                type="button"
                                className="mems-ws-modal__close"
                                onClick={() => setWorkspacePickerOpen(false)}
                                aria-label="Close"
                            >
                                ×
                            </button>
                        </div>
                        <p className="mems-ws-modal__hint">
                            Layout JSON in <code>{MEMS_MASKS_WORKSPACE_FOLDER_NAME}/</code> (names can include a path, e.g.{' '}
                            <code>Imports/Chip.json</code>). After opening, <strong>Workspace</strong> updates that file.
                        </p>
                        <ul className="mems-ws-modal__list">
                            {memsWorkspaceEntries.map((f) => (
                                <li key={f.id}>
                                    <button
                                        type="button"
                                        className="mems-ws-modal__file-btn"
                                        onClick={() => loadDocFromWorkspaceFile(f)}
                                    >
                                        {f.name}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            )}

            <WaferLayoutWizardModal
                open={waferWizardOpen}
                onClose={() => setWaferWizardOpen(false)}
                onApply={applyWaferWizardResult}
            />

            {newDesignModalOpen && (
                <div
                    className="mems-ws-modal-backdrop"
                    role="presentation"
                    onClick={() => setNewDesignModalOpen(false)}
                >
                    <div
                        className="mems-ws-modal mems-new-design-modal"
                        role="dialog"
                        aria-labelledby="mems-new-design-title"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="mems-ws-modal__head">
                            <h3 id="mems-new-design-title">New design</h3>
                            <button
                                type="button"
                                className="mems-ws-modal__close"
                                onClick={() => setNewDesignModalOpen(false)}
                                aria-label="Close"
                            >
                                ×
                            </button>
                        </div>
                        <div className="mems-new-design__body">
                            <p className="mems-ws-modal__hint mems-new-design__intro">
                                Creates a fresh die layout, names the project, adds a <strong>library</strong> master
                                cell (for reuse), and leaves you on <strong>Root</strong> to draw or place instances.
                            </p>
                            <label className="mems-new-design__field">
                                <span>Design name</span>
                                <input
                                    type="text"
                                    className="mems-new-design__input"
                                    value={newDesignProjectName}
                                    onChange={(e) => setNewDesignProjectName(e.target.value)}
                                    autoComplete="off"
                                    autoFocus
                                />
                            </label>
                            <label className="mems-new-design__field">
                                <span>Library cell name</span>
                                <input
                                    type="text"
                                    className="mems-new-design__input"
                                    value={newDesignLibraryName}
                                    onChange={(e) => setNewDesignLibraryName(e.target.value)}
                                    autoComplete="off"
                                    placeholder="Unit"
                                />
                            </label>
                            <label className="mems-new-design__check">
                                <input
                                    type="checkbox"
                                    checked={newDesignPlaceInstance}
                                    onChange={(e) => setNewDesignPlaceInstance(e.target.checked)}
                                />
                                <span>
                                    Place one <strong>instance</strong> of that library on Root at die center (0, 0)
                                </span>
                            </label>
                        </div>
                        <div className="mems-new-design__actions">
                            <button type="button" className="mems-new-design__btn" onClick={() => setNewDesignModalOpen(false)}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="mems-new-design__btn mems-new-design__btn--primary"
                                onClick={() => commitNewDesignFromModal()}
                            >
                                Start design
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <footer className="mems-mask-studio__footer">
                <Save size={12} aria-hidden />
                <span>
                    Autosaved to this browser · use <strong>Workspace</strong> for IndexedDB backup ·{' '}
                    <strong>Download JSON</strong> for a file on disk · geometry µm · display{' '}
                    {unitSuffix(projectDisplayUnit(doc))} · view{' '}
                    {formatLengthUm(viewBox.w, projectDisplayUnit(doc), 3)} wide · die{' '}
                    {dieWidthUm(doc)}×{dieHeightUm(doc)} µm
                    {pointerReadout ? (
                        <>
                            {' · '}
                            <span title="Global layout µm (fixed; export / DRC)">
                                G {pointerReadout.gx.toFixed(1)}, {pointerReadout.gy.toFixed(1)}
                            </span>
                            {' · '}
                            <span title="User-relative µm (design convenience)">
                                U{' '}
                                {globalToUserUm(doc, pointerReadout.gx, pointerReadout.gy).x.toFixed(1)},{' '}
                                {globalToUserUm(doc, pointerReadout.gx, pointerReadout.gy).y.toFixed(1)}
                            </span>
                        </>
                    ) : null}
                    {statusLine ? ` · ${statusLine}` : ''}
                </span>
            </footer>
        </div>
    );
}
