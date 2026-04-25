/**
 * IEEE/ANSI component symbol library for Circuit Studio's schematic
 * renderer. Each entry describes a component as a small list of
 * drawing primitives in local coordinates (symbol centred on 0,0),
 * plus pin definitions consumed by the auto-layout + wire router.
 *
 * Keeping this as a data table (rather than JSX) means the geometry
 * stays in a plain .js file with zero React dependency — the SVG in
 * CircuitStudioPage.jsx iterates over `shapes` and emits primitives.
 *
 * Coordinate conventions:
 *   • Default orientation is horizontal. Two-terminal symbols have
 *     their pins on the ±X axis; multi-pin symbols have their main
 *     flow left→right (inputs on the left, output on the right).
 *   • Pin `side` is one of 'L'/'R'/'T'/'B' and tells the wire router
 *     which direction the lead leaves the body.
 *   • `labelRef` / `labelVal` are default positions (relative to the
 *     symbol centre) for the reference designator and value text.
 *     For vertical orientations the renderer flips/rotates them.
 *
 * Polarity vs. netlist (must match emitNetlist.js pinOrderFor + solver):
 *   • V / I: pin n1 is the left terminal in local space, n2 the right.
 *     SPICE: V(n1)−V(n2) equals the source value; +/− glyphs sit on n1/n2.
 *     Current arrow points n1 → n2 for the positive reference current.
 *   • D: n1 = anode, n2 = cathode (bar end); small A/K labels mark that.
 *   • O: pin inp = non-inverting (+), inn = inverting (−), out = output.
 *   • E / G: output n1 (top) = + sense, n2 (bottom) = −; control nc1/nc2 on the left.
 */

export const SYMBOL_STROKE_WIDTH = 1.6;

// ---------- Helpers ------------------------------------------------

function twoTerm({ width, body, pinsAt }) {
    const half = pinsAt != null ? pinsAt : width / 2;
    return {
        width, height: 40,
        pins: [
            { id: 'n1', x: -half, y: 0, side: 'L' },
            { id: 'n2', x:  half, y: 0, side: 'R' },
        ],
        shapes: body,
        labelRef: { x: 0, y: -22, anchor: 'middle', baseline: 'baseline' },
        labelVal: { x: 0, y:  30, anchor: 'middle', baseline: 'hanging'  },
    };
}

function leads(half, bodyHalf) {
    return [
        { kind: 'line', x1: -half,    y1: 0, x2: -bodyHalf, y2: 0 },
        { kind: 'line', x1:  bodyHalf, y1: 0, x2:  half,    y2: 0 },
    ];
}

// ---------- Resistor (ANSI zigzag) --------------------------------

const R_SYMBOL = twoTerm({
    width: 80,
    body: [
        ...leads(40, 24),
        {
            kind: 'path',
            d: 'M -24 0 L -20 -7 L -14 7 L -8 -7 L -2 7 L 4 -7 L 10 7 L 16 -7 L 20 7 L 24 0',
            fill: 'none',
        },
    ],
});

// ---------- Capacitor (two plates) ---------------------------------

const C_SYMBOL = twoTerm({
    width: 60,
    pinsAt: 30,
    body: [
        ...leads(30, 5),
        { kind: 'line', x1: -5, y1: -14, x2: -5, y2: 14, strokeWidth: 2 },
        { kind: 'line', x1:  5, y1: -14, x2:  5, y2: 14, strokeWidth: 2 },
    ],
});

// ---------- Inductor (four bumps) ---------------------------------

const L_SYMBOL = twoTerm({
    width: 76,
    pinsAt: 38,
    body: [
        { kind: 'line', x1: -38, y1: 0, x2: -28, y2: 0 },
        { kind: 'line', x1:  28, y1: 0, x2:  38, y2: 0 },
        {
            kind: 'path',
            d: 'M -28 0 A 7 7 0 0 1 -14 0 A 7 7 0 0 1 0 0 A 7 7 0 0 1 14 0 A 7 7 0 0 1 28 0',
            fill: 'none',
        },
    ],
});

// ---------- Voltage source (circle + polarity) --------------------

const V_SYMBOL = twoTerm({
    width: 80,
    pinsAt: 40,
    body: [
        ...leads(40, 18),
        { kind: 'circle', cx: 0, cy: 0, r: 18, fill: 'var(--sch-body)' },
        // Pin n1 (left lead) is SPICE node+; n2 (right) is node−. Glyphs must
        // match emitNetlist / solver order so rotation + wiring match user expectation.
        { kind: 'polarity', sign: '+', x: -8, y: -6 },
        { kind: 'polarity', sign: '−', x:  8, y: -6 },
    ],
});

// ---------- Current source (circle + arrow) ----------------------
// Arrow points n1 → n2: positive branch current flows from pin n1 to n2.

const I_SYMBOL = twoTerm({
    width: 80,
    pinsAt: 40,
    body: [
        ...leads(40, 18),
        { kind: 'circle', cx: 0, cy: 0, r: 18, fill: 'var(--sch-body)' },
        { kind: 'line', x1: -8, y1: 0, x2: 6, y2: 0, strokeWidth: 1.8 },
        { kind: 'arrow', x: 6, y: 0, dir: 'R', size: 6 },
    ],
});

// ---------- Diode (triangle + cathode bar) -----------------------

const D_SYMBOL = twoTerm({
    width: 60,
    pinsAt: 30,
    body: [
        { kind: 'line', x1: -30, y1: 0, x2: -10, y2: 0 },
        { kind: 'path', d: 'M -10 -10 L -10 10 L 10 0 Z', fill: 'var(--sch-stroke)' },
        { kind: 'line', x1: 10, y1: -10, x2: 10, y2: 10, strokeWidth: 2 },
        { kind: 'line', x1: 10, y1: 0,   x2: 30, y2: 0 },
        // n1 = anode (triangle), n2 = cathode (bar) — matches SPICE D order.
        { kind: 'text', x: -18, y: -16, text: 'A', fontSize: 8, fontWeight: 700, anchor: 'middle', baseline: 'middle' },
        { kind: 'text', x:  18, y: -16, text: 'K', fontSize: 8, fontWeight: 700, anchor: 'middle', baseline: 'middle' },
    ],
});

// ---------- Op-amp (triangle, + and - inputs, out) ---------------
//
// Orientation note: pins live on the *body* edge (not at the ends of
// leads). The router's "lead extension" handles drawing the stub
// between body edge and routing space, so putting pins on the body
// keeps the triangle visually coherent.

const O_SYMBOL = {
    width: 72,
    height: 56,
    pins: [
        { id: 'inp', x: -24, y: -14, side: 'L' },
        { id: 'inn', x: -24, y:  14, side: 'L' },
        { id: 'out', x:  28, y:   0, side: 'R' },
    ],
    shapes: [
        { kind: 'path', d: 'M -24 -26 L -24 26 L 28 0 Z', fill: 'var(--sch-body)' },
        // inp = non-inverting (+), inn = inverting (−) — matches solver V(inp)−V(inn)=0.
        { kind: 'text', x: -18, y: -14, text: '+', fontSize: 12, fontWeight: 600, anchor: 'start', baseline: 'middle' },
        { kind: 'text', x: -18, y:  14, text: '−', fontSize: 14, fontWeight: 700, anchor: 'start', baseline: 'middle' },
    ],
    labelRef: { x: 0, y: -34, anchor: 'middle', baseline: 'baseline' },
    labelVal: { x: 0, y:  36, anchor: 'middle', baseline: 'hanging'  },
};

// ---------- VCVS / VCCS (diamond dependent source) ----------------
//
// Stamped as four-terminal: n1/n2 on the output side, nc1/nc2 on the
// control side. We lay them out as a diamond with output pins on the
// right and control "ports" (dashed short leads) on the left.

function dependentSource(kindTag) {
    return {
        width: 80,
        height: 60,
        pins: [
            { id: 'nc1', x: -40, y: -14, side: 'L' },
            { id: 'nc2', x: -40, y:  14, side: 'L' },
            { id: 'n1',  x:  40, y: -14, side: 'R' },
            { id: 'n2',  x:  40, y:  14, side: 'R' },
        ],
        shapes: [
            { kind: 'path', d: 'M 0 -22 L 22 0 L 0 22 L -22 0 Z', fill: 'var(--sch-body)' },
            { kind: 'text', x: 0, y: 0, text: kindTag, fontSize: 11, fontWeight: 600, anchor: 'middle', baseline: 'middle' },
            { kind: 'line', x1: -40, y1: -14, x2: -22, y2: -14, strokeDasharray: '4 3' },
            { kind: 'line', x1: -40, y1:  14, x2: -22, y2:  14, strokeDasharray: '4 3' },
            { kind: 'line', x1:  22, y1: -14, x2:  40, y2: -14 },
            { kind: 'line', x1:  22, y1:  14, x2:  40, y2:  14 },
            // Output pins n1 (top) / n2 (bottom): V(n1)−V(n2) = gain·V(nc1,nc2) for E, etc.
            { kind: 'polarity', sign: '+', x: 34, y: -20 },
            { kind: 'polarity', sign: '−', x: 34, y:  20 },
        ],
        labelRef: { x: 0, y: -32, anchor: 'middle', baseline: 'baseline' },
        labelVal: { x: 0, y:  36, anchor: 'middle', baseline: 'hanging'  },
    };
}

const E_SYMBOL = dependentSource('E');
const G_SYMBOL = dependentSource('G');

// ---------- BJT (NPN / PNP) ---------------------------------------
//
// Classic transistor glyph: a circle enclosing the base vertical line,
// collector (top) and emitter (bottom) leads angling out at ~45°. The
// emitter arrow points OUT of the device for NPN ("Not Pointing iN"),
// INTO the device for PNP. Base pin is on the left so the schematic
// router can feed it naturally; C is "up", E is "down".
//
// Pin ids match the solver's netlist order: nc (collector), nb (base),
// ne (emitter).

function bjtSymbol(variant) {
    const isNPN = variant === 'NPN';
    // Arrow pointing TOWARD the junction? For NPN: arrow points from
    // junction → emitter (i.e., "out of the base"). For PNP: arrow
    // points from emitter → junction ("into the base").
    const arrowNPN = {
        kind: 'path',
        d: 'M 6 18 L 14 26 L 2 26 Z', // filled arrow head near the emitter lead
        fill: 'var(--sch-stroke)',
    };
    const arrowPNP = {
        kind: 'path',
        d: 'M -4 10 L 4 18 L -4 18 Z',
        fill: 'var(--sch-stroke)',
    };
    return {
        width: 60,
        height: 80,
        pins: [
            // Collector on top, base on the left (body-wall), emitter on bottom
            { id: 'nc', x:  14, y: -38, side: 'T' },
            { id: 'nb', x: -30, y:   0, side: 'L' },
            { id: 'ne', x:  14, y:  38, side: 'B' },
        ],
        shapes: [
            { kind: 'circle', cx: 0, cy: 0, r: 20, fill: 'var(--sch-body)' },
            // Base vertical bar (inside circle)
            { kind: 'line', x1: -8, y1: -12, x2: -8, y2: 12, strokeWidth: 2 },
            // Base lead (from body wall out to pin)
            { kind: 'line', x1: -30, y1: 0, x2: -8, y2: 0 },
            // Collector slant + lead
            { kind: 'line', x1: -8, y1: -6, x2:  14, y2: -18 },
            { kind: 'line', x1: 14, y1: -18, x2:  14, y2: -38 },
            // Emitter slant + lead
            { kind: 'line', x1: -8, y1:  6, x2:  14, y2:  18 },
            { kind: 'line', x1: 14, y1:  18, x2:  14, y2:  38 },
            // Emitter arrow
            isNPN ? arrowNPN : arrowPNP,
        ],
        labelRef: { x: 28, y: -16, anchor: 'start', baseline: 'middle' },
        labelVal: { x: 28, y:  18, anchor: 'start', baseline: 'middle' },
    };
}

const Q_NPN_SYMBOL = bjtSymbol('NPN');
const Q_PNP_SYMBOL = bjtSymbol('PNP');

// ---------- MOSFET (NMOS / PMOS) ----------------------------------
//
// IEEE-style enhancement MOSFET: gate on the left (separated from
// channel by a vertical gap — emphasising the oxide), channel drawn as
// two short horizontal stubs (broken in the middle = enhancement mode),
// drain on top, source on bottom. Body arrow on the source for NMOS
// (arrow-in), PMOS (arrow-out) — the canonical "what-type-is-it"
// indicator.

function mosSymbol(variant) {
    const isN = variant === 'NMOS';
    // Body-effect arrow on source for quick N/P identification.
    const bodyArrow = isN
        ? { kind: 'path', d: 'M 6 18 L 14 22 L 14 14 Z', fill: 'var(--sch-stroke)' }   // inward
        : { kind: 'path', d: 'M 14 18 L 6  22 L 6  14 Z', fill: 'var(--sch-stroke)' };  // outward
    return {
        width: 64,
        height: 80,
        pins: [
            // Drain top, Gate left, Source bottom, Bulk also bottom (merged w/ source usually)
            { id: 'nd', x:  14, y: -38, side: 'T' },
            { id: 'ng', x: -30, y:   0, side: 'L' },
            { id: 'ns', x:  14, y:  38, side: 'B' },
            { id: 'nbulk', x: -30, y:  22, side: 'L' },
        ],
        shapes: [
            // Gate lead in from the left pin to the gate bar
            { kind: 'line', x1: -30, y1: 0, x2: -14, y2: 0 },
            // Gate bar (vertical)
            { kind: 'line', x1: -14, y1: -16, x2: -14, y2: 16, strokeWidth: 2 },
            // Oxide gap — the channel bar
            { kind: 'line', x1: -8, y1: -16, x2: -8, y2: -4, strokeWidth: 2 },
            { kind: 'line', x1: -8, y1:   4, x2: -8, y2: 16, strokeWidth: 2 },  // enhancement-mode break
            // Drain side
            { kind: 'line', x1: -8,  y1: -14, x2: 14, y2: -14 },
            { kind: 'line', x1: 14,  y1: -14, x2: 14, y2: -38 },
            // Source side
            { kind: 'line', x1: -8,  y1:  14, x2: 14, y2:  14 },
            { kind: 'line', x1: 14,  y1:  14, x2: 14, y2:  38 },
            // Bulk line (short stub, not routed — most schematics tie bulk to source)
            { kind: 'line', x1: -30, y1: 22, x2: -8, y2: 22, strokeDasharray: '3 3' },
            bodyArrow,
        ],
        labelRef: { x: 28, y: -16, anchor: 'start', baseline: 'middle' },
        labelVal: { x: 28, y:  18, anchor: 'start', baseline: 'middle' },
    };
}

const M_NMOS_SYMBOL = mosSymbol('NMOS');
const M_PMOS_SYMBOL = mosSymbol('PMOS');

// ---------- Probes --------------------------------------------------
//
// Voltage probe — a single-pin "test clip" style symbol. Electrically
// it's a no-op (not emitted to SPICE), but it serves as a visual
// anchor that the post-run plumbing uses to auto-select V(node) for
// its attached net on the plot.
const VP_SYMBOL = {
    width: 40, height: 40,
    pins: [{ id: 'tip', x: 0, y: 20, side: 'B' }],
    shapes: [
        { kind: 'line', x1: 0, y1: 20, x2: 0, y2: 6 },
        { kind: 'circle', cx: 0, cy: 0, r: 8, fill: 'none' },
        { kind: 'text', x: 0, y: -12, text: 'V', fontSize: 10, anchor: 'middle', fontWeight: 700 },
    ],
    labelRef: { x: 12, y: 0, anchor: 'start', baseline: 'middle' },
    labelVal: { x: 12, y: 12, anchor: 'start', baseline: 'middle' },
};

// Current probe — an inline ammeter symbol (two pins, bullet body with
// an "A" glyph). Emitted to SPICE as a zero-volt voltage source so the
// solver automatically tracks its branch current, which shows up on
// the plot as I(Vprobe_<ref>).
const IP_SYMBOL = {
    // Pins at ±40 so the symbol sits on the same 20-px grid as the
    // two-terminal passives — drop-in-inline-compatible with R / C / L
    // without forcing the user to re-route the wire.
    width: 80, height: 30,
    pins: [
        { id: 'n1', x: -40, y: 0, side: 'L' },
        { id: 'n2', x:  40, y: 0, side: 'R' },
    ],
    shapes: [
        ...leads(40, 14),
        { kind: 'circle', cx: 0, cy: 0, r: 14, fill: 'none' },
        { kind: 'text', x: 0, y: 1, text: 'A', fontSize: 11, anchor: 'middle', baseline: 'middle', fontWeight: 700 },
    ],
    labelRef: { x: 0, y: -20, anchor: 'middle', baseline: 'baseline' },
    labelVal: { x: 0, y:  24, anchor: 'middle', baseline: 'hanging'  },
};

// Oscilloscope — dual-channel: CH1 `tip` at symbol origin (0,0), CH2
// `tip2` offset to the right so you can clip each probe onto a node.
// UI-only (skipped by emitNetlist, same as VP). After Run, double-click
// opens a CRT modal with one or two superimposed traces (shared Y
// autoscale). CH1 placement matches the old single-tip scope so
// existing demos still snap the primary probe the same way.
const SCOPE_SYMBOL = {
    width: 96,
    height: 80,
    pins: [
        { id: 'tip', x: 0, y: 0, side: 'B' },
        { id: 'tip2', x: 28, y: 0, side: 'B' },
    ],
    shapes: [
        { kind: 'line', x1: 0, y1: 0, x2: 0, y2: -22 },
        { kind: 'line', x1: 28, y1: 0, x2: 28, y2: -22 },
        { kind: 'rect', x: -34, y: -62, w: 68, h: 44, rx: 6, ry: 6, fill: 'var(--sch-body)' },
        { kind: 'rect', x: -26, y: -56, w: 52, h: 24, rx: 2, ry: 2, fill: 'none' },
        // Two trace hints (CH1 green-ish, CH2 amber) — colours match modal.
        {
            kind: 'path',
            d: 'M-22,-50 Q-14,-54 -6,-48',
            fill: 'none',
            stroke: 'rgba(52, 211, 153, 0.85)',
            strokeWidth: 1.4,
        },
        {
            kind: 'path',
            d: 'M-4,-42 Q6,-48 16,-44',
            fill: 'none',
            stroke: 'rgba(251, 191, 36, 0.9)',
            strokeWidth: 1.4,
        },
        { kind: 'line', x1: 0, y1: -56, x2: 0, y2: -32, opacity: 0.45 },
        { kind: 'line', x1: -22, y1: -44, x2: 22, y2: -44, opacity: 0.45 },
        { kind: 'text', x: 0, y: -22, text: 'SCOPE', fontSize: 7, anchor: 'middle', baseline: 'middle', fontWeight: 700 },
        { kind: 'text', x: 0, y: 10, text: '1', fontSize: 6, anchor: 'middle', baseline: 'middle', fontWeight: 700 },
        { kind: 'text', x: 28, y: 10, text: '2', fontSize: 6, anchor: 'middle', baseline: 'middle', fontWeight: 700 },
    ],
    labelRef: { x: 0, y: -68, anchor: 'middle', baseline: 'baseline' },
    labelVal: { x: 14, y: 4, anchor: 'start', baseline: 'hanging' },
};

/** Single-channel scope: one probe tip (CH1 only), narrower CRT body. */
const SCOPE_SINGLE_SYMBOL = {
    width: 56,
    height: 80,
    pins: [
        { id: 'tip', x: 0, y: 0, side: 'B' },
    ],
    shapes: [
        { kind: 'line', x1: 0, y1: 0, x2: 0, y2: -22 },
        { kind: 'rect', x: -26, y: -62, w: 52, h: 44, rx: 6, ry: 6, fill: 'var(--sch-body)' },
        { kind: 'rect', x: -20, y: -56, w: 40, h: 24, rx: 2, ry: 2, fill: 'none' },
        {
            kind: 'path',
            d: 'M-16,-50 Q-6,-54 6,-48',
            fill: 'none',
            stroke: 'rgba(52, 211, 153, 0.85)',
            strokeWidth: 1.4,
        },
        { kind: 'line', x1: 0, y1: -56, x2: 0, y2: -32, opacity: 0.45 },
        { kind: 'line', x1: -18, y1: -44, x2: 18, y2: -44, opacity: 0.45 },
        { kind: 'text', x: 0, y: -22, text: 'SCOPE', fontSize: 7, anchor: 'middle', baseline: 'middle', fontWeight: 700 },
        { kind: 'text', x: 0, y: 10, text: 'CH1', fontSize: 6, anchor: 'middle', baseline: 'middle', fontWeight: 700 },
    ],
    labelRef: { x: 0, y: -68, anchor: 'middle', baseline: 'baseline' },
    labelVal: { x: 0, y: 4, anchor: 'middle', baseline: 'hanging' },
};

// ---------- Linear regulator (3-terminal, ideal Vout) ---------------
//
// Pins: IN (left), GND (tab / common, bottom), OUT (right). The
// netlist emitter turns this into an ideal V(OUT)−V(GND)=Vnom source;
// IN is schematic-only (dropout & quiescent current not modeled).

function regulatorSymbol(bodyLabel) {
    return {
        width: 76,
        height: 68,
        pins: [
            { id: 'n_in', x: -36, y: 0, side: 'L' },
            { id: 'n_gnd', x: 0, y: 32, side: 'B' },
            { id: 'n_out', x: 36, y: 0, side: 'R' },
        ],
        shapes: [
            {
                kind: 'rect', x: -32, y: -22, w: 64, h: 44, rx: 4, ry: 4,
                fill: 'var(--sch-body)', stroke: 'var(--sch-stroke)', strokeWidth: 1.4,
            },
            {
                kind: 'text', x: 0, y: -2, text: bodyLabel, fontSize: 9,
                anchor: 'middle', baseline: 'middle', fontWeight: 700,
            },
            { kind: 'text', x: -36, y: -30, text: 'IN', fontSize: 7, anchor: 'middle', baseline: 'bottom', fontWeight: 600 },
            { kind: 'text', x: 0, y: 38, text: 'GND', fontSize: 7, anchor: 'middle', baseline: 'hanging', fontWeight: 600 },
            { kind: 'text', x: 36, y: -30, text: 'OUT', fontSize: 7, anchor: 'middle', baseline: 'bottom', fontWeight: 600 },
        ],
        labelRef: { x: 0, y: -40, anchor: 'middle', baseline: 'baseline' },
        labelVal: { x: 0, y: 48, anchor: 'middle', baseline: 'hanging' },
    };
}

const REG_POS_SYMBOL = regulatorSymbol('REG+');
const REG_NEG_SYMBOL = regulatorSymbol('REG−');

// ---------- Registry ----------------------------------------------

export const SYMBOLS = {
    R: R_SYMBOL, C: C_SYMBOL, L: L_SYMBOL,
    V: V_SYMBOL, I: I_SYMBOL, D: D_SYMBOL,
    O: O_SYMBOL, E: E_SYMBOL, G: G_SYMBOL,
    Q:     Q_NPN_SYMBOL,    // plain Q defaults to NPN (resolved by pickSymbol below)
    Q_NPN: Q_NPN_SYMBOL, Q_PNP: Q_PNP_SYMBOL,
    M:     M_NMOS_SYMBOL,
    M_NMOS: M_NMOS_SYMBOL, M_PMOS: M_PMOS_SYMBOL,
    VP: VP_SYMBOL, IP: IP_SYMBOL, SCOPE: SCOPE_SYMBOL, SCOPE_SINGLE: SCOPE_SINGLE_SYMBOL,
    REG7805: REG_POS_SYMBOL,
    REG7905: REG_NEG_SYMBOL,
};

/**
 * Symbol geometry for an on-canvas schematic component (handles SCOPE
 * single vs dual channel).
 */
export function symbolForSchematic(comp) {
    if (!comp) return null;
    if (comp.elementType === 'SCOPE' && comp.scopeChannelMode === 'single') {
        return SYMBOLS.SCOPE_SINGLE;
    }
    return SYMBOLS[comp.symbolKey] || SYMBOLS[comp.elementType] || null;
}

/**
 * Resolve the right symbol variant for a given element, consulting the
 * model table to disambiguate Q → NPN/PNP and M → NMOS/PMOS. Always
 * falls back to the plain type key so symbol lookups never crash even
 * if the model reference is missing.
 */
export function pickSymbol(element, models) {
    if (element.type === 'Q') {
        const mdl = models?.[element.model];
        const t = (mdl?.type || 'NPN').toUpperCase();
        return SYMBOLS[`Q_${t === 'PNP' ? 'PNP' : 'NPN'}`] || SYMBOLS.Q;
    }
    if (element.type === 'M') {
        const mdl = models?.[element.model];
        const t = (mdl?.type || 'NMOS').toUpperCase();
        return SYMBOLS[`M_${t === 'PMOS' ? 'PMOS' : 'NMOS'}`] || SYMBOLS.M;
    }
    return SYMBOLS[element.type] || null;
}

/** Returns the pin descriptor inside SYMBOLS[type] matching `pinId`. */
export function symbolPin(type, pinId) {
    const sym = SYMBOLS[type];
    if (!sym) return null;
    return sym.pins.find((p) => p.id === pinId) || null;
}

/**
 * Rotate a 2-D point `{x,y}` by `rot` degrees (must be 0/90/180/270)
 * around the origin. Used by the layout engine to project pins from
 * local symbol coords into world coords.
 */
export function rotateXY(x, y, rot) {
    switch (((rot % 360) + 360) % 360) {
        case 90:  return { x: -y, y:  x };
        case 180: return { x: -x, y: -y };
        case 270: return { x:  y, y: -x };
        default:  return { x,     y     };
    }
}

/** Rotate a pin `side` by `rot` degrees. */
export function rotateSide(side, rot) {
    const order = ['R', 'B', 'L', 'T'];
    const idx = order.indexOf(side);
    if (idx < 0) return side;
    const steps = Math.round((((rot % 360) + 360) % 360) / 90);
    return order[(idx + steps) % 4];
}
