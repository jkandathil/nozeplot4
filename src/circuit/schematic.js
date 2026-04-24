/**
 * Auto-layout schematic renderer for Circuit Studio.
 *
 * Pipeline:
 *   1. Seed a force-directed graph layout of (electrical nodes ⇿
 *      components). Ground is pinned to the bottom-centre so the
 *      layout never flips upside-down.
 *   2. For each component, choose an orientation (0/90/180/270°) so
 *      that its pin axis lines up with the direction between its
 *      connected nodes. Two-terminal parts with a ground pin are
 *      oriented vertically with ground pointing down.
 *   3. Snap component centres and node "bus points" to a fixed grid.
 *      This is what makes the schematic feel like schematic paper —
 *      wires only ever turn 90°, and parts sit on clean grid lines.
 *   4. For every component pin, route an orthogonal wire from the
 *      pin to its node's bus point: lead extension in the pin's
 *      facing direction, then a single 90° turn to the bus.
 *   5. Stamp junction dots on nodes that have ≥3 wires meeting.
 *
 * The output consumed by `SchematicSvg` is a plain data object — no
 * React / JSX here, keeping the geometry easy to unit-test.
 */

import { SYMBOLS, rotateXY, rotateSide, pickSymbol } from './symbols.js';

const GRID = 20; // pixel grid used for snapping

function mulberry32(seed) {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6D2B79F5) >>> 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

function snap(v) { return Math.round(v / GRID) * GRID; }

/** Collect every node index that the given element connects to. */
function collectPinNodes(el) {
    switch (el.type) {
        case 'R': case 'C': case 'L': case 'V': case 'I': case 'D':
            return [el.n1, el.n2];
        case 'E': case 'G':
            return [el.n1, el.n2, el.nc1, el.nc2];
        case 'O':
            return [el.inp, el.inn, el.out];
        case 'Q':
            return [el.nc, el.nb, el.ne];
        case 'M':
            return [el.nd, el.ng, el.ns, el.nbulk];
        default: return [];
    }
}

/** Return a map from pin-id (local) to electrical node index. */
function pinToNode(el) {
    switch (el.type) {
        case 'R': case 'C': case 'L': case 'V': case 'I': case 'D':
            return { n1: el.n1, n2: el.n2 };
        case 'E': case 'G':
            return { n1: el.n1, n2: el.n2, nc1: el.nc1, nc2: el.nc2 };
        case 'O':
            return { inp: el.inp, inn: el.inn, out: el.out };
        case 'Q':
            return { nc: el.nc, nb: el.nb, ne: el.ne };
        case 'M':
            return { nd: el.nd, ng: el.ng, ns: el.ns, nbulk: el.nbulk };
        default: return {};
    }
}

// ---------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------

export function layoutSchematic(parsed, { width = 1020, height = 620, seed = 1 } = {}) {
    const W = width, H = height;
    const rand = mulberry32(seed);

    // -------- 1. Force-directed rough placement --------
    const nodeActors = new Map();
    const nodeLabels = parsed.nodeNames || [];
    for (let i = 0; i < parsed.nNodes; i++) {
        nodeActors.set(i, {
            x: W * (0.2 + 0.6 * rand()),
            y: H * (0.2 + 0.6 * rand()),
            vx: 0, vy: 0,
            pinned: i === 0,
            isGround: i === 0,
            label: i === 0 ? 'GND' : (nodeLabels[i] || `n${i}`),
        });
    }
    // Pin ground to bottom-centre so the graph never flips.
    nodeActors.get(0).x = W / 2;
    nodeActors.get(0).y = H - 60;

    const compActors = parsed.elements.map((el, i) => ({
        x: W * (0.25 + 0.5 * rand()),
        y: H * (0.25 + 0.5 * rand()),
        vx: 0, vy: 0,
        element: el,
        index: i,
    }));

    const edges = [];
    for (const c of compActors) {
        for (const n of collectPinNodes(c.element)) {
            if (n == null) continue;
            edges.push({ comp: c, node: nodeActors.get(n) });
        }
    }

    const nIter = 400;
    const kAttract = 0.045;
    const kRepel = 2600;
    const damping = 0.82;
    const maxStep = 16;
    const all = [...nodeActors.values(), ...compActors];
    for (let iter = 0; iter < nIter; iter++) {
        for (const a of all) { a.fx = 0; a.fy = 0; }
        for (let i = 0; i < all.length; i++) {
            const a = all[i];
            if (a.pinned) continue;
            for (let j = 0; j < all.length; j++) {
                if (i === j) continue;
                const b = all[j];
                const dx = a.x - b.x, dy = a.y - b.y;
                const d2 = dx * dx + dy * dy + 120;
                const inv = 1 / Math.sqrt(d2);
                const f = kRepel / d2;
                a.fx += f * dx * inv;
                a.fy += f * dy * inv;
            }
        }
        for (const { comp, node } of edges) {
            const dx = node.x - comp.x, dy = node.y - comp.y;
            comp.fx += kAttract * dx;
            comp.fy += kAttract * dy;
            if (!node.pinned) {
                node.fx -= kAttract * dx;
                node.fy -= kAttract * dy;
            }
        }
        for (const a of all) {
            if (a.pinned) continue;
            a.fx += (W / 2 - a.x) * 0.0025;
            a.fy += (H / 2 - a.y) * 0.0025;
        }
        for (const a of all) {
            if (a.pinned) continue;
            a.vx = (a.vx + a.fx) * damping;
            a.vy = (a.vy + a.fy) * damping;
            const m = Math.hypot(a.vx, a.vy);
            if (m > maxStep) { a.vx *= maxStep / m; a.vy *= maxStep / m; }
            a.x += a.vx;
            a.y += a.vy;
            a.x = Math.max(60, Math.min(W - 60, a.x));
            a.y = Math.max(50, Math.min(H - 80, a.y));
        }
    }

    // -------- 2. Orient components + snap to grid --------
    const components = compActors.map((c) => {
        const el = c.element;
        const sym = pickSymbol(el, parsed.models) || SYMBOLS[el.type];
        if (!sym) return null;
        const p2n = pinToNode(el);
        let rot = 0;

        // Two-pin components: align pin axis with n1→n2 direction,
        // biasing toward vertical if one pin is ground (so caps/
        // resistors to ground read naturally).
        if (['R', 'C', 'L', 'V', 'I', 'D'].includes(el.type)) {
            const n1 = nodeActors.get(p2n.n1);
            const n2 = nodeActors.get(p2n.n2);
            const dx = n2.x - n1.x;
            const dy = n2.y - n1.y;
            const groundIsN2 = p2n.n2 === 0;
            const groundIsN1 = p2n.n1 === 0;
            if (groundIsN1 || groundIsN2) {
                // Vertical with ground pointing down.
                rot = groundIsN2 ? 90 : 270;
            } else if (Math.abs(dy) > Math.abs(dx) * 1.2) {
                rot = dy >= 0 ? 90 : 270;
            } else {
                rot = dx >= 0 ? 0 : 180;
            }
            // Centre component midway between its two connected nodes.
            c.x = (n1.x + n2.x) / 2;
            c.y = (n1.y + n2.y) / 2;
        } else if (el.type === 'O') {
            // Op-amp: always left-to-right (inputs left, output right).
            const inp = nodeActors.get(p2n.inp);
            const inn = nodeActors.get(p2n.inn);
            const out = nodeActors.get(p2n.out);
            c.x = (inp.x + inn.x + out.x) / 3;
            c.y = (inp.y + inn.y + out.y) / 3;
            // Flip if the output is to the left of the inputs.
            const inputCentreX = (inp.x + inn.x) / 2;
            rot = out.x < inputCentreX ? 180 : 0;
        } else if (el.type === 'E' || el.type === 'G') {
            const n1 = nodeActors.get(p2n.n1);
            const n2 = nodeActors.get(p2n.n2);
            const c1 = nodeActors.get(p2n.nc1);
            const c2 = nodeActors.get(p2n.nc2);
            c.x = (n1.x + n2.x + c1.x + c2.x) / 4;
            c.y = (n1.y + n2.y + c1.y + c2.y) / 4;
            const outMid = (n1.x + n2.x) / 2;
            const ctlMid = (c1.x + c2.x) / 2;
            rot = outMid < ctlMid ? 180 : 0;
        } else if (el.type === 'Q') {
            /* BJT: default orientation has collector up, emitter down,
               base on the left. We keep that 3-terminal stance whenever
               possible (it matches textbook convention). The centre of
               the symbol is placed near the average of its nodes so the
               subsequent spread pass lines them up cleanly. */
            const nC = nodeActors.get(p2n.nc);
            const nB = nodeActors.get(p2n.nb);
            const nE = nodeActors.get(p2n.ne);
            c.x = (nC.x + nB.x + nE.x) / 3;
            c.y = (nC.y + nB.y + nE.y) / 3;
            rot = 0;
        } else if (el.type === 'M') {
            const nD = nodeActors.get(p2n.nd);
            const nG = nodeActors.get(p2n.ng);
            const nS = nodeActors.get(p2n.ns);
            c.x = (nD.x + nG.x + nS.x) / 3;
            c.y = (nD.y + nG.y + nS.y) / 3;
            rot = 0;
        }

        return {
            index: c.index,
            element: el,
            type: el.type,
            x: snap(c.x),
            y: snap(c.y),
            rot,
            sym,
            p2n,
        };
    }).filter(Boolean);

    // -------- 3. Spread overlapping component bodies --------
    // Iteratively push apart any pair whose axis-aligned bounding
    // boxes overlap. This is O(K·N²) but N is small (≲20 in typical
    // demos) and K is capped at 40 iterations, so it's essentially
    // free and produces much cleaner schematics than random force-
    // directed placements on their own.
    for (let pass = 0; pass < 40; pass++) {
        let moved = false;
        for (let i = 0; i < components.length; i++) {
            for (let j = i + 1; j < components.length; j++) {
                const a = components[i], b = components[j];
                const aw = (a.rot === 90 || a.rot === 270) ? a.sym.height : a.sym.width;
                const ah = (a.rot === 90 || a.rot === 270) ? a.sym.width  : a.sym.height;
                const bw = (b.rot === 90 || b.rot === 270) ? b.sym.height : b.sym.width;
                const bh = (b.rot === 90 || b.rot === 270) ? b.sym.width  : b.sym.height;
                const pad = 20;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const minDx = (aw + bw) / 2 + pad;
                const minDy = (ah + bh) / 2 + pad;
                if (Math.abs(dx) < minDx && Math.abs(dy) < minDy) {
                    // Push along the axis with the smaller required
                    // separation (usually cheaper visually).
                    const ovX = minDx - Math.abs(dx);
                    const ovY = minDy - Math.abs(dy);
                    if (ovX < ovY) {
                        const push = Math.ceil(ovX / 2 / GRID) * GRID;
                        a.x -= Math.sign(dx || 1) * push;
                        b.x += Math.sign(dx || 1) * push;
                    } else {
                        const push = Math.ceil(ovY / 2 / GRID) * GRID;
                        a.y -= Math.sign(dy || 1) * push;
                        b.y += Math.sign(dy || 1) * push;
                    }
                    a.x = snap(a.x); a.y = snap(a.y);
                    b.x = snap(b.x); b.y = snap(b.y);
                    moved = true;
                }
            }
        }
        if (!moved) break;
    }

    // -------- 4. Compute world pin positions --------
    // NOTE: component centres (c.x, c.y) are already snapped to the
    // grid. We deliberately do NOT re-snap the rotated pin offsets —
    // capacitors have pins at ±30 px and inductors at ±38 px, neither
    // of which is a multiple of GRID=20. Snapping here would shift
    // the pin coord away from where `componentPins()` returns it,
    // which leaves downstream wires dangling in the SchematicDoc.
    for (const c of components) {
        c.pinWorld = c.sym.pins.map((p) => {
            const r = rotateXY(p.x, p.y, c.rot);
            return {
                id: p.id,
                node: c.p2n[p.id],
                x: c.x + r.x,
                y: c.y + r.y,
                side: rotateSide(p.side, c.rot),
            };
        });
    }

    // -------- 5. Bus points per node --------
    // The bus point is where a node's wires meet. Chosen as the
    // snapped centroid of its connected pin positions, nudged if it
    // collides with a component body.
    const nodePins = new Map(); // nodeId -> [{x,y,side}, ...]
    for (const c of components) {
        for (const pw of c.pinWorld) {
            if (pw.node == null) continue;
            if (!nodePins.has(pw.node)) nodePins.set(pw.node, []);
            nodePins.get(pw.node).push(pw);
        }
    }

    const nodeBus = new Map();
    for (const [nid, actor] of nodeActors.entries()) {
        const pins = nodePins.get(nid) || [];
        let bx, by;
        if (nid === 0) {
            bx = snap(W / 2);
            by = snap(H - 40);
        } else if (pins.length === 0) {
            bx = snap(actor.x);
            by = snap(actor.y);
        } else {
            bx = snap(pins.reduce((s, p) => s + p.x, 0) / pins.length);
            by = snap(pins.reduce((s, p) => s + p.y, 0) / pins.length);
        }
        // Avoid sitting right on top of a component body.
        bx = nudgeAway(components, bx, by).x;
        by = nudgeAway(components, bx, by).y;
        nodeBus.set(nid, { id: nid, x: bx, y: by, label: actor.label, isGround: nid === 0 });
    }

    // -------- 6. Manhattan route pin → bus --------
    const wires = [];
    for (const c of components) {
        for (const pw of c.pinWorld) {
            if (pw.node == null) continue;
            const bus = nodeBus.get(pw.node);
            if (!bus) continue;
            const pts = routeWire(pw, bus);
            wires.push({ nodeId: pw.node, points: pts });
        }
    }

    // -------- 7. Junction dots --------
    // A node earns a junction dot where 3+ segments meet at a point.
    // For our simple router this is the bus point whenever a node has
    // 3+ wires attaching to it.
    const junctions = [];
    for (const [nid, pins] of nodePins.entries()) {
        if (nid === 0) continue;           // ground has its own glyph
        if (pins.length < 3) continue;
        const bus = nodeBus.get(nid);
        if (bus) junctions.push({ x: bus.x, y: bus.y, nodeId: nid });
    }

    // -------- 8. Node colour palette --------
    const palette = [
        '#3b82f6', '#f59e0b', '#10b981', '#ef4444',
        '#a855f7', '#ec4899', '#22d3ee', '#84cc16',
        '#f97316', '#6366f1', '#14b8a6', '#eab308',
    ];
    const nodeColor = new Map();
    nodeColor.set(0, '#64748b');
    let pIdx = 0;
    for (const nid of nodeBus.keys()) {
        if (nid === 0) continue;
        nodeColor.set(nid, palette[pIdx % palette.length]);
        pIdx++;
    }

    // -------- 9. Component labels --------
    for (const c of components) {
        const ref = componentRef(c.element);
        const val = componentValue(c.element);
        // For vertical orientations, push labels to the sides.
        const vertical = c.rot === 90 || c.rot === 270;
        c.labelRef = vertical
            ? { x: c.x + c.sym.height / 2 + 8, y: c.y - 8, anchor: 'start', text: ref }
            : { x: c.x + c.sym.labelRef.x,      y: c.y + c.sym.labelRef.y, anchor: c.sym.labelRef.anchor, text: ref };
        c.labelVal = vertical
            ? { x: c.x + c.sym.height / 2 + 8, y: c.y + 10, anchor: 'start', text: val }
            : { x: c.x + c.sym.labelVal.x,      y: c.y + c.sym.labelVal.y, anchor: c.sym.labelVal.anchor, text: val };
    }

    // Compute actual content bounds so we can trim whitespace around
    // the diagram rather than forcing the full W×H canvas.
    const bounds = contentBounds(components, wires, nodeBus);

    return {
        width: bounds.width,
        height: bounds.height,
        offsetX: -bounds.minX,
        offsetY: -bounds.minY,
        components,
        wires,
        junctions,
        nodes: [...nodeBus.values()],
        nodeColor,
    };
}

// --------------------------------------------------------------
// Helpers
// --------------------------------------------------------------

function nudgeAway(components, x, y) {
    const pad = 18;
    for (const c of components) {
        const w = (c.rot === 90 || c.rot === 270) ? c.sym.height : c.sym.width;
        const h = (c.rot === 90 || c.rot === 270) ? c.sym.width  : c.sym.height;
        const x0 = c.x - w / 2 - pad, x1 = c.x + w / 2 + pad;
        const y0 = c.y - h / 2 - pad, y1 = c.y + h / 2 + pad;
        if (x > x0 && x < x1 && y > y0 && y < y1) {
            // Push out horizontally, preferring the closer edge.
            const leftDist  = Math.abs(x - x0);
            const rightDist = Math.abs(x1 - x);
            return leftDist < rightDist ? { x: snap(x0 - GRID), y } : { x: snap(x1 + GRID), y };
        }
    }
    return { x, y };
}

function routeWire(pin, bus) {
    // Simple two-segment Manhattan route with pin-facing bias. If the
    // pin is horizontal (L/R), the wire leaves the pin horizontally
    // first, then turns 90° to meet the bus. Vertical pins (T/B) do
    // the opposite. This avoids the nasty "stub out and return" loop
    // that a naive fixed-lead extension produces when the bus
    // happens to share the pin's axis.
    if (pin.x === bus.x && pin.y === bus.y) return [[pin.x, pin.y]];

    const horizontalPin = pin.side === 'L' || pin.side === 'R';
    const pts = [[pin.x, pin.y]];
    if (horizontalPin) {
        if (pin.y !== bus.y) pts.push([bus.x, pin.y]);
    } else {
        if (pin.x !== bus.x) pts.push([pin.x, bus.y]);
    }
    pts.push([bus.x, bus.y]);
    return dedupePoints(pts);
}

function dedupePoints(pts) {
    const out = [];
    for (const p of pts) {
        const last = out[out.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
    return out;
}

function contentBounds(components, wires, nodeBus) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const pad = 60;
    const bump = (x, y) => {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    };
    for (const c of components) {
        const w = (c.rot === 90 || c.rot === 270) ? c.sym.height : c.sym.width;
        const h = (c.rot === 90 || c.rot === 270) ? c.sym.width  : c.sym.height;
        bump(c.x - w / 2, c.y - h / 2);
        bump(c.x + w / 2, c.y + h / 2);
    }
    for (const w of wires) for (const [x, y] of w.points) bump(x, y);
    for (const b of nodeBus.values()) bump(b.x, b.y);
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 400; maxY = 300; }
    return {
        minX: minX - pad,
        minY: minY - pad,
        width:  (maxX - minX) + pad * 2,
        height: (maxY - minY) + pad * 2,
    };
}

// --------------------------------------------------------------
// Label helpers
// --------------------------------------------------------------

function componentRef(el) {
    return el.name || el.type;
}

function componentValue(el) {
    if (el == null) return '';
    switch (el.type) {
        case 'R': return formatValue(el.value, 'Ω');
        case 'C': return formatValue(el.value, 'F');
        case 'L': return formatValue(el.value, 'H');
        case 'V': return sourceSummary(el.source, 'V');
        case 'I': return sourceSummary(el.source, 'A');
        case 'D': return el.model || '';
        case 'E': return `E = ${fmtGain(el.gain)}`;
        case 'G': return `g = ${fmtGain(el.gm)} S`;
        case 'O': return 'op-amp';
        case 'Q': return el.model ? el.model.toUpperCase() : '';
        case 'M': {
            const tag = el.model ? el.model.toUpperCase() : '';
            if (el.W && el.L) return `${tag} W/L=${formatValue(el.W, 'm').replace(' ', '')}/${formatValue(el.L, 'm').replace(' ', '')}`;
            return tag;
        }
        default:  return '';
    }
}

function sourceSummary(src, unit) {
    if (!Array.isArray(src) || src.length === 0) return '';
    const parts = [];
    const dc = src.find((s) => s.kind === 'dc');
    const ac = src.find((s) => s.kind === 'ac');
    const fn = src.find((s) => ['sin', 'pulse', 'pwl', 'exp'].includes(s.kind));
    if (dc) parts.push(`DC ${formatValue(dc.v, unit)}`);
    if (ac) parts.push(`AC ${formatValue(ac.mag, unit)}`);
    if (fn) parts.push(fn.kind.toUpperCase());
    return parts.join(' + ');
}

function fmtGain(v) {
    if (!Number.isFinite(v)) return '—';
    if (Math.abs(v) >= 1000) return v.toExponential(2);
    return v.toPrecision(3);
}

/** Engineering-notation value with SI prefix. */
export function formatValue(v, unit) {
    if (!Number.isFinite(v)) return '—';
    const av = Math.abs(v);
    if (av === 0) return `0 ${unit}`;
    const prefixes = [
        { m: 1e12, s: 'T' }, { m: 1e9, s: 'G' }, { m: 1e6, s: 'M' },
        { m: 1e3, s: 'k' }, { m: 1, s: '' }, { m: 1e-3, s: 'm' },
        { m: 1e-6, s: 'µ' }, { m: 1e-9, s: 'n' }, { m: 1e-12, s: 'p' },
        { m: 1e-15, s: 'f' },
    ];
    for (const p of prefixes) {
        if (av >= p.m) {
            const scaled = v / p.m;
            const rounded = Math.abs(scaled) >= 100 ? scaled.toFixed(0)
                          : Math.abs(scaled) >= 10  ? scaled.toFixed(1)
                          :                            scaled.toFixed(2);
            return `${rounded} ${p.s}${unit}`;
        }
    }
    return `${v.toExponential(2)} ${unit}`;
}

/**
 * Legacy entry point kept for callers that still want a single
 * human-readable label (unused by the new renderer, but cheap to
 * preserve in case a tour step references it).
 */
export function componentLabel(el) {
    const ref = componentRef(el);
    const val = componentValue(el);
    return val ? `${ref}\n${val}` : ref;
}
