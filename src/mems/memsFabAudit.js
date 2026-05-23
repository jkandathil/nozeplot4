/**
 * Fabric exchange snapshots — compare geometry counts, bounds, hierarchy, layer mapping.
 */

import { entityBBox } from './memsGeometry.js';

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

/** @param {object[]} entities */
function countEntityTypes(entities) {
    const c = {
        polygon: 0,
        rect: 0,
        ellipse: 0,
        line: 0,
        path: 0,
        text: 0,
        instance: 0,
        other: 0,
    };
    for (const e of entities || []) {
        const t = e?.type;
        if (t && Object.prototype.hasOwnProperty.call(c, t)) c[t]++;
        else c.other++;
    }
    return c;
}

/** @param {object} layer */
function layerKey(layer) {
    const m = layer.metadata || {};
    const gl = m.gdsLayer != null ? Number(m.gdsLayer) : null;
    const gd = m.gdsDatatype != null ? Number(m.gdsDatatype) : null;
    if (gl != null && Number.isFinite(gl) && gd != null && Number.isFinite(gd)) {
        return `gds:${gl}:${gd}`;
    }
    if (typeof layer.name === 'string' && layer.name.length > 0) {
        return `nm:${layer.name}`;
    }
    return `id:${layer.id}`;
}

/** @param {object} layer */
function layerBBoxUm(layer) {
    let b = null;
    for (const e of layer.entities || []) {
        const eb = entityBBox(e);
        if (eb) b = unionBBox(b, eb);
    }
    return b;
}

/** @param {object} cell */
function cellBBoxUm(cell) {
    let b = null;
    for (const L of cell.layers || []) {
        const lb = layerBBoxUm(L);
        if (lb) b = unionBBox(b, lb);
    }
    return b;
}

/** @param {object} cell */
function instanceSummary(cell) {
    const byMaster = new Map();
    let total = 0;
    for (const L of cell.layers || []) {
        for (const e of L.entities || []) {
            if (e.type !== 'instance') continue;
            total++;
            const masterId = e.masterCellId;
            byMaster.set(masterId, (byMaster.get(masterId) || 0) + 1);
        }
    }
    return {
        total,
        byMasterId: Object.fromEntries(byMaster),
    };
}

/**
 * Canonical snapshot for round-trip validation (IDs ignored; keys use GDS layer/datatype when present).
 * @param {object} doc
 */
export function fabricSnapshot(doc) {
    const cells = (doc.cells || []).map((c) => {
        /** @type {Record<string, { counts: object, bbox: object | null }>} */
        const layers = {};
        for (const L of c.layers || []) {
            layers[layerKey(L)] = {
                counts: countEntityTypes(L.entities),
                bbox: layerBBoxUm(L),
            };
        }
        return {
            name: c.name,
            kind: c.kind,
            bbox: cellBBoxUm(c),
            layers,
            instances: instanceSummary(c),
        };
    });

    let globalBBox = null;
    for (const c of doc.cells || []) {
        const bb = cellBBoxUm(c);
        if (bb) globalBBox = unionBBox(globalBBox, bb);
    }

    return {
        projectName: doc.project?.name,
        cells,
        globalBBox,
    };
}

function bboxClose(a, b, tolUm) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
        Math.abs(a.minX - b.minX) <= tolUm &&
        Math.abs(a.minY - b.minY) <= tolUm &&
        Math.abs(a.maxX - b.maxX) <= tolUm &&
        Math.abs(a.maxY - b.maxY) <= tolUm
    );
}

function countsClose(ca, cb) {
    const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
    for (const k of keys) {
        if ((ca[k] || 0) !== (cb[k] || 0)) return false;
    }
    return true;
}

function sumLayerCounts(cellSnap) {
    const t = {
        polygon: 0,
        rect: 0,
        ellipse: 0,
        line: 0,
        path: 0,
        text: 0,
        instance: 0,
        other: 0,
    };
    for (const k of Object.keys(cellSnap.layers || {})) {
        const c = cellSnap.layers[k]?.counts || {};
        for (const x of Object.keys(t)) {
            t[x] += c[x] || 0;
        }
    }
    return t;
}

/**
 * @param {ReturnType<fabricSnapshot>} before
 * @param {ReturnType<fabricSnapshot>} after
 * @param {{ tolUm?: number }} [opts]
 */
export function compareFabricSnapshots(before, after, opts = {}) {
    const tolUm = opts.tolUm ?? 0.25;
    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const warnings = [];

    if ((before.cells?.length || 0) !== (after.cells?.length || 0)) {
        errors.push(`Cell count mismatch: ${before.cells?.length} vs ${after.cells?.length}`);
    }

    const byNameAfter = new Map((after.cells || []).map((c) => [c.name, c]));

    for (const bc of before.cells || []) {
        const ac = byNameAfter.get(bc.name);
        if (!ac) {
            errors.push(`Missing cell after round-trip: “${bc.name}”`);
            continue;
        }
        if (!bboxClose(bc.bbox, ac.bbox, tolUm)) {
            warnings.push(`BBox drift for cell “${bc.name}”`);
        }

        const sb = sumLayerCounts(bc);
        const sa = sumLayerCounts(ac);
        if (!countsClose(sb, sa)) {
            errors.push(
                `Geometry totals differ for “${bc.name}”: ${JSON.stringify(sb)} vs ${JSON.stringify(sa)}`
            );
        }

        const ib = bc.instances?.total ?? 0;
        const ia = ac.instances?.total ?? 0;
        if (ib !== ia) {
            errors.push(`Instance count mismatch in “${bc.name}”: ${ib} vs ${ia}`);
        }
    }

    if (!bboxClose(before.globalBBox, after.globalBBox, tolUm * 2)) {
        warnings.push('Global bounding box drift');
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
    };
}

/**
 * @param {object} doc
 * @param {(d: object) => Uint8Array} exporter
 * @param {(buf: ArrayBuffer) => object} importer
 */
export function validateFabricRoundTrip(doc, exporter, importer) {
    const bytes = exporter(doc);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const copy = importer(ab);
    const a = fabricSnapshot(doc);
    const b = fabricSnapshot(copy);
    const cmp = compareFabricSnapshots(a, b);
    return { copy, bytes, snapshotBefore: a, snapshotAfter: b, ...cmp };
}
