/**
 * Alignment and distribution for MEMS layout selections (µm).
 */

import { translateEntity } from './memsGeometry.js';
import { findEntity } from './memsMaskDoc.js';
import { resolvedEntityBBox } from './memsHierarchy.js';

/** Apply per-entity translations (µm). */
export function applyEntityMoves(doc, deltas) {
    if (!deltas?.length) return doc;
    const byId = new Map(deltas.map((d) => [d.entityId, d]));
    return {
        ...doc,
        cells: doc.cells.map((cell) => ({
            ...cell,
            layers: cell.layers.map((layer) => ({
                ...layer,
                entities: layer.entities.map((e) => {
                    const m = byId.get(e.id);
                    return m ? translateEntity(e, m.dx, m.dy) : e;
                }),
            })),
        })),
    };
}

function centroid(b) {
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/**
 * @param {object} doc
 * @param {{layerId:string,entityId:string}[]} refs
 * @returns {{ id: string, b: object, cx: number, cy: number }[]}
 */
export function selectionMetrics(doc, refs) {
    const out = [];
    for (const r of refs) {
        const hit = findEntity(doc, r.entityId);
        if (!hit) continue;
        const b = resolvedEntityBBox(doc, hit.entity);
        if (!b) continue;
        const c = centroid(b);
        out.push({ id: r.entityId, b, cx: c.x, cy: c.y });
    }
    return out;
}

/**
 * @param {'left'|'right'|'top'|'bottom'|'centerH'|'centerV'} mode
 * @returns {{ entityId: string, dx: number, dy: number }[]}
 */
export function computeAlignDeltas(doc, refs, mode) {
    const items = selectionMetrics(doc, refs);
    if (items.length < 2) return [];

    if (mode === 'left') {
        const t = Math.min(...items.map((x) => x.b.minX));
        return items.map((x) => ({ entityId: x.id, dx: t - x.b.minX, dy: 0 }));
    }
    if (mode === 'right') {
        const t = Math.max(...items.map((x) => x.b.maxX));
        return items.map((x) => ({ entityId: x.id, dx: t - x.b.maxX, dy: 0 }));
    }
    if (mode === 'top') {
        const t = Math.min(...items.map((x) => x.b.minY));
        return items.map((x) => ({ entityId: x.id, dx: 0, dy: t - x.b.minY }));
    }
    if (mode === 'bottom') {
        const t = Math.max(...items.map((x) => x.b.maxY));
        return items.map((x) => ({ entityId: x.id, dx: 0, dy: t - x.b.maxY }));
    }
    if (mode === 'centerH') {
        const mean =
            items.reduce((s, x) => s + x.cx, 0) / items.length;
        return items.map((x) => ({ entityId: x.id, dx: mean - x.cx, dy: 0 }));
    }
    if (mode === 'centerV') {
        const mean =
            items.reduce((s, x) => s + x.cy, 0) / items.length;
        return items.map((x) => ({ entityId: x.id, dx: 0, dy: mean - x.cy }));
    }
    return [];
}

/**
 * Equal spacing between bbox centers along X or Y (µm).
 * @param {'h'|'v'} axis
 */
export function computeDistributeCenters(doc, refs, axis) {
    const items = selectionMetrics(doc, refs);
    if (items.length < 3) return [];

    const sorted =
        axis === 'h'
            ? [...items].sort((a, b) => a.cx - b.cx)
            : [...items].sort((a, b) => a.cy - b.cy);

    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const n = sorted.length;

    /** @type {{ entityId: string, dx: number, dy: number }[]} */
    const deltas = [];

    if (axis === 'h') {
        const span = last.cx - first.cx;
        if (Math.abs(span) < 1e-9) return [];
        sorted.forEach((it, i) => {
            const target = first.cx + (span * i) / (n - 1);
            deltas.push({ entityId: it.id, dx: target - it.cx, dy: 0 });
        });
    } else {
        const span = last.cy - first.cy;
        if (Math.abs(span) < 1e-9) return [];
        sorted.forEach((it, i) => {
            const target = first.cy + (span * i) / (n - 1);
            deltas.push({ entityId: it.id, dx: 0, dy: target - it.cy });
        });
    }

    return deltas;
}

/**
 * Place sorted centers `gapUm` apart (gap between bbox edges).
 * @param {'h'|'v'} axis
 */
export function computeDistributeFixedGap(doc, refs, axis, gapUm) {
    const gap = Math.max(0, Number(gapUm) || 0);
    const items = selectionMetrics(doc, refs);
    if (items.length < 2) return [];

    const sorted =
        axis === 'h'
            ? [...items].sort((a, b) => a.cx - b.cx)
            : [...items].sort((a, b) => a.cy - b.cy);

    /** @type {{ entityId: string, dx: number, dy: number }[]} */
    const deltas = [];

    if (axis === 'h') {
        let cursor = sorted[0].b.minX;
        for (const it of sorted) {
            const w = it.b.maxX - it.b.minX;
            const targetCx = cursor + w / 2;
            deltas.push({ entityId: it.id, dx: targetCx - it.cx, dy: 0 });
            cursor += w + gap;
        }
    } else {
        let cursor = sorted[0].b.minY;
        for (const it of sorted) {
            const h = it.b.maxY - it.b.minY;
            const targetCy = cursor + h / 2;
            deltas.push({ entityId: it.id, dx: 0, dy: targetCy - it.cy });
            cursor += h + gap;
        }
    }

    return deltas;
}
