/**
 * Component library catalog for Circuit Studio's interactive editor.
 *
 * Each entry describes one user-placeable part: how it's named in the
 * palette, which solver element (R/C/L/V/I/D/Q/M/O/E/G) it maps to,
 * the default value / source-spec / model to seed, and a few hints
 * used by the property editor.
 *
 * Why a separate catalog (not just SYMBOLS):
 *   - SYMBOLS holds *graphics* (shapes, pin positions); the library
 *     adds product-level metadata: human-readable names, categories,
 *     tooltip blurbs, unit suggestions, and editor capabilities.
 *   - Multiple library parts can map to the same solver element — e.g.
 *     "Zener diode" and "Signal diode" both emit `D`, just with
 *     different default models. Keeps the palette rich while reusing
 *     the solver plumbing.
 *
 * Schema:
 *   {
 *     id:           unique palette ID (string)
 *     name:         palette display label ("Resistor", "NPN BJT", …)
 *     short:        2-3 char badge shown on palette tile ("R", "Q")
 *     category:     'Passive' | 'Source' | 'Semiconductor' | 'Analog IC' | 'Power' | 'Probe'
 *     description:  hover tooltip, one short sentence
 *     elementType:  solver element letter (R, C, L, V, I, D, Q, M, O, E, G, REG)
 *     symbolKey:    key in SYMBOLS used for rendering
 *     refPrefix:    reference designator prefix ('R', 'C', 'Q', …)
 *     defaultValue: starting value (number, in SI base units — 1e3 = 1k)
 *                   passives only; active devices use sourceSpec/model
 *     valueUnit:    base unit used by the inspector ('Ω', 'F', 'H', 'V', 'A')
 *     sourceSpec?:  for V / I — initial source list (dc/sin/pulse/…)
 *     modelRef?:    reference to a built-in .model string the part
 *                   emits when it's used (added to the netlist once)
 *     inlineModel?: full `.model` text this part contributes if used
 *     extraPins?:   map of pinId → pinId overrides for Opamp/E/G that
 *                   have non-standard terminal naming
 *   }
 */

// Inline model library — canonical SPICE models shipped out of the
// box. Anything a user drops onto the canvas that references one of
// these names will auto-add the corresponding .model line to the
// emitted netlist (emitNetlist.js handles deduplication).
export const BUILTIN_MODELS = {
    DSIG:    '.model DSIG D(Is=1e-14 N=1.2)',
    DZ5V1:   '.model DZ5V1 D(Is=1e-14 N=1.2 BV=5.1 IBV=1m)',
    DLED:    '.model DLED D(Is=1e-20 N=2.5)',
    DSCHOTT: '.model DSCHOTT D(Is=1e-8 N=1.05)',

    QN2222:  '.model QN2222 NPN(Is=1e-15 Bf=200 Vaf=75 Cje=25p Cjc=8p)',
    Q2N3906: '.model Q2N3906 PNP(Is=1e-15 Bf=180 Vaf=60 Cje=20p Cjc=6p)',

    MN_DEF:  '.model MN_DEF NMOS(Vto=0.7 Kp=120u Lambda=0.02 Cgso=1p Cgdo=1p)',
    MP_DEF:  '.model MP_DEF PMOS(Vto=-0.7 Kp=50u  Lambda=0.02 Cgso=1p Cgdo=1p)',
};

export const CATEGORIES = [
    { id: 'Passive',       name: 'Passive components' },
    { id: 'Source',        name: 'Sources'            },
    { id: 'Semiconductor', name: 'Semiconductors'     },
    { id: 'Analog IC',     name: 'Analog ICs'         },
    { id: 'Power',         name: 'Power & ground'     },
    { id: 'Probe',         name: 'Probes & labels'    },
];

/** @type {object[]} Session-only parts merged into {@link getPart} (from SPICE library rows). */
let USER_SESSION_LIBRARY = [];

/** Replace session library extensions (called from CircuitStudio when `spiceLibs` changes). */
export function setUserLibrarySessionParts(parts) {
    USER_SESSION_LIBRARY = Array.isArray(parts) ? parts : [];
}

export function getUserLibrarySessionParts() {
    return USER_SESSION_LIBRARY;
}

/**
 * If a downloaded palette part defines this SPICE model name, return its
 * `{ name, type, params }` for merging into `doc.userModels`.
 * @param {string} modelName
 * @returns {{ name: string, type: string, params: Record<string, number> }|null}
 */
export function getContributedUserModelForName(modelName) {
    if (!modelName) return null;
    const key = String(modelName).toLowerCase();
    const part = USER_SESSION_LIBRARY.find(
        (p) => p.modelRef && String(p.modelRef).toLowerCase() === key,
    );
    return part?.contributesUserModel || null;
}

/** Built-in + doc `userModels` names suitable for the model &lt;select&gt;. */
export function modelChoicesForElement(elementType, userModels = []) {
    const all = Object.keys(BUILTIN_MODELS);
    let builtins;
    switch (elementType) {
        case 'D':
            builtins = all.filter((k) => /^D/i.test(k) && !/^Q/i.test(k));
            break;
        case 'Q':
            builtins = all.filter((k) => /^Q/i.test(k));
            break;
        case 'M':
            builtins = all.filter((k) => /^M/i.test(k));
            break;
        default:
            builtins = all;
    }
    const out = [...builtins];
    const want = (t) => {
        const u = String(t || '').toUpperCase();
        if (elementType === 'Q') return u === 'NPN' || u === 'PNP';
        if (elementType === 'D') return u === 'D';
        if (elementType === 'M') return u === 'NMOS' || u === 'PMOS';
        return false;
    };
    for (const m of userModels || []) {
        const n = m?.name;
        if (!n || !want(m?.type)) continue;
        if (!out.some((x) => String(x).toLowerCase() === String(n).toLowerCase())) out.push(n);
    }
    return out;
}

export const LIBRARY = [
    // ---------- Passives ----------
    {
        id: 'R',
        name: 'Resistor',
        short: 'R',
        category: 'Passive',
        description: 'Ideal linear resistor — 1/V·I relationship, no frequency roll-off.',
        elementType: 'R',
        symbolKey: 'R',
        refPrefix: 'R',
        defaultValue: 1e3,
        valueUnit: 'Ω',
    },
    {
        id: 'R_photo',
        name: 'Photoresistor',
        short: 'Rₚ',
        category: 'Passive',
        description: 'Light-dependent resistor (LDR) — model as a plain R whose value is user-parameterised.',
        elementType: 'R',
        symbolKey: 'R',
        refPrefix: 'R',
        defaultValue: 10e3,
        valueUnit: 'Ω',
    },
    {
        id: 'C',
        name: 'Capacitor',
        short: 'C',
        category: 'Passive',
        description: 'Ideal capacitor. In transient it stores charge; in AC it has impedance 1/(jωC).',
        elementType: 'C',
        symbolKey: 'C',
        refPrefix: 'C',
        defaultValue: 100e-9,
        valueUnit: 'F',
    },
    {
        id: 'C_electro',
        name: 'Electrolytic cap',
        short: 'C⁺',
        category: 'Passive',
        description: 'Polarised bulk capacitor — same solver model, bigger typical value.',
        elementType: 'C',
        symbolKey: 'C',
        refPrefix: 'C',
        defaultValue: 10e-6,
        valueUnit: 'F',
    },
    {
        id: 'L',
        name: 'Inductor',
        short: 'L',
        category: 'Passive',
        description: 'Ideal inductor. Impedance jωL in AC, integrates voltage → current in transient.',
        elementType: 'L',
        symbolKey: 'L',
        refPrefix: 'L',
        defaultValue: 1e-3,
        valueUnit: 'H',
    },

    // ---------- Sources ----------
    {
        id: 'V_dc',
        name: 'DC voltage',
        short: 'V',
        category: 'Source',
        description: 'Independent DC voltage source — constant V regardless of current.',
        elementType: 'V',
        symbolKey: 'V',
        refPrefix: 'V',
        // AC 1 0: harmless for DC/tran; gives a default small-signal input
        // for .ac sweeps without opening the source editor.
        sourceSpec: [{ kind: 'dc', v: 5 }, { kind: 'ac', mag: 1, phase: 0 }],
    },
    {
        id: 'V_ac',
        name: 'AC source',
        short: 'V~',
        category: 'Source',
        description: 'Small-signal AC stimulus for .ac analysis (phase in degrees).',
        elementType: 'V',
        symbolKey: 'V',
        refPrefix: 'V',
        sourceSpec: [{ kind: 'dc', v: 0 }, { kind: 'ac', mag: 1, phase: 0 }],
    },
    {
        id: 'V_sin',
        name: 'Sine source',
        short: 'V∿',
        category: 'Source',
        description: 'Time-domain sinusoid: SIN(Vo Va f td θ). For transient stimulus.',
        elementType: 'V',
        symbolKey: 'V',
        refPrefix: 'V',
        sourceSpec: [
            { kind: 'sin', vo: 0, va: 1, f: 1e3, td: 0, theta: 0 },
            { kind: 'ac', mag: 1, phase: 0 },
        ],
    },
    {
        id: 'V_pulse',
        name: 'Pulse source',
        short: 'V⊓',
        category: 'Source',
        description: 'PULSE(V1 V2 td tr tf pw per) — digital-style square wave or single pulse.',
        elementType: 'V',
        symbolKey: 'V',
        refPrefix: 'V',
        sourceSpec: [
            { kind: 'pulse', v1: 0, v2: 5, td: 0, tr: 1e-6, tf: 1e-6, pw: 1e-3, per: 2e-3 },
            { kind: 'ac', mag: 1, phase: 0 },
        ],
    },
    {
        id: 'I_dc',
        name: 'Current source',
        short: 'I',
        category: 'Source',
        description: 'Independent DC current source — forces I regardless of voltage.',
        elementType: 'I',
        symbolKey: 'I',
        refPrefix: 'I',
        sourceSpec: [{ kind: 'dc', v: 1e-3 }],
    },

    // ---------- Semiconductors ----------
    {
        id: 'D_sig',
        name: 'Signal diode',
        short: 'D',
        category: 'Semiconductor',
        description: 'Generic silicon small-signal diode (1N914-like). Shockley model with N=1.2.',
        elementType: 'D',
        symbolKey: 'D',
        refPrefix: 'D',
        modelRef: 'DSIG',
    },
    {
        id: 'D_zener',
        name: 'Zener (5.1 V)',
        short: 'DZ',
        category: 'Semiconductor',
        description: '5.1 V Zener diode — use as a voltage clamp / reference.',
        elementType: 'D',
        symbolKey: 'D',
        refPrefix: 'D',
        modelRef: 'DZ5V1',
    },
    {
        id: 'D_led',
        name: 'LED',
        short: 'LED',
        category: 'Semiconductor',
        description: 'Light-emitting diode — high-N diode model (≈1.8 V forward drop in red LED bias).',
        elementType: 'D',
        symbolKey: 'D',
        refPrefix: 'D',
        modelRef: 'DLED',
    },
    {
        id: 'D_schottky',
        name: 'Schottky diode',
        short: 'DS',
        category: 'Semiconductor',
        description: 'Low-Vf Schottky rectifier (≈0.3 V forward).',
        elementType: 'D',
        symbolKey: 'D',
        refPrefix: 'D',
        modelRef: 'DSCHOTT',
    },
    {
        id: 'Q_npn',
        name: 'NPN BJT',
        short: 'QN',
        category: 'Semiconductor',
        description: 'NPN bipolar transistor (2N2222-ish). Ebers-Moll + Early effect in the solver.',
        elementType: 'Q',
        symbolKey: 'Q_NPN',
        refPrefix: 'Q',
        modelRef: 'QN2222',
    },
    {
        id: 'Q_pnp',
        name: 'PNP BJT',
        short: 'QP',
        category: 'Semiconductor',
        description: 'PNP bipolar transistor (2N3906-ish).',
        elementType: 'Q',
        symbolKey: 'Q_PNP',
        refPrefix: 'Q',
        modelRef: 'Q2N3906',
    },
    {
        id: 'M_nmos',
        name: 'NMOS',
        short: 'MN',
        category: 'Semiconductor',
        description: 'N-channel MOSFET (Shichman-Hodges Level-1, Vto=0.7 V).',
        elementType: 'M',
        symbolKey: 'M_NMOS',
        refPrefix: 'M',
        modelRef: 'MN_DEF',
    },
    {
        id: 'M_pmos',
        name: 'PMOS',
        short: 'MP',
        category: 'Semiconductor',
        description: 'P-channel MOSFET (Vto=-0.7 V).',
        elementType: 'M',
        symbolKey: 'M_PMOS',
        refPrefix: 'M',
        modelRef: 'MP_DEF',
    },

    // ---------- Analog ICs ----------
    {
        id: 'O_opamp',
        name: 'Op-amp',
        short: 'OP',
        category: 'Analog IC',
        description: 'Ideal op-amp (infinite gain, virtual short). Solver enforces V(in+)=V(in−).',
        elementType: 'O',
        symbolKey: 'O',
        refPrefix: 'O',
    },
    {
        id: 'E_vcvs',
        name: 'VCVS (E)',
        short: 'E',
        category: 'Analog IC',
        description: 'Voltage-controlled voltage source: V(out+,out−) = gain · V(ctl+,ctl−).',
        elementType: 'E',
        symbolKey: 'E',
        refPrefix: 'E',
        defaultValue: 10,
        valueUnit: 'V/V',
    },
    {
        id: 'G_vccs',
        name: 'VCCS (G)',
        short: 'G',
        category: 'Analog IC',
        description: 'Voltage-controlled current source: I = gm · V(ctl+,ctl−).',
        elementType: 'G',
        symbolKey: 'G',
        refPrefix: 'G',
        defaultValue: 1e-3,
        valueUnit: 'A/V',
    },

    // ---------- Probes ----------
    {
        id: 'VP',
        name: 'Voltage probe',
        short: 'V?',
        category: 'Probe',
        description: 'Single-pin probe. Snap onto any wire or pin to auto-plot its node voltage after Run.',
        elementType: 'VP',
        symbolKey: 'VP',
        refPrefix: 'VP',
    },
    {
        id: 'IP',
        name: 'Current probe',
        short: 'I?',
        category: 'Probe',
        description: 'Inline ammeter. Splice into a wire and Run to plot the branch current through it.',
        elementType: 'IP',
        symbolKey: 'IP',
        refPrefix: 'IP',
    },
    {
        id: 'SCOPE',
        name: 'Oscilloscope',
        short: 'OSC',
        category: 'Probe',
        description: 'Scope: CH1 (left tip) and optional CH2 (right tip). Set single vs dual channel in properties; double-click after Run for the CRT viewer.',
        elementType: 'SCOPE',
        symbolKey: 'SCOPE',
        refPrefix: 'X',
        /** Initial value for `scopeChannelMode` on the placed component. */
        scopeChannelMode: 'dual',
    },

    // ---------- Power & ground ----------
    {
        id: 'GND',
        name: 'Ground',
        short: 'GND',
        category: 'Power',
        description: 'Reference node (node 0). Every circuit needs one.',
        elementType: 'GND',
        symbolKey: 'GND',
        refPrefix: '0',
    },
    {
        id: 'VCC',
        name: 'VCC rail',
        short: 'VCC',
        category: 'Power',
        description: 'Convenience label for a +5 V / +12 V / etc rail — expands to a DC voltage source to ground.',
        elementType: 'V',
        symbolKey: 'V',
        refPrefix: 'V',
        sourceSpec: [{ kind: 'dc', v: 5 }],
        autoGround: true, // emit-netlist injects GND as n2
    },

    // ---------- Linear regulators (ideal fixed Vout) -----------------
    // Emitted as V(OUT)−V(GND)=nominal; IN pin is schematic-only (no dropout / IQ).
    {
        id: 'reg_7805',
        name: 'LM7805 (+5 V)',
        short: '7805',
        category: 'Power',
        description: 'Positive fixed 5 V (78xx class). Ideal V(OUT)−V(GND)=5 V. IN pin is not in the netlist — wire it to your raw supply for documentation; dropout is not modeled.',
        elementType: 'REG',
        symbolKey: 'REG7805',
        refPrefix: 'U',
        defaultValue: 5,
        valueUnit: 'V',
    },
    {
        id: 'reg_7809',
        name: 'LM7809 (+9 V)',
        short: '7809',
        category: 'Power',
        description: 'Positive fixed 9 V (78xx). Ideal output vs GND pin; IN pin schematic-only.',
        elementType: 'REG',
        symbolKey: 'REG7805',
        refPrefix: 'U',
        defaultValue: 9,
        valueUnit: 'V',
    },
    {
        id: 'reg_7812',
        name: 'LM7812 (+12 V)',
        short: '7812',
        category: 'Power',
        description: 'Positive fixed 12 V (78xx). Ideal output vs GND pin; IN pin schematic-only.',
        elementType: 'REG',
        symbolKey: 'REG7805',
        refPrefix: 'U',
        defaultValue: 12,
        valueUnit: 'V',
    },
    {
        id: 'reg_7815',
        name: 'LM7815 (+15 V)',
        short: '7815',
        category: 'Power',
        description: 'Positive fixed 15 V (78xx). Ideal output vs GND pin; IN pin schematic-only.',
        elementType: 'REG',
        symbolKey: 'REG7805',
        refPrefix: 'U',
        defaultValue: 15,
        valueUnit: 'V',
    },
    {
        id: 'reg_7824',
        name: 'LM7824 (+24 V)',
        short: '7824',
        category: 'Power',
        description: 'Positive fixed 24 V (78xx). Ideal output vs GND pin; IN pin schematic-only.',
        elementType: 'REG',
        symbolKey: 'REG7805',
        refPrefix: 'U',
        defaultValue: 24,
        valueUnit: 'V',
    },
    {
        id: 'reg_7905',
        name: 'LM7905 (−5 V)',
        short: '7905',
        category: 'Power',
        description: 'Negative fixed −5 V (79xx). Ideal V(OUT)−V(GND)=−5 V. IN pin schematic-only.',
        elementType: 'REG',
        symbolKey: 'REG7905',
        refPrefix: 'U',
        defaultValue: -5,
        valueUnit: 'V',
    },
    {
        id: 'reg_7912',
        name: 'LM7912 (−12 V)',
        short: '7912',
        category: 'Power',
        description: 'Negative fixed −12 V (79xx). Ideal V(OUT)−V(GND)=−12 V. IN pin schematic-only.',
        elementType: 'REG',
        symbolKey: 'REG7905',
        refPrefix: 'U',
        defaultValue: -12,
        valueUnit: 'V',
    },
    {
        id: 'reg_1117_33',
        name: 'AMS1117-3.3 (+3.3 V)',
        short: '3V3',
        category: 'Power',
        description: 'Common LDO, +3.3 V fixed. Ideal V(OUT)−V(GND)=3.3 V; IN pin schematic-only.',
        elementType: 'REG',
        symbolKey: 'REG7805',
        refPrefix: 'U',
        defaultValue: 3.3,
        valueUnit: 'V',
    },
    {
        id: 'reg_1117_50',
        name: 'AMS1117-5.0 (+5 V)',
        short: '1117',
        category: 'Power',
        description: 'Common LDO, +5 V fixed. Ideal V(OUT)−V(GND)=5 V; IN pin schematic-only.',
        elementType: 'REG',
        symbolKey: 'REG7805',
        refPrefix: 'U',
        defaultValue: 5,
        valueUnit: 'V',
    },
    {
        id: 'reg_1117_18',
        name: 'AMS1117-1.8 (+1.8 V)',
        short: '1V8',
        category: 'Power',
        description: 'Common LDO, +1.8 V fixed. Ideal V(OUT)−V(GND)=1.8 V; IN pin schematic-only.',
        elementType: 'REG',
        symbolKey: 'REG7805',
        refPrefix: 'U',
        defaultValue: 1.8,
        valueUnit: 'V',
    },
];

/** Look up a library entry by id. Returns null if not found. */
export function getPart(id) {
    return USER_SESSION_LIBRARY.find((p) => p.id === id) || LIBRARY.find((p) => p.id === id) || null;
}

/** Library entries grouped by category, in the order declared above. */
export function libraryByCategory() {
    const buckets = new Map();
    for (const c of CATEGORIES) buckets.set(c.id, []);
    for (const p of LIBRARY) {
        if (!buckets.has(p.category)) buckets.set(p.category, []);
        buckets.get(p.category).push(p);
    }
    return CATEGORIES.map((c) => ({
        ...c,
        items: buckets.get(c.id) || [],
    }));
}

/** Simple substring search across name / short / description. */
export function searchLibrary(q) {
    if (!q) return LIBRARY;
    const needle = String(q).toLowerCase();
    return LIBRARY.filter((p) =>
        p.name.toLowerCase().includes(needle)
        || p.short.toLowerCase().includes(needle)
        || p.description.toLowerCase().includes(needle)
        || p.elementType.toLowerCase() === needle
    );
}

/**
 * Search static {@link LIBRARY} plus extra parts (e.g. downloaded models).
 * Matches part number, SPICE model name, name, short, description, element type.
 */
export function searchAllLibraryParts(q, extraParts = []) {
    const needle = String(q || '').trim().toLowerCase();
    const merged = [...LIBRARY, ...(extraParts || [])];
    if (!needle) return merged;
    return merged.filter((p) => {
        const pn = String(p.partNumber || '').toLowerCase();
        const mn = String(p.spiceModelName || p.modelRef || '').toLowerCase();
        return p.name.toLowerCase().includes(needle)
            || p.short.toLowerCase().includes(needle)
            || (p.description && p.description.toLowerCase().includes(needle))
            || p.elementType.toLowerCase() === needle
            || (pn && pn.includes(needle))
            || (mn && mn.includes(needle));
    });
}
