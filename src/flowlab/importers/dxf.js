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

/* Normalise DXF text before handing it to the parser. Handles three
 * real-world pathologies we've seen in the wild:
 *   1. UTF-8 / UTF-16 BOM at the start (some CAD apps emit both).
 *   2. CR-only or mixed CRLF line endings — dxf-parser's split() is
 *      strict about \n boundaries.
 *   3. Missing `0\nEOF` group at the end (truncated files, minimal
 *      hand-written DXFs). Without it the parser throws "EOF group
 *      not read before end of file. Ended on code undefined".
 */
function normaliseDxf(text) {
    if (typeof text !== 'string') text = String(text ?? '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    text = text.replace(/\r\n?/g, '\n');
    while (text.endsWith('\n')) text = text.slice(0, -1);
    /* Peek at the last non-whitespace group pair; if it's not
     * `0 / EOF`, append one. Walk backward because trailing comments /
     * whitespace are uncommon but legal in DXF. */
    const lines = text.split('\n').map((l) => l.trim());
    let sawEof = false;
    for (let i = lines.length - 1; i >= 1; i--) {
        if (!lines[i]) continue;
        if (lines[i] === 'EOF' && lines[i - 1] === '0') { sawEof = true; break; }
        if (lines[i] === 'EOF') { sawEof = true; break; }
        break;
    }
    if (!sawEof) text += '\n0\nEOF\n';
    else text += '\n';
    return text;
}

/* Last-resort minimal DXF reader for files that dxf-parser can't
 * consume even after normalisation. Walks the (group-code, value)
 * pair stream and extracts the handful of primitive entities Flow
 * Lab cares about (LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC). ELLIPSE
 * / SPLINE are skipped here — if those matter for a particular file
 * the user can export it from the source CAD with the "standard DXF"
 * option so dxf-parser's full pipeline works.
 *
 * Returns a shape compatible with what `dxf-parser` would produce so
 * the downstream `dxfToEntities` routine is unchanged.
 */
function fallbackParseDxf(text) {
    const lines = text.split('\n').map((l) => l.trim());
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
        const code = Number(lines[i]);
        if (!Number.isFinite(code)) { i -= 1; continue; }
        pairs.push([code, lines[i + 1]]);
    }
    const header = {};
    const entities = [];
    let inEntities = false;
    let inHeader = false;
    let pendingVar = null;
    let cur = null;
    const flush = () => { if (cur) { entities.push(cur); cur = null; } };
    for (let i = 0; i < pairs.length; i++) {
        const [code, rawVal] = pairs[i];
        const val = rawVal;
        if (code === 0) {
            if (val === 'SECTION') {
                const next = pairs[i + 1];
                if (next && next[0] === 2) {
                    if (next[1] === 'HEADER') { inHeader = true; inEntities = false; }
                    else if (next[1] === 'ENTITIES') { inEntities = true; inHeader = false; }
                    else { inHeader = false; inEntities = false; }
                    i++;
                }
                flush();
                continue;
            }
            if (val === 'ENDSEC' || val === 'EOF') {
                flush();
                inEntities = false;
                inHeader = false;
                continue;
            }
            if (inEntities) {
                flush();
                cur = { type: val, vertices: [] };
            }
            continue;
        }
        if (inHeader) {
            if (code === 9) pendingVar = val;
            else if (pendingVar != null && code === 70) {
                const n = Number(val);
                if (Number.isFinite(n)) header[pendingVar] = n;
                pendingVar = null;
            }
            continue;
        }
        if (!cur) continue;
        if (cur.type === 'LINE') {
            if (code === 10) cur._x0 = Number(val);
            else if (code === 20) cur._y0 = Number(val);
            else if (code === 11) cur._x1 = Number(val);
            else if (code === 21) {
                cur._y1 = Number(val);
                cur.vertices = [
                    { x: cur._x0 || 0, y: cur._y0 || 0 },
                    { x: cur._x1 || 0, y: cur._y1 || 0 },
                ];
            }
        } else if (cur.type === 'LWPOLYLINE') {
            if (code === 70) cur.shape = !!(Number(val) & 1);
            else if (code === 10) cur._px = Number(val);
            else if (code === 20) {
                cur.vertices.push({ x: cur._px || 0, y: Number(val) });
            }
        } else if (cur.type === 'POLYLINE') {
            if (code === 70) cur.closed = !!(Number(val) & 1);
        } else if (cur.type === 'VERTEX') {
            if (code === 10) cur._px = Number(val);
            else if (code === 20) {
                const parent = entities[entities.length - 2];
                if (parent && parent.type === 'POLYLINE') {
                    parent.vertices.push({ x: cur._px || 0, y: Number(val) });
                }
            }
        } else if (cur.type === 'CIRCLE') {
            if (code === 10) cur._cx = Number(val);
            else if (code === 20) cur._cy = Number(val);
            else if (code === 40) {
                cur.radius = Number(val);
                cur.center = { x: cur._cx || 0, y: cur._cy || 0 };
            }
        } else if (cur.type === 'ARC') {
            if (code === 10) cur._cx = Number(val);
            else if (code === 20) cur._cy = Number(val);
            else if (code === 40) cur.radius = Number(val);
            else if (code === 50) cur.startAngle = Number(val);
            else if (code === 51) {
                cur.endAngle = Number(val);
                cur.center = { x: cur._cx || 0, y: cur._cy || 0 };
            }
        }
    }
    flush();
    /* Drop VERTEX scaffolding (already merged into the parent POLYLINE). */
    const filtered = entities.filter((e) => e.type !== 'VERTEX' && e.type !== 'SEQEND');
    return { header, entities: filtered };
}

/**
 * Parse a DXF text string and return Flow Lab entity objects.
 *
 * `scaleOverride` (optional) replaces the auto-detected mm scale.
 */
export function parseDxfToEntities(dxfText, { scaleOverride = null } = {}) {
    const cleaned = normaliseDxf(dxfText);
    const parser = new DxfParser();
    let dxf;
    let usedFallback = false;
    try {
        dxf = parser.parseSync(cleaned);
    } catch (err) {
        /* Try the minimal built-in fallback before giving up — covers
         * hand-written DXFs that dxf-parser's strict state machine
         * rejects. */
        console.warn('dxf-parser failed, falling back to minimal reader:', err?.message || err);
        try {
            dxf = fallbackParseDxf(cleaned);
            usedFallback = true;
        } catch (err2) {
            throw new Error('Failed to parse DXF: ' + (err?.message || err));
        }
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
        usedFallback,
    };
}

function dxfUnitName(code) {
    return {
        1: 'inch', 2: 'foot', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km',
        8: 'µin', 9: 'mil', 10: 'yard', 11: 'Å', 12: 'nm', 13: 'µm',
    }[code] || `code ${code}`;
}
