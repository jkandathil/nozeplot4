/**
 * DXF → Flow Lab entity importer.
 *
 * Uses the `dxf-parser` npm package to consume AutoCAD DXF text and
 * converts the entity stream into Flow Lab polyline entities.
 *
 * Supported DXF entities:
 *   LINE               → 2-vertex open polyline
 *   LWPOLYLINE         → closed/open polyline (honours the `closed` flag)
 *   POLYLINE           → closed/open polyline (heavyweight variant)
 *   CIRCLE             → closed polyline (48-segment approximation)
 *   ARC                → open polyline
 *   ELLIPSE            → closed/open polyline (honours startAngle/endAngle)
 *   SPLINE             → flattened polyline (de Boor sampling via the
 *                        parser's own `controlPoints` / `knots`)
 *
 * Units are resolved from the $INSUNITS header (0=unitless, 1=in,
 * 2=ft, 4=mm, 5=cm, 6=m). Unit-less files are treated as millimetres
 * with a soft warning.
 *
 * NOTE: We return raw ({x,y}) vertices — the caller wraps them with
 * createPolylineEntity so Flow Lab's id/edgeBC plumbing stays in one
 * place.
 */

import DxfParser from 'dxf-parser';
import { createPolylineEntity } from '../geometry.js';

const UNIT_MM_SCALE = {
    0: 1,        // unitless → treat as mm, with a warning
    1: 25.4,     // inch
    2: 304.8,    // foot
    3: 1609344,  // mile
    4: 1,        // mm
    5: 10,       // cm
    6: 1000,     // m
    7: 1e6,      // km
    8: 25.4e-6,  // microinch
    9: 25.4e-3,  // mil
    10: 914.4,   // yard
    11: 1e-7,    // angstrom
    12: 1e-6,    // nanometre
    13: 1e-3,    // micron
    14: 100,     // decimetre
    15: 10000,   // dekametre
    16: 100000,  // hectometre
    17: 1e9,     // gigametre
};

function circlePoints(cx, cy, r, segs = 48) {
    const pts = [];
    for (let i = 0; i < segs; i++) {
        const a = 2 * Math.PI * i / segs;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
}

function arcPoints(cx, cy, r, a0Deg, a1Deg, segsPerFull = 48) {
    let a0 = a0Deg * Math.PI / 180;
    let a1 = a1Deg * Math.PI / 180;
    if (a1 <= a0) a1 += 2 * Math.PI;
    const sweep = a1 - a0;
    const n = Math.max(4, Math.ceil(segsPerFull * sweep / (2 * Math.PI)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const a = a0 + sweep * (i / n);
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
}

function ellipsePoints(cx, cy, majX, majY, ratio, a0, a1, segsPerFull = 64) {
    // majX/majY define the major axis endpoint relative to centre;
    // `ratio` is minor/major. Parameter angles a0, a1 are in radians
    // on the unrotated ellipse.
    const majLen = Math.hypot(majX, majY);
    if (!(majLen > 0)) return [];
    const ux = majX / majLen, uy = majY / majLen;
    // Minor axis perpendicular (left-hand) to major.
    const vx = -uy, vy = ux;
    const minLen = majLen * ratio;
    let s = a0, e = a1;
    if (e <= s) e += 2 * Math.PI;
    const sweep = e - s;
    const n = Math.max(4, Math.ceil(segsPerFull * sweep / (2 * Math.PI)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const t = s + sweep * (i / n);
        const x = majLen * Math.cos(t);
        const y = minLen * Math.sin(t);
        pts.push({
            x: cx + ux * x + vx * y,
            y: cy + uy * x + vy * y,
        });
    }
    return pts;
}

/* B-spline de Boor-like uniform sampling. `dxf-parser` gives us the
 * control points and knot vector; we evaluate N+1 samples across the
 * parameter range. This is a visual flatten — good enough for CFD
 * geometry which gets rasterised to a mask anyway. */
function sampleSpline(ent, samples = 64) {
    const cps = ent.controlPoints || [];
    if (cps.length < 2) return [];
    if (cps.length === 2) return cps.map((p) => ({ x: p.x, y: p.y }));
    const deg = Math.max(1, Math.min(5, ent.degreeOfSplineCurve || 3));
    const knots = ent.knotValues || [];
    if (knots.length !== cps.length + deg + 1) {
        // Fall back to Catmull-Rom-ish: sample control polygon with
        // smoothing by averaging neighbours. Beats nothing.
        const cp = cps.map((p) => ({ x: p.x, y: p.y }));
        const out = [];
        for (let i = 0; i < samples; i++) {
            const t = (i / (samples - 1)) * (cp.length - 1);
            const i0 = Math.floor(t);
            const i1 = Math.min(i0 + 1, cp.length - 1);
            const f = t - i0;
            out.push({
                x: cp[i0].x * (1 - f) + cp[i1].x * f,
                y: cp[i0].y * (1 - f) + cp[i1].y * f,
            });
        }
        return out;
    }
    const tMin = knots[deg];
    const tMax = knots[knots.length - deg - 1];
    const basis = (i, k, t) => {
        if (k === 0) {
            return (t >= knots[i] && t < knots[i + 1]) ? 1 : 0;
        }
        const d1 = knots[i + k] - knots[i];
        const d2 = knots[i + k + 1] - knots[i + 1];
        const a = d1 > 0 ? (t - knots[i]) / d1 : 0;
        const b = d2 > 0 ? (knots[i + k + 1] - t) / d2 : 0;
        return a * basis(i, k - 1, t) + b * basis(i + 1, k - 1, t);
    };
    const out = [];
    for (let s = 0; s < samples; s++) {
        const t = tMin + (tMax - tMin) * (s / (samples - 1)) - 1e-9;
        let x = 0, y = 0;
        for (let i = 0; i < cps.length; i++) {
            const B = basis(i, deg, Math.min(t, tMax - 1e-9));
            x += cps[i].x * B;
            y += cps[i].y * B;
        }
        out.push({ x, y });
    }
    return out;
}

/* Convert raw DXF parser output to the Flow Lab entity list. */
function dxfToEntities(dxf, scale) {
    const collected = [];
    const push = (pts, closed) => {
        if (!pts || pts.length < 2) return;
        const scaled = pts.map((p) => ({ x: p.x * scale, y: p.y * scale }));
        collected.push({ pts: scaled, closed: !!closed });
    };
    const entities = dxf.entities || [];
    for (const e of entities) {
        if (!e) continue;
        try {
            switch (e.type) {
                case 'LINE':
                    if (e.vertices && e.vertices.length >= 2) {
                        push([
                            { x: e.vertices[0].x, y: e.vertices[0].y },
                            { x: e.vertices[1].x, y: e.vertices[1].y },
                        ], false);
                    }
                    break;
                case 'LWPOLYLINE':
                case 'POLYLINE': {
                    const verts = (e.vertices || []).map((v) => ({ x: v.x, y: v.y }));
                    if (verts.length < 2) break;
                    // LW closed flag is `shape` on lwpolyline, `closed` elsewhere.
                    const closed = !!(e.shape || e.closed);
                    push(verts, closed);
                    break;
                }
                case 'CIRCLE':
                    push(circlePoints(e.center.x, e.center.y, e.radius), true);
                    break;
                case 'ARC':
                    push(
                        arcPoints(e.center.x, e.center.y, e.radius, e.startAngle || 0, e.endAngle || 360),
                        false,
                    );
                    break;
                case 'ELLIPSE': {
                    const pts = ellipsePoints(
                        e.center.x, e.center.y,
                        e.majorAxisEndPoint?.x || 0, e.majorAxisEndPoint?.y || 0,
                        e.axisRatio ?? 1,
                        e.startAngle ?? 0,
                        e.endAngle ?? 2 * Math.PI,
                    );
                    const closed = Math.abs((e.endAngle ?? 2 * Math.PI) - (e.startAngle ?? 0) - 2 * Math.PI) < 1e-6;
                    push(pts, closed);
                    break;
                }
                case 'SPLINE': {
                    const pts = sampleSpline(e);
                    push(pts, !!e.closed);
                    break;
                }
                default:
                    /* SOLID, HATCH, TEXT, INSERT (block references),
                       DIMENSION, etc. — silently skipped. A future pass
                       could expand INSERT to its block body and walk
                       recursively. */
                    break;
            }
        } catch (err) {
            // Malformed entity — skip so a single bad record can't abort
            // the whole import.
            console.warn('DXF entity skipped:', e?.type, err);
        }
    }
    return collected;
}

/**
 * Parse a DXF text string and return Flow Lab entity objects.
 *
 * `scaleOverride` (optional) replaces the auto-detected mm scale.
 */
export function parseDxfToEntities(dxfText, { scaleOverride = null } = {}) {
    const parser = new DxfParser();
    let dxf;
    try {
        dxf = parser.parseSync(dxfText);
    } catch (err) {
        throw new Error('Failed to parse DXF: ' + (err?.message || err));
    }
    if (!dxf) throw new Error('DXF parsed to null');
    const unitsCode = dxf.header?.$INSUNITS ?? 0;
    const autoScale = UNIT_MM_SCALE[unitsCode] ?? 1;
    const scale = scaleOverride != null && Number.isFinite(scaleOverride)
        ? scaleOverride
        : autoScale;
    const collected = dxfToEntities(dxf, scale);
    // Compute bbox before entity wrapping for the "fit to viewport" caller.
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const c of collected) {
        for (const p of c.pts) {
            if (p.x < xmin) xmin = p.x; if (p.x > xmax) xmax = p.x;
            if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y;
        }
    }
    const entities = collected
        .map((c) => createPolylineEntity(c.pts, { closed: c.closed }))
        .filter((e) => e && e.points && e.points.length >= 2);
    const bbox = Number.isFinite(xmin) ? { xmin, ymin, xmax, ymax } : null;
    return {
        entities,
        bbox,
        sourceUnit: unitsCode,
        detectedScale: autoScale,
        unitsName: unitsCode === 0 ? 'unit-less (treated as mm)' : dxfUnitName(unitsCode),
    };
}

function dxfUnitName(code) {
    return {
        1: 'inch', 2: 'foot', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km',
        8: 'µin', 9: 'mil', 10: 'yard', 11: 'Å', 12: 'nm', 13: 'µm',
    }[code] || `code ${code}`;
}
