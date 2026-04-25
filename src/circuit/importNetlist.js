/**
 * Seed a SchematicDoc from a SPICE netlist string.
 *
 * Approach:
 *   1. Parse the netlist with the existing `parseNetlist` to get
 *      {elements, models, directives, …}.
 *   2. Run `layoutSchematic` — this gives us force-directed, grid-
 *      snapped placements, orientations, and Manhattan-routed wires.
 *   3. For each laid-out component, create a corresponding doc
 *      component at the same (x, y, rot). Map the solver element +
 *      model to the closest library part (so the inspector can edit
 *      it with a nice UI).
 *   4. Copy wire polylines straight across — they're already in
 *      pixel coords.
 *   5. Preserve directives as raw text so the emitter can round-trip
 *      them back out.
 *
 * The resulting doc is *functionally* identical to the source net-
 * list: re-emitting it and re-parsing should yield the same solver
 * context.
 */

import { parseNetlist } from './netlist.js';
import { layoutSchematic } from './schematic.js';
import {
    emptyDoc, GRID, snap, addLabel, componentPins,
} from './schematicDoc.js';
import { getPart, LIBRARY } from './library.js';

/** Choose a library part id for a parsed element + optional model. */
function partIdFor(element, models) {
    const t = element.type;
    switch (t) {
        case 'R': return 'R';
        case 'C': return 'C';
        case 'L': return 'L';
        case 'V': {
            const specs = element.source || [];
            if (specs.some((s) => s.kind === 'pulse')) return 'V_pulse';
            if (specs.some((s) => s.kind === 'sin'))   return 'V_sin';
            if (specs.some((s) => s.kind === 'ac'))    return 'V_ac';
            return 'V_dc';
        }
        case 'I': return 'I_dc';
        case 'D': {
            const mdl = models?.[element.model];
            if (mdl?.bv && mdl.bv > 0) return 'D_zener';
            return 'D_sig';
        }
        case 'Q': {
            const mdl = models?.[element.model];
            const kind = (mdl?.type || 'NPN').toUpperCase();
            return kind === 'PNP' ? 'Q_pnp' : 'Q_npn';
        }
        case 'M': {
            const mdl = models?.[element.model];
            const kind = (mdl?.type || 'NMOS').toUpperCase();
            return kind === 'PMOS' ? 'M_pmos' : 'M_nmos';
        }
        case 'O': return 'O_opamp';
        case 'E': return 'E_vcvs';
        case 'G': return 'G_vccs';
        default:  return null;
    }
}

/** Copy source-spec objects from the parser into the doc schema. */
function copySourceSpec(element) {
    if (!element.source) return null;
    return element.source.map((s) => ({ ...s }));
}

/** Map from pin-id → parsed node index, per solver element type. */
function pinNodesFor(el) {
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

/**
 * Turn a netlist text into an editable SchematicDoc.
 *
 * Returns { doc, nodes, warnings } where `nodes` is the node list
 * from the auto-layout (used by the canvas to draw labels).
 */
/**
 * @param {string} netlistText
 * @param {{ includeFiles?: Record<string, string> }} [options] — same as {@link parseNetlist}
 */
export function importNetlistToDoc(netlistText, options = {}) {
    const parsed = parseNetlist(netlistText, { includeFiles: options.includeFiles });
    const layout = layoutSchematic(parsed);

    const doc = emptyDoc();
    const warnings = [];

    // Shift all layout coordinates so nothing lives in negative space
    // (the canvas works in a fixed world coord system starting at 0).
    const ox = layout.offsetX || 0;
    const oy = layout.offsetY || 0;

    // Remember a mapping from parsed element index → created doc component
    // so wire routing can still figure out node → pin connections later.
    const compByIndex = new Map();

    // 1) Components.
    for (const lc of layout.components) {
        const el = lc.element;
        const partId = partIdFor(el, parsed.models);
        if (!partId) {
            warnings.push(`Unsupported element skipped during import: ${el.type}${el.name || ''}`);
            continue;
        }
        const part = getPart(partId);

        // Create component manually so we can preserve the original
        // reference designator and value exactly as the user wrote
        // them (rather than auto-numbering).
        const comp = {
            id: `u${doc.meta.nextUid++}`,
            partId,
            elementType: part.elementType,
            symbolKey: part.symbolKey,
            pos: { x: snap(lc.x + ox), y: snap(lc.y + oy) },
            rot: lc.rot || 0,
            ref: (part.refPrefix || el.type) + (el.name || '?'),
            value: el.value ?? el.gain ?? el.gm ?? part.defaultValue,
            valueUnit: part.valueUnit,
            sourceSpec: copySourceSpec(el),
            modelRef: el.model || part.modelRef || null,
            autoGround: false,
        };

        // If parsed element doesn't have a ref prefix leading its name,
        // tidy up to "R1" / "Q2" style.
        if (el.name) {
            const pfx = part.refPrefix;
            const alreadyPrefixed = el.name.toUpperCase().startsWith(pfx.toUpperCase());
            comp.ref = alreadyPrefixed ? el.name : `${pfx}${el.name}`;
        }

        // Keep the running ref counter in sync so freshly dropped
        // components don't collide with imported ones.
        const m = /^([A-Za-z]+)(\d+)$/.exec(comp.ref);
        if (m) {
            const pfx = m[1];
            const n = parseInt(m[2], 10);
            doc.meta.refCounts[pfx] = Math.max(doc.meta.refCounts[pfx] || 0, n);
        }

        doc.components.push(comp);
        compByIndex.set(lc.index, comp);

        // Stamp a net label at each pin using the parsed node name —
        // this guarantees electrical correctness regardless of how
        // the auto-router drew the wires (which can cross and would
        // otherwise be incorrectly merged by geometric resolution).
        const pinNodes = pinNodesFor(el);
        for (const pin of componentPins(comp)) {
            const nodeIdx = pinNodes[pin.id];
            if (nodeIdx == null) continue;
            const name = nodeIdx === 0 ? 'gnd'
                : (parsed.nodeNames?.[nodeIdx] || `n${nodeIdx}`);
            addLabel(doc, pin.x, pin.y, name, false);
        }
    }

    // 2) Ground marker. Place a single GND symbol near the bus point
    // assigned by the auto-layout so the user can see where node 0
    // lives; the actual electrical connectivity is enforced by the
    // 'gnd' net labels stamped on pins above.
    const groundBus = layout.nodes.find((n) => n.id === 0 || n.isGround);
    if (groundBus) {
        const gpart = getPart('GND');
        doc.components.push({
            id: `u${doc.meta.nextUid++}`,
            partId: 'GND',
            elementType: gpart.elementType,
            symbolKey: gpart.symbolKey,
            pos: { x: snap(groundBus.x + ox), y: snap(groundBus.y + oy) },
            rot: 0,
            ref: '0',
            value: null,
            valueUnit: null,
            sourceSpec: null,
            modelRef: null,
            autoGround: false,
        });
    }

    // 3) Carry over user-declared .model entries so round-trip
    //    emission preserves them exactly.
    if (parsed.models) {
        for (const key of Object.keys(parsed.models)) {
            const m = parsed.models[key];
            doc.userModels.push({
                name: m.name || key,
                type: m.type || 'D',
                params: { ...(m.params || {}) },
            });
        }
    }

    // 3) Wires — copied as visual-only polylines. Electrical
    // connectivity is carried by the pin labels stamped above, so
    // the auto-router's crossings and intermediate bends never
    // cause spurious net merges.
    //
    // We deliberately do NOT snap individual wire vertices here:
    // off-grid coordinates (capacitor pins at ±30 px, inductor pins
    // at ±38 px) are the whole reason for this fix — re-snapping
    // would push the endpoint back off its pin and leave a dangle.
    for (const w of layout.wires) {
        const pts = w.points.map(([x, y]) => [Math.round(x + ox), Math.round(y + oy)]);
        doc.wires.push({
            id: `u${doc.meta.nextUid++}`,
            points: pts,
        });
    }

    if (parsed.directives) {
        for (const d of parsed.directives) {
            doc.directives.push({
                id: `u${doc.meta.nextUid++}`,
                kind: d.kind || 'raw',
                text: directiveToText(d),
                parsed: d,
            });
        }
    }

    // Pin-stamped labels + visual-only wires (see import header). Net
    // resolution must stay label-authoritative for this doc.
    doc.meta.labelNetAuthority = true;

    return {
        doc,
        width: layout.width,
        height: layout.height,
        nodes: layout.nodes,
        warnings,
    };
}

/** Format a parsed directive back to canonical SPICE text. */
function directiveToText(d) {
    const fv = (x) => (Number.isFinite(x) ? String(x) : String(x ?? ''));
    switch (d.kind) {
        case 'op':   return '.op';
        case 'dc':   return `.dc ${d.src} ${fv(d.start)} ${fv(d.stop)} ${fv(d.step)}`;
        case 'ac':   return `.ac ${d.mode} ${fv(d.n)} ${fv(d.fStart)} ${fv(d.fStop)}`;
        case 'tran': return `.tran ${fv(d.tstep)} ${fv(d.tstop)}${d.tstart ? ' ' + fv(d.tstart) : ''}${d.uic ? ' UIC' : ''}`;
        // Parser stores the increment as `step` (see netlist.js); older
        // drafts may have used `inc`.
        case 'step': return `.step ${d.target} ${fv(d.start)} ${fv(d.stop)} ${fv(d.step ?? d.inc)}`;
        case 'model': return d.raw || '.model';
        default: return d.raw || '';
    }
}

/** Quick utility: reverse lookup of the library entry for a doc component. */
export function partForComponent(comp) {
    return getPart(comp.partId) || LIBRARY.find((p) => p.elementType === comp.elementType) || null;
}
