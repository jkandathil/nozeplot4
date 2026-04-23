/**
 * Auto-layout "schematic preview" for Circuit Studio.
 *
 * This is NOT a full schematic editor — Phase 1 just needs a readable
 * picture of a netlist so users can sanity-check connectivity before
 * hitting Run. The proper drag-and-drop editor lands in Phase 2.
 *
 * Approach: treat the netlist as a bipartite graph (electrical nodes
 * ⇿ components), run a tiny force-directed layout, and render each
 * component at its layout position with an IEEE-ish symbol. Wires are
 * straight lines from component pins to the corresponding node
 * junction, coloured per-node for legibility.
 *
 * The layout is deterministic (seeded RNG + fixed iteration count) so
 * the same netlist always renders the same picture, which matters
 * when a user tweaks values and expects visual stability.
 */

function mulberry32(seed) {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6D2B79F5) >>> 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Build a lightweight layout model.  Inputs: parsed netlist (from
 * netlist.js). Returns `{ nodes, comps, wires, width, height }` with
 * coordinates in a 0..W, 0..H SVG canvas.
 */
export function layoutSchematic(parsed, { width = 640, height = 420, seed = 1 } = {}) {
    const rand = mulberry32(seed);
    const W = width, H = height;

    // Layout actors — one per electrical node (except ground, which we
    // pin at the bottom-centre) and one per component.
    const nodeActors = new Map();      // nodeIdx -> {x,y,vx,vy, isGround, label}
    const nodeLabels = parsed.nodeNames || [];
    for (let i = 0; i < parsed.nNodes; i++) {
        nodeActors.set(i, {
            x: W * (0.2 + 0.6 * rand()),
            y: H * (0.2 + 0.6 * rand()),
            vx: 0, vy: 0,
            isGround: i === 0,
            pinned: i === 0,
            label: i === 0 ? 'GND' : (nodeLabels[i] || `n${i}`),
        });
    }
    // Pin ground near bottom-centre so the layout doesn't flip upside-down.
    nodeActors.get(0).x = W / 2;
    nodeActors.get(0).y = H - 40;

    const compActors = parsed.elements.map((el, i) => ({
        x: W * (0.25 + 0.5 * rand()),
        y: H * (0.25 + 0.5 * rand()),
        vx: 0, vy: 0,
        element: el,
        index: i,
    }));

    // Edges: component → its pin nodes.
    const edges = [];
    for (const c of compActors) {
        const e = c.element;
        const pins = collectPinNodes(e);
        for (const n of pins) {
            if (n == null) continue;
            edges.push({ comp: c, node: nodeActors.get(n) });
        }
    }

    // Tiny force-directed sim: attraction along edges + global repulsion.
    const nIter = 300;
    const kAttract = 0.04;
    const kRepel = 1400;
    const damping = 0.82;
    const maxStep = 14;
    const all = [...nodeActors.values(), ...compActors];
    for (let iter = 0; iter < nIter; iter++) {
        for (const a of all) { a.fx = 0; a.fy = 0; }
        // Repulsion between all actors (O(N²) but N ≲ 100 in practice).
        for (let i = 0; i < all.length; i++) {
            const a = all[i];
            if (a.pinned) continue;
            for (let j = 0; j < all.length; j++) {
                if (i === j) continue;
                const b = all[j];
                const dx = a.x - b.x, dy = a.y - b.y;
                const d2 = dx * dx + dy * dy + 100;
                const f = kRepel / d2;
                a.fx += f * dx / Math.sqrt(d2);
                a.fy += f * dy / Math.sqrt(d2);
            }
        }
        // Edge attraction.
        for (const { comp, node } of edges) {
            const dx = node.x - comp.x, dy = node.y - comp.y;
            comp.fx += kAttract * dx;
            comp.fy += kAttract * dy;
            if (!node.pinned) {
                node.fx -= kAttract * dx;
                node.fy -= kAttract * dy;
            }
        }
        // Centering pull (weak) so the graph doesn't drift off-canvas.
        for (const a of all) {
            if (a.pinned) continue;
            a.fx += (W / 2 - a.x) * 0.002;
            a.fy += (H / 2 - a.y) * 0.002;
        }
        // Integrate with damped velocity + step clamp.
        for (const a of all) {
            if (a.pinned) continue;
            a.vx = (a.vx + a.fx) * damping;
            a.vy = (a.vy + a.fy) * damping;
            const m = Math.hypot(a.vx, a.vy);
            if (m > maxStep) { a.vx *= maxStep / m; a.vy *= maxStep / m; }
            a.x += a.vx;
            a.y += a.vy;
            a.x = Math.max(30, Math.min(W - 30, a.x));
            a.y = Math.max(30, Math.min(H - 30, a.y));
        }
    }

    // Build the render-ready graph.
    const outNodes = [...nodeActors.entries()].map(([idx, a]) => ({
        id: idx, label: a.label, x: a.x, y: a.y, isGround: a.isGround,
    }));
    const outComps = compActors.map((c) => ({
        index: c.index,
        element: c.element,
        x: c.x, y: c.y,
        pins: collectPinNodes(c.element),
    }));
    // Unique colour per node (ground gets neutral grey).
    const palette = [
        '#64748b', '#3b82f6', '#f59e0b', '#10b981',
        '#ef4444', '#a855f7', '#ec4899', '#22d3ee',
        '#84cc16', '#f97316', '#6366f1', '#14b8a6',
    ];
    const nodeColor = new Map();
    for (let i = 0; i < outNodes.length; i++) {
        nodeColor.set(outNodes[i].id, i === 0 ? '#6b7280' : palette[(i - 1) % (palette.length - 1) + 1]);
    }
    return { nodes: outNodes, comps: outComps, nodeColor, width: W, height: H };
}

function collectPinNodes(el) {
    switch (el.type) {
        case 'R': case 'C': case 'L': case 'V': case 'I': case 'D':
            return [el.n1, el.n2];
        case 'E': case 'G':
            return [el.n1, el.n2, el.nc1, el.nc2];
        case 'O':
            return [el.inp, el.inn, el.out];
        default: return [];
    }
}

/**
 * Return a short human label (with units) for a component. Used in
 * the schematic preview under each symbol.
 */
export function componentLabel(el) {
    if (el == null) return '';
    switch (el.type) {
        case 'R': return `${el.name}\n${formatValue(el.value, 'Ω')}`;
        case 'C': return `${el.name}\n${formatValue(el.value, 'F')}`;
        case 'L': return `${el.name}\n${formatValue(el.value, 'H')}`;
        case 'V': {
            const ac = el.source.find((s) => s.kind === 'ac');
            const dc = el.source.find((s) => s.kind === 'dc');
            const fn = el.source.find((s) => ['sin', 'pulse', 'pwl', 'exp'].includes(s.kind));
            const parts = [];
            if (dc) parts.push(`DC ${formatValue(dc.v, 'V')}`);
            if (ac) parts.push(`AC ${formatValue(ac.mag, 'V')}`);
            if (fn) parts.push(fn.kind.toUpperCase());
            return `${el.name}\n${parts.join(' + ')}`;
        }
        case 'I': {
            const dc = el.source.find((s) => s.kind === 'dc');
            return `${el.name}\n${dc ? formatValue(dc.v, 'A') : 'src'}`;
        }
        case 'D': return `${el.name}\n(${el.model})`;
        case 'E': return `${el.name}\nE=${el.gain.toPrecision(3)}`;
        case 'G': return `${el.name}\ng=${el.gm.toPrecision(3)}`;
        case 'O': return `${el.name}\nop-amp`;
        default: return el.name || el.type;
    }
}

function formatValue(v, unit) {
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
                          : Math.abs(scaled) >= 10 ? scaled.toFixed(1)
                          : scaled.toFixed(2);
            return `${rounded} ${p.s}${unit}`;
        }
    }
    return `${v.toExponential(2)} ${unit}`;
}
