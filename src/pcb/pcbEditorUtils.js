/**
 * Hit-testing, snapping, and geometry helpers for PCB Studio CAD.
 */

export function snapBoard(v, gridMm, snapToGrid) {
    const g = Number(gridMm) > 0 ? Number(gridMm) : 0.5;
    if (!snapToGrid) return Math.round(Number(v) * 1e6) / 1e6;
    return Math.round(Number(v) / g) * g;
}

function dist2(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}

/** Minimum distance from point P to segment AB (mm). */
export function distPointToSegment(px, py, ax, ay, bx, by) {
    const l2 = dist2(ax, ay, bx, by);
    if (l2 < 1e-18) return Math.sqrt(dist2(px, py, ax, ay));
    let t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * (bx - ax);
    const qy = ay + t * (by - ay);
    return Math.sqrt(dist2(px, py, qx, qy));
}

export function pickTrackAt(doc, mx, my, tolMm = 0.45) {
    const tracks = doc.tracks || [];
    for (let ti = tracks.length - 1; ti >= 0; ti--) {
        const tr = tracks[ti];
        const pts = tr.points || [];
        const halfW = (Number(tr.widthMm) || 0.35) / 2 + tolMm * 0.35;
        for (let i = 0; i < pts.length - 1; i++) {
            const d = distPointToSegment(mx, my, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
            if (d <= halfW + tolMm * 0.65) return tr;
        }
    }
    return null;
}

export function pickViaAt(doc, mx, my, tolMm = 0.55) {
    const vias = doc.vias || [];
    for (let i = vias.length - 1; i >= 0; i--) {
        const v = vias[i];
        const r = (Number(v.diamMm) || 0.8) / 2 + tolMm;
        if (dist2(mx, my, v.x, v.y) <= r * r) return v;
    }
    return null;
}

/** Point-in-polygon (even-odd); ring is treated as closed (last–first). */
export function pointInPolygon(px, py, pts) {
    if (!pts || pts.length < 3) return false;
    let inside = false;
    const n = pts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = pts[i][0];
        const yi = pts[i][1];
        const xj = pts[j][0];
        const yj = pts[j][1];
        const denom = yj - yi;
        const cross =
            (yi > py) !== (yj > py) &&
            px < (Math.abs(denom) < 1e-12 ? xi : ((xj - xi) * (py - yi)) / denom + xi);
        if (cross) inside = !inside;
    }
    return inside;
}

export function distPointToPolygonEdge(px, py, pts) {
    if (!pts || pts.length < 3) return Infinity;
    let dmin = Infinity;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = pts[i];
        const b = pts[j];
        dmin = Math.min(dmin, distPointToSegment(px, py, a[0], a[1], b[0], b[1]));
    }
    return dmin;
}

export function pickPolygonAt(doc, mx, my, tolMm = 0.4) {
    const polys = doc.polygons || [];
    for (let i = polys.length - 1; i >= 0; i--) {
        const p = polys[i];
        const pts = p.points || [];
        if (pts.length < 3) continue;
        if (pointInPolygon(mx, my, pts)) return p;
        if (distPointToPolygonEdge(mx, my, pts) <= tolMm) return p;
    }
    return null;
}

export function centroidClipboard(buf) {
    const xs = [];
    const ys = [];
    for (const p of buf.placements || []) {
        xs.push(p.x);
        ys.push(p.y);
    }
    for (const t of buf.tracks || []) {
        for (const pt of t.points || []) {
            xs.push(pt[0]);
            ys.push(pt[1]);
        }
    }
    for (const v of buf.vias || []) {
        xs.push(v.x);
        ys.push(v.y);
    }
    for (const po of buf.polygons || []) {
        for (const pt of po.points || []) {
            xs.push(pt[0]);
            ys.push(pt[1]);
        }
    }
    if (!xs.length) return [20, 20];
    const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
    return [cx, cy];
}
