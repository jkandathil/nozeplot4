/**
 * Thermal Studio entity model.
 *
 * Vector CAD entities for the thermal studio. We piggy-back on Flow Lab's
 * geometry helpers (rect / circle / ellipse / polygon / polyline / arc) so
 * boolean ops, offsets, fillet, mirror / rotate, and SVG/DXF importers all
 * work transparently. The only addition is **per-entity material assignment**
 * and an optional **heater flag** so the rasterizer can build the solver's
 * material grid + heater mask.
 *
 * Coordinates are in micrometres (µm) — the natural scale for MEMS hotplate
 * geometry. Flow Lab's importers return mm-coordinate entities; callers
 * scale by 1000 before adding them here.
 *
 * Z-order:
 *   Entities are stored in an array; later entries paint over earlier ones
 *   (painter's algorithm). Use `bringToFront` / `sendToBack` to reorder.
 *
 * Entity shape (extends Flow Lab's `region`):
 *   {
 *     ...flowLabEntity,
 *     materialId: string,   // key into THERMAL_MATERIALS
 *     isHeater:   boolean,  // include this region in the heater mask
 *     thermalRole?: string, // optional label ('membrane', 'frame', ...)
 *   }
 */

import {
    createRectEntity as flCreateRect,
    createCircleEntity as flCreateCircle,
    createEllipseEntity as flCreateEllipse,
    createPolylineEntity as flCreatePolyline,
    createArcEntity as flCreateArc,
    booleanUnion as flBooleanUnion,
    booleanSubtract as flBooleanSubtract,
    booleanIntersect as flBooleanIntersect,
    booleanXor as flBooleanXor,
    offsetPolygon as flOffsetPolygon,
    filletVertex as flFilletVertex,
    translateEntity as flTranslate,
    rotateEntity as flRotate,
    mirrorEntity as flMirror,
    scaleEntity as flScale,
    pointInPolygon as flPointInPolygon,
    entitiesBBox as flEntitiesBBox,
    entitiesCentroid as flEntitiesCentroid,
    distToSegment as flDistToSegment,
    sampleArc3Point as flSampleArc3,
    updateShapeParams as flUpdateParams,
    polygonCentroid as flPolygonCentroid,
    signedArea as flSignedArea,
} from '../flowlab/geometry.js';
import { isHeaterMaterialIndex, materialIndex } from './materials.js';

/** Default material a new entity gets if none specified. */
const DEFAULT_MATERIAL = 'silicon';

/**
 * Tag a Flow-Lab entity with thermal metadata. Drops `edgeBC` (we don't model
 * per-edge thermal BCs at the entity level — global frame Dirichlet handles
 * the substrate sink, surfaces are bulk Robin sinks).
 *
 * @param {object} ent
 * @param {{ materialId?: string, isHeater?: boolean, thermalRole?: string }} [meta]
 */
export function tagAsThermal(ent, meta = {}) {
    if (!ent) return null;
    const materialId = meta.materialId || DEFAULT_MATERIAL;
    const isHeater =
        meta.isHeater !== undefined
            ? !!meta.isHeater
            : isHeaterMaterialIndex(materialIndex(materialId));
    return {
        ...ent,
        materialId,
        isHeater,
        thermalRole: meta.thermalRole,
    };
}

/** Rectangle entity in µm coordinates with a thermal material. */
export function createThermalRect(x0, y0, x1, y1, meta = {}) {
    return tagAsThermal(flCreateRect(x0, y0, x1, y1), meta);
}

/** Circle entity (cx, cy, r in µm). */
export function createThermalCircle(cx, cy, r, meta = {}) {
    const segments = meta.segments || Math.max(24, Math.min(96, Math.round(r / 5)));
    return tagAsThermal(flCreateCircle(cx, cy, r, segments), meta);
}

/** Ellipse via bbox corners. */
export function createThermalEllipse(x0, y0, x1, y1, meta = {}) {
    const ent = flCreateEllipse(x0, y0, x1, y1, meta.segments || 96);
    return ent ? tagAsThermal(ent, meta) : null;
}

/** Polygon (closed polyline) from explicit points. */
export function createThermalPolygon(points, meta = {}) {
    return tagAsThermal(flCreatePolyline(points, { closed: true }), meta);
}

/** Open polyline. Useful for heater traces — auto-buffered to a strip on rasterise. */
export function createThermalPolyline(points, meta = {}) {
    const ent = flCreatePolyline(points, { closed: false });
    return tagAsThermal(ent, { ...meta, openTraceWidthUm: meta.openTraceWidthUm ?? 8 });
}

/** Arc (open polyline). */
export function createThermalArc(cx, cy, r, a0, a1, meta = {}) {
    const ent = flCreateArc(cx, cy, r, a0, a1, meta.segments || 64);
    return ent ? tagAsThermal(ent, { ...meta, openTraceWidthUm: meta.openTraceWidthUm ?? 8 }) : null;
}

/** Two-point line (open polyline of two vertices). */
export function createThermalLine(p0, p1, meta = {}) {
    return createThermalPolyline([p0, p1], meta);
}

/* ──────────────────────────────────────────────────────────────────
 * Boolean / transform passthroughs that preserve thermal metadata.
 * Flow Lab's helpers already inherit `{ ...firstEntity }` — since we
 * spread-extend with `materialId`/`isHeater`, those propagate too.
 * We post-process to ensure the flag is consistent with the chosen
 * material index, in case the user changed it mid-stream.
 * ────────────────────────────────────────────────────────────────── */

/** Inherit thermal meta from `src` onto a freshly-built entity `ent`. */
function inheritThermal(ent, src) {
    if (!ent) return null;
    const materialId = src?.materialId || DEFAULT_MATERIAL;
    return {
        ...ent,
        materialId,
        isHeater: src?.isHeater ?? isHeaterMaterialIndex(materialIndex(materialId)),
        thermalRole: src?.thermalRole,
    };
}

export function thermalUnion(entities) {
    const out = flBooleanUnion(entities);
    return out.map((e) => inheritThermal(e, entities[0]));
}
export function thermalSubtract(entities) {
    const out = flBooleanSubtract(entities);
    return out.map((e) => inheritThermal(e, entities[0]));
}
export function thermalIntersect(entities) {
    const out = flBooleanIntersect(entities);
    return out.map((e) => inheritThermal(e, entities[0]));
}
export function thermalXor(entities) {
    const out = flBooleanXor(entities);
    return out.map((e) => inheritThermal(e, entities[0]));
}

export function thermalOffset(entity, distanceUm) {
    const out = flOffsetPolygon(entity, distanceUm);
    return out.map((e) => inheritThermal(e, entity));
}

export function thermalFilletVertex(entity, vertexIdx, radiusUm, segments = 16) {
    const out = flFilletVertex(entity, vertexIdx, radiusUm, segments);
    return out ? inheritThermal(out, entity) : entity;
}

export function thermalTranslate(entity, dx, dy) {
    return inheritThermal(flTranslate(entity, dx, dy), entity);
}
export function thermalRotate(entity, cx, cy, deg) {
    return inheritThermal(flRotate(entity, cx, cy, deg), entity);
}
export function thermalScale(entity, cx, cy, sx, sy = sx) {
    return inheritThermal(flScale(entity, cx, cy, sx, sy), entity);
}
export function thermalMirror(entity, a, b) {
    return inheritThermal(flMirror(entity, a, b), entity);
}

export function thermalUpdateShapeParams(entity, nextParams) {
    return inheritThermal(flUpdateParams(entity, nextParams), entity);
}

/* ──────────────────────────────────────────────────────────────────
 * Hit-testing helpers
 * ────────────────────────────────────────────────────────────────── */

/**
 * Hit-test a point (in µm) against an entity. Returns:
 *   { kind: 'inside' } if the point is inside a closed polygon,
 *   { kind: 'edge', edgeIdx, distance } if within `tolUm` of an edge,
 *   { kind: 'vertex', idx, distance } if within `tolUm` of a vertex,
 *   null otherwise.
 */
export function hitEntity(entity, x, y, tolUm) {
    if (!entity?.points?.length) return null;
    const pts = entity.points;
    let nearestVertex = { idx: -1, d: Infinity };
    for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - x, pts[i].y - y);
        if (d < nearestVertex.d) nearestVertex = { idx: i, d };
    }
    if (nearestVertex.d <= tolUm) {
        return { kind: 'vertex', idx: nearestVertex.idx, distance: nearestVertex.d };
    }
    let nearestEdge = { idx: -1, d: Infinity };
    const nEdges = entity.closed === false ? pts.length - 1 : pts.length;
    for (let i = 0; i < nEdges; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const d = flDistToSegment(x, y, a, b);
        if (d < nearestEdge.d) nearestEdge = { idx: i, d };
    }
    if (nearestEdge.d <= tolUm) {
        return { kind: 'edge', edgeIdx: nearestEdge.idx, distance: nearestEdge.d };
    }
    if (entity.closed !== false && flPointInPolygon(pts, x, y)) {
        return { kind: 'inside' };
    }
    return null;
}

/** Bounding box of an entity in µm (or null if degenerate). */
export function entityBBox(entity) {
    if (!entity?.points?.length) return null;
    let xmin = Infinity;
    let ymin = Infinity;
    let xmax = -Infinity;
    let ymax = -Infinity;
    for (const p of entity.points) {
        if (p.x < xmin) xmin = p.x;
        if (p.y < ymin) ymin = p.y;
        if (p.x > xmax) xmax = p.x;
        if (p.y > ymax) ymax = p.y;
    }
    if (!Number.isFinite(xmin)) return null;
    return { xmin, ymin, xmax, ymax };
}

/** All-entities bbox via Flow Lab's helper. */
export function allEntitiesBBox(entities) {
    if (!entities?.length) return null;
    return flEntitiesBBox(entities);
}

/** Centroid of all selected entities. Reuses Flow Lab's helper. */
export function entitiesCentroid(entities) {
    return flEntitiesCentroid(entities);
}

/** Polygon centroid passthrough (computed on the entity's `points`). */
export function entityCentroid(entity) {
    if (!entity?.points?.length) return null;
    return flPolygonCentroid(entity.points);
}

/** Signed area (closed polygons only). Negative for CW. */
export function entitySignedArea(entity) {
    if (!entity?.points?.length || entity.closed === false) return 0;
    return flSignedArea(entity.points);
}

export const sampleArc3Point = flSampleArc3;

/* ──────────────────────────────────────────────────────────────────
 * Electrothermal helpers: estimate the resistance of a heater entity
 * from its geometry + material electrical resistivity.
 * ────────────────────────────────────────────────────────────────── */

/** Total length (µm) of a polyline / chain of vertices. */
export function polylineLengthUm(entity) {
    if (!entity?.points || entity.points.length < 2) return 0;
    const pts = entity.points;
    let L = 0;
    const closed = entity.closed !== false;
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        L += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return L;
}

/**
 * Estimate the DC resistance (Ω) of a heater entity at reference T.
 *
 *   R = ρ · L / (w · t)        for an open-polyline coil (length L, width w, thickness t)
 *   R = ρ / t · (perimeter / 2) / w_eff   rough estimate for closed polygons (assume
 *                                          mean current-path = perimeter/2,
 *                                          mean cross-section ≈ √(area / perimeter))
 *
 * @param {object} entity                     thermal entity
 * @param {number} traceWidthUm               cross-section width (µm)
 * @param {number} thicknessUm                film thickness (µm)
 * @param {number} rhoElecOhmM                resistivity (Ω·m)
 * @returns {number|null}                     R (Ω) or null if undefined
 */
export function estimateEntityResistanceOhm(entity, traceWidthUm, thicknessUm, rhoElecOhmM) {
    if (!entity?.points?.length) return null;
    if (!(rhoElecOhmM > 0) || !(traceWidthUm > 0) || !(thicknessUm > 0)) return null;
    const tM = thicknessUm * 1e-6;
    const wM = traceWidthUm * 1e-6;
    if (entity.closed === false) {
        const Lum = polylineLengthUm(entity);
        if (!(Lum > 0)) return null;
        const Lm = Lum * 1e-6;
        return (rhoElecOhmM * Lm) / (wM * tM);
    }
    /* Closed polygon: rough estimate via perimeter / 2 as length, and trace
       width as the user-supplied w. Better than nothing for filled coils. */
    const Lum = polylineLengthUm(entity) / 2;
    if (!(Lum > 0)) return null;
    const Lm = Lum * 1e-6;
    return (rhoElecOhmM * Lm) / (wM * tM);
}
