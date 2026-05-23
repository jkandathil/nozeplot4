/**
 * High-precision 2D kernel for MEMS layout: Boolean ops (polygon-clipping),
 * offset / stroke expansion (Clipper), nm-scale coordinates.
 * Used by Mask Studio tools, future DRC / derived masks / MEMS export.
 */

import polygonClipping from 'polygon-clipping';
import ClipperLib from 'clipper-lib';
import { NM_PER_UM, umToNmInt, pointUmToNmPair, nmPairToPointUm, cleanRingNm } from './memsGeomPrecision.js';
import { entityToClosedRingsUm } from './memsShapeToRings.js';

/** @typedef {import('polygon-clipping').MultiPolygon} MultiPolygonNm */

/** Empty multipolygon (polygon-clipping shape). */
export function emptyMultiPolygon() {
    return /** @type {MultiPolygonNm} */ ([]);
}

/**
 * @param {MultiPolygonNm} mp
 * @returns {ClipperLib.Paths}
 */
function multiPolygonNmToClipperPaths(mp) {
    const paths = new ClipperLib.Paths();
    for (const poly of mp) {
        for (const ring of poly) {
            const path = new ClipperLib.Path();
            for (const [x, y] of ring) {
                path.push(new ClipperLib.IntPoint2(x, y));
            }
            path.push(path[0]);
            paths.push(path);
        }
    }
    return paths;
}

/**
 * Re-build nesting for Clipper offset solutions (rings may be unassociated).
 * @param {ClipperLib.Paths} paths
 * @returns {MultiPolygonNm}
 */
export function clipperPathsNmToMultiPolygonNm(paths) {
    if (!paths.length) return emptyMultiPolygon();
    const clpr = new ClipperLib.Clipper();
    clpr.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
    const pt = new ClipperLib.PolyTree();
    clpr.Execute(
        ClipperLib.ClipType.ctUnion,
        pt,
        ClipperLib.PolyFillType.pftNonZero,
        ClipperLib.PolyFillType.pftNonZero
    );
    const exp = ClipperLib.JS.PolyTreeToExPolygons(pt);
    /** @type {MultiPolygonNm} */
    const mp = [];
    for (let i = 0; i < exp.length; i++) {
        const outer = exp[i].outer.map((ip) => /** @type {[number, number]} */ ([ip.X, ip.Y]));
        const holes = exp[i].holes.map((h) => h.map((ip) => /** @type {[number, number]} */ ([ip.X, ip.Y])));
        mp.push([outer, ...holes]);
    }
    return mp;
}

/**
 * @param {import('./memsShapeToRings.js').TessellationResult['rings']} ringsUm
 * @param {'polygon'|'other'} mode
 */
export function ringsUmToMultiPolygonNm(ringsUm, mode) {
    if (!ringsUm.length) return emptyMultiPolygon();
    if (mode === 'polygon') {
        const nmPoly = ringsUm
            .map((r) => cleanRingNm(r.map((p) => pointUmToNmPair(p))))
            .filter((ring) => ring.length >= 3);
        if (!nmPoly.length || nmPoly[0].length < 3) return emptyMultiPolygon();
        return /** @type {MultiPolygonNm} */ ([nmPoly]);
    }
    /** @type {MultiPolygonNm} */
    const polys = [];
    for (const r of ringsUm) {
        const nm = cleanRingNm(r.map((p) => pointUmToNmPair(p)));
        if (nm.length >= 3) polys.push([nm]);
    }
    return polys;
}

/**
 * @param {object} e
 * @param {{ lineHalfWidthUm?: number, pathCapUm?: number }} [opts]
 * @returns {MultiPolygonNm}
 */
export function entityToMultiPolygonNm(e, opts = {}) {
    const { rings, skipped } = entityToClosedRingsUm(e, opts);
    if (!rings.length || skipped) return emptyMultiPolygon();
    if (e.type === 'polygon') {
        return ringsUmToMultiPolygonNm(rings, 'polygon');
    }
    return ringsUmToMultiPolygonNm(rings, 'other');
}

/**
 * Union tessellations of many entities (possibly spanning layers).
 * @param {object[]} entities
 * @param {{ lineHalfWidthUm?: number, pathCapUm?: number }} [opts]
 */
export function entitiesToUnionMultiPolygonNm(entities, opts = {}) {
    /** @type {MultiPolygonNm} */
    let acc = emptyMultiPolygon();
    for (const e of entities) {
        const mp = entityToMultiPolygonNm(e, opts);
        if (!mp.length) continue;
        acc = acc.length === 0 ? mp : polygonClipping.union(acc, mp);
    }
    return acc;
}

/**
 * @param {MultiPolygonNm[]} parts
 */
export function unionMultiPolygonsNm(parts) {
    const filtered = parts.filter((p) => p && p.length);
    if (!filtered.length) return emptyMultiPolygon();
    let acc = filtered[0];
    for (let i = 1; i < filtered.length; i++) {
        acc = polygonClipping.union(acc, filtered[i]);
    }
    return acc;
}

/**
 * @param {MultiPolygonNm} mpNm
 * @returns {{ points: { x:number,y:number }[], holes?: { x:number,y:number }[][] }[]}
 */
export function multiPolygonNmToPolygonSpecsUm(mpNm) {
    const specs = [];
    for (const poly of mpNm) {
        if (!poly.length) continue;
        const outerNm = poly[0];
        const holeNm = poly.slice(1);
        const points = outerNm.map(nmPairToPointUm);
        const holes = holeNm.map((ring) => ring.map(nmPairToPointUm));
        specs.push({
            points,
            ...(holes.length ? { holes } : {}),
        });
    }
    return specs;
}

/**
 * Self-intersection cleanup: dissolve into simple polygons (union components).
 * @param {MultiPolygonNm} mpNm
 */
export function sanitizeMultiPolygonNm(mpNm) {
    if (!mpNm.length) return emptyMultiPolygon();
    let acc = emptyMultiPolygon();
    for (const poly of mpNm) {
        if (!poly.length) continue;
        acc = acc.length === 0 ? [poly] : polygonClipping.union(acc, [poly]);
    }
    return acc;
}

/**
 * @typedef {{
 *   miterLimit?: number,
 *   arcToleranceUm?: number,
 * }} OffsetOpts
 */

/**
 * Grow (>0) or shrink (<0) multipolygon boundaries in nm integer space (stable).
 * @param {MultiPolygonNm} mpNm
 * @param {number} deltaUm offset distance (µm); sign = side
 * @param {OffsetOpts} [opts]
 */
export function offsetMultiPolygonNm(mpNm, deltaUm, opts = {}) {
    if (!mpNm.length) return emptyMultiPolygon();
    const deltaNm = umToNmInt(deltaUm);
    if (deltaNm === 0) return sanitizeMultiPolygonNm(mpNm);

    const miter = opts.miterLimit ?? 2;
    const arcTolNm = umToNmInt(opts.arcToleranceUm ?? 0.25);

    const paths = multiPolygonNmToClipperPaths(mpNm);
    const co = new ClipperLib.ClipperOffset(miter, arcTolNm);
    for (let i = 0; i < paths.length; i++) {
        co.AddPath(paths[i], ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
    }
    const sol = new ClipperLib.Paths();
    co.Execute(sol, deltaNm);
    return clipperPathsNmToMultiPolygonNm(sol);
}

/** Offset the union of tessellated entities (single merged boundary). */
export function offsetUnionEntitiesNm(entities, deltaUm, opts) {
    const mp = entitiesToUnionMultiPolygonNm(entities, opts);
    return offsetMultiPolygonNm(mp, deltaUm, opts);
}

/** Offset each entity independently, then merge (disjoint selections stay disjoint). */
export function offsetEntitiesCombinedNm(entities, deltaUm, opts) {
    /** @type {MultiPolygonNm} */
    let acc = emptyMultiPolygon();
    for (const e of entities) {
        const mp = entityToMultiPolygonNm(e, opts);
        if (!mp.length) continue;
        const off = offsetMultiPolygonNm(mp, deltaUm, opts);
        acc = acc.length === 0 ? off : polygonClipping.union(acc, off);
    }
    return sanitizeMultiPolygonNm(acc);
}

/**
 * Expand open path (µm vertices) to filled polygon multipolygon (round joins, open ends).
 * @param {{ x:number,y:number }[]} pointsUm
 * @param {number} halfWidthUm
 * @param {OffsetOpts} [opts]
 */
export function openPathToMultiPolygonNm(pointsUm, halfWidthUm, opts = {}) {
    if (!pointsUm || pointsUm.length < 2 || halfWidthUm <= 0) return emptyMultiPolygon();
    const path = new ClipperLib.Path();
    for (const p of pointsUm) {
        path.push(new ClipperLib.IntPoint2(umToNmInt(p.x), umToNmInt(p.y)));
    }
    const miter = opts.miterLimit ?? 2;
    const arcTolNm = umToNmInt(opts.arcToleranceUm ?? 0.25);
    const co = new ClipperLib.ClipperOffset(miter, arcTolNm);
    co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound);
    const sol = new ClipperLib.Paths();
    co.Execute(sol, umToNmInt(halfWidthUm));
    return clipperPathsNmToMultiPolygonNm(sol);
}

/**
 * Boolean combine entity tessellations (µm → nm internally).
 * @param {'union'|'intersection'|'difference'|'xor'} op
 * @param {object[]} subjectEntities ordered — difference uses subjectEntities[0] minus union(rest)
 * @param {object[]} [clipEntities] for explicit two-group ops (optional)
 * @param {{ lineHalfWidthUm?: number, pathCapUm?: number }} [opts]
 */
export function booleanEntitiesNm(op, subjectEntities, clipEntities, opts = {}) {
    const subs = clipEntities != null ? clipEntities : subjectEntities.slice(1);
    const subj =
        clipEntities != null
            ? entitiesToUnionMultiPolygonNm(subjectEntities, opts)
            : subjectEntities.length
              ? entityToMultiPolygonNm(subjectEntities[0], opts)
              : emptyMultiPolygon();
    const clip =
        clipEntities != null
            ? entitiesToUnionMultiPolygonNm(clipEntities, opts)
            : subs.length
              ? entitiesToUnionMultiPolygonNm(subs, opts)
              : emptyMultiPolygon();

    let result;
    switch (op) {
        case 'union':
            result = unionMultiPolygonsNm(
                subjectEntities.map((e) => entityToMultiPolygonNm(e, opts)).filter((m) => m.length)
            );
            break;
        case 'intersection':
            if (clipEntities != null) {
                result =
                    subj.length && clip.length ? polygonClipping.intersection(subj, clip) : emptyMultiPolygon();
            } else {
                const mps = subjectEntities
                    .map((e) => entityToMultiPolygonNm(e, opts))
                    .filter((m) => m.length);
                if (mps.length < 2) result = emptyMultiPolygon();
                else {
                    let acc = mps[0];
                    for (let i = 1; i < mps.length; i++) acc = polygonClipping.intersection(acc, mps[i]);
                    result = acc;
                }
            }
            break;
        case 'difference':
            if (!subj.length) result = emptyMultiPolygon();
            else if (!clip.length) result = subj;
            else result = polygonClipping.difference(subj, clip);
            break;
        case 'xor':
            if (clipEntities != null) {
                result =
                    subj.length && clip.length ? polygonClipping.xor(subj, clip) : subj.length ? subj : clip;
            } else {
                const mps = subjectEntities
                    .map((e) => entityToMultiPolygonNm(e, opts))
                    .filter((m) => m.length);
                if (mps.length < 2) result = emptyMultiPolygon();
                else {
                    let acc = mps[0];
                    for (let i = 1; i < mps.length; i++) acc = polygonClipping.xor(acc, mps[i]);
                    result = acc;
                }
            }
            break;
        default:
            result = emptyMultiPolygon();
    }
    return sanitizeMultiPolygonNm(result);
}

/** Public constants for callers / tests. */
export const GEOMETRY_KERNEL = {
    NM_PER_UM,
    umToNmInt,
};

/**
 * Planar polygon booleans supported by {@link booleanEntitiesNm} (polygon-clipping).
 * Union / intersect / subtract / XOR cover the usual mask-layout CAD set.
 */
export const MEMS_PLANAR_BOOLEAN_OPS = /** @type {const} */ ([
    'union',
    'intersection',
    'difference',
    'xor',
]);

export { pathStrokeAsRingsUm, entityToClosedRingsUm } from './memsShapeToRings.js';
