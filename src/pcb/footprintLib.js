/**
 * Built-in SMD / through-hole footprints (mm, origin at package centre).
 * Used by PCB Studio placement + Gerber flash generation.
 */

/** @typedef {{ id: string, x: number, y: number, w: number, h: number, num: string }} FpPad */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   family: string,
 *   pads: FpPad[],
 *   silk: Array<{ kind: 'line', x1: number, y1: number, x2: number, y2: number }>,
 * }} FootprintDef
 */

/** @type {FootprintDef[]} */
export const FOOTPRINTS = [
    {
        id: 'R_0805',
        name: 'Resistor 0805',
        family: 'R',
        pads: [
            { id: '1', num: '1', x: -0.5, y: 0, w: 0.55, h: 1.2 },
            { id: '2', num: '2', x: 0.5, y: 0, w: 0.55, h: 1.2 },
        ],
        silk: [
            { kind: 'line', x1: -0.9, y1: -0.65, x2: 0.9, y2: -0.65 },
            { kind: 'line', x1: -0.9, y1: 0.65, x2: 0.9, y2: 0.65 },
        ],
    },
    {
        id: 'C_0805',
        name: 'Capacitor 0805',
        family: 'C',
        pads: [
            { id: '1', num: '1', x: -0.5, y: 0, w: 0.55, h: 1.2 },
            { id: '2', num: '2', x: 0.5, y: 0, w: 0.55, h: 1.2 },
        ],
        silk: [{ kind: 'line', x1: -0.85, y1: -0.6, x2: 0.85, y2: -0.6 }],
    },
    {
        id: 'L_1210',
        name: 'Inductor 1210',
        family: 'L',
        pads: [
            { id: '1', num: '1', x: -0.75, y: 0, w: 0.7, h: 1.35 },
            { id: '2', num: '2', x: 0.75, y: 0, w: 0.7, h: 1.35 },
        ],
        silk: [],
    },
    {
        id: 'SOD323',
        name: 'Diode SOD-323',
        family: 'D',
        pads: [
            { id: 'A', num: '1', x: -0.55, y: 0, w: 0.45, h: 0.7 },
            { id: 'K', num: '2', x: 0.55, y: 0, w: 0.45, h: 0.7 },
        ],
        silk: [{ kind: 'line', x1: 0.2, y1: -0.45, x2: 0.2, y2: 0.45 }],
    },
    {
        id: 'SOT23_3',
        name: 'SOT-23 (3-pad)',
        family: 'Q',
        pads: [
            { id: '1', num: '1', x: -0.48, y: -0.65, w: 0.55, h: 0.7 },
            { id: '2', num: '2', x: 0.48, y: -0.65, w: 0.55, h: 0.7 },
            { id: '3', num: '3', x: 0, y: 0.65, w: 0.55, h: 0.7 },
        ],
        silk: [{ kind: 'line', x1: -0.7, y1: -1.1, x2: 0.7, y2: -1.1 }],
    },
    {
        id: 'TO220_3',
        name: 'TO-220 (3-lead)',
        family: 'REG',
        pads: [
            { id: 'in', num: '1', x: -2.54, y: 2.3, w: 1.2, h: 1.4 },
            { id: 'gnd', num: '2', x: 0, y: 2.3, w: 1.2, h: 1.4 },
            { id: 'out', num: '3', x: 2.54, y: 2.3, w: 1.2, h: 1.4 },
        ],
        silk: [
            { kind: 'line', x1: -5, y1: -6, x2: 5, y2: -6 },
            { kind: 'line', x1: -5, y1: -6, x2: -5, y2: 8 },
            { kind: 'line', x1: 5, y1: -6, x2: 5, y2: 8 },
        ],
    },
    {
        id: 'PIN2_HDR',
        name: '2-pin 2.54 header',
        family: 'V',
        pads: [
            { id: '1', num: '1', x: -1.27, y: 0, w: 1.4, h: 1.4 },
            { id: '2', num: '2', x: 1.27, y: 0, w: 1.4, h: 1.4 },
        ],
        silk: [],
    },
    {
        id: 'CHIP_4SQ',
        name: '4-pad chip (E/G / quad)',
        family: 'IC',
        pads: [
            { id: '1', num: '1', x: -1.4, y: -1.4, w: 0.9, h: 0.9 },
            { id: '2', num: '2', x: 1.4, y: -1.4, w: 0.9, h: 0.9 },
            { id: '3', num: '3', x: 1.4, y: 1.4, w: 0.9, h: 0.9 },
            { id: '4', num: '4', x: -1.4, y: 1.4, w: 0.9, h: 0.9 },
        ],
        silk: [],
    },
    {
        id: 'DIP8',
        name: 'DIP-8 / SO8 body',
        family: 'IC',
        pads: [
            { id: '1', num: '1', x: -3.81, y: -2.54, w: 1.6, h: 1.2 },
            { id: '2', num: '2', x: -1.27, y: -2.54, w: 1.6, h: 1.2 },
            { id: '3', num: '3', x: 1.27, y: -2.54, w: 1.6, h: 1.2 },
            { id: '4', num: '4', x: 3.81, y: -2.54, w: 1.6, h: 1.2 },
            { id: '5', num: '5', x: 3.81, y: 2.54, w: 1.6, h: 1.2 },
            { id: '6', num: '6', x: 1.27, y: 2.54, w: 1.6, h: 1.2 },
            { id: '7', num: '7', x: -1.27, y: 2.54, w: 1.6, h: 1.2 },
            { id: '8', num: '8', x: -3.81, y: 2.54, w: 1.6, h: 1.2 },
        ],
        silk: [{ kind: 'line', x1: -4.5, y1: -3.5, x2: 4.5, y2: -3.5 }],
    },
];

const BY_ID = Object.fromEntries(FOOTPRINTS.map((f) => [f.id, f]));

export function getFootprint(id) {
    return BY_ID[id] || null;
}

export function listFootprintSummaries() {
    return FOOTPRINTS.map((f) => ({ id: f.id, name: f.name, family: f.family }));
}

export function addFootprint(footprintDef) {
    if (!BY_ID[footprintDef.id]) {
        FOOTPRINTS.push(footprintDef);
        BY_ID[footprintDef.id] = footprintDef;
    }
}
