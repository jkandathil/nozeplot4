/**
 * SchematicDoc → SPICE netlist string.
 *
 * Design notes:
 *   - Node IDs come from `resolveNets(doc)`, which pins ground to
 *     node 0. We emit them as `n<id>` (n1, n2, …) except for 0 which
 *     becomes `gnd` by convention.
 *   - Component reference designators (R1, C2, Q3…) are preserved
 *     verbatim from the doc — these are user-visible and should be
 *     stable across saves.
 *   - Models: each component's `modelRef` pulls the matching
 *     .model definition from BUILTIN_MODELS; we deduplicate so one
 *     DSIG model is emitted even if there are 20 D_sig parts.
 *   - Directives (.op / .ac / .tran / .dc / .step) are stored as raw
 *     text on the doc and just appended as-is.
 *
 * If the doc has structural problems (a pin in no net, an active
 * device without a model, etc.) we emit comments flagging them so
 * the user can fix them interactively. We never throw — a broken
 * schematic should still produce something parseable, because the
 * solver will give clearer diagnostics than we ever could.
 */

import { resolveNets } from './schematicDoc.js';
import { BUILTIN_MODELS } from './library.js';

const GND_LABEL = '0'; // Spice's canonical ground.

function nodeLabel(nodeId, nets) {
    if (nodeId == null) return '?';
    if (nodeId === 0) return GND_LABEL;
    // Use custom labels (from net labels in the doc) if any; else
    // default to auto-generated "n<id>" names.
    const lab = nets?.nodeLabels?.get(nodeId);
    // Skip auto labels (n1, n2, …) — those collide with default
    // naming and we'd rather emit a clean default.
    if (lab && !/^n\d+$/.test(lab) && lab !== 'gnd') {
        return lab;
    }
    return `n${nodeId}`;
}

function formatValue(v, unit) {
    if (!Number.isFinite(v)) return String(v);
    const av = Math.abs(v);
    if (av === 0) return '0';
    // Prefer engineering-notation suffixes (k, Meg, u, n, p, f).
    if (av >= 1e9)  return `${v / 1e9}G`;
    if (av >= 1e6)  return `${v / 1e6}Meg`;
    if (av >= 1e3)  return `${v / 1e3}k`;
    if (av >= 1)    return `${v}`;
    if (av >= 1e-3) return `${v / 1e-3}m`;
    if (av >= 1e-6) return `${v / 1e-6}u`;
    if (av >= 1e-9) return `${v / 1e-9}n`;
    if (av >= 1e-12) return `${v / 1e-12}p`;
    if (av >= 1e-15) return `${v / 1e-15}f`;
    return v.toExponential(3);
}

function formatSourceSpec(specs) {
    if (!specs || specs.length === 0) return 'DC 0';
    const out = [];
    for (const s of specs) {
        switch (s.kind) {
            case 'dc':
                out.push(`DC ${formatValue(s.v)}`);
                break;
            case 'ac':
                out.push(`AC ${formatValue(s.mag)}${s.phase != null ? ` ${formatValue(s.phase)}` : ''}`);
                break;
            case 'sin':
                out.push(`SIN(${formatValue(s.vo)} ${formatValue(s.va)} ${formatValue(s.f)} ${formatValue(s.td || 0)} ${formatValue(s.theta || 0)})`);
                break;
            case 'pulse':
                out.push(`PULSE(${formatValue(s.v1)} ${formatValue(s.v2)} ${formatValue(s.td || 0)} ${formatValue(s.tr || 1e-9)} ${formatValue(s.tf || 1e-9)} ${formatValue(s.pw)} ${formatValue(s.per)})`);
                break;
            case 'pwl': {
                const pts = (s.points || []).map(([t, v]) => `${formatValue(t)} ${formatValue(v)}`).join(' ');
                out.push(`PWL(${pts})`);
                break;
            }
            default:
                out.push('DC 0');
        }
    }
    return out.join(' ');
}

/**
 * @param {SchematicDoc} doc
 * @param {Object} [opts]
 * @param {string} [opts.title] Optional first-line title comment.
 * @returns {{ text: string, nets, warnings: string[] }}
 */
export function emitNetlist(doc, opts = {}) {
    const nets = resolveNets(doc);
    const warnings = [];
    const lines = [];
    const title = opts.title || 'Circuit Studio schematic';
    lines.push(`* ${title}`);

    // Track which models we've emitted so we don't duplicate.
    const emittedModels = new Set();

    for (const comp of doc.components) {
        if (comp.elementType === 'GND') continue; // just a marker
        // Voltage probes + oscilloscopes are UI-only — they tag a
        // node for the plot auto-selector and the scope modal, but
        // contribute nothing to the netlist.
        if (comp.elementType === 'VP') continue;
        if (comp.elementType === 'SCOPE') continue;

        const ref = comp.ref;
        const pinOrder = pinOrderFor(comp.elementType);
        const nodes = pinOrder.map((pid) => {
            const n = nets.pinNode(comp, pid);
            if (n == null) {
                warnings.push(`${ref}: pin ${pid} is floating`);
                return '?';
            }
            return nodeLabel(n, nets);
        });

        switch (comp.elementType) {
            case 'R': case 'C': case 'L': {
                lines.push(`${ref} ${nodes[0]} ${nodes[1]} ${formatValue(comp.value)}`);
                break;
            }
            case 'V': {
                // Synthesize second terminal if autoGround (VCC rail).
                const n1 = nodes[0] ?? '?';
                const n2 = comp.autoGround ? '0' : (nodes[1] ?? '?');
                lines.push(`${ref} ${n1} ${n2} ${formatSourceSpec(comp.sourceSpec)}`);
                break;
            }
            case 'I': {
                lines.push(`${ref} ${nodes[0]} ${nodes[1]} ${formatSourceSpec(comp.sourceSpec)}`);
                break;
            }
            case 'D': {
                const model = comp.modelRef || 'DSIG';
                lines.push(`${ref} ${nodes[0]} ${nodes[1]} ${model}`);
                if (BUILTIN_MODELS[model] && !emittedModels.has(model)) {
                    emittedModels.add(model);
                }
                break;
            }
            case 'Q': {
                // Q <name> c b e <model>
                const model = comp.modelRef || 'QN2222';
                lines.push(`${ref} ${nodes[0]} ${nodes[1]} ${nodes[2]} ${model}`);
                if (BUILTIN_MODELS[model]) emittedModels.add(model);
                break;
            }
            case 'M': {
                // M <name> d g s [b] <model>
                const model = comp.modelRef || 'MN_DEF';
                // Four-terminal MOSFET: if the symbol's b pin isn't connected
                // we tie body to source by convention.
                const nd = nodes[0]; const ng = nodes[1]; const ns = nodes[2];
                const nb = nodes[3] != null && nodes[3] !== '?' ? nodes[3] : ns;
                lines.push(`${ref} ${nd} ${ng} ${ns} ${nb} ${model}`);
                if (BUILTIN_MODELS[model]) emittedModels.add(model);
                break;
            }
            case 'O': {
                // Ideal opamp: O <name> in+ in- out
                lines.push(`${ref} ${nodes[0]} ${nodes[1]} ${nodes[2]}`);
                break;
            }
            case 'E': {
                // VCVS: E <name> out+ out- ctl+ ctl- gain
                lines.push(`${ref} ${nodes[0]} ${nodes[1]} ${nodes[2]} ${nodes[3]} ${formatValue(comp.value)}`);
                break;
            }
            case 'G': {
                // VCCS: G <name> out+ out- ctl+ ctl- gm
                lines.push(`${ref} ${nodes[0]} ${nodes[1]} ${nodes[2]} ${nodes[3]} ${formatValue(comp.value)}`);
                break;
            }
            case 'IP': {
                // Current probe → zero-volt voltage source. The solver
                // adds a branch for any V-type element so its current
                // is automatically tracked and surfaces later as
                // I(<probe-ref>) on the plot. Prefix with "V" so the
                // parser sees it as a voltage source even if the user
                // chose a custom IP ref; the leading letter is what
                // netlist.js dispatches on.
                const spiceName = ref.startsWith('V') ? ref : `V${ref}`;
                lines.push(`${spiceName} ${nodes[0]} ${nodes[1]} DC 0`);
                break;
            }
            default:
                warnings.push(`${ref}: unknown element type ${comp.elementType}`);
        }
    }

    // User-defined models (imported from a netlist) come first so
    // built-ins can reference them if they ever collide.
    if (doc.userModels && doc.userModels.length > 0) {
        lines.push('');
        for (const m of doc.userModels) {
            lines.push(serialiseModel(m));
        }
    }

    // Built-in models referenced by library parts.
    if (emittedModels.size > 0) {
        for (const m of emittedModels) {
            // Don't re-emit a model the user already declared under
            // the same name (case-insensitive).
            const clash = (doc.userModels || []).some((u) => u.name.toLowerCase() === m.toLowerCase());
            if (clash) continue;
            const def = BUILTIN_MODELS[m];
            if (def) lines.push(def);
        }
    }

    // Directives (user-authored or imported).
    if (doc.directives && doc.directives.length > 0) {
        lines.push('');
        for (const d of doc.directives) {
            lines.push((d.text || '').trim());
        }
    }

    lines.push('.end');

    return {
        text: lines.join('\n'),
        nets,
        warnings,
    };
}

function serialiseModel(m) {
    const params = Object.entries(m.params || {})
        .map(([k, v]) => `${k}=${formatValue(v)}`)
        .join(' ');
    return `.model ${m.name} ${m.type}(${params})`;
}

/**
 * Return the SYMBOL pin ordering the solver expects for each element
 * type. Pin ids come from src/circuit/symbols.js.
 */
function pinOrderFor(elementType) {
    switch (elementType) {
        case 'R': case 'C': case 'L': case 'V': case 'I': case 'D':
            return ['n1', 'n2'];
        case 'Q': return ['nc', 'nb', 'ne'];          // collector, base, emitter
        case 'M': return ['nd', 'ng', 'ns', 'nbulk']; // drain, gate, source, body
        case 'O': return ['inp', 'inn', 'out'];
        case 'E': case 'G': return ['n1', 'n2', 'nc1', 'nc2'];
        case 'IP': return ['n1', 'n2'];
        case 'VP': return ['tip'];
        case 'SCOPE': return ['tip'];
        default: return [];
    }
}
