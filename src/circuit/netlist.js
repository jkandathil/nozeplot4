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
 *   D  diode                    D<name> anode cathode MODEL
 *   E  VCVS                     E<name> n+ n- c+ c- gain
 *   G  VCCS                     G<name> n+ n- c+ c- gm
 *   O  ideal op-amp             O<name> in+ in- out        (virtual-short constraint, infinite gain)
 *   .model NAME D(Is=... N=...)           diode parameters
 *
 * Supported directives:
 *   .op
 *   .dc <src> <start> <stop> <step>
 *   .ac {DEC|OCT|LIN} <N> <f_start> <f_stop>
 *   .tran <tstep> <tstop> [tstart] [UIC]
 *   .end
 *
 * Comments: lines starting with '*' and anything after ';' on a line.
 *
 * Unit suffixes: T, G, MEG, K, M, U, N, P, F (case-insensitive),
 *                plus 'mil' and 'Hz'/'s' which are stripped.
 */

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

/** Strip comments and blank lines, and fold '+'-continuation lines into the previous entry. */
function preprocess(text) {
    const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    for (let line of raw) {
        // Semicolon / '//' comment tail
        const semi = line.indexOf(';');
        if (semi >= 0) line = line.slice(0, semi);
        const slash = line.indexOf('//');
        if (slash >= 0) line = line.slice(0, slash);
        line = line.trimEnd();
        if (line.length === 0) { out.push(''); continue; }
        const first = line.trimStart()[0];
        if (first === '*') { out.push(''); continue; }     // full-line comment
        if (first === '+' && out.length > 0) {
            // Continuation — glue onto previous.
            out[out.length - 1] = out[out.length - 1] + ' ' + line.trimStart().slice(1);
        } else {
            out.push(line);
        }
    }
    return out;
}

/**
 * Split a line into tokens, preserving parenthesised groups like
 * SIN(0 1 1k) as a single token so the parameterised source parser
 * can handle them downstream.
 */
function tokenize(line) {
    const out = [];
    let i = 0;
    const n = line.length;
    while (i < n) {
        while (i < n && /\s/.test(line[i])) i++;
        if (i >= n) break;
        let start = i;
        let depth = 0;
        while (i < n) {
            const ch = line[i];
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            else if (depth === 0 && /\s/.test(ch)) break;
            i++;
        }
        out.push(line.slice(start, i));
    }
    return out;
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
 */
export function parseNetlist(text) {
    const lines = preprocess(text);
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

    const errors = [];
    const warnings = [];

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
                default:
                    warnings.push(`Unknown element '${head}' on line ${li + 1}`);
            }
        } catch (err) {
            errors.push(`Line ${li + 1}: ${err?.message || err}`);
        }
    }

    // Default diode model if user didn't provide one.
    if (!models.default) {
        models.default = { name: 'DEFAULT', type: 'D', params: { is: 1e-14, n: 1, bv: 100, cj0: 0 } };
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
