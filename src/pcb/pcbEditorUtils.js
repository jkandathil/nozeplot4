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

/**
 * True if segment AB intersects the closed axis-aligned rectangle [minX,maxX]×[minY,maxY] (mm).
 * Used for marquee / box selection of tracks and polygon edges.
 */
export function segmentIntersectsAabb(ax, ay, bx, by, minX, maxX, minY, maxY) {
    const inside = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
    if (inside(ax, ay) || inside(bx, by)) return true;
    const sMinX = Math.min(ax, bx);
    const sMaxX = Math.max(ax, bx);
    const sMinY = Math.min(ay, by);
    const sMaxY = Math.max(ay, by);
    if (sMaxX < minX || sMinX > maxX || sMaxY < minY || sMinY > maxY) return false;

    const crossVertical = (xLine) => {
        if (Math.abs(bx - ax) < 1e-12) return false;
        const t = (xLine - ax) / (bx - ax);
        if (t < 0 || t > 1) return false;
        const y = ay + t * (by - ay);
        return y >= minY && y <= maxY;
    };
    const crossHorizontal = (yLine) => {
        if (Math.abs(by - ay) < 1e-12) return false;
        const t = (yLine - ay) / (by - ay);
        if (t < 0 || t > 1) return false;
        const x = ax + t * (bx - ax);
        return x >= minX && x <= maxX;
    };
    return crossVertical(minX) || crossVertical(maxX) || crossHorizontal(minY) || crossHorizontal(maxY);
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

const SQRT2 = Math.SQRT2;

function hypot2(dx, dy) {
    return Math.hypot(dx, dy);
}

/** Eight unit directions: axis + 45° diagonals (Eagle/KiCad octilinear style). */
function buildOctilinearDirs(prev, last) {
    const dirs = [];
    const lx = last[0];
    const ly = last[1];
    if (!prev || hypot2(lx - prev[0], ly - prev[1]) < 1e-9) {
        for (let k = 0; k < 8; k++) {
            const a = (k * Math.PI) / 4;
            dirs.push([Math.cos(a), Math.sin(a)]);
        }
        return dirs;
    }
    const base = Math.atan2(ly - prev[1], lx - prev[0]);
    for (let k = 0; k < 8; k++) {
        const a = base + (k * Math.PI) / 4;
        dirs.push([Math.cos(a), Math.sin(a)]);
    }
    return dirs;
}

/** Distance along ray from `last` with unit `dir` so endpoint lands on grid (last on grid). */
function gridStepAlongUnitRay(dir, gridMm) {
    const ax = Math.abs(dir[0]);
    const ay = Math.abs(dir[1]);
    if (ax < 1e-9 || ay < 1e-9) return gridMm;
    if (Math.abs(ax - ay) < 1e-9) return gridMm * SQRT2;
    return gridMm;
}

/**
 * KiCad/Eagle-style interactive routing: next vertex on a ray from `last` in one of eight
 * directions (world octagon if no prior segment, else 45° steps relative to `prev → last`).
 * With grid snap, distance along the ray is quantized so H/V and 45° legs stay on-grid.
 * Set `opts.routeFreeAngle: true` for legacy arbitrary-angle + per-axis grid snap at call site.
 *
 * @param {number[] | null} prev previous polyline vertex [x,y] or null
 * @param {number[]} last current endpoint [x,y]
 * @param {number} cx cursor x (mm)
 * @param {number} cy cursor y (mm)
 * @param {{ gridMm?: number, snapToGrid?: boolean, routeFreeAngle?: boolean }} [opts]
 * @returns {[number, number]}
 */
export function snapInteractiveRoutePoint(prev, last, cx, cy, opts = {}) {
    const gridMm = Number(opts.gridMm) > 0 ? Number(opts.gridMm) : 0.5;
    const snapToGrid = opts.snapToGrid !== false;
    if (opts.routeFreeAngle === true) {
        let x = cx;
        let y = cy;
        if (snapToGrid) {
            x = snapBoard(x, gridMm, true);
            y = snapBoard(y, gridMm, true);
        }
        return [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6];
    }

    const lx = last[0];
    const ly = last[1];
    const vx = cx - lx;
    const vy = cy - ly;

    let prevUx = 1;
    let prevUy = 0;
    if (prev) {
        const plx = lx - prev[0];
        const ply = ly - prev[1];
        const plen = hypot2(plx, ply);
        if (plen > 1e-9) {
            prevUx = plx / plen;
            prevUy = ply / plen;
        }
    }

    const dirs = buildOctilinearDirs(prev, last);
    let bestX = lx;
    let bestY = ly;
    let bestCost = Infinity;
    let bestTie = -Infinity;

    for (const dir of dirs) {
        const tRaw = vx * dir[0] + vy * dir[1];
        if (tRaw < -1e-7) continue;

        let t;
        if (snapToGrid) {
            const step = gridStepAlongUnitRay(dir, gridMm);
            let n = Math.round(tRaw / step);
            if (n < 1 && tRaw > step * 0.08) n = 1;
            if (n < 1) continue;
            t = n * step;
        } else {
            t = Math.max(0, tRaw);
            if (t < 1e-9) continue;
        }

        const px = lx + t * dir[0];
        const py = ly + t * dir[1];
        const dx = px - cx;
        const dy = py - cy;
        const cost = dx * dx + dy * dy;
        const tie = dir[0] * prevUx + dir[1] * prevUy;
        if (cost < bestCost - 1e-12 || (Math.abs(cost - bestCost) < 1e-12 && tie > bestTie)) {
            bestCost = cost;
            bestTie = tie;
            bestX = px;
            bestY = py;
        }
    }

    if (bestCost === Infinity) {
        const vlen = hypot2(vx, vy);
        const vxN = vlen > 1e-12 ? vx / vlen : 1;
        const vyN = vlen > 1e-12 ? vy / vlen : 0;
        let bestK = 0;
        let bestDot = -2;
        for (let k = 0; k < 8; k++) {
            const a = (k * Math.PI) / 4;
            const dx = Math.cos(a);
            const dy = Math.sin(a);
            const d = dx * vxN + dy * vyN;
            if (d > bestDot) {
                bestDot = d;
                bestK = k;
            }
        }
        const a = (bestK * Math.PI) / 4;
        const dir = [Math.cos(a), Math.sin(a)];
        const step = gridStepAlongUnitRay(dir, gridMm);
        const t = snapToGrid ? step : Math.max(gridMm * 0.02, vlen);
        bestX = lx + t * dir[0];
        bestY = ly + t * dir[1];
    }

    return [Math.round(bestX * 1e6) / 1e6, Math.round(bestY * 1e6) / 1e6];
}

/**
 * Remove redundant vertices where three consecutive points are collinear (same bearing).
 * @param {number[][]} pts
 * @returns {number[][]}
 */
export function simplifyCollinearTrackPoints(pts) {
    if (!pts || pts.length < 3) return pts || [];
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
        const a = out[out.length - 1];
        const b = pts[i];
        const c = pts[i + 1];
        const dx1 = b[0] - a[0];
        const dy1 = b[1] - a[1];
        const dx2 = c[0] - b[0];
        const dy2 = c[1] - b[1];
        const len1 = hypot2(dx1, dy1);
        const len2 = hypot2(dx2, dy2);
        if (len1 < 1e-12 || len2 < 1e-12) continue;
        const c1 = dx1 / len1;
        const s1 = dy1 / len1;
        const c2 = dx2 / len2;
        const s2 = dy2 / len2;
        const cross = Math.abs(c1 * s2 - s1 * c2);
        const dot = c1 * c2 + s1 * s2;
        if (cross < 1e-5 && dot > 0) continue;
        out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
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
