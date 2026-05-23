/**
 * SPICE-style netlist parser for Circuit Studio.
 *
 * The grammar is intentionally a strict subset of ngspice / LTspice so
 * a user can copy a textbook netlist or a Berkeley-style example into
 * the editor and have it work without edits.
 *
 * Supported elements (first letter, case-insensitive):
 *   R  resistor                 R<name> n+ n- value
 *   C  capacitor                C<name> n+ n- value [IC=v0]
 *   L  inductor                 L<name> n+ n- value [IC=i0]
 *   V  voltage source           V<name> n+ n- [DC] v | AC mag [phase] | SIN(...) | PULSE(...) | PWL(...)
 *   I  current source           same source-function grammar as V
 *   D  diode                    D<name> anode cathode MODEL     (supports Shockley + Zener BV)
 *   Q  BJT                      Q<name> collector base emitter [substrate] MODEL       (NPN / PNP)
 *   M  MOSFET                   M<name> drain gate source [bulk] MODEL [W=.. L=..]     (NMOS / PMOS)
 *   E  VCVS                     E<name> n+ n- c+ c- gain
 *   G  VCCS                     G<name> n+ n- c+ c- gm
 *   O  ideal op-amp             O<name> in+ in- out        (virtual-short constraint, infinite gain)
 *
 *   .model NAME  D(Is=... N=... Bv=... Ibv=... Cj0=...)
 *   .model NAME  NPN(Is=... Bf=... Br=... Vaf=... Var=... Nf=... Nr=... Re=... Rc=... Rb=... Cje=... Cjc=...)
 *   .model NAME  PNP(...)     — same parameters, opposite polarity
 *   .model NAME  NMOS(Vto=... Kp=... Lambda=... Gamma=... Phi=... Cgso=... Cgdo=...)
 *   .model NAME  PMOS(...)    — same parameters, opposite polarity
 *
 * Supported directives:
 *   .op
 *   .dc    <src> <start> <stop> <step>
 *   .ac    {DEC|OCT|LIN} <N> <f_start> <f_stop>
 *   .tran  <tstep> <tstop> [tstart] [UIC]
 *   .tf    <OUTVAR> <SRC>   — DC small-signal transfer (OUTVAR = V(n) | V(n1,n2) | I(Vname); SRC = V source)
 *   .step  <elementName> <start> <stop> <step>             — parameter sweep for design exploration
 *   .include "file" / .lib "file" [section]                — merged from caller `includeFiles` map
 *   .subckt NAME n1 n2 … / .ends  plus  Xref … SUBNAME      — subcircuits flattened to primitives (v1)
 *   .end
 *
 * Comments: lines starting with '*' and anything after ';' on a line.
 *
 * Unit suffixes: T, G, MEG, K, M, U, N, P, F (case-insensitive),
 *                plus 'mil' and 'Hz'/'s' which are stripped.
 *
 * Optional second argument to {@link parseNetlist}:
 *   `{ includeFiles: { 'path.lib': text, ... } }` — resolves `.include`
 *   before parsing. See {@link expandSpiceForParse} in spiceExpand.js.
 */

import { preprocess, tokenize } from './spiceLineUtils.js';
import { expandSpiceForParse } from './spiceExpand.js';

const UNIT_MULT = {
    t: 1e12, g: 1e9, meg: 1e6, k: 1e3,
    m: 1e-3, u: 1e-6, µ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
};

/** Parse a SPICE numeric literal like "10k", "1.5meg", "2.2n", "5e-3". */
export function parseSpiceValue(tok) {
    if (tok == null) return NaN;
    const s = String(tok).trim().toLowerCase();
    if (s.length === 0) return NaN;
    // Strip trailing unit tail ("hz", "s", "ohm", "v", "a", "f", "h", "db")
    // but ONLY when it's a multi-letter alpha tail, to avoid eating the SI
    // prefix single letters (k/m/u/n/p/…). Matching is greedy longest-first.
    const m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-zµ]*)$/i);
    if (!m) return NaN;
    const num = parseFloat(m[1]);
    const suf = m[2] || '';
    if (!suf) return num;
    // Try longest suffixes first so "meg" wins over "m" and "mil" over "m".
    if (suf === 'mil') return num * 25.4e-6;
    if (suf.startsWith('meg')) return num * 1e6;
    const first = suf[0];
    const mult = UNIT_MULT[first];
    if (mult != null) return num * mult;
    // Unknown trailing unit (e.g. "V", "Hz") → ignore the suffix.
    return num;
}

/**
 * Parse a source function argument — returns an object the solver can
 * evaluate. Shapes:
 *   {kind: 'dc', v}
 *   {kind: 'sin', vo, va, f, td, theta}
 *   {kind: 'pulse', v1, v2, td, tr, tf, pw, per}
 *   {kind: 'pwl', points: [[t0,v0], [t1,v1], ...]}
 *   {kind: 'ac', mag, phase}
 */
function parseSourceSpec(tokens, startIdx) {
    // Remaining tokens after node list; can be any of:
    //   DC <v>                     -> dc
    //   <v>                        -> dc (SPICE shorthand)
    //   AC <mag> [phase]           -> ac
    //   SIN(vo va f [td [theta]])  -> sin
    //   PULSE(v1 v2 [td [tr [tf [pw [per]]]]]) -> pulse
    //   PWL(t0 v0 t1 v1 ...)       -> pwl
    /* Token-consuming scanner. Each pass inspects the head of `rest`
       and removes as many tokens as the clause uses, so interleaved
       forms like "AC 1 PULSE(...)" or "DC 5 SIN(...)" are handled
       without accidentally feeding PULSE into AC's phase slot. */
    const rest = tokens.slice(startIdx);
    let funcToken = null;
    let dcToken = null;
    let acTokens = null;

    const isFunc = (t) => /^(SIN|PULSE|PWL|EXP|SFFM)\(/i.test(t || '');
    const looksNumeric = (t) => {
        if (t == null) return false;
        if (isFunc(t)) return false;
        if (/^(AC|DC)$/i.test(t)) return false;
        return Number.isFinite(parseSpiceValue(t));
    };

    let i = 0;
    while (i < rest.length) {
        const t = rest[i];
        const tu = (t || '').toUpperCase();
        if (isFunc(t)) { funcToken = t; i++; continue; }
        if (tu === 'DC') {
            if (looksNumeric(rest[i + 1])) { dcToken = rest[i + 1]; i += 2; } else { i++; }
            continue;
        }
        if (tu === 'AC') {
            const hasMag = looksNumeric(rest[i + 1]);
            const hasPhase = hasMag && looksNumeric(rest[i + 2]);
            acTokens = {
                mag: hasMag ? parseSpiceValue(rest[i + 1]) : 1,
                phase: hasPhase ? parseSpiceValue(rest[i + 2]) : 0,
            };
            i += 1 + (hasMag ? 1 : 0) + (hasPhase ? 1 : 0);
            continue;
        }
        // Bare leading number without an explicit "DC" prefix.
        if (dcToken == null && funcToken == null && looksNumeric(t)) {
            dcToken = t;
        }
        i++;
    }
    const specs = [];
    if (dcToken != null) {
        specs.push({ kind: 'dc', v: parseSpiceValue(dcToken) });
    }
    if (acTokens) {
        specs.push({ kind: 'ac', mag: acTokens.mag, phase: acTokens.phase });
    }
    if (funcToken) {
        const m = funcToken.match(/^(\w+)\((.*)\)$/);
        if (m) {
            const name = m[1].toUpperCase();
            const args = m[2].trim().split(/[\s,]+/).map(parseSpiceValue);
            if (name === 'SIN') {
                specs.push({
                    kind: 'sin',
                    vo: args[0] || 0,
                    va: args[1] || 0,
                    f: args[2] || 0,
                    td: args[3] || 0,
                    theta: args[4] || 0,
                });
            } else if (name === 'PULSE') {
                specs.push({
                    kind: 'pulse',
                    v1: args[0] || 0,
                    v2: args[1] || 0,
                    td: args[2] || 0,
                    tr: Math.max(args[3] || 0, 1e-15),
                    tf: Math.max(args[4] || 0, 1e-15),
                    pw: args[5] || 0,
                    per: args[6] || Number.POSITIVE_INFINITY,
                });
            } else if (name === 'PWL') {
                const pts = [];
                for (let i = 0; i + 1 < args.length; i += 2) pts.push([args[i], args[i + 1]]);
                specs.push({ kind: 'pwl', points: pts });
            } else if (name === 'EXP') {
                specs.push({
                    kind: 'exp',
                    v1: args[0] || 0, v2: args[1] || 0,
                    td1: args[2] || 0, tau1: Math.max(args[3] || 1e-9, 1e-15),
                    td2: args[4] || 0, tau2: Math.max(args[5] || 1e-9, 1e-15),
                });
            }
        }
    }
    if (specs.length === 0) specs.push({ kind: 'dc', v: 0 });
    return specs;
}

/**
 * Parse a netlist into {elements, directives, models, nodes}.
 * `nodes` maps node names to integer ids (0 = ground: matches "0", "GND", "gnd").
 *
 * @param {string} text
 * @param {{ includeFiles?: Record<string, string> }} [options]
 */
export function parseNetlist(text, options = {}) {
    const preWarnings = [];
    const preErrors = [];
    let source = String(text || '');
    if (options.includeFiles && typeof options.includeFiles === 'object') {
        const exp = expandSpiceForParse(source, options.includeFiles);
        source = exp.text;
        preWarnings.push(...exp.warnings);
        preErrors.push(...exp.errors);
    }
    const lines = preprocess(source);
    const elements = [];
    const directives = [];
    const models = {};
    /* Ground is canonical node 0. We normalise 'GND' / 'gnd' / '0' onto
       that same index before consulting the map so the map's `size`
       always reflects the true number of distinct electrical nodes —
       otherwise the MNA matrix gets empty rows and blows up with a
       singular-matrix error. */
    const nodeMap = new Map();
    nodeMap.set('0', 0);

    const nodeId = (name) => {
        let key = String(name).toLowerCase();
        if (key === 'gnd') key = '0';
        if (key === '0') return 0;
        if (!nodeMap.has(key)) nodeMap.set(key, nodeMap.size);
        return nodeMap.get(key);
    };

    const errors = [...preErrors];
    const warnings = [...preWarnings];

    /* We intentionally do NOT auto-skip the first line as a SPICE title —
       users of Circuit Studio start from blank canvases as often as from
       textbook netlists, and swallowing their first element line was
       worse than ignoring the SPICE title convention. If someone copies
       a ".TITLE ..." or bare-text title line in, it will just parse as
       an unknown-element warning, which is the right failure mode. */
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li].trim();
        if (line.length === 0) continue;

        const toks = tokenize(line);
        if (toks.length === 0) continue;
        const head = toks[0];
        const tag = head[0].toUpperCase();

        try {
            if (head.startsWith('.')) {
                const d = head.slice(1).toLowerCase();
                if (d === 'end') continue;
                if (d === 'op') { directives.push({ kind: 'op' }); continue; }
                if (d === 'dc') {
                    directives.push({
                        kind: 'dc',
                        src: toks[1],
                        start: parseSpiceValue(toks[2]),
                        stop: parseSpiceValue(toks[3]),
                        step: parseSpiceValue(toks[4]),
                    });
                    continue;
                }
                if (d === 'ac') {
                    const mode = (toks[1] || 'dec').toLowerCase();
                    directives.push({
                        kind: 'ac',
                        mode: mode === 'oct' ? 'oct' : (mode === 'lin' ? 'lin' : 'dec'),
                        n: parseSpiceValue(toks[2]) || 10,
                        fStart: parseSpiceValue(toks[3]),
                        fStop: parseSpiceValue(toks[4]),
                    });
                    continue;
                }
                if (d === 'tran') {
                    directives.push({
                        kind: 'tran',
                        tstep: parseSpiceValue(toks[1]),
                        tstop: parseSpiceValue(toks[2]),
                        tstart: toks[3] && toks[3].toUpperCase() !== 'UIC' ? parseSpiceValue(toks[3]) : 0,
                        uic: toks.slice(3).some((t) => t.toUpperCase() === 'UIC'),
                    });
                    continue;
                }
                if (d === 'step') {
                    /* .step <elementName> <start> <stop> <step>
                       Sweeps the primary value of the referenced element
                       (resistance for R, capacitance for C, DC level for
                       V/I, etc). The analysis pipeline re-solves every
                       step and plots a family-of-curves. */
                    directives.push({
                        kind: 'step',
                        target: toks[1],
                        start: parseSpiceValue(toks[2]),
                        stop:  parseSpiceValue(toks[3]),
                        step:  parseSpiceValue(toks[4]),
                    });
                    continue;
                }
                if (d === 'tf') {
                    /* .TF OUTVAR SRCNAM — small-signal transfer about the DC op.
                       OUTVAR: V(node), V(n1,n2), or I(Vname). SRC must be a
                       voltage source instance name. */
                    const outTok = (toks[1] || '').trim();
                    const srcTok = (toks[2] || '').trim();
                    if (!outTok || !srcTok) {
                        errors.push(`Line ${li + 1}: .TF needs <OUTVAR> <Vsrc>, e.g. .TF V(vout) Vin`);
                        continue;
                    }
                    const outCompact = outTok.replace(/\s+/g, '');
                    const mV = /^V\s*\(\s*([^),]+)\s*(?:,\s*([^)]+))?\s*\)$/i.exec(outCompact);
                    const mI = /^I\s*\(\s*([A-Za-z_][\w]*)\s*\)$/i.exec(outCompact);
                    if (mV) {
                        directives.push({
                            kind: 'tf',
                            outKind: 'v',
                            nPlus: mV[1].trim(),
                            nMinus: (mV[2] || '0').trim().replace(/^gnd$/i, '0'),
                            srcName: srcTok,
                            rawOut: outTok,
                        });
                    } else if (mI) {
                        directives.push({
                            kind: 'tf',
                            outKind: 'i',
                            probeVName: mI[1].trim(),
                            srcName: srcTok,
                            rawOut: outTok,
                        });
                    } else {
                        errors.push(`Line ${li + 1}: .TF OUTVAR must be V(node), V(n1,n2), or I(Vname) — got "${outTok}"`);
                    }
                    continue;
                }
                if (d === 'model') {
                    const name = toks[1];
                    // Model body may be ".model NAME D(Is=... N=...)" or with space before '('
                    const body = line.replace(/^\.model\s+\S+\s*/i, '');
                    const type = body.match(/^(\w+)/)?.[1]?.toUpperCase() || 'D';
                    const params = {};
                    const paramRe = /(\w+)\s*=\s*([-+0-9.eE\w]+)/g;
                    let mm;
                    while ((mm = paramRe.exec(body)) != null) {
                        params[mm[1].toLowerCase()] = parseSpiceValue(mm[2]);
                    }
                    models[name.toLowerCase()] = { name, type, params };
                    continue;
                }
                warnings.push(`Unknown directive '${head}' on line ${li + 1}`);
                continue;
            }

            // Element dispatch
            switch (tag) {
                case 'R': {
                    elements.push({
                        type: 'R', name: head, n1: nodeId(toks[1]), n2: nodeId(toks[2]),
                        value: parseSpiceValue(toks[3]),
                    });
                    break;
                }
                case 'C': {
                    const ic = toks.slice(4).find((t) => /^ic=/i.test(t));
                    elements.push({
                        type: 'C', name: head, n1: nodeId(toks[1]), n2: nodeId(toks[2]),
                        value: parseSpiceValue(toks[3]),
                        ic: ic ? parseSpiceValue(ic.split('=')[1]) : 0,
                    });
                    break;
                }
                case 'L': {
                    const ic = toks.slice(4).find((t) => /^ic=/i.test(t));
                    elements.push({
                        type: 'L', name: head, n1: nodeId(toks[1]), n2: nodeId(toks[2]),
                        value: parseSpiceValue(toks[3]),
                        ic: ic ? parseSpiceValue(ic.split('=')[1]) : 0,
                    });
                    break;
                }
                case 'V': {
                    elements.push({
                        type: 'V', name: head, n1: nodeId(toks[1]), n2: nodeId(toks[2]),
                        source: parseSourceSpec(toks, 3),
                    });
                    break;
                }
                case 'I': {
                    elements.push({
                        type: 'I', name: head, n1: nodeId(toks[1]), n2: nodeId(toks[2]),
                        source: parseSourceSpec(toks, 3),
                    });
                    break;
                }
                case 'D': {
                    elements.push({
                        type: 'D', name: head,
                        n1: nodeId(toks[1]), n2: nodeId(toks[2]),
                        model: (toks[3] || 'default').toLowerCase(),
                    });
                    break;
                }
                case 'E': {
                    elements.push({
                        type: 'E', name: head,
                        n1: nodeId(toks[1]), n2: nodeId(toks[2]),
                        nc1: nodeId(toks[3]), nc2: nodeId(toks[4]),
                        gain: parseSpiceValue(toks[5]),
                    });
                    break;
                }
                case 'G': {
                    elements.push({
                        type: 'G', name: head,
                        n1: nodeId(toks[1]), n2: nodeId(toks[2]),
                        nc1: nodeId(toks[3]), nc2: nodeId(toks[4]),
                        gm: parseSpiceValue(toks[5]),
                    });
                    break;
                }
                case 'O': {
                    // Ideal op-amp: O<name> in+ in- out   (virtual short + infinite output current)
                    elements.push({
                        type: 'O', name: head,
                        inp: nodeId(toks[1]), inn: nodeId(toks[2]), out: nodeId(toks[3]),
                    });
                    break;
                }
                case 'Q': {
                    /* BJT:  Q<name> C B E [substrate] MODEL
                       Substrate (4-terminal) form is accepted but the
                       substrate node is ignored by the solver — treated as
                       a 3-terminal Ebers-Moll device with the bulk/sub pin
                       folded into ground. This matches how most textbook
                       circuits invoke Q-devices. */
                    let mIdx = 4;
                    if (toks.length > 5) {
                        // Token 4 might be substrate node if token 5 looks like a model name.
                        const maybeModel4 = (toks[4] || '').toLowerCase();
                        const maybeModel5 = (toks[5] || '').toLowerCase();
                        if (models[maybeModel5] || !maybeModel4.match(/^(npn|pnp)$/)) {
                            mIdx = 5;
                        }
                    }
                    const mdlName = (toks[mIdx] || 'qdefault').toLowerCase();
                    elements.push({
                        type: 'Q', name: head,
                        nc: nodeId(toks[1]),   // collector
                        nb: nodeId(toks[2]),   // base
                        ne: nodeId(toks[3]),   // emitter
                        model: mdlName,
                    });
                    break;
                }
                case 'M': {
                    /* MOSFET:  M<name> D G S B MODEL [W=.. L=..]
                       Bulk node is required by SPICE convention. We accept
                       it but the level-1 stamp here ignores body-effect by
                       default — gamma in the model triggers the body
                       correction automatically. W/L override the model
                       defaults (1 µm / 1 µm) when present on the element
                       line. */
                    elements.push({
                        type: 'M', name: head,
                        nd: nodeId(toks[1]), ng: nodeId(toks[2]),
                        ns: nodeId(toks[3]), nbulk: nodeId(toks[4] || '0'),
                        model: (toks[5] || 'mdefault').toLowerCase(),
                        W: (() => {
                            const w = toks.slice(6).find((t) => /^w=/i.test(t));
                            return w ? parseSpiceValue(w.split('=')[1]) : undefined;
                        })(),
                        L: (() => {
                            const l = toks.slice(6).find((t) => /^l=/i.test(t));
                            return l ? parseSpiceValue(l.split('=')[1]) : undefined;
                        })(),
                    });
                    break;
                }
                default:
                    warnings.push(`Unknown element '${head}' on line ${li + 1}`);
            }
        } catch (err) {
            errors.push(`Line ${li + 1}: ${err?.message || err}`);
        }
    }

    // Default diode model if user didn't provide one.
    if (!models.default) {
        models.default = { name: 'DEFAULT', type: 'D', params: { is: 1e-14, n: 1, bv: 100, ibv: 1e-3, cj0: 0 } };
    }
    /* Reasonable textbook defaults for when a BJT/MOSFET references a
       model name that wasn't defined. These match LTspice's out-of-the-box
       "NPN"/"PNP"/"NMOS"/"PMOS" primitives closely enough that most
       beginner circuits will still simulate instead of erroring out. */
    if (!models.qdefault) {
        models.qdefault = {
            name: 'QDEFAULT', type: 'NPN',
            params: { is: 1e-16, bf: 100, br: 1, vaf: 100, nf: 1, nr: 1,
                      re: 0, rb: 0, rc: 0, cje: 0, cjc: 0 },
        };
    }
    if (!models.mdefault) {
        models.mdefault = {
            name: 'MDEFAULT', type: 'NMOS',
            params: { vto: 1.0, kp: 50e-6, lambda: 0.02, gamma: 0, phi: 0.6,
                      w: 10e-6, l: 1e-6, cgso: 0, cgdo: 0 },
        };
    }

    return {
        elements,
        directives,
        models,
        nodeNames: [...nodeMap.keys()],
        nodeIndex: (name) => {
            let k = String(name).toLowerCase();
            if (k === 'gnd') k = '0';
            if (k === '0') return 0;
            return nodeMap.get(k) ?? -1;
        },
        nNodes: nodeMap.size,
        errors,
        warnings,
    };
}
