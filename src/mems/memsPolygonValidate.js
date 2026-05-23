/**
 * Lightweight polygon / polyline validation for interactive editing.
 */

const EPS = 1e-9;

/** @param {{x:number,y:number}} a @param {{x:number,y:number}} b @param {{x:number,y:number}} c @param {{x:number,y:number}} d */
function segmentsIntersectProper(a, b, c, d) {
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    if (o1 * o2 < -EPS && o3 * o4 < -EPS) return true;
    return false;
}

function orient(p, q, r) {
    return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

/**
 * Open polyline self-intersection: test only non-adjacent segments (excluding zero-length).
 * @param {{x:number,y:number}[]} pts open polyline vertices in order
 */
export function openPolylineSelfIntersects(pts) {
    if (!pts || pts.length < 4) return false;
    const n = pts.length;
    for (let i = 0; i < n - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-12) continue;
        for (let j = i + 2; j < n - 1; j++) {
            const c = pts[j];
            const d = pts[j + 1];
            if (Math.hypot(d.x - c.x, d.y - c.y) < 1e-12) continue;
            if (segmentsIntersectProper(a, b, c, d)) return true;
        }
    }
    return false;
}

/**
 * Closing segment (last → first) vs non-adjacent edges for a pending polygon ring.
 * @param {{x:number,y:number}[]} ring at least 3 vertices, not yet duplicated closing point
 */
export function closingSegmentCrosses(ring) {
    if (!ring || ring.length < 3) return false;
    const n = ring.length;
    const a = ring[n - 1];
    const b = ring[0];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-12) return false;
    for (let i = 0; i < n - 1; i++) {
        if (i === n - 2 || i === 0) continue;
        const c = ring[i];
        const d = ring[i + 1];
        if (segmentsIntersectProper(a, b, c, d)) return true;
    }
    return false;
}

/** Does new segment (last vertex → newPt) cross any earlier segment except the previous edge? */
export function newEdgeCrossesExistingOpen(pts, newPt) {
    if (!pts || pts.length < 2 || !newPt) return false;
    const a = pts[pts.length - 1];
    const b = newPt;
    for (let i = 0; i < pts.length - 2; i++) {
        if (segmentsIntersectProper(a, b, pts[i], pts[i + 1])) return true;
    }
    return false;
}

export function minSegmentLengthUm(pts, closed = false) {
    if (!pts || pts.length < 2) return Infinity;
    let m = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
        const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
        if (d < m) m = d;
    }
    if (closed && pts.length >= 3) {
        const a = pts[pts.length - 1];
        const b = pts[0];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d < m) m = d;
    }
    return m;
}
