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
        { kind: 'polarity', sign: '+', x:  8, y: -6 },
        { kind: 'polarity', sign: '−', x: -8, y: -6 },
    ],
});

// ---------- Current source (circle + arrow) ----------------------

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
        ],
        labelRef: { x: 0, y: -32, anchor: 'middle', baseline: 'baseline' },
        labelVal: { x: 0, y:  36, anchor: 'middle', baseline: 'hanging'  },
    };
}

const E_SYMBOL = dependentSource('E');
const G_SYMBOL = dependentSource('G');

// ---------- Registry ----------------------------------------------

export const SYMBOLS = {
    R: R_SYMBOL, C: C_SYMBOL, L: L_SYMBOL,
    V: V_SYMBOL, I: I_SYMBOL, D: D_SYMBOL,
    O: O_SYMBOL, E: E_SYMBOL, G: G_SYMBOL,
};

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
