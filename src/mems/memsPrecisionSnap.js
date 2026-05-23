/**
 * CAD-style snapping: grid + geometry features (endpoints, midpoints, centers,
 * segment projections, segment intersections). µm space.
 */

import { entityBBox, snapPoint } from './memsGeometry.js';
import { resolvedEntityBBox } from './memsHierarchy.js';
import { layoutLayers } from './memsMaskDoc.js';

const DEG = Math.PI / 180;

/** @param {[number,number,number,number][]} segments */
function segmentSegmentIntersection(ax, ay, bx, by, cx, cy, dx, dy) {
    const rx = bx - ax;
    const ry = by - ay;
    const sx = dx - cx;
    const sy = dy - cy;
    const denom = rx * sy - ry * sx;
    if (Math.abs(denom) < 1e-18) return null;
    const qx = cx - ax;
    const qy = cy - ay;
    const t = (qx * sy - qy * sx) / denom;
    const u = (qx * ry - qy * rx) / denom;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return { x: ax + t * rx, y: ay + t * ry };
}

/** Closest point on segment AB to P; returns { x, y, t } */
export function closestPointOnSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-30;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return { x: ax + t * dx, y: ay + t * dy, t };
}

function rotateCorners(rect) {
    const deg = rect.rotationDeg || 0;
    if (!deg) {
        return [
            { x: rect.x, y: rect.y },
            { x: rect.x + rect.width, y: rect.y },
            { x: rect.x + rect.width, y: rect.y + rect.height },
            { x: rect.x, y: rect.y + rect.height },
        ];
    }
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const rad = deg * DEG;
    const corners = [
        [rect.x, rect.y],
        [rect.x + rect.width, rect.y],
        [rect.x + rect.width, rect.y + rect.height],
        [rect.x, rect.y + rect.height],
    ];
    return corners.map(([x, y]) => {
        const lx = x - cx;
        const ly = y - cy;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return { x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos };
    });
}

/**
 * Snapping priority tier (lower = preferred). Vertex & corner before edge & grid.
 * @readonly
 */
export const SNAP_TIER_VERTEX = 0;
export const SNAP_TIER_FEATURE = 1;
export const SNAP_TIER_EDGE = 2;
export const SNAP_TIER_INTERSECTION = 3;
export const SNAP_TIER_GUIDE = 4;
export const SNAP_TIER_GRID = 5;

/** @typedef {{ x:number,y:number,sub:'v'|'m'|'c',label:string}} TaggedSnapPoint */

/**
 * @param {object} doc
 * @param {object} e entity
 * @param {(object) => object | null} bboxFn resolvedEntityBBox or entityBBox
 * @param {TaggedSnapPoint[]} outTagged
 * @param {[number,number,number,number][]} outSegs
 */
function pushEntityFeatures(doc, e, bboxFn, outTagged, outSegs, includeEdges) {
    if (!e) return;
    if (e.type === 'instance') {
        const b = bboxFn(doc, e);
        if (!b) return;
        outTagged.push(
            { x: b.minX, y: b.minY, sub: 'v', label: 'Corner' },
            { x: b.maxX, y: b.minY, sub: 'v', label: 'Corner' },
            { x: b.maxX, y: b.maxY, sub: 'v', label: 'Corner' },
            { x: b.minX, y: b.maxY, sub: 'v', label: 'Corner' },
            { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, sub: 'c', label: 'Center' }
        );
        return;
    }
    if (e.type === 'rect') {
        const corners = rotateCorners(e);
        corners.forEach((p) => outTagged.push({ x: p.x, y: p.y, sub: 'v', label: 'Corner' }));
        const cx = e.x + e.width / 2;
        const cy = e.y + e.height / 2;
        outTagged.push({ x: cx, y: cy, sub: 'c', label: 'Center' });
        if (includeEdges) {
            for (let i = 0; i < corners.length; i++) {
                const j = (i + 1) % corners.length;
                outSegs.push([corners[i].x, corners[i].y, corners[j].x, corners[j].y]);
            }
        }
        return;
    }
    if (e.type === 'ellipse') {
        const rad = (e.rotationDeg || 0) * DEG;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const ax = e.rx * cos;
        const ay = e.rx * sin;
        const bx = -e.ry * sin;
        const by = e.ry * cos;
        outTagged.push(
            { x: e.cx, y: e.cy, sub: 'c', label: 'Center' },
            { x: e.cx + ax, y: e.cy + ay, sub: 'v', label: 'Ellipse' },
            { x: e.cx - ax, y: e.cy - ay, sub: 'v', label: 'Ellipse' },
            { x: e.cx + bx, y: e.cy + by, sub: 'v', label: 'Ellipse' },
            { x: e.cx - bx, y: e.cy - by, sub: 'v', label: 'Ellipse' }
        );
        const samples = 24;
        let px = e.cx + e.rx * cos;
        let py = e.cy + e.rx * sin;
        for (let i = 1; i <= samples; i++) {
            const t = (i / samples) * 2 * Math.PI;
            const x0 = e.rx * Math.cos(t);
            const y0 = e.ry * Math.sin(t);
            const qx = e.cx + x0 * cos - y0 * sin;
            const qy = e.cy + x0 * sin + y0 * cos;
            if (includeEdges) outSegs.push([px, py, qx, qy]);
            px = qx;
            py = qy;
        }
        return;
    }
    if (e.type === 'line') {
        outTagged.push(
            { x: e.x1, y: e.y1, sub: 'v', label: 'Endpoint' },
            { x: e.x2, y: e.y2, sub: 'v', label: 'Endpoint' },
            { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2, sub: 'm', label: 'Midpoint' }
        );
        if (includeEdges) outSegs.push([e.x1, e.y1, e.x2, e.y2]);
        return;
    }
    if (e.type === 'path') {
        const pts = e.points || [];
        for (let i = 0; i < pts.length; i++) {
            outTagged.push({ x: pts[i].x, y: pts[i].y, sub: 'v', label: 'Path' });
        }
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            outTagged.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, sub: 'm', label: 'Midpoint' });
            if (includeEdges) outSegs.push([a.x, a.y, b.x, b.y]);
        }
        return;
    }
    if (e.type === 'polygon') {
        const outer = e.points || [];
        const rings = [outer, ...(e.holes || [])];
        for (const ring of rings) {
            if (ring.length < 2) continue;
            for (let i = 0; i < ring.length; i++) {
                outTagged.push({ x: ring[i].x, y: ring[i].y, sub: 'v', label: 'Vertex' });
            }
            for (let i = 0; i < ring.length; i++) {
                const j = (i + 1) % ring.length;
                const a = ring[i];
                const b = ring[j];
                outTagged.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, sub: 'm', label: 'Midpoint' });
                if (includeEdges) outSegs.push([a.x, a.y, b.x, b.y]);
            }
        }
        const b = entityBBox(e);
        if (b) {
            outTagged.push({
                x: (b.minX + b.maxX) / 2,
                y: (b.minY + b.maxY) / 2,
                sub: 'c',
                label: 'Center',
            });
        }
    }
}

function bboxFnResolved(doc, e) {
    return resolvedEntityBBox(doc, e);
}

/**
 * Build snap geometry from visible selectable layers in the active cell.
 * @returns {{ taggedPoints: TaggedSnapPoint[], segments: [number,number,number,number][] }}
 */
export function buildSnapIndex(doc, excludeEntityIds = new Set()) {
    /** @type {TaggedSnapPoint[]} */
    const taggedPoints = [];
    /** @type {[number,number,number,number][]} */
    const segments = [];

    for (const layer of layoutLayers(doc)) {
        if (!layer.visible || layer.selectable === false) continue;
        for (const e of layer.entities || []) {
            if (excludeEntityIds.has(e.id)) continue;
            pushEntityFeatures(doc, e, bboxFnResolved, taggedPoints, segments, true);
        }
    }

    return { taggedPoints, segments };
}

function subToSnapTier(sub) {
    if (sub === 'v') return SNAP_TIER_VERTEX;
    return SNAP_TIER_FEATURE;
}

/**
 * Keep segments whose expanded AABB may be within `pad` (µm) of (wx,wy).
 * @param {[number,number,number,number][]} segments
 */
function filterSegmentsNear(wx, wy, segments, pad) {
    if (segments.length < 4000) return segments;
    const out = [];
    for (const s of segments) {
        const [ax, ay, bx, by] = s;
        const minx = Math.min(ax, bx) - pad;
        const maxx = Math.max(ax, bx) + pad;
        const miny = Math.min(ay, by) - pad;
        const maxy = Math.max(ay, by) + pad;
        if (wx >= minx && wx <= maxx && wy >= miny && wy <= maxy) out.push(s);
    }
    return out.length ? out : segments;
}

function intersectPairsNear(segments, px, py, bandUm, maxPairs = 8000) {
    const out = [];
    const n = segments.length;
    let pairs = 0;
    for (let i = 0; i < n && pairs < maxPairs; i++) {
        const [ax, ay, bx, by] = segments[i];
        const mix = Math.min(ax, bx) - bandUm;
        const max = Math.max(ax, bx) + bandUm;
        const miy = Math.min(ay, by) - bandUm;
        const may = Math.max(ay, by) + bandUm;
        if (px < mix || px > max || py < miy || py > may) continue;
        for (let j = i + 1; j < n && pairs < maxPairs; j++) {
            const [cx, cy, dx, dy] = segments[j];
            const ip = segmentSegmentIntersection(ax, ay, bx, by, cx, cy, dx, dy);
            pairs++;
            if (!ip) continue;
            if (Math.abs(ip.x - px) <= bandUm && Math.abs(ip.y - py) <= bandUm) out.push(ip);
        }
    }
    return out;
}

function intersectPairsNearFiltered(segments, px, py, bandUm, maxPairs = 8000) {
    const narrow =
        segments.length > 8000
            ? filterSegmentsNear(px, py, segments, bandUm * 2)
            : segments;
    return intersectPairsNear(narrow, px, py, bandUm, maxPairs);
}

/**
 * Full snap with explicit priority: vertex → feature (mid/center) → edge → intersection → guide → grid.
 * All distances use world-space tolerance `tolUm` (µm).
 *
 * @returns {{
 *   x: number, y: number, snapped: boolean, tier: number, kind: string, distanceUm: number,
 *   fromGeometry: boolean
 * }}
 */
export function snapWorldDetail(wx, wy, doc, opts = {}) {
    const {
        gridUm = 10,
        gridEnabled = true,
        geometrySnapEnabled = true,
        guidesEnabled = true,
        tolUm = 12,
        snapEndpoint = true,
        snapMidpoint = true,
        snapCenter = true,
        snapIntersection = true,
        snapEdge = true,
        guidesH = [],
        guidesV = [],
        excludeEntityIds = new Set(),
        snapIndex: prebuiltIndex = null,
        /** @type {TaggedSnapPoint[]} */ extraTaggedPoints = [],
    } = opts;

    const tol = Math.max(0.5, tolUm);
    const tol2 = tol * tol;

    const idx = prebuiltIndex || buildSnapIndex(doc, excludeEntityIds);
    const tagged = [...(idx.taggedPoints || []), ...extraTaggedPoints];

    /** @type {{ tier: number, d2: number, x: number, y: number, kind: string, fromTag: boolean } | null} */
    let win = null;

    function beat(tier, d2, x, y, kind, fromTag) {
        if (d2 > tol2) return;
        if (
            !win ||
            tier < win.tier ||
            (tier === win.tier && d2 < win.d2 - 1e-18)
        ) {
            win = { tier, d2, x, y, kind, fromTag };
        }
    }

    if (geometrySnapEnabled) {
        for (const p of tagged) {
            if (p.sub === 'v' && !snapEndpoint) continue;
            if (p.sub === 'm' && !snapMidpoint) continue;
            if (p.sub === 'c' && !snapCenter) continue;
            const dx = wx - p.x;
            const dy = wy - p.y;
            beat(subToSnapTier(p.sub), dx * dx + dy * dy, p.x, p.y, p.label, true);
        }

        const segs =
            snapEdge || snapIntersection
                ? filterSegmentsNear(wx, wy, idx.segments, tol)
                : [];

        if (snapEdge) {
            for (const [ax, ay, bx, by] of segs) {
                const q = closestPointOnSegment(wx, wy, ax, ay, bx, by);
                const dx = wx - q.x;
                const dy = wy - q.y;
                beat(SNAP_TIER_EDGE, dx * dx + dy * dy, q.x, q.y, 'Edge', false);
            }
        }

        if (snapIntersection && idx.segments.length >= 2) {
            const band = tol * 4;
            const hits = intersectPairsNearFiltered(idx.segments, wx, wy, band);
            for (const p of hits) {
                const dx = wx - p.x;
                const dy = wy - p.y;
                beat(SNAP_TIER_INTERSECTION, dx * dx + dy * dy, p.x, p.y, 'Intersection', false);
            }
        }
    }

    if (guidesEnabled) {
        for (const gx of guidesV) {
            if (!Number.isFinite(gx)) continue;
            for (const gy of guidesH) {
                if (!Number.isFinite(gy)) continue;
                if (Math.abs(wx - gx) <= tol && Math.abs(wy - gy) <= tol) {
                    const dx = wx - gx;
                    const dy = wy - gy;
                    beat(SNAP_TIER_GUIDE, dx * dx + dy * dy, gx, gy, 'Guide ∩', false);
                }
            }
        }
        for (const gx of guidesV) {
            if (!Number.isFinite(gx)) continue;
            if (Math.abs(wx - gx) <= tol) {
                const dx = wx - gx;
                const dy = 0;
                beat(SNAP_TIER_GUIDE, dx * dx + dy * dy, gx, wy, 'Guide V', false);
            }
        }
        for (const gy of guidesH) {
            if (!Number.isFinite(gy)) continue;
            if (Math.abs(wy - gy) <= tol) {
                const dx = 0;
                const dy = wy - gy;
                beat(SNAP_TIER_GUIDE, dx * dx + dy * dy, wx, gy, 'Guide H', false);
            }
        }
    }

    let x = wx;
    let y = wy;
    let snapped = false;
    let tier = SNAP_TIER_GRID;
    let kind = 'Free';
    let fromGeometry = false;

    if (win) {
        let nx = win.x;
        let ny = win.y;
        snapped = true;
        tier = win.tier;
        kind = win.kind;
        fromGeometry = win.tier <= SNAP_TIER_INTERSECTION;

        if (gridEnabled && gridUm > 0 && !win.fromTag) {
            const g = snapPoint({ x: nx, y: ny }, gridUm);
            const dg = (nx - g.x) ** 2 + (ny - g.y) ** 2;
            if (dg <= tol2 * 0.25) {
                nx = g.x;
                ny = g.y;
                kind = `${win.kind} · grid`;
            }
        }
        x = nx;
        y = ny;
    } else if (gridEnabled && gridUm > 0) {
        const g = snapPoint({ x: wx, y: wy }, gridUm);
        x = g.x;
        y = g.y;
        tier = SNAP_TIER_GRID;
        kind = 'Grid';
        snapped = false;
    }

    const dist = snapped && win ? Math.sqrt(win.d2) : 0;

    return {
        x,
        y,
        snapped,
        tier,
        kind,
        distanceUm: snapped ? dist : Math.hypot(x - wx, y - wy),
        fromGeometry,
    };
}

/**
 * Full precision snap for world point (µm) — wrapper around {@link snapWorldDetail}.
 */
export function precisionSnapWorld(wx, wy, doc, opts = {}) {
    const r = snapWorldDetail(wx, wy, doc, {
        ...opts,
        geometrySnapEnabled: opts.geometrySnapEnabled !== false,
        guidesEnabled: opts.guidesEnabled !== false,
    });
    return { x: r.x, y: r.y, snapped: r.snapped };
}

/**
 * Axis / angle constraint from anchor to cursor.
 * Shift → orthogonal (horizontal or vertical dominant). Alt → snap angle to increments.
 */
export function constrainDragTarget(
    ox,
    oy,
    wx,
    wy,
    shiftKey,
    altKey,
    angleSnapDeg = 15
) {
    const dx = wx - ox;
    const dy = wy - oy;

    if (shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) {
            return { x: wx, y: oy };
        }
        return { x: ox, y: wy };
    }

    if (altKey && angleSnapDeg > 0) {
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) return { x: wx, y: wy };
        let ang = Math.atan2(dy, dx);
        const step = (angleSnapDeg * Math.PI) / 180;
        ang = Math.round(ang / step) * step;
        return { x: ox + len * Math.cos(ang), y: oy + len * Math.sin(ang) };
    }

    return { x: wx, y: wy };
}
