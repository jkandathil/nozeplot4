/**
 * SVG → Flow Lab entity importer.
 *
 * Supports: <path>, <polygon>, <polyline>, <rect>, <circle>,
 * <ellipse>, <line>. Bezier / arc path segments are flattened using
 * the browser's own SVG engine (`getPointAtLength`) — reliable across
 * Chrome / Safari / Firefox without pulling in a bespoke path parser.
 *
 * Coordinates are in millimetres. SVG files use a mix of units:
 *   · If the outer <svg> has explicit width/height in mm / cm / in,
 *     we compute a unit-per-viewBox-unit scale.
 *   · Otherwise the viewBox units are assumed to be millimetres.
 * Users can pick a different scale in the import dialog — we expose
 * `scale` as a parameter so the caller can multiply afterwards.
 *
 * Returns { entities, bbox, sourceUnit } or throws on unparseable input.
 */

import { createPolylineEntity } from '../geometry.js';

const CURVE_FLATTEN_MM = 0.25; // max chord error along flattened curves

/* Parse a length attribute like "210mm" / "8in" / "100" → pixels,
 * then convert to mm. SVG's default is 96 CSS pixels = 1 inch. */
function parseLengthToMm(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const m = s.match(/^([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*([a-z%]*)$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const u = m[2].toLowerCase();
    switch (u) {
        case 'mm': return n;
        case 'cm': return n * 10;
        case 'm':  return n * 1000;
        case 'in': return n * 25.4;
        case 'pt': return n * 25.4 / 72;
        case 'pc': return n * 25.4 / 6;
        case 'px': return n * 25.4 / 96;
        case '':   return n * 25.4 / 96;  // unit-less = px in SVG
        case '%':  return null;            // viewport-relative, can't resolve here
        default:   return null;
    }
}

/* Determine the mm-per-viewBox-unit scale. */
function computeUnitScale(svgEl) {
    const vb = svgEl.getAttribute('viewBox');
    const wAttr = svgEl.getAttribute('width');
    const hAttr = svgEl.getAttribute('height');
    if (vb) {
        const parts = vb.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
        if (parts.length === 4) {
            const vbW = parts[2];
            const vbH = parts[3];
            const wMm = parseLengthToMm(wAttr);
            const hMm = parseLengthToMm(hAttr);
            if (wMm && vbW > 0) return { scale: wMm / vbW, sourceUnit: 'mm' };
            if (hMm && vbH > 0) return { scale: hMm / vbH, sourceUnit: 'mm' };
            // No physical size — assume viewBox units are millimetres.
            return { scale: 1, sourceUnit: 'viewBox' };
        }
    }
    // No viewBox → use width/height or treat unitless as mm.
    const wMm = parseLengthToMm(wAttr);
    if (wMm) return { scale: 1, sourceUnit: 'mm' };  // width already in mm
    return { scale: 1, sourceUnit: 'mm' };
}

/* Parse transform="matrix(a,b,c,d,e,f) translate(x,y) scale(s) rotate(a,cx,cy)" and
 * concatenate into a single 2×3 affine. Only handles the common cases — enough for
 * files exported from Illustrator / Inkscape / Figma. */
function parseTransform(raw) {
    const m = [1, 0, 0, 1, 0, 0]; // a, b, c, d, e, f
    if (!raw) return m;
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
    let match;
    while ((match = re.exec(raw)) !== null) {
        const fn = match[1];
        const args = match[2].split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
        const t = multiplyTransform(m, transformForFn(fn, args));
        m[0] = t[0]; m[1] = t[1]; m[2] = t[2]; m[3] = t[3]; m[4] = t[4]; m[5] = t[5];
    }
    return m;
}
function transformForFn(fn, a) {
    switch (fn) {
        case 'matrix':    return a.length === 6 ? a.slice() : [1, 0, 0, 1, 0, 0];
        case 'translate': return [1, 0, 0, 1, a[0] || 0, a[1] || 0];
        case 'scale':     { const sx = a[0] || 1, sy = a.length > 1 ? a[1] : sx; return [sx, 0, 0, sy, 0, 0]; }
        case 'rotate': {
            const ang = (a[0] || 0) * Math.PI / 180;
            const cosA = Math.cos(ang), sinA = Math.sin(ang);
            if (a.length >= 3) {
                const cx = a[1], cy = a[2];
                // translate(cx,cy) · rotate(a) · translate(-cx,-cy)
                const r = [cosA, sinA, -sinA, cosA, 0, 0];
                const t1 = [1, 0, 0, 1, cx, cy];
                const t2 = [1, 0, 0, 1, -cx, -cy];
                return multiplyTransform(multiplyTransform(t1, r), t2);
            }
            return [cosA, sinA, -sinA, cosA, 0, 0];
        }
        default: return [1, 0, 0, 1, 0, 0];
    }
}
function multiplyTransform(m1, m2) {
    // m1 * m2  (2×3 affines, column-major per SVG convention)
    const [a1, b1, c1, d1, e1, f1] = m1;
    const [a2, b2, c2, d2, e2, f2] = m2;
    return [
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    ];
}
function applyTransform(m, x, y) {
    return {
        x: m[0] * x + m[2] * y + m[4],
        y: m[1] * x + m[3] * y + m[5],
    };
}

/* Walk the SVG DOM, accumulating transforms. */
function walk(node, parentT, ctx) {
    if (!node || node.nodeType !== 1) return;
    const ownT = parseTransform(node.getAttribute ? node.getAttribute('transform') : null);
    const T = multiplyTransform(parentT, ownT);
    const tag = node.tagName.toLowerCase();
    switch (tag) {
        case 'svg':
        case 'g':
        case 'symbol':
        case 'a':
            for (const child of node.children) walk(child, T, ctx);
            break;
        case 'path':     handlePath(node, T, ctx); break;
        case 'polygon':  handlePoly(node, T, ctx, true);  break;
        case 'polyline': handlePoly(node, T, ctx, false); break;
        case 'rect':     handleRect(node, T, ctx); break;
        case 'line':     handleLine(node, T, ctx); break;
        case 'circle':   handleCircle(node, T, ctx); break;
        case 'ellipse':  handleEllipse(node, T, ctx); break;
        default: /* ignore <text>, <use>, <image>, filters, etc. */ break;
    }
}

function parsePointsAttr(raw) {
    if (!raw) return [];
    return String(raw)
        .split(/[\s,]+/)
        .map(parseFloat)
        .filter(Number.isFinite)
        .reduce((acc, n, i, arr) => {
            if (i % 2 === 0 && i + 1 < arr.length) acc.push({ x: n, y: arr[i + 1] });
            return acc;
        }, []);
}

function handlePoly(node, T, ctx, closed) {
    const raw = parsePointsAttr(node.getAttribute('points'));
    if (raw.length < 2) return;
    const pts = raw.map((p) => {
        const q = applyTransform(T, p.x, p.y);
        return { x: q.x * ctx.scale, y: q.y * ctx.scale };
    });
    ctx.add({ pts, closed });
}

function handleRect(node, T, ctx) {
    const x = parseFloat(node.getAttribute('x') || 0);
    const y = parseFloat(node.getAttribute('y') || 0);
    const w = parseFloat(node.getAttribute('width') || 0);
    const h = parseFloat(node.getAttribute('height') || 0);
    if (!(w > 0 && h > 0)) return;
    const rx = parseFloat(node.getAttribute('rx') || 0);
    const ry = parseFloat(node.getAttribute('ry') || rx);
    if (rx > 0 || ry > 0) {
        // Round rect — flatten corners.
        const corners = roundRectPoints(x, y, w, h, Math.max(0, rx), Math.max(0, ry));
        const mapped = corners.map((p) => {
            const q = applyTransform(T, p.x, p.y);
            return { x: q.x * ctx.scale, y: q.y * ctx.scale };
        });
        ctx.add({ pts: mapped, closed: true });
        return;
    }
    const raw = [
        { x: x, y: y },
        { x: x + w, y: y },
        { x: x + w, y: y + h },
        { x: x, y: y + h },
    ];
    const pts = raw.map((p) => {
        const q = applyTransform(T, p.x, p.y);
        return { x: q.x * ctx.scale, y: q.y * ctx.scale };
    });
    ctx.add({ pts, closed: true });
}
function roundRectPoints(x, y, w, h, rx, ry, segsPerArc = 10) {
    rx = Math.min(rx, w / 2);
    ry = Math.min(ry, h / 2);
    const out = [];
    const arc = (cx, cy, a0, a1) => {
        for (let i = 0; i <= segsPerArc; i++) {
            const t = i / segsPerArc;
            const a = a0 + (a1 - a0) * t;
            out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
        }
    };
    // top-left corner → top-right corner → bottom-right → bottom-left
    arc(x + rx,       y + ry,       Math.PI,         1.5 * Math.PI);
    arc(x + w - rx,   y + ry,       -0.5 * Math.PI,  0);
    arc(x + w - rx,   y + h - ry,   0,               0.5 * Math.PI);
    arc(x + rx,       y + h - ry,   0.5 * Math.PI,   Math.PI);
    return out;
}

function handleLine(node, T, ctx) {
    const x1 = parseFloat(node.getAttribute('x1') || 0);
    const y1 = parseFloat(node.getAttribute('y1') || 0);
    const x2 = parseFloat(node.getAttribute('x2') || 0);
    const y2 = parseFloat(node.getAttribute('y2') || 0);
    const a = applyTransform(T, x1, y1);
    const b = applyTransform(T, x2, y2);
    ctx.add({
        pts: [
            { x: a.x * ctx.scale, y: a.y * ctx.scale },
            { x: b.x * ctx.scale, y: b.y * ctx.scale },
        ],
        closed: false,
    });
}

function handleCircle(node, T, ctx, segs = 48) {
    const cx = parseFloat(node.getAttribute('cx') || 0);
    const cy = parseFloat(node.getAttribute('cy') || 0);
    const r = parseFloat(node.getAttribute('r') || 0);
    if (!(r > 0)) return;
    const pts = [];
    for (let i = 0; i < segs; i++) {
        const a = 2 * Math.PI * i / segs;
        const p = applyTransform(T, cx + r * Math.cos(a), cy + r * Math.sin(a));
        pts.push({ x: p.x * ctx.scale, y: p.y * ctx.scale });
    }
    ctx.add({ pts, closed: true });
}

function handleEllipse(node, T, ctx, segs = 64) {
    const cx = parseFloat(node.getAttribute('cx') || 0);
    const cy = parseFloat(node.getAttribute('cy') || 0);
    const rx = parseFloat(node.getAttribute('rx') || 0);
    const ry = parseFloat(node.getAttribute('ry') || 0);
    if (!(rx > 0 && ry > 0)) return;
    const pts = [];
    for (let i = 0; i < segs; i++) {
        const a = 2 * Math.PI * i / segs;
        const p = applyTransform(T, cx + rx * Math.cos(a), cy + ry * Math.sin(a));
        pts.push({ x: p.x * ctx.scale, y: p.y * ctx.scale });
    }
    ctx.add({ pts, closed: true });
}

/* Path flattening uses the browser's SVGPathElement APIs —
 * getTotalLength() / getPointAtLength() — so we don't have to write a
 * bespoke parser for M/L/H/V/C/S/Q/T/A and their relative variants.
 * We sample at an adaptive step so curves end up roughly flat to
 * CURVE_FLATTEN_MM. The path's own d attribute is copied onto a
 * throwaway element that lives in a detached <svg>, which is enough
 * for Chrome/Firefox/Safari to evaluate the geometry. */
function handlePath(node, T, ctx) {
    const d = node.getAttribute('d');
    if (!d) return;
    const ns = 'http://www.w3.org/2000/svg';
    const tmp = document.createElementNS(ns, 'svg');
    tmp.setAttribute('width', '0'); tmp.setAttribute('height', '0');
    tmp.style.position = 'absolute'; tmp.style.left = '-9999px';
    document.body.appendChild(tmp);
    try {
        const p = document.createElementNS(ns, 'path');
        p.setAttribute('d', d);
        tmp.appendChild(p);
        const total = p.getTotalLength ? p.getTotalLength() : 0;
        if (!(total > 0)) return;
        // Step size: proportional to length, clamped.
        const stepMm = Math.max(CURVE_FLATTEN_MM / Math.max(0.001, ctx.scale), 0.05);
        const nSteps = Math.max(4, Math.ceil(total / stepMm));
        // Split the path into subpaths on 'M' so we can emit multiple
        // entities (a 'd' like "M0,0 L10,0 M20,0 L30,0" = two lines).
        const segs = splitPathOnMoves(d);
        if (segs.length <= 1) {
            emitSampledPath(p, total, nSteps, T, ctx, isClosedPath(d));
        } else {
            for (const s of segs) {
                const sp = document.createElementNS(ns, 'path');
                sp.setAttribute('d', s);
                tmp.appendChild(sp);
                const tot = sp.getTotalLength();
                if (tot > 0) {
                    const ns2 = Math.max(4, Math.ceil(tot / stepMm));
                    emitSampledPath(sp, tot, ns2, T, ctx, isClosedPath(s));
                }
            }
        }
    } finally {
        document.body.removeChild(tmp);
    }
}
function splitPathOnMoves(d) {
    // Split at every absolute 'M' not at the start. Relative 'm' after
    // the first segment also starts a new subpath per SVG spec.
    const tokens = d.match(/[MmZzLlHhVvCcSsQqTtAa][^MmZzLlHhVvCcSsQqTtAa]*/g) || [];
    const segs = [];
    let cur = '';
    let first = true;
    for (const t of tokens) {
        const c = t[0];
        if ((c === 'M' || c === 'm') && !first && cur.trim()) {
            segs.push(cur);
            cur = '';
        }
        cur += t;
        first = false;
    }
    if (cur.trim()) segs.push(cur);
    return segs;
}
function isClosedPath(d) {
    return /[Zz]\s*$/.test(d.trim());
}
function emitSampledPath(p, total, nSteps, T, ctx, closed) {
    const pts = [];
    for (let i = 0; i <= nSteps; i++) {
        const s = (i / nSteps) * total;
        const pt = p.getPointAtLength(s);
        const q = applyTransform(T, pt.x, pt.y);
        pts.push({ x: q.x * ctx.scale, y: q.y * ctx.scale });
    }
    // If the path is closed, drop the duplicate last point that maps to
    // the start (getPointAtLength can return it twice on closed paths).
    if (closed && pts.length > 2) {
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-4) pts.pop();
    }
    if (pts.length >= 2) ctx.add({ pts, closed });
}

/**
 * Parse an SVG string and return Flow Lab entities.
 *
 * `scaleOverride` (optional): override the auto-detected mm-per-unit
 * scale. E.g. if auto-detection thinks everything is at 1× but you
 * want to scale up by 0.5 mm/unit, pass 0.5 here.
 */
export function parseSvgToEntities(svgText, { scaleOverride = null } = {}) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error('Malformed SVG: ' + err.textContent.trim());
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== 'svg') {
        throw new Error('No <svg> root element in input.');
    }
    const auto = computeUnitScale(root);
    const scale = scaleOverride != null && Number.isFinite(scaleOverride)
        ? scaleOverride
        : auto.scale;
    const collected = [];
    const ctx = {
        scale,
        add: ({ pts, closed }) => {
            if (!pts || pts.length < 2) return;
            collected.push({ pts, closed });
        },
    };
    // SVG Y grows down, but Flow Lab uses Y up. Flip at the very end.
    walk(root, [1, 0, 0, 1, 0, 0], ctx);
    // Flip Y and compute bbox.
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const c of collected) {
        for (const p of c.pts) {
            p.y = -p.y;
            if (p.x < xmin) xmin = p.x; if (p.x > xmax) xmax = p.x;
            if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y;
        }
    }
    const entities = collected
        .map((c) => createPolylineEntity(c.pts, { closed: !!c.closed }))
        .filter((e) => e && e.points && e.points.length >= 2);
    const bbox = Number.isFinite(xmin)
        ? { xmin, ymin, xmax, ymax }
        : null;
    return { entities, bbox, sourceUnit: auto.sourceUnit, detectedScale: auto.scale };
}
