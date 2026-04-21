import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X as CloseIcon, Move, Check } from 'lucide-react';
import {
    MousePointer2, Square, Hexagon, Circle as CircleIcon, Eraser,
    Play, Pause, RotateCcw, Grid3x3, Ruler, Wind, Info, ZoomIn, ZoomOut, Maximize2,
    Minus, CheckCircle2, TrendingDown, PenLine, Undo2, Redo2, Save, FolderOpen, Scissors, FilePlus, Spline,
    Folder, FolderPlus, FileText, Download, Trash2, Edit3, ChevronRight, ChevronLeft, ChevronDown,
    PanelLeftClose, PanelRightClose, EyeOff,
    Archive, Database, ArrowRight, Settings2,
    Combine, Minus as SubtractIcon, SquareAsterisk, Shuffle, Shapes,
    MoveHorizontal, FlipHorizontal, RotateCw, ArrowUpRight, Link2,
    Activity, Gauge, Droplets, Waves, Crosshair, BarChart2,
    Plus, ChevronUp, LayoutGrid,
} from 'lucide-react';
import {
    LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip,
    ResponsiveContainer, CartesianGrid, Legend, ReferenceArea, ReferenceLine
} from 'recharts';
import {
    createRectEntity, createCircleEntity, createPolylineEntity,
    pointInPolygon, distToSegment, entitiesBBox, rasterizeDomain,
    edgeOutwardNormal, characteristicLength_mm, removeVertexAt, removeEdgeAt,
    filletVertex,
    collectCuttingEdges, trimSection, trimOpenPolylineEdge, trimLineAtPoint,
    projectPointOnSegment,
    booleanUnion, booleanSubtract, booleanIntersect, booleanXor,
    offsetPolygon, extendOpenPolyline, joinPolylinesIntoRegion,
    translateEntity, rotateEntity, mirrorEntity,
    polygonCentroid, entitiesCentroid,
} from '../flowlab/geometry.js';
import { mmToUnit, unitToMm, formatLength, pickGridStepMm, UNIT_LABEL } from '../flowlab/units.js';
import { GAS_PRESETS, gasById, nu, reynolds } from '../flowlab/gases.js';
import {
    ANALYTE_PRESETS, analyteById, schmidt, peclet, diffusionTime_s,
    correctedDiffusivity,
    PULSE_PROFILES, pulseProfileById, evalPulse,
} from '../flowlab/analytes.js';
import { COLORMAPS, COLORMAP_NAMES } from '../flowlab/colormap.js';
import './FlowLabPage.css';

/**
 * Flow Lab — 2D gas-path designer + LBM flow solver.
 *
 * Layout:
 *   ┌ toolbar ─────────────────────────────────────────────────┐
 *   │ select | rect | polyline | circle | delete | grid | units │
 *   │ gas | inlet | colormap | play/pause/reset | Re badge       │
 *   ├────────┬──────────────────────────────────┬──────────────┤
 *   │ layers │  canvas (heatmap underlay + SVG) │  inspector   │
 *   │   &    │                                  │  (BC / gas)  │
 *   │  help  │                                  │              │
 *   └────────┴──────────────────────────────────┴──────────────┘
 *
 * Geometry is a single closed polyline ("the fluid region"). Each edge
 * gets its own BC (wall / inlet / outlet). For MVP we support exactly one
 * region — multi-region + obstacles are phase-2.
 *
 * Coordinates in state are ALWAYS in mm. The unit toggle affects display
 * only. The viewport is {pxPerMm, tx, ty}: world (mm) → screen (px) via
 *   sx = x_mm * pxPerMm + tx
 *   sy = -y_mm * pxPerMm + ty     (y-up in world, y-down on screen)
 */

const TOOLS = {
    SELECT: 'select',
    RECT: 'rect',
    POLY: 'poly',
    LINE: 'line',
    CIRCLE: 'circle',
    SECTION: 'section',
    FILLET: 'fillet',
    TRIM: 'trim',
    DELETE: 'delete',
    EXTEND: 'extend',
    OFFSET: 'offset',
    MIRROR: 'mirror',
    MOVE: 'move',
    MEASURE: 'measure',
    PROBE: 'probe',
};

/** Named palette used to colour point probes in canvas / charts. Matches
 *  the existing section colour cycle (warm, distinct, readable on the
 *  turbo heat-map background). */
const PROBE_COLORS = ['#38bdf8', '#a78bfa', '#f472b6', '#fb923c', '#facc15', '#34d399', '#60a5fa'];

const PROJECT_SCHEMA = 'flowlab.v1';
const FLOWLAB_FOLDER_NAME = 'Flow Lab';
const PROJECT_FILE_SUFFIX = '.flow.json';

/* Result files archive a snapshot of the simulation output alongside the
   project, so users can close Flow Lab and reopen weeks later to keep
   exploring (add sections, export CSV, etc.) without re-running. */
const RESULT_SCHEMA = 'flowlab.result.v1';
const RESULT_FILE_SUFFIX = '.flowres.json';

/* Empty-folder marker. The workspace has a flat folder model, so we
   persist virtual Flow Lab subfolders by encoding "path/name" into the
   file name. Empty folders would otherwise vanish — this placeholder
   file keeps them around until the user adds content or deletes them. */
const FOLDER_MARKER_NAME = '.flowlab-folder';
const FOLDER_MARKER_SCHEMA = 'flowlab.folder.marker';

/* Legal filename chars (excluding '/' which we use as a path separator). */
const INVALID_NAME_RE = /[\\/:*?"<>|]/;
const isValidSimpleName = (s) => typeof s === 'string' && s.trim().length > 0 && !INVALID_NAME_RE.test(s);

/* Split a full Flow Lab-relative name like "Experiments/trial-1.flow.json"
   into a path array ["Experiments"] and the base file name "trial-1.flow.json".
   Returns { parts, base, dir }. */
function splitPath(fullName) {
    const pieces = String(fullName).split('/').filter(Boolean);
    if (pieces.length <= 1) return { parts: [], base: pieces[0] || '', dir: '' };
    const base = pieces.pop();
    return { parts: pieces, base, dir: pieces.join('/') };
}
const joinPath = (...parts) => parts.filter((p) => p && String(p).length).join('/');

/**
 * Default example geometry: a 20 mm × 5 mm chamber with a 1 mm inlet on
 * the left (y ∈ [2,3] mm) and a 1 mm outlet on the right (y ∈ [2,3] mm),
 * all remaining sides tagged as no-slip walls. Ready to press "Run".
 *
 * CCW vertex order (so `edgeOutwardNormal` gives correct outward normals):
 *
 *      y=5 ┌──────────────────────────┐
 *          │ wall(4)                  │
 *      y=3 ├──> outlet(2) right side  │
 *          │                          │
 *      y=2 ├──> ...                   │
 *          │ wall(0) bottom           │
 *      y=0 └──────────────────────────┘
 *          x=0                        x=20
 */
const DEFAULT_DOMAIN = () => {
    const pts = [
        { x: 0,  y: 0 },   // 0
        { x: 20, y: 0 },   // 1
        { x: 20, y: 2 },   // 2
        { x: 20, y: 3 },   // 3
        { x: 20, y: 5 },   // 4
        { x: 0,  y: 5 },   // 5
        { x: 0,  y: 3 },   // 6
        { x: 0,  y: 2 },   // 7
    ];
    const ent = createPolylineEntity(pts);
    ent.edgeBC = {
        0: { type: 'wall' },                   // bottom (0,0)→(20,0)
        1: { type: 'wall' },                   // right, below outlet (20,0)→(20,2)
        2: { type: 'outlet' },                 // 1 mm outlet (20,2)→(20,3)
        3: { type: 'wall' },                   // right, above outlet (20,3)→(20,5)
        4: { type: 'wall' },                   // top (20,5)→(0,5)
        5: { type: 'wall' },                   // left, above inlet (0,5)→(0,3)
        6: { type: 'inlet' },                  // 1 mm inlet (0,3)→(0,2)
        7: { type: 'wall' },                   // left, below inlet (0,2)→(0,0)
    };
    return ent;
};

/* ────────────────────────────────────────────────────────────────
 * Aroma-chamber demo geometry
 *
 * A dog-bone / "I-beam" layout that illustrates what the solver can
 * actually do for aroma-sensor chip work:
 *
 *   - 10 × 10 mm central chamber (1 cm × 1 cm as the user asked for)
 *   - 10 × 2 mm inlet channel on the left  (1 cm × 0.2 cm)
 *   - 10 × 2 mm outlet channel on the right (1 cm × 0.2 cm)
 *   - All 8 internal chamber corners filleted with r = 1 mm
 *     (both the sudden-expansion junctions and the far corners —
 *      the former smooths the jet, the latter kills dead-zone
 *      recirculation)
 *   - Two 4 mm sensor strips centred on the top and bottom chamber
 *     walls so the user can immediately see S_top vs S_bottom
 *     arrival-time differences
 *
 *         y=10 ┌─────────┐
 *              │ ╭─────╮ │
 *              │ │  ◜  │ │
 *      y=6 ├───┘ │     │ └───┤ outlet (y=4..6)
 *      y=4 ├───┐ │     │ ┌───┤
 *              │ │  ◟  │ │
 *              │ ╰─────╯ │
 *         y=0  └─────────┘
 *              x=10      x=20
 * ──────────────────────────────────────────────────────────────── */

/**
 * Fillet a sharp corner into an arc. Handles both convex (left-turn
 * CCW) and reflex (right-turn CCW) corners.
 *
 *   prev, curr, next : {x,y}   adjacent polyline vertices
 *   radius           : mm      target fillet radius
 *   segments         : int     # polyline segments approximating arc
 *
 * Returns `segments + 1` points along the arc, starting at the tangent
 * point on the (prev → curr) edge and ending on the (curr → next) edge.
 * If the two adjacent edges are too short for the requested radius, the
 * radius is clamped to the largest that fits.
 */
function computeFilletArc(prev, curr, next, radius, segments = 8) {
    const ax = curr.x - prev.x, ay = curr.y - prev.y;
    const bx = next.x - curr.x, by = next.y - curr.y;
    const aLen = Math.hypot(ax, ay);
    const bLen = Math.hypot(bx, by);
    if (aLen < 1e-9 || bLen < 1e-9) return [{ x: curr.x, y: curr.y }];
    const aux = ax / aLen, auy = ay / aLen;
    const bux = bx / bLen, buy = by / bLen;
    const cross = aux * buy - auy * bux;
    const dotv  = aux * bux + auy * buy;
    const phi = Math.atan2(cross, dotv);
    const absPhi = Math.abs(phi);
    if (absPhi < 1e-3 || Math.abs(absPhi - Math.PI) < 1e-3) {
        return [{ x: curr.x, y: curr.y }];
    }
    const interiorHalf = (Math.PI - absPhi) / 2;
    const tanIH = Math.tan(interiorHalf);
    const setbackMax = radius / tanIH;
    const setback = Math.min(setbackMax, aLen * 0.49, bLen * 0.49);
    const effR = setback * tanIH;
    const T1x = curr.x - aux * setback, T1y = curr.y - auy * setback;
    const T2x = curr.x + bux * setback, T2y = curr.y + buy * setback;
    const s = Math.sign(cross) || 1;
    const Cx = T1x + s * (-auy) * effR;
    const Cy = T1y + s * ( aux) * effR;
    const a1 = Math.atan2(T1y - Cy, T1x - Cx);
    const a2 = Math.atan2(T2y - Cy, T2x - Cx);
    let da = a2 - a1;
    // pick the arc direction matching the turn sign, keeping the short arc
    if (s > 0) {
        while (da < 0) da += 2 * Math.PI;
        while (da > 2 * Math.PI) da -= 2 * Math.PI;
    } else {
        while (da > 0) da -= 2 * Math.PI;
        while (da < -2 * Math.PI) da += 2 * Math.PI;
    }
    const altDa = da - s * 2 * Math.PI;
    if (Math.abs(altDa) < Math.abs(da)) da = altDa;
    const out = [];
    for (let i = 0; i <= segments; i++) {
        const a = a1 + (da * i) / segments;
        out.push({ x: Cx + effR * Math.cos(a), y: Cy + effR * Math.sin(a) });
    }
    return out;
}

/**
 * Build the dog-bone aroma chamber with filleted internal corners and
 * two sensor strips. Returns a polyline entity plus the per-edge BC
 * map correctly mapped through the fillet expansion.
 */
const AROMA_CHAMBER_DOMAIN = () => {
    /* Sharp vertex list (CCW, y-up). Fillets are applied at the
       channel↔chamber junctions (indices 1,6,9,14) and the four outer
       chamber corners (2,5,10,13). The inlet/outlet vertices (0,7,8,15)
       stay sharp — filleting across a BC change would be ambiguous. */
    const sharpPts = [
        { x: 0,  y: 4  }, //  0  inlet BL
        { x: 10, y: 4  }, //  1  junction SW   ← fillet
        { x: 10, y: 0  }, //  2  chamber BL    ← fillet
        { x: 13, y: 0  }, //  3  sensor-bot L
        { x: 17, y: 0  }, //  4  sensor-bot R
        { x: 20, y: 0  }, //  5  chamber BR    ← fillet
        { x: 20, y: 4  }, //  6  junction SE   ← fillet
        { x: 30, y: 4  }, //  7  outlet BR
        { x: 30, y: 6  }, //  8  outlet TR
        { x: 20, y: 6  }, //  9  junction NE   ← fillet
        { x: 20, y: 10 }, // 10  chamber TR    ← fillet
        { x: 17, y: 10 }, // 11  sensor-top R
        { x: 13, y: 10 }, // 12  sensor-top L
        { x: 10, y: 10 }, // 13  chamber TL    ← fillet
        { x: 10, y: 6  }, // 14  junction NW   ← fillet
        { x: 0,  y: 6  }, // 15  inlet TL
    ];
    const sharpBCs = {
        0:  'wall',    // bottom of inlet
        1:  'wall',    // chamber-left below junction
        2:  'wall',    // chamber bottom left of sensor
        3:  'sensor',  // BOTTOM SENSOR
        4:  'wall',    // chamber bottom right of sensor
        5:  'wall',    // chamber-right below junction
        6:  'wall',    // bottom of outlet
        7:  'outlet',  // OUTLET
        8:  'wall',    // top of outlet
        9:  'wall',    // chamber-right above junction
        10: 'wall',    // chamber top right of sensor
        11: 'sensor',  // TOP SENSOR
        12: 'wall',    // chamber top left of sensor
        13: 'wall',    // chamber-left above junction
        14: 'wall',    // top of inlet
        15: 'inlet',   // INLET
    };
    const filletR = 1.0; // mm
    const filletSeg = 10;
    const filletVerts = new Set([1, 2, 5, 6, 9, 10, 13, 14]);

    /* Expand sharp vertices into filleted polyline, preserving BC of
       each original edge through the expansion. `emit()` records the
       BC of every output edge as we build the point list. */
    const outPts = [];
    const outEdgeBC = [];
    const n = sharpPts.length;

    const emit = (pt, incomingBC) => {
        if (outPts.length === 0) {
            outPts.push(pt);
            // Incoming BC for the first point is handled by the
            // final push after the loop (the closing edge).
        } else {
            outPts.push(pt);
            outEdgeBC.push(incomingBC);
        }
    };

    for (let i = 0; i < n; i++) {
        const curr = sharpPts[i];
        const incomingBC = sharpBCs[(i - 1 + n) % n]; // BC of edge (i-1)→i
        if (filletVerts.has(i)) {
            const prev = sharpPts[(i - 1 + n) % n];
            const next = sharpPts[(i + 1) % n];
            const arc = computeFilletArc(prev, curr, next, filletR, filletSeg);
            for (let k = 0; k < arc.length; k++) {
                /* First arc point = reached via original edge (i-1).
                   Subsequent arc points = internal arc edges → 'wall'
                   (both original adjacent edges are walls for every
                   filleted vertex in this geometry, by construction). */
                emit(arc[k], k === 0 ? incomingBC : 'wall');
            }
        } else {
            emit(curr, incomingBC);
        }
    }
    // Closing edge from last output point back to output[0] uses the
    // BC of original edge (n-1) → 0.
    outEdgeBC.push(sharpBCs[n - 1]);
    // Sanity: total edges must equal total points (closed polygon).
    // outEdgeBC currently has outPts.length entries.

    const ent = createPolylineEntity(outPts);
    ent.edgeBC = {};
    for (let j = 0; j < outEdgeBC.length; j++) {
        ent.edgeBC[j] = { type: outEdgeBC[j] };
    }
    return ent;
};

/** Vertical section across the chamber centre (x = 15 mm) used by the
 *  aroma demo so the Profile chart has data the instant Run finishes. */
const AROMA_CHAMBER_SECTION = () => ({
    id: 's_aroma_mid',
    type: 'section',
    label: 'Mid-chamber profile',
    color: SECTION_COLORS[0],
    visible: true,
    points: [{ x: 15, y: 0 }, { x: 15, y: 10 }],
});

/**
 * Guided-tour script for the aroma demo. Each step highlights one DOM
 * target (via `data-tour-id` attributes rendered elsewhere in the JSX)
 * and shows a short instruction card. Steps run ONLY when the user
 * clicks "Load aroma demo" — the regular workflow is not interrupted.
 *
 * target === null → centred overlay, no highlight (intro / outro).
 */
const AROMA_TOUR_STEPS = [
    {
        target: null,
        title: 'Welcome to the aroma demo',
        body: 'You just loaded a 1 cm × 1 cm chamber, 1 cm × 0.2 cm channels on each side, two wall sensors, and a rectangular NO₂ pulse at 25 °C / 40 % RH. This 11-step tour walks through what to look at. You can skip any time.',
    },
    {
        target: 'canvas',
        title: '1 / The geometry',
        body: 'Dog-bone layout with 8 filleted internal corners (r = 1 mm). Violet dashed edges are the two 4 mm sensor strips on the top and bottom chamber walls. The inlet is on the far left (highlighted blue), outlet on the far right.',
    },
    {
        target: 'gas-inlet',
        title: '2 / Inlet is in sccm mode',
        body: 'Flow rate 20 sccm, channel depth 1 mm. The solver back-computes U from Q and the inlet area. Change Q or depth → the "→ U" readout updates live and sensor t₅₀ shifts proportionally.',
    },
    {
        target: 'species',
        title: '3 / Species transport is on',
        body: 'Analyte = Nitrogen dioxide (NO₂) at 25 °C / 40 % RH (D ≈ 1.5×10⁻⁵ m²/s). Pulse = Rectangular, starts at t = 0.2 s (flow-development pre-roll), duration 1.0 s ≈ one residence time. Watch the Pe badge — it tells you advection vs. diffusion balance.',
    },
    {
        target: 'run',
        title: '4 / Press ▶ Run',
        body: 'Click the highlighted Run button now. The velocity field appears first; after ≈ 100 iterations the residual in the Convergence panel drops below 1e-4. At t = 0.2 s (sim time) the magenta aroma cloud starts to enter.',
    },
    {
        target: 'canvas',
        title: '5 / Watch the flow field',
        body: 'Turbo colormap shows |u| from 0 to the 95th percentile. The jet enters left, spreads into the chamber, re-contracts into the outlet. Because the corners are filleted, you should NOT see strong vortex stagnation near the walls.',
    },
    {
        target: 'canvas',
        title: '6 / Watch the aroma cloud',
        body: 'After t ≈ 0.2 s magenta c(x,y,t) appears at the inlet. It hugs the flow streamlines, sweeps through the chamber, and takes slightly longer to reach the walls than the centerline — that wall-delay is exactly what the sensors see.',
    },
    {
        target: 'sensor',
        title: '7 / Read the sensor response',
        body: 'c(t) and |u|(t) traces fill in live for S_top and S_bottom. Once the pulse has crossed the 10 / 50 / 90 % thresholds, the metrics row fills in: peak, tPeak, t₁₀, t₅₀, t₉₀, rise, FWHM, AUC. Symmetric sensors → matched traces; jet bias → skew.',
    },
    {
        target: 'flowrate',
        title: '8 / Check mass balance',
        body: 'Q_in and Q_out should both settle at ≈ 20 sccm, and their difference should converge to ~0. If not, the mesh is too coarse or τ is out of range — bump mesh resolution in the Solver mesh panel.',
    },
    {
        target: 'section',
        title: '9 / Profile across the chamber',
        body: 'A vertical section is pre-placed at x = 15 mm (mid-chamber). Switch the Profile dropdown from |u| to c to see the transverse concentration distribution during the pulse, or to c·u for mass flux.',
    },
    {
        target: 'sensor',
        title: '10 / Export your results',
        body: 'Sensors CSV exports the full c(t) + |u|(t) trace per sensor. Q(t) CSV in the Flow rate panel exports transient flow rate. Section CSV exports the profile along the probe line. File → Save Project JSON captures the full model + settings.',
    },
    {
        target: null,
        title: '11 / Try these experiments',
        body: 'All without redrawing: (a) swap analyte to Passive tracer → front visibly broadens (lower Pe). (b) Change pulse to Gaussian, σ = 0.05 s → FWHM collapses. (c) Bump Q to 40 sccm → t₅₀ halves. (d) Delete the fillets with the Trim tool → corner recirculation appears.',
    },
];

/** Pre-placed section across the channel centre — so the Profile chart
    has something to draw the moment the user first presses Run. */
/* Post-processing palette — chosen to be visually distinct on both
   dark and light canvases. Cycles when there are more sections than
   colors (rare). */
const SECTION_COLORS = [
    '#22d3ee', '#f472b6', '#a78bfa', '#fbbf24',
    '#34d399', '#fb923c', '#60a5fa', '#f87171',
];

/* All quantities the section-probe can plot. `compute(sample, tx, ty, nxn, nyn)`
   returns the scalar value in SI (m/s) — negative signs matter for
   directional ones (ux/uy/un/ut) so the chart can show reverse flow. */
const PROFILE_QUANTITIES = [
    { id: 'umag', label: '|u| magnitude',       unit: 'm/s', abbr: '|u|',
      compute: (s) => s.u_mps },
    { id: 'ux',   label: 'u_x (horizontal)',    unit: 'm/s', abbr: 'u_x',
      compute: (s) => s.ux_mps },
    { id: 'uy',   label: 'u_y (vertical)',      unit: 'm/s', abbr: 'u_y',
      compute: (s) => s.uy_mps },
    { id: 'un',   label: 'u·n (normal)',        unit: 'm/s', abbr: 'u·n',
      compute: (s, _tx, _ty, nxn, nyn) => s.ux_mps * nxn + s.uy_mps * nyn },
    { id: 'ut',   label: 'u·t (tangential)',    unit: 'm/s', abbr: 'u·t',
      compute: (s, tx, ty) => s.ux_mps * tx + s.uy_mps * ty },
];
const QUANTITY_BY_ID = Object.fromEntries(PROFILE_QUANTITIES.map((q) => [q.id, q]));

/* Choices for the Flow-rate-vs-time chart. The `key` must exactly
   match the field name written into each timeHistory row. `scale` is
   an optional multiplier applied purely for display on the chart Y
   axis (e.g. m³/s rendered in µL/min for readability); the raw CSV
   export stays in SI so downstream tools get unambiguous values. */
const TIME_QUANTITIES = [
    { id: 'Q_mlpm',    key: 'Q_mlpm',    label: 'Q (flow rate)', abbr: 'Q',    unit: 'mL/min' },
    { id: 'Q_m3ps',    key: 'Q_m3ps',    label: 'Q (SI)',        abbr: 'Q',    unit: 'm³/s' },
    { id: 'mean_mps',  key: 'mean_mps',  label: 'mean |u|',      abbr: 'ū',    unit: 'm/s' },
    { id: 'peak_mps',  key: 'peak_mps',  label: 'peak |u|',      abbr: 'ûₘₐₓ', unit: 'm/s' },
    { id: 'flux_m2ps', key: 'flux_m2ps', label: 'flux per m depth', abbr: '∫u·n',  unit: 'm²/s' },
];
const TIME_QUANTITY_BY_ID = Object.fromEntries(TIME_QUANTITIES.map((q) => [q.id, q]));

let sectionIdCounter = 0;
const nextSectionId = () => `s_${Date.now().toString(36)}_${++sectionIdCounter}`;

const DEFAULT_SECTION = () => ({
    id: 's_default',
    type: 'section',
    label: 'Section 1',
    color: SECTION_COLORS[0],
    visible: true,
    points: [{ x: 10, y: 0 }, { x: 10, y: 5 }],
});

/** One-time example scene for first paint + undo stack entry. Starts
 *  on the aroma-chamber demo so opening Flow Lab lands on a ready-to-
 *  Run species-transport configuration instead of the bare 20×5 mm
 *  channel. We build the ents/secs once and deep-clone into both the
 *  live state and the undo-history seed so Cmd-Z doesn't mint a new
 *  polygon id and make the first body appear to vanish. */
const FLOWLAB_INITIAL_SNAPSHOT = (() => {
    const ents = [AROMA_CHAMBER_DOMAIN()];
    const secs = [AROMA_CHAMBER_SECTION()];
    return {
        entities: JSON.parse(JSON.stringify(ents)),
        sections: JSON.parse(JSON.stringify(secs)),
    };
})();

const BC_TYPES = [
    { id: 'wall',   label: 'Wall (no-slip)' },
    { id: 'inlet',  label: 'Inlet (velocity)' },
    { id: 'outlet', label: 'Outlet (zero-gradient)' },
    { id: 'sensor', label: 'Sensor (probe wall)' },
];

/* Mesh resolution presets — longest-axis lattice cells. Finer meshes
   resolve thin features and wall gradients better but scale O(N²) in
   memory and O(N³) in wall-clock to reach steady state. The custom
   option lets power users push further if they're willing to wait. */
const MESH_PRESETS = [
    { id: 'coarse',     label: 'Coarse',     n: 150, hint: 'fast preview (≤ a few s)' },
    { id: 'medium',     label: 'Medium',     n: 300, hint: 'default balance' },
    { id: 'fine',       label: 'Fine',       n: 450, hint: 'resolves thin walls' },
    { id: 'very-fine',  label: 'Very fine',  n: 600, hint: 'slow but smooth' },
];
const DEFAULT_MESH_LONG_AXIS = 300;
const MIN_MESH_LONG_AXIS = 40;
const MAX_MESH_LONG_AXIS = 1000;

/* Minor-division-per-major grid options for the drawing grid. */
const MINOR_DIV_OPTIONS = [1, 2, 4, 5, 10];

/* Target longest-axis lattice resolution. `rasterizeDomain` derives the
   shorter axis from the aspect ratio so cells stay square (D2Q9 requires
   dx = dy). 300 lattice cells run at 30–60 fps on a modern laptop. */
const LATTICE_LONG_AXIS = 300;
const TARGET_U_LB = 0.05; // safe Mach for BGK

const FlowLabPage = ({ workspaceFiles = [], onSaveJson, onDeleteFile } = {}) => {
    /* ── Drawing + geometry state ────────────────────────────────── */
    const [entities, setEntities] = useState(() =>
        JSON.parse(JSON.stringify(FLOWLAB_INITIAL_SNAPSHOT.entities)));
    const [tool, setTool] = useState(TOOLS.SELECT);
    // `selection` now supports vertex picks alongside edge/entity picks:
    //   { entityId, edgeIdx?: number, vertexIdx?: number }
    const [selection, setSelection] = useState(null);
    /** Multi-selection for boolean / transform / join operations. A Set
     *  of entity ids. The primary `selection` above is always mirrored
     *  into this set (so a single select still works). Shift-click on
     *  an entity toggles its membership. */
    const [multiSelection, setMultiSelection] = useState(() => new Set());
    /** Offset distance (mm). User-editable via the floating inputs when
     *  the Offset tool is active. Positive → grows outward. */
    const [offsetDistanceMm, setOffsetDistanceMm] = useState(0.5);
    /** Mirror-axis scratch: click-drag defines a reflection line.
     *  { x0, y0, x1, y1 } while dragging. */
    const [mirrorDrag, setMirrorDrag] = useState(null);
    /** Move-tool scratch: first click = reference point, second click =
     *  target. Stores { x0, y0 } while waiting for the target. */
    const [movePending, setMovePending] = useState(null);
    /** Extend-tool scratch: first click picks a polyline endpoint.
     *  Stores { entityId, endpoint: 'start'|'end' } until a cutting-
     *  edge target is clicked. */
    const [extendPending, setExtendPending] = useState(null);
    /** Measure-tool state. `measurePending` holds the first clicked
     *  point while waiting for the second; `measurement` holds the
     *  finalized { p1, p2 } pair so the tooltip stays on screen until
     *  the user starts a new measurement, presses Escape, or deletes it. */
    const [measurePending, setMeasurePending] = useState(null);
    const [measurement, setMeasurement] = useState(null);
    /** Right-drag rubber-band in canvas pixel coords (local to wrap). */
    const [marqueeDrag, setMarqueeDrag] = useState(null);
    const [pendingPolyPoints, setPendingPolyPoints] = useState([]); // live polyline (closed)
    const [pendingLinePoints, setPendingLinePoints] = useState([]); // Line tool (open or closes-on-start)
    /** When the Line tool is used to "continue drawing" from an open
     *  polyline's free endpoint, the id of that polyline is remembered
     *  here. On close, that original entity is replaced by the newly
     *  formed closed polygon. Null otherwise. */
    const [pendingLineExtendId, setPendingLineExtendId] = useState(null);

    /** App-level mode toggle.
     *   - `false` → Simulation mode: CAD create/modify ribbons hidden,
     *     focus is on running and interpreting the simulation. Select,
     *     Section, Measure, Grid/View, Undo stay available.
     *   - `true`  → CAD mode: full geometry-authoring ribbon (Sketch,
     *     Modify, Combine) exposed for drawing / editing.
     *  The canvas, entity list and physics panels remain visible in
     *  both modes; only the toolbar contents change. */
    const [cadMode, setCadMode] = useState(false);
    const [rectDrag, setRectDrag] = useState(null); // {x0,y0,x1,y1}
    const [circleDrag, setCircleDrag] = useState(null); // {cx,cy,r}
    const [sectionDrag, setSectionDrag] = useState(null); // {x0,y0,x1,y1} during drag
    const [sections, setSections] = useState(() =>
        JSON.parse(JSON.stringify(FLOWLAB_INITIAL_SNAPSHOT.sections)));
    /* Post-sim analysis state */
    const [profileQuantity, setProfileQuantity] = useState('umag');
    /* Out-of-plane depth assumption (mm). LBM is 2D; users need this to
       convert flux per-metre-depth into an actual volumetric flow rate. */
    const [channelDepthMm, setChannelDepthMm] = useState(1);
    /* Inlet BC mode — either velocity (m/s, what the solver consumes
       directly) or volumetric flow rate (sccm, which is how gas-delivery
       engineers actually think). When set to sccm, the effective inlet
       velocity is back-computed from Q, the inlet edge length and the
       channel depth. */
    const [inletMode, setInletMode] = useState('sccm'); // 'velocity' | 'sccm'
    const [inletQ_sccm, setInletQ_sccm] = useState(20); // default 20 sccm (aroma-demo)
    /* Species transport — enable the passive-scalar solver overlay so
       the user can watch an aroma pulse wash through the device and
       time its arrival at sensor surfaces. Defaults ON so Flow Lab
       opens on the ready-to-Run aroma-chamber demo. */
    const [speciesEnabled, setSpeciesEnabled] = useState(true);
    /* Default analyte: Nitrogen dioxide (NO₂) — the most common
       "reactive inorganic" target for our sensor work. Users can switch
       to the passive tracer, NO, or any VOC from the dropdown. */
    const [analyteId, setAnalyteId] = useState('no2');
    const [customD_m2s, setCustomD_m2s] = useState(1.0e-5);
    /* Sample-side conditions. Temperature scales the tabulated D_AB
       (Fuller-Schettler-Giddings, T^1.75); RH is stored as metadata
       and surfaced in CSV headers / UI hints. */
    const [analyteT_C, setAnalyteT_C] = useState(25);
    const [analyteRH_pct, setAnalyteRH_pct] = useState(40);
    /* Default pulse: Rectangular with a short 0.2 s flow-development
       pre-roll followed by a 1 s exposure (≈ one chamber residence
       time at typical 1 cm / 1 cm·s⁻¹ settings). This gives the sensor
       a clear rise-plateau-fall response out of the box — far more
       informative than a fire-and-forget step function. */
    const [pulseId, setPulseId] = useState('rect');
    const [pulseParams, setPulseParams] = useState(() =>
        Object.fromEntries(pulseProfileById('rect').params.map((p) => [p.id, p.default])));
    /* Live sensor-response history — keyed by sensor edgeIdx.
       Each entry: { t_s: [...], c: [...], u: [...] }. Grows during a
       run, cleared on reset / species-reset. Kept in refs for O(1)
       appends, mirrored to state each snapshot so charts re-render. */
    const sensorHistoryRef = useRef({});
    const [sensorHistory, setSensorHistory] = useState({});
    /* Which section's detailed stats card to show. */
    const [selectedSectionId, setSelectedSectionId] = useState('s_aroma_mid');
    /* Point probe — last clicked world coord (mm) to show local quantities. */
    const [probePoint, setProbePoint] = useState(null);

    /* Point probes — user-placed dots inside the fluid that sample the
       velocity + concentration fields each frame (bilinear interpolation
       of the solver grid) and feed their time history straight into the
       Sensor response panel alongside any wall sensors. Unlike wall
       sensors, these are NOT a boundary condition — they're passive
       observers, so you can drop them anywhere in the domain.
       Shape: [{ id, label, x_mm, y_mm, color }]. */
    const [pointProbes, setPointProbes] = useState([]);
    const pointProbesRef = useRef([]);
    useEffect(() => { pointProbesRef.current = pointProbes; }, [pointProbes]);

    /* Pulse event banner — shown over the canvas for a few seconds when
       the commanded inlet concentration crosses in or out of zero. The
       ref holds the previous value so we can detect edges without
       re-rendering every frame just to compare. */
    const prevCInletRef = useRef(0);
    const pulseBannerTimerRef = useRef(null);
    const [pulseBanner, setPulseBanner] = useState(null); // { kind, t_s, peak }

    /* Flow Lab file explorer modal. `explorerOpen` toggles the UI,
       `explorerCwd` is the currently-browsed virtual subfolder path
       (empty string = Flow Lab root). */
    const [explorerOpen, setExplorerOpen] = useState(false);
    const [visualizerOpen, setVisualizerOpen] = useState(false);
    const [explorerCwd, setExplorerCwd] = useState('');
    const [explorerExpanded, setExplorerExpanded] = useState(() => new Set(['']));

    /* Guided-tour state. `tourIdx` is the step index into
       `AROMA_TOUR_STEPS`, or null when the tour is inactive. Only set
       by the "Load aroma demo" button — the tour is OPT-IN so regular
       workflow is never interrupted. */
    const [tourIdx, setTourIdx] = useState(null);

    /* ── Undo / Redo stack ───────────────────────────────────────── */
    // history is a list of snapshots { entities, sections }; pointer `historyIdx`
    // points to the currently-displayed state. New edits truncate the redo tail.
    const HISTORY_LIMIT = 80;
    const [history, setHistory] = useState(() => [
        JSON.parse(JSON.stringify(FLOWLAB_INITIAL_SNAPSHOT)),
    ]);
    const [historyIdx, setHistoryIdx] = useState(0);
    const skipNextHistoryRef = useRef(false);

    /* ── Save / Load project state ──────────────────────────────── */
    const [projectName, setProjectName] = useState('untitled');
    const [saveStatus, setSaveStatus] = useState('');
    /**
     * The workspace file the user is currently editing. When this is
     * set, Save overwrites it in-place. When it's null (fresh canvas
     * or after "New"), Save behaves like Save As and prompts for a
     * filename.
     *
     * `currentProjectFileName` is tracked alongside so we can display
     * it in the status bar and use the exact on-disk name for the
     * overwrite (no random "untitled (2).flow.json" duplicates).
     */
    const [currentProjectFileId, setCurrentProjectFileId] = useState(null);
    const [currentProjectFileName, setCurrentProjectFileName] = useState(null);
    const [isDirty, setIsDirty] = useState(false);
    // Used to suppress the dirty flag on the very first geometry init
    // and on "Load Project" (which swaps entities without a user edit).
    const skipNextDirtyRef = useRef(true);

    /* ── Fillet tool radius (mm, internal) ───────────────────────
       User edits it through the toolbar input which converts via the
       `unit` toggle. 0.5 mm ≈ 500 µm is a sensible default for most
       millimetre-scale channels. */
    const [filletRadiusMm, setFilletRadiusMm] = useState(0.5);

    /* ── Floating property dialog (SolidWorks-style PM) ──────────
       Anchors to the selected vertex / edge / entity and lives as a
       portal over the whole page. `dismissed` hides it until the user
       picks something new. `userPos` lets them drag it around. */
    const [propDialogDismissed, setPropDialogDismissed] = useState(false);
    const [propDialogUserPos, setPropDialogUserPos] = useState(null);

    /* ── Viewport ────────────────────────────────────────────────── */
    const canvasWrapRef = useRef(null);
    const [viewport, setViewport] = useState({ pxPerMm: 30, tx: 60, ty: 60 });
    const [canvasSize, setCanvasSize] = useState({ w: 800, h: 480 });
    const [cursorWorld, setCursorWorld] = useState(null);
    const [unit, setUnit] = useState('mm');
    const [gridOn, setGridOn] = useState(true);
    const [snapOn, setSnapOn] = useState(true);
    // Drawing-grid appearance overrides. `gridStepOverrideMm = null` means
    // "auto" (scale with zoom); a number pins the step. `minorDivisions`
    // controls how many minor ticks sit between each major tick.
    const [gridStepOverrideMm, setGridStepOverrideMm] = useState(null);
    const [gridStepMinMm, setGridStepMinMm] = useState(null);
    const [minorDivisions, setMinorDivisions] = useState(5);
    const [gridSettingsOpen, setGridSettingsOpen] = useState(false);
    const gridSettingsBtnRef = useRef(null);

    /* Panel visibility — user can hide the left / right side panels to
     * maximise the CAD canvas. Preferences persist in localStorage so
     * they stick across sessions (but are NOT part of the saved project,
     * which is meant to be portable geometry / BC data only). */
    const [leftPanelOpen, setLeftPanelOpen] = useState(() => {
        try { const v = localStorage.getItem('flowlab.leftPanelOpen'); return v == null ? true : v === '1'; }
        catch { return true; }
    });
    const [rightPanelOpen, setRightPanelOpen] = useState(() => {
        try { const v = localStorage.getItem('flowlab.rightPanelOpen'); return v == null ? true : v === '1'; }
        catch { return true; }
    });
    /** When true, both side panels auto-collapse whenever a non-Select
     *  CAD tool is active or a drawing interaction is in progress — so
     *  the canvas is at max size during modelling. As soon as the user
     *  is idle in Select mode again the panels re-appear. */
    const [panelsAutoHide, setPanelsAutoHide] = useState(() => {
        try { return localStorage.getItem('flowlab.panelsAutoHide') === '1'; }
        catch { return false; }
    });
    useEffect(() => {
        try { localStorage.setItem('flowlab.leftPanelOpen', leftPanelOpen ? '1' : '0'); } catch (_) { /* ignore */ }
    }, [leftPanelOpen]);
    useEffect(() => {
        try { localStorage.setItem('flowlab.rightPanelOpen', rightPanelOpen ? '1' : '0'); } catch (_) { /* ignore */ }
    }, [rightPanelOpen]);
    useEffect(() => {
        try { localStorage.setItem('flowlab.panelsAutoHide', panelsAutoHide ? '1' : '0'); } catch (_) { /* ignore */ }
    }, [panelsAutoHide]);

    /* Persist cadMode across sessions. */
    useEffect(() => {
        try { localStorage.setItem('flowlab.cadMode', cadMode ? '1' : '0'); } catch (_) { /* ignore */ }
    }, [cadMode]);
    /* Restore on mount. Safe to do once; subsequent writes are handled
       by the effect above. */
    useEffect(() => {
        try {
            const v = localStorage.getItem('flowlab.cadMode');
            if (v === '1') setCadMode(true);
        } catch (_) { /* ignore */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* When leaving CAD mode, snap back to a Simulation-safe tool and
       clear any in-progress draw scratch. Otherwise the user could be
       stranded "mid-polyline" with no ribbon to finish the action. */
    useEffect(() => {
        if (cadMode) return;
        const allowed = new Set([TOOLS.SELECT, TOOLS.SECTION, TOOLS.MEASURE, TOOLS.PROBE]);
        if (!allowed.has(tool)) setTool(TOOLS.SELECT);
        setPendingPolyPoints([]);
        setPendingLinePoints([]);
        setPendingLineExtendId(null);
        setRectDrag(null);
        setCircleDrag(null);
        setMirrorDrag(null);
        setMovePending(null);
        setExtendPending(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cadMode]);

    /* "Modelling in progress" = user is actively sketching / modifying —
     *  used for the optional auto-hide behaviour so the panels get out
     *  of the way while the canvas is in use. */
    const modellingInProgress = (
        tool !== TOOLS.SELECT ||
        !!rectDrag || !!circleDrag ||
        (pendingPolyPoints && pendingPolyPoints.length > 0) ||
        (pendingLinePoints && pendingLinePoints.length > 0) ||
        !!mirrorDrag || !!movePending || !!extendPending ||
        !!measurePending || !!marqueeDrag
    );
    const showLeftPanel = leftPanelOpen && !(panelsAutoHide && modellingInProgress);
    const showRightPanel = rightPanelOpen && !(panelsAutoHide && modellingInProgress);
    // Solver mesh resolution (long-axis lattice cells). Exposed so users can
    // trade speed vs accuracy per project.
    const [meshLongAxis, setMeshLongAxis] = useState(DEFAULT_MESH_LONG_AXIS);

    /* ── Physics / solver ────────────────────────────────────────── */
    const [gasId, setGasId] = useState('air');
    const gas = gasById(gasId);
    const [inletU_m_s, setInletU_m_s] = useState(0.1);
    const [colormap, setColormap] = useState('turbo');
    const [running, setRunning] = useState(false);
    /* Broadcast running state so other parts of the app (e.g. the
       Sidebar's Flow Lab nav button) can show a "sim running" dot while
       the user is on a different page. The Sidebar listens for this
       event; if nobody listens, this is a cheap no-op. */
    useEffect(() => {
        if (typeof window === 'undefined') return;
        try {
            window.__flowLabRunning = !!running;
            window.dispatchEvent(
                new CustomEvent('flowlab-running-change', { detail: { running: !!running } })
            );
        } catch { /* ignore */ }
    }, [running]);
    const [solverInfo, setSolverInfo] = useState(null); // {nx, ny, tau, dx_m, dt_s, bbox}
    const [field, setField] = useState(null); // {nx, ny, umag, umax, iter, residual}
    const [solverWarning, setSolverWarning] = useState(null);
    const [residualHistory, setResidualHistory] = useState([]); // [{iter, residual}]
    const residualHistoryRef = useRef([]); // mirror for setState-free appends inside onmessage
    const STEADY_THRESHOLD = 1e-4;
    const STEADY_WINDOW = 8; // consecutive posts below threshold → "steady"

    /* Optional user-specified maximum simulation time (in seconds of
       physical time). When set, the solver keeps marching past steady
       state and auto-pauses once `field.t_s >= simDurationS`. When
       left blank / null, the original behaviour is preserved: auto-
       pause on steady-state convergence. Useful for pulse studies
       where you want to watch the c(t) decay tail well after steady
       state for the velocity field has been reached. */
    const [simDurationS, setSimDurationS] = useState('');
    const simDurationNum = (() => {
        if (simDurationS === '' || simDurationS == null) return null;
        const v = Number(simDurationS);
        return Number.isFinite(v) && v > 0 ? v : null;
    })();

    /* Transient flow-rate history. Populated as the solver marches —
       one row per field post with the physical time and, per visible
       section, Q (vol. flow rate), mean / peak |u|, σ, and flux. Used
       by the Flow-rate-vs-time chart, the steady-state summary table,
       and the time-history CSV export. */
    const [timeHistory, setTimeHistory] = useState([]);
    const timeHistoryRef = useRef([]);
    const lastRecordedIterRef = useRef(-1);
    const TIME_HISTORY_MAX = 2000;
    /* `steadyIter` is derived from residualHistory via useMemo below;
       we mirror it into a ref so callbacks defined EARLIER in the
       component body (e.g. handleSaveResult) can read the latest
       value without forcing a forward reference (which would cause a
       TDZ error at render-time). */
    const steadyIterRef = useRef(null);

    /* Which quantity to plot on the Flow-rate-vs-time chart. Mirrors
       the keys used in the time-history rows so the chart can look up
       values cheaply. Labels/units come from TIME_QUANTITIES below. */
    const [transientQuantity, setTransientQuantity] = useState('Q_mlpm');

    /* Web Worker lifecycle. Created lazily when user hits play; torn
       down on reset. Re-using a single worker across multiple runs
       avoids the ~50 ms cold-start on each click. */
    const workerRef = useRef(null);
    const heatmapCanvasRef = useRef(null);
    /* Secondary canvas that renders the aroma-concentration field on
     * top of the velocity heatmap when species transport is enabled.
     * Uses a white-hot → magenta colour ramp with alpha driven by the
     * local concentration, so the velocity colours still bleed through
     * at low c and the pulse front lights up visibly at high c. */
    const speciesCanvasRef = useRef(null);
    const [showSpeciesOverlay, setShowSpeciesOverlay] = useState(false);
    /* The fluid/wall mask is needed on the main thread for (a) rendering
       wall cells as transparent on the heatmap, and (b) skipping walls
       when integrating streamlines. We keep it in a ref (it never needs
       to trigger a re-render by itself). */
    const maskRef = useRef(null);
    /* Streamlines overlay — recomputed from each field snapshot. */
    const [showStreamlines, setShowStreamlines] = useState(true);

    /* ── Undo / Redo plumbing ────────────────────────────────────
       Pattern: whenever `entities` or `sections` change we push a
       fresh snapshot to the history stack — unless the change came
       from undo/redo itself (marked via `skipNextHistoryRef`). Keeps
       the interface to the rest of the component identical to before
       (still plain `setEntities(…)` calls) while giving us Cmd-Z
       for free. */
    useEffect(() => {
        if (skipNextHistoryRef.current) {
            skipNextHistoryRef.current = false;
            return;
        }
        setHistory((prev) => {
            const trimmed = prev.slice(0, historyIdx + 1);
            trimmed.push({
                entities: JSON.parse(JSON.stringify(entities)),
                sections: JSON.parse(JSON.stringify(sections)),
            });
            while (trimmed.length > HISTORY_LIMIT) trimmed.shift();
            return trimmed;
        });
        setHistoryIdx((i) => Math.min(i + 1, HISTORY_LIMIT - 1));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entities, sections]);

    /* Mark the project dirty on any entity/section change after the
       first mount or after a Load. `skipNextDirtyRef` is set true at
       component init and flipped true again right before we commit a
       Load so we don't paint a freshly-loaded file as modified. */
    useEffect(() => {
        if (skipNextDirtyRef.current) {
            skipNextDirtyRef.current = false;
            return;
        }
        setIsDirty(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entities, sections]);

    const undo = useCallback(() => {
        const next = Math.max(0, historyIdx - 1);
        if (next === historyIdx) return;
        const snap = history[next];
        if (!snap) return;
        skipNextHistoryRef.current = true;
        setEntities(JSON.parse(JSON.stringify(snap.entities)));
        skipNextHistoryRef.current = true;
        setSections(JSON.parse(JSON.stringify(snap.sections)));
        setHistoryIdx(next);
    }, [history, historyIdx]);

    const redo = useCallback(() => {
        const next = Math.min(history.length - 1, historyIdx + 1);
        if (next === historyIdx) return;
        const snap = history[next];
        if (!snap) return;
        skipNextHistoryRef.current = true;
        setEntities(JSON.parse(JSON.stringify(snap.entities)));
        skipNextHistoryRef.current = true;
        setSections(JSON.parse(JSON.stringify(snap.sections)));
        setHistoryIdx(next);
    }, [history, historyIdx]);

    const canUndo = historyIdx > 0;
    const canRedo = historyIdx < history.length - 1;

    /* ── Surgical deletion of the current selection ──────────────
       Called by both the Del key and the toolbar "Cut" button.
       The logic mirrors the keyboard path so each entry point stays
       consistent:
         • Vertex selected  → drop that vertex; re-index BCs.
         • Edge selected    → BREAK that segment (open closed polygon,
           or split open polyline). Matches the DELETE tool's edge
           click behaviour so the two entry points feel the same.
         • Entity selected  → remove the whole entity. */
    const deleteSelection = useCallback(() => {
        if (!selection) return;
        const ent = entities.find((en) => en.id === selection.entityId);
        if (!ent) return;
        if (selection.vertexIdx != null) {
            const next = removeVertexAt(ent, selection.vertexIdx);
            setEntities((es) => next
                ? es.map((en) => (en.id === ent.id ? next : en))
                : es.filter((en) => en.id !== ent.id));
            setSelection(next ? { entityId: ent.id, edgeIdx: null, vertexIdx: null } : null);
        } else if (selection.edgeIdx != null) {
            const replacements = removeEdgeAt(ent, selection.edgeIdx);
            setEntities((es) => {
                const idx = es.findIndex((en) => en.id === ent.id);
                if (idx < 0) return es;
                const next = es.slice();
                next.splice(idx, 1, ...replacements);
                return next;
            });
            setSelection(null);
        } else {
            setEntities((es) => es.filter((en) => en.id !== ent.id));
            setSelection(null);
        }
    }, [selection, entities]);

    /* ── Multi-selection helpers & CAD ops ──────────────────────────
     * All the pro-grade CAD operations that need two or more selected
     * polygons (boolean ops, join-to-region) or at least one (offset,
     * mirror). The multi-selection set is the source of truth; we fall
     * back to the primary selection when a user hasn't explicitly
     * shift-clicked a group. */

    /** Resolve the set of entities the CAD ops should act on. Prefers
     *  the multi-selection, falls back to the single primary selection. */
    const activeSelectionIds = useMemo(() => {
        if (multiSelection.size > 0) return Array.from(multiSelection);
        if (selection?.entityId) return [selection.entityId];
        return [];
    }, [multiSelection, selection]);

    const selectedEntities = useMemo(
        () => activeSelectionIds.map((id) => entities.find((en) => en.id === id)).filter(Boolean),
        [activeSelectionIds, entities]
    );

    const closedSelectedEntities = useMemo(
        () => selectedEntities.filter((en) => en.closed !== false),
        [selectedEntities]
    );

    const openSelectedEntities = useMemo(
        () => selectedEntities.filter((en) => en.closed === false),
        [selectedEntities]
    );

    /** Apply a boolean op to the currently-selected closed polygons.
     *  Replaces the operands with the result in-place (the first
     *  operand's index becomes the insertion point). */
    const applyBooleanOp = useCallback((opFn, opLabel) => {
        const sel = closedSelectedEntities;
        if (sel.length < 2) {
            setSolverWarning(`${opLabel} needs at least 2 closed polygons selected (Shift-click to add).`);
            return;
        }
        try {
            const result = opFn(sel);
            if (!result || result.length === 0) {
                setSolverWarning(`${opLabel} produced an empty region — operands may not overlap.`);
                return;
            }
            const operandIds = new Set(sel.map((e) => e.id));
            setEntities((es) => {
                const out = [];
                let inserted = false;
                for (const en of es) {
                    if (operandIds.has(en.id)) {
                        if (!inserted) { out.push(...result); inserted = true; }
                    } else {
                        out.push(en);
                    }
                }
                return out;
            });
            // Focus the first result entity.
            setSelection({ entityId: result[0].id, edgeIdx: null, vertexIdx: null });
            setMultiSelection(new Set([result[0].id]));
            setSolverWarning(null);
        } catch (err) {
            setSolverWarning(`${opLabel} failed: ${err.message || 'unknown error'}`);
        }
    }, [closedSelectedEntities]);

    const runUnion     = useCallback(() => applyBooleanOp(booleanUnion,     'Union'),     [applyBooleanOp]);
    const runSubtract  = useCallback(() => applyBooleanOp(booleanSubtract,  'Subtract'),  [applyBooleanOp]);
    const runIntersect = useCallback(() => applyBooleanOp(booleanIntersect, 'Intersect'), [applyBooleanOp]);
    const runXor       = useCallback(() => applyBooleanOp(booleanXor,       'XOR'),       [applyBooleanOp]);

    /** Join-to-Region: take all open polylines currently selected and
     *  stitch them into a single closed polygon. The operands are
     *  removed and replaced with the new region. */
    const runJoinToRegion = useCallback(() => {
        const opens = openSelectedEntities;
        if (opens.length === 0) {
            setSolverWarning('Make region: select at least one open polyline (Shift-click to add more).');
            return;
        }
        const tol_mm = 4 / viewport.pxPerMm; // endpoint snap tolerance scales with zoom
        const res = joinPolylinesIntoRegion(opens, { tol_mm });
        if (!res.ok) { setSolverWarning(res.reason); return; }
        const operandIds = new Set(opens.map((e) => e.id));
        setEntities((es) => {
            const out = [];
            let inserted = false;
            for (const en of es) {
                if (operandIds.has(en.id)) {
                    if (!inserted) { out.push(res.entity); inserted = true; }
                } else {
                    out.push(en);
                }
            }
            return out;
        });
        setSelection({ entityId: res.entity.id, edgeIdx: null, vertexIdx: null });
        setMultiSelection(new Set([res.entity.id]));
        setSolverWarning('Region formed from ' + opens.length + ' polyline' + (opens.length === 1 ? '' : 's') + '. Tag edges as Inlet / Outlet / Wall.');
    }, [openSelectedEntities, viewport.pxPerMm]);

    /* ── New / blank canvas ──────────────────────────────────────
       Wipes all geometry, sections, selection and the running
       solver. Undoable via Cmd-Z because the history effect picks
       up the entities/sections change automatically. */
    const startNewProject = useCallback(() => {
        // Kill any solver first so its lattice mask doesn't linger.
        if (workerRef.current) {
            workerRef.current.terminate();
            workerRef.current = null;
        }
        maskRef.current = null;
        setField(null);
        setSolverInfo(null);
        setRunning(false);
        setResidualHistory([]);
        residualHistoryRef.current = [];
        setTimeHistory([]);
        timeHistoryRef.current = [];
        lastRecordedIterRef.current = -1;
        setSolverWarning(null);

        // Clear drawing state.
        setPendingPolyPoints([]);
        setPendingLinePoints([]);
        setRectDrag(null);
        setCircleDrag(null);
        setSectionDrag(null);
        setSelection(null);

        // The big deletes — these are the ones the history hook picks
        // up, so Cmd-Z brings the example channel back.
        setEntities([]);
        setSections([]);

        setProjectName('untitled');
        setCurrentProjectFileId(null);
        setCurrentProjectFileName(null);
        setIsDirty(false);
        setSaveStatus('New project — canvas cleared. ⌘Z to undo.');
        setTimeout(() => setSaveStatus(''), 4000);
    }, []);

    /* ── All Flow Lab files (projects + results + folder markers) ─
       Everything in the workspace's top-level "Flow Lab" folder. */
    const flowLabFiles = useMemo(() => {
        if (!Array.isArray(workspaceFiles) || workspaceFiles.length === 0) return [];
        const folder = workspaceFiles.find(
            (f) => f?.isFolder && String(f.name).toLowerCase() === FLOWLAB_FOLDER_NAME.toLowerCase()
        );
        if (!folder) return [];
        return workspaceFiles
            .filter((f) => f && !f.isFolder && String(f.folderId) === String(folder.id))
            .map((f) => ({
                ...f,
                _kind: String(f.name).toLowerCase().endsWith(PROJECT_FILE_SUFFIX) ? 'project'
                     : String(f.name).toLowerCase().endsWith(RESULT_FILE_SUFFIX)  ? 'result'
                     : String(f.name).endsWith(FOLDER_MARKER_NAME)                ? 'marker'
                     : 'other',
            }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }, [workspaceFiles]);

    /* Legacy: projects only, flat list (used by the classic Open dropdown). */
    const projectFiles = useMemo(
        () => flowLabFiles.filter((f) => f._kind === 'project'),
        [flowLabFiles]
    );

    /* Build a virtual file tree from the flat list. Sub-folders come
       from '/' characters in the file name (or from marker files for
       otherwise-empty folders). Tree nodes:
         { type:'folder', name, path, children:[], files:[] }
         { type:'file',   name, path, file } */
    const fileTree = useMemo(() => {
        const root = { type: 'folder', name: '', path: '', children: new Map(), files: [] };
        const ensureFolder = (pathParts) => {
            let cur = root;
            let accum = '';
            for (const p of pathParts) {
                accum = accum ? `${accum}/${p}` : p;
                if (!cur.children.has(p)) {
                    cur.children.set(p, {
                        type: 'folder',
                        name: p,
                        path: accum,
                        children: new Map(),
                        files: [],
                    });
                }
                cur = cur.children.get(p);
            }
            return cur;
        };
        for (const f of flowLabFiles) {
            const { parts, base } = splitPath(f.name);
            const folderNode = ensureFolder(parts);
            // Marker files just keep empty folders alive — don't list them.
            if (f._kind === 'marker') continue;
            folderNode.files.push({
                type: 'file',
                name: base,
                path: f.name,
                file: f,
            });
        }
        // Convert Map → sorted array recursively for render predictability.
        const finalise = (node) => ({
            ...node,
            children: Array.from(node.children.values())
                .map(finalise)
                .sort((a, b) => a.name.localeCompare(b.name)),
            files: node.files.sort((a, b) => a.name.localeCompare(b.name)),
        });
        return finalise(root);
    }, [flowLabFiles]);

    const serializeProject = useCallback(() => ({
        schema: PROJECT_SCHEMA,
        savedAt: new Date().toISOString(),
        name: projectName,
        unit,
        gasId,
        inletU_m_s,
        inletMode,
        inletQ_sccm,
        channelDepthMm,
        speciesEnabled,
        analyteId,
        customD_m2s,
        analyteT_C,
        analyteRH_pct,
        pulseId,
        pulseParams,
        colormap,
        showStreamlines,
        meshLongAxis,
        simDurationS,
        gridStepOverrideMm,
        gridStepMinMm,
        minorDivisions,
        entities: JSON.parse(JSON.stringify(entities)),
        sections: JSON.parse(JSON.stringify(sections)),
        pointProbes: JSON.parse(JSON.stringify(pointProbes)),
    }), [projectName, unit, gasId, inletU_m_s, inletMode, inletQ_sccm, channelDepthMm,
         speciesEnabled, analyteId, customD_m2s, analyteT_C, analyteRH_pct, pulseId, pulseParams,
         colormap, showStreamlines,
         meshLongAxis, simDurationS, gridStepOverrideMm, gridStepMinMm, minorDivisions, entities, sections,
         pointProbes]);

    /**
     * Quick Save — writes to the file the user already opened / last
     * saved to (by id). If nothing is open yet (fresh "New" canvas or
     * first-ever save), falls through to Save As so the user gets a
     * chance to name it.
     */
    const handleSaveProject = useCallback(async () => {
        if (!onSaveJson) {
            setSaveStatus('Save is not available (workspace unavailable).');
            return;
        }
        // Nothing open yet → behave like Save As on the first save.
        if (!currentProjectFileId || !currentProjectFileName) {
            return handleSaveAsProject(); // eslint-disable-line no-use-before-define
        }
        try {
            setSaveStatus('Saving…');
            const json = { ...serializeProject(), name: projectName };
            const res = await onSaveJson({
                folderName: FLOWLAB_FOLDER_NAME,
                fileName: currentProjectFileName,
                fileId: currentProjectFileId,
                json,
            });
            // The saver may have returned a (possibly new) fileId — keep
            // our handle pointing at the canonical row.
            if (res?.fileId) setCurrentProjectFileId(res.fileId);
            setIsDirty(false);
            setSaveStatus(`Saved → Flow Lab/${currentProjectFileName}`);
            setTimeout(() => setSaveStatus(''), 3000);
        } catch (err) {
            console.error('Flow Lab save failed:', err);
            setSaveStatus(`Save failed: ${err?.message || err}`);
        }
        return undefined;
    }, [onSaveJson, serializeProject, projectName, currentProjectFileId, currentProjectFileName]);

    /**
     * Save As — always prompts for a name and creates (or overwrites
     * a same-named) file. Updates the "currently open" handle so the
     * next plain Save goes back to this file without asking. An optional
     * `{ dir }` lets the explorer target a sub-folder path.
     */
    const handleSaveAsProject = useCallback(async ({ dir = '' } = {}) => {
        if (!onSaveJson) {
            setSaveStatus('Save is not available (workspace unavailable).');
            return;
        }
        const defaultName = projectName && projectName !== 'untitled' ? projectName : 'untitled';
        const rawName = (typeof window !== 'undefined'
            ? window.prompt('Save project as:', defaultName)
            : null);
        if (!rawName) return;
        const safe = String(rawName)
            .trim()
            .replace(/[\\/:*?"<>|]/g, '-')
            .slice(0, 80) || 'untitled';
        const baseName = safe.toLowerCase().endsWith(PROJECT_FILE_SUFFIX)
            ? safe
            : `${safe}${PROJECT_FILE_SUFFIX}`;
        const fileName = joinPath(dir, baseName);
        try {
            setSaveStatus('Saving…');
            const json = { ...serializeProject(), name: safe };
            const res = await onSaveJson({ folderName: FLOWLAB_FOLDER_NAME, fileName, json });
            setProjectName(safe);
            if (res?.fileId) setCurrentProjectFileId(res.fileId);
            setCurrentProjectFileName(fileName);
            setIsDirty(false);
            setSaveStatus(res?.overwritten
                ? `Replaced → Flow Lab/${fileName}`
                : `Saved → Flow Lab/${fileName}`);
            setTimeout(() => setSaveStatus(''), 3500);
        } catch (err) {
            console.error('Flow Lab save failed:', err);
            setSaveStatus(`Save failed: ${err?.message || err}`);
        }
    }, [onSaveJson, serializeProject, projectName]);

    const handleLoadProject = useCallback((fileId) => {
        if (!fileId) return;
        const file = projectFiles.find((f) => f.id === fileId);
        if (!file) return;
        // Saved projects live in the `data` slot (see handleSaveJsonToWorkspace
        // in App.jsx — it writes JSON directly as `data`).
        const json = file.data
            ?? (typeof file.csvText === 'string' ? (() => { try { return JSON.parse(file.csvText); } catch { return null; } })() : null);
        if (!json || json.schema !== PROJECT_SCHEMA) {
            setSaveStatus(`Can't load "${file.name}" — not a Flow Lab project.`);
            return;
        }
        // Terminate any running solver — loaded geometry invalidates the mask.
        if (workerRef.current) {
            workerRef.current.terminate();
            workerRef.current = null;
        }
        maskRef.current = null;
        setField(null);
        setSolverInfo(null);
        setRunning(false);
        setResidualHistory([]);
        residualHistoryRef.current = [];
        setTimeHistory([]);
        timeHistoryRef.current = [];
        lastRecordedIterRef.current = -1;

        skipNextHistoryRef.current = true;
        skipNextDirtyRef.current = true;
        setEntities(JSON.parse(JSON.stringify(json.entities || [])));
        skipNextHistoryRef.current = true;
        skipNextDirtyRef.current = true;
        {
            // Back-fill colour/label/visible on sections from older saves.
            const rawSections = JSON.parse(JSON.stringify(json.sections || []));
            setSections(rawSections.map((s, idx) => ({
                visible: true,
                label: `Section ${idx + 1}`,
                color: SECTION_COLORS[idx % SECTION_COLORS.length],
                ...s,
            })));
            setSelectedSectionId(rawSections[0]?.id || null);
        }
        if (json.unit) setUnit(json.unit);
        if (json.gasId) setGasId(json.gasId);
        if (typeof json.inletU_m_s === 'number') setInletU_m_s(json.inletU_m_s);
        if (json.inletMode === 'velocity' || json.inletMode === 'sccm') setInletMode(json.inletMode);
        if (typeof json.inletQ_sccm === 'number' && Number.isFinite(json.inletQ_sccm)) setInletQ_sccm(json.inletQ_sccm);
        if (typeof json.speciesEnabled === 'boolean') setSpeciesEnabled(json.speciesEnabled);
        if (typeof json.analyteId === 'string') setAnalyteId(json.analyteId);
        if (typeof json.customD_m2s === 'number' && Number.isFinite(json.customD_m2s)) setCustomD_m2s(json.customD_m2s);
        if (typeof json.analyteT_C === 'number' && Number.isFinite(json.analyteT_C)) setAnalyteT_C(json.analyteT_C);
        if (typeof json.analyteRH_pct === 'number' && Number.isFinite(json.analyteRH_pct)) setAnalyteRH_pct(json.analyteRH_pct);
        if (Array.isArray(json.pointProbes)) {
            setPointProbes(json.pointProbes
                .filter((pp) => pp && Number.isFinite(pp.x_mm) && Number.isFinite(pp.y_mm))
                .map((pp, i) => ({
                    id: String(pp.id || `p_restore_${i}_${Date.now().toString(36)}`),
                    label: String(pp.label || `P${i + 1}`),
                    x_mm: pp.x_mm,
                    y_mm: pp.y_mm,
                    color: pp.color || PROBE_COLORS[i % PROBE_COLORS.length],
                })));
        }
        if (typeof json.pulseId === 'string') setPulseId(json.pulseId);
        if (json.pulseParams && typeof json.pulseParams === 'object') setPulseParams({ ...json.pulseParams });
        if (json.colormap) setColormap(json.colormap);
        if (typeof json.showStreamlines === 'boolean') setShowStreamlines(json.showStreamlines);
        if (typeof json.meshLongAxis === 'number' && Number.isFinite(json.meshLongAxis)) {
            setMeshLongAxis(Math.max(MIN_MESH_LONG_AXIS, Math.min(MAX_MESH_LONG_AXIS, Math.round(json.meshLongAxis))));
        }
        if (json.simDurationS === '' || json.simDurationS == null) {
            setSimDurationS('');
        } else if (typeof json.simDurationS === 'number' && Number.isFinite(json.simDurationS) && json.simDurationS > 0) {
            setSimDurationS(String(json.simDurationS));
        } else if (typeof json.simDurationS === 'string') {
            setSimDurationS(json.simDurationS);
        }
        if (json.gridStepOverrideMm === null || typeof json.gridStepOverrideMm === 'number') {
            setGridStepOverrideMm(json.gridStepOverrideMm);
        }
        if (json.gridStepMinMm === null || (typeof json.gridStepMinMm === 'number' && json.gridStepMinMm > 0)) {
            setGridStepMinMm(json.gridStepMinMm);
        }
        if (typeof json.minorDivisions === 'number' && json.minorDivisions > 0) {
            setMinorDivisions(Math.round(json.minorDivisions));
        }
        setProjectName(String(json.name || splitPath(file.name).base.replace(PROJECT_FILE_SUFFIX, '')));
        setCurrentProjectFileId(file.id);
        setCurrentProjectFileName(file.name);
        setIsDirty(false);
        setSelection(null);
        setSaveStatus(`Loaded ${file.name}`);
        setTimeout(() => setSaveStatus(''), 3500);
    }, [projectFiles]);

    /* ── File manager: results, folders, rename, delete ─────────── */

    /* Save the current simulation **result** — project + final velocity
       field — as a .flowres.json file. Float32Array is serialised as a
       regular Array so JSON.stringify works cleanly across the
       workspace IndexedDB boundary.

       Saving a result *does not* change the "currently open" project
       handle; results are post-sim artefacts, not the editable project
       file. That way hitting Save after running the simulation won't
       accidentally overwrite the result file. */
    const handleSaveResult = useCallback(async ({ dir = '' } = {}) => {
        if (!onSaveJson) {
            setSaveStatus('Save is not available (workspace unavailable).');
            return;
        }
        if (!field || !solverInfo) {
            setSaveStatus('Nothing to save yet — run the simulation first.');
            setTimeout(() => setSaveStatus(''), 3500);
            return;
        }
        const defaultName = `${projectName || 'result'}-result`;
        const rawName = (typeof window !== 'undefined'
            ? window.prompt('Save simulation result as:', defaultName)
            : null);
        if (!rawName) return;
        const safe = String(rawName).trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'untitled-result';
        const baseName = safe.toLowerCase().endsWith(RESULT_FILE_SUFFIX)
            ? safe
            : `${safe}${RESULT_FILE_SUFFIX}`;
        const fileName = joinPath(dir, baseName);

        const resultJson = {
            schema: RESULT_SCHEMA,
            savedAt: new Date().toISOString(),
            name: safe,
            project: serializeProject(),
            solverInfo: {
                // store only the cheap/plain-JSON bits (no DataView / mask)
                bbox: solverInfo.bbox,
                dx_m: solverInfo.dx_m,
                dt_s: solverInfo.dt_s,
                nx: field.nx,
                ny: field.ny,
            },
            field: {
                nx: field.nx,
                ny: field.ny,
                umag: Array.from(field.umag),
                ux:   Array.from(field.ux),
                uy:   Array.from(field.uy),
                umax: field.umax,
            },
            iter: field.iter ?? 0,
            residual: field.residual ?? 0,
            channelDepthMm,
            profileQuantity,
            // Transient recording (one row per field post). Each row is
            // plain JSON so this survives round-tripping cleanly. Older
            // viewers just ignore the unknown `timeHistory` field.
            timeHistory: timeHistory.map((r) => ({
                iter: r.iter,
                t_s: r.t_s,
                per: r.per,
            })),
            steadyIter: steadyIterRef.current,
        };

        try {
            setSaveStatus('Archiving result…');
            const res = await onSaveJson({ folderName: FLOWLAB_FOLDER_NAME, fileName, json: resultJson });
            setSaveStatus(res?.overwritten
                ? `Result replaced → Flow Lab/${fileName}`
                : `Result saved → Flow Lab/${fileName}`);
            setTimeout(() => setSaveStatus(''), 4000);
        } catch (err) {
            console.error('Flow Lab save-result failed:', err);
            setSaveStatus(`Save failed: ${err?.message || err}`);
        }
    }, [onSaveJson, serializeProject, projectName, field, solverInfo, channelDepthMm, profileQuantity, timeHistory]);

    const handleSaveAllGraphsToWorkspace = useCallback(async () => {
        if (!onSaveJson) {
            setSaveStatus('Save is not available (workspace unavailable).');
            return;
        }
        const fileName = `flowlab-graphs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        const data = {
            schema: 'flowlab.graphs.v1',
            savedAt: new Date().toISOString(),
            sensorHistory: sensorHistoryRef.current,
            timeHistory,
            steadyIter: steadyIterRef.current,
        };
        try {
            setSaveStatus('Saving graphs to workspace…');
            await onSaveJson({ folderName: FLOWLAB_FOLDER_NAME, fileName, json: data });
            setSaveStatus(`Saved graphs → Flow Lab/${fileName}`);
            setTimeout(() => setSaveStatus(''), 4000);
        } catch (err) {
            setSaveStatus('Failed to save graphs.');
            setTimeout(() => setSaveStatus(''), 4000);
        }
    }, [onSaveJson, timeHistory]);

    /* Load a .flowres.json — restores the embedded project *and* the
       saved flow field, so users can continue analysing (drag new
       sections, export CSV, change the plotted quantity) without
       re-running the solver.  The solver itself is left paused — the
       saved mask may disagree with the restored field if geometry is
       later edited, so we deliberately don't auto-resume. */
    const handleLoadResult = useCallback((fileId) => {
        if (!fileId) return;
        const file = flowLabFiles.find((f) => f.id === fileId);
        if (!file) return;
        const json = file.data
            ?? (typeof file.csvText === 'string' ? (() => { try { return JSON.parse(file.csvText); } catch { return null; } })() : null);
        if (!json || json.schema !== RESULT_SCHEMA) {
            setSaveStatus(`Can't load "${file.name}" — not a Flow Lab result file.`);
            return;
        }
        // Stop the solver; we're restoring a frozen snapshot.
        if (workerRef.current) {
            workerRef.current.terminate();
            workerRef.current = null;
        }
        maskRef.current = null;
        setRunning(false);
        setResidualHistory([]);
        residualHistoryRef.current = [];
        // Result files may carry a saved time-history — hydrate below.
        setTimeHistory([]);
        timeHistoryRef.current = [];
        lastRecordedIterRef.current = -1;

        // Hydrate project state first.
        const p = json.project || {};
        skipNextHistoryRef.current = true;
        skipNextDirtyRef.current = true;
        setEntities(JSON.parse(JSON.stringify(p.entities || [])));
        skipNextHistoryRef.current = true;
        skipNextDirtyRef.current = true;
        {
            const rawSections = JSON.parse(JSON.stringify(p.sections || []));
            setSections(rawSections.map((s, idx) => ({
                visible: true,
                label: `Section ${idx + 1}`,
                color: SECTION_COLORS[idx % SECTION_COLORS.length],
                ...s,
            })));
            setSelectedSectionId(rawSections[0]?.id || null);
        }
        if (p.unit) setUnit(p.unit);
        if (p.gasId) setGasId(p.gasId);
        if (typeof p.inletU_m_s === 'number') setInletU_m_s(p.inletU_m_s);
        if (p.inletMode === 'velocity' || p.inletMode === 'sccm') setInletMode(p.inletMode);
        if (typeof p.inletQ_sccm === 'number' && Number.isFinite(p.inletQ_sccm)) setInletQ_sccm(p.inletQ_sccm);
        if (typeof p.speciesEnabled === 'boolean') setSpeciesEnabled(p.speciesEnabled);
        if (typeof p.analyteId === 'string') setAnalyteId(p.analyteId);
        if (typeof p.customD_m2s === 'number' && Number.isFinite(p.customD_m2s)) setCustomD_m2s(p.customD_m2s);
        if (typeof p.analyteT_C === 'number' && Number.isFinite(p.analyteT_C)) setAnalyteT_C(p.analyteT_C);
        if (typeof p.analyteRH_pct === 'number' && Number.isFinite(p.analyteRH_pct)) setAnalyteRH_pct(p.analyteRH_pct);
        if (Array.isArray(p.pointProbes)) {
            setPointProbes(p.pointProbes
                .filter((pp) => pp && Number.isFinite(pp.x_mm) && Number.isFinite(pp.y_mm))
                .map((pp, i) => ({
                    id: String(pp.id || `p_restore_${i}_${Date.now().toString(36)}`),
                    label: String(pp.label || `P${i + 1}`),
                    x_mm: pp.x_mm,
                    y_mm: pp.y_mm,
                    color: pp.color || PROBE_COLORS[i % PROBE_COLORS.length],
                })));
        }
        if (typeof p.pulseId === 'string') setPulseId(p.pulseId);
        if (p.pulseParams && typeof p.pulseParams === 'object') setPulseParams({ ...p.pulseParams });
        if (p.colormap) setColormap(p.colormap);
        if (typeof p.showStreamlines === 'boolean') setShowStreamlines(p.showStreamlines);
        if (typeof p.meshLongAxis === 'number' && Number.isFinite(p.meshLongAxis)) {
            setMeshLongAxis(Math.max(MIN_MESH_LONG_AXIS, Math.min(MAX_MESH_LONG_AXIS, Math.round(p.meshLongAxis))));
        }
        if (p.gridStepOverrideMm === null || typeof p.gridStepOverrideMm === 'number') {
            setGridStepOverrideMm(p.gridStepOverrideMm);
        }
        if (p.gridStepMinMm === null || (typeof p.gridStepMinMm === 'number' && p.gridStepMinMm > 0)) {
            setGridStepMinMm(p.gridStepMinMm);
        }
        if (typeof p.minorDivisions === 'number' && p.minorDivisions > 0) {
            setMinorDivisions(Math.round(p.minorDivisions));
        }
        if (typeof json.channelDepthMm === 'number') setChannelDepthMm(json.channelDepthMm);
        if (typeof json.profileQuantity === 'string') setProfileQuantity(json.profileQuantity);
        setProjectName(String(p.name || splitPath(file.name).base.replace(RESULT_FILE_SUFFIX, '')));

        // Restore the flow field.
        const rawField = json.field || {};
        if (Array.isArray(rawField.umag) && Array.isArray(rawField.ux) && Array.isArray(rawField.uy)) {
            setField({
                nx: rawField.nx,
                ny: rawField.ny,
                umag: new Float32Array(rawField.umag),
                ux:   new Float32Array(rawField.ux),
                uy:   new Float32Array(rawField.uy),
                umax: rawField.umax,
                iter: json.iter,
                residual: json.residual,
            });
        }
        if (json.solverInfo) {
            setSolverInfo({
                bbox: json.solverInfo.bbox,
                dx_m: json.solverInfo.dx_m,
                dt_s: json.solverInfo.dt_s,
            });
        }
        // Restore the transient time-history if the result file saved it.
        // Older result files (schema before v1.1) won't have this field;
        // in that case the chart simply starts empty after loading.
        if (Array.isArray(json.timeHistory)) {
            timeHistoryRef.current = json.timeHistory.slice();
            setTimeHistory(json.timeHistory.slice());
            const lastIter = json.timeHistory.length
                ? json.timeHistory[json.timeHistory.length - 1].iter
                : -1;
            lastRecordedIterRef.current = lastIter;
        }

        // A result file doesn't reclaim the "currently open project"
        // handle — editing is done on the editable project file.
        setCurrentProjectFileId(null);
        setCurrentProjectFileName(null);
        setIsDirty(false);
        setSelection(null);
        setSaveStatus(`Opened result ${file.name}`);
        setTimeout(() => setSaveStatus(''), 3500);
    }, [flowLabFiles]);

    /* Unified "open from explorer" — routes to the right loader based
       on file suffix. Used by the double-click-to-open gesture. */
    const handleOpenFile = useCallback((file) => {
        if (!file) return;
        if (file._kind === 'result') return handleLoadResult(file.id);
        if (file._kind === 'project') return handleLoadProject(file.id);
        setSaveStatus(`Can't open ${file.name} (unknown type).`);
    }, [handleLoadResult, handleLoadProject]);

    /* Persist a virtual sub-folder by writing an invisible marker file.
       The folder auto-appears in the tree next render thanks to the
       path parser in `fileTree`. */
    const handleCreateFolder = useCallback(async (parentDir = '') => {
        if (!onSaveJson) return;
        const name = typeof window !== 'undefined'
            ? window.prompt(parentDir
                ? `New folder inside "Flow Lab/${parentDir}":`
                : 'New folder name:', 'untitled-folder')
            : null;
        if (!name) return;
        const clean = name.trim();
        if (!isValidSimpleName(clean)) {
            setSaveStatus('Invalid folder name.');
            setTimeout(() => setSaveStatus(''), 3000);
            return;
        }
        const fileName = joinPath(parentDir, clean, FOLDER_MARKER_NAME);
        try {
            await onSaveJson({
                folderName: FLOWLAB_FOLDER_NAME,
                fileName,
                json: { schema: FOLDER_MARKER_SCHEMA, createdAt: new Date().toISOString() },
            });
            setExplorerExpanded((exp) => new Set(exp).add(joinPath(parentDir, clean)));
            setSaveStatus(`Created folder → ${joinPath(parentDir, clean)}/`);
            setTimeout(() => setSaveStatus(''), 3000);
        } catch (err) {
            console.error('create folder failed:', err);
            setSaveStatus(`Failed: ${err?.message || err}`);
        }
    }, [onSaveJson]);

    /* Delete one file. */
    const handleDeleteOneFile = useCallback(async (file) => {
        if (!onDeleteFile) return;
        try {
            await onDeleteFile({ stopPropagation: () => {} }, file.id);
            if (currentProjectFileId === file.id) {
                setCurrentProjectFileId(null);
                setCurrentProjectFileName(null);
            }
        } catch (err) {
            console.error('delete failed:', err);
            setSaveStatus(`Delete failed: ${err?.message || err}`);
        }
    }, [onDeleteFile, currentProjectFileId]);

    /* Delete an item from the file tree — confirms with the user,
       then removes the corresponding workspace file(s). For folders
       this recursively deletes every descendant file (including the
       marker). */
    const handleDeleteTreeItem = useCallback(async (item) => {
        if (!onDeleteFile) return;
        if (item.type === 'file') {
            if (!window.confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
            await handleDeleteOneFile(item.file);
            setSaveStatus(`Deleted ${item.name}`);
            setTimeout(() => setSaveStatus(''), 2500);
            return;
        }
        // Folder: gather every file whose path starts with "folder/"
        const prefix = item.path ? `${item.path}/` : '';
        const victims = flowLabFiles.filter((f) => String(f.name).startsWith(prefix));
        if (!victims.length) return;
        if (!window.confirm(`Delete folder "${item.path}" and ${victims.length} file${victims.length > 1 ? 's' : ''} inside it? This cannot be undone.`)) return;
        for (const v of victims) {
            // eslint-disable-next-line no-await-in-loop
            await handleDeleteOneFile(v);
        }
        setSaveStatus(`Deleted folder ${item.path}/`);
        setTimeout(() => setSaveStatus(''), 2500);
    }, [onDeleteFile, flowLabFiles, handleDeleteOneFile]);

    /* Rename a file (keeps the same folder / suffix) or a folder (moves
       every file with the folder's path prefix).  Implementation: read
       old file contents, write to new name, then delete old. */
    const handleRenameTreeItem = useCallback(async (item) => {
        if (!onSaveJson || !onDeleteFile) return;
        if (item.type === 'file') {
            const suffix = item.name.endsWith(RESULT_FILE_SUFFIX) ? RESULT_FILE_SUFFIX
                         : item.name.endsWith(PROJECT_FILE_SUFFIX) ? PROJECT_FILE_SUFFIX
                         : '';
            const currentStem = item.name.replace(new RegExp(`${suffix.replace('.', '\\.')}$`), '');
            const raw = window.prompt(`Rename "${item.name}" to:`, currentStem);
            if (!raw) return;
            const clean = raw.trim();
            if (!isValidSimpleName(clean)) { setSaveStatus('Invalid name.'); return; }
            const { dir } = splitPath(item.path);
            const newName = joinPath(dir, `${clean}${suffix}`);
            if (newName === item.path) return;
            try {
                await onSaveJson({ folderName: FLOWLAB_FOLDER_NAME, fileName: newName, json: item.file.data });
                await onDeleteFile({ stopPropagation: () => {} }, item.file.id);
                if (currentProjectFileId === item.file.id) {
                    setCurrentProjectFileName(newName);
                }
                setSaveStatus(`Renamed → ${newName}`);
                setTimeout(() => setSaveStatus(''), 3000);
            } catch (err) {
                console.error('rename failed:', err);
                setSaveStatus(`Rename failed: ${err?.message || err}`);
            }
            return;
        }
        // Folder rename: move every descendant.
        const oldPath = item.path;
        const parentDir = splitPath(oldPath).dir;
        const currentName = item.name;
        const raw = window.prompt(`Rename folder "${oldPath}" to:`, currentName);
        if (!raw) return;
        const clean = raw.trim();
        if (!isValidSimpleName(clean)) { setSaveStatus('Invalid folder name.'); return; }
        const newPath = joinPath(parentDir, clean);
        if (newPath === oldPath) return;
        const prefix = `${oldPath}/`;
        const toMove = flowLabFiles.filter((f) => String(f.name).startsWith(prefix));
        for (const f of toMove) {
            const newName = `${newPath}/${f.name.slice(prefix.length)}`;
            // eslint-disable-next-line no-await-in-loop
            await onSaveJson({ folderName: FLOWLAB_FOLDER_NAME, fileName: newName, json: f.data });
            // eslint-disable-next-line no-await-in-loop
            await onDeleteFile({ stopPropagation: () => {} }, f.id);
            if (currentProjectFileId === f.id) setCurrentProjectFileName(newName);
        }
        setSaveStatus(`Renamed folder → ${newPath}/`);
        setTimeout(() => setSaveStatus(''), 3000);
    }, [onSaveJson, onDeleteFile, flowLabFiles, currentProjectFileId]);

    /* Move a file into a different virtual sub-folder. Used by the
       "Move…" dropdown in the explorer. Keeps the base name; changes
       the directory prefix only. */
    const handleMoveFile = useCallback(async (file, newDir) => {
        if (!onSaveJson || !onDeleteFile) return;
        const base = splitPath(file.name).base;
        const newName = joinPath(newDir, base);
        if (newName === file.name) return;
        try {
            await onSaveJson({ folderName: FLOWLAB_FOLDER_NAME, fileName: newName, json: file.data });
            await onDeleteFile({ stopPropagation: () => {} }, file.id);
            if (currentProjectFileId === file.id) setCurrentProjectFileName(newName);
            setSaveStatus(`Moved → ${newName}`);
            setTimeout(() => setSaveStatus(''), 3000);
        } catch (err) {
            console.error('move failed:', err);
            setSaveStatus(`Move failed: ${err?.message || err}`);
        }
    }, [onSaveJson, onDeleteFile, currentProjectFileId]);

    /* All virtual folder paths (used by the "Move to…" dropdown). */
    const allFolderPaths = useMemo(() => {
        const set = new Set(['']);
        const walk = (node) => {
            if (node.path) set.add(node.path);
            if (Array.isArray(node.children)) node.children.forEach(walk);
        };
        walk(fileTree);
        return Array.from(set).sort();
    }, [fileTree]);

    /* ── Viewport resize observer ───────────────────────────────── */
    useEffect(() => {
        const el = canvasWrapRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                setCanvasSize({ w: Math.max(200, width), h: Math.max(200, height) });
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    /* ── Coordinate helpers ─────────────────────────────────────── */
    const toScreen = useCallback((p) => ({
        x: p.x * viewport.pxPerMm + viewport.tx,
        y: -p.y * viewport.pxPerMm + viewport.ty,
    }), [viewport]);

    const toWorld = useCallback((sx, sy) => ({
        x: (sx - viewport.tx) / viewport.pxPerMm,
        y: -(sy - viewport.ty) / viewport.pxPerMm,
    }), [viewport]);

    /* Grid spacing for the current zoom. Resolution order:
        1. A pinned "Fixed" step wins unconditionally (`gridStepOverrideMm`).
        2. Otherwise the auto-selected step is used (`pickGridStepMm`), but
           clamped to the user's minimum floor (`gridStepMinMm`) so the
           grid never renders finer than the user wants — when the user
           zooms in beyond the minimum threshold, the grid stays at the
           min spacing and the on-screen cells simply grow in pixels. */
    const gridStepMm = useMemo(() => {
        if (gridStepOverrideMm != null && Number.isFinite(gridStepOverrideMm) && gridStepOverrideMm > 0) {
            return gridStepOverrideMm;
        }
        const auto = pickGridStepMm(viewport.pxPerMm);
        if (gridStepMinMm != null && Number.isFinite(gridStepMinMm) && gridStepMinMm > 0) {
            return Math.max(auto, gridStepMinMm);
        }
        return auto;
    }, [viewport.pxPerMm, gridStepOverrideMm, gridStepMinMm]);

    /* Snap a world point to the grid or nearest endpoint. Also snaps to
       the first vertex of the in-progress Line chain so the close
       gesture feels firm. */
    const snapWorldPoint = useCallback((p) => {
        if (!snapOn) return p;
        const g = gridStepMm;
        const snapped = {
            x: Math.round(p.x / g) * g,
            y: Math.round(p.y / g) * g,
        };
        const r_mm = 8 / viewport.pxPerMm;
        let best = null, bestD = r_mm;
        for (const e of entities) {
            for (const v of e.points) {
                const d = Math.hypot(v.x - p.x, v.y - p.y);
                if (d < bestD) { bestD = d; best = v; }
            }
        }
        // Snap to the first vertex of the current Line chain (for closing).
        if (pendingLinePoints.length >= 2) {
            const v = pendingLinePoints[0];
            const d = Math.hypot(v.x - p.x, v.y - p.y);
            if (d < bestD) { bestD = d; best = v; }
        }
        return best ? { x: best.x, y: best.y } : snapped;
    }, [snapOn, gridStepMm, entities, pendingLinePoints, viewport.pxPerMm]);

    /* ── Fit viewport to content ────────────────────────────────── */
    const fitToContent = useCallback(() => {
        const bb = entitiesBBox(entities);
        if (!bb) return;
        const margin = 60; // px
        const bw = bb.xmax - bb.xmin;
        const bh = bb.ymax - bb.ymin;
        const sx = (canvasSize.w - 2 * margin) / (bw || 1);
        const sy = (canvasSize.h - 2 * margin) / (bh || 1);
        const s = Math.min(sx, sy);
        const cxw = 0.5 * (bb.xmin + bb.xmax);
        const cyw = 0.5 * (bb.ymin + bb.ymax);
        setViewport({
            pxPerMm: s,
            tx: canvasSize.w / 2 - cxw * s,
            ty: canvasSize.h / 2 + cyw * s,
        });
    }, [entities, canvasSize]);

    // Fit once on first mount after canvas sized.
    useEffect(() => {
        if (canvasSize.w > 200 && entities.length && viewport.pxPerMm === 30) {
            fitToContent();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvasSize.w]);

    /* ── Mouse / wheel handlers ─────────────────────────────────── */
    const handleWheel = (e) => {
        e.preventDefault();
        const rect = canvasWrapRef.current.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const wp = toWorld(sx, sy);
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newScale = Math.max(0.5, Math.min(5000, viewport.pxPerMm * factor));
        // Keep the world point under the cursor fixed during the zoom.
        setViewport({
            pxPerMm: newScale,
            tx: sx - wp.x * newScale,
            ty: sy + wp.y * newScale,
        });
    };

    const panRef = useRef(null);
    const handleMouseDown = (e) => {
        const rect = canvasWrapRef.current.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const wp = snapWorldPoint(toWorld(sx, sy));

        // Middle mouse or space-drag: pan, regardless of tool.
        if (e.button === 1 || e.altKey) {
            panRef.current = { sx, sy, tx: viewport.tx, ty: viewport.ty };
            return;
        }

        // Right button: marquee multi-select (any tool). Context menu
        // suppressed on the canvas via onContextMenu.
        if (e.button === 2) {
            e.preventDefault();
            setMarqueeDrag({ sx0: sx, sy0: sy, sx1: sx, sy1: sy });
            return;
        }

        if (tool === TOOLS.RECT) {
            setRectDrag({ x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y });
        } else if (tool === TOOLS.CIRCLE) {
            setCircleDrag({ cx: wp.x, cy: wp.y, r: 0 });
        } else if (tool === TOOLS.POLY) {
            setPendingPolyPoints((pts) => [...pts, wp]);
        } else if (tool === TOOLS.LINE) {
            // Line tool behaviour:
            //   · First click on empty space → start a fresh chain.
            //   · First click near the free endpoint of an existing OPEN
            //     polyline → "absorb" that polyline so the user can
            //     continue drawing from the open end (useful after
            //     deleting an edge of a closed polygon, to re-form a
            //     new closed region along a different path).
            //   · Subsequent click near the first point of the current
            //     chain → close into a new closed polygon. If a polyline
            //     was absorbed, it is removed and replaced by the new
            //     closed polygon.
            //   · Otherwise → append the point and keep drawing.
            const snapTol = 8 / viewport.pxPerMm;
            if (pendingLinePoints.length === 0) {
                let extendId = null;
                let startPts = [wp];
                for (const ent of entities) {
                    if (ent.closed !== false) continue;
                    if (!ent.points || ent.points.length < 2) continue;
                    const p0 = ent.points[0];
                    const pN = ent.points[ent.points.length - 1];
                    if (Math.hypot(wp.x - p0.x, wp.y - p0.y) < snapTol) {
                        extendId = ent.id;
                        startPts = ent.points.slice().reverse();
                        break;
                    }
                    if (Math.hypot(wp.x - pN.x, wp.y - pN.y) < snapTol) {
                        extendId = ent.id;
                        startPts = ent.points.slice();
                        break;
                    }
                }
                setPendingLineExtendId(extendId);
                setPendingLinePoints(startPts);
            } else if (pendingLinePoints.length >= 2
                       && Math.hypot(wp.x - pendingLinePoints[0].x,
                                     wp.y - pendingLinePoints[0].y) < snapTol) {
                const closedPts = pendingLinePoints;
                const ent = createPolylineEntity(closedPts, { closed: true });
                const replaceId = pendingLineExtendId;
                setEntities((es) => {
                    const filtered = replaceId
                        ? es.filter((en) => en.id !== replaceId)
                        : es;
                    return [...filtered, ent];
                });
                setSelection({ entityId: ent.id, edgeIdx: null });
                setMultiSelection(new Set([ent.id]));
                setPendingLineExtendId(null);
                setPendingLinePoints([]);
                setTool(TOOLS.SELECT);
            } else {
                setPendingLinePoints((pts) => [...pts, wp]);
            }
        } else if (tool === TOOLS.SECTION) {
            setSectionDrag({ x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y });
        } else if (tool === TOOLS.FILLET) {
            // Pick the vertex nearest the click across all CLOSED polygons.
            // Fillet operates on corners only — open polylines are ignored.
            const r_hit = 8 / viewport.pxPerMm;
            let hitEnt = null, hitVIdx = -1, bestD = r_hit;
            for (const e of entities) {
                if (e.closed === false) continue;
                for (let i = 0; i < e.points.length; i++) {
                    const v = e.points[i];
                    const d = Math.hypot(v.x - wp.x, v.y - wp.y);
                    if (d < bestD) { bestD = d; hitEnt = e; hitVIdx = i; }
                }
            }
            if (!hitEnt) {
                setSolverWarning('Fillet: click on a corner vertex of a closed polygon.');
                return;
            }
            const nextEnt = filletVertex(hitEnt, hitVIdx, filletRadiusMm, 16);
            if (!nextEnt) {
                setSolverWarning(`Fillet: radius ${filletRadiusMm} mm is too big for this corner (longer than an adjacent edge) or the corner is nearly straight.`);
                return;
            }
            setSolverWarning(null);
            setEntities((es) => es.map((en) => (en.id === hitEnt.id ? nextEnt : en)));
            setSelection({ entityId: hitEnt.id, edgeIdx: null, vertexIdx: null });
        } else if (tool === TOOLS.TRIM) {
            // Trim — click on the portion of a line or section probe to
            // discard. The click is snapped to the nearest eligible line
            // (sections first, then open polylines); intersections with
            // every OTHER line / section in the scene act as cutting
            // edges. The clicked sub-segment is removed; the rest stays.
            const pickR_mm = 8 / viewport.pxPerMm;

            // 1. Try sections first — they're usually longer/thinner,
            //    and users typically add sections for analysis and over-
            //    shoot the geometry on purpose.
            let bestSec = null, bestSecD = pickR_mm;
            for (const s of sections) {
                if (!s?.points || s.points.length < 2) continue;
                if (s.visible === false) continue;
                const d = distToSegment(wp.x, wp.y, s.points[0], s.points[1]);
                if (d < bestSecD) { bestSecD = d; bestSec = s; }
            }
            if (bestSec) {
                const cutters = collectCuttingEdges(entities, sections, { excludeSectionId: bestSec.id });
                const replacements = trimSection(bestSec, wp, cutters, {
                    idFactory: () => nextSectionId(),
                });
                if (replacements.length === 1 && replacements[0].id === bestSec.id
                    && Math.hypot(replacements[0].points[0].x - bestSec.points[0].x,
                                  replacements[0].points[0].y - bestSec.points[0].y) < 1e-6
                    && Math.hypot(replacements[0].points[1].x - bestSec.points[1].x,
                                  replacements[0].points[1].y - bestSec.points[1].y) < 1e-6) {
                    setSolverWarning('Trim: click past an intersection — the clicked portion has nothing to cut it off.');
                    return;
                }
                setSolverWarning(null);
                setSections((prev) => {
                    const idx = prev.findIndex((s) => s.id === bestSec.id);
                    if (idx < 0) return prev;
                    // Give every newly-split sister a unique colour so
                    // the analysis list stays legible.
                    const base = prev.slice();
                    const decorated = replacements.map((s, i) => ({
                        ...s,
                        color: i === 0 ? s.color : SECTION_COLORS[(prev.length + i) % SECTION_COLORS.length],
                    }));
                    base.splice(idx, 1, ...decorated);
                    return base;
                });
                if (replacements.length > 0) setSelectedSectionId(replacements[0].id);
                return;
            }

            // 2. Try open polylines (line entities). Closed polygons
            //    are intentionally left alone — trimming them would
            //    change their topology (break the fluid domain), which
            //    is rarely what the user wants with a quick click.
            let hitEnt = null, hitEdge = -1, hitD = pickR_mm;
            for (const e of entities) {
                if (e.closed !== false) continue; // only open polylines
                for (let i = 0; i < e.points.length - 1; i++) {
                    const d = distToSegment(wp.x, wp.y, e.points[i], e.points[i + 1]);
                    if (d < hitD) { hitD = d; hitEnt = e; hitEdge = i; }
                }
            }
            if (hitEnt) {
                const cutters = collectCuttingEdges(entities, sections, {
                    excludeEntityId: hitEnt.id,
                    excludeEdge: hitEdge,
                });
                const replacements = trimOpenPolylineEdge(hitEnt, hitEdge, wp, cutters, {
                    idFactory: () => `${hitEnt.id}_t${Date.now().toString(36)}_${Math.floor(Math.random() * 1e5).toString(36)}`,
                });
                if (replacements.length === 1 && replacements[0] === hitEnt) {
                    setSolverWarning('Trim: no intersecting line found on the clicked edge.');
                    return;
                }
                setSolverWarning(null);
                setEntities((es) => {
                    const idx = es.findIndex((e) => e.id === hitEnt.id);
                    if (idx < 0) return es;
                    const next = es.slice();
                    next.splice(idx, 1, ...replacements);
                    return next;
                });
                setSelection(null);
                return;
            }

            // User may be trying to "remove the line between" two touching
            // rectangles — Trim only works on sections + OPEN polylines.
            let nearClosedEdge = false;
            for (const e of entities) {
                if (e.closed === false) continue;
                const n = e.points.length;
                for (let i = 0; i < n; i++) {
                    const a = e.points[i], b = e.points[(i + 1) % n];
                    if (distToSegment(wp.x, wp.y, a, b) < pickR_mm) {
                        nearClosedEdge = true;
                        break;
                    }
                }
                if (nearClosedEdge) break;
            }
            if (nearClosedEdge) {
                setSolverWarning(
                    'Trim does not merge closed shapes. To fuse two touching rectangles into one outline: Shift-click each polygon, then Union (⌘U). Re-tag Inlet / Outlet on the merged boundary afterward.'
                );
            } else {
                setSolverWarning('Trim: click on a section probe or an open line to trim.');
            }
        } else if (tool === TOOLS.OFFSET) {
            // Offset: click any closed polygon and offset by the stored
            // distance (positive = outward, negative = inward).
            let target = null;
            for (const en of entities) {
                if (en.closed === false) continue;
                const er_mm = 6 / viewport.pxPerMm;
                let onEdge = false;
                for (let i = 0; i < en.points.length; i++) {
                    const a = en.points[i], b = en.points[(i + 1) % en.points.length];
                    if (distToSegment(wp.x, wp.y, a, b) < er_mm) { onEdge = true; break; }
                }
                if (onEdge || pointInPolygon(en.points, wp.x, wp.y)) { target = en; break; }
            }
            if (!target) {
                setSolverWarning('Offset: click inside or on the edge of a closed polygon.');
                return;
            }
            const out = offsetPolygon(target, offsetDistanceMm);
            if (!out.length) {
                setSolverWarning('Offset collapsed the shape — try a smaller (less negative) value.');
                return;
            }
            setEntities((es) => {
                const idx = es.findIndex((en) => en.id === target.id);
                if (idx < 0) return es;
                const next = es.slice();
                next.splice(idx, 1, ...out);
                return next;
            });
            setSelection(out[0] ? { entityId: out[0].id, edgeIdx: null, vertexIdx: null } : null);
            setSolverWarning(null);
        } else if (tool === TOOLS.EXTEND) {
            // Extend: first click = pick a polyline endpoint (within a
            // generous radius). Second click = confirm target region;
            // the polyline is extended along its end direction until it
            // hits the nearest cutting edge.
            if (!extendPending) {
                const vr_mm = 8 / viewport.pxPerMm;
                let bestD = vr_mm, best = null;
                for (const en of entities) {
                    if (en.closed !== false) continue;
                    if (!en.points || en.points.length < 2) continue;
                    const first = en.points[0];
                    const last = en.points[en.points.length - 1];
                    const dFirst = Math.hypot(first.x - wp.x, first.y - wp.y);
                    const dLast  = Math.hypot(last.x  - wp.x, last.y  - wp.y);
                    if (dFirst < bestD) { bestD = dFirst; best = { entityId: en.id, endpoint: 'start' }; }
                    if (dLast  < bestD) { bestD = dLast;  best = { entityId: en.id, endpoint: 'end' }; }
                }
                if (!best) {
                    setSolverWarning('Extend: click the END of an open polyline first (the free tip to grow).');
                    return;
                }
                setExtendPending(best);
                setSolverWarning('Extend: now click near the boundary you want to extend into (cutting edges hit first).');
                return;
            }
            // Second click — execute the extend.
            const ent = entities.find((x) => x.id === extendPending.entityId);
            if (!ent) { setExtendPending(null); return; }
            const cutters = collectCuttingEdges(entities, [], { excludeEntityId: ent.id });
            const out = extendOpenPolyline(ent, extendPending.endpoint, cutters);
            if (out === ent) {
                setSolverWarning('Extend: ray didn\'t intersect any geometry — draw or re-aim the polyline.');
            } else {
                setEntities((es) => es.map((en) => (en.id === ent.id ? out : en)));
                setSolverWarning(null);
            }
            setExtendPending(null);
        } else if (tool === TOOLS.MOVE) {
            // Move: click anchor, then click target; translate all entities
            // currently in multi-selection (or the primary selection).
            if (!movePending) {
                setMovePending({ x0: wp.x, y0: wp.y });
                setSolverWarning('Move: now click the new position.');
                return;
            }
            const dx = wp.x - movePending.x0;
            const dy = wp.y - movePending.y0;
            setMovePending(null);
            const targetIds = multiSelection.size
                ? Array.from(multiSelection)
                : (selection ? [selection.entityId] : []);
            if (!targetIds.length) { setSolverWarning('Move: nothing selected.'); return; }
            setEntities((es) => es.map((en) => targetIds.includes(en.id) ? translateEntity(en, dx, dy) : en));
            setSolverWarning(null);
        } else if (tool === TOOLS.MIRROR) {
            // Mirror: drag to define the reflection axis.
            setMirrorDrag({ x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y });
        } else if (tool === TOOLS.PROBE) {
            /* Drop a point probe at the clicked world coordinate. The
               probe starts sampling the field on the next solver snapshot
               (no restart required — it just appears in the Sensor
               response panel). Stays inside the Probe tool so the user
               can sprinkle several probes in one go; Escape / Select
               tool exit the mode. */
            setPointProbes((list) => {
                const nextIdx = list.length + 1;
                const color = PROBE_COLORS[(nextIdx - 1) % PROBE_COLORS.length];
                return [
                    ...list,
                    {
                        id: `p_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
                        label: `P${nextIdx}`,
                        x_mm: wp.x,
                        y_mm: wp.y,
                        color,
                    },
                ];
            });
            return;
        } else if (tool === TOOLS.MEASURE) {
            // Measure: click → set P1 → live-preview; click again → finalize
            // (tooltip stays on screen until the user starts a new
            // measurement or presses Escape).
            if (!measurePending) {
                setMeasurePending({ x: wp.x, y: wp.y });
                setMeasurement(null);
                setSolverWarning('Measure: click the second point.');
                return;
            }
            setMeasurement({
                p1: { x: measurePending.x, y: measurePending.y },
                p2: { x: wp.x, y: wp.y },
            });
            setMeasurePending(null);
            setSolverWarning(null);
        } else if (tool === TOOLS.SELECT || tool === TOOLS.DELETE) {
            // Pick order: vertex (tightest) → edge → entity interior. Having
            // an explicit vertex hit lets the user delete a single vertex
            // (= cut a section out of an existing polygon).
            const vr_mm = 5 / viewport.pxPerMm;
            const er_mm = 6 / viewport.pxPerMm;
            let hitEntity = null, hitEdge = -1, hitVertex = -1;

            // 1. Vertex pick. In SELECT mode we restrict to the currently-
            //    selected entity to avoid sticky handles everywhere; in
            //    DELETE mode we scan every entity so the user can surgically
            //    knock out a single vertex with one click.
            const candidatesForVertex = tool === TOOLS.DELETE
                ? entities
                : (selection ? entities.filter((en) => en.id === selection.entityId) : []);
            {
                let bestD = vr_mm;
                for (const e of candidatesForVertex) {
                    for (let i = 0; i < e.points.length; i++) {
                        const v = e.points[i];
                        const d = Math.hypot(v.x - wp.x, v.y - wp.y);
                        if (d < bestD) { bestD = d; hitEntity = e; hitVertex = i; }
                    }
                }
            }

            // 2. Edge pick across ALL entities.
            if (!hitEntity) {
                outer: for (const e of entities) {
                    const nEdges = e.closed === false
                        ? Math.max(0, e.points.length - 1)
                        : e.points.length;
                    for (let i = 0; i < nEdges; i++) {
                        const a = e.points[i];
                        const b = e.points[(i + 1) % e.points.length];
                        if (distToSegment(wp.x, wp.y, a, b) < er_mm) {
                            hitEntity = e; hitEdge = i;
                            break outer;
                        }
                    }
                }
            }

            if (hitEntity) {
                if (tool === TOOLS.DELETE) {
                    // Surgical DELETE-tool behaviour:
                    //   · Vertex hit → drop that vertex, neighbours reconnect.
                    //     Whole entity is removed if it shrinks below 2 verts.
                    //   · Edge hit   → BREAK the segment: closed polygon opens
                    //     into an open polyline starting at edgeIdx+1; open
                    //     polyline splits into two independent polylines.
                    //   · Neither, just interior → delete the entire entity
                    //     (the old "click inside to nuke" behaviour).
                    if (hitVertex >= 0) {
                        const next = removeVertexAt(hitEntity, hitVertex);
                        setEntities((es) => next
                            ? es.map((en) => (en.id === hitEntity.id ? next : en))
                            : es.filter((en) => en.id !== hitEntity.id));
                        setSelection(null);
                    } else if (hitEdge >= 0) {
                        const replacements = removeEdgeAt(hitEntity, hitEdge);
                        setEntities((es) => {
                            const idx = es.findIndex((en) => en.id === hitEntity.id);
                            if (idx < 0) return es;
                            const next = es.slice();
                            next.splice(idx, 1, ...replacements);
                            return next;
                        });
                        setSelection(null);
                        if (!replacements.length) {
                            setSolverWarning('Deleted segment — entity removed (it had only that one edge).');
                        } else if (hitEntity.closed !== false && replacements.length === 1) {
                            setSolverWarning(null);
                            // Polygon opened — brief hint so the user knows
                            // the domain is no longer closed and the solver
                            // will ignore it until re-closed.
                            setSolverWarning('Segment removed. The shape is now an open polyline — close it (Line tool) or draw a replacement to re-form the domain.');
                        }
                    } else {
                        setEntities((es) => es.filter((en) => en.id !== hitEntity.id));
                        setSelection(null);
                    }
                } else {
                    // SELECT mode: shift-click adds/removes from the multi-
                    // selection without changing the primary pick. Plain
                    // click resets multi-selection to just this entity.
                    if (e.shiftKey) {
                        setMultiSelection((prev) => {
                            const next = new Set(prev);
                            if (next.has(hitEntity.id)) next.delete(hitEntity.id);
                            else next.add(hitEntity.id);
                            return next;
                        });
                    } else {
                        setMultiSelection(new Set([hitEntity.id]));
                    }
                    setSelection({
                        entityId: hitEntity.id,
                        edgeIdx: hitVertex >= 0 ? null : hitEdge,
                        vertexIdx: hitVertex >= 0 ? hitVertex : null,
                    });
                }
            } else {
                // Clicked an empty area. In SELECT mode this is the usual
                // interior-fall-through for closed polygons. In DELETE mode
                // we fall back to interior-click → delete whole entity so
                // users aren't left wondering "why did nothing happen?".
                let interiorHit = null;
                for (const e of entities) {
                    if (e.closed === false) continue;
                    if (pointInPolygon(e.points, wp.x, wp.y)) { interiorHit = e; break; }
                }
                if (tool === TOOLS.DELETE) {
                    if (interiorHit) {
                        setEntities((es) => es.filter((en) => en.id !== interiorHit.id));
                        setSelection(null);
                        setMultiSelection(new Set());
                    }
                } else {
                    if (interiorHit) {
                        if (e.shiftKey) {
                            setMultiSelection((prev) => {
                                const next = new Set(prev);
                                if (next.has(interiorHit.id)) next.delete(interiorHit.id);
                                else next.add(interiorHit.id);
                                return next;
                            });
                        } else {
                            setMultiSelection(new Set([interiorHit.id]));
                        }
                        setSelection({ entityId: interiorHit.id, edgeIdx: null, vertexIdx: null });
                    } else if (!e.shiftKey) {
                        setSelection(null);
                        setMultiSelection(new Set());
                    }
                }
            }
        }
    };

    const handleMouseMove = (e) => {
        const rect = canvasWrapRef.current.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;

        if (panRef.current) {
            setViewport((vp) => ({
                ...vp,
                tx: panRef.current.tx + (sx - panRef.current.sx),
                ty: panRef.current.ty + (sy - panRef.current.sy),
            }));
            return;
        }

        const wpRaw = toWorld(sx, sy);
        const wp = snapWorldPoint(wpRaw);
        setCursorWorld(wp);

        if (marqueeDrag) {
            setMarqueeDrag((md) => (md ? { ...md, sx1: sx, sy1: sy } : null));
        }

        if (rectDrag) setRectDrag((rd) => ({ ...rd, x1: wp.x, y1: wp.y }));
        if (circleDrag) setCircleDrag((cd) => ({
            ...cd,
            r: Math.hypot(wp.x - cd.cx, wp.y - cd.cy),
        }));
        if (sectionDrag) setSectionDrag((sd) => ({ ...sd, x1: wp.x, y1: wp.y }));
        if (mirrorDrag) setMirrorDrag((md) => ({ ...md, x1: wp.x, y1: wp.y }));
    };

    const handleMouseUp = (e) => {
        if (panRef.current) { panRef.current = null; return; }

        if (marqueeDrag) {
            const leave = e?.type === 'mouseleave';
            const rightUp = e?.type === 'mouseup' && e.button === 2;
            if (leave) {
                setMarqueeDrag(null);
            } else if (rightUp) {
                const { sx0, sy0, sx1, sy1 } = marqueeDrag;
                setMarqueeDrag(null);
                const wPx = Math.abs(sx1 - sx0), hPx = Math.abs(sy1 - sy0);
                if (wPx > 3 && hPx > 3) {
                    const wx0 = Math.min(sx0, sx1), wx1 = Math.max(sx0, sx1);
                    const wy0 = Math.min(sy0, sy1), wy1 = Math.max(sy0, sy1);
                    const c1 = toWorld(wx0, wy0), c2 = toWorld(wx1, wy0);
                    const c3 = toWorld(wx0, wy1), c4 = toWorld(wx1, wy1);
                    const mx0 = Math.min(c1.x, c2.x, c3.x, c4.x);
                    const mx1 = Math.max(c1.x, c2.x, c3.x, c4.x);
                    const my0 = Math.min(c1.y, c2.y, c3.y, c4.y);
                    const my1 = Math.max(c1.y, c2.y, c3.y, c4.y);
                    const hits = [];
                    for (const ent of entities) {
                        if (!ent || ent.id === 'preview') continue;
                        const bb = entitiesBBox([ent]);
                        if (!bb) continue;
                        if (bb.xmax >= mx0 && bb.xmin <= mx1 && bb.ymax >= my0 && bb.ymin <= my1) {
                            hits.push(ent.id);
                        }
                    }
                    if (hits.length) {
                        if (e.shiftKey) {
                            setMultiSelection((prev) => {
                                const n = new Set(prev);
                                hits.forEach((id) => n.add(id));
                                return n;
                            });
                        } else {
                            setMultiSelection(new Set(hits));
                        }
                        setSelection({ entityId: hits[0], edgeIdx: null, vertexIdx: null });
                        setTool(TOOLS.SELECT);
                    }
                }
            }
        }

        // Rect/Circle/Poly/Line all APPEND now — previous geometry is
        // preserved so users can build up multi-body scenes and combine
        // them with the boolean / offset / mirror tools.
        if (rectDrag) {
            const { x0, y0, x1, y1 } = rectDrag;
            if (Math.abs(x1 - x0) > 1e-6 && Math.abs(y1 - y0) > 1e-6) {
                const ent = createRectEntity(x0, y0, x1, y1);
                setEntities((es) => [...es, ent]);
                setSelection({ entityId: ent.id, edgeIdx: null, vertexIdx: null });
                setMultiSelection(new Set([ent.id]));
            }
            setRectDrag(null);
        }
        if (circleDrag) {
            if (circleDrag.r > 1e-6) {
                const ent = createCircleEntity(circleDrag.cx, circleDrag.cy, circleDrag.r);
                setEntities((es) => [...es, ent]);
                setSelection({ entityId: ent.id, edgeIdx: null, vertexIdx: null });
                setMultiSelection(new Set([ent.id]));
            }
            setCircleDrag(null);
        }
        if (mirrorDrag) {
            const { x0, y0, x1, y1 } = mirrorDrag;
            if (Math.hypot(x1 - x0, y1 - y0) > 1e-4) {
                const targetIds = multiSelection.size
                    ? Array.from(multiSelection)
                    : (selection ? [selection.entityId] : []);
                if (targetIds.length) {
                    const axisA = { x: x0, y: y0 }, axisB = { x: x1, y: y1 };
                    setEntities((es) => es.map((en) =>
                        targetIds.includes(en.id) ? mirrorEntity(en, axisA, axisB) : en));
                    setSolverWarning(null);
                } else {
                    setSolverWarning('Mirror: select at least one entity first (Select tool, then drag).');
                }
            }
            setMirrorDrag(null);
        }
        if (sectionDrag) {
            const { x0, y0, x1, y1 } = sectionDrag;
            if (Math.hypot(x1 - x0, y1 - y0) > 1e-4) {
                // Append a new section. Auto-assign a colour and a label
                // from the palette. Colours cycle if a lot of sections.
                setSections((prev) => {
                    const idx = prev.length;
                    const id = nextSectionId();
                    const next = [...prev, {
                        id,
                        type: 'section',
                        label: `Section ${idx + 1}`,
                        color: SECTION_COLORS[idx % SECTION_COLORS.length],
                        visible: true,
                        points: [{ x: x0, y: y0 }, { x: x1, y: y1 }],
                    }];
                    setSelectedSectionId(id);
                    return next;
                });
            }
            setSectionDrag(null);
        }
    };

    /* Polyline finalisation: double-click or Enter closes the loop. */
    const handleDoubleClick = () => {
        if (tool === TOOLS.POLY && pendingPolyPoints.length >= 3) {
            const ent = createPolylineEntity(pendingPolyPoints, { closed: true });
            setEntities((es) => [...es, ent]);
            setSelection({ entityId: ent.id, edgeIdx: null, vertexIdx: null });
            setMultiSelection(new Set([ent.id]));
            setPendingPolyPoints([]);
            setTool(TOOLS.SELECT);
        } else if (tool === TOOLS.LINE && pendingLinePoints.length >= 2) {
            // Double-click ends the line chain (open polyline). Drop the
            // trailing duplicate vertex the two clicks produced. If an
            // existing open polyline was being extended, replace it with
            // the merged result instead of creating a sibling.
            const pts = pendingLinePoints.slice(0, -1);
            const finalPts = pts.length >= 2 ? pts : pendingLinePoints;
            const ent = createPolylineEntity(finalPts, { closed: false });
            const replaceId = pendingLineExtendId;
            setEntities((es) => {
                const filtered = replaceId
                    ? es.filter((en) => en.id !== replaceId)
                    : es;
                return [...filtered, ent];
            });
            setSelection({ entityId: ent.id, edgeIdx: null, vertexIdx: null });
            setPendingLineExtendId(null);
            setPendingLinePoints([]);
            setTool(TOOLS.SELECT);
        }
    };

    useEffect(() => {
        const onKey = (e) => {
            // Ignore hotkeys while typing in a form field.
            const tag = e.target?.tagName;
            const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

            // Undo / redo (available even while typing is fine — browsers
            // already handle in-input undo separately because e.target is
            // the input there).
            const meta = e.metaKey || e.ctrlKey;
            if (meta && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
                if (typing) return;
                e.preventDefault();
                undo();
                return;
            }
            if (meta && ((e.key === 'z' || e.key === 'Z') && e.shiftKey || e.key === 'y' || e.key === 'Y')) {
                if (typing) return;
                e.preventDefault();
                redo();
                return;
            }
            /* Cmd/Ctrl+S → quick Save. Cmd/Ctrl+Shift+S → Save As.
               Both work without a selection and without caring what
               the drawing tool is. */
            if (meta && (e.key === 's' || e.key === 'S') && !e.shiftKey) {
                if (typing) return;
                e.preventDefault();
                handleSaveProject();
                return;
            }
            if (meta && (e.key === 's' || e.key === 'S') && e.shiftKey) {
                if (typing) return;
                e.preventDefault();
                handleSaveAsProject();
                return;
            }

            if (e.key === 'Escape') {
                // Universal "bail out" — cancel any in-progress interaction
                // and fall back to the Select tool so the user is never
                // stranded in a CAD mode they can't leave without clicking
                // the toolbar.
                setPendingPolyPoints([]);
                setPendingLinePoints([]);
                setPendingLineExtendId(null);
                setRectDrag(null); setCircleDrag(null);
                setMeasurePending(null);
                setMeasurement(null);
                setMovePending(null);
                setExtendPending(null);
                setMirrorDrag(null);
                setMarqueeDrag(null);
                setSolverWarning(null);
                if (tool !== TOOLS.SELECT) setTool(TOOLS.SELECT);
            } else if (e.key === 'Enter' && tool === TOOLS.POLY && pendingPolyPoints.length >= 3) {
                const ent = createPolylineEntity(pendingPolyPoints, { closed: true });
                setEntities((es) => [...es, ent]);
                setSelection({ entityId: ent.id, edgeIdx: null, vertexIdx: null });
                setMultiSelection(new Set([ent.id]));
                setPendingPolyPoints([]);
                setTool(TOOLS.SELECT);
            } else if (e.key === 'Enter' && tool === TOOLS.LINE && pendingLinePoints.length >= 2) {
                // Finalise Line as an OPEN polyline (construction geometry,
                // ignored by the solver but renders as a dashed stroke so
                // you can sketch reference lines). If we were "extending"
                // an existing open polyline, that original entity is
                // replaced by the merged one so no duplicate remains.
                const ent = createPolylineEntity(pendingLinePoints, { closed: false });
                const replaceId = pendingLineExtendId;
                setEntities((es) => {
                    const filtered = replaceId
                        ? es.filter((en) => en.id !== replaceId)
                        : es;
                    return [...filtered, ent];
                });
                setSelection({ entityId: ent.id, edgeIdx: null, vertexIdx: null });
                setPendingLineExtendId(null);
                setPendingLinePoints([]);
                setTool(TOOLS.SELECT);
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                if (typing) return;
                // Delete selected section first if one exists and no entity
                // is selected — the section tool uses the same Del key as
                // geometry, so we disambiguate by what's selected.
                if (!selection && selectedSectionId) {
                    setSections((ss) => ss.filter((s) => s.id !== selectedSectionId));
                    setSelectedSectionId(null);
                    return;
                }
                if (!selection) return;
                const ent = entities.find((en) => en.id === selection.entityId);
                if (!ent) return;
                if (selection.vertexIdx != null) {
                    // Delete a single vertex: re-indexes BCs. If the entity
                    // would drop below 2 points the whole thing goes away.
                    const next = removeVertexAt(ent, selection.vertexIdx);
                    setEntities((es) => next
                        ? es.map((en) => (en.id === ent.id ? next : en))
                        : es.filter((en) => en.id !== ent.id));
                    setSelection(next ? { entityId: ent.id, edgeIdx: null, vertexIdx: null } : null);
                } else if (selection.edgeIdx != null) {
                    // Delete a segment: BREAK it. Closed polygon opens into
                    // an open polyline that wraps from edgeIdx+1 back round
                    // to edgeIdx; open polyline splits into two pieces at
                    // that edge. Holding Shift falls back to the legacy
                    // COLLAPSE behaviour (remove the vertex after edgeIdx)
                    // in case you're trimming out a redundant corner.
                    if (e.shiftKey) {
                        const vIdx = (selection.edgeIdx + 1) % ent.points.length;
                        const next = removeVertexAt(ent, vIdx);
                        setEntities((es) => next
                            ? es.map((en) => (en.id === ent.id ? next : en))
                            : es.filter((en) => en.id !== ent.id));
                        setSelection(next ? { entityId: ent.id, edgeIdx: null, vertexIdx: null } : null);
                    } else {
                        const replacements = removeEdgeAt(ent, selection.edgeIdx);
                        setEntities((es) => {
                            const idx = es.findIndex((en) => en.id === ent.id);
                            if (idx < 0) return es;
                            const next = es.slice();
                            next.splice(idx, 1, ...replacements);
                            return next;
                        });
                        setSelection(null);
                    }
                } else {
                    setEntities((es) => es.filter((en) => en.id !== ent.id));
                    setSelection(null);
                }
            } else if (e.key === 'f' && !typing) fitToContent();
            else if ((e.key === 't' || e.key === 'T') && !typing && !e.ctrlKey && !e.metaKey) {
                setTool(TOOLS.TRIM);
            }
            else if ((e.key === 'x' || e.key === 'X') && !typing && !e.ctrlKey && !e.metaKey) {
                setTool(TOOLS.EXTEND); setExtendPending(null);
            }
            else if ((e.key === 'o' || e.key === 'O') && !typing && !e.ctrlKey && !e.metaKey) {
                setTool(TOOLS.OFFSET);
            }
            else if ((e.key === 'v' || e.key === 'V') && !typing && !e.ctrlKey && !e.metaKey) {
                setTool(TOOLS.MOVE); setMovePending(null);
            }
            else if ((e.key === 'm' || e.key === 'M') && !typing && !e.ctrlKey && !e.metaKey) {
                setTool(TOOLS.MIRROR);
            }
            else if ((e.key === 'u' || e.key === 'U') && !typing && (e.ctrlKey || e.metaKey)) {
                e.preventDefault(); runUnion();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [tool, pendingPolyPoints, pendingLinePoints, selection, entities, fitToContent, undo, redo, handleSaveProject, handleSaveAsProject, selectedSectionId, runUnion]);

    /* ── BC editing ─────────────────────────────────────────────── */
    const updateSelectedEdgeBC = (patch) => {
        if (!selection || selection.edgeIdx == null) return;
        setEntities((es) => es.map((e) => {
            if (e.id !== selection.entityId) return e;
            const edgeBC = { ...e.edgeBC };
            edgeBC[selection.edgeIdx] = { ...edgeBC[selection.edgeIdx], ...patch };
            return { ...e, edgeBC };
        }));
    };

    /* ── Parametric geometry editing (SolidWorks-style) ─────────
       Move a single vertex to exact (x_mm, y_mm). Used by the Vertex
       editor in the Inspector. */
    const setVertexPosition = useCallback((entityId, vertexIdx, x_mm, y_mm) => {
        if (!Number.isFinite(x_mm) || !Number.isFinite(y_mm)) return;
        setEntities((es) => es.map((e) => {
            if (e.id !== entityId) return e;
            if (vertexIdx < 0 || vertexIdx >= e.points.length) return e;
            const pts = e.points.map((p, i) => (i === vertexIdx ? { x: x_mm, y: y_mm } : p));
            return { ...e, points: pts };
        }));
    }, []);

    /* Resize a specific edge to exact length in mm. Keeps the START
       vertex fixed and slides the END vertex along the current edge
       direction. */
    const setEdgeLength = useCallback((entityId, edgeIdx, newLen_mm) => {
        if (!(newLen_mm > 0) || !Number.isFinite(newLen_mm)) return;
        setEntities((es) => es.map((e) => {
            if (e.id !== entityId) return e;
            const n = e.points.length;
            if (edgeIdx < 0 || edgeIdx >= n) return e;
            const a = e.points[edgeIdx];
            const bIdx = (edgeIdx + 1) % n;
            const b = e.points[bIdx];
            const dx = b.x - a.x, dy = b.y - a.y;
            const curLen = Math.hypot(dx, dy);
            if (curLen < 1e-9) return e;
            const ux = dx / curLen, uy = dy / curLen;
            const nb = { x: a.x + ux * newLen_mm, y: a.y + uy * newLen_mm };
            const pts = e.points.map((p, i) => (i === bIdx ? nb : p));
            return { ...e, points: pts };
        }));
    }, []);

    /* Rotate an edge to a specific angle (degrees, measured from +x
       axis). Keeps the START vertex fixed, rotates the END vertex
       around it, preserving the current length. */
    const setEdgeAngle = useCallback((entityId, edgeIdx, angleDeg) => {
        if (!Number.isFinite(angleDeg)) return;
        setEntities((es) => es.map((e) => {
            if (e.id !== entityId) return e;
            const n = e.points.length;
            if (edgeIdx < 0 || edgeIdx >= n) return e;
            const a = e.points[edgeIdx];
            const bIdx = (edgeIdx + 1) % n;
            const b = e.points[bIdx];
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.hypot(dx, dy);
            if (len < 1e-9) return e;
            const rad = (angleDeg * Math.PI) / 180;
            const nb = { x: a.x + len * Math.cos(rad), y: a.y + len * Math.sin(rad) };
            const pts = e.points.map((p, i) => (i === bIdx ? nb : p));
            return { ...e, points: pts };
        }));
    }, []);

    const selectedEntity = entities.find((e) => e.id === selection?.entityId) || null;
    const selectedEdgeBC = selection?.edgeIdx != null && selectedEntity
        ? selectedEntity.edgeBC[selection.edgeIdx]
        : null;

    /* Whenever the user picks a new vertex / edge / entity, un-dismiss
       the floating dialog and let it re-anchor from scratch. */
    useEffect(() => {
        setPropDialogDismissed(false);
        setPropDialogUserPos(null);
    }, [selection?.entityId, selection?.vertexIdx, selection?.edgeIdx]);

    /* Esc closes the floating dialog without touching selection. */
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape' && !propDialogDismissed) {
                setPropDialogDismissed(true);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [propDialogDismissed]);

    /* Compute the dialog's anchor point in world-mm: the selected
       vertex, the midpoint of the selected edge, or the polygon
       centroid. */
    const propAnchorWorld = useMemo(() => {
        if (!selectedEntity) return null;
        const pts = selectedEntity.points;
        if (selection?.vertexIdx != null && pts[selection.vertexIdx]) {
            return pts[selection.vertexIdx];
        }
        if (selection?.edgeIdx != null) {
            const a = pts[selection.edgeIdx];
            const b = pts[(selection.edgeIdx + 1) % pts.length];
            return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        }
        let sx = 0, sy = 0;
        for (const p of pts) { sx += p.x; sy += p.y; }
        return { x: sx / pts.length, y: sy / pts.length };
    }, [selection, selectedEntity]);

    /* ── Solver driver ──────────────────────────────────────────── */
    const startSolver = useCallback(() => {
        if (!entities.length) return;
        // With multi-body support we may have several closed polygons on
        // canvas. Pick the ACTIVE fluid domain as the closed polygon
        // that has both Inlet AND Outlet edges. Ties break on largest
        // bounding box. This lets users draw "obstacle" polygons (which
        // currently still need to be merged into the main domain via
        // Subtract — a single-domain solver) without confusing the run.
        const closedList = entities.filter((e) => e.closed !== false);
        if (!closedList.length) {
            setSolverWarning('No closed fluid region — close a polyline or draw a rectangle/circle before running.');
            return;
        }
        const scoreDomain = (ent) => {
            let hasIn = false, hasOut = false;
            for (let i = 0; i < ent.points.length; i++) {
                const bc = ent.edgeBC?.[i];
                if (bc?.type === 'inlet') hasIn = true;
                if (bc?.type === 'outlet') hasOut = true;
            }
            const bb = entitiesBBox([ent]);
            const area = bb ? (bb.xmax - bb.xmin) * (bb.ymax - bb.ymin) : 0;
            return { hasIn, hasOut, area };
        };
        let domain = null, domainScore = null;
        for (const ent of closedList) {
            const s = scoreDomain(ent);
            if (!domain) { domain = ent; domainScore = s; continue; }
            // Prefer entities with both I/O; then by area.
            const selfIO = s.hasIn && s.hasOut ? 2 : (s.hasIn || s.hasOut ? 1 : 0);
            const bestIO = domainScore.hasIn && domainScore.hasOut ? 2 : (domainScore.hasIn || domainScore.hasOut ? 1 : 0);
            if (selfIO > bestIO || (selfIO === bestIO && s.area > domainScore.area)) {
                domain = ent; domainScore = s;
            }
        }
        let inletEdgeIdx = -1, outletEdgeIdx = -1;
        for (let i = 0; i < domain.points.length; i++) {
            const bc = domain.edgeBC?.[i];
            if (bc?.type === 'inlet' && inletEdgeIdx === -1) inletEdgeIdx = i;
            if (bc?.type === 'outlet' && outletEdgeIdx === -1) outletEdgeIdx = i;
        }
        if (inletEdgeIdx === -1) {
            setSolverWarning(closedList.length > 1
                ? 'No inlet on any closed polygon — click an edge of the fluid domain and set its BC to Inlet. (Merge overlapping bodies with Union if needed.)'
                : 'No inlet — click an edge and set its BC to Inlet.');
            return;
        }
        if (outletEdgeIdx === -1) {
            setSolverWarning('No outlet — one edge must be Outlet for mass to leave.');
            return;
        }
        if (closedList.length > 1) {
            setSolverWarning(`Multiple closed polygons on canvas — running on "${domain.id.slice(0, 8)}" (it has inlet + outlet). Use Union/Subtract to combine bodies into one solver domain.`);
        } else {
            setSolverWarning(null);
        }

        // User-chosen long-axis lattice cell count. Clamp defensively so a
        // stray value in the custom input box can't blow up memory.
        const nLong = Math.max(MIN_MESH_LONG_AXIS,
            Math.min(MAX_MESH_LONG_AXIS, Math.round(meshLongAxis) || DEFAULT_MESH_LONG_AXIS));
        const raster = rasterizeDomain(domain, nLong);
        if (!raster) { setSolverWarning('Could not rasterize geometry.'); return; }
        const { nx, ny } = raster;

        // Physical Δx in metres = (grid cell size in mm) / 1000.
        const dx_mm = raster.dx;
        const dx_m = dx_mm / 1000;
        /* Effective inlet speed — recomputed here inline (rather than
           pulled from a useMemo) so this callback doesn't need to close
           over a later-declared value, which would trip the temporal-
           dead-zone trap at component-body execution time. */
        let effectiveU;
        if (inletMode === 'sccm') {
            const Q_m3s = Math.max(0, inletQ_sccm) * 1.6666667e-8; // sccm → m³/s
            let inletLen_mm = 0;
            const pts = domain.points;
            for (let i = 0; i < pts.length; i++) {
                if (domain.edgeBC?.[i]?.type !== 'inlet') continue;
                const a = pts[i], b = pts[(i + 1) % pts.length];
                inletLen_mm += Math.hypot(b.x - a.x, b.y - a.y);
            }
            const A_m2 = (inletLen_mm * 1e-3) * (Math.max(1e-6, channelDepthMm) * 1e-3);
            effectiveU = A_m2 > 0 ? Q_m3s / A_m2 : inletU_m_s;
        } else {
            effectiveU = inletU_m_s;
        }
        const U_phys = Math.max(1e-9, effectiveU);
        const nu_phys = nu(gas);
        const dt_s = TARGET_U_LB * dx_m / U_phys;
        const nu_lb = nu_phys * dt_s / (dx_m * dx_m);
        const tau = 3 * nu_lb + 0.5;

        /* Species diffusivity in lattice units. For the FD scalar solver
           we need D_lb = D_phys · dt_s / dx²  — same non-dimensionalisation
           used for viscosity. Stability requires D_lb ≤ 0.25; we warn if
           the user pushes outside that envelope (almost always safe for
           gas-phase aromas, which have D ≈ 10⁻⁵ m²/s). */
        const analyteLocal = analyteById(analyteId);
        const D_ref = analyteId === 'custom' ? customD_m2s : analyteLocal.D;
        const D_phys = Math.max(0, correctedDiffusivity(D_ref, analyteT_C));
        const D_lb = D_phys * dt_s / (dx_m * dx_m);
        if (speciesEnabled && D_lb > 0.24) {
            setSolverWarning(`Species D_lb = ${D_lb.toFixed(3)} is near the stability limit 0.25 — refine the mesh or pick a smaller analyte diffusivity.`);
        }

        if (tau < 0.52) {
            setSolverWarning(`Relaxation τ = ${tau.toFixed(3)} is near unstable — reduce inlet velocity or refine grid.`);
        } else if (tau > 1.8) {
            setSolverWarning(`Relaxation τ = ${tau.toFixed(3)} is high — simulation may be overly diffusive.`);
        }

        // Inlet outward normal → inflow direction = -outward.
        const n = edgeOutwardNormal(domain.points, inletEdgeIdx);
        const outN = edgeOutwardNormal(domain.points, outletEdgeIdx);

        // Convert continuous normal to the nearest D2Q9 axis-aligned direction
        // for the outlet zero-gradient copy (integer offsets only).
        const outletDir = [
            Math.abs(outN.x) > Math.abs(outN.y) ? Math.sign(outN.x) : 0,
            Math.abs(outN.y) >= Math.abs(outN.x) ? Math.sign(outN.y) : 0,
        ];

        // Terminate prior worker if any, and reset the convergence trace.
        if (workerRef.current) {
            workerRef.current.terminate();
            workerRef.current = null;
        }
        residualHistoryRef.current = [];
        setResidualHistory([]);
        timeHistoryRef.current = [];
        setTimeHistory([]);
        lastRecordedIterRef.current = -1;
        maskRef.current = raster.mask;
        // Wipe sensor histories + pulse banner state on every fresh run
        // so the next start-of-pulse fires an edge event.
        sensorHistoryRef.current = {};
        prevCInletRef.current = 0;
        if (pulseBannerTimerRef.current) {
            clearTimeout(pulseBannerTimerRef.current);
            pulseBannerTimerRef.current = null;
        }
        setPulseBanner(null);
        setSensorHistory({});
        const worker = new Worker(new URL('../flowlab/lbmWorker.js', import.meta.url), { type: 'module' });
        workerRef.current = worker;
        // Snapshot pulse settings so the BC loop sees a stable copy
        // even if the user edits the profile mid-run (changes apply on
        // the NEXT run — stops a Gaussian turning into a step mid-way).
        const pulseIdLocal = pulseId;
        const pulseParamsLocal = { ...pulseParams };
        const speciesEnabledLocal = speciesEnabled;
        worker.onmessage = (ev) => {
            const m = ev.data || {};
            if (m.type === 'field') {
                setField({
                    nx, ny,
                    umag: m.umag,
                    ux: m.ux, uy: m.uy,
                    umax: m.umax,
                    iter: m.iter,
                    residual: m.residual,
                    c: m.c || null,
                    t_s: m.t_s || m.iter * dt_s,
                    cInletValue: m.cInletValue || 0,
                    cMax: m.cMax || 0,
                    cMaxFluid: m.cMaxFluid || 0,
                });
                // Trim history to last 500 points; keeps the mini-chart cheap.
                const hist = residualHistoryRef.current;
                hist.push({ iter: m.iter, residual: m.residual });
                if (hist.length > 500) hist.splice(0, hist.length - 500);
                setResidualHistory(hist.slice());

                // Sensor history — append one row per sensor per snapshot.
                if (m.sensorSnapshot && m.sensorSnapshot.length > 0) {
                    const t_s = m.t_s || m.iter * dt_s;
                    const store = sensorHistoryRef.current;
                    for (const sn of m.sensorSnapshot) {
                        const key = String(sn.edgeIdx);
                        if (!store[key]) store[key] = { t_s: [], c: [], u: [], label: sn.label };
                        store[key].label = sn.label;
                        store[key].t_s.push(t_s);
                        store[key].c.push(sn.c_mean);
                        store[key].u.push(sn.u_mean);
                        /* Hard cap at 20k samples so a half-hour sim doesn't
                           blow memory, but large enough that a pulse at
                           t = 0.3 s is still on record at t = 30 s. */
                        if (store[key].t_s.length > 20000) {
                            store[key].t_s.splice(0, store[key].t_s.length - 20000);
                            store[key].c.splice(0, store[key].c.length - 20000);
                            store[key].u.splice(0, store[key].u.length - 20000);
                        }
                    }
                    setSensorHistory({ ...store });
                }

                /* Append the commanded inlet concentration as a synthetic
                   "INLET" trace so the response chart shows, at every
                   moment, what the worker is driving the inlet cell to.
                   This is the reference for the pulse: if this goes
                   up→down on schedule but the sensor c(t) stays elevated,
                   the chamber is slow to clear (physics, not a bug);
                   if this itself doesn't return to zero, we have a bug
                   in the pulse evaluator. Recorded even when there are
                   no explicit wall sensors so the user always has a
                   "ground truth" to compare against. */
                if (speciesEnabledLocal) {
                    const t_s = m.t_s || m.iter * dt_s;
                    const store = sensorHistoryRef.current;
                    const k = 'INLET';
                    if (!store[k]) store[k] = { t_s: [], c: [], u: [], label: 'Inlet command' };
                    const cNow = Number.isFinite(m.cInletValue) ? m.cInletValue : 0;
                    store[k].t_s.push(t_s);
                    store[k].c.push(cNow);
                    store[k].u.push(0);
                    if (store[k].t_s.length > 20000) {
                        store[k].t_s.splice(0, store[k].t_s.length - 20000);
                        store[k].c.splice(0, store[k].c.length - 20000);
                        store[k].u.splice(0, store[k].u.length - 20000);
                    }

                    /* Edge-detect aroma pulse start / end: zero → non-zero
                       pins a "started" banner, non-zero → zero pins an
                       "ended" banner. The banner stays visible for the
                       rest of the run (or until a fresh run / reset
                       clears it) so the user always has a visible
                       indicator of pulse state. `EPS` avoids spurious
                       fires from tiny numerical noise. */
                    const EPS = 1e-4;
                    const prev = prevCInletRef.current || 0;
                    if (prev < EPS && cNow >= EPS) {
                        if (pulseBannerTimerRef.current) {
                            clearTimeout(pulseBannerTimerRef.current);
                            pulseBannerTimerRef.current = null;
                        }
                        setPulseBanner({ kind: 'start', t_s, value: cNow });
                    } else if (prev >= EPS && cNow < EPS) {
                        if (pulseBannerTimerRef.current) {
                            clearTimeout(pulseBannerTimerRef.current);
                            pulseBannerTimerRef.current = null;
                        }
                        setPulseBanner({ kind: 'end', t_s });
                    }
                    prevCInletRef.current = cNow;
                }

                /* Point probes — sample the freshly-delivered field at each
                   user-placed dot (bilinear interpolation) and append to
                   sensorHistoryRef under a "P:"-prefixed key so they coexist
                   with wall sensors but don't collide with edgeIdx keys.
                   Sampling runs on the main thread: cost is ~O(probes),
                   negligible. If the probe sits outside the domain / inside
                   a wall cell, we emit NaN — the chart skips it. */
                const probesLive = pointProbesRef.current || [];
                if (probesLive.length > 0 && m.ux && m.uy) {
                    const t_s = m.t_s || m.iter * dt_s;
                    const store = sensorHistoryRef.current;
                    const { bbox } = raster;
                    const dx_mm = (bbox.xmax - bbox.xmin) / nx;
                    const dy_mm = (bbox.ymax - bbox.ymin) / ny;
                    const sampleScalar = (arr, i0, j0, fx, fy) => {
                        const k00 = j0 * nx + i0;
                        const k10 = k00 + 1;
                        const k01 = k00 + nx;
                        const k11 = k01 + 1;
                        return (
                            (1 - fx) * (1 - fy) * arr[k00]
                            + fx * (1 - fy) * arr[k10]
                            + (1 - fx) * fy * arr[k01]
                            + fx * fy * arr[k11]
                        );
                    };
                    const mask = raster.mask;
                    let anyChange = false;
                    for (const pp of probesLive) {
                        const i = (pp.x_mm - bbox.xmin) / dx_mm - 0.5;
                        const j = (pp.y_mm - bbox.ymin) / dy_mm - 0.5;
                        const i0 = Math.floor(i);
                        const j0 = Math.floor(j);
                        const fx = i - i0;
                        const fy = j - j0;
                        let uSamp = NaN;
                        let cSamp = NaN;
                        
                        if (i0 >= 0 && i0 < nx - 1 && j0 >= 0 && j0 < ny - 1) {
                            /* Worker mask codes: FLUID=0, WALL=1, INLET=2,
                               OUTLET=3. We need *non-wall* cells at all four
                               bilinear corners. Using truthiness here was a
                               bug — FLUID is 0 (falsy), so every interior
                               fluid point was rejected and dot probes
                               recorded NaN → invisible traces. */
                            const WALL_CODE = 1;
                            const k00 = j0 * nx + i0;
                            const k10 = k00 + 1;
                            const k01 = k00 + nx;
                            const k11 = k01 + 1;
                            const allFluid = mask
                                ? (mask[k00] !== WALL_CODE
                                    && mask[k10] !== WALL_CODE
                                    && mask[k01] !== WALL_CODE
                                    && mask[k11] !== WALL_CODE)
                                : true;
                                
                            if (allFluid) {
                                // Safe to bilinear interpolate
                                const ux = sampleScalar(m.ux, i0, j0, fx, fy);
                                const uy = sampleScalar(m.uy, i0, j0, fx, fy);
                                uSamp = Math.hypot(ux, uy);
                                if (m.c) cSamp = sampleScalar(m.c, i0, j0, fx, fy);
                                else cSamp = 0;
                            } else {
                                // Near a wall: fall back to nearest-neighbor to avoid sampling
                                // 0-velocity or stale concentration from the wall cell itself.
                                const ic = Math.max(0, Math.min(nx - 1, Math.round(i)));
                                const jc = Math.max(0, Math.min(ny - 1, Math.round(j)));
                                const kc = jc * nx + ic;
                                if (!mask || mask[kc] !== WALL_CODE) {
                                    uSamp = Math.hypot(m.ux[kc], m.uy[kc]);
                                    if (m.c) cSamp = m.c[kc];
                                    else cSamp = 0;
                                }
                            }
                        }
                        const key = `P:${pp.id}`;
                        const labelNice = `${pp.label} (${pp.x_mm.toFixed(1)}, ${pp.y_mm.toFixed(1)} mm)`;
                        if (!store[key]) store[key] = { t_s: [], c: [], u: [], label: labelNice };
                        store[key].label = labelNice;
                        store[key].t_s.push(t_s);
                        store[key].c.push(cSamp);
                        store[key].u.push(uSamp);
                        if (store[key].t_s.length > 20000) {
                            store[key].t_s.splice(0, store[key].t_s.length - 20000);
                            store[key].c.splice(0, store[key].c.length - 20000);
                            store[key].u.splice(0, store[key].u.length - 20000);
                        }
                        anyChange = true;
                    }
                    if (anyChange) setSensorHistory({ ...store });
                }

                /* Inlet species BC is evaluated **inside the worker** every
                   LBM step (see lbmWorker.js). Do NOT post species-bc here —
                   posting only on each rendered frame left cInlet stuck for
                   hundreds of lattice steps so rectangular pulses never
                   turned off in sim time and c(t) never decayed to zero. */
            } else if (m.type === 'ready') {
                worker.postMessage({ type: 'start' });
            }
        };
        worker.postMessage({
            type: 'init',
            nx, ny,
            mask: raster.mask,
            inletDir: [-n.x, -n.y],  // inflow = opposite of outward normal
            inletU_lb: TARGET_U_LB,
            outletDir,
            tau,
            stepsPerPost: 6,
            postEvery: 33, // ~30 fps
            dt_s,
            species: speciesEnabledLocal ? { enabled: true, D_lb } : { enabled: false },
            sensorEdges: raster.sensorEdges || [],
            pulseId: pulseIdLocal,
            pulseParams: pulseParamsLocal,
        });

        setSolverInfo({
            nx, ny, tau, dx_m, dt_s,
            bbox: raster.bbox,
            sensorEdges: raster.sensorEdges || [],
            inletLength_mm: raster.inletLength_mm || 0,
            D_m2s: D_phys, D_lb,
            species: speciesEnabledLocal,
            pulseId: pulseIdLocal, pulseParams: pulseParamsLocal,
        });
        setRunning(true);
    }, [entities, gas, inletMode, inletU_m_s, inletQ_sccm, channelDepthMm,
        meshLongAxis, speciesEnabled, analyteId, customD_m2s, analyteT_C, pulseId, pulseParams]);

    const pauseSolver = useCallback(() => {
        if (workerRef.current) workerRef.current.postMessage({ type: 'pause' });
        setRunning(false);
        /* Drop the pulse banner on pause — it's a run-time indicator, so
           when the solver is parked the banner is no longer meaningful.
           Reset prevCInletRef so the edge detector re-fires on the next
           field post (pulse active → "in progress" banner returns on
           Resume; pulse already ended → no banner, as intended). */
        if (pulseBannerTimerRef.current) {
            clearTimeout(pulseBannerTimerRef.current);
            pulseBannerTimerRef.current = null;
        }
        setPulseBanner(null);
        prevCInletRef.current = 0;
    }, []);

    /** Resume an already-initialised (paused) solver, or start a fresh
        one if nothing is alive. This is what the big green play button
        calls — mirrors COMSOL's behaviour where pressing play after
        convergence lets you keep marching. */
    const runOrResumeSolver = useCallback(() => {
        if (workerRef.current) {
            workerRef.current.postMessage({ type: 'start' });
            setRunning(true);
            setSolverWarning(null);
            /* Keep the steady-state auto-pause SUPPRESSED on resume.
               At the moment the user clicks Run after convergence,
               `residualHistory` is still full of sub-threshold entries,
               so `steadyReached` is still true. If we reset
               `autoPausedOnceRef` to false here the auto-pause effect
               would immediately re-fire on the very next render and
               pause the solver again — Run would appear to do nothing.
               Leaving the ref at `true` means the pause only re-arms
               once residuals destabilise (pulse, BC change, parameter
               edit), which is handled by:
                   `if (!steadyReached) autoPausedOnceRef.current = false`
               in the steady-state effect below. This matches the
               intended "keep marching past steady state" behaviour.
               Duration-based pause is also NOT re-armed here: a resume
               without changing the Sim time means "keep marching past
               the previous target"; re-arm happens when the user
               bumps the target, handled by a separate effect below. */
            autoPausedOnceRef.current = true;
        } else {
            startSolver();
        }
    }, [startSolver]);

    const resetSolver = useCallback(() => {
        if (workerRef.current) {
            workerRef.current.terminate();
            workerRef.current = null;
        }
        maskRef.current = null;
        residualHistoryRef.current = [];
        setResidualHistory([]);
        timeHistoryRef.current = [];
        setTimeHistory([]);
        lastRecordedIterRef.current = -1;
        sensorHistoryRef.current = {};
        setSensorHistory({});
        setRunning(false);
        setField(null);
        setSolverInfo(null);
        setSolverWarning(null);
        if (pulseBannerTimerRef.current) {
            clearTimeout(pulseBannerTimerRef.current);
            pulseBannerTimerRef.current = null;
        }
        setPulseBanner(null);
        prevCInletRef.current = 0;
        durationPausedOnceRef.current = false;
    }, []);

    /* Auto-pause + geometry-invalidation effects live AFTER the
       `steadyReached` useMemo (see below) — their dep arrays would hit a
       TDZ otherwise. The `autoPausedOnceRef` ref, however, can safely be
       declared here so the effects further down can reference it. */
    const autoPausedOnceRef = useRef(false);

    // Cleanup on unmount.
    useEffect(() => {
        return () => {
            if (workerRef.current) workerRef.current.terminate();
        };
    }, []);

    /* ── Display-range stats: percentile-clipped umax.
         With an inlet-jet geometry (5:1 area ratio here) the jet velocity
         dominates and the bulk chamber averages out near 0.2 · umax; plain
         min-max normalisation sends everything into the dark end of the
         colormap. Clipping at the 95th percentile gives a colour range
         that matches what COMSOL / Star-CCM+ show by default. */
    const displayStats = useMemo(() => {
        if (!field || !maskRef.current) return null;
        const { umag } = field;
        const mask = maskRef.current;
        /* Gather fluid-only velocities into a typed array, sort, pick
           0 / 50 / 95 / 100 percentiles. For a 300×150 = 45 000 grid this
           costs ~1 ms per snapshot — fine at 30 fps. */
        const tmp = new Float32Array(umag.length);
        let n = 0;
        for (let i = 0; i < umag.length; i++) {
            // mask values: 0 = fluid, 1 = wall, 2 = inlet, 3 = outlet
            if (mask[i] === 1) continue;
            tmp[n++] = umag[i];
        }
        const fluid = tmp.subarray(0, n);
        fluid.sort();
        const q = (p) => fluid[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
        return {
            p50: q(0.5),
            p95: q(0.95),
            p99: q(0.99),
            max: fluid[n - 1] || 0,
            n,
        };
    }, [field]);

    /* Convert lattice u → m/s using the cached Δx_phys / Δt_phys. */
    const latticeToMps = solverInfo ? solverInfo.dx_m / Math.max(solverInfo.dt_s, 1e-30) : 0;

    /* ── Heatmap rendering ──────────────────────────────────────── */
    useEffect(() => {
        if (!field || !solverInfo || !displayStats) return;
        const canvas = heatmapCanvasRef.current;
        if (!canvas) return;
        const { nx, ny, umag } = field;
        const mask = maskRef.current;
        canvas.width = nx; canvas.height = ny;
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(nx, ny);
        const lut = COLORMAPS[colormap] || COLORMAPS.viridis;
        /* Clip at the 95th percentile of fluid cells. That pushes the
           chamber's mean velocity (~20% of inlet jet) into the mid of
           the colormap and leaves only the 5% brightest cells (the
           inlet/outlet throat) saturated at the top. */
        const vclip = Math.max(1e-12, displayStats.p95);
        for (let j = 0; j < ny; j++) {
            // Flip vertically — world Y is up, canvas Y is down.
            const src = (ny - 1 - j) * nx;
            const dst = j * nx;
            for (let i = 0; i < nx; i++) {
                const o = (dst + i) * 4;
                if (mask[src + i] === 1) {
                    // Wall: transparent so the page / geometry outline shows through.
                    img.data[o + 3] = 0;
                    continue;
                }
                const v = Math.min(1, umag[src + i] / vclip);
                // Mild √ stretch: makes low-velocity fluid visibly coloured
                // without flattening contrast at the top. Matches the
                // default "rainbow-style" stretch in commercial codes.
                const t = Math.sqrt(v);
                const idx = Math.max(0, Math.min(255, Math.round(t * 255)));
                img.data[o]     = lut[3 * idx];
                img.data[o + 1] = lut[3 * idx + 1];
                img.data[o + 2] = lut[3 * idx + 2];
                img.data[o + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
    }, [field, solverInfo, colormap, displayStats]);

    /* ── Species concentration overlay ──
     * Separate canvas layered on top of the velocity heatmap. Renders
     * c(x,y) as a white-hot/magenta ramp with alpha ∝ c so the velocity
     * colours still show through in dilute areas. Scale is auto — we
     * normalise to the current max of the c field (but never less than
     * the current inlet-BC value, so a plateau pulse renders consistently). */
    useEffect(() => {
        const canvas = speciesCanvasRef.current;
        if (!canvas) return;
        if (!speciesEnabled || !showSpeciesOverlay || !field?.c || !solverInfo) {
            // Clear any stale overlay.
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width || 1, canvas.height || 1);
            return;
        }
        const { nx, ny } = field;
        const c = field.c;
        const mask = maskRef.current;
        canvas.width = nx; canvas.height = ny;
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(nx, ny);
        let cMax = field.cInletValue || 0;
        for (let k = 0; k < c.length; k++) if (c[k] > cMax) cMax = c[k];
        if (cMax < 1e-6) cMax = 1;
        for (let j = 0; j < ny; j++) {
            const src = (ny - 1 - j) * nx;
            const dst = j * nx;
            for (let i = 0; i < nx; i++) {
                const o = (dst + i) * 4;
                if (mask[src + i] === 1) { img.data[o + 3] = 0; continue; }
                const v = Math.min(1, Math.max(0, c[src + i] / cMax));
                // White → yellow → magenta ramp (readable on both viridis
                // and turbo underlays). Alpha picks up with √(v) so the
                // front edge is visible without hiding the flow field.
                const r = Math.round(255);
                const g = Math.round(255 * (1 - v * 0.9));
                const b = Math.round(255 * (1 - v));
                img.data[o] = r;
                img.data[o + 1] = g;
                img.data[o + 2] = b;
                img.data[o + 3] = Math.round(220 * Math.sqrt(v));
            }
        }
        ctx.putImageData(img, 0, 0);
    }, [field, solverInfo, speciesEnabled, showSpeciesOverlay]);

    /* Derived physical stats. */
    const domainForStats = entities.find((e) => e.closed !== false) || entities[0];
    const L_mm = selectedEntity ? characteristicLength_mm(selectedEntity)
        : (domainForStats ? characteristicLength_mm(domainForStats) : 1);

    /* Inlet-edge length (sum of all 'inlet'-tagged edges on the active
       domain). Needed to map a user-specified sccm into an inlet velocity,
       and to compute Sherwood / mass-transfer quantities. */
    const inletLength_mm = useMemo(() => {
        if (!domainForStats) return 0;
        let total = 0;
        const pts = domainForStats.points;
        for (let i = 0; i < pts.length; i++) {
            if (domainForStats.edgeBC?.[i]?.type !== 'inlet') continue;
            const a = pts[i], b = pts[(i + 1) % pts.length];
            total += Math.hypot(b.x - a.x, b.y - a.y);
        }
        return total;
    }, [domainForStats]);

    /* Effective inlet speed (m/s) that the solver actually sees. In
       "velocity" mode this is just `inletU_m_s`; in "sccm" mode we back-
       compute U from the user's Q (sccm) and the inlet cross-section
       (inletLength × channelDepth). If there's no inlet edge yet we
       fall back to the raw `inletU_m_s` so the UI doesn't divide by zero. */
    const effectiveInletU_m_s = useMemo(() => {
        if (inletMode !== 'sccm') return inletU_m_s;
        const Q_m3s = Math.max(0, inletQ_sccm) * 1.6666667e-8; // sccm → m³/s
        const A_m2 = (inletLength_mm * 1e-3) * (Math.max(1e-6, channelDepthMm) * 1e-3);
        if (!(A_m2 > 0)) return inletU_m_s;
        return Q_m3s / A_m2;
    }, [inletMode, inletU_m_s, inletQ_sccm, inletLength_mm, channelDepthMm]);

    const Re = reynolds(gas, effectiveInletU_m_s, L_mm);

    /* Analyte properties + species-transport dimensionless numbers. */
    const analyte = analyteById(analyteId);
    const D_ref_m2s = analyteId === 'custom' ? customD_m2s : analyte.D;
    /* D at the sample temperature (Fuller T^1.75 scaling). Humidity is
       stored as metadata only — its second-order effect on D is < a few
       percent and the gas-phase solver reads the same ν as the carrier. */
    const D_m2s = correctedDiffusivity(D_ref_m2s, analyteT_C);
    const Sc = schmidt(nu(gas), D_m2s);
    const Pe = peclet(effectiveInletU_m_s, L_mm, D_m2s);
    const tauDiff_s = diffusionTime_s(L_mm, D_m2s);
    /* Flow (convective) time L/U — useful as a ruler next to τ_diff to
       tell the user immediately whether advection or diffusion wins. */
    const tauFlow_s = effectiveInletU_m_s > 0 ? (L_mm * 1e-3) / effectiveInletU_m_s : Infinity;

    /* Mesh preview — what the solver would build for the CURRENT domain
       and the CURRENT mesh-resolution setting. Lets the user see cell
       count and cell size *before* pressing Run, so they can trade off
       fidelity vs. wall-clock cost consciously. Pure-geometric: safe to
       recompute cheaply on every entity / mesh change. */
    const meshPreview = useMemo(() => {
        const dom = entities.find((e) => e.closed !== false);
        if (!dom) return null;
        let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
        for (const p of dom.points) {
            if (p.x < xmin) xmin = p.x; if (p.y < ymin) ymin = p.y;
            if (p.x > xmax) xmax = p.x; if (p.y > ymax) ymax = p.y;
        }
        const W_mm = (xmax - xmin) * 1.04; // matches rasterizeDomain's 2 % pad
        const H_mm = (ymax - ymin) * 1.04;
        if (!(W_mm > 0 && H_mm > 0)) return null;
        const nLong = Math.max(MIN_MESH_LONG_AXIS,
            Math.min(MAX_MESH_LONG_AXIS, Math.round(meshLongAxis) || DEFAULT_MESH_LONG_AXIS));
        let nx, ny;
        if (W_mm >= H_mm) { nx = nLong; ny = Math.max(8, Math.round(nLong * (H_mm / W_mm))); }
        else               { ny = nLong; nx = Math.max(8, Math.round(nLong * (W_mm / H_mm))); }
        const dx_mm = Math.min(W_mm / nx, H_mm / ny);
        return { nx, ny, total: nx * ny, dx_mm, W_mm, H_mm };
    }, [entities, meshLongAxis]);

    /* Sample an arbitrary section across the velocity field (bilinear
       interp). Returns a rich object: per-sample u_mps/ux_mps/uy_mps
       plus the section unit-vectors and length. Pure helper — safe to
       call from memos, effects, or CSV export. */
    const sampleSectionProfile = useCallback((section) => {
        if (!field || !solverInfo || !section?.points?.length) return null;
        const a = section.points[0], b = section.points[1];
        const lenMm = Math.hypot(b.x - a.x, b.y - a.y);
        if (lenMm < 1e-6) return null;
        const tx = (b.x - a.x) / lenMm;
        const ty = (b.y - a.y) / lenMm;
        const nxn = -ty, nyn = tx;
        const { bbox, dx_m, dt_s } = solverInfo;
        const { nx, ny, umag, ux, uy } = field;
        const dx_mm = (bbox.xmax - bbox.xmin) / nx;
        const dy_mm = (bbox.ymax - bbox.ymin) / ny;
        const latticeToMps = dx_m / Math.max(dt_s, 1e-30);

        const nSamples = 120;
        const samples = [];
        for (let k = 0; k <= nSamples; k++) {
            const t = k / nSamples;
            const xw = a.x + t * (b.x - a.x);
            const yw = a.y + t * (b.y - a.y);
            const i = (xw - bbox.xmin) / dx_mm - 0.5;
            const j = (yw - bbox.ymin) / dy_mm - 0.5;
            const i0 = Math.floor(i), j0 = Math.floor(j);
            const fi = i - i0, fj = j - j0;
            const inRange = i0 >= 0 && i0 < nx - 1 && j0 >= 0 && j0 < ny - 1;
            let u_lb = NaN, ux_lb = NaN, uy_lb = NaN;
            if (inRange) {
                const k00 = j0 * nx + i0;
                const k10 = j0 * nx + i0 + 1;
                const k01 = (j0 + 1) * nx + i0;
                const k11 = (j0 + 1) * nx + i0 + 1;
                const w00 = (1 - fi) * (1 - fj);
                const w10 = fi * (1 - fj);
                const w01 = (1 - fi) * fj;
                const w11 = fi * fj;
                u_lb  = w00 * umag[k00] + w10 * umag[k10] + w01 * umag[k01] + w11 * umag[k11];
                ux_lb = w00 * ux[k00]   + w10 * ux[k10]   + w01 * ux[k01]   + w11 * ux[k11];
                uy_lb = w00 * uy[k00]   + w10 * uy[k10]   + w01 * uy[k01]   + w11 * uy[k11];
            }
            samples.push({
                s_mm: t * lenMm,
                u_mps:  u_lb  * latticeToMps,
                ux_mps: ux_lb * latticeToMps,
                uy_mps: uy_lb * latticeToMps,
            });
        }
        return { samples, tx, ty, nxn, nyn, lenMm };
    }, [field, solverInfo]);

    /* Compute section profile + summary stats for EVERY section.
       Derived stats include: peak, mean, stdev, min, flux (per-m depth),
       volumetric flow rate (using channelDepthMm), local Re, and the
       uniformity index (1 − σ/mean). Cheap — ≤ sections × 120 samples. */
    const sectionProfiles = useMemo(() => {
        if (!field || !solverInfo) return [];
        return sections.map((section) => {
            const base = sampleSectionProfile(section);
            if (!base) return { section, ok: false };
            const { samples, tx, ty, nxn, nyn, lenMm } = base;

            let peak = 0, sum = 0, sum2 = 0, minVal = Infinity, maxAbs = 0;
            let n = 0, flux_m2ps = 0;
            for (let i = 0; i < samples.length; i++) {
                const s = samples[i];
                if (!Number.isFinite(s.u_mps)) continue;
                peak   = Math.max(peak, s.u_mps);
                minVal = Math.min(minVal, s.u_mps);
                maxAbs = Math.max(maxAbs, Math.abs(s.u_mps));
                sum  += s.u_mps;
                sum2 += s.u_mps * s.u_mps;
                n++;
                if (i > 0) {
                    const prev = samples[i - 1];
                    if (Number.isFinite(prev.ux_mps) && Number.isFinite(s.ux_mps)) {
                        const ds_m = (s.s_mm - prev.s_mm) * 1e-3;
                        const un0 = prev.ux_mps * nxn + prev.uy_mps * nyn;
                        const un1 = s.ux_mps    * nxn + s.uy_mps    * nyn;
                        flux_m2ps += 0.5 * (un0 + un1) * ds_m;
                    }
                }
            }
            const mean = n > 0 ? sum / n : 0;
            const variance = n > 0 ? Math.max(0, sum2 / n - mean * mean) : 0;
            const std = Math.sqrt(variance);
            const uniformity = mean > 1e-12 ? Math.max(0, 1 - std / mean) : 0;
            const depth_m = Math.max(channelDepthMm, 1e-9) * 1e-3;
            const volFlow_m3ps = flux_m2ps * depth_m;
            const volFlow_mlpm = volFlow_m3ps * 1e6 * 60;   // m³/s → mL/min
            const volFlow_sccm = volFlow_m3ps * 1e6 * 60;   // (same magnitude; gas-depends but OK at ≈STP)
            const Re_local = reynolds(gas, mean, lenMm);

            return {
                section, ok: true, samples, tx, ty, nxn, nyn, lenMm,
                stats: {
                    peak_mps: peak,
                    mean_mps: mean,
                    min_mps: Number.isFinite(minVal) ? minVal : 0,
                    std_mps: std,
                    max_abs_mps: maxAbs,
                    uniformity,
                    flux_m2ps,
                    volFlow_m3ps,
                    volFlow_mlpm,
                    volFlow_sccm,
                    Re_local,
                    nSamples: n,
                },
            };
        });
    }, [sections, sampleSectionProfile, field, solverInfo, channelDepthMm, gas]);

    /* Legacy aliases kept so existing callers (tests, etc.) don't break. */
    const profileSamples = sectionProfiles[0]?.samples || null;
    const profileStats = sectionProfiles[0]?.stats || null;

    /* ── Time-history recorder ──────────────────────────────────────
       On every field post (≈ 30 Hz) append one row to the time-history
       stack: { iter, t_s, per: { [sectionId]: { Q_*, mean_*, peak_*,
       flux_m2ps, std_mps } } }. We dedupe on `iter` so paused/idle
       states don't spam duplicate rows, and sub-sample the oldest half
       when the buffer exceeds TIME_HISTORY_MAX to keep memory bounded
       even on very long runs. */
    useEffect(() => {
        if (!field || !solverInfo) return;
        if (field.iter === lastRecordedIterRef.current) return;
        lastRecordedIterRef.current = field.iter;
        const t_s = field.iter * solverInfo.dt_s;
        const per = {};
        for (const p of sectionProfiles) {
            if (!p?.ok) continue;
            per[p.section.id] = {
                Q_m3ps:     p.stats.volFlow_m3ps,
                Q_mlpm:     p.stats.volFlow_mlpm,
                flux_m2ps:  p.stats.flux_m2ps,
                mean_mps:   p.stats.mean_mps,
                peak_mps:   p.stats.peak_mps,
                std_mps:    p.stats.std_mps,
                Re_local:   p.stats.Re_local,
            };
        }
        const row = { iter: field.iter, t_s, per };
        timeHistoryRef.current.push(row);
        if (timeHistoryRef.current.length > TIME_HISTORY_MAX) {
            // Downsample the oldest half — drop every other entry. This
            // keeps the early-transient shape visible while freeing room
            // for fresh samples.
            const arr = timeHistoryRef.current;
            const half = Math.floor(arr.length / 2);
            const thinned = [];
            for (let i = 0; i < half; i++) if (i % 2 === 0) thinned.push(arr[i]);
            for (let i = half; i < arr.length; i++) thinned.push(arr[i]);
            timeHistoryRef.current = thinned;
        }
        setTimeHistory(timeHistoryRef.current.slice());
    }, [field, sectionProfiles, solverInfo]);

    /* Detect when steady state was reached: the first iter at which the
       last STEADY_WINDOW residuals have all been below STEADY_THRESHOLD.
       Used by the time-history chart to paint a vertical marker. */
    const steadyIter = useMemo(() => {
        for (let i = STEADY_WINDOW - 1; i < residualHistory.length; i++) {
            let ok = true;
            for (let k = 0; k < STEADY_WINDOW; k++) {
                if (residualHistory[i - k].residual >= STEADY_THRESHOLD) { ok = false; break; }
            }
            if (ok) return residualHistory[i].iter;
        }
        return null;
        // STEADY_WINDOW/THRESHOLD are stable literals → safe out of deps.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [residualHistory]);
    /* Keep the ref mirror fresh for earlier-declared callbacks. */
    useEffect(() => { steadyIterRef.current = steadyIter; }, [steadyIter]);

    /* Download a section's samples as CSV — columns are the raw sampled
       quantities plus the derived section-relative coordinate. */
    const exportSectionCsv = useCallback((section) => {
        const profile = sectionProfiles.find((p) => p.section.id === section.id);
        if (!profile?.ok) return;
        const { samples, tx, ty, nxn, nyn, stats } = profile;
        const header = [
            '# Flow Lab profile export',
            `# section: ${section.label || section.id}`,
            `# points_mm: (${section.points[0].x.toFixed(3)},${section.points[0].y.toFixed(3)}) → (${section.points[1].x.toFixed(3)},${section.points[1].y.toFixed(3)})`,
            `# channel_depth_mm: ${channelDepthMm}`,
            `# peak_mps: ${stats.peak_mps.toFixed(6)}`,
            `# mean_mps: ${stats.mean_mps.toFixed(6)}`,
            `# std_mps: ${stats.std_mps.toFixed(6)}`,
            `# flux_m2ps: ${stats.flux_m2ps.toExponential(6)}`,
            `# Q_m3ps: ${stats.volFlow_m3ps.toExponential(6)}`,
            `# Q_mlpm: ${stats.volFlow_mlpm.toExponential(6)}`,
            `# Re_local: ${stats.Re_local.toFixed(4)}`,
            '',
            's_mm,x_mm,y_mm,umag_mps,ux_mps,uy_mps,un_mps,ut_mps',
        ].join('\n');
        const rows = samples.map((sm) => {
            const xw = section.points[0].x + (sm.s_mm / (stats.max_abs_mps > 0 ? profile.lenMm : 1)) * 0;
            // Reconstruct world (x,y) from s_mm along section for completeness:
            const t = sm.s_mm / profile.lenMm;
            const x = section.points[0].x + t * (section.points[1].x - section.points[0].x);
            const y = section.points[0].y + t * (section.points[1].y - section.points[0].y);
            const un = sm.ux_mps * nxn + sm.uy_mps * nyn;
            const ut = sm.ux_mps * tx  + sm.uy_mps * ty;
            return [
                sm.s_mm, x, y,
                sm.u_mps, sm.ux_mps, sm.uy_mps, un, ut,
            ].map((v) => Number.isFinite(v) ? v.toFixed(6) : 'NaN').join(',');
        }).join('\n');
        const csv = `${header}\n${rows}\n`;
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `flowlab_${(section.label || section.id).replace(/\s+/g, '_')}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, [sectionProfiles, channelDepthMm]);

    /* Download a wide-format CSV of the full transient flow-rate
       history for every section currently in the scene. Columns:
       iter, t_s, then per section: mean_mps, peak_mps, flux_m2ps,
       Q_m3ps, Q_mlpm. Missing cells (section added mid-run) are
       left empty so spreadsheets handle them gracefully. */
    const exportTimeHistoryCsv = useCallback(() => {
        if (!timeHistory.length) return;
        const safeName = (s) => (s.label || s.id).replace(/[^\w\-]+/g, '_');
        const cols = [];
        for (const s of sections) {
            cols.push(`mean_mps__${safeName(s)}`);
            cols.push(`peak_mps__${safeName(s)}`);
            cols.push(`flux_m2ps__${safeName(s)}`);
            cols.push(`Q_m3ps__${safeName(s)}`);
            cols.push(`Q_mlpm__${safeName(s)}`);
        }
        const header = [
            '# Flow Lab — transient flow-rate history',
            `# gas: ${gas?.name || gasId}, kinematic ν: ${gas?.nu.toExponential(3) || '?'} m²/s, density ρ: ${gas?.rho?.toFixed(4) || '?'} kg/m³`,
            `# inlet U: ${inletU_m_s} m/s, channel depth: ${channelDepthMm} mm`,
            `# dt (s): ${solverInfo?.dt_s?.toExponential(6) || 'unknown'}`,
            `# dx (m): ${solverInfo?.dx_m?.toExponential(6) || 'unknown'}`,
            `# grid: ${solverInfo ? `${solverInfo.nx}×${solverInfo.ny}` : 'unknown'}`,
            `# samples: ${timeHistory.length}`,
            `# sections: ${sections.map((s) => s.label || s.id).join(' | ')}`,
            '',
            ['iter', 't_s', ...cols].join(','),
        ].join('\n');
        const rows = timeHistory.map((row) => {
            const parts = [row.iter, row.t_s.toExponential(6)];
            for (const s of sections) {
                const rec = row.per?.[s.id];
                if (!rec) { parts.push('', '', '', '', ''); continue; }
                parts.push(
                    Number.isFinite(rec.mean_mps)  ? rec.mean_mps.toFixed(8)    : '',
                    Number.isFinite(rec.peak_mps)  ? rec.peak_mps.toFixed(8)    : '',
                    Number.isFinite(rec.flux_m2ps) ? rec.flux_m2ps.toExponential(6) : '',
                    Number.isFinite(rec.Q_m3ps)    ? rec.Q_m3ps.toExponential(6) : '',
                    Number.isFinite(rec.Q_mlpm)    ? rec.Q_mlpm.toFixed(8)      : '',
                );
            }
            return parts.join(',');
        }).join('\n');
        const csv = `${header}\n${rows}\n`;
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `flowlab_timehistory_${projectName || 'untitled'}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, [timeHistory, sections, gas, gasId, inletU_m_s, channelDepthMm, solverInfo, projectName]);

    /* Steady-state summary CSV — one row per section with the current
       (final) flow-field stats. Exports even if the solver hasn't
       formally converged yet; users routinely want a "here is the
       latest snapshot" dump regardless. */
    const exportSteadyStateCsv = useCallback(() => {
        if (!sectionProfiles.length) return;
        const rows = sectionProfiles.filter((p) => p.ok).map((p) => {
            const s = p.section;
            const st = p.stats;
            return [
                (s.label || s.id).replace(/[^\w\-]+/g, '_'),
                p.lenMm.toFixed(4),
                st.peak_mps.toFixed(8),
                st.mean_mps.toFixed(8),
                st.std_mps.toFixed(8),
                (st.uniformity * 100).toFixed(3),
                st.flux_m2ps.toExponential(6),
                st.volFlow_m3ps.toExponential(6),
                st.volFlow_mlpm.toFixed(6),
                st.Re_local.toFixed(4),
            ].join(',');
        }).join('\n');
        const header = [
            '# Flow Lab — steady-state section summary',
            `# gas: ${gas?.name || gasId}, inlet U: ${inletU_m_s} m/s, depth: ${channelDepthMm} mm`,
            `# field iter: ${field?.iter ?? '?'}, residual: ${Number.isFinite(field?.residual) ? field.residual.toExponential(3) : '?'}`,
            `# steady: ${steadyIter != null ? `yes (iter ${steadyIter})` : 'not yet'}`,
            '',
            'section,length_mm,peak_mps,mean_mps,std_mps,uniformity_pct,flux_m2ps,Q_m3ps,Q_mlpm,Re_local',
        ].join('\n');
        const csv = `${header}\n${rows}\n`;
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `flowlab_summary_${projectName || 'untitled'}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, [sectionProfiles, gas, gasId, inletU_m_s, channelDepthMm, field, steadyIter, projectName]);

    /* Sensor response metrics — given a c(t) curve recorded at a
     * sensor wall, derive the classical response characteristics:
     *   peak, time-of-peak, t10 / t50 / t90 on the rising edge,
     *   FWHM (full width at half-max), AUC ≈ "total dose", and
     *   final value (for steady inlet profiles). All times are in
     *   seconds of simulated flow. Pure function so it can be called
     *   from the UI AND the CSV exporter. Returns null if the curve
     *   is too short to be meaningful. */
    const sensorMetrics = useCallback((entry) => {
        if (!entry || !entry.t_s || entry.t_s.length < 3) return null;
        const t = entry.t_s, c = entry.c;
        const n = t.length;
        let peak = -Infinity, tPeak = 0;
        for (let i = 0; i < n; i++) {
            if (c[i] > peak) { peak = c[i]; tPeak = t[i]; }
        }
        const baseline = c[0];
        const final = c[n - 1];
        const threshold = (frac) => peak > baseline ? baseline + frac * (peak - baseline) : peak;
        // Rising-edge crossings by linear interpolation — returns NaN
        // if the curve never reaches that threshold (e.g. δ-pulse too
        // short to resolve).
        const firstCross = (thr) => {
            for (let i = 1; i < n; i++) {
                if ((c[i - 1] < thr) !== (c[i] < thr)) {
                    const a = c[i - 1], b = c[i];
                    const frac = Math.abs(b - a) < 1e-12 ? 0 : (thr - a) / (b - a);
                    return t[i - 1] + frac * (t[i] - t[i - 1]);
                }
            }
            return NaN;
        };
        const t10 = firstCross(threshold(0.10));
        const t50 = firstCross(threshold(0.50));
        const t90 = firstCross(threshold(0.90));
        // FWHM around the peak (full width where c ≥ peak/2).
        const half = 0.5 * peak;
        let tRiseHalf = NaN, tFallHalf = NaN;
        for (let i = 1; i < n; i++) {
            if (c[i - 1] < half && c[i] >= half) {
                const a = c[i - 1], b = c[i];
                const frac = Math.abs(b - a) < 1e-12 ? 0 : (half - a) / (b - a);
                tRiseHalf = t[i - 1] + frac * (t[i] - t[i - 1]);
                break;
            }
        }
        for (let i = n - 1; i >= 1; i--) {
            if (c[i - 1] >= half && c[i] < half) {
                const a = c[i - 1], b = c[i];
                const frac = Math.abs(b - a) < 1e-12 ? 0 : (half - a) / (b - a);
                tFallHalf = t[i - 1] + frac * (t[i] - t[i - 1]);
                break;
            }
        }
        const fwhm = (Number.isFinite(tRiseHalf) && Number.isFinite(tFallHalf))
            ? (tFallHalf - tRiseHalf) : NaN;
        // Trapezoidal AUC of (c − baseline) over the full record.
        let auc = 0;
        for (let i = 1; i < n; i++) {
            auc += 0.5 * ((c[i] - baseline) + (c[i - 1] - baseline)) * (t[i] - t[i - 1]);
        }
        return {
            peak, tPeak, baseline, final,
            t10, t50, t90,
            riseTime: Number.isFinite(t10) && Number.isFinite(t90) ? t90 - t10 : NaN,
            fwhm, auc,
            n,
            duration: t[n - 1] - t[0],
        };
    }, []);

    /* Per-sensor CSV export: wide format with time + each sensor's
     * c(t) and |u|(t). Handy for offline analysis / plotting. */
    const exportSensorCsv = useCallback(() => {
        const store = sensorHistoryRef.current;
        const keys = Object.keys(store);
        if (keys.length === 0) return;
        // Use the longest sensor's time axis as the master. In practice
        // every sensor is sampled on the same beat anyway.
        const masterKey = keys.reduce((a, b) =>
            store[a].t_s.length >= store[b].t_s.length ? a : b);
        const master = store[masterKey];
        const cols = [];
        for (const k of keys) {
            const lab = (store[k].label || `S${k}`).replace(/[^\w\-]+/g, '_');
            cols.push(`c__${lab}`);
            cols.push(`u_mps__${lab}`);
        }
        const header = [
            '# Flow Lab — sensor response export',
            `# gas: ${gas?.label || gasId}, inlet U: ${effectiveInletU_m_s.toExponential(3)} m/s, depth: ${channelDepthMm} mm`,
            `# analyte: ${analyte.label}, D: ${D_m2s.toExponential(3)} m²/s, Sc: ${Sc.toFixed(2)}, Pe: ${Pe.toExponential(3)}`,
            `# sample conditions: T = ${Number(analyteT_C).toFixed(1)} °C, RH = ${Number(analyteRH_pct).toFixed(0)} %`,
            `# pulse: ${pulseId} (${JSON.stringify(pulseParams)})`,
            `# samples: ${master.t_s.length}`,
            `# sensors: ${keys.map((k) => store[k].label).join(' | ')}`,
            '',
            ['t_s', ...cols].join(','),
        ].join('\n');
        const rows = master.t_s.map((t_s, i) => {
            const parts = [t_s.toExponential(6)];
            for (const k of keys) {
                const s = store[k];
                const idx = Math.min(i, s.t_s.length - 1);
                parts.push(
                    Number.isFinite(s.c[idx]) ? s.c[idx].toFixed(8) : '',
                    Number.isFinite(s.u[idx]) ? s.u[idx].toFixed(8) : '',
                );
            }
            return parts.join(',');
        }).join('\n');
        const csv = `${header}\n${rows}\n`;
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `flowlab_sensors_${projectName || 'untitled'}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, [gas, gasId, effectiveInletU_m_s, channelDepthMm, analyte, D_m2s, Sc, Pe,
        analyteT_C, analyteRH_pct, pulseId, pulseParams, projectName]);

    /* Streamlines — integrate a set of seed points forward through the
       velocity field and render as thin translucent polylines over the
       heatmap. Step size is constant in arc-length (we advance along the
       *normalised* velocity direction) so line length isn't dominated
       by the fastest cells in the jet. This is the visual style used by
       COMSOL / Paraview for stream-line plots.

       Cost: seedCount seeds × maxSteps × ~bilinear sample. With 60 seeds
       × 180 steps that's ≈ 10 000 samples per snapshot — sub-millisecond. */
    const streamlines = useMemo(() => {
        if (!showStreamlines) return [];
        if (!field || !solverInfo || !maskRef.current) return [];
        const { nx, ny, ux, uy } = field;
        const mask = maskRef.current;
        const { bbox } = solverInfo;
        const dx_mm = (bbox.xmax - bbox.xmin) / nx;
        const dy_mm = (bbox.ymax - bbox.ymin) / ny;
        const umax = field.umax || 1e-12;

        const sampleVel = (x_mm, y_mm) => {
            const i = (x_mm - bbox.xmin) / dx_mm - 0.5;
            const j = (y_mm - bbox.ymin) / dy_mm - 0.5;
            const i0 = Math.floor(i), j0 = Math.floor(j);
            if (i0 < 0 || i0 >= nx - 1 || j0 < 0 || j0 >= ny - 1) return null;
            const k00 = j0 * nx + i0;
            const k10 = j0 * nx + i0 + 1;
            const k01 = (j0 + 1) * nx + i0;
            const k11 = (j0 + 1) * nx + i0 + 1;
            // Walking into a wall? Terminate the streamline there.
            if (mask[k00] === 1 && mask[k10] === 1 && mask[k01] === 1 && mask[k11] === 1) return null;
            const fi = i - i0, fj = j - j0;
            const w00 = (1 - fi) * (1 - fj);
            const w10 = fi * (1 - fj);
            const w01 = (1 - fi) * fj;
            const w11 = fi * fj;
            return [
                w00 * ux[k00] + w10 * ux[k10] + w01 * ux[k01] + w11 * ux[k11],
                w00 * uy[k00] + w10 * uy[k10] + w01 * uy[k01] + w11 * uy[k11],
            ];
        };

        // Seed on a regular grid covering the fluid region.
        const targetSeeds = 60;
        const seedStride = Math.max(3, Math.round(Math.sqrt((nx * ny) / targetSeeds)));
        const seeds = [];
        for (let j = Math.floor(seedStride / 2); j < ny; j += seedStride) {
            for (let i = Math.floor(seedStride / 2); i < nx; i += seedStride) {
                const k = j * nx + i;
                if (mask[k] === 1) continue;
                seeds.push({
                    x: bbox.xmin + (i + 0.5) * dx_mm,
                    y: bbox.ymin + (j + 0.5) * dy_mm,
                });
            }
        }

        // Arc-length step: half a cell, so streamlines resolve fine features.
        const ds = Math.min(dx_mm, dy_mm) * 0.5;
        const maxSteps = 180;
        const minSpeedFrac = 0.003; // stop if local speed drops below 0.3% of umax
        const lines = [];
        for (const seed of seeds) {
            const pts = [{ x: seed.x, y: seed.y }];
            let p = { x: seed.x, y: seed.y };
            for (let k = 0; k < maxSteps; k++) {
                const v = sampleVel(p.x, p.y);
                if (!v) break;
                const speed = Math.hypot(v[0], v[1]);
                if (speed < minSpeedFrac * umax) break;
                // RK2: evaluate at midpoint.
                const mx = p.x + 0.5 * ds * v[0] / speed;
                const my = p.y + 0.5 * ds * v[1] / speed;
                const vm = sampleVel(mx, my);
                if (!vm) break;
                const speedMid = Math.hypot(vm[0], vm[1]);
                if (speedMid < minSpeedFrac * umax) break;
                p = {
                    x: p.x + ds * vm[0] / speedMid,
                    y: p.y + ds * vm[1] / speedMid,
                };
                pts.push({ x: p.x, y: p.y });
            }
            if (pts.length > 3) lines.push(pts);
        }
        return lines;
    }, [field, solverInfo, showStreamlines]);

    /* Steady-state detection: last STEADY_WINDOW residuals all below threshold. */
    const steadyReached = useMemo(() => {
        if (residualHistory.length < STEADY_WINDOW) return false;
        const tail = residualHistory.slice(-STEADY_WINDOW);
        return tail.every((h) => h.residual < STEADY_THRESHOLD);
    }, [residualHistory]);

    /* Auto-pause as soon as steady state is detected. The worker is kept
       alive (paused), so hitting Run again resumes from the converged
       field rather than restarting from rest. Declared down here because
       its dep array references `steadyReached` — placing the effect
       above the useMemo would trip the temporal-dead-zone check the
       very first time React evaluates this function body. */
    useEffect(() => {
        /* When the user has specified a simulation duration, we keep
           marching past steady state and let the duration-watch effect
           below handle the pause. Otherwise preserve the original
           auto-pause-on-steady behaviour. */
        if (simDurationNum != null) {
            autoPausedOnceRef.current = false;
            return;
        }
        if (steadyReached && running && !autoPausedOnceRef.current) {
            autoPausedOnceRef.current = true;
            pauseSolver();
            setSolverWarning('Steady state reached — simulation auto-paused. Press Run to keep marching, adjust inputs and Run again, or Reset.');
        }
        if (!steadyReached) autoPausedOnceRef.current = false;
    }, [steadyReached, running, pauseSolver, simDurationNum]);

    /* Duration-based auto-pause. When the user sets a target simulation
       time (seconds of physical time), pause as soon as the current
       field's t_s crosses that threshold. Uses a separate "once" ref so
       it doesn't fight with the steady-state pause above. */
    const durationPausedOnceRef = useRef(false);
    const lastArmedDurationRef = useRef(null);
    useEffect(() => {
        if (simDurationNum == null) {
            durationPausedOnceRef.current = false;
            lastArmedDurationRef.current = null;
            return;
        }
        /* Re-arm whenever the user bumps / lowers the target so the
           next field post crossing the new threshold will pause. */
        if (lastArmedDurationRef.current !== simDurationNum) {
            lastArmedDurationRef.current = simDurationNum;
            durationPausedOnceRef.current = false;
        }
        const t_s = field?.t_s;
        if (!running || !Number.isFinite(t_s)) return;
        if (t_s >= simDurationNum && !durationPausedOnceRef.current) {
            durationPausedOnceRef.current = true;
            pauseSolver();
            setSolverWarning(`Reached target simulation time (${simDurationNum.toFixed(3)} s) — auto-paused. Press Run to keep marching past this target, or adjust Sim time and Run again.`);
        }
    }, [field, running, simDurationNum, pauseSolver]);

    /* Geometry / BC edits invalidate any running solver — the mask
       would be stale. Killing the worker here means the next Run click
       rebuilds it from scratch, which is the correct behaviour. */
    useEffect(() => {
        if (!workerRef.current) return;
        workerRef.current.terminate();
        workerRef.current = null;
        maskRef.current = null;
        setRunning(false);
        setField(null);
        setSolverInfo(null);
        setResidualHistory([]);
        residualHistoryRef.current = [];
        setTimeHistory([]);
        timeHistoryRef.current = [];
        lastRecordedIterRef.current = -1;
        autoPausedOnceRef.current = false;
    }, [entities]);

    const deadVolumePct = useMemo(() => {
        if (!field) return null;
        const { umag, umax } = field;
        if (umax < 1e-12) return null;
        const threshold = 0.01 * umax; // 1% of peak
        let dead = 0, fluid = 0;
        for (let i = 0; i < umag.length; i++) {
            if (umag[i] < 1e-15) continue; // wall cell (we zeroed these)
            fluid++;
            if (umag[i] < threshold) dead++;
        }
        return fluid > 0 ? (100 * dead / fluid) : null;
    }, [field]);

    /* ── Convenience: position heatmap canvas so it aligns with the
         fluid region bbox in world coords. */
    const heatmapBoxStyle = useMemo(() => {
        if (!solverInfo) return null;
        const { bbox } = solverInfo;
        const tl = toScreen({ x: bbox.xmin, y: bbox.ymax });
        const br = toScreen({ x: bbox.xmax, y: bbox.ymin });
        return {
            left: tl.x,
            top: tl.y,
            width: br.x - tl.x,
            height: br.y - tl.y,
        };
    }, [solverInfo, toScreen]);

    /* ─────────────── Render ─────────────── */
    const gridLines = useMemo(() => {
        if (!gridOn) return null;
        const g = gridStepMm;
        const majorEvery = Math.max(1, Math.round(minorDivisions || 1));
        const tl = toWorld(0, 0);
        const br = toWorld(canvasSize.w, canvasSize.h);
        const xmin = Math.floor(Math.min(tl.x, br.x) / g) * g;
        const xmax = Math.ceil(Math.max(tl.x, br.x) / g) * g;
        const ymin = Math.floor(Math.min(tl.y, br.y) / g) * g;
        const ymax = Math.ceil(Math.max(tl.y, br.y) / g) * g;
        const lines = [];
        for (let x = xmin; x <= xmax + 1e-9; x += g) {
            const major = Math.abs(Math.round(x / g) % majorEvery) === 0;
            const s1 = toScreen({ x, y: ymin });
            const s2 = toScreen({ x, y: ymax });
            lines.push(<line key={`vx${x}`} x1={s1.x} y1={s1.y} x2={s2.x} y2={s2.y}
                className={major ? 'fl-grid-major' : 'fl-grid-minor'} />);
        }
        for (let y = ymin; y <= ymax + 1e-9; y += g) {
            const major = Math.abs(Math.round(y / g) % majorEvery) === 0;
            const s1 = toScreen({ x: xmin, y });
            const s2 = toScreen({ x: xmax, y });
            lines.push(<line key={`hy${y}`} x1={s1.x} y1={s1.y} x2={s2.x} y2={s2.y}
                className={major ? 'fl-grid-major' : 'fl-grid-minor'} />);
        }
        // Axes.
        const o = toScreen({ x: 0, y: 0 });
        const xAxisEnd = toScreen({ x: gridStepMm * 2, y: 0 });
        const yAxisEnd = toScreen({ x: 0, y: gridStepMm * 2 });
        lines.push(<line key="xa" x1={o.x} y1={o.y} x2={xAxisEnd.x} y2={xAxisEnd.y}
            className="fl-axis fl-axis-x" />);
        lines.push(<line key="ya" x1={o.x} y1={o.y} x2={yAxisEnd.x} y2={yAxisEnd.y}
            className="fl-axis fl-axis-y" />);
        return lines;
    }, [gridOn, gridStepMm, minorDivisions, canvasSize, toWorld, toScreen]);

    const previewEntity = useMemo(() => {
        if (rectDrag) {
            const { x0, y0, x1, y1 } = rectDrag;
            const xmin = Math.min(x0, x1), xmax = Math.max(x0, x1);
            const ymin = Math.min(y0, y1), ymax = Math.max(y0, y1);
            return {
                id: 'preview',
                type: 'region',
                closed: true,
                points: [
                    { x: xmin, y: ymin }, { x: xmax, y: ymin },
                    { x: xmax, y: ymax }, { x: xmin, y: ymax },
                ],
                edgeBC: {},
            };
        }
        if (circleDrag && circleDrag.r > 0) {
            const { cx, cy, r } = circleDrag;
            const n = 48;
            const pts = [];
            for (let i = 0; i < n; i++) {
                const a = (i / n) * 2 * Math.PI;
                pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
            }
            return { id: 'preview', type: 'region', closed: true, points: pts, edgeBC: {} };
        }
        if (pendingPolyPoints.length > 0) {
            const pts = pendingPolyPoints.concat(cursorWorld ? [cursorWorld] : []);
            return { id: 'preview', type: 'region', closed: true, points: pts, edgeBC: {} };
        }
        if (pendingLinePoints.length > 0) {
            const pts = pendingLinePoints.concat(cursorWorld ? [cursorWorld] : []);
            return { id: 'preview', type: 'region', closed: false, points: pts, edgeBC: {} };
        }
        return null;
    }, [rectDrag, circleDrag, pendingPolyPoints, pendingLinePoints, cursorWorld]);

    /* When the Line tool is "continuing" from an existing open polyline's
       endpoint, that polyline is duplicated in the preview (it becomes
       part of pendingLinePoints). Hide the original while extending so
       the canvas doesn't render it twice. */
    const displayedEntities = (pendingLineExtendId
        ? entities.filter((en) => en.id !== pendingLineExtendId)
        : entities
    ).concat(previewEntity ? [previewEntity] : []);

    /* Guided-tour highlight: every time `tourIdx` advances, scrub the
       previous highlight off whichever element had it and apply a
       pulsing attribute to the new target. Using a data-attribute
       (rather than mutating className) lets the CSS rule stay scoped
       and guarantees no stale highlights if React re-mounts a panel. */
    useEffect(() => {
        document
            .querySelectorAll('[data-tour-highlight="true"]')
            .forEach((el) => el.removeAttribute('data-tour-highlight'));
        if (tourIdx == null) return;
        const step = AROMA_TOUR_STEPS[tourIdx];
        if (!step?.target) return;
        const el = document.querySelector(`[data-tour-id="${step.target}"]`);
        if (!el) return;
        el.setAttribute('data-tour-highlight', 'true');
        try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
        return () => el.removeAttribute('data-tour-highlight');
    }, [tourIdx]);

    return (
        <div className="fl-page">
            {/* ─── Guided-tour overlay (opt-in; only active when the
                 "Load aroma demo" button was clicked) ─── */}
            {tourIdx !== null && createPortal(
                <div className="fl-tour-card" role="dialog" aria-modal="false">
                    <div className="fl-tour-step-label">
                        Step {tourIdx + 1} of {AROMA_TOUR_STEPS.length} · Aroma demo tour
                    </div>
                    <div className="fl-tour-title">{AROMA_TOUR_STEPS[tourIdx].title}</div>
                    <div className="fl-tour-body">{AROMA_TOUR_STEPS[tourIdx].body}</div>
                    <div className="fl-tour-actions">
                        <button type="button"
                                className="fl-toolbtn"
                                onClick={() => setTourIdx(null)}>
                            Skip tour
                        </button>
                        <div className="fl-tour-spacer" />
                        <button type="button"
                                className="fl-toolbtn"
                                disabled={tourIdx === 0}
                                onClick={() => setTourIdx((i) => Math.max(0, (i ?? 0) - 1))}>
                            Previous
                        </button>
                        <button type="button"
                                className="fl-toolbtn fl-toolbtn-primary"
                                onClick={() => {
                                    if (tourIdx >= AROMA_TOUR_STEPS.length - 1) {
                                        setTourIdx(null);
                                    } else {
                                        setTourIdx((i) => (i ?? 0) + 1);
                                    }
                                }}>
                            {tourIdx >= AROMA_TOUR_STEPS.length - 1 ? 'Finish' : 'Next'}
                        </button>
                    </div>
                </div>,
                document.body
            )}

            {/* ─── Toolbar (ribbon-style grouped) ─── */}
            <div className="fl-toolbar">
                {/* ── File ─────────────────────────────────────────── */}
                <div className="fl-tg">
                    <div className="fl-tg-label">File</div>
                    <div className="fl-tg-body">
                        <button className="fl-toolbtn"
                            title="New project — clear canvas and start fresh (Cmd/Ctrl+Z to undo)"
                            onClick={startNewProject}>
                            <FilePlus size={14} /> New
                        </button>
                        <button
                            className={`fl-toolbtn ${isDirty ? 'fl-toolbtn-primary' : ''}`}
                            title={currentProjectFileName
                                ? `Save changes to ${currentProjectFileName} (Cmd/Ctrl+S)`
                                : 'Save project to workspace → Flow Lab folder (Cmd/Ctrl+S)'}
                            onClick={handleSaveProject}
                            disabled={!onSaveJson}>
                            <Save size={14} /> Save{isDirty ? ' *' : ''}
                        </button>
                        <button className="fl-toolbtn"
                            title="Save as a new project file (Cmd/Ctrl+Shift+S)"
                            onClick={handleSaveAsProject}
                            disabled={!onSaveJson}>
                            Save as…
                        </button>
                        <button
                            className="fl-toolbtn"
                            title="Save a snapshot of the current simulation result for later analysis"
                            onClick={() => handleSaveResult()}
                            disabled={!onSaveJson || !field}
                        >
                            <Archive size={14} /> Result
                        </button>
                        <button
                            className="fl-toolbtn"
                            title="Open the Flow Lab file manager (projects, results, folders)"
                            onClick={() => setExplorerOpen(true)}
                        >
                            <FolderOpen size={14} /> Files{flowLabFiles.length
                                ? ` (${flowLabFiles.filter((f) => f._kind !== 'marker').length})`
                                : ''}
                        </button>
                    </div>
                </div>
                <div className="fl-sep" />
                {/* ── Mode (Simulation ↔ CAD) ──────────────────────── */}
                <div className="fl-tg">
                    <div className="fl-tg-label">Mode</div>
                    <div className="fl-tg-body">
                        <div
                            className="fl-mode-toggle"
                            role="tablist"
                            aria-label="Flow Lab mode"
                        >
                            <button
                                type="button"
                                role="tab"
                                aria-selected={!cadMode}
                                className={!cadMode ? 'is-active' : ''}
                                title="Simulation mode — focus on running and analysing the simulation. CAD tools are hidden (Select, Section, Measure stay available)."
                                onClick={() => setCadMode(false)}
                            >
                                <Wind size={12} style={{ marginRight: 4 }} />
                                Simulate
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={cadMode}
                                className={cadMode ? 'is-active' : ''}
                                title="CAD mode — author geometry with the full Sketch / Modify / Combine ribbon. Click entities to select (Shift-click or right-drag for multi); delete edges, draw or re-close with the Line tool."
                                onClick={() => setCadMode(true)}
                            >
                                <PenLine size={12} style={{ marginRight: 4 }} />
                                CAD
                            </button>
                        </div>
                    </div>
                </div>
                {cadMode && <div className="fl-sep" />}
                {cadMode && (
                <>
                {/* ── Sketch (create geometry) ─────────────────────── */}
                <div className="fl-tg">
                    <div className="fl-tg-label">Sketch</div>
                    <div className="fl-tg-body">
                        <ToolButton active={tool === TOOLS.SELECT} onClick={() => setTool(TOOLS.SELECT)}
                            title="Select (V) — click a vertex, edge, or interior. Shift-click to multi-select; right-drag on canvas for marquee select."
                            icon={<MousePointer2 size={14} />} label="Select" />
                        <ToolButton active={tool === TOOLS.LINE} onClick={() => setTool(TOOLS.LINE)}
                            title="Line — click to add vertices; click the first vertex to close into a polygon, Enter leaves it open"
                            icon={<PenLine size={14} />} label="Line" />
                        <ToolButton active={tool === TOOLS.RECT} onClick={() => setTool(TOOLS.RECT)}
                            title="Rectangle (R)" icon={<Square size={14} />} label="Rect" />
                        <ToolButton active={tool === TOOLS.POLY} onClick={() => setTool(TOOLS.POLY)}
                            title="Polyline — click, click, double-click to close (P)"
                            icon={<Hexagon size={14} />} label="Polyline" />
                        <ToolButton active={tool === TOOLS.CIRCLE} onClick={() => setTool(TOOLS.CIRCLE)}
                            title="Circle (C)" icon={<CircleIcon size={14} />} label="Circle" />
                    </div>
                </div>
                <div className="fl-sep" />
                {/* ── Modify (edit existing geometry) ──────────────── */}
                <div className="fl-tg">
                    <div className="fl-tg-label">Modify</div>
                    <div className="fl-tg-body">
                        <ToolButton
                            active={tool === TOOLS.MOVE}
                            onClick={() => { setTool(TOOLS.MOVE); setMovePending(null); }}
                            title="Move — click a reference point, then click the target point. Moves all selected entities."
                            icon={<MoveHorizontal size={14} />} label="Move"
                        />
                        <ToolButton
                            active={tool === TOOLS.MIRROR}
                            onClick={() => setTool(TOOLS.MIRROR)}
                            title="Mirror (M) — drag to draw a reflection axis; the selected entities are mirrored across it."
                            icon={<FlipHorizontal size={14} />} label="Mirror"
                        />
                        <div className="fl-offset-wrap">
                            <ToolButton
                                active={tool === TOOLS.OFFSET}
                                onClick={() => setTool(TOOLS.OFFSET)}
                                title="Offset (O) — click a closed polygon and generate a parallel polygon at the distance below. Positive grows outward, negative shrinks inward."
                                icon={<Shapes size={14} />} label="Offset"
                            />
                            <label className="fl-offset-input" title={`Offset distance (${UNIT_LABEL[unit]}). Positive = outward, negative = inward.`}>
                                <span>d</span>
                                <input
                                    type="number"
                                    step={unit === 'um' ? 10 : 0.1}
                                    value={Number(mmToUnit(offsetDistanceMm, unit).toFixed(unit === 'um' ? 1 : 3))}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (Number.isFinite(v)) setOffsetDistanceMm(unitToMm(v, unit));
                                    }}
                                />
                                <span className="fl-offset-unit">{UNIT_LABEL[unit]}</span>
                            </label>
                        </div>
                        <ToolButton
                            active={tool === TOOLS.EXTEND}
                            onClick={() => { setTool(TOOLS.EXTEND); setExtendPending(null); }}
                            title="Extend (X) — click the free end of an open polyline, then click toward the boundary. The line grows along its direction to the first hit."
                            icon={<ArrowUpRight size={14} />} label="Extend"
                        />
                        <div className="fl-offset-wrap">
                            <ToolButton active={tool === TOOLS.FILLET} onClick={() => setTool(TOOLS.FILLET)}
                                title="Fillet — click a corner vertex of a closed polygon to round it with the radius below"
                                icon={<Spline size={14} />} label="Fillet" />
                            <label className="fl-fillet-radius" title={`Fillet radius (${UNIT_LABEL[unit]})`}>
                                R
                                <input
                                    type="number"
                                    min="0"
                                    step={unit === 'mm' ? 0.1 : 10}
                                    value={Number(mmToUnit(filletRadiusMm, unit).toFixed(unit === 'mm' ? 3 : 1))}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (Number.isFinite(v) && v >= 0) setFilletRadiusMm(unitToMm(v, unit));
                                    }}
                                />
                                <span className="fl-fillet-unit">{UNIT_LABEL[unit]}</span>
                            </label>
                        </div>
                        <ToolButton active={tool === TOOLS.TRIM} onClick={() => setTool(TOOLS.TRIM)}
                            title="Trim (T) — for section probes and OPEN (dashed) construction lines only. Cuts at intersections. To merge two touching closed shapes, select both and use Combine → Union (⌘U)."
                            icon={<Scissors size={14} />} label="Trim" />
                        <ToolButton active={tool === TOOLS.DELETE} onClick={() => setTool(TOOLS.DELETE)}
                            title="Delete tool — click a vertex to drop it, click an edge to break that segment, click the interior to remove the whole entity."
                            icon={<Eraser size={14} />} label="Delete" />
                        <button className="fl-toolbtn"
                            title="Delete selection (Del) — remove the currently selected vertex, edge section, or entity."
                            onClick={deleteSelection}
                            disabled={!selection}>
                            <Trash2 size={14} /> Delete sel
                        </button>
                    </div>
                </div>
                <div className="fl-sep" />
                {/* ── Combine (multi-select required) ──────────────── */}
                <div className="fl-tg">
                    <div className="fl-tg-label">
                        <span>Combine</span>
                        {activeSelectionIds.length > 0 && (
                            <span className="fl-tg-badge">{activeSelectionIds.length} selected</span>
                        )}
                    </div>
                    <div className="fl-tg-body">
                        <button className="fl-toolbtn"
                            onClick={runUnion}
                            disabled={closedSelectedEntities.length < 2}
                            title="Union (Ctrl+U) — fuse the selected closed polygons into one region. Select 2+ via Entities list checkboxes, right-drag marquee, or Shift-click.">
                            <Combine size={14} /> Union
                        </button>
                        <button className="fl-toolbtn"
                            onClick={runSubtract}
                            disabled={closedSelectedEntities.length < 2}
                            title="Subtract — first selected polygon minus the rest. Shift-click the operands in order (primary = minuend).">
                            <SubtractIcon size={14} /> Subtract
                        </button>
                        <button className="fl-toolbtn"
                            onClick={runIntersect}
                            disabled={closedSelectedEntities.length < 2}
                            title="Intersect — region common to all selected closed polygons.">
                            <SquareAsterisk size={14} /> Intersect
                        </button>
                        <button className="fl-toolbtn"
                            onClick={runXor}
                            disabled={closedSelectedEntities.length < 2}
                            title="XOR — symmetric difference (everything except the common region).">
                            <Shuffle size={14} /> XOR
                        </button>
                        <button className="fl-toolbtn"
                            onClick={runJoinToRegion}
                            disabled={openSelectedEntities.length === 0}
                            title="Make region — stitch selected open polylines into a single closed polygon. Use Extend / Trim first to clean up intersections.">
                            <Link2 size={14} /> Make region
                        </button>
                    </div>
                </div>
                </>
                )}
                <div className="fl-sep" />
                {/* ── Analysis (probes & measurements) ─────────────── */}
                <div className="fl-tg">
                    <div className="fl-tg-label">Analysis</div>
                    <div className="fl-tg-body">
                        <ToolButton active={tool === TOOLS.SECTION} onClick={() => setTool(TOOLS.SECTION)}
                            title="Section probe — drag a line across the channel to plot u, flow-rate, etc. along it"
                            icon={<Minus size={14} />} label="Section" />
                        <ToolButton active={tool === TOOLS.PROBE} onClick={() => setTool(TOOLS.PROBE)}
                            title="Point probe — click anywhere inside the fluid to drop a dot. It samples c(t) and |u|(t) at that point every frame and shows up in the Sensor response panel alongside wall sensors. Keep clicking to drop several; Escape / Select to stop."
                            icon={<Crosshair size={14} />} label="Probe" />
                        <ToolButton active={tool === TOOLS.MEASURE}
                            onClick={() => { setTool(TOOLS.MEASURE); setMeasurePending(null); }}
                            title="Measure — click two points to show coordinates, Δx, Δy, length and angle. Snap works if enabled. Escape clears."
                            icon={<Ruler size={14} />} label="Measure" />
                        {measurement && (
                            <button className="fl-toolbtn"
                                title="Clear the current measurement"
                                onClick={() => { setMeasurement(null); setMeasurePending(null); }}>
                                <CloseIcon size={14} /> Clear
                            </button>
                        )}
                    </div>
                </div>
                <div className="fl-sep" />
                {/* ── History ──────────────────────────────────────── */}
                <div className="fl-tg">
                    <div className="fl-tg-label">History</div>
                    <div className="fl-tg-body">
                        <button className="fl-toolbtn" title="Undo (Cmd/Ctrl+Z)"
                            onClick={undo} disabled={!canUndo}>
                            <Undo2 size={14} />
                        </button>
                        <button className="fl-toolbtn" title="Redo (Cmd/Ctrl+Shift+Z)"
                            onClick={redo} disabled={!canRedo}>
                            <Redo2 size={14} />
                        </button>
                    </div>
                </div>
                <div className="fl-sep" />
                {/* ── View (grid, snap, units) ─────────────────────── */}
                <div className="fl-tg">
                    <div className="fl-tg-label">View</div>
                    <div className="fl-tg-body">
                        <ToolButton active={gridOn} onClick={() => setGridOn((v) => !v)}
                            title="Toggle grid (F7)" icon={<Grid3x3 size={14} />} label="Grid" />
                        <div className="fl-gridsettings-wrap">
                            <button
                                ref={gridSettingsBtnRef}
                                className={`fl-toolbtn fl-gridsettings-btn${gridSettingsOpen ? ' is-active' : ''}`}
                                onClick={() => setGridSettingsOpen((v) => !v)}
                                title="Grid settings — spacing, divisions, minimum step"
                                aria-label="Grid settings"
                                aria-expanded={gridSettingsOpen}
                            >
                                <Settings2 size={14} />
                            </button>
                            {gridSettingsOpen && (
                                <GridSettingsPopover
                                    gridStepMm={gridStepMm}
                                    overrideMm={gridStepOverrideMm}
                                    setOverrideMm={setGridStepOverrideMm}
                                    minStepMm={gridStepMinMm}
                                    setMinStepMm={setGridStepMinMm}
                                    minorDivisions={minorDivisions}
                                    setMinorDivisions={setMinorDivisions}
                                    unit={unit}
                                    anchorEl={gridSettingsBtnRef.current}
                                    onClose={() => setGridSettingsOpen(false)}
                                />
                            )}
                        </div>
                        <ToolButton active={snapOn} onClick={() => setSnapOn((v) => !v)}
                            title="Toggle snap (F9)" icon={<Ruler size={14} />} label="Snap" />
                        <div className="fl-unit-toggle">
                            <button className={unit === 'mm' ? 'is-active' : ''}
                                onClick={() => setUnit('mm')}>mm</button>
                            <button className={unit === 'um' ? 'is-active' : ''}
                                onClick={() => setUnit('um')}>µm</button>
                        </div>
                    </div>
                </div>
                <div className="fl-sep" />
                {/* ── Panels (show / hide sidebars to maximise canvas) ─ */}
                <div className="fl-tg">
                    <div className="fl-tg-label">Panels</div>
                    <div className="fl-tg-body">
                        <ToolButton
                            active={!leftPanelOpen}
                            onClick={() => setLeftPanelOpen((v) => !v)}
                            title={leftPanelOpen ? 'Hide the left panel (Entities / help)' : 'Show the left panel (Entities / help)'}
                            icon={<PanelLeftClose size={14} />}
                            label={leftPanelOpen ? 'Hide L' : 'Show L'}
                        />
                        <ToolButton
                            active={!rightPanelOpen}
                            onClick={() => setRightPanelOpen((v) => !v)}
                            title={rightPanelOpen ? 'Hide the right panel (Inspector / properties)' : 'Show the right panel (Inspector / properties)'}
                            icon={<PanelRightClose size={14} />}
                            label={rightPanelOpen ? 'Hide R' : 'Show R'}
                        />
                        <ToolButton
                            active={panelsAutoHide}
                            onClick={() => setPanelsAutoHide((v) => !v)}
                            title="Auto-hide both side panels while a non-Select tool is active (they re-appear when you return to Select / press Esc)"
                            icon={<EyeOff size={14} />}
                            label="Auto-hide"
                        />
                    </div>
                </div>
                <div className="fl-sep" />
                {/* ── Viewport (zoom / fit) ────────────────────────── */}
                <div className="fl-tg">
                    <div className="fl-tg-label">Viewport</div>
                    <div className="fl-tg-body">
                        <button className="fl-toolbtn" title="Zoom in" onClick={() =>
                            setViewport((v) => ({ ...v, pxPerMm: Math.min(5000, v.pxPerMm * 1.25) }))}>
                            <ZoomIn size={14} />
                        </button>
                        <button className="fl-toolbtn" title="Zoom out" onClick={() =>
                            setViewport((v) => ({ ...v, pxPerMm: Math.max(0.5, v.pxPerMm / 1.25) }))}>
                            <ZoomOut size={14} />
                        </button>
                        <button className="fl-toolbtn" title="Fit to content (F)" onClick={fitToContent}>
                            <Maximize2 size={14} /> Fit
                        </button>
                    </div>
                </div>
                <div className="fl-sep" />
                {/* ── Simulate (run/pause/reset) ───────────────────── */}
                <div className="fl-tg">
                    <div className="fl-tg-label">Simulate</div>
                    <div className="fl-tg-body">
                        {!running ? (
                            <button className="fl-toolbtn fl-toolbtn-primary" onClick={runOrResumeSolver} data-tour-id="run">
                                <Play size={14} />
                                {workerRef.current ? (steadyReached ? 'Resume (steady)' : 'Resume') : 'Run'}
                            </button>
                        ) : (
                            <button className="fl-toolbtn" onClick={pauseSolver}>
                                <Pause size={14} /> Pause
                            </button>
                        )}
                        <button className="fl-toolbtn" onClick={resetSolver}>
                            <RotateCcw size={14} /> Reset
                        </button>
                    </div>
                </div>
                <div className="fl-spacer" />
                {currentProjectFileName && (
                    <span className="fl-current-file" title="Currently open file">
                        {currentProjectFileName}{isDirty ? ' •' : ''}
                    </span>
                )}
                {saveStatus && <span className="fl-save-status">{saveStatus}</span>}
                <div className="fl-re-badge" title="Global Reynolds number">
                    <Wind size={14} /> Re ≈ {Re.toFixed(1)}
                </div>
            </div>

            {/* ─── Main layout ─── */}
            <div
                className={`fl-main${!showLeftPanel ? ' fl-main--no-left' : ''}${!showRightPanel ? ' fl-main--no-right' : ''}`}
                style={{
                    gridTemplateColumns: `${showLeftPanel ? '220px' : '0'} 1fr ${showRightPanel ? '280px' : '0'}`,
                }}
            >
                {/* Left column: layers / info */}
                <div className={`fl-left${showLeftPanel ? '' : ' is-collapsed'}`} aria-hidden={!showLeftPanel}>
                    <div className="fl-panel">
                        <div className="fl-panel-title">Entities</div>
                        <div className="fl-entity-hint fl-muted">
                            Tick checkboxes to build a multi-selection for <b>Union</b> / boolean tools.
                            <b> Right-drag</b> a box on the canvas to grab several; hold <kbd>Shift</kbd> while releasing to add to the current set.
                        </div>
                        {entities.length === 0 ? (
                            <div className="fl-muted">No geometry yet. Draw a rectangle, circle or polyline to start.</div>
                        ) : entities.map((e) => (
                            <div key={e.id} className="fl-entity-list-row">
                                <label className="fl-entity-cb" title="Include in multi-selection (Union, Move, Mirror…)"
                                    onClick={(ev) => ev.stopPropagation()}
                                    onMouseDown={(ev) => ev.stopPropagation()}>
                                    <input
                                        type="checkbox"
                                        checked={multiSelection.has(e.id)}
                                        onChange={() => {
                                            setMultiSelection((prev) => {
                                                const n = new Set(prev);
                                                if (n.has(e.id)) n.delete(e.id);
                                                else n.add(e.id);
                                                return n;
                                            });
                                        }}
                                    />
                                </label>
                                <div
                                    className={`fl-entity-row ${selection?.entityId === e.id ? 'is-sel' : ''}${multiSelection.has(e.id) ? ' is-multi' : ''}`}
                                    onClick={() => setSelection({ entityId: e.id, edgeIdx: null, vertexIdx: null })}
                                >
                                    <span className="fl-entity-type">{e.closed === false ? 'Open' : 'Region'}</span>
                                    <span className="fl-entity-sub">{e.points.length} pts{e.id.length > 14 ? ` · ${e.id.slice(0, 12)}…` : ''}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="fl-panel">
                        <div className="fl-panel-title"><Info size={12} /> Quick help</div>
                        <ul className="fl-help">
                            <li><b>Line</b>: click to add vertices; click the <b>first</b> vertex to close into a polygon, <kbd>Enter</kbd> leaves it open (sketch line).</li>
                            <li><b>Polyline</b>: click to add vertices, <b>double-click</b> or <kbd>Enter</kbd> to close.</li>
                            <li><b>Select</b>: click a <b>vertex</b> or <b>edge</b> — press <kbd>Del</kbd> (or <b>Cut</b>). Vertex Del drops the corner; edge Del <b>breaks that segment</b> (closed shape opens, open polyline splits) so you can redesign it. <kbd>Shift</kbd>+<kbd>Del</kbd> on an edge collapses it instead.</li>
                            <li><b>Delete tool</b>: click a vertex to drop it, click an edge to break that segment, click the interior to remove the whole entity.</li>
                            <li><b>Undo / Redo</b>: <kbd>⌘Z</kbd> / <kbd>⌘⇧Z</kbd> (80 steps).</li>
                            <li><b>Save</b>: writes <code>.flow.json</code> to the workspace's <i>Flow Lab</i> folder; <b>Open</b> loads any project from that folder.</li>
                            <li><b>Pan</b>: hold <kbd>Alt</kbd>, or middle-mouse drag.</li>
                            <li><b>Zoom</b>: scroll wheel (cursor-anchored).</li>
                            <li><b>Grid ⚙</b>: click the gear next to <b>Grid</b> for fixed step + minor-division options.</li>
                            <li><b>Solver mesh</b>: right rail → pick <i>Coarse / Medium / Fine / Very fine</i> or a custom cell count; preview shows Δx before running.</li>
                            <li><b>Multi-select</b>: tick <b>checkboxes</b> in the Entities list, or <b>right-drag</b> a selection box on the canvas (<kbd>Shift</kbd>+release adds to the set). <kbd>Shift</kbd>+click on the canvas still works.</li>
                            <li><b>Boolean</b>: select 2+ closed polygons and use <b>Union</b> (<kbd>⌘U</kbd>), <b>Subtract</b> (first − rest), <b>Intersect</b>, or <b>XOR</b>.</li>
                            <li><b>Trim</b> (<kbd>T</kbd>): only <b>sections</b> and <b>open</b> dashed lines — not for merging two closed rectangles. To remove the wall between touching boxes: <kbd>Shift</kbd>+click both, <b>Union</b>, then set Inlet/Outlet again on the merged outline.</li>
                            <li><b>Offset</b> (<kbd>O</kbd>): set <code>d</code> in the toolbar (positive = outward, negative = inward), then click a closed polygon.</li>
                            <li><b>Extend</b> (<kbd>X</kbd>): click the free end of an open polyline, then click toward any boundary — line grows to the first intersection.</li>
                            <li><b>Move</b> (<kbd>V</kbd>): click reference then target — translates all selected entities.</li>
                            <li><b>Mirror</b> (<kbd>M</kbd>): drag to draw the reflection axis — reflects the selection across it.</li>
                            <li><b>Make region</b>: select several open polylines that form a loop → turns them into a single closed polygon ready for BCs.</li>
                            <li><b>Run</b>: needs at least one Inlet and one Outlet edge on a closed polygon.</li>
                            <li><b>Bail out</b>: press <kbd>Esc</kbd> any time to cancel the current tool, drop any pending click / drag, and jump back to <b>Select</b>.</li>
                            <li><b>Maximise canvas</b>: toolbar → <b>Panels</b> has <b>Hide L</b> / <b>Hide R</b> to collapse either sidebar, and <b>Auto-hide</b> tucks them away automatically while a drawing tool is active (they slide back in when you return to Select). You can also click the small chevrons on the left / right edges of the canvas to toggle.</li>
                            <li><b>Aroma pulse & sensors</b>:
                                <ol style={{ margin: '4px 0 0 14px', padding: 0, fontSize: '0.78rem' }}>
                                    <li>Set <b>Inlet Q</b> in the Gas & inlet panel (switch to <b>sccm</b> for flow-rate thinking). Dial in <b>Channel depth</b> so volumetric numbers are physical.</li>
                                    <li>Click a wall edge, open the edge inspector, set <b>BC → Sensor</b>. Repeat to add more — they show up violet-dashed on the canvas.</li>
                                    <li>In <b>Species transport</b>, enable the aroma pulse, pick an analyte and a pulse profile (step / rectangular / Gaussian / exp). The <b>Pe</b> and <b>Sc</b> badges tell you whether advection or diffusion dominates.</li>
                                    <li>Press <b>Run</b>. The velocity heatmap + magenta concentration overlay animate live, and the <b>Sensor response</b> panel records c(t), |u|(t), t₁₀ / t₅₀ / t₉₀, FWHM and AUC per sensor — export to CSV for offline analysis.</li>
                                </ol>
                            </li>
                        </ul>
                    </div>
                </div>

                {/* Centre: drawing canvas with heatmap underlay */}
                <div
                    ref={canvasWrapRef}
                    className={`fl-canvas-wrap${marqueeDrag ? ' is-marquee' : ''}`}
                    data-tour-id="canvas"
                    onWheel={handleWheel}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    onContextMenu={(ev) => ev.preventDefault()}
                    onDoubleClick={handleDoubleClick}
                    style={{ cursor: marqueeDrag ? 'crosshair' : (tool === TOOLS.SELECT ? 'default' : 'crosshair') }}
                >
                    {/* Edge toggles — always visible on the canvas so the side
                     *  panels can be collapsed / restored without touching the
                     *  toolbar. Tooltip changes to match current state. */}
                    <button
                        type="button"
                        className={`fl-edge-toggle fl-edge-toggle--left${showLeftPanel ? ' is-open' : ' is-closed'}`}
                        onClick={(e) => { e.stopPropagation(); setLeftPanelOpen((v) => !v); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={showLeftPanel ? 'Hide left panel (Entities)' : 'Show left panel (Entities)'}
                        aria-label={showLeftPanel ? 'Hide left panel' : 'Show left panel'}
                    >
                        {showLeftPanel ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <button
                        type="button"
                        className={`fl-edge-toggle fl-edge-toggle--right${showRightPanel ? ' is-open' : ' is-closed'}`}
                        onClick={(e) => { e.stopPropagation(); setRightPanelOpen((v) => !v); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={showRightPanel ? 'Hide right panel (Inspector)' : 'Show right panel (Inspector)'}
                        aria-label={showRightPanel ? 'Hide right panel' : 'Show right panel'}
                    >
                        {showRightPanel ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
                    </button>
                    {/* Aroma pulse event banner — appears when the
                        commanded inlet concentration crosses zero (start
                        or end of pulse). Auto-fades after ~3 s. */}
                    {pulseBanner && (
                        <div
                            className={`fl-pulse-banner fl-pulse-banner--${pulseBanner.kind}`}
                            role="status"
                            aria-live="polite"
                        >
                            {pulseBanner.kind === 'start' ? (
                                <>
                                    <span className="fl-pulse-banner-dot" />
                                    <span className="fl-pulse-banner-ttl">Aroma pulse in progress</span>
                                    <span className="fl-pulse-banner-sub">
                                        started t = {pulseBanner.t_s.toFixed(3)} s · c<sub>in</sub> = {pulseBanner.value?.toFixed(2)}
                                    </span>
                                </>
                            ) : (
                                <>
                                    <span className="fl-pulse-banner-dot" />
                                    <span className="fl-pulse-banner-ttl">Aroma pulse ended</span>
                                    <span className="fl-pulse-banner-sub">
                                        t = {pulseBanner.t_s.toFixed(3)} s · inlet closed, watching c(t) decay
                                    </span>
                                </>
                            )}
                        </div>
                    )}
                    {marqueeDrag && (
                        <div
                            className="fl-marquee-overlay"
                            style={{
                                left: Math.min(marqueeDrag.sx0, marqueeDrag.sx1),
                                top: Math.min(marqueeDrag.sy0, marqueeDrag.sy1),
                                width: Math.abs(marqueeDrag.sx1 - marqueeDrag.sx0),
                                height: Math.abs(marqueeDrag.sy1 - marqueeDrag.sy0),
                            }}
                            aria-hidden
                        />
                    )}
                    {heatmapBoxStyle && (
                        <canvas
                            ref={heatmapCanvasRef}
                            className="fl-heatmap"
                            style={heatmapBoxStyle}
                        />
                    )}
                    {heatmapBoxStyle && speciesEnabled && showSpeciesOverlay && (
                        <canvas
                            ref={speciesCanvasRef}
                            className="fl-species-overlay"
                            style={heatmapBoxStyle}
                            aria-hidden
                        />
                    )}
                    {displayStats && (
                        <ColorLegend
                            lut={COLORMAPS[colormap] || COLORMAPS.viridis}
                            vmin={0}
                            vmax={displayStats.p95 * latticeToMps}
                            label="|u| (m/s)"
                        />
                    )}
                    <AxesGizmo unit={unit} />
                    <OriginLabel toScreen={toScreen} canvasSize={canvasSize} unit={unit} />
                    <svg className="fl-svg" width={canvasSize.w} height={canvasSize.h}>
                        {gridLines}
                        {displayedEntities.map((e) => (
                            <EntitySvg
                                key={e.id}
                                entity={e}
                                toScreen={toScreen}
                                selected={selection?.entityId === e.id}
                                selectedEdgeIdx={selection?.entityId === e.id ? selection.edgeIdx : null}
                                selectedVertexIdx={selection?.entityId === e.id ? selection.vertexIdx : null}
                                isPreview={e.id === 'preview'}
                                multiSelected={multiSelection.has(e.id) && selection?.entityId !== e.id}
                            />
                        ))}
                        {/* Mirror-axis preview while dragging */}
                        {mirrorDrag && (() => {
                            const a = toScreen({ x: mirrorDrag.x0, y: mirrorDrag.y0 });
                            const b = toScreen({ x: mirrorDrag.x1, y: mirrorDrag.y1 });
                            return (
                                <g className="fl-mirror-preview">
                                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                                        className="fl-mirror-axis" />
                                    <circle cx={a.x} cy={a.y} r={3} className="fl-mirror-anchor" />
                                    <circle cx={b.x} cy={b.y} r={3} className="fl-mirror-anchor" />
                                </g>
                            );
                        })()}
                        {/* Move-tool rubber band */}
                        {movePending && cursorWorld && (() => {
                            const a = toScreen({ x: movePending.x0, y: movePending.y0 });
                            const b = toScreen(cursorWorld);
                            return (
                                <g className="fl-move-preview">
                                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                                        className="fl-move-vec" />
                                    <circle cx={a.x} cy={a.y} r={3} className="fl-move-anchor" />
                                </g>
                            );
                        })()}
                        {/* Extend-tool end-hint */}
                        {extendPending && (() => {
                            const ent = entities.find((en) => en.id === extendPending.entityId);
                            if (!ent) return null;
                            const pt = extendPending.endpoint === 'start'
                                ? ent.points[0]
                                : ent.points[ent.points.length - 1];
                            const s = toScreen(pt);
                            return <circle cx={s.x} cy={s.y} r={6} className="fl-extend-hint" />;
                        })()}
                        {/* Measure tool — live preview + finalized tooltip.
                             Shows P1, P2, Δx, Δy, length and angle in the
                             active unit (mm or µm). Tooltip anchors to the
                             end-point and nudges to stay on-canvas. */}
                        {(() => {
                            const p1 = measurement?.p1 || measurePending;
                            const p2 = measurement?.p2 || (measurePending && cursorWorld);
                            if (!p1 || !p2) return null;
                            const s1 = toScreen(p1);
                            const s2 = toScreen(p2);
                            const dx_mm = p2.x - p1.x;
                            const dy_mm = p2.y - p1.y;
                            const len_mm = Math.hypot(dx_mm, dy_mm);
                            const ang_deg = Math.atan2(dy_mm, dx_mm) * 180 / Math.PI;
                            const fmt = (mm) => {
                                const v = mmToUnit(mm, unit);
                                return unit === 'um' ? v.toFixed(0) : v.toFixed(3);
                            };
                            // Tooltip placement — anchor to P2 screen pos,
                            // clamp to stay inside the canvas so it never
                            // spills off the edge.
                            const TW = 178, TH = 100;
                            let tx = s2.x + 14;
                            let ty = s2.y - TH - 8;
                            if (tx + TW > canvasSize.w - 4) tx = s2.x - TW - 14;
                            if (ty < 4) ty = s2.y + 14;
                            if (ty + TH > canvasSize.h - 4) ty = canvasSize.h - TH - 4;
                            const finalised = !!measurement;
                            return (
                                <g className={`fl-measure ${finalised ? 'is-final' : 'is-preview'}`}>
                                    <line x1={s1.x} y1={s1.y} x2={s2.x} y2={s2.y}
                                        className="fl-measure-line" />
                                    <circle cx={s1.x} cy={s1.y} r={4} className="fl-measure-anchor" />
                                    <circle cx={s2.x} cy={s2.y} r={4} className="fl-measure-anchor" />
                                    {/* Midpoint length tag */}
                                    <g transform={`translate(${(s1.x + s2.x) / 2}, ${(s1.y + s2.y) / 2})`}>
                                        <rect x={-34} y={-10} width={68} height={18} rx={4}
                                            className="fl-measure-tagbg" />
                                        <text x={0} y={3} textAnchor="middle" className="fl-measure-tagtxt">
                                            {fmt(len_mm)} {UNIT_LABEL[unit]}
                                        </text>
                                    </g>
                                    {/* Detail tooltip card */}
                                    <g transform={`translate(${tx}, ${ty})`}>
                                        <rect width={TW} height={TH} rx={6} className="fl-measure-tipbg" />
                                        <text x={10} y={18} className="fl-measure-tiptitle">Measure</text>
                                        <text x={10} y={38} className="fl-measure-tiprow">
                                            P1 ({fmt(p1.x)}, {fmt(p1.y)}) {UNIT_LABEL[unit]}
                                        </text>
                                        <text x={10} y={52} className="fl-measure-tiprow">
                                            P2 ({fmt(p2.x)}, {fmt(p2.y)}) {UNIT_LABEL[unit]}
                                        </text>
                                        <text x={10} y={66} className="fl-measure-tiprow">
                                            Δx {fmt(dx_mm)}  Δy {fmt(dy_mm)} {UNIT_LABEL[unit]}
                                        </text>
                                        <text x={10} y={80} className="fl-measure-tiprow">
                                            Length {fmt(len_mm)} {UNIT_LABEL[unit]}
                                        </text>
                                        <text x={10} y={94} className="fl-measure-tiprow">
                                            Angle {ang_deg.toFixed(2)}°
                                        </text>
                                    </g>
                                </g>
                            );
                        })()}
                        {/* Streamlines — above the heatmap, under the geometry so
                             walls always sit on top and read as the domain boundary. */}
                        {streamlines.length > 0 && (
                            <g className="fl-streamlines">
                                {streamlines.map((line, li) => {
                                    const d = line.map((p, i) => {
                                        const s = toScreen(p);
                                        return `${i === 0 ? 'M' : 'L'}${s.x.toFixed(1)},${s.y.toFixed(1)}`;
                                    }).join(' ');
                                    return <path key={li} d={d} className="fl-streamline" />;
                                })}
                            </g>
                        )}
                        {/* Section probe lines (rendered above the heatmap + geometry).
                             Each section now has its own colour + selection
                             highlight; invisible sections are hidden. */}
                        {sections.filter((s) => s.visible !== false).map((s) => {
                            const sa = toScreen(s.points[0]);
                            const sb = toScreen(s.points[1]);
                            const isSelected = s.id === selectedSectionId;
                            const color = s.color || SECTION_COLORS[0];
                            return (
                                <g
                                    key={s.id}
                                    className={`fl-section ${isSelected ? 'is-selected' : ''}`}
                                    onClick={() => setSelectedSectionId(s.id)}
                                    style={{ cursor: 'pointer' }}
                                >
                                    <line
                                        x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y}
                                        className="fl-section-line"
                                        stroke={color}
                                        strokeWidth={isSelected ? 2.75 : 1.75}
                                    />
                                    <circle cx={sa.x} cy={sa.y} r={isSelected ? 5 : 4}
                                        className="fl-section-end" fill={color} />
                                    <circle cx={sb.x} cy={sb.y} r={isSelected ? 5 : 4}
                                        className="fl-section-end" fill={color} />
                                    {/* Label near midpoint */}
                                    <text
                                        x={(sa.x + sb.x) / 2}
                                        y={(sa.y + sb.y) / 2 - 6}
                                        className="fl-section-label"
                                        fill={color}
                                        textAnchor="middle"
                                    >{s.label || s.id}</text>
                                </g>
                            );
                        })}
                        {sectionDrag && (() => {
                            const sa = toScreen({ x: sectionDrag.x0, y: sectionDrag.y0 });
                            const sb = toScreen({ x: sectionDrag.x1, y: sectionDrag.y1 });
                            return (
                                <g className="fl-section is-preview">
                                    <line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} className="fl-section-line" />
                                </g>
                            );
                        })()}
                        {/* Point probes — rendered above the heatmap / geometry
                             so the user can always see where they've dropped
                             them. Each dot is a mini-target: outer ring +
                             filled core + numeric label. Click the × to
                             remove (the X appears inline; visible at all
                             sizes, keeps touch-devices usable). */}
                        {pointProbes.map((pp) => {
                            const s = toScreen({ x: pp.x_mm, y: pp.y_mm });
                            return (
                                <g key={pp.id} className="fl-point-probe" style={{ pointerEvents: 'auto' }}>
                                    <circle cx={s.x} cy={s.y} r={7} className="fl-probe-ring" stroke={pp.color} />
                                    <circle cx={s.x} cy={s.y} r={3} className="fl-probe-core" fill={pp.color} />
                                    <text x={s.x + 9} y={s.y - 7} className="fl-probe-label" fill={pp.color}>
                                        {pp.label}
                                    </text>
                                    <g
                                        transform={`translate(${s.x + 9}, ${s.y + 2})`}
                                        style={{ cursor: 'pointer' }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setPointProbes((list) => list.filter((x) => x.id !== pp.id));
                                            if (sensorHistoryRef.current) {
                                                const k = `P:${pp.id}`;
                                                if (sensorHistoryRef.current[k]) {
                                                    delete sensorHistoryRef.current[k];
                                                    setSensorHistory({ ...sensorHistoryRef.current });
                                                }
                                            }
                                        }}
                                    >
                                        <title>Remove this point probe</title>
                                        <rect x={-1} y={-1} width={10} height={10} rx={2} className="fl-probe-x-bg" />
                                        <path d="M1,1 L7,7 M7,1 L1,7" className="fl-probe-x" />
                                    </g>
                                </g>
                            );
                        })}
                        {/* Cursor snap glyph */}
                        {cursorWorld && (
                            <g>
                                <circle
                                    cx={toScreen(cursorWorld).x}
                                    cy={toScreen(cursorWorld).y}
                                    r={4}
                                    className="fl-snap-glyph"
                                />
                            </g>
                        )}
                    </svg>
                </div>

                {/* Right column: inspector */}
                <div className={`fl-right${showRightPanel ? '' : ' is-collapsed'}`} aria-hidden={!showRightPanel}>
                    <div className="fl-panel" data-tour-id="gas-inlet">
                        <div className="fl-panel-title">Gas & inlet</div>
                        <label className="fl-field">
                            <span>Gas</span>
                            <select value={gasId} onChange={(e) => setGasId(e.target.value)}>
                                {GAS_PRESETS.map((g) => (
                                    <option key={g.id} value={g.id}>{g.label}</option>
                                ))}
                            </select>
                        </label>
                        <div className="fl-kv">
                            <span>ρ</span>
                            <span>{gas.rho.toFixed(3)} kg/m³</span>
                        </div>
                        <div className="fl-kv">
                            <span>μ</span>
                            <span>{(gas.mu * 1e6).toFixed(2)} µPa·s</span>
                        </div>
                        <div className="fl-kv">
                            <span>ν</span>
                            <span>{(nu(gas) * 1e6).toFixed(3)} mm²/s</span>
                        </div>
                        {/* Inlet BC — toggle between raw velocity and volumetric
                            flow rate (sccm). Sccm is how gas-delivery engineers
                            actually think; velocity maps directly to the solver. */}
                        <div className="fl-bc-toggle" role="tablist" aria-label="Inlet BC type">
                            <button
                                role="tab"
                                aria-selected={inletMode === 'velocity'}
                                className={inletMode === 'velocity' ? 'is-active' : ''}
                                onClick={() => setInletMode('velocity')}
                                title="Specify inlet as velocity (m/s) — direct solver input."
                            >Velocity</button>
                            <button
                                role="tab"
                                aria-selected={inletMode === 'sccm'}
                                className={inletMode === 'sccm' ? 'is-active' : ''}
                                onClick={() => setInletMode('sccm')}
                                title="Specify inlet as volumetric flow rate (sccm = standard cm³/min). Requires channel depth + inlet width to compute velocity."
                            >sccm</button>
                        </div>
                        {inletMode === 'velocity' ? (
                            <label className="fl-field">
                                <span>Inlet U</span>
                                <div className="fl-inline">
                                    <input
                                        type="number"
                                        value={inletU_m_s}
                                        onChange={(e) => setInletU_m_s(Math.max(0, Number(e.target.value)))}
                                        step={0.01}
                                        min={0}
                                    />
                                    <span>m/s</span>
                                </div>
                            </label>
                        ) : (
                            <>
                                <label className="fl-field" title="Volumetric flow rate at standard conditions (0 °C, 1 atm). 1 sccm = 1 mL/min.">
                                    <span>Inlet Q</span>
                                    <div className="fl-inline">
                                        <input
                                            type="number"
                                            value={inletQ_sccm}
                                            onChange={(e) => setInletQ_sccm(Math.max(0, Number(e.target.value)))}
                                            step={0.1}
                                            min={0}
                                        />
                                        <span>sccm</span>
                                    </div>
                                </label>
                                <div className="fl-kv" title="Back-computed inlet velocity = Q / (inlet width × channel depth).">
                                    <span>→ U</span>
                                    <span>{effectiveInletU_m_s.toFixed(4)} m/s</span>
                                </div>
                                <div className="fl-kv fl-muted" title="Sum of lengths of all inlet-tagged edges on the active domain.">
                                    <span>inlet width</span>
                                    <span>{inletLength_mm > 0 ? formatLength(inletLength_mm, unit) : '— tag an edge as Inlet'}</span>
                                </div>
                            </>
                        )}
                        <label className="fl-field" title="Out-of-plane channel depth — the 3rd dimension the 2D sim can't see. Used for all volumetric flow / mass-flow conversions.">
                            <span>Channel depth</span>
                            <div className="fl-inline">
                                <input
                                    type="number"
                                    value={channelDepthMm}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (Number.isFinite(v) && v > 0) setChannelDepthMm(v);
                                    }}
                                    step={0.1}
                                    min={0.001}
                                />
                                <span>mm</span>
                            </div>
                        </label>
                        <div className="fl-kv">
                            <span>Char. L</span>
                            <span>{formatLength(L_mm, unit)}</span>
                        </div>
                        <div className="fl-kv fl-kv-strong" title="Reynolds number based on effective inlet velocity and characteristic length (shortest bbox side).">
                            <span>Re</span>
                            <span>{Re.toFixed(2)}</span>
                        </div>
                    </div>

                    {/* ── Species transport (aroma analyte) ──────────────
                         Dedicated panel for the passive-scalar overlay that
                         shows how an odorant pulse propagates through the
                         device and when it reaches each sensor. */}
                    <div className="fl-panel" data-tour-id="species">
                        <div className="fl-panel-title">
                            <Activity size={12} /> Species transport
                        </div>
                        <label className="fl-field fl-toggle-field" title="Run a passive-scalar advection–diffusion solver alongside the LBM so aroma analyte concentration can be visualised & probed at sensors.">
                            <span>Enable aroma pulse</span>
                            <input
                                type="checkbox"
                                checked={speciesEnabled}
                                onChange={(e) => setSpeciesEnabled(e.target.checked)}
                                disabled={running}
                            />
                        </label>
                        {speciesEnabled && (
                            <label className="fl-field fl-toggle-field" title="Overlay the concentration field on the canvas — bright / magenta where aroma is high, faded where it's empty.">
                                <span>Show overlay</span>
                                <input
                                    type="checkbox"
                                    checked={showSpeciesOverlay}
                                    onChange={(e) => setShowSpeciesOverlay(e.target.checked)}
                                />
                            </label>
                        )}
                        <label className="fl-field">
                            <span>Analyte</span>
                            <select
                                value={analyteId}
                                onChange={(e) => setAnalyteId(e.target.value)}
                                disabled={running}
                            >
                                {ANALYTE_PRESETS.map((a) => (
                                    <option key={a.id} value={a.id}>{a.label}</option>
                                ))}
                            </select>
                        </label>
                        <label
                            className="fl-field"
                            title="Sample / carrier temperature in °C. The tabulated D_AB at 25 °C is rescaled by (T/298.15)^1.75 (Fuller-Schettler-Giddings). Higher T → faster diffusion, lower Sc, lower Pe."
                        >
                            <span>Sample T</span>
                            <div className="fl-inline">
                                <input
                                    type="number"
                                    value={analyteT_C}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (Number.isFinite(v)) setAnalyteT_C(v);
                                    }}
                                    step={1}
                                    min={-20}
                                    max={200}
                                    disabled={running}
                                />
                                <span>°C</span>
                            </div>
                        </label>
                        <label
                            className="fl-field"
                            title="Relative humidity of the sample (0–100 %). Stored as metadata and exported in the sensor CSV header. Its effect on gas-phase D is a few percent and is ignored by the solver; it matters chiefly for sensor surface chemistry (e.g. NO₂ + H₂O → HNO₃) and for breath / food headspace realism."
                        >
                            <span>Humidity</span>
                            <div className="fl-inline">
                                <input
                                    type="number"
                                    value={analyteRH_pct}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (Number.isFinite(v)) setAnalyteRH_pct(Math.max(0, Math.min(100, v)));
                                    }}
                                    step={5}
                                    min={0}
                                    max={100}
                                    disabled={running}
                                />
                                <span>% RH</span>
                            </div>
                        </label>
                        {analyteId === 'custom' && (
                            <label className="fl-field" title="Binary gas-phase diffusivity D_AB (m²/s).">
                                <span>D custom</span>
                                <div className="fl-inline">
                                    <input
                                        type="number"
                                        value={customD_m2s}
                                        onChange={(e) => {
                                            const v = Number(e.target.value);
                                            if (Number.isFinite(v) && v > 0) setCustomD_m2s(v);
                                        }}
                                        step={1e-6}
                                        min={1e-8}
                                    />
                                    <span>m²/s</span>
                                </div>
                            </label>
                        )}
                        <div
                            className="fl-kv"
                            title={`Effective gas-phase diffusivity at T = ${Number(analyteT_C).toFixed(1)} °C. Reference D at 25 °C = ${D_ref_m2s.toExponential(2)} m²/s, scaled by (T/298.15)^1.75 = ${(D_m2s / Math.max(1e-30, D_ref_m2s)).toFixed(3)}×.`}
                        >
                            <span>D @ T</span>
                            <span>{D_m2s.toExponential(2)} m²/s</span>
                        </div>
                        <div className="fl-kv" title="Schmidt number Sc = ν / D. ≈ 1 for gas-phase aromas → momentum & species diffuse at comparable rates.">
                            <span>Sc</span>
                            <span>{Number.isFinite(Sc) ? Sc.toFixed(2) : '—'}</span>
                        </div>
                        <div className="fl-kv fl-kv-strong" title="Péclet number Pe = U·L / D. Pe ≫ 1 → advection dominates (sharp fronts). Pe ≪ 1 → diffusion smears them out.">
                            <span>Pe</span>
                            <span>{Number.isFinite(Pe) ? Pe.toExponential(2) : '—'}</span>
                        </div>
                        <div className="fl-kv" title="Diffusive timescale τ_diff = L² / D — how long pure diffusion alone would take to cross the device.">
                            <span>τ diff</span>
                            <span>{Number.isFinite(tauDiff_s) ? `${tauDiff_s.toPrecision(3)} s` : '—'}</span>
                        </div>
                        <div className="fl-kv" title="Convective (residence) timescale τ_conv = L / U — how long the bulk flow takes to cross the device.">
                            <span>τ flow</span>
                            <span>{Number.isFinite(tauFlow_s) ? `${tauFlow_s.toPrecision(3)} s` : '—'}</span>
                        </div>

                        {speciesEnabled && (
                            <>
                                <div className="fl-subhd">Inlet pulse profile</div>
                                <label className="fl-field">
                                    <span>Profile</span>
                                    <select
                                        value={pulseId}
                                        onChange={(e) => {
                                            const id = e.target.value;
                                            setPulseId(id);
                                            // Seed with the default params whenever the
                                            // user picks a different profile, so every
                                            // field the new profile cares about has a
                                            // starting value.
                                            setPulseParams(Object.fromEntries(
                                                pulseProfileById(id).params.map((p) => [p.id, p.default])
                                            ));
                                        }}
                                        disabled={running}
                                    >
                                        {PULSE_PROFILES.map((p) => (
                                            <option key={p.id} value={p.id}>{p.label}</option>
                                        ))}
                                    </select>
                                </label>
                                <div className="fl-muted fl-pulse-desc">
                                    {pulseProfileById(pulseId).description}
                                </div>
                                {pulseProfileById(pulseId).params.map((p) => (
                                    <label key={p.id} className="fl-field fl-field-inset">
                                        <span>{p.label}</span>
                                        <input
                                            type="number"
                                            value={pulseParams[p.id] ?? p.default}
                                            onChange={(e) => {
                                                const v = Number(e.target.value);
                                                if (Number.isFinite(v)) {
                                                    setPulseParams((pp) => ({ ...pp, [p.id]: v }));
                                                }
                                            }}
                                            step={p.step}
                                            min={p.min}
                                            disabled={running}
                                        />
                                    </label>
                                ))}
                                <div className="fl-muted fl-hint">
                                    Pulse settings apply to the <b>next</b> run — press <b>Reset</b> then <b>Run</b> after editing.
                                </div>
                            </>
                        )}
                    </div>

                    <div className="fl-panel">
                        <div className="fl-panel-title">Solver mesh</div>
                        <div className="fl-mesh-presets">
                            {MESH_PRESETS.map((p) => (
                                <button key={p.id}
                                    className={`fl-mesh-preset${meshLongAxis === p.n ? ' is-active' : ''}`}
                                    onClick={() => setMeshLongAxis(p.n)}
                                    title={`${p.n} cells along the long axis — ${p.hint}`}
                                    disabled={running}
                                >
                                    <span className="fl-mesh-preset-label">{p.label}</span>
                                    <span className="fl-mesh-preset-n">{p.n}</span>
                                </button>
                            ))}
                        </div>
                        <label className="fl-field fl-field-inset" title="Number of lattice cells along the longest side of the bounding box. Higher = sharper walls & thinner features, but quadratically more memory / slower.">
                            <span>Long-axis cells</span>
                            <div className="fl-inline">
                                <input
                                    type="number"
                                    min={MIN_MESH_LONG_AXIS}
                                    max={MAX_MESH_LONG_AXIS}
                                    step={10}
                                    value={meshLongAxis}
                                    onChange={(e) => {
                                        const v = Math.round(Number(e.target.value));
                                        if (Number.isFinite(v)) {
                                            setMeshLongAxis(Math.max(MIN_MESH_LONG_AXIS, Math.min(MAX_MESH_LONG_AXIS, v)));
                                        }
                                    }}
                                    disabled={running}
                                />
                                <span>cells</span>
                            </div>
                        </label>
                        {meshPreview ? (
                            <>
                                <div className="fl-kv">
                                    <span>Estimated grid</span>
                                    <span>{meshPreview.nx} × {meshPreview.ny}</span>
                                </div>
                                <div className="fl-kv">
                                    <span>Total cells</span>
                                    <span>{meshPreview.total.toLocaleString()}</span>
                                </div>
                                <div className="fl-kv fl-kv-strong">
                                    <span>Cell size Δx</span>
                                    <span>{formatLength(meshPreview.dx_mm, unit)}</span>
                                </div>
                            </>
                        ) : (
                            <div className="fl-muted">Close a region (rectangle / circle / polygon) to preview cell size.</div>
                        )}
                        {running && (
                            <div className="fl-muted fl-mesh-note">
                                Pause / Reset the solver to change mesh resolution — it rebuilds the lattice on the next <b>Run</b>.
                            </div>
                        )}
                        <div className="fl-subhd" style={{ marginTop: 10 }}>Run duration</div>
                        <label
                            className="fl-field fl-field-inset"
                            title="Optional target simulation time in seconds of physical time. When set, the solver keeps marching past steady state and auto-pauses once this is reached. Leave blank to keep the default behaviour (auto-pause on steady-state convergence)."
                        >
                            <span>Sim time</span>
                            <div className="fl-inline">
                                <input
                                    type="number"
                                    min={0}
                                    step={0.1}
                                    placeholder="auto (steady)"
                                    value={simDurationS}
                                    onChange={(e) => setSimDurationS(e.target.value)}
                                />
                                <span>s</span>
                            </div>
                        </label>
                        <div className="fl-muted" style={{ fontSize: 11, marginTop: 4 }}>
                            {simDurationNum != null
                                ? <>Auto-pause at <b>t = {simDurationNum.toFixed(3)} s</b>. Steady-state auto-pause disabled while a duration is set.</>
                                : <>Blank → auto-pause when steady state is detected. Enter a value (e.g. <b>5</b>) to keep marching for a fixed physical time.</>}
                        </div>
                    </div>

                    <div className="fl-panel">
                        <div className="fl-panel-title">Properties</div>
                        {!selectedEntity && (
                            <div className="fl-muted">Pick the <b>Select</b> tool and click a vertex, an edge, or an entity to edit dimensions.</div>
                        )}
                        {selectedEntity && selection?.vertexIdx != null && (
                            <VertexEditor
                                key={`${selectedEntity.id}-v${selection.vertexIdx}`}
                                entity={selectedEntity}
                                vertexIdx={selection.vertexIdx}
                                unit={unit}
                                onChange={(x_mm, y_mm) => setVertexPosition(selectedEntity.id, selection.vertexIdx, x_mm, y_mm)}
                            />
                        )}
                        {selectedEntity && selection?.edgeIdx != null && (
                            <>
                                <EdgeEditor
                                    key={`${selectedEntity.id}-e${selection.edgeIdx}`}
                                    entity={selectedEntity}
                                    edgeIdx={selection.edgeIdx}
                                    unit={unit}
                                    onSetStart={(x_mm, y_mm) => setVertexPosition(selectedEntity.id, selection.edgeIdx, x_mm, y_mm)}
                                    onSetEnd={(x_mm, y_mm) => setVertexPosition(selectedEntity.id, (selection.edgeIdx + 1) % selectedEntity.points.length, x_mm, y_mm)}
                                    onSetLength={(L_mm) => setEdgeLength(selectedEntity.id, selection.edgeIdx, L_mm)}
                                    onSetAngle={(deg) => setEdgeAngle(selectedEntity.id, selection.edgeIdx, deg)}
                                />
                                {selectedEdgeBC && (
                                    <label className="fl-field fl-field-inset">
                                        <span>BC type</span>
                                        <select value={selectedEdgeBC.type}
                                            onChange={(e) => updateSelectedEdgeBC({ type: e.target.value })}>
                                            {BC_TYPES.map((t) => (
                                                <option key={t.id} value={t.id}>{t.label}</option>
                                            ))}
                                        </select>
                                    </label>
                                )}
                            </>
                        )}
                        {selectedEntity && selection?.edgeIdx == null && selection?.vertexIdx == null && (
                            <EntityInfo entity={selectedEntity} unit={unit} />
                        )}
                    </div>

                    <div className="fl-panel" data-tour-id="section">
                        <div className="fl-panel-title">Post-sim analysis</div>
                        {sections.length === 0 ? (
                            <div className="fl-muted">Pick the <b>Section</b> tool and drag a line across the channel. You can add more sections — one per drag.</div>
                        ) : !field ? (
                            <div className="fl-muted">Press <b>Run</b> to start the simulation — profiles fill in live.</div>
                        ) : (
                            <>
                                <label className="fl-field fl-field-inset">
                                    <span>Quantity to plot</span>
                                    <select value={profileQuantity}
                                        onChange={(e) => setProfileQuantity(e.target.value)}>
                                        {PROFILE_QUANTITIES.map((q) => (
                                            <option key={q.id} value={q.id}>{q.label} ({q.unit})</option>
                                        ))}
                                    </select>
                                </label>
                                <label className="fl-field fl-field-inset" title="Assumed out-of-plane depth (the third dimension the 2D sim can't see). Used to convert flux to volumetric flow rate.">
                                    <span>Channel depth (mm)</span>
                                    <input
                                        type="number"
                                        min={0.001}
                                        step={0.1}
                                        value={channelDepthMm}
                                        onChange={(e) => {
                                            const v = Number(e.target.value);
                                            if (Number.isFinite(v) && v > 0) setChannelDepthMm(v);
                                        }}
                                    />
                                </label>

                                <MultiProfileChart
                                    sectionProfiles={sectionProfiles}
                                    quantity={profileQuantity}
                                    selectedId={selectedSectionId}
                                />

                                <div className="fl-section-list">
                                    {sectionProfiles.map(({ section, ok, stats }) => (
                                        <SectionRow
                                            key={section.id}
                                            section={section}
                                            stats={ok ? stats : null}
                                            selected={section.id === selectedSectionId}
                                            onSelect={() => setSelectedSectionId(section.id)}
                                            onToggleVisible={() => setSections((ss) =>
                                                ss.map((s) => s.id === section.id
                                                    ? { ...s, visible: s.visible === false ? true : false }
                                                    : s))}
                                            onRename={(label) => setSections((ss) =>
                                                ss.map((s) => s.id === section.id ? { ...s, label } : s))}
                                            onDelete={() => {
                                                setSections((ss) => ss.filter((s) => s.id !== section.id));
                                                if (selectedSectionId === section.id) setSelectedSectionId(null);
                                            }}
                                            onExportCsv={() => exportSectionCsv(section)}
                                        />
                                    ))}
                                    {sections.length === 0 && (
                                        <div className="fl-muted">No sections yet.</div>
                                    )}
                                </div>

                                {/* Detailed stats for the currently-selected section. */}
                                {(() => {
                                    const chosen = sectionProfiles.find((p) => p.section.id === selectedSectionId) || sectionProfiles[0];
                                    if (!chosen?.ok) return null;
                                    const { section, stats } = chosen;
                                    return (
                                        <div className="fl-section-stats">
                                            <div className="fl-section-stats-hd">
                                                <span className="fl-section-chip" style={{ background: section.color }} />
                                                {section.label}
                                            </div>
                                            <div className="fl-kv"><span>peak |u|</span><span>{stats.peak_mps.toFixed(4)} m/s</span></div>
                                            <div className="fl-kv"><span>mean |u|</span><span>{stats.mean_mps.toFixed(4)} m/s</span></div>
                                            <div className="fl-kv"><span>σ |u|</span><span>{stats.std_mps.toFixed(4)} m/s</span></div>
                                            <div className="fl-kv" title="Uniformity index = 1 − σ/mean. 1 = perfectly uniform.">
                                                <span>uniformity</span><span>{(stats.uniformity * 100).toFixed(1)} %</span>
                                            </div>
                                            <div className="fl-kv" title="∫ (u·n) ds — volumetric flux per metre of out-of-plane depth.">
                                                <span>flux (per m depth)</span>
                                                <span>{Math.abs(stats.flux_m2ps).toExponential(2)} m²/s</span>
                                            </div>
                                            <div className="fl-kv fl-kv-strong" title={`Volumetric flow rate assuming depth = ${channelDepthMm} mm.`}>
                                                <span>Q (flow rate)</span>
                                                <span>{formatFlowRate(stats.volFlow_m3ps)}</span>
                                            </div>
                                            <div className="fl-kv" title="Re based on mean |u| across this section and the section length.">
                                                <span>Re (section)</span><span>{stats.Re_local.toFixed(2)}</span>
                                            </div>
                                        </div>
                                    );
                                })()}
                            </>
                        )}
                    </div>

                    {/* ── Flow rate vs time ─────────────────────────────── */}
                    <div className="fl-panel" data-tour-id="flowrate">
                        <div className="fl-panel-title">
                            <TrendingDown size={12} /> Flow rate vs time
                            {steadyIter != null && (
                                <span className="fl-steady-badge" title={`Steady state reached at iter ${steadyIter}`}>
                                    <CheckCircle2 size={11} /> Steady
                                </span>
                            )}
                        </div>
                        {sections.length === 0 ? (
                            <div className="fl-muted">Draw at least one section probe to record transient flow rates.</div>
                        ) : (
                            <>
                                <label className="fl-field">
                                    <span>Quantity</span>
                                    <select value={transientQuantity} onChange={(e) => setTransientQuantity(e.target.value)}>
                                        {TIME_QUANTITIES.map((q) => (
                                            <option key={q.id} value={q.id}>{q.label} ({q.unit})</option>
                                        ))}
                                    </select>
                                </label>
                                <FlowRateTimeChart
                                    history={timeHistory}
                                    sections={sections}
                                    selectedId={selectedSectionId}
                                    quantityKey={TIME_QUANTITY_BY_ID[transientQuantity]?.key || 'Q_mlpm'}
                                    unitLabel={TIME_QUANTITY_BY_ID[transientQuantity]?.unit || 'mL/min'}
                                    steadyIter={steadyIter}
                                />
                                <div className="fl-kv">
                                    <span>samples</span>
                                    <span>{timeHistory.length}</span>
                                </div>
                                {timeHistory.length > 0 && (
                                    <div className="fl-kv" title="Physical time span covered by the current recording.">
                                        <span>elapsed</span>
                                        <span>
                                            {(() => {
                                                const t = timeHistory[timeHistory.length - 1].t_s
                                                        - timeHistory[0].t_s;
                                                if (!Number.isFinite(t) || t <= 0) return '—';
                                                return t >= 1 ? `${t.toFixed(3)} s` : `${(t * 1e3).toFixed(2)} ms`;
                                            })()}
                                        </span>
                                    </div>
                                )}
                                {/* Steady-state summary table — one row per visible
                                    section with the final Q + mean |u| + Re. Pulls
                                    straight from `sectionProfiles`, so if the user
                                    hasn't hit steady yet it shows the latest snap-
                                    shot (labelled so they're not misled). */}
                                {sectionProfiles.length > 0 && (
                                    <div className="fl-tht-summary">
                                        <div className="fl-tht-summary-hd">
                                            {steadyIter != null ? 'Steady-state values' : 'Latest values (not yet steady)'}
                                        </div>
                                        <table className="fl-tht-table">
                                            <thead>
                                                <tr>
                                                    <th>Section</th>
                                                    <th title="Mean velocity magnitude across the section">ū (m/s)</th>
                                                    <th title="Volumetric flow rate">Q (mL/min)</th>
                                                    <th title="Local Reynolds number">Re</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {sectionProfiles.filter((p) => p.ok && p.section.visible !== false).map((p) => (
                                                    <tr key={p.section.id}
                                                        className={p.section.id === selectedSectionId ? 'is-selected' : ''}
                                                        onClick={() => setSelectedSectionId(p.section.id)}>
                                                        <td>
                                                            <span className="fl-section-chip" style={{ background: p.section.color }} />
                                                            {p.section.label || p.section.id}
                                                        </td>
                                                        <td>{p.stats.mean_mps.toFixed(4)}</td>
                                                        <td>{p.stats.volFlow_mlpm.toFixed(3)}</td>
                                                        <td>{p.stats.Re_local.toFixed(1)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                                <div className="fl-tht-actions">
                                    <button className="fl-toolbtn"
                                        onClick={exportTimeHistoryCsv}
                                        disabled={!timeHistory.length}
                                        title="Download Q(t), mean, peak, flux per section as a wide-format CSV"
                                        type="button">
                                        <Save size={12} /> Q(t) CSV
                                    </button>
                                    <button className="fl-toolbtn"
                                        onClick={exportSteadyStateCsv}
                                        disabled={!sectionProfiles.length}
                                        title="Download one summary row per section at the current (or steady-state) field"
                                        type="button">
                                        <Save size={12} /> Summary CSV
                                    </button>
                                    <button className="fl-toolbtn"
                                        onClick={() => {
                                            timeHistoryRef.current = [];
                                            setTimeHistory([]);
                                            lastRecordedIterRef.current = -1;
                                        }}
                                        disabled={!timeHistory.length}
                                        title="Discard the recorded time history (keeps the current field)"
                                        type="button">
                                        Clear
                                    </button>
                                </div>
                            </>
                        )}
                    </div>

                    {/* ── Sensor response (c(t) + metrics) ──────────────────
                         Live plot of concentration and velocity at every
                         wall edge tagged as "Sensor". Shows classic response
                         metrics (t10/t50/t90, FWHM, AUC) as soon as c(t)
                         has crossed the relevant thresholds. */}
                    <div className="fl-panel" data-tour-id="sensor">
                        <div className="fl-panel-title">
                            <Activity size={12} /> Sensor response
                        </div>
                        <SensorResponsePanel
                            sensorHistory={sensorHistory}
                            speciesEnabled={speciesEnabled}
                            solverInfo={solverInfo}
                            entities={entities}
                            sensorMetrics={sensorMetrics}
                            pointProbes={pointProbes}
                            running={running}
                            effectiveInletU={effectiveInletU_m_s}
                            tauFlow_s={tauFlow_s}
                            cInletNow={field?.cInletValue}
                            cMaxFluid={field?.cMaxFluid}
                            onRemoveProbe={(id) => {
                                setPointProbes((list) => list.filter((pp) => pp.id !== id));
                                const k = `P:${id}`;
                                if (sensorHistoryRef.current?.[k]) {
                                    delete sensorHistoryRef.current[k];
                                    setSensorHistory({ ...sensorHistoryRef.current });
                                }
                            }}
                            onExportCsv={exportSensorCsv}
                            onVisualize={() => setVisualizerOpen(true)}
                            onSaveToWorkspace={handleSaveAllGraphsToWorkspace}
                            onClearHistory={() => {
                                sensorHistoryRef.current = {};
                                setSensorHistory({});
                            }}
                        />
                    </div>

                    <div className="fl-panel">
                        <div className="fl-panel-title">
                            <TrendingDown size={12} /> Convergence
                            {steadyReached && (
                                <span className="fl-steady-badge" title="Last 8 residual posts all below 1e-4">
                                    <CheckCircle2 size={11} /> Steady
                                </span>
                            )}
                        </div>
                        {residualHistory.length < 2 ? (
                            <div className="fl-muted">Residual trace appears once the simulation is running.</div>
                        ) : (
                            <ResidualChart history={residualHistory} threshold={STEADY_THRESHOLD} />
                        )}
                    </div>

                    <div className="fl-panel">
                        <div className="fl-panel-title">Visualization</div>
                        <label className="fl-field">
                            <span>Colormap</span>
                            <select value={colormap} onChange={(e) => setColormap(e.target.value)}>
                                {COLORMAP_NAMES.map((n) => (
                                    <option key={n} value={n}>{n}</option>
                                ))}
                            </select>
                        </label>
                        <label className="fl-checkbox">
                            <input type="checkbox" checked={showStreamlines}
                                onChange={(e) => setShowStreamlines(e.target.checked)} />
                            <span>Streamlines overlay</span>
                        </label>
                        {displayStats && (
                            <>
                                <div className="fl-kv">
                                    <span>color range</span>
                                    <span>0 → {(displayStats.p95 * latticeToMps).toFixed(3)} m/s</span>
                                </div>
                                <div className="fl-kv" title="95% of fluid cells have |u| below this value; the heatmap saturates above it.">
                                    <span>clipping</span>
                                    <span>p95</span>
                                </div>
                            </>
                        )}
                        <button className="fl-toolbtn" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
                            onClick={() => { setEntities([DEFAULT_DOMAIN()]); setSections([DEFAULT_SECTION()]); fitToContent(); }}
                            title="Restore the default 20 × 5 mm example channel">
                            Reload example
                        </button>
                        <button className="fl-toolbtn" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
                            onClick={() => {
                                /* One-click aroma demo: dog-bone geometry with
                                   filleted corners, two sensor strips, mid-
                                   chamber probe line, physical units in sccm,
                                   species ON with a rectangular NO₂ pulse at
                                   25 °C / 40 % RH. Pulse timings match the
                                   app-wide defaults (0.2 s pre-roll + 1 s
                                   exposure ≈ one residence time).
                                   Press Run immediately after clicking. */
                                setEntities([AROMA_CHAMBER_DOMAIN()]);
                                setSections([AROMA_CHAMBER_SECTION()]);
                                setSelectedSectionId('s_aroma_mid');
                                setInletMode('sccm');
                                setInletQ_sccm(20);
                                setChannelDepthMm(1);
                                setSpeciesEnabled(true);
                                setShowSpeciesOverlay(false);
                                setAnalyteId('no2');
                                setAnalyteT_C(25);
                                setAnalyteRH_pct(40);
                                setPulseId('rect');
                                setPulseParams({ t_start: 0.2, t_dur: 1.0 });
                                fitToContent();
                                // Kick off the guided tour — only this
                                // one entry point starts it, so normal
                                // use of the app is never interrupted.
                                setTourIdx(0);
                            }}
                            title="Dog-bone aroma chamber (1 cm × 1 cm chamber, 1 cm × 0.2 cm channels) with filleted corners, two sensors, rectangular NO₂ pulse at 25 °C / 40 % RH — ready to Run.">
                            Load aroma demo
                        </button>
                    </div>
                </div>
            </div>

            {/* ─── Status bar ─── */}
            <div className="fl-status">
                <span>
                    cursor: {cursorWorld
                        ? `${formatLength(cursorWorld.x, unit)}, ${formatLength(cursorWorld.y, unit)}`
                        : '—'}
                </span>
                <span className="fl-sep-v" />
                <span>grid: {formatLength(gridStepMm, unit)}</span>
                <span className="fl-sep-v" />
                <span>zoom: {viewport.pxPerMm.toFixed(1)} px/{UNIT_LABEL.mm}</span>
                <span className="fl-sep-v" />
                {solverInfo && (
                    <>
                        <span>grid {solverInfo.nx}×{solverInfo.ny}</span>
                        <span className="fl-sep-v" />
                        <span>τ={solverInfo.tau.toFixed(3)}</span>
                        <span className="fl-sep-v" />
                    </>
                )}
                {field && (
                    <>
                        <span>iter {field.iter}</span>
                        <span className="fl-sep-v" />
                        <span>resid {field.residual.toExponential(2)}</span>
                        <span className="fl-sep-v" />
                        <span>|u|max {(field.umax * latticeToMps).toFixed(4)} m/s</span>
                        {displayStats && (
                            <>
                                <span className="fl-sep-v" />
                                <span>p95 {(displayStats.p95 * latticeToMps).toFixed(4)} m/s</span>
                            </>
                        )}
                        {solverInfo && (
                            <>
                                <span className="fl-sep-v" />
                                <span title="Simulated physical time">t = {(field.iter * solverInfo.dt_s * 1000).toFixed(3)} ms</span>
                            </>
                        )}
                        <span className="fl-sep-v" />
                        {deadVolumePct != null && (
                            <span>dead zone: {deadVolumePct.toFixed(1)}%</span>
                        )}
                    </>
                )}
                {steadyReached && (
                    <span className="fl-steady-status" title="Last 8 residual posts all below 1e-4">
                        <CheckCircle2 size={12} /> steady state reached
                    </span>
                )}
                {solverWarning && <span className="fl-warn">⚠ {solverWarning}</span>}
            </div>

            {/* ── Floating property dialog (SolidWorks-style PM) ──
                Shown only in Select mode, portal'd to body so it
                escapes the canvas-wrap overflow clip and floats above
                everything. Draggable by its header. */}
            <FloatingPropertyDialog
                visible={tool === TOOLS.SELECT && selectedEntity && !propDialogDismissed && propAnchorWorld}
                canvasWrapRef={canvasWrapRef}
                anchorWorld={propAnchorWorld}
                toScreen={toScreen}
                userPos={propDialogUserPos}
                onDrag={(next) => setPropDialogUserPos(next)}
                onClose={() => setPropDialogDismissed(true)}
                title={
                    selection?.vertexIdx != null ? `Vertex #${selection.vertexIdx}`
                    : selection?.edgeIdx != null ? `Edge #${selection.edgeIdx}`
                    : selectedEntity?.closed === false ? 'Open polyline'
                    : 'Region'
                }
            >
                {selectedEntity && selection?.vertexIdx != null && (
                    <VertexEditor
                        key={`pd-${selectedEntity.id}-v${selection.vertexIdx}`}
                        entity={selectedEntity}
                        vertexIdx={selection.vertexIdx}
                        unit={unit}
                        onChange={(x_mm, y_mm) => setVertexPosition(selectedEntity.id, selection.vertexIdx, x_mm, y_mm)}
                    />
                )}
                {selectedEntity && selection?.edgeIdx != null && (
                    <>
                        <EdgeEditor
                            key={`pd-${selectedEntity.id}-e${selection.edgeIdx}`}
                            entity={selectedEntity}
                            edgeIdx={selection.edgeIdx}
                            unit={unit}
                            onSetStart={(x_mm, y_mm) => setVertexPosition(selectedEntity.id, selection.edgeIdx, x_mm, y_mm)}
                            onSetEnd={(x_mm, y_mm) => setVertexPosition(selectedEntity.id, (selection.edgeIdx + 1) % selectedEntity.points.length, x_mm, y_mm)}
                            onSetLength={(L_mm) => setEdgeLength(selectedEntity.id, selection.edgeIdx, L_mm)}
                            onSetAngle={(deg) => setEdgeAngle(selectedEntity.id, selection.edgeIdx, deg)}
                        />
                        {selectedEdgeBC && (
                            <label className="fl-field fl-field-inset">
                                <span>BC type</span>
                                <select value={selectedEdgeBC.type}
                                    onChange={(e) => updateSelectedEdgeBC({ type: e.target.value })}>
                                    {BC_TYPES.map((t) => (
                                        <option key={t.id} value={t.id}>{t.label}</option>
                                    ))}
                                </select>
                            </label>
                        )}
                    </>
                )}
                {selectedEntity && selection?.edgeIdx == null && selection?.vertexIdx == null && (
                    <EntityInfo entity={selectedEntity} unit={unit} />
                )}
            </FloatingPropertyDialog>

            {visualizerOpen && (
                <DataVisualizerModal
                    sensorHistory={sensorHistory}
                    speciesEnabled={speciesEnabled}
                    onClose={() => setVisualizerOpen(false)}
                />
            )}

            {/* ─── Flow Lab file manager modal ─── */}
            {explorerOpen && (
                <FileExplorerModal
                    tree={fileTree}
                    cwd={explorerCwd}
                    onCwdChange={setExplorerCwd}
                    expanded={explorerExpanded}
                    onExpandedChange={setExplorerExpanded}
                    allFolderPaths={allFolderPaths}
                    currentOpenFileId={currentProjectFileId}
                    onClose={() => setExplorerOpen(false)}
                    onOpenFile={(file) => {
                        handleOpenFile(file);
                        setExplorerOpen(false);
                    }}
                    onCreateFolder={handleCreateFolder}
                    onRenameItem={handleRenameTreeItem}
                    onDeleteItem={handleDeleteTreeItem}
                    onMoveFile={handleMoveFile}
                    onSaveProjectHere={(dir) => {
                        handleSaveAsProject({ dir });
                        setExplorerOpen(false);
                    }}
                    onSaveResultHere={(dir) => {
                        handleSaveResult({ dir });
                        setExplorerOpen(false);
                    }}
                    hasField={!!field}
                />
            )}
        </div>
    );
};

const ToolButton = ({ active, onClick, title, icon, label }) => (
    <button
        className={`fl-toolbtn${active ? ' is-active' : ''}`}
        onClick={onClick}
        title={title}
        type="button"
    >
        {icon}<span>{label}</span>
    </button>
);

const EntitySvg = ({ entity, toScreen, selected, selectedEdgeIdx, selectedVertexIdx, isPreview, multiSelected }) => {
    const pts = entity.points;
    if (pts.length < 1) return null;
    const isClosed = entity.closed !== false; // legacy entities w/o flag treated as closed
    const pathD = pts.map((p, i) => {
        const s = toScreen(p);
        return `${i === 0 ? 'M' : 'L'}${s.x.toFixed(1)},${s.y.toFixed(1)}`;
    }).join(' ') + (isClosed && pts.length > 2 && !isPreview ? ' Z' : '');

    // For open polylines we only draw n-1 edges and never the wrap. Also
    // no fill — purely stroke construction geometry.
    const nEdges = isClosed ? pts.length : Math.max(0, pts.length - 1);

    return (
        <g className={`fl-entity ${selected ? 'is-sel' : ''} ${multiSelected ? 'is-multi-sel' : ''} ${isPreview ? 'is-preview' : ''} ${isClosed ? '' : 'is-open'}`}>
            {isClosed && <path d={pathD} className="fl-entity-fill" />}
            {Array.from({ length: nEdges }).map((_, i) => {
                if (isPreview && isClosed === false && i === nEdges - 1) {
                    // For open-line previews the final segment trails to the
                    // cursor — still show it but with a different class.
                }
                if (isPreview && isClosed && i === nEdges - 1) return null;
                const a = pts[i];
                const b = pts[(i + 1) % pts.length];
                if (!b) return null;
                const sa = toScreen(a);
                const sb = toScreen(b);
                const bc = entity.edgeBC?.[i] || { type: 'wall' };
                const baseCls = isClosed ? `fl-edge fl-edge-${bc.type}` : 'fl-edge fl-edge-open';
                const cls = `${baseCls}${selectedEdgeIdx === i ? ' is-selected' : ''}`;
                return (
                    <line key={i} x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} className={cls} />
                );
            })}
            {pts.map((p, i) => {
                if (isPreview && i === pts.length - 1) return null; // preview's last pt = cursor
                const s = toScreen(p);
                const isSel = selected && selectedVertexIdx === i;
                // When an entity is selected we enlarge every vertex so
                // they're easy to target. Otherwise a subtle dot is
                // enough not to clutter the drawing.
                const r = selected ? (isSel ? 5 : 3.5) : 2.5;
                return (
                    <circle
                        key={`v${i}`}
                        cx={s.x} cy={s.y} r={r}
                        className={`fl-vertex${isSel ? ' is-selected' : ''}${selected ? ' is-visible' : ''}`}
                    />
                );
            })}
        </g>
    );
};

/* Tiny SVG line chart for the velocity profile |u|(s).
   Width is taken from the panel (100%); height is fixed. We normalise to
   the peak of the profile itself (not the global field max) so that even
   a nearly-stagnant section still gives a readable shape. */
const ProfileChart = ({ samples }) => {
    const W = 240, H = 110;
    const padL = 28, padR = 6, padT = 8, padB = 20;
    const xs = samples.map((s) => s.s_mm);
    const ys = samples.map((s) => Number.isFinite(s.u_mps) ? s.u_mps : 0);
    const smax = xs[xs.length - 1] || 1;
    const umax = Math.max(1e-9, ...ys);
    const xPx = (s) => padL + (s / smax) * (W - padL - padR);
    const yPx = (u) => padT + (1 - u / umax) * (H - padT - padB);
    const path = samples.map((s, i) => {
        const u = Number.isFinite(s.u_mps) ? s.u_mps : 0;
        return `${i === 0 ? 'M' : 'L'}${xPx(s.s_mm).toFixed(1)},${yPx(u).toFixed(1)}`;
    }).join(' ');
    // 3 y-axis ticks: 0, umax/2, umax
    const yticks = [0, umax / 2, umax];
    return (
        <svg className="fl-profile-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
            <rect x={padL} y={padT} width={W - padL - padR} height={H - padT - padB} className="fl-chart-plot" />
            {yticks.map((v, i) => (
                <g key={i}>
                    <line x1={padL} x2={W - padR} y1={yPx(v)} y2={yPx(v)} className="fl-chart-grid" />
                    <text x={padL - 4} y={yPx(v) + 3} className="fl-chart-tick" textAnchor="end">
                        {v.toExponential(1)}
                    </text>
                </g>
            ))}
            <path d={path} className="fl-profile-line" />
            <text x={padL} y={H - 4} className="fl-chart-label">0</text>
            <text x={W - padR} y={H - 4} className="fl-chart-label" textAnchor="end">
                {smax.toFixed(2)} mm
            </text>
            <text x={W / 2} y={H - 4} className="fl-chart-label" textAnchor="middle">
                position along section
            </text>
        </svg>
    );
};

/* Format a volumetric flow rate (m³/s) in a scale that makes sense.
   Picks SI prefix so µL/min, mL/min, L/min all read naturally. */
function formatFlowRate(m3ps) {
    if (!Number.isFinite(m3ps)) return '—';
    const abs = Math.abs(m3ps);
    // Convert to mL/min for the comparison scale.
    const mlpm = m3ps * 1e6 * 60;
    const absMlpm = Math.abs(mlpm);
    if (absMlpm < 1e-3) return `${(mlpm * 1e3).toFixed(3)} µL/min`;
    if (absMlpm < 1)    return `${(mlpm * 1e3).toFixed(2)} µL/min`;
    if (absMlpm < 1000) return `${mlpm.toFixed(3)} mL/min`;
    return `${(mlpm / 1000).toFixed(3)} L/min`;
    // (abs var kept for readability but unused in the picked branch)
    // eslint-disable-next-line no-unused-expressions
    abs;
}

/* Multi-section profile overlay — plots any number of section samples
   on shared axes. The quantity (|u|, ux, uy, u·n, u·t) is provided by
   the parent via `quantity`. The chart clamps each sample through the
   QUANTITY_BY_ID[quantity].compute function so we can plot components
   cleanly (including negative values for reverse flow).

   Auto-scaling: y-range spans min..max across all visible sections so
   you can compare them like-for-like. A dashed zero line appears when
   the range crosses zero (directional quantities often do). */
/* ───────── Sensor response panel ─────────
 * Live c(t) / |u|(t) traces for every wall edge tagged as "Sensor".
 * When species transport is OFF, only |u|(t) is shown (still useful as
 * a "how much flow is actually reaching the sensor" indicator). When
 * ON, the concentration curve appears and the metrics card fills in
 * with the classical response characteristics. */
const SensorResponsePanel = ({
    sensorHistory, speciesEnabled, solverInfo, entities,
    sensorMetrics, pointProbes, onRemoveProbe,
    onExportCsv, onClearHistory, onVisualize, onSaveToWorkspace,
    running, effectiveInletU, tauFlow_s, cInletNow, cMaxFluid,
}) => {
    /* Time-axis view window. "Full" spans every sample currently in
       the store (NOT from t=0 — the store is capped, so if the first
       sample is t=8 s the x-axis starts at 8 s, otherwise the trace
       would appear to drift to the right as old data rolls off).
       Default to "Last 5 s" so short pulses (~0.2–1 s) always render
       as a visible bump rather than a compressed spike. */
    const [windowSec, setWindowSec] = useState('5');
    const keys = Object.keys(sensorHistory || {});
    // Resolve labels from the currently-running domain when possible
    // (the worker's labels were set at rasterization time and should
    // already match, but this is a belt-and-braces fallback).
    const domain = entities.find((e) => e.closed !== false) || entities[0];
    const sensorEdges = (solverInfo?.sensorEdges) || [];
    const probeList = Array.isArray(pointProbes) ? pointProbes : [];
    const probeCount = probeList.length;

    /* Extract pulse start / end times from solverInfo so we can draw
       vertical markers and a shaded pulse window on the c(t) chart.
       These come from whatever profile was active at Run time (even if
       the user edits them mid-run, the snapshot inside solverInfo is
       the authoritative truth for what the worker is using). */
    const pulseId = solverInfo?.pulseId;
    const pulseParams = solverInfo?.pulseParams;
    let tPulseOn = null, tPulseOff = null;
    if (pulseId === 'rect' && pulseParams) {
        tPulseOn = Number(pulseParams.t_start);
        tPulseOff = Number(pulseParams.t_start) + Number(pulseParams.t_dur);
    } else if (pulseId === 'double' && pulseParams) {
        tPulseOn = Number(pulseParams.t_on);
        tPulseOff = Number(pulseParams.t_off);
    } else if (pulseId === 'exp' && pulseParams) {
        tPulseOn = Number(pulseParams.t_start);
    } else if (pulseId === 'gauss' && pulseParams) {
        tPulseOn = Number(pulseParams.mu);
    }

    /* Separate the synthetic "INLET" trace (commanded pulse) from the
       real-sensor keys — it's always plotted last and styled separately
       so the user can instantly see the pulse shape against the sensor
       response. `realKeys` drives the "no data yet" banners. */
    const INLET_KEY = 'INLET';
    const realKeys = keys.filter((k) => k !== INLET_KEY);

    if (!sensorEdges.length && probeCount === 0 && realKeys.length === 0) {
        return (
            <div className="fl-muted">
                No sensors yet. Two options:
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                    <li>
                        <b>Wall sensor</b> — click an edge, open the <b>Edge</b> inspector and set BC to <b>Sensor</b>.
                    </li>
                    <li>
                        <b>Point probe</b> — pick the <b>Probe</b> tool in the Analysis ribbon and click anywhere in the fluid to drop a dot.
                    </li>
                </ul>
                Either will stream live |u|(t){speciesEnabled ? ' and c(t)' : ''} into this panel.
            </div>
        );
    }
    if (realKeys.length === 0) {
        const parts = [];
        if (sensorEdges.length) parts.push(`${sensorEdges.length} wall sensor${sensorEdges.length === 1 ? '' : 's'}`);
        if (probeCount) parts.push(`${probeCount} point probe${probeCount === 1 ? '' : 's'}`);
        return (
            <div className="fl-muted">
                {parts.join(' · ')} defined. Press <b>Run</b> — traces will start filling in.
            </div>
        );
    }

    /* Time axis. Using min/max over the current data (NOT hard-anchoring
       to 0) stops the trace from drifting right once old samples roll
       off the history cap. The rolling-window options clamp to a
       fixed-width trailing span. */
    let tDataMin = Infinity, tDataMax = -Infinity;
    for (const k of keys) {
        const arr = sensorHistory[k].t_s;
        if (!arr.length) continue;
        if (arr[0] < tDataMin) tDataMin = arr[0];
        if (arr[arr.length - 1] > tDataMax) tDataMax = arr[arr.length - 1];
    }
    if (!Number.isFinite(tDataMin)) { tDataMin = 0; tDataMax = 1e-6; }
    if (tDataMax - tDataMin < 1e-9) tDataMax = tDataMin + 1e-6;
    const windowNum = windowSec === 'full' ? Infinity : Number(windowSec);
    const tMax = tDataMax;
    const tMin = windowSec === 'full'
        ? tDataMin
        : Math.max(tDataMin, tMax - windowNum);

    // Two tiny charts stacked: c(t) (only if species enabled) + u(t).
    const W = 260, H = 110;
    const padL = 38, padR = 8, padT = 8, padB = 22;

    const renderChart = (ySelector, yLabel, yFmt, opts = {}) => {
        const { showInlet = false, showPulseMarkers = false, onlyKeys = null } = opts;
        /* If `onlyKeys` is a non-empty list we only consider / draw those
           keys — used to render one dedicated c(t) chart per dot probe
           so a probe in the fast bulk flow isn't scale-squished by a
           wall sensor whose peak is 1000× smaller. */
        const activeKeys = onlyKeys && onlyKeys.length
            ? keys.filter((k) => onlyKeys.includes(k))
            : keys;
        let yMin = Infinity, yMax = -Infinity;
        // Y-autoscale only from samples inside the visible time window —
        // otherwise an out-of-view peak silently stretches the axis and
        // the visible trace looks flat.
        for (const k of activeKeys) {
            if (!showInlet && k === INLET_KEY) continue;
            const arr = sensorHistory[k];
            const vals = ySelector(arr);
            for (let j = 0; j < arr.t_s.length; j++) {
                const t = arr.t_s[j];
                if (t < tMin || t > tMax) continue;
                const v = vals[j];
                if (!Number.isFinite(v)) continue;
                if (v < yMin) yMin = v;
                if (v > yMax) yMax = v;
            }
        }
        if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) { yMin = 0; yMax = 1; }
        if (Math.abs(yMax - yMin) < 1e-12) { yMax = yMin + 1; }
        const yPad = 0.08 * (yMax - yMin);
        yMin -= yPad; yMax += yPad;
        const x2px = (t) => padL + (W - padL - padR) * ((t - tMin) / Math.max(1e-12, tMax - tMin));
        const y2px = (v) => padT + (H - padT - padB) * (1 - (v - yMin) / Math.max(1e-12, yMax - yMin));
        const palette = ['#60a5fa', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#fb923c', '#4ade80'];
        // Order keys: INLET reference last so it paints over everything.
        const baseKeys = onlyKeys && onlyKeys.length
            ? activeKeys.filter((k) => k !== INLET_KEY)
            : realKeys;
        const drawKeys = showInlet
            ? [...baseKeys, ...(activeKeys.includes(INLET_KEY) ? [INLET_KEY] : [])]
            : baseKeys;
        return (
            <svg className="fl-profile-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
                <rect x={padL} y={padT} width={W - padL - padR} height={H - padT - padB} className="fl-chart-plot" />
                {/* y ticks */}
                {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                    const v = yMin + f * (yMax - yMin);
                    return (
                        <g key={f}>
                            <line x1={padL} y1={y2px(v)} x2={W - padR} y2={y2px(v)} className="fl-chart-grid" />
                            <text x={padL - 4} y={y2px(v) + 3} textAnchor="end" className="fl-chart-axis">{yFmt(v)}</text>
                        </g>
                    );
                })}
                {/* x ticks */}
                {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                    const t = tMin + f * (tMax - tMin);
                    return (
                        <g key={f}>
                            <text x={x2px(t)} y={H - padB + 12} textAnchor="middle" className="fl-chart-axis">
                                {t < 0.1 ? (t * 1000).toFixed(0) + ' ms' : t.toFixed(2) + ' s'}
                            </text>
                        </g>
                    );
                })}
                <text x={padL} y={padT + 8} className="fl-chart-label">{yLabel}</text>
                {/* Pulse-window annotation: shaded band between pulse ON
                    and pulse OFF, plus vertical markers. Only drawn on
                    the c(t) chart so the |u| chart stays clean. */}
                {showPulseMarkers && Number.isFinite(tPulseOn) && Number.isFinite(tPulseOff)
                    && tPulseOff > tPulseOn
                    && tPulseOff >= tMin && tPulseOn <= tMax && (
                        <rect
                            x={x2px(Math.max(tPulseOn, tMin))}
                            y={padT}
                            width={Math.max(0, x2px(Math.min(tPulseOff, tMax)) - x2px(Math.max(tPulseOn, tMin)))}
                            height={H - padT - padB}
                            fill="rgba(16, 185, 129, 0.10)"
                        />
                    )}
                {showPulseMarkers && Number.isFinite(tPulseOn) && tPulseOn >= tMin && tPulseOn <= tMax && (
                    <g>
                        <line
                            x1={x2px(tPulseOn)} x2={x2px(tPulseOn)}
                            y1={padT} y2={H - padB}
                            stroke="rgba(16, 185, 129, 0.9)"
                            strokeWidth="1"
                            strokeDasharray="3 3"
                        />
                        <text
                            x={x2px(tPulseOn) + 3}
                            y={padT + 9}
                            style={{ fontSize: 9, fill: 'rgba(16, 185, 129, 0.95)' }}
                        >pulse on</text>
                    </g>
                )}
                {showPulseMarkers && Number.isFinite(tPulseOff) && tPulseOff >= tMin && tPulseOff <= tMax && (
                    <g>
                        <line
                            x1={x2px(tPulseOff)} x2={x2px(tPulseOff)}
                            y1={padT} y2={H - padB}
                            stroke="rgba(245, 158, 11, 0.9)"
                            strokeWidth="1"
                            strokeDasharray="3 3"
                        />
                        <text
                            x={x2px(tPulseOff) + 3}
                            y={padT + 9}
                            style={{ fontSize: 9, fill: 'rgba(245, 158, 11, 0.95)' }}
                        >pulse off</text>
                    </g>
                )}
                {/* Curves — split at NaN gaps and at the window edge so
                    one bad sample or an out-of-view sample doesn't nuke
                    the trace. Dashed grey = commanded inlet reference. */}
                {drawKeys.map((k, i) => {
                    const arr = sensorHistory[k];
                    const vals = ySelector(arr);
                    const isInlet = k === INLET_KEY;
                    const isProbe = k.startsWith('P:');
                    const probe = isProbe ? probeList.find((pp) => `P:${pp.id}` === k) : null;
                    const stroke = isInlet
                        ? 'var(--text-muted, #94a3b8)'
                        : (probe?.color || palette[i % palette.length]);
                    const segments = [];
                    let cur = [];
                    for (let j = 0; j < arr.t_s.length; j++) {
                        const t = arr.t_s[j];
                        const v = vals[j];
                        const inRange = t >= tMin && t <= tMax;
                        if (inRange && Number.isFinite(v)) {
                            cur.push(`${x2px(t).toFixed(1)},${y2px(v).toFixed(1)}`);
                        } else if (cur.length) {
                            segments.push(cur.join(' '));
                            cur = [];
                        }
                    }
                    if (cur.length) segments.push(cur.join(' '));
                    return (
                        <g key={k}>
                            {segments.map((pts, si) => (
                                <polyline key={si}
                                    points={pts}
                                    stroke={stroke}
                                    fill="none"
                                    strokeWidth={isInlet ? 1.2 : (isProbe ? 1.9 : 1.6)}
                                    strokeDasharray={
                                        isInlet ? '2 3'
                                            : (isProbe ? '4 3' : undefined)
                                    }
                                    opacity={isInlet ? 0.75 : 1}
                                    className="fl-chart-line"
                                />
                            ))}
                        </g>
                    );
                })}
            </svg>
        );
    };

    return (
        <div className="fl-sensor-panel">
            {probeCount > 0 && (
                <div className="fl-probe-chiprow" title="Point probes currently placed inside the fluid. Each one streams c(t) and |u|(t) into the charts below. Click × to remove a probe (removes its trace too).">
                    {probeList.map((pp) => (
                        <span key={pp.id} className="fl-probe-chip" style={{ borderColor: pp.color }}>
                            <span className="fl-probe-chip-dot" style={{ background: pp.color }} />
                            <span className="fl-probe-chip-lbl">{pp.label}</span>
                            <span className="fl-probe-chip-pos">
                                ({pp.x_mm.toFixed(1)}, {pp.y_mm.toFixed(1)} mm)
                            </span>
                            {onRemoveProbe && (
                                <button
                                    type="button"
                                    className="fl-probe-chip-rm"
                                    onClick={() => onRemoveProbe(pp.id)}
                                    title={`Remove ${pp.label}`}
                                    aria-label={`Remove probe ${pp.label}`}
                                >×</button>
                            )}
                        </span>
                    ))}
                </div>
            )}
            {/* Sim-time + residence-time summary. Makes it obvious at a
                glance how much simulated time has elapsed vs. how much
                is needed for a puff to traverse the chamber — the single
                most common reason "c(t) at the sensor doesn't respond"
                is simply that the sim hasn't run long enough. */}
            {speciesEnabled && (
                <div className="fl-sensor-summary" title="Simulated-time clock vs. the convective residence time L/U. You typically need 3–5 residence times past pulse end for c(t) to decay back to zero.">
                    <div className="fl-kv">
                        <span>sim time</span>
                        <span><b>{Number.isFinite(tDataMax) ? tDataMax.toFixed(3) : '0.000'} s</b></span>
                    </div>
                    <div className="fl-kv">
                        <span>τ flow (L / U)</span>
                        <span>{Number.isFinite(tauFlow_s) ? tauFlow_s.toPrecision(3) + ' s' : '—'}</span>
                    </div>
                    {/* Live inlet drive — what the worker is injecting RIGHT
                        NOW at the inlet boundary. If this stays 0 while sim
                        time is inside [t_start, t_start+t_dur], the pulse
                        evaluator isn't firing (solver or param bug). If it
                        cycles 0 → 1 → 0 on schedule but the sensor c(t)
                        stays flat, the issue is purely physical (flow is
                        too slow, sensor too far from inlet). */}
                    <div className="fl-kv" title="Live inlet concentration the solver is currently driving. Cycles 0 → 1 → 0 with the aroma pulse.">
                        <span>c inlet now</span>
                        <span style={{
                            fontWeight: 700,
                            color: Number.isFinite(cInletNow) && cInletNow > 1e-4
                                ? '#22c55e' : 'inherit',
                        }}>
                            {Number.isFinite(cInletNow) ? cInletNow.toFixed(3) : '—'}
                        </span>
                    </div>
                    {/* Max concentration anywhere in the fluid (excluding
                        inlet cells). If this stays 0 while c inlet now
                        cycles, advection+diffusion are not transporting the
                        puff off the boundary — a solver bug. If it rises
                        but the sensor row still reads 0, the puff simply
                        hasn't reached the sensor's wall patch yet (physics). */}
                    <div className="fl-kv" title="Max concentration anywhere in the interior fluid. Should become non-zero shortly after the pulse starts if advection/diffusion is working.">
                        <span>c max (fluid)</span>
                        <span style={{
                            fontWeight: 700,
                            color: Number.isFinite(cMaxFluid) && cMaxFluid > 1e-4
                                ? '#22c55e' : '#ef4444',
                        }}>
                            {Number.isFinite(cMaxFluid) ? cMaxFluid.toFixed(3) : '—'}
                        </span>
                    </div>
                    <div className="fl-kv" title="Pulse profile and parameters captured at Run time. If these don't match what you set in the solver panel, press Reset and Run again.">
                        <span>pulse</span>
                        <span style={{ fontSize: 11 }}>
                            {pulseId || '—'}
                            {pulseParams ? ' · ' + Object.entries(pulseParams).map(([k, v]) => `${k}=${v}`).join(', ') : ''}
                        </span>
                    </div>
                    {Number.isFinite(tPulseOff) && Number.isFinite(tauFlow_s) && tDataMax < tPulseOff + 3 * tauFlow_s && (
                        <div className="fl-muted" style={{ gridColumn: '1 / -1', fontSize: 11, marginTop: 4, lineHeight: 1.35 }}>
                            {tDataMax < tPulseOn
                                ? <>Pulse hasn't started yet (fires at <b>{tPulseOn.toFixed(2)} s</b>). Keep <b>Run</b> going.</>
                                : tDataMax < tPulseOff
                                    ? <>Pulse in progress (<b>{tPulseOn.toFixed(2)}–{tPulseOff.toFixed(2)} s</b>). Puff is still being injected.</>
                                    : <>Pulse ended at <b>{tPulseOff.toFixed(2)} s</b>. Expect c(t) to finish decaying around <b>t ≈ {(tPulseOff + 3 * tauFlow_s).toFixed(2)} s</b> (pulse-off + 3·τ<sub>flow</sub>). You've only reached <b>{tDataMax.toFixed(2)} s</b>{running ? ' — keep Run going.' : ' — press Run again to continue.'}</>}
                        </div>
                    )}
                </div>
            )}
            {/* Chart controls: time window. Keeps the trace readable
                when sims run for many seconds — otherwise auto-scaling
                to the full history visibly "squeezes to the left" as
                tMax grows. */}
            <div className="fl-inline" style={{ justifyContent: 'space-between', marginBottom: 4, gap: 6, flexWrap: 'wrap' }}>
                <span className="fl-muted" style={{ fontSize: 11 }}>
                    Solid = wall sensor · dashed coloured = point probe
                </span>
                <label className="fl-field fl-field-inline fl-view-select" title="Clamp the visible time range — full history, or the most recent N seconds. Older samples stay in the store (and in the CSV export), just off-chart.">
                    <span>View</span>
                    <select value={windowSec}
                        onChange={(e) => setWindowSec(e.target.value)}>
                        <option value="full">Full history</option>
                        <option value="1">Last 1 s</option>
                        <option value="2">Last 2 s</option>
                        <option value="5">Last 5 s</option>
                        <option value="10">Last 10 s</option>
                    </select>
                </label>
            </div>
            {speciesEnabled
                ? renderChart(
                    (arr) => arr.c,
                    'c(t) — near-wall analyte',
                    (v) => v.toFixed(2),
                )
                : (
                    <div className="fl-muted" style={{ marginBottom: 8 }}>
                        Species transport is off — only |u|(t) is recorded. Turn on <b>Enable aroma pulse</b> in Species transport to see c(t) and response metrics.
                    </div>
                )}
            {renderChart(
                (arr) => arr.u,
                '|u|(t) near sensor wall  (m/s)',
                (v) => v.toFixed(3),
            )}

            {/* One dedicated c(t) chart per point probe. Probes sit in the
                bulk flow and typically see 100–1000× higher peak c than
                wall sensors, so auto-scaling a single shared chart collapses
                wall traces to an invisible line. Giving each probe its own
                y-axis makes both regimes readable, and makes per-probe
                shape comparisons trivial. Drawn only when species
                transport is on (no c(t) to show otherwise) and only when
                the probe has at least one sample logged. */}
            {speciesEnabled && probeList.map((pp) => {
                const k = `P:${pp.id}`;
                const arr = sensorHistory[k];
                if (!arr || arr.t_s.length === 0) return null;
                return (
                    <div key={k} style={{ marginTop: 4 }}>
                        {renderChart(
                            (a) => a.c,
                            `c(t) — ${arr.label || pp.label}`,
                            (v) => (Math.abs(v) < 0.01 ? v.toExponential(1) : v.toFixed(2)),
                            { onlyKeys: [k] },
                        )}
                    </div>
                );
            })}

            {/* Per-sensor legend + metrics card. The synthetic INLET
                trace is listed last in muted style, without response
                metrics — it's a reference pulse, not a measurement. */}
            <div className="fl-sensor-list">
                {realKeys.map((k, i) => {
                    const arr = sensorHistory[k];
                    const palette = ['#60a5fa', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#fb923c', '#4ade80'];
                    const isInlet = k === INLET_KEY;
                    const isProbe = k.startsWith('P:');
                    const probe = isProbe ? probeList.find((pp) => `P:${pp.id}` === k) : null;
                    const chipColor = isInlet
                        ? 'var(--text-muted, #94a3b8)'
                        : (probe?.color || palette[i % palette.length]);
                    const mx = speciesEnabled && !isInlet ? sensorMetrics(arr) : null;
                    return (
                        <div key={k} className="fl-sensor-row">
                            <div className="fl-sensor-row-hd">
                                <span className="fl-sensor-chip" style={{ background: chipColor }} />
                                <span className="fl-sensor-lab">
                                    {isInlet ? '┄ ' : (isProbe ? '● ' : '')}{arr.label || `S${Number(k) + 1}`}
                                </span>
                                <span className="fl-sensor-sub fl-muted">{arr.t_s.length} samples</span>
                            </div>
                            {isInlet ? (
                                <div className="fl-sensor-metrics">
                                    <div className="fl-kv" title="The concentration the worker is driving the inlet cell to, as a function of simulation time. Not a measurement.">
                                        <span>reference</span>
                                        <span>{arr.c.length ? arr.c[arr.c.length - 1].toFixed(2) : '—'}</span>
                                    </div>
                                </div>
                            ) : mx ? (
                                <div className="fl-sensor-metrics">
                                    <div className="fl-kv" title="Current concentration at this sensor / probe (latest sample). Compare to the 'peak c' below to see if the signal is still decaying.">
                                        <span>c now</span>
                                        <span>{arr.c.length ? arr.c[arr.c.length - 1].toFixed(3) : '—'}</span>
                                    </div>
                                    <div className="fl-kv"><span>peak c</span><span>{mx.peak.toFixed(3)} @ {mx.tPeak.toFixed(3)} s</span></div>
                                    <div className="fl-kv" title="Time to reach 10 % of peak on the rising edge."><span>t₁₀</span><span>{Number.isFinite(mx.t10) ? mx.t10.toFixed(3) + ' s' : '—'}</span></div>
                                    <div className="fl-kv" title="Time to reach 50 % of peak on the rising edge."><span>t₅₀</span><span>{Number.isFinite(mx.t50) ? mx.t50.toFixed(3) + ' s' : '—'}</span></div>
                                    <div className="fl-kv" title="Time to reach 90 % of peak on the rising edge."><span>t₉₀</span><span>{Number.isFinite(mx.t90) ? mx.t90.toFixed(3) + ' s' : '—'}</span></div>
                                    <div className="fl-kv" title="Rise time t₁₀→t₉₀."><span>rise</span><span>{Number.isFinite(mx.riseTime) ? mx.riseTime.toFixed(3) + ' s' : '—'}</span></div>
                                    <div className="fl-kv" title="Full Width at Half Maximum — width (in s) of the peak at c = peak/2."><span>FWHM</span><span>{Number.isFinite(mx.fwhm) ? mx.fwhm.toFixed(3) + ' s' : '—'}</span></div>
                                    <div className="fl-kv" title="∫ (c(t) − c₀) dt — total dose delivered to the sensor (c·s)."><span>AUC</span><span>{mx.auc.toExponential(2)} c·s</span></div>
                                </div>
                            ) : (
                                <div className="fl-sensor-metrics">
                                    <div className="fl-kv">
                                        <span>|u| latest</span>
                                        <span>{arr.u.length ? arr.u[arr.u.length - 1].toFixed(4) + ' m/s' : '—'}</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            <div className="fl-inline fl-sensor-actions">
                <button className="fl-toolbtn fl-toolbtn-primary"
                    onClick={onVisualize}
                    disabled={keys.length === 0}
                    title="Open an interactive graph with tooltips to visualize the data"
                    type="button">
                    <BarChart2 size={12} /> Visualize
                </button>
                <button className="fl-toolbtn"
                    onClick={onSaveToWorkspace}
                    disabled={keys.length === 0}
                    title="Save all graph data directly to the Flow Lab workspace"
                    type="button">
                    <Save size={12} /> Save
                </button>
                <button className="fl-toolbtn"
                    onClick={onExportCsv}
                    disabled={keys.length === 0}
                    title="Download time + c(t) + |u|(t) for every sensor as one CSV"
                    type="button">
                    <Download size={12} /> CSV
                </button>
                <button className="fl-toolbtn"
                    onClick={onClearHistory}
                    disabled={keys.length === 0}
                    title="Clear the recorded sensor history (keeps the current field)"
                    type="button">
                    Clear
                </button>
            </div>
        </div>
    );
};

const MultiProfileChart = ({ sectionProfiles, quantity, selectedId }) => {
    const qDef = QUANTITY_BY_ID[quantity] || QUANTITY_BY_ID.umag;
    const visible = sectionProfiles.filter((p) => p.ok && p.section.visible !== false);
    const W = 260, H = 140;
    const padL = 38, padR = 8, padT = 8, padB = 22;
    if (!visible.length) {
        return (
            <svg className="fl-profile-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
                <rect x={padL} y={padT} width={W - padL - padR} height={H - padT - padB} className="fl-chart-plot" />
                <text x={W / 2} y={H / 2} className="fl-chart-label" textAnchor="middle">waiting for data…</text>
            </svg>
        );
    }
    // Normalise the x-axis across sections: plot each one on [0, 1] so
    // sections of different lengths overlay on a common coordinate. A
    // separate "s_mm" label shows each section's absolute length.
    let yMin = Infinity, yMax = -Infinity;
    const series = visible.map((p) => {
        const vals = p.samples.map((s) => qDef.compute(s, p.tx, p.ty, p.nxn, p.nyn));
        for (const v of vals) {
            if (!Number.isFinite(v)) continue;
            if (v < yMin) yMin = v;
            if (v > yMax) yMax = v;
        }
        return { profile: p, vals };
    });
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) { yMin = 0; yMax = 1; }
    if (Math.abs(yMax - yMin) < 1e-12) { yMax = yMin + 1e-6; }
    const xPx = (t) => padL + t * (W - padL - padR);
    const yPx = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB);

    const yticks = [yMin, (yMin + yMax) / 2, yMax];
    const crossesZero = yMin < 0 && yMax > 0;
    return (
        <svg className="fl-profile-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
            <rect x={padL} y={padT} width={W - padL - padR} height={H - padT - padB} className="fl-chart-plot" />
            {yticks.map((v, i) => (
                <g key={i}>
                    <line x1={padL} x2={W - padR} y1={yPx(v)} y2={yPx(v)} className="fl-chart-grid" />
                    <text x={padL - 4} y={yPx(v) + 3} className="fl-chart-tick" textAnchor="end">
                        {Math.abs(v) < 0.01 || Math.abs(v) > 999 ? v.toExponential(1) : v.toFixed(3)}
                    </text>
                </g>
            ))}
            {crossesZero && (
                <line x1={padL} x2={W - padR} y1={yPx(0)} y2={yPx(0)} className="fl-chart-goal" />
            )}
            {series.map(({ profile, vals }) => {
                const n = vals.length;
                const path = vals.map((v, i) => {
                    const safe = Number.isFinite(v) ? v : 0;
                    return `${i === 0 ? 'M' : 'L'}${xPx(i / (n - 1 || 1)).toFixed(1)},${yPx(safe).toFixed(1)}`;
                }).join(' ');
                const isSel = profile.section.id === selectedId;
                return (
                    <path
                        key={profile.section.id}
                        d={path}
                        stroke={profile.section.color}
                        strokeWidth={isSel ? 2.4 : 1.4}
                        fill="none"
                        opacity={isSel ? 1 : 0.85}
                    />
                );
            })}
            <text x={padL} y={H - 4} className="fl-chart-label">0</text>
            <text x={W - padR} y={H - 4} className="fl-chart-label" textAnchor="end">
                s / L
            </text>
            <text x={W / 2} y={H - 4} className="fl-chart-label" textAnchor="middle">
                {qDef.abbr} ({qDef.unit})
            </text>
        </svg>
    );
};

/** Time-series chart: volumetric flow rate Q(t) per section.
 *  `history` = [{ iter, t_s, per: { [sectionId]: { Q_mlpm, ... } } }].
 *  Lines are drawn in each section's colour and the selected section
 *  is rendered on top with a bolder stroke + a trailing dot showing
 *  the latest value. A dashed vertical marker is drawn at `steadyIter`
 *  when steady state has been reached, giving a clean visual separator
 *  between transient and steady phases. Quantity is selected by key:
 *  'Q_mlpm', 'mean_mps', 'peak_mps', 'flux_m2ps', 'Q_m3ps'. */
const FlowRateTimeChart = ({ history, sections, selectedId, quantityKey, unitLabel, steadyIter }) => {
    const W = 260, H = 150;
    const padL = 46, padR = 8, padT = 8, padB = 22;
    const visibleSections = sections.filter((s) => s.visible !== false);
    if (!history?.length || !visibleSections.length) {
        return (
            <svg className="fl-profile-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
                <rect x={padL} y={padT} width={W - padL - padR} height={H - padT - padB} className="fl-chart-plot" />
                <text x={W / 2} y={H / 2} className="fl-chart-label" textAnchor="middle">
                    {history?.length ? 'No visible sections' : 'waiting for data…'}
                </text>
            </svg>
        );
    }
    // Compute tMin/tMax/yMin/yMax across visible sections. We y-pad so
    // a perfectly flat trace still renders nicely (±5% around the value).
    let tMin = Infinity, tMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const row of history) {
        if (!Number.isFinite(row.t_s)) continue;
        if (row.t_s < tMin) tMin = row.t_s;
        if (row.t_s > tMax) tMax = row.t_s;
        for (const s of visibleSections) {
            const v = row.per?.[s.id]?.[quantityKey];
            if (!Number.isFinite(v)) continue;
            if (v < yMin) yMin = v;
            if (v > yMax) yMax = v;
        }
    }
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax - tMin < 1e-9) {
        tMin = 0; tMax = Math.max(tMax, 1e-6);
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) { yMin = 0; yMax = 1; }
    if (Math.abs(yMax - yMin) < 1e-12) {
        const c = yMin;
        const pad = Math.max(1e-6, Math.abs(c) * 0.05);
        yMin = c - pad; yMax = c + pad;
    }
    const xPx = (t) => padL + ((t - tMin) / (tMax - tMin)) * (W - padL - padR);
    const yPx = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB);

    const yticks = [yMin, (yMin + yMax) / 2, yMax];
    const fmtY = (v) => (Math.abs(v) < 0.01 || Math.abs(v) >= 1e4)
        ? v.toExponential(1)
        : (Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
    const fmtX = (t) => (t >= 10 ? t.toFixed(1) : t.toFixed(3));

    const crossesZero = yMin < 0 && yMax > 0;

    return (
        <svg className="fl-profile-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
            <rect x={padL} y={padT} width={W - padL - padR} height={H - padT - padB} className="fl-chart-plot" />
            {yticks.map((v, i) => (
                <g key={i}>
                    <line x1={padL} x2={W - padR} y1={yPx(v)} y2={yPx(v)} className="fl-chart-grid" />
                    <text x={padL - 4} y={yPx(v) + 3} className="fl-chart-tick" textAnchor="end">{fmtY(v)}</text>
                </g>
            ))}
            {crossesZero && (
                <line x1={padL} x2={W - padR} y1={yPx(0)} y2={yPx(0)} className="fl-chart-goal" />
            )}
            {/* Steady-state marker */}
            {steadyIter != null && (() => {
                const rowAtSteady = history.find((h) => h.iter >= steadyIter);
                if (!rowAtSteady) return null;
                const sx = xPx(rowAtSteady.t_s);
                return (
                    <g>
                        <line x1={sx} x2={sx} y1={padT} y2={H - padB}
                              className="fl-chart-goal" strokeDasharray="3 3" />
                        <text x={sx + 3} y={padT + 10} className="fl-chart-label">steady</text>
                    </g>
                );
            })()}
            {/* One polyline per visible section. */}
            {visibleSections.map((sec) => {
                const pts = [];
                for (const row of history) {
                    const v = row.per?.[sec.id]?.[quantityKey];
                    if (!Number.isFinite(v)) continue;
                    pts.push([row.t_s, v]);
                }
                if (pts.length < 2) return null;
                const path = pts.map(([t, v], i) =>
                    `${i === 0 ? 'M' : 'L'}${xPx(t).toFixed(1)},${yPx(v).toFixed(1)}`
                ).join(' ');
                const isSel = sec.id === selectedId;
                const lastV = pts[pts.length - 1][1];
                const lastT = pts[pts.length - 1][0];
                return (
                    <g key={sec.id}>
                        <path d={path} stroke={sec.color}
                              strokeWidth={isSel ? 2.4 : 1.4} fill="none"
                              opacity={isSel ? 1 : 0.85} />
                        <circle cx={xPx(lastT)} cy={yPx(lastV)} r={isSel ? 3 : 2}
                                fill={sec.color} stroke="none" />
                    </g>
                );
            })}
            <text x={padL} y={H - 4} className="fl-chart-label">{fmtX(tMin)} s</text>
            <text x={W - padR} y={H - 4} className="fl-chart-label" textAnchor="end">{fmtX(tMax)} s</text>
            <text x={(padL + W - padR) / 2} y={H - 4} className="fl-chart-label" textAnchor="middle">
                t ({unitLabel})
            </text>
        </svg>
    );
};

/* A single row in the section list — colour swatch, label, quick stats,
   visibility toggle, CSV export, delete. Click the row to make it the
   "selected" (focused) section for the detailed stats card. */
const SectionRow = ({ section, stats, selected, onSelect, onToggleVisible, onRename, onDelete, onExportCsv }) => {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(section.label || section.id);
    useEffect(() => { setText(section.label || section.id); }, [section.label, section.id]);
    const commit = () => {
        setEditing(false);
        if (text.trim() && text !== section.label) onRename(text.trim().slice(0, 30));
        else setText(section.label || section.id);
    };
    const hidden = section.visible === false;
    return (
        <div className={`fl-section-row ${selected ? 'is-selected' : ''} ${hidden ? 'is-hidden' : ''}`}
             onClick={onSelect}>
            <span className="fl-section-chip" style={{ background: section.color }} />
            {editing ? (
                <input
                    className="fl-section-label-input"
                    autoFocus
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') commit();
                        if (e.key === 'Escape') { setText(section.label || section.id); setEditing(false); }
                    }}
                    onClick={(e) => e.stopPropagation()}
                />
            ) : (
                <span
                    className="fl-section-label-txt"
                    onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
                    title="Double-click to rename"
                >{section.label || section.id}</span>
            )}
            <span className="fl-section-meta">
                {stats ? `${stats.peak_mps.toFixed(3)} m/s` : '—'}
            </span>
            <button
                className="fl-icon-btn"
                onClick={(e) => { e.stopPropagation(); onToggleVisible(); }}
                title={hidden ? 'Show' : 'Hide'}
                type="button"
            >{hidden ? '○' : '●'}</button>
            <button
                className="fl-icon-btn"
                onClick={(e) => { e.stopPropagation(); onExportCsv(); }}
                title="Export profile as CSV"
                type="button"
            >↓</button>
            <button
                className="fl-icon-btn fl-icon-btn-danger"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                title="Delete section"
                type="button"
            >×</button>
        </div>
    );
};

/* Tiny residual(iter) chart, log-y. A dashed threshold line at 1e-4 marks
   the convergence target. Great for spotting stalled sims at a glance. */
const ResidualChart = ({ history, threshold }) => {
    const W = 240, H = 100;
    const padL = 34, padR = 6, padT = 6, padB = 18;
    const its = history.map((h) => h.iter);
    const res = history.map((h) => Math.max(1e-12, h.residual));
    const imax = its[its.length - 1] || 1;
    const imin = its[0] || 0;
    const logMin = Math.log10(Math.min(threshold * 0.1, ...res));
    const logMax = Math.log10(Math.max(1, ...res));
    const xPx = (i) => padL + ((i - imin) / Math.max(1, imax - imin)) * (W - padL - padR);
    const yPx = (r) => padT + (1 - (Math.log10(r) - logMin) / (logMax - logMin)) * (H - padT - padB);
    const path = history.map((h, idx) =>
        `${idx === 0 ? 'M' : 'L'}${xPx(h.iter).toFixed(1)},${yPx(Math.max(1e-12, h.residual)).toFixed(1)}`
    ).join(' ');
    return (
        <svg className="fl-profile-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
            <rect x={padL} y={padT} width={W - padL - padR} height={H - padT - padB} className="fl-chart-plot" />
            <line x1={padL} x2={W - padR} y1={yPx(threshold)} y2={yPx(threshold)} className="fl-chart-goal" />
            <text x={padL - 4} y={yPx(threshold) + 3} className="fl-chart-tick" textAnchor="end">
                {threshold.toExponential(0)}
            </text>
            <text x={padL - 4} y={padT + 8} className="fl-chart-tick" textAnchor="end">
                {Math.pow(10, logMax).toExponential(0)}
            </text>
            <path d={path} className="fl-residual-line" />
            <text x={padL} y={H - 4} className="fl-chart-label">{imin}</text>
            <text x={W - padR} y={H - 4} className="fl-chart-label" textAnchor="end">
                iter {imax}
            </text>
        </svg>
    );
};

/** Compact popover attached to the Grid toolbar button. Rendered via a
 *  portal into document.body so the toolbar's overflow-x:auto (which
 *  implicitly clips the Y axis too) never cuts it off.
 *
 *  The popover supports THREE spacing modes:
 *    • **Auto**  — step scales with zoom (classic behaviour).
 *    • **Min**   — a minimum floor; step = max(minMm, auto(zoom)). The
 *                  grid never renders finer than `minMm`; when you zoom
 *                  in past that threshold the cells simply grow in
 *                  pixels, keeping the grid readable at every zoom.
 *    • **Fixed** — pin the step to an exact value (no scaling at all).
 *
 *  Divisions-per-major controls how many minor ticks sit between majors.
 *  Note that none of these settings affect the LBM mesh resolution
 *  (that's the separate "Solver mesh" panel on the right). */
const GridSettingsPopover = ({
    gridStepMm, overrideMm, setOverrideMm,
    minStepMm, setMinStepMm,
    minorDivisions, setMinorDivisions,
    unit, anchorEl, onClose,
}) => {
    // Current active mode (Auto / Min / Fixed).
    const mode = overrideMm != null ? 'fixed' : (minStepMm != null ? 'min' : 'auto');

    // Show the currently-effective step in the user's chosen unit.
    const displayStep = mmToUnit(gridStepMm, unit);
    const [stepInput, setStepInput] = useState(() =>
        overrideMm != null ? mmToUnit(overrideMm, unit).toString() : '');
    const [minInput, setMinInput] = useState(() =>
        minStepMm != null ? mmToUnit(minStepMm, unit).toString() : '');

    useEffect(() => {
        setStepInput(overrideMm != null ? mmToUnit(overrideMm, unit).toString() : '');
    }, [overrideMm, unit]);
    useEffect(() => {
        setMinInput(minStepMm != null ? mmToUnit(minStepMm, unit).toString() : '');
    }, [minStepMm, unit]);

    const commitStep = () => {
        const v = Number(stepInput);
        if (stepInput === '' || !Number.isFinite(v) || v <= 0) {
            setOverrideMm(null);
            return;
        }
        setOverrideMm(unitToMm(v, unit));
    };
    const commitMinStep = () => {
        const v = Number(minInput);
        if (minInput === '' || !Number.isFinite(v) || v <= 0) {
            setMinStepMm(null);
            return;
        }
        setMinStepMm(unitToMm(v, unit));
    };

    // Anchor the portal to the gear button's current screen position.
    const rootRef = useRef(null);
    const [pos, setPos] = useState(() => {
        if (!anchorEl) return { top: 60, left: 60 };
        const r = anchorEl.getBoundingClientRect();
        return { top: r.bottom + 6, left: r.left };
    });
    useEffect(() => {
        const update = () => {
            if (!anchorEl) return;
            const r = anchorEl.getBoundingClientRect();
            // Keep the popover fully inside the viewport.
            const POP_W = 260;
            const POP_H = 280;
            const left = Math.max(8, Math.min(window.innerWidth - POP_W - 8, r.left));
            const top = Math.min(window.innerHeight - POP_H - 8, r.bottom + 6);
            setPos({ top, left });
        };
        update();
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    }, [anchorEl]);

    // Close on outside click / Escape. The anchor button itself should
    // not count as "outside" (otherwise clicking the gear would reopen
    // and immediately close the popover).
    useEffect(() => {
        const onDoc = (e) => {
            if (rootRef.current && rootRef.current.contains(e.target)) return;
            if (anchorEl && anchorEl.contains(e.target)) return;
            onClose();
        };
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose, anchorEl]);

    const stepStep = unit === 'um' ? 10 : 0.1;

    const popoverNode = (
        <div
            className="fl-gridpop fl-gridpop-portal"
            ref={rootRef}
            role="dialog"
            aria-label="Grid settings"
            style={{ top: pos.top, left: pos.left }}
        >
            <div className="fl-gridpop-title">Grid settings</div>

            <div className="fl-gridpop-row">
                <span className="fl-gridpop-label">Spacing</span>
                <div className="fl-gridpop-segmented">
                    <button
                        className={mode === 'auto' ? 'is-active' : ''}
                        onClick={() => { setOverrideMm(null); setMinStepMm(null); }}
                        title="Grid step scales with zoom"
                    >Auto</button>
                    <button
                        className={mode === 'min' ? 'is-active' : ''}
                        onClick={() => {
                            setOverrideMm(null);
                            if (minStepMm == null) setMinStepMm(gridStepMm);
                        }}
                        title="Grid step never goes below a minimum; zoom-in past that point keeps the step constant and cells grow in pixels"
                    >Min</button>
                    <button
                        className={mode === 'fixed' ? 'is-active' : ''}
                        onClick={() => setOverrideMm(overrideMm ?? gridStepMm)}
                        title="Pin the grid step to an exact value regardless of zoom"
                    >Fixed</button>
                </div>
            </div>

            {mode === 'fixed' && (
                <label className="fl-gridpop-field" title="Pin a fixed major-grid spacing (value in current unit).">
                    <span>Step</span>
                    <div className="fl-inline">
                        <input
                            type="number"
                            value={stepInput}
                            onChange={(e) => setStepInput(e.target.value)}
                            onBlur={commitStep}
                            onKeyDown={(e) => { if (e.key === 'Enter') { commitStep(); e.currentTarget.blur(); } }}
                            min={0}
                            step={stepStep}
                        />
                        <span>{UNIT_LABEL[unit]}</span>
                    </div>
                </label>
            )}

            {mode === 'min' && (
                <label className="fl-gridpop-field" title={`Smallest spacing the grid may shrink to (${UNIT_LABEL[unit]}). When zoomed in past this, the grid stays at this size and on-screen cells grow.`}>
                    <span>Min step</span>
                    <div className="fl-inline">
                        <input
                            type="number"
                            value={minInput}
                            onChange={(e) => setMinInput(e.target.value)}
                            onBlur={commitMinStep}
                            onKeyDown={(e) => { if (e.key === 'Enter') { commitMinStep(); e.currentTarget.blur(); } }}
                            min={0}
                            step={stepStep}
                        />
                        <span>{UNIT_LABEL[unit]}</span>
                    </div>
                </label>
            )}

            {mode === 'auto' && (
                <div className="fl-gridpop-hint">
                    Auto step scales with zoom. Currently <b>{displayStep.toFixed(unit === 'um' ? 0 : 3)} {UNIT_LABEL[unit]}</b>.
                </div>
            )}

            {mode === 'min' && (
                <div className="fl-gridpop-hint">
                    Effective step: <b>{displayStep.toFixed(unit === 'um' ? 0 : 3)} {UNIT_LABEL[unit]}</b>. Zoom in further and the grid stays at min; zoom out and it coarsens normally.
                </div>
            )}

            <div className="fl-gridpop-row">
                <span className="fl-gridpop-label">Divisions per major</span>
                <div className="fl-gridpop-segmented">
                    {MINOR_DIV_OPTIONS.map((n) => (
                        <button key={n}
                            className={minorDivisions === n ? 'is-active' : ''}
                            onClick={() => setMinorDivisions(n)}
                        >{n}</button>
                    ))}
                </div>
            </div>

            <div className="fl-gridpop-footer">
                <button className="fl-gridpop-reset"
                    onClick={() => { setOverrideMm(null); setMinStepMm(null); setMinorDivisions(5); }}
                    title="Reset to Auto spacing with 5 minor divisions">Reset</button>
                <button className="fl-gridpop-done" onClick={onClose}>Done</button>
            </div>
        </div>
    );

    return createPortal(popoverNode, document.body);
};

/** Fixed-position XY axis gizmo pinned to the bottom-left of the
 *  canvas, in the CAD convention (+X right, +Y up). Purely informative
 *  — it does NOT move with pan/zoom, it just tells users which way the
 *  coordinate system points. The current display unit (mm / µm) is
 *  shown next to the axis labels. */
const AxesGizmo = ({ unit = 'mm' }) => {
    // Geometry of the gizmo — fits in a 72×72 box with a small margin.
    const W = 78, H = 78;
    const pad = 10;
    const ox = pad + 4;       // origin x inside the gizmo SVG
    const oy = H - pad - 4;   // origin y inside the gizmo SVG (y-down)
    const len = 44;           // arrow length
    const ahx = oy - len;     // (unused helper — kept for readability)
    // eslint-disable-next-line no-unused-expressions
    ahx;
    const xTip = { x: ox + len, y: oy };
    const yTip = { x: ox,       y: oy - len };
    return (
        <div className="fl-axes-gizmo" aria-label="Coordinate axes (X right, Y up)">
            <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
                {/* Subtle frame so the widget reads against any heatmap */}
                <rect x={1} y={1} width={W - 2} height={H - 2}
                      className="fl-axes-bg" rx={8} ry={8} />
                {/* Origin dot */}
                <circle cx={ox} cy={oy} r={2.2} className="fl-axes-origin" />
                {/* X axis — red-orange, pointing right */}
                <line x1={ox} y1={oy} x2={xTip.x} y2={xTip.y}
                      className="fl-axes-x" />
                <polygon className="fl-axes-x-head"
                         points={`${xTip.x},${xTip.y} ${xTip.x - 6},${xTip.y - 3.5} ${xTip.x - 6},${xTip.y + 3.5}`} />
                <text x={xTip.x + 4} y={xTip.y + 3.5} className="fl-axes-label-x">X</text>
                {/* Y axis — green, pointing up */}
                <line x1={ox} y1={oy} x2={yTip.x} y2={yTip.y}
                      className="fl-axes-y" />
                <polygon className="fl-axes-y-head"
                         points={`${yTip.x},${yTip.y} ${yTip.x - 3.5},${yTip.y + 6} ${yTip.x + 3.5},${yTip.y + 6}`} />
                <text x={yTip.x - 3} y={yTip.y - 4} className="fl-axes-label-y">Y</text>
                {/* Origin & unit caption */}
                <text x={ox - 2} y={oy + 11} className="fl-axes-caption">0, {unit}</text>
            </svg>
        </div>
    );
};

/** Tiny world-origin crosshair drawn on top of the canvas at whatever
 *  screen position world-(0,0) currently sits at. Skipped entirely if
 *  the origin is outside the visible canvas rectangle, so it doesn't
 *  clutter panned-away views. Rendered as an overlay SVG so it sits
 *  above the heatmap without interfering with hit-testing. */
const OriginLabel = ({ toScreen, canvasSize, unit = 'mm' }) => {
    const p = toScreen({ x: 0, y: 0 });
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const margin = 16;
    if (p.x < -margin || p.y < -margin
        || p.x > canvasSize.w + margin
        || p.y > canvasSize.h + margin) return null;
    const r = 6;
    return (
        <svg className="fl-origin-marker" width={canvasSize.w} height={canvasSize.h}
             viewBox={`0 0 ${canvasSize.w} ${canvasSize.h}`} aria-hidden>
            {/* Short X tick at origin (positive-x direction) */}
            <line x1={p.x} y1={p.y} x2={p.x + r * 3} y2={p.y}
                  className="fl-origin-x" />
            {/* Short Y tick (positive-y direction = up = -screenY) */}
            <line x1={p.x} y1={p.y} x2={p.x} y2={p.y - r * 3}
                  className="fl-origin-y" />
            <circle cx={p.x} cy={p.y} r={3} className="fl-origin-dot" />
            <text x={p.x + 8} y={p.y + 12} className="fl-origin-label">
                (0, 0) {unit}
            </text>
        </svg>
    );
};

/* Floating color-scale legend, bottom-right of the canvas. Renders a
   vertical gradient strip with numeric ticks at 0 / ½ / max — the same
   affordance COMSOL / Star-CCM+ / Paraview put on every contour plot. */
const ColorLegend = ({ lut, vmin, vmax, label }) => {
    const W = 54, H = 160;
    const barW = 14;
    const x0 = 6;
    // Build a vertical gradient canvas from the LUT (inline as a data URL
    // via an SVG <image> would cost bandwidth; use a stack of 64 <rect>s
    // which is cheap and cleanly themeable).
    const steps = 64;
    const rects = [];
    for (let i = 0; i < steps; i++) {
        const t = 1 - i / (steps - 1); // top = max, bottom = min
        const idx = Math.max(0, Math.min(255, Math.round(t * 255)));
        const r = lut[3 * idx], g = lut[3 * idx + 1], b = lut[3 * idx + 2];
        rects.push(
            <rect key={i}
                x={x0}
                y={10 + (i / steps) * (H - 30)}
                width={barW}
                height={(H - 30) / steps + 0.5}
                fill={`rgb(${r},${g},${b})`}
            />
        );
    }
    const ticks = [
        { t: 1, v: vmax },
        { t: 0.5, v: (vmin + vmax) / 2 },
        { t: 0, v: vmin },
    ];
    return (
        <svg className="fl-legend" viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
            <rect x={0} y={0} width={W} height={H} className="fl-legend-bg" rx={4} />
            {rects}
            {ticks.map((tk, i) => {
                const y = 10 + (1 - tk.t) * (H - 30);
                return (
                    <g key={i}>
                        <line x1={x0 + barW} x2={x0 + barW + 4} y1={y} y2={y} className="fl-legend-tick" />
                        <text x={x0 + barW + 6} y={y + 3} className="fl-legend-label">
                            {tk.v.toExponential(1)}
                        </text>
                    </g>
                );
            })}
            <text x={W / 2} y={H - 4} className="fl-legend-title" textAnchor="middle">
                {label}
            </text>
        </svg>
    );
};

/* ── Inspector mini-components ─────────────────────────────
   These mirror SolidWorks' "Property Manager": select a vertex or an
   edge and dimensions become directly editable. Inputs commit on blur
   or Enter; they stay in sync with live geometry updates via `key` on
   the parent render and a light-weight local-input buffer. */

function useMmInput(initial_mm, unit, commit) {
    // Keep a string buffer so the user can type "1.2", "1.", etc. without
    // us stomping the caret via auto-roundtrip. Commits on blur / Enter.
    const [text, setText] = useState(() => toUnitText(initial_mm, unit));
    useEffect(() => { setText(toUnitText(initial_mm, unit)); }, [initial_mm, unit]);
    const flush = () => {
        const v = Number(text);
        if (Number.isFinite(v)) commit(unitToMm(v, unit));
        else setText(toUnitText(initial_mm, unit));
    };
    return {
        value: text,
        onChange: (e) => setText(e.target.value),
        onBlur: flush,
        onKeyDown: (e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } },
    };
}
function toUnitText(mm, unit) {
    const v = mmToUnit(mm, unit);
    return unit === 'mm' ? v.toFixed(3) : v.toFixed(1);
}

const VertexEditor = ({ entity, vertexIdx, unit, onChange }) => {
    const v = entity.points[vertexIdx];
    const xProps = useMmInput(v.x, unit, (x_mm) => onChange(x_mm, v.y));
    const yProps = useMmInput(v.y, unit, (y_mm) => onChange(v.x, y_mm));
    return (
        <div className="fl-props">
            <div className="fl-props-hd">Vertex #{vertexIdx}</div>
            <label className="fl-field fl-field-inset">
                <span>X ({UNIT_LABEL[unit]})</span>
                <input type="number" step={unit === 'mm' ? 0.05 : 5} {...xProps} />
            </label>
            <label className="fl-field fl-field-inset">
                <span>Y ({UNIT_LABEL[unit]})</span>
                <input type="number" step={unit === 'mm' ? 0.05 : 5} {...yProps} />
            </label>
            <div className="fl-props-hint">Edit coordinates to move this vertex exactly.</div>
        </div>
    );
};

const EdgeEditor = ({ entity, edgeIdx, unit, onSetStart, onSetEnd, onSetLength, onSetAngle }) => {
    const n = entity.points.length;
    const a = entity.points[edgeIdx];
    const b = entity.points[(edgeIdx + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len_mm = Math.hypot(dx, dy);
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const aXProps = useMmInput(a.x, unit, (x_mm) => onSetStart(x_mm, a.y));
    const aYProps = useMmInput(a.y, unit, (y_mm) => onSetStart(a.x, y_mm));
    const bXProps = useMmInput(b.x, unit, (x_mm) => onSetEnd(x_mm, b.y));
    const bYProps = useMmInput(b.y, unit, (y_mm) => onSetEnd(b.x, y_mm));
    const lenProps = useMmInput(len_mm, unit, (L_mm) => onSetLength(L_mm));
    const [angText, setAngText] = useState(angleDeg.toFixed(2));
    useEffect(() => { setAngText(angleDeg.toFixed(2)); }, [angleDeg]);
    const flushAng = () => {
        const v = Number(angText);
        if (Number.isFinite(v)) onSetAngle(v);
        else setAngText(angleDeg.toFixed(2));
    };
    return (
        <div className="fl-props">
            <div className="fl-props-hd">Edge #{edgeIdx}</div>
            <div className="fl-props-row">
                <label className="fl-field fl-field-inset">
                    <span>Start X ({UNIT_LABEL[unit]})</span>
                    <input type="number" step={unit === 'mm' ? 0.05 : 5} {...aXProps} />
                </label>
                <label className="fl-field fl-field-inset">
                    <span>Start Y ({UNIT_LABEL[unit]})</span>
                    <input type="number" step={unit === 'mm' ? 0.05 : 5} {...aYProps} />
                </label>
            </div>
            <div className="fl-props-row">
                <label className="fl-field fl-field-inset">
                    <span>End X ({UNIT_LABEL[unit]})</span>
                    <input type="number" step={unit === 'mm' ? 0.05 : 5} {...bXProps} />
                </label>
                <label className="fl-field fl-field-inset">
                    <span>End Y ({UNIT_LABEL[unit]})</span>
                    <input type="number" step={unit === 'mm' ? 0.05 : 5} {...bYProps} />
                </label>
            </div>
            <label className="fl-field fl-field-inset">
                <span>Length ({UNIT_LABEL[unit]})</span>
                <input type="number" min={0} step={unit === 'mm' ? 0.05 : 5} {...lenProps} />
            </label>
            <label className="fl-field fl-field-inset">
                <span>Angle (°)</span>
                <input type="number" step={0.5}
                    value={angText}
                    onChange={(e) => setAngText(e.target.value)}
                    onBlur={flushAng}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} />
            </label>
            <div className="fl-props-hint">Editing <b>Length</b> moves the end vertex along the current direction; <b>Angle</b> rotates it around the start.</div>
        </div>
    );
};

const EntityInfo = ({ entity, unit }) => {
    const n = entity.points.length;
    const closed = entity.closed !== false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, peri = 0;
    for (let i = 0; i < n; i++) {
        const p = entity.points[i];
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        if (closed || i < n - 1) {
            const q = entity.points[(i + 1) % n];
            peri += Math.hypot(q.x - p.x, q.y - p.y);
        }
    }
    return (
        <div className="fl-props">
            <div className="fl-props-hd">Entity · {closed ? 'closed region' : 'open polyline'}</div>
            <div className="fl-kv"><span>Vertices</span><span>{n}</span></div>
            <div className="fl-kv"><span>Bounding box W</span><span>{formatLength(maxX - minX, unit)}</span></div>
            <div className="fl-kv"><span>Bounding box H</span><span>{formatLength(maxY - minY, unit)}</span></div>
            <div className="fl-kv"><span>Perimeter</span><span>{formatLength(peri, unit)}</span></div>
            <div className="fl-props-hint">Click a <b>vertex</b> or an <b>edge</b> to edit dimensions.</div>
        </div>
    );
};

/* ──────────────────────────────────────────────────────────────
   FloatingPropertyDialog — glass-morphism property popup
   ──────────────────────────────────────────────────────────────
   Portal'd to `document.body` so it lives above all layout and
   isn't clipped by the canvas-wrap's overflow:hidden. The position
   is (a) re-computed from the world-space anchor on every viewport
   change, unless (b) the user has dragged it — then `userPos` wins
   until a new selection is made. A faint SVG leader line links the
   dialog back to its anchor so users always see what it refers to.
*/
const FloatingPropertyDialog = ({
    visible, canvasWrapRef, anchorWorld, toScreen,
    userPos, onDrag, onClose, title, children,
}) => {
    const [rect, setRect] = useState(null); // bounding rect of canvas-wrap in viewport coords
    const dialogRef = useRef(null);

    // Track the canvas-wrap's viewport rect (for scroll / resize / layout changes).
    useEffect(() => {
        if (!visible) return undefined;
        const el = canvasWrapRef?.current;
        if (!el) return undefined;
        const update = () => setRect(el.getBoundingClientRect());
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            ro.disconnect();
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [visible, canvasWrapRef]);

    if (!visible || !anchorWorld || !rect) return null;

    // Anchor position in viewport px.
    const anchorLocal = toScreen(anchorWorld);
    const anchorX = rect.left + anchorLocal.x;
    const anchorY = rect.top + anchorLocal.y;

    // Dialog target position (viewport px). Default: up-and-right of anchor.
    // If the user has dragged the dialog, `userPos` overrides auto-anchor.
    const dialogW = dialogRef.current?.offsetWidth || 260;
    const dialogH = dialogRef.current?.offsetHeight || 180;
    let left = userPos?.left ?? (anchorX + 22);
    let top = userPos?.top ?? (anchorY - 30);
    // Clamp into viewport with 8px margin.
    const vw = window.innerWidth, vh = window.innerHeight;
    left = Math.max(8, Math.min(vw - dialogW - 8, left));
    top = Math.max(8, Math.min(vh - dialogH - 8, top));

    // Leader-line from anchor to dialog's top-left corner.
    const leaderX1 = anchorX, leaderY1 = anchorY;
    const leaderX2 = left, leaderY2 = top + 14;

    const startDrag = (e) => {
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY;
        const base = { left, top };
        const onMove = (me) => {
            onDrag({ left: base.left + (me.clientX - sx), top: base.top + (me.clientY - sy) });
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };

    /* Confirm handler — commits any pending typing in the dialog's
       inputs before closing. Each input already auto-commits on blur
       (see useMmInput), so we just force-blur the focused element
       inside the dialog. A tiny 0 ms timeout lets React flush the
       value/commit before we unmount the portal. */
    const handleOk = () => {
        const active = document.activeElement;
        if (active && dialogRef.current && dialogRef.current.contains(active)) {
            active.blur();
        }
        // Defer close by one tick so the blur-triggered setState in the
        // input lands in the same batch — geometry stays in sync.
        setTimeout(() => onClose?.(), 0);
    };

    return createPortal(
        <>
            {/* Leader line (subtle, does not block mouse events). */}
            <svg
                className="fl-prop-leader"
                width={vw}
                height={vh}
                style={{ position: 'fixed', left: 0, top: 0, pointerEvents: 'none', zIndex: 1000 }}
            >
                <line
                    x1={leaderX1} y1={leaderY1}
                    x2={leaderX2} y2={leaderY2}
                    className="fl-prop-leader-line"
                />
                <circle cx={leaderX1} cy={leaderY1} r={4} className="fl-prop-leader-dot" />
            </svg>

            <div
                ref={dialogRef}
                className="fl-prop-dialog"
                style={{ left, top }}
                role="dialog"
                aria-label={`Properties for ${title}`}
                /* Pressing Enter anywhere inside the dialog (outside of
                   an already-committing input) also confirms and closes.
                   Inputs intercept Enter themselves via their own
                   onKeyDown, so this only fires when focus is on the
                   body/container itself. */
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.target === dialogRef.current || e.target.tagName !== 'INPUT')) {
                        e.preventDefault();
                        handleOk();
                    }
                }}
            >
                <div className="fl-prop-dialog-hd" onMouseDown={startDrag}>
                    <Move size={12} className="fl-prop-dialog-grip" />
                    <span className="fl-prop-dialog-title">{title}</span>
                    <button
                        type="button"
                        className="fl-prop-dialog-close"
                        onClick={onClose}
                        title="Close without confirming (Esc)"
                        aria-label="Close properties dialog"
                    >
                        <CloseIcon size={13} />
                    </button>
                </div>
                <div className="fl-prop-dialog-body">
                    {children}
                </div>
                <div className="fl-prop-dialog-footer">
                    <button
                        type="button"
                        className="fl-prop-dialog-btn fl-prop-dialog-btn-ok"
                        onClick={handleOk}
                        title="Apply changes and close (Enter)"
                    >
                        <Check size={13} /> OK
                    </button>
                </div>
            </div>
        </>,
        document.body,
    );
};

/* ─────────────────────────────────────────────────────────────────
   FileExplorerModal — the "Files" dialog for the Flow Lab workspace.

   Left column: virtual folder tree with expand/collapse chevrons.
   Right column: files inside the currently-selected folder, with
   per-file actions (Open, Rename, Move, Delete).  Both columns also
   include quick-add buttons (New folder, Save project here, Save
   result here) so the user can build up projects in any subfolder
   without leaving the dialog.

   Rendered with createPortal so z-index and overflow aren't affected
   by the main page layout. */
const FileExplorerModal = ({
    tree,
    cwd,
    onCwdChange,
    expanded,
    onExpandedChange,
    allFolderPaths,
    currentOpenFileId,
    onClose,
    onOpenFile,
    onCreateFolder,
    onRenameItem,
    onDeleteItem,
    onMoveFile,
    onSaveProjectHere,
    onSaveResultHere,
    hasField,
}) => {
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    /* Locate the folder node for the currently-browsed cwd (empty
       string = root). Breadth-first walk keeps this O(n). */
    const findFolder = (node, path) => {
        if (node.path === path) return node;
        for (const child of node.children || []) {
            const hit = findFolder(child, path);
            if (hit) return hit;
        }
        return null;
    };
    const cwdNode = findFolder(tree, cwd) || tree;

    const toggleExpanded = (path) => {
        const next = new Set(expanded);
        if (next.has(path)) next.delete(path); else next.add(path);
        onExpandedChange(next);
    };

    const iconForFile = (file) => {
        if (file._kind === 'result') return <Database size={13} className="fl-fx-ficon is-result" />;
        if (file._kind === 'project') return <FileText size={13} className="fl-fx-ficon is-project" />;
        return <FileText size={13} className="fl-fx-ficon" />;
    };

    const breadcrumb = cwd
        ? cwd.split('/').map((seg, i, arr) => {
            const path = arr.slice(0, i + 1).join('/');
            return (
                <React.Fragment key={path}>
                    <span className="fl-fx-crumb-sep">/</span>
                    <button className="fl-fx-crumb" onClick={() => onCwdChange(path)}>{seg}</button>
                </React.Fragment>
            );
          })
        : null;

    return createPortal(
        <div className="fl-fx-backdrop" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
            <div className="fl-fx-modal">
                <div className="fl-fx-hd">
                    <div className="fl-fx-title">
                        <FolderOpen size={16} /> Flow Lab — Files
                    </div>
                    <button className="fl-fx-close" onClick={onClose} title="Close (Esc)"><CloseIcon size={16} /></button>
                </div>

                <div className="fl-fx-toolbar">
                    <div className="fl-fx-breadcrumb">
                        <button className={`fl-fx-crumb ${cwd === '' ? 'is-active' : ''}`}
                            onClick={() => onCwdChange('')}
                            title="Flow Lab root">
                            <Folder size={13} /> Flow Lab
                        </button>
                        {breadcrumb}
                    </div>
                    <div className="fl-fx-toolbar-right">
                        <button className="fl-fx-btn"
                            onClick={() => onCreateFolder(cwd)}
                            title="Create a new sub-folder inside this location">
                            <FolderPlus size={13} /> New folder
                        </button>
                        <button className="fl-fx-btn fl-fx-btn-primary"
                            onClick={() => onSaveProjectHere(cwd)}
                            title="Save the current project as a new file here">
                            <Save size={13} /> Save project here
                        </button>
                        <button className="fl-fx-btn fl-fx-btn-accent"
                            onClick={() => onSaveResultHere(cwd)}
                            disabled={!hasField}
                            title={hasField ? 'Archive the current simulation result here' : 'Run the simulation first'}>
                            <Archive size={13} /> Save result here
                        </button>
                    </div>
                </div>

                <div className="fl-fx-body">
                    {/* ── Tree ── */}
                    <div className="fl-fx-tree">
                        <FolderTreeNode
                            node={tree}
                            depth={0}
                            cwd={cwd}
                            expanded={expanded}
                            onToggle={toggleExpanded}
                            onPick={onCwdChange}
                            isRoot
                        />
                    </div>

                    {/* ── File listing for cwd ── */}
                    <div className="fl-fx-list">
                        {(cwdNode.children.length === 0 && cwdNode.files.length === 0) ? (
                            <div className="fl-fx-empty">
                                <Folder size={28} />
                                <div>This folder is empty.</div>
                                <div className="fl-fx-empty-hint">
                                    Use <b>Save project here</b> or <b>Save result here</b> to drop files in this location,
                                    or <b>New folder</b> to add a sub-folder.
                                </div>
                            </div>
                        ) : (
                            <>
                                {cwdNode.children.map((child) => (
                                    <div key={`f-${child.path}`} className="fl-fx-row fl-fx-row-folder"
                                        onDoubleClick={() => onCwdChange(child.path)}>
                                        <Folder size={14} className="fl-fx-ficon is-folder" />
                                        <span className="fl-fx-name" onClick={() => onCwdChange(child.path)}>
                                            {child.name}
                                        </span>
                                        <span className="fl-fx-meta">
                                            {countDescendants(child)} item{countDescendants(child) === 1 ? '' : 's'}
                                        </span>
                                        <div className="fl-fx-row-actions">
                                            <button className="fl-icon-btn" onClick={() => onRenameItem(child)} title="Rename">
                                                <Edit3 size={12} />
                                            </button>
                                            <button className="fl-icon-btn fl-icon-btn-danger" onClick={() => onDeleteItem(child)} title="Delete folder & contents">
                                                <Trash2 size={12} />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                                {cwdNode.files.map((item) => (
                                    <FileRow
                                        key={`f-${item.path}`}
                                        item={item}
                                        icon={iconForFile(item.file)}
                                        isOpen={currentOpenFileId === item.file.id}
                                        allFolderPaths={allFolderPaths}
                                        currentDir={cwd}
                                        onOpen={() => onOpenFile(item.file)}
                                        onRename={() => onRenameItem(item)}
                                        onDelete={() => onDeleteItem(item)}
                                        onMove={(newDir) => onMoveFile(item.file, newDir)}
                                    />
                                ))}
                            </>
                        )}
                    </div>
                </div>

                <div className="fl-fx-footer">
                    <span className="fl-fx-legend">
                        <FileText size={11} /> Project &nbsp;·&nbsp; <Database size={11} /> Result
                    </span>
                    <span className="fl-fx-hint">Double-click a file to open · Esc to close</span>
                </div>
            </div>
        </div>,
        document.body,
    );
};

function countDescendants(node) {
    let n = node.files.length;
    for (const c of node.children) n += countDescendants(c) + 1; // +1 for the sub-folder itself
    return n;
}

const FolderTreeNode = ({ node, depth, cwd, expanded, onToggle, onPick, isRoot }) => {
    const isOpen = expanded.has(node.path) || isRoot;
    const selected = cwd === node.path;
    const hasChildren = node.children.length > 0;
    const count = node.files.length + node.children.length;
    return (
        <div>
            {/* Root gets a pseudo-row that is always visible */}
            <div
                className={`fl-fx-tree-row ${selected ? 'is-selected' : ''}`}
                style={{ paddingLeft: 6 + depth * 14 }}
                onClick={() => onPick(node.path)}
            >
                {hasChildren ? (
                    <button className="fl-fx-chev"
                        onClick={(e) => { e.stopPropagation(); onToggle(node.path); }}
                    >
                        {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    </button>
                ) : (
                    <span className="fl-fx-chev-placeholder" />
                )}
                <Folder size={12} className={`fl-fx-ficon is-folder ${isOpen ? 'is-open' : ''}`} />
                <span className="fl-fx-tree-name">{isRoot ? 'Flow Lab' : node.name}</span>
                {count > 0 && <span className="fl-fx-tree-badge">{count}</span>}
            </div>
            {isOpen && node.children.map((child) => (
                <FolderTreeNode
                    key={child.path}
                    node={child}
                    depth={depth + 1}
                    cwd={cwd}
                    expanded={expanded}
                    onToggle={onToggle}
                    onPick={onPick}
                />
            ))}
        </div>
    );
};

const FileRow = ({ item, icon, isOpen, allFolderPaths, currentDir, onOpen, onRename, onDelete, onMove }) => {
    const file = item.file;
    const savedAt = file.updatedAt || file.createdAt;
    const sizeKB = Number.isFinite(file.size) ? (file.size / 1024).toFixed(1) : '—';
    const when = savedAt ? new Date(savedAt).toLocaleString() : '—';
    const targets = allFolderPaths.filter((p) => p !== currentDir);
    return (
        <div className={`fl-fx-row ${isOpen ? 'is-open' : ''}`} onDoubleClick={onOpen}>
            {icon}
            <span className="fl-fx-name" onClick={onOpen}>
                {item.name}
                {isOpen && <span className="fl-fx-open-badge">open</span>}
            </span>
            <span className="fl-fx-meta">
                {file._kind === 'result' ? 'result' : 'project'} · {sizeKB} kB · {when}
            </span>
            <div className="fl-fx-row-actions">
                <button className="fl-icon-btn" onClick={onOpen} title="Open">
                    <ArrowRight size={12} />
                </button>
                {targets.length > 0 && (
                    <select
                        className="fl-fx-move"
                        value=""
                        onChange={(e) => { if (e.target.value !== '') onMove(e.target.value); }}
                        title="Move to folder…"
                    >
                        <option value="">Move…</option>
                        {targets.map((t) => (
                            <option key={t} value={t}>{t === '' ? '(root)' : t}</option>
                        ))}
                    </select>
                )}
                <button className="fl-icon-btn" onClick={onRename} title="Rename"><Edit3 size={12} /></button>
                <button className="fl-icon-btn" onClick={() => downloadFileToDisk(file)} title="Download as JSON">
                    <Download size={12} />
                </button>
                <button className="fl-icon-btn fl-icon-btn-danger" onClick={onDelete} title="Delete">
                    <Trash2 size={12} />
                </button>
            </div>
        </div>
    );
};

/* Export a single workspace file as a JSON blob — handy for backing
   up a project or sharing a result without the whole workspace. */
function downloadFileToDisk(file) {
    try {
        const payload = file.data ?? {};
        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = splitPath(file.name).base || file.name || 'flowlab.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
        console.error('download failed:', err);
    }
}

/* ───────────────────────────────────────────────────────────────────
 * Data Visualizer
 *
 * A dashboard-style modal that lets the user add / remove / reorder as
 * many charts as they want, each with independent metric selection
 * (concentration, velocity, or c·|u| flux) and per-series visibility
 * toggles. Chart data is computed once and shared across cards so
 * toggling series is O(1) — only the rendered <Line> set changes.
 * ─────────────────────────────────────────────────────────────────── */
const VIZ_METRIC_LABELS = {
    c: { title: 'Concentration c(t)', yLabel: 'c', short: 'c' },
    u: { title: 'Velocity |u|(t)',    yLabel: '|u|', short: '|u|' },
    cu:{ title: 'Flux c·|u|(t)',      yLabel: 'c·|u|', short: 'c·|u|' },
};
const VIZ_PALETTE = ['#60a5fa', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#fb923c', '#4ade80', '#22d3ee'];
let _vizPlotCounter = 0;
const makeVizPlot = (metric, keys) => {
    _vizPlotCounter += 1;
    return {
        id: `viz_${_vizPlotCounter}_${Math.random().toString(36).slice(2, 6)}`,
        title: VIZ_METRIC_LABELS[metric]?.title || metric,
        metric,
        /* Default all series visible. Sensor keys absent on construction
           (e.g. a probe added later in the run) will be added lazily in
           the per-plot legend effect. */
        series: Object.fromEntries(keys.map((k) => [k, true])),
    };
};

const DataVisualizerModal = ({ sensorHistory, speciesEnabled, onClose }) => {
    const keys = Object.keys(sensorHistory || {});

    /* Master time array — longest history wins so all sensors fit. */
    const masterKey = keys.length
        ? keys.reduce((a, b) => (sensorHistory[a].t_s.length >= sensorHistory[b].t_s.length ? a : b))
        : null;
    const timeArray = masterKey ? sensorHistory[masterKey].t_s : [];
    const tMaxAll = timeArray.length ? timeArray[timeArray.length - 1] : 0;

    const colorFor = useCallback((k) => {
        if (k === 'INLET') return '#94a3b8';
        const idx = Math.max(0, keys.indexOf(k));
        return VIZ_PALETTE[idx % VIZ_PALETTE.length];
    }, [keys]);

    /* Dashboard state — plots array is authoritative. */
    const [plots, setPlots] = useState(() => {
        const initial = [];
        if (speciesEnabled) initial.push(makeVizPlot('c', keys));
        initial.push(makeVizPlot('u', keys));
        return initial;
    });
    const [timeRangeS, setTimeRangeS] = useState(0);   // 0 = all
    const [columns, setColumns] = useState(1);
    const [showMarkers, setShowMarkers] = useState(false);
    const [smooth, setSmooth] = useState(true);
    const [logY, setLogY] = useState(false);

    /* Lazily fill in newly-appeared sensor keys on each render so if a
       user adds a point probe mid-run, the existing plots pick it up
       with visibility ON. */
    useEffect(() => {
        setPlots((prev) => {
            let changed = false;
            const next = prev.map((p) => {
                const missing = keys.filter((k) => !(k in p.series));
                if (!missing.length) return p;
                changed = true;
                const series = { ...p.series };
                for (const k of missing) series[k] = true;
                return { ...p, series };
            });
            return changed ? next : prev;
        });
    }, [keys.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

    const addPlot = useCallback((metric) => {
        setPlots((ps) => [...ps, makeVizPlot(metric, keys)]);
    }, [keys]);
    const removePlot = useCallback((id) => setPlots((ps) => ps.filter((p) => p.id !== id)), []);
    const movePlot = useCallback((id, dir) => setPlots((ps) => {
        const idx = ps.findIndex((p) => p.id === id);
        if (idx < 0) return ps;
        const j = idx + dir;
        if (j < 0 || j >= ps.length) return ps;
        const next = ps.slice();
        const [item] = next.splice(idx, 1);
        next.splice(j, 0, item);
        return next;
    }), []);
    const setPlotTitle = useCallback((id, title) => setPlots((ps) => ps.map((p) => (p.id === id ? { ...p, title } : p))), []);
    const setPlotMetric = useCallback((id, metric) => setPlots((ps) => ps.map((p) => (p.id === id ? { ...p, metric } : p))), []);
    const toggleSeries = useCallback((id, key) => setPlots((ps) => ps.map((p) => {
        if (p.id !== id) return p;
        return { ...p, series: { ...p.series, [key]: !(p.series[key] !== false) } };
    })), []);
    const setAllSeries = useCallback((id, on) => setPlots((ps) => ps.map((p) => {
        if (p.id !== id) return p;
        const series = {};
        for (const k of keys) series[k] = !!on;
        return { ...p, series };
    })), [keys]);

    /* Build chart rows once, with optional trailing-window filter. A
       single shared array feeds every plot — Recharts picks out the
       metric-specific dataKeys it needs. */
    const tCutoff = timeRangeS > 0 ? Math.max(0, tMaxAll - timeRangeS) : -Infinity;
    const chartData = useMemo(() => {
        if (!timeArray.length) return [];
        const out = [];
        for (let i = 0; i < timeArray.length; i++) {
            const t = timeArray[i];
            if (t < tCutoff) continue;
            const row = { t: Number(t.toFixed(4)) };
            for (const k of keys) {
                const arr = sensorHistory[k];
                if (!arr) continue;
                const idx = Math.min(i, arr.t_s.length - 1);
                const c = arr.c?.[idx];
                const u = arr.u?.[idx];
                if (Number.isFinite(c)) row[`${k}_c`] = c;
                if (Number.isFinite(u)) row[`${k}_u`] = u;
                if (Number.isFinite(c) && Number.isFinite(u)) row[`${k}_cu`] = c * u;
            }
            out.push(row);
        }
        return out;
    }, [timeArray, keys, sensorHistory, tCutoff]);

    if (keys.length === 0) return null;

    const cardHeightCss = columns === 1 ? 'min(62vh, 520px)' : 'min(50vh, 420px)';

    return createPortal(
        <div
            className="fl-fx-backdrop"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="fl-fx-modal fl-viz-modal">
                <div className="fl-fx-hd">
                    <div className="fl-fx-title">
                        <BarChart2 size={16} /> Data Visualizer
                        <span className="fl-viz-subtitle">
                            {plots.length} plot{plots.length === 1 ? '' : 's'} · {keys.length} series · {tMaxAll.toFixed(2)} s of data
                        </span>
                    </div>
                    <button className="fl-fx-close" onClick={onClose} aria-label="Close"><CloseIcon size={16} /></button>
                </div>

                <div className="fl-viz-toolbar">
                    <div className="fl-viz-tb-group">
                        <span className="fl-viz-tb-label">Add plot</span>
                        <button
                            type="button"
                            className="fl-viz-tb-btn"
                            onClick={() => addPlot('c')}
                            disabled={!speciesEnabled}
                            title={speciesEnabled ? 'Add a concentration c(t) plot' : 'Enable Species transport to plot concentration'}
                        >
                            <Plus size={12} /> c(t)
                        </button>
                        <button type="button" className="fl-viz-tb-btn" onClick={() => addPlot('u')} title="Add a velocity |u|(t) plot">
                            <Plus size={12} /> |u|(t)
                        </button>
                        <button
                            type="button"
                            className="fl-viz-tb-btn"
                            onClick={() => addPlot('cu')}
                            disabled={!speciesEnabled}
                            title={speciesEnabled ? 'Add a flux c·|u|(t) plot' : 'Enable Species transport to plot flux'}
                        >
                            <Plus size={12} /> c·|u|(t)
                        </button>
                    </div>

                    <div className="fl-viz-tb-group">
                        <label className="fl-viz-tb-field" title="Trailing window: show only the last N seconds of data. Useful for pulse close-ups.">
                            <span>Window</span>
                            <select value={timeRangeS} onChange={(e) => setTimeRangeS(Number(e.target.value))}>
                                <option value={0}>All</option>
                                <option value={1}>Last 1 s</option>
                                <option value={2}>Last 2 s</option>
                                <option value={5}>Last 5 s</option>
                                <option value={10}>Last 10 s</option>
                                <option value={30}>Last 30 s</option>
                            </select>
                        </label>
                        <label className="fl-viz-tb-field" title="Stack all plots in one column (easier comparison of same time axis) or side-by-side.">
                            <span><LayoutGrid size={11} /> Layout</span>
                            <select value={columns} onChange={(e) => setColumns(Number(e.target.value))}>
                                <option value={1}>1 column</option>
                                <option value={2}>2 columns</option>
                            </select>
                        </label>
                        <label className="fl-viz-tb-check" title="Render dots on each sample so individual data points are visible.">
                            <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} />
                            <span>Markers</span>
                        </label>
                        <label className="fl-viz-tb-check" title="Catmull-Rom smoothing between samples (monotone). Uncheck for raw step-accurate traces.">
                            <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} />
                            <span>Smooth</span>
                        </label>
                        <label className="fl-viz-tb-check" title="Use a log-scaled Y axis (useful for decay tails spanning orders of magnitude).">
                            <input type="checkbox" checked={logY} onChange={(e) => setLogY(e.target.checked)} />
                            <span>Log Y</span>
                        </label>
                    </div>
                </div>

                <div className={`fl-viz-body fl-viz-body--cols-${columns}`}>
                    {plots.length === 0 ? (
                        <div className="fl-viz-empty">
                            <BarChart2 size={28} />
                            <div className="fl-viz-empty-ttl">No plots yet</div>
                            <div className="fl-viz-empty-sub">Use the buttons above to add a concentration, velocity, or flux chart.</div>
                        </div>
                    ) : plots.map((p, pi) => {
                        const metricLabel = VIZ_METRIC_LABELS[p.metric] || { yLabel: p.metric };
                        const visibleKeys = keys.filter((k) => p.series[k] !== false);
                        return (
                            <div key={p.id} className="fl-viz-card">
                                <div className="fl-viz-card-hd">
                                    <input
                                        className="fl-viz-card-title"
                                        value={p.title}
                                        onChange={(e) => setPlotTitle(p.id, e.target.value)}
                                        spellCheck={false}
                                        aria-label="Plot title"
                                    />
                                    <div className="fl-viz-card-tools">
                                        <select
                                            value={p.metric}
                                            onChange={(e) => setPlotMetric(p.id, e.target.value)}
                                            className="fl-viz-metric-select"
                                            title="Metric plotted on the Y axis"
                                        >
                                            <option value="c" disabled={!speciesEnabled}>Concentration c</option>
                                            <option value="u">Velocity |u|</option>
                                            <option value="cu" disabled={!speciesEnabled}>Flux c·|u|</option>
                                        </select>
                                        <button
                                            type="button"
                                            className="fl-viz-card-iconbtn"
                                            onClick={() => movePlot(p.id, -1)}
                                            disabled={pi === 0}
                                            title="Move up"
                                            aria-label="Move plot up"
                                        >
                                            <ChevronUp size={13} />
                                        </button>
                                        <button
                                            type="button"
                                            className="fl-viz-card-iconbtn"
                                            onClick={() => movePlot(p.id, +1)}
                                            disabled={pi === plots.length - 1}
                                            title="Move down"
                                            aria-label="Move plot down"
                                        >
                                            <ChevronDown size={13} />
                                        </button>
                                        <button
                                            type="button"
                                            className="fl-viz-card-iconbtn fl-viz-card-iconbtn--danger"
                                            onClick={() => removePlot(p.id)}
                                            title="Remove plot"
                                            aria-label="Remove plot"
                                        >
                                            <Trash2 size={13} />
                                        </button>
                                    </div>
                                </div>

                                <div className="fl-viz-card-legend">
                                    <div className="fl-viz-legend-chips">
                                        {keys.map((k) => {
                                            const on = p.series[k] !== false;
                                            return (
                                                <button
                                                    type="button"
                                                    key={k}
                                                    className={`fl-viz-chip${on ? ' is-on' : ''}`}
                                                    onClick={() => toggleSeries(p.id, k)}
                                                    title={on ? `Hide ${sensorHistory[k].label || k}` : `Show ${sensorHistory[k].label || k}`}
                                                    style={{ '--viz-chip-color': colorFor(k) }}
                                                >
                                                    <span className="fl-viz-chip-dot" />
                                                    <span className="fl-viz-chip-label">{sensorHistory[k].label || k}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <div className="fl-viz-legend-tools">
                                        <button type="button" className="fl-viz-ghostbtn" onClick={() => setAllSeries(p.id, true)}>Show all</button>
                                        <button type="button" className="fl-viz-ghostbtn" onClick={() => setAllSeries(p.id, false)}>Hide all</button>
                                    </div>
                                </div>

                                <div className="fl-viz-card-chart" style={{ height: cardHeightCss }}>
                                    {visibleKeys.length === 0 ? (
                                        <div className="fl-viz-chart-empty">No series selected — click a chip above to show a sensor.</div>
                                    ) : (
                                        <ResponsiveContainer width="100%" height="100%">
                                            <LineChart data={chartData} margin={{ top: 8, right: 24, left: 8, bottom: 28 }}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color, #334155)" />
                                                <XAxis
                                                    dataKey="t"
                                                    type="number"
                                                    domain={['auto', 'auto']}
                                                    tickFormatter={(t) => `${Number(t).toFixed(2)}s`}
                                                    stroke="var(--text-muted, #94a3b8)"
                                                    label={{ value: 'time (s)', position: 'insideBottom', offset: -8, fill: 'var(--text-muted, #94a3b8)', fontSize: 11 }}
                                                />
                                                <YAxis
                                                    stroke="var(--text-muted, #94a3b8)"
                                                    scale={logY ? 'log' : 'auto'}
                                                    domain={logY ? ['auto', 'auto'] : ['auto', 'auto']}
                                                    allowDataOverflow={logY}
                                                    label={{ value: metricLabel.yLabel, angle: -90, position: 'insideLeft', fill: 'var(--text-muted, #94a3b8)', fontSize: 11 }}
                                                />
                                                <RechartsTooltip
                                                    contentStyle={{
                                                        backgroundColor: 'var(--bg-body, #0f172a)',
                                                        borderColor: 'var(--border-color, #334155)',
                                                        color: 'var(--text-bright, #f8fafc)',
                                                        fontSize: 12,
                                                    }}
                                                    labelFormatter={(t) => `t = ${Number(t).toFixed(4)} s`}
                                                    formatter={(value, name) => [Number(value).toExponential(3), name]}
                                                />
                                                <Legend verticalAlign="top" height={24} wrapperStyle={{ fontSize: 11 }} />
                                                {visibleKeys.map((k) => (
                                                    <Line
                                                        key={`${k}_${p.metric}`}
                                                        type={smooth ? 'monotone' : 'linear'}
                                                        dataKey={`${k}_${p.metric}`}
                                                        name={sensorHistory[k].label || k}
                                                        stroke={colorFor(k)}
                                                        strokeWidth={k === 'INLET' ? 1.5 : 2}
                                                        strokeDasharray={k === 'INLET' ? '5 5' : ''}
                                                        dot={showMarkers ? { r: 2 } : false}
                                                        activeDot={{ r: 4 }}
                                                        isAnimationActive={false}
                                                        connectNulls={false}
                                                    />
                                                ))}
                                            </LineChart>
                                        </ResponsiveContainer>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>,
        document.body
    );
};

export default FlowLabPage;
