/**
 * Tessellate MEMS entities to closed rings (µm) for Boolean / offset kernels.
 */

import { rotatePoint } from './memsGeometry.js';

const DEG = Math.PI / 180;

/** @param {{ x:number,y:number }[]} ring */
function ringClosed(ring) {
    if (ring.length < 2) return ring;
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a.x === b.x && a.y === b.y) return ring;
    return [...ring, { ...a }];
}

/** Upper-left rect corners CCW */
function axisRectCorners(r) {
    return [
        { x: r.x, y: r.y },
        { x: r.x + r.width, y: r.y },
        { x: r.x + r.width, y: r.y + r.height },
        { x: r.x, y: r.y + r.height },
    ];
}

/**
 * Ellipse boundary as closed polygon; segment length capped for nm-scale stability.
 * @param {number} cx
 * @param {number} cy
 * @param {number} rx
 * @param {number} ry
 * @param {number} rotationDeg
 * @param {number} maxChordUm — max edge length in µm
 */
export function ellipseToRingUm(cx, cy, rx, ry, rotationDeg = 0, maxChordUm = 0.25) {
    const rad = rotationDeg * DEG;
    const perim = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))); // Ramanujan approx
    let n = Math.ceil(perim / Math.max(1e-6, maxChordUm));
    n = Math.max(16, Math.min(2048, n));
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = (i / n) * 2 * Math.PI;
        const x0 = rx * Math.cos(t);
        const y0 = ry * Math.sin(t);
        const wx = cx + x0 * Math.cos(rad) - y0 * Math.sin(rad);
        const wy = cy + x0 * Math.sin(rad) + y0 * Math.cos(rad);
        pts.push({ x: wx, y: wy });
    }
    return ringClosed(pts.slice(0, -1).concat([pts[0]]));
}

/**
 * @typedef {{
 *   rings: { x: number, y: number }[][],
 *   skipped?: boolean,
 *   reason?: string
 * }} TessellationResult
 */

/**
 * @param {import('./memsMaskDoc.js').MemsEntity} e
 * @param {{
 *   lineHalfWidthUm?: number,
 *   pathCapUm?: number,
 * }} [opts]
 * @returns {TessellationResult}
 */
export function entityToClosedRingsUm(e, opts = {}) {
    const lineHalfWidthUm = opts.lineHalfWidthUm ?? 0.005;
    const pathCapUm = opts.pathCapUm ?? Math.max(lineHalfWidthUm, 0.01);

    if (e.type === 'rect') {
        const corners = axisRectCorners(e);
        const deg = e.rotationDeg || 0;
        if (!deg) {
            return { rings: [ringClosed(corners)] };
        }
        const cx = e.x + e.width / 2;
        const cy = e.y + e.height / 2;
        const rad = deg * DEG;
        const rotated = corners.map((p) => {
            const q = rotatePoint(p.x, p.y, cx, cy, rad);
            return { x: q.x, y: q.y };
        });
        return { rings: [ringClosed(rotated)] };
    }
    if (e.type === 'polygon') {
        const outer = e.points || [];
        if (outer.length < 3) return { rings: [], skipped: true, reason: 'polygon < 3 vertices' };
        const rings = [ringClosed(outer.map((p) => ({ x: p.x, y: p.y })))];
        const holes = e.holes || [];
        for (const h of holes) {
            if (h.length >= 3) rings.push(ringClosed(h.map((p) => ({ x: p.x, y: p.y }))));
        }
        return { rings };
    }
    if (e.type === 'ellipse') {
        const ring = ellipseToRingUm(e.cx, e.cy, e.rx, e.ry, e.rotationDeg || 0);
        return { rings: [ring] };
    }
    if (e.type === 'line') {
        const dx = e.x2 - e.x1;
        const dy = e.y2 - e.y1;
        const len = Math.hypot(dx, dy);
        if (len < 1e-12) return { rings: [], skipped: true, reason: 'degenerate line' };
        const ux = dx / len;
        const uy = dy / len;
        const px = -uy * lineHalfWidthUm;
        const py = ux * lineHalfWidthUm;
        const strip = [
            { x: e.x1 + px, y: e.y1 + py },
            { x: e.x2 + px, y: e.y2 + py },
            { x: e.x2 - px, y: e.y2 - py },
            { x: e.x1 - px, y: e.y1 - py },
        ];
        return { rings: [ringClosed(strip)] };
    }
    if (e.type === 'path') {
        const pts = e.points || [];
        if (pts.length < 2) return { rings: [], skipped: true, reason: 'path < 2 points' };
        const rings = pathStrokeAsRingsUm(pts, pathCapUm);
        return rings.length ? { rings } : { rings: [], skipped: true, reason: 'path stroke empty' };
    }
    return { rings: [], skipped: true, reason: 'unknown entity' };
}

/**
 * Simple path stroke → ribbon polygons (µm). Caps are squared along endpoint normals.
 * @param {{ x:number,y:number }[]} pts
 * @param {number} halfWidthUm
 * @returns {{ x:number,y:number }[][]}
 */
export function pathStrokeAsRingsUm(pts, halfWidthUm) {
    if (pts.length < 2 || halfWidthUm <= 0) return [];
    const rings = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const ax = pts[i].x;
        const ay = pts[i].y;
        const bx = pts[i + 1].x;
        const by = pts[i + 1].y;
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len < 1e-15) continue;
        const ux = dx / len;
        const uy = dy / len;
        const px = -uy * halfWidthUm;
        const py = ux * halfWidthUm;
        const quad = [
            { x: ax + px, y: ay + py },
            { x: bx + px, y: by + py },
            { x: bx - px, y: by - py },
            { x: ax - px, y: ay - py },
        ];
        rings.push(ringClosed(quad));
    }
    return rings;
}
