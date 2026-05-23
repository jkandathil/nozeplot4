/**
 * Hit tests, bounds, and transforms for MEMS layout entities (canonical µm).
 */

const DEG = Math.PI / 180;

export function rotatePoint(px, py, cx, cy, rad) {
    const dx = px - cx;
    const dy = py - cy;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
        x: cx + dx * cos - dy * sin,
        y: cy + dx * sin + dy * cos,
    };
}

/** Upper-left rect corners CCW from (x,y) */
function axisRectCorners(r) {
    return [
        { x: r.x, y: r.y },
        { x: r.x + r.width, y: r.y },
        { x: r.x + r.width, y: r.y + r.height },
        { x: r.x, y: r.y + r.height },
    ];
}

function bboxOfPoints(pts) {
    if (!pts.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
}

function ellipseRadialBBox(cx, cy, rx, ry, rotationDeg) {
    const samples = 48;
    const rad = (rotationDeg || 0) * DEG;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i <= samples; i++) {
        const t = (i / samples) * 2 * Math.PI;
        const x0 = rx * Math.cos(t);
        const y0 = ry * Math.sin(t);
        const x = cx + x0 * Math.cos(rad) - y0 * Math.sin(rad);
        const y = cy + x0 * Math.sin(rad) + y0 * Math.cos(rad);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    return { minX, minY, maxX, maxY };
}

/** @param {{ x:number,y:number }[]} pts closed polygon */
export function pointInPolygon(px, py, pts) {
    if (!pts || pts.length < 3) return false;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x;
        const yi = pts[i].y;
        const xj = pts[j].x;
        const yj = pts[j].y;
        const intersect =
            yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-30) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

export function pointInEllipse(px, py, cx, cy, rx, ry, rotationDeg = 0) {
    if (rx <= 0 || ry <= 0) return false;
    const rad = -(rotationDeg || 0) * DEG;
    const dx = px - cx;
    const dy = py - cy;
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
    const nx = lx / rx;
    const ny = ly / ry;
    return nx * nx + ny * ny <= 1 + 1e-9;
}

export function pointNearSegment(px, py, ax, ay, bx, by, tol) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-30;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    return Math.hypot(px - qx, py - qy) <= tol;
}

/** Outer boundary + holes (even-odd region hit test). */
export function hitPolygonRegion(px, py, outer, holes, tol = 8) {
    const ho = holes || [];
    for (const h of ho) {
        if (h.length >= 2 && hitPolygon(px, py, h, tol)) return true;
    }
    if (!hitPolygon(px, py, outer, tol)) return false;
    for (const h of ho) {
        if (h.length >= 3 && pointInPolygon(px, py, h)) return false;
    }
    return true;
}

export function hitPolygon(px, py, pts, tol = 8) {
    if (!pts || pts.length < 2) return false;
    if (pts.length >= 3 && pointInPolygon(px, py, pts)) return true;
    for (let i = 0; i < pts.length - 1; i++) {
        if (pointNearSegment(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, tol)) return true;
    }
    if (pts.length >= 3) {
        const last = pts.length - 1;
        if (pointNearSegment(px, py, pts[last].x, pts[last].y, pts[0].x, pts[0].y, tol)) return true;
    }
    return false;
}

export function hitPathOpen(px, py, pts, tol = 8) {
    if (!pts || pts.length < 2) return false;
    for (let i = 0; i < pts.length - 1; i++) {
        if (pointNearSegment(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, tol)) return true;
    }
    return false;
}

/** Hit test for rect with optional rotation around its centre */
export function hitRotatedRect(px, py, r, tol = 8) {
    const deg = r.rotationDeg || 0;
    if (!deg) {
        return (
            px >= r.x - tol &&
            px <= r.x + r.width + tol &&
            py >= r.y - tol &&
            py <= r.y + r.height + tol
        );
    }
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const rad = -deg * DEG;
    const q = rotatePoint(px, py, cx, cy, rad);
    return (
        q.x >= r.x - tol &&
        q.x <= r.x + r.width + tol &&
        q.y >= r.y - tol &&
        q.y <= r.y + r.height + tol
    );
}

export function entityBBox(e) {
    if (e.type === 'rect') {
        const deg = e.rotationDeg || 0;
        if (!deg) {
            return { minX: e.x, minY: e.y, maxX: e.x + e.width, maxY: e.y + e.height };
        }
        const cx = e.x + e.width / 2;
        const cy = e.y + e.height / 2;
        const rad = deg * DEG;
        const corners = axisRectCorners(e).map((p) => rotatePoint(p.x, p.y, cx, cy, rad));
        return bboxOfPoints(corners);
    }
    if (e.type === 'polygon') {
        const pts = e.points || [];
        const all = [...pts];
        for (const h of e.holes || []) {
            for (const p of h) all.push(p);
        }
        if (!all.length) return null;
        return bboxOfPoints(all);
    }
    if (e.type === 'ellipse') {
        return ellipseRadialBBox(e.cx, e.cy, e.rx, e.ry, e.rotationDeg || 0);
    }
    if (e.type === 'line') {
        return bboxOfPoints([
            { x: e.x1, y: e.y1 },
            { x: e.x2, y: e.y2 },
        ]);
    }
    if (e.type === 'path') {
        const pts = e.points || [];
        if (!pts.length) return null;
        const b = bboxOfPoints(pts);
        if (!b) return null;
        const hw = Number(e.widthUm);
        if (Number.isFinite(hw) && hw > 0) {
            const p = hw / 2;
            return { minX: b.minX - p, minY: b.minY - p, maxX: b.maxX + p, maxY: b.maxY + p };
        }
        return b;
    }
    if (e.type === 'text') {
        const h = Number(e.heightUm);
        const pad = Number.isFinite(h) && h > 0 ? h * 0.5 : 5;
        return {
            minX: e.x - pad,
            minY: e.y - pad,
            maxX: e.x + pad,
            maxY: e.y + pad,
        };
    }
    return null;
}

export function entityCentroid(e) {
    const b = entityBBox(e);
    if (!b) return { x: 0, y: 0 };
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

export function hitEntity(px, py, e, tol = 8) {
    if (e.type === 'rect') return hitRotatedRect(px, py, e, tol);
    if (e.type === 'polygon') {
        const pts = e.points || [];
        const holes = e.holes || [];
        return hitPolygonRegion(px, py, pts, holes, tol);
    }
    if (e.type === 'ellipse') return pointInEllipse(px, py, e.cx, e.cy, e.rx, e.ry, e.rotationDeg || 0);
    if (e.type === 'line')
        return pointNearSegment(px, py, e.x1, e.y1, e.x2, e.y2, tol);
    if (e.type === 'path') return hitPathOpen(px, py, e.points || [], tol);
    if (e.type === 'text') {
        const b = entityBBox(e);
        if (!b) return false;
        return px >= b.minX - tol && px <= b.maxX + tol && py >= b.minY - tol && py <= b.maxY + tol;
    }
    return false;
}

export function bboxIntersects(a, b) {
    return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

export function snapScalar(v, gridUm) {
    if (!gridUm || gridUm <= 0) return v;
    return Math.round(v / gridUm) * gridUm;
}

export function snapPoint(p, gridUm) {
    return { x: snapScalar(p.x, gridUm), y: snapScalar(p.y, gridUm) };
}

export function translateEntity(e, dx, dy) {
    if (e.type === 'rect') {
        return { ...e, x: e.x + dx, y: e.y + dy };
    }
    if (e.type === 'polygon' || e.type === 'path') {
        const next =
            e.type === 'polygon' && e.holes?.length
                ? {
                      ...e,
                      points: (e.points || []).map((pt) => ({ x: pt.x + dx, y: pt.y + dy })),
                      holes: e.holes.map((ring) => ring.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }))),
                  }
                : {
                      ...e,
                      points: (e.points || []).map((pt) => ({ x: pt.x + dx, y: pt.y + dy })),
                  };
        return next;
    }
    if (e.type === 'ellipse') {
        return { ...e, cx: e.cx + dx, cy: e.cy + dy };
    }
    if (e.type === 'line') {
        return {
            ...e,
            x1: e.x1 + dx,
            y1: e.y1 + dy,
            x2: e.x2 + dx,
            y2: e.y2 + dy,
        };
    }
    if (e.type === 'instance') {
        return { ...e, x: e.x + dx, y: e.y + dy };
    }
    if (e.type === 'text') {
        return { ...e, x: e.x + dx, y: e.y + dy };
    }
    return e;
}

/**
 * Rotate entity degrees around pivot (µm space).
 * @returns deep-updated entity
 */
export function rotateEntityAround(e, pivotX, pivotY, deltaDeg) {
    const rad = deltaDeg * DEG;

    if (e.type === 'rect') {
        const cx = e.x + e.width / 2;
        const cy = e.y + e.height / 2;
        const nc = rotatePoint(cx, cy, pivotX, pivotY, rad);
        const nextRot = (((e.rotationDeg || 0) + deltaDeg) % 360 + 360) % 360;
        return {
            ...e,
            x: nc.x - e.width / 2,
            y: nc.y - e.height / 2,
            rotationDeg: nextRot,
        };
    }
    if (e.type === 'ellipse') {
        const nc = rotatePoint(e.cx, e.cy, pivotX, pivotY, rad);
        return {
            ...e,
            cx: nc.x,
            cy: nc.y,
            rotationDeg: (((e.rotationDeg || 0) + deltaDeg) % 360 + 360) % 360,
        };
    }
    if (e.type === 'polygon' || e.type === 'path') {
        const rot = (x, y) => rotatePoint(x, y, pivotX, pivotY, rad);
        return {
            ...e,
            points: (e.points || []).map((p) => {
                const q = rot(p.x, p.y);
                return { x: q.x, y: q.y };
            }),
            ...(e.holes?.length
                ? {
                      holes: e.holes.map((ring) =>
                          ring.map((p) => {
                              const q = rot(p.x, p.y);
                              return { x: q.x, y: q.y };
                          })
                      ),
                  }
                : {}),
        };
    }
    if (e.type === 'line') {
        const a = rotatePoint(e.x1, e.y1, pivotX, pivotY, rad);
        const b = rotatePoint(e.x2, e.y2, pivotX, pivotY, rad);
        return { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    if (e.type === 'instance') {
        const nc = rotatePoint(e.x, e.y, pivotX, pivotY, rad);
        const nextRot = (((e.rotationDeg || 0) + deltaDeg) % 360 + 360) % 360;
        return { ...e, x: nc.x, y: nc.y, rotationDeg: nextRot };
    }
    if (e.type === 'text') {
        const nc = rotatePoint(e.x, e.y, pivotX, pivotY, rad);
        const nextRot = (((e.rotationDeg || 0) + deltaDeg) % 360 + 360) % 360;
        return { ...e, x: nc.x, y: nc.y, rotationDeg: nextRot };
    }
    return e;
}

/** Absolute rotation for rect around its centre */
export function setRectRotationDeg(e, deg) {
    const cx = e.x + e.width / 2;
    const cy = e.y + e.height / 2;
    const delta = deg - (e.rotationDeg || 0);
    return rotateEntityAround(e, cx, cy, delta);
}

/** Absolute rotation for ellipse */
export function setEllipseRotationDeg(e, deg) {
    const delta = deg - (e.rotationDeg || 0);
    return rotateEntityAround(e, e.cx, e.cy, delta);
}

/** Axis-aligned resize: fixed NW corner at rect origin, SE corner moves to (seX, seY). */
export function resizeRectAABBNwSe(e, seX, seY) {
    const nwX = e.x;
    const nwY = e.y;
    return {
        ...e,
        width: Math.max(0.5, seX - nwX),
        height: Math.max(0.5, seY - nwY),
    };
}

/** Unrotated ellipse: bbox NW at (cx−rx, cy−ry), resize SE corner to (seX, seY). */
export function resizeEllipseAABBNwSe(e, seX, seY) {
    const nwX = e.cx - e.rx;
    const nwY = e.cy - e.ry;
    const w = Math.max(0.5, seX - nwX);
    const h = Math.max(0.5, seY - nwY);
    return {
        ...e,
        cx: nwX + w / 2,
        cy: nwY + h / 2,
        rx: w / 2,
        ry: h / 2,
    };
}
