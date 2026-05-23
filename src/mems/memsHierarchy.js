/**
 * Hierarchical MEMS layout: cell masters, placed instances (transform + array),
 * recursion with depth limits, and flattening for export/DRC.
 */

import { entityBBox, rotatePoint, hitEntity } from './memsGeometry.js';

export const MEMS_INSTANCE_MAX_DEPTH = 48;

/** Cap rows×cols so bbox loops / placement iteration cannot freeze the browser on hostile documents. */
export const MEMS_MAX_ARRAY_PLACEMENTS = 250000;

/**
 * Default ceiling for resolved primitives when flattening (DRC / export). Prevents OOM on wafer maps.
 * Callers may override via {@link flattenActiveCell} options.
 */
export const MEMS_FLATTEN_DEFAULT_MAX_ENTITIES = 750000;

/** Preview ghost mesh: max resolved primitives across all instances (wafer = many instances × die complexity). */
export const MEMS_GHOST_MAX_ENTITIES = 45000;

const DEG = Math.PI / 180;

/** @param {object} doc @param {string} cellId */
export function getCell(doc, cellId) {
    return doc?.cells?.find((c) => c.id === cellId);
}

/**
 * @returns {{ rows: number, cols: number, pitchXUm: number, pitchYUm: number }}
 */
export function normalizeInstanceArray(arr) {
    if (!arr || typeof arr !== 'object') {
        return { rows: 1, cols: 1, pitchXUm: 0, pitchYUm: 0 };
    }
    let rows = Math.max(1, Math.min(5000, Math.floor(Number(arr.rows) || 1)));
    let cols = Math.max(1, Math.min(5000, Math.floor(Number(arr.cols) || 1)));
    const n = rows * cols;
    if (n > MEMS_MAX_ARRAY_PLACEMENTS) {
        const f = Math.sqrt(MEMS_MAX_ARRAY_PLACEMENTS / n);
        rows = Math.max(1, Math.floor(rows * f));
        cols = Math.max(1, Math.floor(cols * f));
    }
    const pitchXUm = Number.isFinite(Number(arr.pitchXUm)) ? Number(arr.pitchXUm) : 0;
    const pitchYUm = Number.isFinite(Number(arr.pitchYUm)) ? Number(arr.pitchYUm) : 0;
    return { rows, cols, pitchXUm, pitchYUm };
}

/**
 * Placement origins in parent cell space (µm): base (inst.x, inst.y) + grid.
 * @returns {{ ox: number, oy: number }[]}
 */
export function instancePlacementOrigins(inst) {
    const { rows, cols, pitchXUm, pitchYUm } = normalizeInstanceArray(inst.array);
    const bx = Number(inst.x) || 0;
    const by = Number(inst.y) || 0;
    const out = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            out.push({ ox: bx + c * pitchXUm, oy: by + r * pitchYUm });
        }
    }
    return out;
}

/**
 * Map a vector from master cell local coordinates through instance mirror / scale / rotation.
 */
export function transformMasterVector(mx, my, inst) {
    let x = mx;
    let y = my;
    if (inst.mirrorX) x = -x;
    if (inst.mirrorY) y = -y;
    const sx = Number(inst.scaleX);
    const sy = Number(inst.scaleY);
    x *= Number.isFinite(sx) && sx !== 0 ? sx : 1;
    y *= Number.isFinite(sy) && sy !== 0 ? sy : 1;
    const rad = ((inst.rotationDeg ?? 0) * Math.PI) / 180;
    const rx = x * Math.cos(rad) - y * Math.sin(rad);
    const ry = x * Math.sin(rad) + y * Math.cos(rad);
    return { x: rx, y: ry };
}

export function masterPointToParent(mx, my, inst, ox, oy) {
    const t = transformMasterVector(mx, my, inst);
    return { x: ox + t.x, y: oy + t.y };
}

function unionBBox(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
    };
}

function bboxFromCorners(corners) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of corners) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
}

export function transformMasterBBoxToParent(b, inst, ox, oy) {
    if (!b) return null;
    const corners = [
        { x: b.minX, y: b.minY },
        { x: b.maxX, y: b.minY },
        { x: b.maxX, y: b.maxY },
        { x: b.minX, y: b.maxY },
    ].map(({ x, y }) => masterPointToParent(x, y, inst, ox, oy));
    return bboxFromCorners(corners);
}

/**
 * Map every coordinate in an entity through (mx,my) -> masterPointToParent(mx,my,inst,ox,oy).
 */
export function mapEntityThroughInstance(ent, inst, ox, oy) {
    const m = (x, y) => masterPointToParent(x, y, inst, ox, oy);
    if (ent.type === 'rect') {
        const deg = ent.rotationDeg || 0;
        const cx = ent.x + ent.width / 2;
        const cy = ent.y + ent.height / 2;
        const rad = deg * DEG;
        const corners = [
            { x: ent.x, y: ent.y },
            { x: ent.x + ent.width, y: ent.y },
            { x: ent.x + ent.width, y: ent.y + ent.height },
            { x: ent.x, y: ent.y + ent.height },
        ].map((p) => {
            const q = rotatePoint(p.x, p.y, cx, cy, rad);
            return m(q.x, q.y);
        });
        const bb = bboxFromCorners(corners);
        if (!bb) return null;
        return {
            ...ent,
            x: bb.minX,
            y: bb.minY,
            width: Math.max(0.01, bb.maxX - bb.minX),
            height: Math.max(0.01, bb.maxY - bb.minY),
            rotationDeg: (ent.rotationDeg ?? 0) + (inst.rotationDeg ?? 0),
        };
    }
    if (ent.type === 'polygon') {
        const pts = (ent.points || []).map((p) => m(p.x, p.y));
        const holes = (ent.holes || []).map((ring) => ring.map((p) => m(p.x, p.y)));
        return { ...ent, points: pts, ...(holes.length ? { holes } : {}) };
    }
    if (ent.type === 'ellipse') {
        const c0 = m(ent.cx, ent.cy);
        const sx = Math.abs(Number(inst.scaleX) || 1);
        const sy = Math.abs(Number(inst.scaleY) || 1);
        return {
            ...ent,
            cx: c0.x,
            cy: c0.y,
            rx: Math.max(0.01, ent.rx * sx),
            ry: Math.max(0.01, ent.ry * sy),
            rotationDeg: (ent.rotationDeg ?? 0) + (inst.rotationDeg ?? 0),
        };
    }
    if (ent.type === 'line') {
        const a = m(ent.x1, ent.y1);
        const b = m(ent.x2, ent.y2);
        return { ...ent, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    if (ent.type === 'path') {
        const pts = (ent.points || []).map((p) => m(p.x, p.y));
        return { ...ent, points: pts };
    }
    if (ent.type === 'text') {
        const p0 = m(ent.x, ent.y);
        return { ...ent, x: p0.x, y: p0.y };
    }
    return null;
}

/** Transform primitive entity from master local coords into parent cell space (one placement). */
export function transformPrimitiveFromMaster(ent, inst, ox, oy) {
    return mapEntityThroughInstance(ent, inst, ox, oy);
}

/**
 * Recursive bounding box of all drawable geometry in a cell (master space).
 */
export function cellContentBBoxUm(doc, cellId, depthLeft = MEMS_INSTANCE_MAX_DEPTH) {
    const cell = getCell(doc, cellId);
    if (!cell || depthLeft < 0) return null;
    let acc = null;
    for (const layer of cell.layers || []) {
        for (const e of layer.entities || []) {
            const eb =
                e.type === 'instance'
                    ? instanceBBoxInParentSpace(doc, e, depthLeft - 1)
                    : entityBBox(e);
            acc = unionBBox(acc, eb);
        }
    }
    return acc;
}

export function instanceBBoxInParentSpace(doc, inst, depthLeft = MEMS_INSTANCE_MAX_DEPTH) {
    if (!inst || inst.type !== 'instance') return null;
    const master = getCell(doc, inst.masterCellId);
    if (!master || depthLeft < 0) return null;
    const inner = cellContentBBoxUm(doc, inst.masterCellId, depthLeft);
    if (!inner) return null;
    const { rows, cols, pitchXUm, pitchYUm } = normalizeInstanceArray(inst.array);
    const n = rows * cols;
    const bx = Number(inst.x) || 0;
    const by = Number(inst.y) || 0;
    /** Rectangular grid: union AABB equals union at the four corner placements (same transformed footprint). */
    const origins =
        n > 48
            ? [
                  { ox: bx, oy: by },
                  { ox: bx + (cols - 1) * pitchXUm, oy: by },
                  { ox: bx, oy: by + (rows - 1) * pitchYUm },
                  { ox: bx + (cols - 1) * pitchXUm, oy: by + (rows - 1) * pitchYUm },
              ]
            : instancePlacementOrigins(inst);
    let acc = null;
    for (const { ox, oy } of origins) {
        const tb = transformMasterBBoxToParent(inner, inst, ox, oy);
        acc = unionBBox(acc, tb);
    }
    return acc;
}

/**
 * Expand instance to concrete primitives in parent cell coordinates.
 * @param {{ remaining: number } | null} budget When set, decrements per leaf primitive; stops early when exhausted.
 * @returns {{ entity: object, masterLayerIndex: number }[]}
 */
export function expandInstanceToWorldEntities(
    doc,
    inst,
    depthLeft = MEMS_INSTANCE_MAX_DEPTH,
    budget = null
) {
    if (!inst || inst.type !== 'instance' || depthLeft < 0) return [];
    if (budget && budget.remaining <= 0) return [];
    const master = getCell(doc, inst.masterCellId);
    if (!master) return [];

    /** @type {{ entity: object, masterLayerIndex: number }[]} */
    const out = [];

    placementLoop: for (const { ox, oy } of instancePlacementOrigins(inst)) {
        for (let li = 0; li < master.layers.length; li++) {
            const layer = master.layers[li];
            for (const e of layer.entities || []) {
                if (budget && budget.remaining <= 0) break placementLoop;
                if (e.type === 'instance') {
                    const inner = expandInstanceToWorldEntities(doc, e, depthLeft - 1, budget);
                    for (const row of inner) {
                        if (budget && budget.remaining <= 0) break placementLoop;
                        const mapped = mapEntityThroughInstance(row.entity, inst, ox, oy);
                        if (mapped) out.push({ entity: mapped, masterLayerIndex: li });
                    }
                } else {
                    const te = transformPrimitiveFromMaster(e, inst, ox, oy);
                    if (te) {
                        out.push({ entity: te, masterLayerIndex: li });
                        if (budget) budget.remaining--;
                    }
                }
            }
        }
    }
    return out;
}

/**
 * Flatten active cell instances into resolved geometry per layer.
 * @param {{ depth?: number, maxExpandedEntities?: number, metaOut?: { truncated?: boolean } }} [opts]
 */
export function flattenActiveCell(doc, opts = {}) {
    const depth = opts.depth ?? MEMS_INSTANCE_MAX_DEPTH;
    const maxEnt =
        opts.maxExpandedEntities !== undefined
            ? opts.maxExpandedEntities
            : MEMS_FLATTEN_DEFAULT_MAX_ENTITIES;
    const budget = Number.isFinite(maxEnt) && maxEnt > 0 ? { remaining: Math.floor(maxEnt) } : null;
    const cell = doc.cells?.find((c) => c.id === doc.activeCellId);
    if (!cell) return [];

    const layers = cell.layers || [];
    /** @type {Map<string, object[]>} */
    const byLayer = new Map();
    for (const l of layers) {
        byLayer.set(l.id, []);
    }

    const pushToMappedLayer = (masterLayerIndex, ent) => {
        const li = Math.min(Math.max(0, masterLayerIndex), layers.length - 1);
        const lid = layers[li].id;
        byLayer.get(lid).push(ent);
    };

    outer: for (let li = 0; li < layers.length; li++) {
        const layer = layers[li];
        for (const e of layer.entities || []) {
            if (budget && budget.remaining <= 0) break outer;
            if (e.type !== 'instance') {
                byLayer.get(layer.id).push({ ...e });
            } else {
                const expanded = expandInstanceToWorldEntities(doc, e, depth, budget);
                for (const { entity: ge, masterLayerIndex } of expanded) {
                    pushToMappedLayer(masterLayerIndex, { ...ge });
                }
            }
        }
    }

    if (opts.metaOut && typeof opts.metaOut === 'object') {
        opts.metaOut.truncated = !!(budget && budget.remaining <= 0);
    }

    return layers.map((l) => ({
        layerId: l.id,
        layerName: l.name,
        entities: byLayer.get(l.id) || [],
    }));
}

/**
 * Bounding box for entities including instances (parent cell space).
 */
export function resolvedEntityBBox(doc, e) {
    if (!e) return null;
    if (e.type === 'instance') return instanceBBoxInParentSpace(doc, e);
    return entityBBox(e);
}

/**
 * Hit-test including instance expansion (master geometry is authoritative).
 * Uses a modest expansion budget so wafer-scale layouts cannot freeze the UI on click.
 */
export function hitEntityResolved(doc, px, py, e, tol = 8) {
    if (!e) return false;
    if (e.type !== 'instance') return hitEntity(px, py, e, tol);
    const ib = instanceBBoxInParentSpace(doc, e);
    if (
        ib &&
        (px < ib.minX - tol || px > ib.maxX + tol || py < ib.minY - tol || py > ib.maxY + tol)
    ) {
        return false;
    }
    const budget = { remaining: 80000 };
    const parts = expandInstanceToWorldEntities(doc, e, MEMS_INSTANCE_MAX_DEPTH, budget);
    for (const { entity } of parts) {
        if (hitEntity(px, py, entity, tol)) return true;
    }
    return false;
}
