/**
 * DC-oriented schematic diagnostics.
 *
 * 1) *Structural* DC connectivity — a graph walk from SPICE node 0 that
 *    treats capacitors as open circuits and current sources as *not*
 *    shorting their terminals (they have infinite impedance between
 *    n+ and n− at DC).  This catches nets that will float at the DC
 *    operating point even when geometric net resolution looks fine.
 *
 * 2) *Singular-matrix* post-mortem — maps the dense-MNA column index
 *    from the solver's Gaussian failure onto either an interior node
 *    (node column) or a branch unknown (V / L / E / O) so the canvas
 *    can pulse-highlight the implicated pins.
 */

import { componentPins } from './schematicDoc.js';

/** Same labelling rule as emitNetlist.nodeLabel (kept in sync manually). */
export function labelForGeomNode(nets, nodeId) {
    if (nodeId == null) return '?';
    if (nodeId === 0) return '0';
    const lab = nets?.nodeLabels?.get(nodeId);
    if (lab && !/^n\d+$/i.test(lab) && lab !== 'gnd') return lab;
    return `n${nodeId}`;
}

/** Reverse lookup: SPICE token from compact node id (0, 1, 2, …). */
export function spiceNodeNameForId(parsed, id) {
    if (!parsed?.nodeNames || !parsed.nodeIndex) return `node_${id}`;
    for (const name of parsed.nodeNames) {
        try {
            if (parsed.nodeIndex(name) === id) return name;
        } catch { /* ignore */ }
    }
    return `node_${id}`;
}

/** Every geometric net id that appears on at least one component pin. */
export function allGeomNodeIds(doc, nets) {
    const s = new Set([0]);
    if (!doc?.components || !nets) return s;
    for (const comp of doc.components) {
        for (const pin of componentPins(comp) || []) {
            const id = nets.pinNode(comp, pin.id);
            if (id != null) s.add(id);
        }
    }
    return s;
}

/**
 * Map a SPICE net name from the compiled netlist back onto one or more
 * geometric resolver node ids so we can find canvas pins to flag.
 */
export function findGeomNodeIdsForSpiceNodeName(nets, doc, spiceName) {
    const want = String(spiceName || '').trim().toLowerCase();
    if (want === '0' || want === 'gnd') return [0];
    const out = [];
    for (const gid of allGeomNodeIds(doc, nets)) {
        if (labelForGeomNode(nets, gid).toLowerCase() === want) out.push(gid);
    }
    if (out.length > 0) return out;
    const m = /^n(\d+)$/i.exec(String(spiceName || '').trim());
    if (m) {
        const k = +m[1];
        if (allGeomNodeIds(doc, nets).has(k)) return [k];
    }
    return [];
}

/** All { compId, pinId } pairs sitting on geometric node `gid`. */
export function collectPinsOnGeomNode(doc, nets, gid) {
    const pins = [];
    if (!doc?.components || !nets || gid == null) return pins;
    for (const comp of doc.components) {
        for (const pin of componentPins(comp) || []) {
            if (nets.pinNode(comp, pin.id) === gid) {
                pins.push({ compId: comp.id, pinId: pin.id });
            }
        }
    }
    return pins;
}

/**
 * Return SPICE node indices (0 … nNodes-1) that cannot reach node 0
 * through any *DC-conducting* edge (see module header).
 */
export function findStructuralDcDisconnectedSpiceNodes(parsed) {
    if (!parsed?.elements || !(parsed.nNodes > 0)) return [];
    const n = parsed.nNodes;
    const adj = Array.from({ length: n }, () => []);

    const add = (a, b) => {
        if (a < 0 || b < 0 || a >= n || b >= n || a === b) return;
        adj[a].push(b);
        adj[b].push(a);
    };

    for (const el of parsed.elements) {
        switch (el.type) {
            case 'R':
            case 'L':
            case 'V':
            case 'D':
                add(el.n1, el.n2);
                break;
            case 'E':
                add(el.n1, el.n2);
                break;
            case 'O':
                add(el.inp, el.inn);
                break;
            case 'Q': {
                add(el.nc, el.nb);
                add(el.nb, el.ne);
                add(el.nc, el.ne);
                break;
            }
            case 'M': {
                const ns = [el.nd, el.ng, el.ns, el.nbulk];
                const uniq = [...new Set(ns.filter((x) => x >= 0 && x < n))];
                for (let i = 0; i < uniq.length; i++) {
                    for (let j = i + 1; j < uniq.length; j++) add(uniq[i], uniq[j]);
                }
                break;
            }
            /* C, I, G — no DC short between their terminals for this graph */
            default:
                break;
        }
    }

    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) {
        const u = stack.pop();
        for (const v of adj[u]) {
            if (!seen.has(v)) {
                seen.add(v);
                stack.push(v);
            }
        }
    }

    const bad = [];
    for (let i = 0; i < n; i++) {
        if (!seen.has(i)) bad.push(i);
    }
    return bad;
}

/**
 * Merge structural DC-island findings into an existing validateSchematic
 * result so the canvas / inspector pick them up like any other DRC row.
 */
export function mergeDcConnectivityIssues(base, parsed, doc, nets) {
    if (!base || !parsed?.elements?.length || !nets || !doc) return base;
    const disconnected = findStructuralDcDisconnectedSpiceNodes(parsed);
    if (disconnected.length === 0) return base;

    const pinKeys = new Set(base.floatingPinKeys);
    const flagged = new Set(base.flaggedComponentIds);
    const extraIssues = [];

    for (const nid of disconnected) {
        const name = spiceNodeNameForId(parsed, nid);
        const gids = findGeomNodeIdsForSpiceNodeName(nets, doc, name);
        const pins = [];
        const compIds = new Set();
        for (const gid of gids) {
            for (const p of collectPinsOnGeomNode(doc, nets, gid)) {
                pinKeys.add(`${p.compId}|${p.pinId}`);
                pins.push(p);
                const c = doc.components.find((x) => x.id === p.compId);
                if (c) {
                    compIds.add(c.id);
                    flagged.add(c.id);
                }
            }
        }
        extraIssues.push({
            id: `dc-disconnect-${nid}`,
            severity: 'error',
            kind: 'dc-disconnected-node',
            message: `Net "${name}" has no DC path to ground. At the DC operating point capacitors are open circuits and current sources do not conduct between their pins, so this net can float and the matrix becomes singular. Fix: add a high‑value bleed resistor to ground, tie the net to a DC‑return path, or enable .tran UIC only if you really intend to skip the DC op‑point.`,
            pins,
            componentIds: [...compIds],
        });
    }

    return {
        ...base,
        issues: [...base.issues, ...extraIssues],
        floatingPinKeys: pinKeys,
        flaggedComponentIds: flagged,
        errorCount: base.errorCount + extraIssues.length,
    };
}

/**
 * Build extra validation rows + pin highlights after a failed Run, by
 * parsing the thrown error and (when possible) the active solver ctx.
 */
export function diagnoseSolverRunFailure(err, ctx, parsed, doc, nets) {
    const pinKeys = new Set();
    const flaggedComponentIds = new Set();
    const issues = [];
    const msg = String(err?.message || err);

    const mCol = /Singular matrix at column (\d+)/i.exec(msg);
    if (mCol && ctx && parsed && doc && nets) {
        const col = parseInt(mCol[1], 10);
        const interior = ctx.interior;
        if (col < interior) {
            const spiceNode = col + 1;
            const name = spiceNodeNameForId(parsed, spiceNode);
            const pins = [];
            for (const gid of findGeomNodeIdsForSpiceNodeName(nets, doc, name)) {
                for (const p of collectPinsOnGeomNode(doc, nets, gid)) {
                    pinKeys.add(`${p.compId}|${p.pinId}`);
                    pins.push(p);
                    const c = doc.components.find((x) => x.id === p.compId);
                    if (c) {
                        flaggedComponentIds.add(c.id);
                    }
                }
            }
            issues.push({
                id: 'solver-singular-node',
                severity: 'error',
                kind: 'solver-singular-matrix',
                message: `Solver: ${msg} — highlighted pins are on net "${name}" (interior unknown index ${col}).`,
                pins,
                componentIds: [...new Set(pins.map((p) => p.compId))],
            });
        } else {
            const bi = col - interior;
            const branchEl = ctx.branchElems?.[bi];
            if (branchEl) {
                const refLower = String(branchEl.name).toLowerCase();
                const comp = doc.components.find((c) => String(c.ref || '').toLowerCase() === refLower);
                const pins = [];
                if (comp) {
                    flaggedComponentIds.add(comp.id);
                    for (const pin of componentPins(comp) || []) {
                        const k = `${comp.id}|${pin.id}`;
                        pinKeys.add(k);
                        pins.push({ compId: comp.id, pinId: pin.id });
                    }
                }
                const kindLabel = branchEl.type === 'L' ? 'inductor' : 'voltage source / controlled source';
                issues.push({
                    id: 'solver-singular-branch',
                    severity: 'error',
                    kind: 'solver-singular-branch',
                    message: `Solver: ${msg} — highlighted part is ${branchEl.name} (${kindLabel}). Typical causes: two ideal voltage sources in parallel, a loop of voltage sources/inductors with no series resistance, or an ill‑posed op‑amp feedback network.`,
                    pins,
                    componentIds: comp ? [comp.id] : [],
                });
            }
        }
    }

    return { pinKeys, flaggedComponentIds, issues };
}

/**
 * Merge solver-failure diagnostics into a validation snapshot for one
 * render cycle (Canvas + net warnings).
 */
export function mergeSolverDiagnostic(validation, diagnostic) {
    if (!validation) return null;
    if (!diagnostic) return validation;
    const hasPins = diagnostic.pinKeys && diagnostic.pinKeys.size > 0;
    const hasIssues = diagnostic.issues && diagnostic.issues.length > 0;
    if (!hasPins && !hasIssues) return validation;

    const pinKeys = new Set(validation.floatingPinKeys);
    if (hasPins) for (const k of diagnostic.pinKeys) pinKeys.add(k);
    const flagged = new Set(validation.flaggedComponentIds);
    if (diagnostic.flaggedComponentIds) {
        for (const id of diagnostic.flaggedComponentIds) flagged.add(id);
    }
    const extra = diagnostic.issues || [];
    let err = validation.errorCount;
    for (const i of extra) if (i.severity === 'error') err++;

    return {
        ...validation,
        floatingPinKeys: pinKeys,
        flaggedComponentIds: flagged,
        issues: [...validation.issues, ...extra],
        errorCount: err,
    };
}
