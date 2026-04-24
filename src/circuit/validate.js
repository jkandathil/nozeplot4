/**
 * Schematic design-rule check.
 *
 * Consumes a SchematicDoc plus the output of resolveNets() and returns a
 * structured list of issues that the UI can render as visual markers and
 * a human-readable summary. Nothing here throws — if the inputs are
 * malformed we fall back to an empty result so the UI never crashes
 * mid-edit.
 *
 * Categories detected:
 *   • dangling-wire-endpoint  (warn) — a wire endpoint doesn't touch any
 *     pin, other wire, junction, or label. Usually means the user stopped
 *     drawing short of the target.
 *   • floating-pin            (warn) — component pin that isn't shared
 *     with any other pin or wire vertex. Sourced from nets.floatingPins.
 *   • orphan-component        (error) — every pin of the component is
 *     floating. The component contributes nothing and (for most element
 *     types) will produce `? ?` placeholders in the emitted netlist.
 *   • no-ground               (error) — no node is tied to SPICE node 0.
 *     DC solve is guaranteed to fail with a singular matrix.
 *   • duplicate-ref           (warn) — two or more components share the
 *     same reference designator. Simulation still runs but stepping /
 *     probing gets ambiguous.
 *
 * CircuitStudioPage may merge additional rows from dcDiagnostics.js:
 *   • dc-disconnected-node    (error) — SPICE node has no DC path to
 *     ground when capacitors are opens and I-sources don't short pins.
 *   • solver-singular-matrix / solver-singular-branch (error) — pinned
 *     after a failed Run so the canvas can highlight implicated nets.
 *
 * The returned object also exposes ready-to-consume Sets / arrays so the
 * Canvas doesn't have to re-scan the issue list to decide how to render
 * each element.
 */

import { componentPins } from './schematicDoc.js';

/**
 * @typedef {Object} ValidationIssue
 * @property {string} id                       Stable key (for React).
 * @property {'error'|'warn'} severity
 * @property {string} kind                     Category string above.
 * @property {string} message                  Human-readable summary.
 * @property {string[]} [componentIds]         Flagged components.
 * @property {string[]} [wireIds]              Flagged wires.
 * @property {Array<{compId:string,pinId:string}>} [pins]
 * @property {Array<{wireId:string,pointIndex:number,x:number,y:number}>} [endpoints]
 */

/**
 * @param {object} doc   SchematicDoc
 * @param {object|null} nets  Result of resolveNets(doc), or null when resolution failed.
 * @returns {{
 *   issues: ValidationIssue[],
 *   flaggedComponentIds: Set<string>,
 *   flaggedWireIds: Set<string>,
 *   floatingPinKeys: Set<string>,
 *   danglingEndpoints: Array<{wireId:string,pointIndex:number,x:number,y:number}>,
 *   hasGround: boolean,
 *   errorCount: number,
 *   warnCount: number,
 * }}
 */
export function validateSchematic(doc, nets) {
    const issues = [];
    const flaggedComponentIds = new Set();
    const flaggedWireIds = new Set();
    const floatingPinKeys = new Set();
    const danglingEndpoints = [];

    if (!doc || !Array.isArray(doc.components)) {
        return empty();
    }

    /* -------------------------------------------------- floating pins */
    // Surface each floating pin as its own issue so the messages line up
    // 1:1 with the dashed markers the canvas already draws.
    if (nets && Array.isArray(nets.floatingPins)) {
        for (const fp of nets.floatingPins) {
            const comp = doc.components.find((c) => c.id === fp.comp.id) || fp.comp;
            const key = `${comp.id}|${fp.pinId}`;
            floatingPinKeys.add(key);
            flaggedComponentIds.add(comp.id);
            issues.push({
                id: `float-${key}`,
                severity: 'warn',
                kind: 'floating-pin',
                message: `Pin ${fp.pinId} of ${comp.ref || comp.id} is floating — wire it to something or it'll produce a '?' in the netlist.`,
                componentIds: [comp.id],
                pins: [{ compId: comp.id, pinId: fp.pinId }],
            });
        }
    }

    /* -------------------------------------------------- orphan parts */
    // "Orphan" = every pin of this component is floating. We don't flag
    // single-pin grounds: their only pin is meant to be floating from
    // the pin-sharing perspective; they're the anchor.
    for (const comp of doc.components) {
        if (comp.elementType === 'GND') continue;
        const pins = componentPins(comp) || [];
        if (pins.length === 0) continue;
        const allFloating = pins.every((p) => floatingPinKeys.has(`${comp.id}|${p.id}`));
        if (allFloating) {
            flaggedComponentIds.add(comp.id);
            issues.push({
                id: `orphan-${comp.id}`,
                severity: 'error',
                kind: 'orphan-component',
                message: `${comp.ref || comp.id} is unconnected — all pins are dangling. Delete it or wire it in.`,
                componentIds: [comp.id],
            });
        }
    }

    /* -------------------------------------------------- dangling wire ends */
    // An endpoint is "dangling" if no other vertex in the schematic
    // shares its coordinate. We build a coord-count map that counts:
    //   • every component pin
    //   • every wire vertex (including mid-polyline, so a wire that
    //     T's into another wire isn't flagged at the T)
    //   • every label
    // Then a wire endpoint with count == 1 (itself) is dangling.
    const coordCount = new Map();
    const bump = (x, y) => {
        const k = `${x}|${y}`;
        coordCount.set(k, (coordCount.get(k) || 0) + 1);
    };
    for (const comp of doc.components) {
        for (const pin of componentPins(comp) || []) bump(pin.x, pin.y);
    }
    for (const wire of doc.wires || []) {
        for (const [x, y] of wire.points || []) bump(x, y);
    }
    for (const label of doc.labels || []) bump(label.x, label.y);

    // Additional case: wires can cross a pin mid-segment (T-junction).
    // In that situation the endpoint coord might be shared with nothing
    // else but still be electrically fine. We err on the side of
    // reporting because the endpoint visually looks unattached; users
    // can always draw a short stub to silence it.
    for (const wire of doc.wires || []) {
        const pts = wire.points || [];
        if (pts.length < 2) continue;
        const endpoints = [
            { idx: 0, p: pts[0] },
            { idx: pts.length - 1, p: pts[pts.length - 1] },
        ];
        for (const { idx, p } of endpoints) {
            const [x, y] = p;
            const k = `${x}|${y}`;
            if ((coordCount.get(k) || 0) <= 1) {
                danglingEndpoints.push({ wireId: wire.id, pointIndex: idx, x, y });
                flaggedWireIds.add(wire.id);
                issues.push({
                    id: `dangle-${wire.id}-${idx}`,
                    severity: 'warn',
                    kind: 'dangling-wire-endpoint',
                    message: `Wire endpoint at (${x}, ${y}) doesn't connect to anything. Extend it onto a pin or another wire.`,
                    wireIds: [wire.id],
                    endpoints: [{ wireId: wire.id, pointIndex: idx, x, y }],
                });
            }
        }
    }

    /* -------------------------------------------------- ground reference */
    // Cheapest reliable check: does the resolver report any node 0? If
    // not, every node is floating from SPICE's perspective and DC solve
    // will hit a singular matrix.
    const hasGround = detectGround(doc, nets);
    if (!hasGround && doc.components.length > 0) {
        issues.push({
            id: 'no-ground',
            severity: 'error',
            kind: 'no-ground',
            message: 'No ground reference — place a GND symbol and wire one node to it, or the DC solver will fail with a singular matrix.',
        });
    }

    /* -------------------------------------------------- duplicate refs */
    const refToComps = new Map();
    for (const comp of doc.components) {
        if (!comp.ref) continue;
        if (!refToComps.has(comp.ref)) refToComps.set(comp.ref, []);
        refToComps.get(comp.ref).push(comp);
    }
    for (const [ref, comps] of refToComps) {
        if (comps.length <= 1) continue;
        for (const c of comps) flaggedComponentIds.add(c.id);
        issues.push({
            id: `dup-${ref}`,
            severity: 'warn',
            kind: 'duplicate-ref',
            message: `Reference "${ref}" is used by ${comps.length} components — rename them so probes and .print lines stay unambiguous.`,
            componentIds: comps.map((c) => c.id),
        });
    }

    let errorCount = 0;
    let warnCount = 0;
    for (const i of issues) {
        if (i.severity === 'error') errorCount++;
        else warnCount++;
    }

    return {
        issues,
        flaggedComponentIds,
        flaggedWireIds,
        floatingPinKeys,
        danglingEndpoints,
        hasGround,
        errorCount,
        warnCount,
    };
}

/** Build an empty-but-well-formed result so callers can assume the shape. */
function empty() {
    return {
        issues: [],
        flaggedComponentIds: new Set(),
        flaggedWireIds: new Set(),
        floatingPinKeys: new Set(),
        danglingEndpoints: [],
        hasGround: true,
        errorCount: 0,
        warnCount: 0,
    };
}

/**
 * A schematic has a *usable* ground only if some non-GND component pin
 * actually reaches node 0. The resolver always pins GND's own pin to
 * node 0, so checking GND pins tells us nothing — we need to see
 * another component come along for the ride.
 *
 * If net resolution didn't run, we make a coarse geometric check:
 * does any non-GND pin sit at the exact coord of a GND pin?
 */
function detectGround(doc, nets) {
    // Probes don't count toward ground detection. A scope clipped
    // to ground doesn't actually wire the circuit to anything.
    const isProbe = (t) => t === 'VP' || t === 'IP' || t === 'SCOPE';
    if (nets && typeof nets.pinNode === 'function') {
        for (const comp of doc.components) {
            if (comp.elementType === 'GND') continue;
            if (isProbe(comp.elementType)) continue;
            for (const pin of componentPins(comp) || []) {
                if (nets.pinNode(comp, pin.id) === 0) return true;
            }
        }
        return false;
    }
    // Fallback: no nets, so peek at coordinates directly.
    const gndCoords = new Set();
    for (const comp of doc.components) {
        if (comp.elementType !== 'GND') continue;
        for (const pin of componentPins(comp) || []) {
            gndCoords.add(`${pin.x}|${pin.y}`);
        }
    }
    if (gndCoords.size === 0) return false;
    for (const comp of doc.components) {
        if (comp.elementType === 'GND') continue;
        if (isProbe(comp.elementType)) continue;
        for (const pin of componentPins(comp) || []) {
            if (gndCoords.has(`${pin.x}|${pin.y}`)) return true;
        }
    }
    return false;
}
