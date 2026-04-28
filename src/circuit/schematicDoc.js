/**
 * Interactive schematic document — the Phase-3 editing data model.
 *
 * The existing Phase-1/2 pipeline was *parse-then-layout*: take a
 * text netlist, parse it, then auto-place components. That's great
 * for demos but hostile to editing. Phase 3 flips the flow:
 *
 *     SchematicDoc  ──emit──▶  SPICE netlist  ──parse──▶  solver
 *           ▲
 *           └── interactive canvas (add / move / rotate / wire / edit)
 *
 * The doc is the *single source of truth*. Every UI action mutates
 * the doc; the netlist is an output view (editable in "raw mode" via
 * the import path, but that's a round-trip, not an alternative
 * editing surface).
 *
 * Geometry conventions
 * ---------------------
 *   - All coordinates are stored in **pixels** (same units SYMBOLS
 *     uses internally). The canvas draws at 1:1, pans/zooms in view
 *     transforms.
 *   - `GRID = 20` is the snap step: component placement snaps to
 *     multiples of GRID, and the wire tool snaps endpoints/bends to
 *     GRID. Pin coordinates within a symbol aren't required to be
 *     multiples of GRID (some BJT/MOS pins land at 14 px offsets),
 *     but the *component centre* is always grid-aligned so parallel
 *     same-type components stay perfectly collinear.
 *   - Wires are polylines of integer pixel vertices. They route only
 *     in axis-aligned segments (enforced by the canvas tool).
 *
 * Net resolution
 * ---------------
 * A *net* is the set of pins + wire endpoints that are electrically
 * connected. We resolve nets with a union-find over two kinds of
 * equivalence:
 *     (a) "same coordinate"  — any two vertices (pin or wire end)
 *         sharing (x,y) merge.
 *     (b) "same polyline"    — all vertices of one wire merge (the
 *         polyline acts as a single rubber band — even L-shaped
 *         wires connect their bends).
 *
 * Ground is a pseudo-component with a single pin at its origin whose
 * node is *always* id 0, no matter what else shares that coordinate.
 */

import { SYMBOLS, rotateXY, symbolForSchematic } from './symbols.js';
import { getPart, getContributedUserModelForName } from './library.js';

/**
 * Merge a parsed `.model` into `doc.userModels` if that name is not already present.
 * @param {object} doc
 * @param {{ name: string, type: string, params?: Record<string, number> }} rec
 */
export function ensureUserModel(doc, rec) {
    if (!doc || !rec?.name) return;
    const key = String(rec.name).toLowerCase();
    if (doc.userModels.some((u) => String(u.name).toLowerCase() === key)) return;
    doc.userModels.push({
        name: rec.name,
        type: String(rec.type || 'D').toUpperCase(),
        params: { ...(rec.params || {}) },
    });
}

export const GRID = 20;

/** Snap a pixel coordinate to the nearest grid cell. */
export function snap(px) { return Math.round(px / GRID) * GRID; }
/** Round to integer grid units (used when storing component pos). */
export function snapUnit(px) { return Math.round(px / GRID); }

/* ------------------------------------------------------------------ */
/* Doc factory + mutations                                            */
/* ------------------------------------------------------------------ */

export function emptyDoc() {
    return {
        components: [],
        wires: [],
        // Explicit net labels. Two labels sharing `name` merge their
        // coordinates into the same net, even if no wire physically
        // connects them. Names are case-insensitive; the reserved
        // names 'gnd' and '0' coerce a coord to node 0.
        //
        // We use labels during netlist import to guarantee correct
        // connectivity regardless of how wires happen to cross, and
        // users can place labels in the canvas for hierarchical /
        // bus-style designs (future work).
        labels: [],       // [{ id, x, y, name, visible }]
        directives: [],   // [{ id, kind, text, parsed }]
        userModels: [],   // [{ name, type, params }] — extra .model defs imported from user netlists
        meta: {
            nextUid: 1,
            refCounts: {},
            // When true, resolveNets() uses label-authoritative mode (imported
            // netlists: connectivity from pin-stamped labels; wires visual-only).
            // Hand-built circuits keep this false so Manhattan wires define nets.
            labelNetAuthority: false,
        },
    };
}

export function cloneDoc(doc) {
    return JSON.parse(JSON.stringify(doc));
}

function nextUid(doc) {
    const n = doc.meta.nextUid++;
    return `u${n}`;
}

function nextRef(doc, prefix) {
    doc.meta.refCounts[prefix] = (doc.meta.refCounts[prefix] || 0) + 1;
    return `${prefix}${doc.meta.refCounts[prefix]}`;
}

/* ------------------------------------------------------------------ */
/* Components                                                         */
/* ------------------------------------------------------------------ */

/**
 * Add a component at pixel position (px, py). The position is
 * snapped to the grid so pin coordinates stay deterministic. Returns
 * the full component record (mutates `doc`).
 *
 *   partId      — library part id ('R', 'Q_npn', 'V_sin', …)
 *   px, py      — pixel coords for the component centre (snapped)
 *   rotation    — 0 / 90 / 180 / 270 (default 0)
 */
export function addComponent(doc, partId, px, py, rotation = 0) {
    const part = getPart(partId);
    if (!part) throw new Error(`Unknown library part: ${partId}`);

    const comp = {
        id: nextUid(doc),
        partId,
        elementType: part.elementType,
        symbolKey: part.symbolKey,
        pos: { x: snap(px), y: snap(py) },
        rot: rotation,
        ref: part.refPrefix === '0' ? '0' : nextRef(doc, part.refPrefix),
        value: part.defaultValue,
        valueUnit: part.valueUnit,
        sourceSpec: part.sourceSpec ? JSON.parse(JSON.stringify(part.sourceSpec)) : null,
        modelRef: part.modelRef || null,
        autoGround: !!part.autoGround,
    };
    if (part.elementType === 'SCOPE') {
        comp.scopeChannelMode = part.scopeChannelMode === 'single' ? 'single' : 'dual';
    }
    if (part.contributesUserModel) {
        ensureUserModel(doc, part.contributesUserModel);
    }
    doc.components.push(comp);
    return comp;
}

/** Serializable slice of a component for copy/paste (no `id` / `ref`). */
export function componentToPastePayload(comp) {
    return {
        partId: comp.partId,
        pos: { x: comp.pos.x, y: comp.pos.y },
        rot: comp.rot ?? 0,
        value: comp.value,
        valueUnit: comp.valueUnit,
        sourceSpec: comp.sourceSpec ? JSON.parse(JSON.stringify(comp.sourceSpec)) : null,
        modelRef: comp.modelRef ?? null,
        autoGround: !!comp.autoGround,
        scopeChannelMode: comp.scopeChannelMode,
    };
}

/**
 * Insert clones from {@link componentToPastePayload} at `anchorWorldX/Y`
 * (snapped): the payload bbox min corner is aligned to that point.
 * @returns {Array<object>} the new component records pushed onto `doc`
 */
export function pasteComponentPayloads(doc, payloads, anchorWorldX, anchorWorldY) {
    if (!payloads?.length) return [];
    let minX = Infinity;
    let minY = Infinity;
    for (const p of payloads) {
        minX = Math.min(minX, p.pos.x);
        minY = Math.min(minY, p.pos.y);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return [];
    const tx = snap(anchorWorldX);
    const ty = snap(anchorWorldY);
    const dx = tx - minX;
    const dy = ty - minY;
    const out = [];
    for (const s of payloads) {
        const part = getPart(s.partId);
        if (!part) continue;
        const comp = {
            id: nextUid(doc),
            partId: s.partId,
            elementType: part.elementType,
            symbolKey: part.symbolKey,
            pos: { x: snap(s.pos.x + dx), y: snap(s.pos.y + dy) },
            rot: (((s.rot ?? 0) % 360) + 360) % 360,
            ref: part.refPrefix === '0' ? '0' : nextRef(doc, part.refPrefix),
            value: s.value != null ? s.value : part.defaultValue,
            valueUnit: s.valueUnit != null ? s.valueUnit : part.valueUnit,
            sourceSpec: s.sourceSpec != null
                ? JSON.parse(JSON.stringify(s.sourceSpec))
                : (part.sourceSpec ? JSON.parse(JSON.stringify(part.sourceSpec)) : null),
            modelRef: s.modelRef != null ? s.modelRef : (part.modelRef || null),
            autoGround: s.autoGround != null ? !!s.autoGround : !!part.autoGround,
        };
        if (part.elementType === 'SCOPE') {
            comp.scopeChannelMode = (s.scopeChannelMode === 'single' || part.scopeChannelMode === 'single')
                ? 'single'
                : 'dual';
        }
        if (part.contributesUserModel) {
            ensureUserModel(doc, part.contributesUserModel);
        }
        doc.components.push(comp);
        out.push(comp);
    }
    return out;
}

export function removeComponent(doc, compId) {
    const idx = doc.components.findIndex((c) => c.id === compId);
    if (idx < 0) return false;
    doc.components.splice(idx, 1);
    return true;
}

export function moveComponent(doc, compId, px, py) {
    const c = doc.components.find((c) => c.id === compId);
    if (!c) return false;
    c.pos = { x: snap(px), y: snap(py) };
    return true;
}

/**
 * Translate a component by (dx, dy) pixels. Deltas are snapped to the
 * grid, so the final position lands on a grid cell even if the mouse
 * moved by a non-grid amount. Any net labels anchored to one of the
 * component's pin coordinates are shifted in lock-step (unless another
 * component's pin sits on the same point — in that case we leave the
 * label behind so the other part keeps its connectivity).
 */
export function translateComponent(doc, compId, dx, dy) {
    const c = doc.components.find((c) => c.id === compId);
    if (!c) return false;
    const gdx = snap(dx);
    const gdy = snap(dy);
    if (gdx === 0 && gdy === 0) return false;

    // Capture old pin coords before mutating.
    const oldPins = componentPins(c);
    c.pos = { x: c.pos.x + gdx, y: c.pos.y + gdy };
    const newPins = componentPins(c);

    for (let i = 0; i < oldPins.length; i++) {
        const op = oldPins[i];
        const np = newPins[i];
        // Is another component still anchored at the old pin coord?
        let sharedElsewhere = false;
        for (const other of doc.components) {
            if (other.id === c.id) continue;
            for (const otherPin of componentPins(other)) {
                if (otherPin.x === op.x && otherPin.y === op.y) {
                    sharedElsewhere = true;
                    break;
                }
            }
            if (sharedElsewhere) break;
        }
        if (sharedElsewhere) continue;
        // Shift every label sitting exactly on the old pin coord.
        for (const lab of doc.labels) {
            if (lab.x === Math.round(op.x) && lab.y === Math.round(op.y)) {
                lab.x = Math.round(np.x);
                lab.y = Math.round(np.y);
            }
        }
    }
    return true;
}

export function rotateComponent(doc, compId, delta = 90) {
    const c = doc.components.find((c) => c.id === compId);
    if (!c) return false;
    c.rot = (((c.rot + delta) % 360) + 360) % 360;
    return true;
}

export function updateComponent(doc, compId, patch) {
    const c = doc.components.find((c) => c.id === compId);
    if (!c) return false;
    Object.assign(c, patch);
    if (patch.modelRef != null && ['D', 'Q', 'M'].includes(c.elementType)) {
        const rec = getContributedUserModelForName(c.modelRef);
        if (rec) ensureUserModel(doc, rec);
    }
    return true;
}

/* ------------------------------------------------------------------ */
/* Wires                                                              */
/* ------------------------------------------------------------------ */

/**
 * Add a wire from (x1,y1) to (x2,y2) as a manhattan polyline with
 * one corner. Coordinates are pixels (snapped by the caller).
 */
export function addWire(doc, x1, y1, x2, y2, bendFirst = 'H') {
    const points = manhattanPath(x1, y1, x2, y2, bendFirst);
    const wire = { id: nextUid(doc), points };
    doc.wires.push(wire);
    return wire;
}

/**
 * Attach a net label at (x,y). Two labels sharing a name merge.
 * Coords are *not* snapped: labels often attach to component pins,
 * which can live at non-grid offsets (e.g. BJT base at ±14 px).
 */
export function addLabel(doc, x, y, name, visible = false) {
    const label = {
        id: nextUid(doc),
        x: Math.round(x), y: Math.round(y),
        name: String(name),
        visible: !!visible,
    };
    doc.labels.push(label);
    return label;
}

export function addWirePath(doc, points) {
    if (!points || points.length < 2) return null;
    const wire = { id: nextUid(doc), points: points.map(([x, y]) => [x, y]) };
    doc.wires.push(wire);
    return wire;
}

export function removeWire(doc, wireId) {
    const idx = doc.wires.findIndex((w) => w.id === wireId);
    if (idx < 0) return false;
    doc.wires.splice(idx, 1);
    return true;
}

export function removeLabel(doc, labelId) {
    const idx = doc.labels.findIndex((l) => l.id === labelId);
    if (idx < 0) return false;
    doc.labels.splice(idx, 1);
    return true;
}

/**
 * Drop consecutive duplicate vertices, remove collinear Manhattan
 * middles (straightens A–B–C on one axis), insert bends on any
 * diagonal segments, then straighten again. Deletes wires with fewer
 * than two points. Helps junction-dot logic (geometric mode) by
 * collapsing stacked wire vertices; net labels are not “branches”.
 */
export function cleanupWireGeometry(doc) {
    if (!doc?.wires?.length) return { removedWires: 0, simplifiedWires: 0 };

    const dedupeConsecutive = (pts) => {
        const out = [];
        for (const p of pts) {
            const x = p[0];
            const y = p[1];
            if (!out.length || out[out.length - 1][0] !== x || out[out.length - 1][1] !== y) {
                out.push([x, y]);
            }
        }
        return out;
    };

    const removeCollinearOnce = (pts) => {
        if (pts.length < 3) return { pts, changed: false };
        const out = [pts[0]];
        let changed = false;
        for (let i = 1; i < pts.length - 1; i++) {
            const prev = out[out.length - 1];
            const cur = pts[i];
            const next = pts[i + 1];
            const allXSame = prev[0] === cur[0] && cur[0] === next[0];
            const allYSame = prev[1] === cur[1] && cur[1] === next[1];
            if (allXSame || allYSame) {
                changed = true;
                continue;
            }
            out.push(cur);
        }
        out.push(pts[pts.length - 1]);
        return { pts: out, changed };
    };

    const straighten = (pts) => {
        let p = dedupeConsecutive(pts);
        for (let g = 0; g < 32; g++) {
            const { pts: np, changed } = removeCollinearOnce(p);
            p = np;
            if (!changed) break;
        }
        return p;
    };

    let removedWires = 0;
    let simplifiedWires = 0;
    const next = [];
    for (const w of doc.wires) {
        const before = (w.points || []).length;
        const raw = (w.points || []).map((p) => [p[0], p[1]]);
        let pts = straighten(raw);
        if (pts.length >= 2) {
            rekinkManhattan(pts);
            pts = straighten(pts);
        }
        if (pts.length < 2) {
            removedWires++;
            continue;
        }
        const changed =
            pts.length !== before
            || pts.some((p, i) => p[0] !== (w.points[i]?.[0]) || p[1] !== (w.points[i]?.[1]));
        if (changed) simplifiedWires++;
        next.push({ ...w, points: pts });
    }
    doc.wires = next;
    return { removedWires, simplifiedWires };
}

/**
 * Translate a whole wire polyline by (dx, dy). Deltas snap to the grid
 * so every vertex stays on a grid cell. Returns true if the wire moved.
 */
export function translateWire(doc, wireId, dx, dy) {
    const w = doc.wires.find((w) => w.id === wireId);
    if (!w) return false;
    const gdx = snap(dx);
    const gdy = snap(dy);
    if (gdx === 0 && gdy === 0) return false;
    w.points = w.points.map(([x, y]) => [x + gdx, y + gdy]);
    return true;
}

/* ------------------------------------------------------------------ */
/* Rubber-band translate                                              */
/*                                                                    */
/* "Pro-sim" localized drag: moving a component shifts ONLY that      */
/* component plus whichever wire vertices were sitting on its pins    */
/* (stretching wires to follow). Moving a wire shifts just that one   */
/* wire, but any endpoint that was anchored to a component pin stays  */
/* locked to that pin and a bend is inserted so the polyline stays    */
/* manhattan. Nothing else in the schematic moves — no whole-circuit  */
/* rubber-banding, which is what most users actually expect.          */
/* ------------------------------------------------------------------ */

/**
 * Move a component and "rubber-band" any wire endpoints / mid-segment
 * T-junctions that were electrically attached to its pins, so the
 * wires follow the component instead of detaching.
 *
 * Strategy:
 *   1. Record each pin's old coord before mutating.
 *   2. Shift the component position.
 *   3. For every wire, remap any vertex that coincided with an old
 *      pin coord to the matching new pin coord (per-pin pairing).
 *   4. If a wire segment passed *through* a pin at a mid-segment
 *      coord, splice the new pin coord into that segment so the wire
 *      still hits the pin after the move.
 *   5. Collapse consecutive duplicate vertices, then re-manhattan any
 *      non-axis-aligned segments the move introduced by inserting
 *      one extra bend per offending segment.
 *
 * Returns true if anything moved.
 */
export function translateComponentRubber(doc, compId, dx, dy) {
    const c = doc.components.find((c) => c.id === compId);
    if (!c) return false;
    const gdx = snap(dx);
    const gdy = snap(dy);
    if (gdx === 0 && gdy === 0) return false;

    const oldPins = componentPins(c);
    // Map old-pin-coord → new-pin-coord, one entry per pin. We pair
    // by pin index instead of by coord so rotationally-symmetric
    // parts (two pins mirrored across the centre) still get the
    // right mapping when they translate.
    const oldNewByIndex = oldPins.map((op) => ({
        old: [op.x, op.y],
        new: [op.x + gdx, op.y + gdy],
    }));
    const oldCoordKeys = new Set(oldPins.map((op) => `${op.x}|${op.y}`));

    // --- 1. Shift the component itself.
    c.pos = { x: c.pos.x + gdx, y: c.pos.y + gdy };

    // --- 2. Label book-keeping (identical rule to translateComponent).
    for (let i = 0; i < oldPins.length; i++) {
        const op = oldPins[i];
        const np = { x: op.x + gdx, y: op.y + gdy };
        let sharedElsewhere = false;
        for (const other of doc.components) {
            if (other.id === c.id) continue;
            for (const otherPin of componentPins(other)) {
                if (otherPin.x === op.x && otherPin.y === op.y) {
                    sharedElsewhere = true;
                    break;
                }
            }
            if (sharedElsewhere) break;
        }
        if (sharedElsewhere) continue;
        for (const lab of doc.labels) {
            if (lab.x === Math.round(op.x) && lab.y === Math.round(op.y)) {
                lab.x = Math.round(np.x);
                lab.y = Math.round(np.y);
            }
        }
    }

    // --- 3. Rubber-band wire vertices at each pin.
    const lookupNew = (x, y) => {
        for (const p of oldNewByIndex) {
            if (p.old[0] === x && p.old[1] === y) return p.new;
        }
        return null;
    };

    for (const wire of doc.wires) {
        const pts = wire.points;
        // (a) Remap vertices at old pin coords.
        for (let i = 0; i < pts.length; i++) {
            const np = lookupNew(pts[i][0], pts[i][1]);
            if (np) pts[i] = [np[0], np[1]];
        }
        // (b) Mid-segment T-junctions: an old pin coord sitting
        //     strictly inside an axis-aligned segment gets spliced
        //     into the polyline so the "wire passes through pin"
        //     connection still holds after the component moves.
        for (let s = pts.length - 1; s >= 1; s--) {
            const [x1, y1] = pts[s - 1];
            const [x2, y2] = pts[s];
            const horiz = y1 === y2;
            const vert  = x1 === x2;
            if (!horiz && !vert) continue;
            // Skip segments we already remapped — the endpoints would
            // have matched an old pin coord and been moved above.
            for (const op of oldPins) {
                const onSeg = (horiz && op.y === y1 && op.x > Math.min(x1, x2) && op.x < Math.max(x1, x2))
                           || (vert  && op.x === x1 && op.y > Math.min(y1, y2) && op.y < Math.max(y1, y2));
                if (!onSeg) continue;
                if (!oldCoordKeys.has(`${op.x}|${op.y}`)) continue;
                const np = lookupNew(op.x, op.y);
                if (!np) continue;
                // Splice the new coord into this segment so the wire
                // still hits the pin after the move. If the result
                // creates a diagonal jump we'll fix it in step (d).
                pts.splice(s, 0, [np[0], np[1]]);
            }
        }
        // (c) Drop consecutive duplicate vertices introduced by the
        //     remap (e.g. two pins that landed on the same coord).
        dedupePoints(pts);
        // (d) Re-manhattan: insert a bend between any two neighbours
        //     that aren't axis-aligned.
        rekinkManhattan(pts);
        wire.points = pts;
    }
    return true;
}

/**
 * Move a wire by (dx, dy) while keeping any endpoint that was
 * anchored to a component pin locked at that pin. A bend is inserted
 * next to each anchored endpoint so the polyline stays manhattan.
 *
 * Only this one wire moves — the rest of the schematic is untouched.
 * Returns true if the wire changed.
 */
export function translateWireRubber(doc, wireId, dx, dy) {
    const w = doc.wires.find((w) => w.id === wireId);
    if (!w) return false;
    const gdx = snap(dx);
    const gdy = snap(dy);
    if (gdx === 0 && gdy === 0) return false;

    // Pin-coord index across the whole doc.
    const pinCoords = new Set();
    for (const c of doc.components) {
        for (const p of componentPins(c)) pinCoords.add(`${p.x}|${p.y}`);
    }

    const pts = w.points.map(([x, y]) => [x, y]);
    const n = pts.length;
    const firstAnchored = pinCoords.has(`${pts[0][0]}|${pts[0][1]}`);
    const lastAnchored  = pinCoords.has(`${pts[n - 1][0]}|${pts[n - 1][1]}`);

    // Shift every interior vertex by (gdx, gdy). Endpoint handling
    // depends on whether they're anchored.
    const shifted = pts.map(([x, y]) => [x + gdx, y + gdy]);
    if (firstAnchored) shifted[0] = pts[0];
    if (lastAnchored)  shifted[n - 1] = pts[n - 1];

    // If only one endpoint is anchored and the drag is axis-aligned,
    // the wire would already look fine. Otherwise, splice a bend in
    // next to each anchored endpoint to keep the polyline manhattan.
    if (firstAnchored) {
        const [ax, ay] = shifted[0];
        const [bx, by] = shifted[1];
        if (ax !== bx && ay !== by) {
            // Insert corner (bx, ay) so first segment is horizontal
            // then the next is vertical (or vice-versa; either works).
            shifted.splice(1, 0, [bx, ay]);
        }
    }
    if (lastAnchored) {
        const m = shifted.length;
        const [px, py] = shifted[m - 2];
        const [qx, qy] = shifted[m - 1];
        if (px !== qx && py !== qy) {
            shifted.splice(m - 1, 0, [px, qy]);
        }
    }

    dedupePoints(shifted);
    rekinkManhattan(shifted);
    w.points = shifted;
    return true;
}

/** In-place: drop consecutive duplicate vertices. */
function dedupePoints(pts) {
    for (let i = pts.length - 1; i >= 1; i--) {
        if (pts[i][0] === pts[i - 1][0] && pts[i][1] === pts[i - 1][1]) {
            pts.splice(i, 1);
        }
    }
}

/** In-place: ensure every segment is axis-aligned by inserting one
 *  bend per offending pair. Bend choice favours horizontal-first for
 *  symmetry with the wire tool's default routing. */
function rekinkManhattan(pts) {
    for (let i = pts.length - 1; i >= 1; i--) {
        const [x1, y1] = pts[i - 1];
        const [x2, y2] = pts[i];
        if (x1 === x2 || y1 === y2) continue;
        pts.splice(i, 0, [x2, y1]);
    }
}

/* ------------------------------------------------------------------ */
/* Group drag (OrCAD / KiCad style rubber-band)                       */
/* ------------------------------------------------------------------ */

/**
 * Find every element electrically connected to `seed` so the caller
 * can move them as one rigid block. This preserves connectivity when
 * the user drags anything that's already wired into a network — the
 * behaviour people expect from OrCAD / Altium / KiCad.
 *
 * Connectivity is derived geometrically (and by label-name), so the
 * result stays correct regardless of whether the doc came from an
 * imported netlist or was drawn from scratch:
 *
 *   • Two elements at the same pixel coord are in the same group.
 *   • A wire's vertices are all in the same group (rubber band).
 *   • A pin mid-segment on a wire joins that wire's group.
 *   • Labels with the same name are in the same group.
 *
 * Returns `{ componentIds, wireIds, labelIds }` as Sets. The seed
 * element is always included. GND symbols are excluded unless the
 * seed itself is a GND — dragging a wire shouldn't uproot the ground
 * symbol from the whole schematic.
 *
 *   seed = { kind: 'component' | 'wire' | 'label', id: string }
 */
export function findConnectedGroup(doc, seed) {
    const componentIds = new Set();
    const wireIds = new Set();
    const labelIds = new Set();
    if (!seed) return { componentIds, wireIds, labelIds };

    // --- 1. Build a union-find over every "vertex" in the schematic.
    // Each vertex records where it came from so we can walk back from
    // the union-find roots to component / wire / label IDs.
    const vertices = [];
    for (const comp of doc.components) {
        for (const pin of componentPins(comp)) {
            vertices.push({ kind: 'pin', x: pin.x, y: pin.y, compId: comp.id });
        }
    }
    for (const wire of doc.wires) {
        for (const [x, y] of wire.points) {
            vertices.push({ kind: 'wire', x, y, wireId: wire.id });
        }
    }
    for (const lab of doc.labels) {
        vertices.push({ kind: 'label', x: lab.x, y: lab.y, labelId: lab.id, name: lab.name });
    }

    const p = ufMake(vertices.length);

    // Coord-share: any two vertices at the same (x, y) are connected.
    const byCoord = new Map();
    for (let i = 0; i < vertices.length; i++) {
        const k = coordKey(vertices[i].x, vertices[i].y);
        if (byCoord.has(k)) ufUnion(p, i, byCoord.get(k));
        else byCoord.set(k, i);
    }

    // Wire polylines: all vertices of the same wire share a net.
    const firstIdxByWire = new Map();
    for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        if (v.kind !== 'wire') continue;
        if (!firstIdxByWire.has(v.wireId)) { firstIdxByWire.set(v.wireId, i); continue; }
        ufUnion(p, i, firstIdxByWire.get(v.wireId));
    }

    // Pins crossed by a wire mid-segment count as T-junction connections.
    for (const wire of doc.wires) {
        const pts = wire.points;
        for (let s = 1; s < pts.length; s++) {
            const [x1, y1] = pts[s - 1];
            const [x2, y2] = pts[s];
            const horizontal = y1 === y2;
            const vertical = x1 === x2;
            if (!horizontal && !vertical) continue;
            for (let i = 0; i < vertices.length; i++) {
                const v = vertices[i];
                if (v.kind !== 'pin') continue;
                const onSeg = (horizontal && v.y === y1 && v.x > Math.min(x1, x2) && v.x < Math.max(x1, x2))
                           || (vertical && v.x === x1 && v.y > Math.min(y1, y2) && v.y < Math.max(y1, y2));
                if (!onSeg) continue;
                const wireIdx = firstIdxByWire.get(wire.id);
                if (wireIdx != null) ufUnion(p, i, wireIdx);
            }
        }
    }

    // Labels with identical names merge (authoritative in imported docs).
    const nameToRep = new Map();
    for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        if (v.kind !== 'label') continue;
        if (nameToRep.has(v.name)) ufUnion(p, i, nameToRep.get(v.name));
        else nameToRep.set(v.name, i);
    }

    // --- 2. Locate the seed vertices and find their union root.
    const seedRoots = new Set();
    for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        if (seed.kind === 'component' && v.kind === 'pin' && v.compId === seed.id) seedRoots.add(ufFind(p, i));
        else if (seed.kind === 'wire' && v.kind === 'wire' && v.wireId === seed.id) seedRoots.add(ufFind(p, i));
        else if (seed.kind === 'label' && v.kind === 'label' && v.labelId === seed.id) seedRoots.add(ufFind(p, i));
    }
    // Pin-less seed (e.g. GND symbol with a single "pin" that lives at
    // the component centre): fall back to explicit containment.
    if (seed.kind === 'component' && seedRoots.size === 0) componentIds.add(seed.id);
    if (seed.kind === 'wire' && seedRoots.size === 0) wireIds.add(seed.id);
    if (seed.kind === 'label' && seedRoots.size === 0) labelIds.add(seed.id);

    // --- 2b. Transitive closure across components.
    // Union-find only connects things that share a coordinate, so
    // seedRoots so far covers exactly the *net* the seed sits on.
    // But the user is dragging a circuit, not a net: dragging R
    // should bring along the capacitor and source wired into R, and
    // everything wired into those in turn. We treat each non-GND
    // component as a "bridge" that, once its pins are in the group,
    // pulls its remaining pins (and their nets) into the group too.
    // GND is excluded from bridging so ground stays anchored.
    const pinVerticesByComp = new Map();
    for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        if (v.kind !== 'pin') continue;
        if (!pinVerticesByComp.has(v.compId)) pinVerticesByComp.set(v.compId, []);
        pinVerticesByComp.get(v.compId).push(i);
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const comp of doc.components) {
            if (comp.elementType === 'GND') continue;
            const indices = pinVerticesByComp.get(comp.id);
            if (!indices || indices.length === 0) continue;
            const roots = indices.map((i) => ufFind(p, i));
            const anyIn = roots.some((r) => seedRoots.has(r));
            if (!anyIn) continue;
            for (const r of roots) {
                if (!seedRoots.has(r)) { seedRoots.add(r); changed = true; }
            }
        }
    }

    // --- 3. Collect every element whose vertices share a seed root.
    for (let i = 0; i < vertices.length; i++) {
        if (!seedRoots.has(ufFind(p, i))) continue;
        const v = vertices[i];
        if (v.kind === 'pin') componentIds.add(v.compId);
        else if (v.kind === 'wire') wireIds.add(v.wireId);
        else if (v.kind === 'label') labelIds.add(v.labelId);
    }

    // GND symbols that are electrically part of the dragged circuit
    // come along automatically (their pin coord is in seedRoots via the
    // phase-1 coord-share). GNDs in unrelated sub-circuits never union
    // with us, so they stay put. We deliberately don't treat GND as a
    // bridge during the transitive closure (Phase 2b) so that a huge
    // schematic sharing ground across many sub-circuits doesn't collapse
    // into one giant drag group.

    return { componentIds, wireIds, labelIds };
}

/**
 * Translate every element in `group` (result of findConnectedGroup)
 * by (dx, dy). Deltas are snapped to the grid so the final positions
 * land on grid cells. Returns `true` if anything moved.
 *
 * We translate components, wires, and labels **directly** (bypassing
 * translateComponent's per-part label book-keeping) because we've
 * already decided every group member moves in lock-step; the ordinary
 * "leave the label behind if another pin shares the coord" rule
 * doesn't apply when both pins are in the group.
 */
export function translateGroup(doc, group, dx, dy) {
    const gdx = snap(dx);
    const gdy = snap(dy);
    if (gdx === 0 && gdy === 0) return false;
    if (!group) return false;

    const compIds = group.componentIds || new Set();
    const wireIds = group.wireIds || new Set();
    const labelIds = group.labelIds || new Set();

    for (const comp of doc.components) {
        if (!compIds.has(comp.id)) continue;
        comp.pos = { x: comp.pos.x + gdx, y: comp.pos.y + gdy };
    }
    for (const wire of doc.wires) {
        if (!wireIds.has(wire.id)) continue;
        wire.points = wire.points.map(([x, y]) => [x + gdx, y + gdy]);
    }
    for (const lab of doc.labels) {
        if (!labelIds.has(lab.id)) continue;
        lab.x += gdx;
        lab.y += gdy;
    }
    return true;
}

/** Two-segment manhattan route: horizontal-then-vertical by default. */
export function manhattanPath(x1, y1, x2, y2, bendFirst = 'H') {
    if (x1 === x2 || y1 === y2) return [[x1, y1], [x2, y2]];
    return bendFirst === 'H'
        ? [[x1, y1], [x2, y1], [x2, y2]]
        : [[x1, y1], [x1, y2], [x2, y2]];
}

/* ------------------------------------------------------------------ */
/* Pin projection                                                     */
/* ------------------------------------------------------------------ */

/**
 * Yields every pin of `comp` projected into world pixel coords:
 *   [{ id: pinId, x: px, y: py, side: 'L'|'R'|'T'|'B' }]
 */
export function componentPins(comp) {
    if (comp.elementType === 'GND') {
        return [{ id: 'gnd', x: comp.pos.x, y: comp.pos.y, side: 'T' }];
    }
    const sym = symbolForSchematic(comp) || SYMBOLS[comp.symbolKey] || SYMBOLS[comp.elementType];
    if (!sym) return [];
    const out = [];
    for (const p of sym.pins) {
        const r = rotateXY(p.x, p.y, comp.rot);
        out.push({ id: p.id, x: comp.pos.x + r.x, y: comp.pos.y + r.y, side: p.side });
    }
    // VCC rail only exposes the top pin; the bottom pin is implicit GND.
    if (comp.autoGround && out.length >= 2) {
        return out.slice(0, 1);
    }
    return out;
}

/* ------------------------------------------------------------------ */
/* Net resolution (union-find over pin coords + wire vertices)        */
/* ------------------------------------------------------------------ */

function ufMake(n) {
    const parent = new Array(n); for (let i = 0; i < n; i++) parent[i] = i;
    return parent;
}
function ufFind(p, a) { while (p[a] !== a) { p[a] = p[p[a]]; a = p[a]; } return a; }
function ufUnion(p, a, b) { const ra = ufFind(p, a); const rb = ufFind(p, b); if (ra !== rb) p[ra] = rb; }

function coordKey(x, y) { return `${x}|${y}`; }

/**
 * Resolve nets. Returns:
 *   {
 *     nodeIdAt(x, y)               → integer node id (0 = GND)
 *     pinNode(comp, pinId)         → integer node id
 *     nodeCount                    → total number of nets (excl. GND sentinel)
 *     nodeLabels                   → Map<nodeId, string>   (auto or user-chosen)
 *     junctions                    → [{ x, y }]  where ≥3 wires/pins meet
 *     floatingPins                 → [{ comp, pinId }] not connected to any wire or shared coord
 *   }
 */
export function resolveNets(doc) {
    // Resolution strategy is chosen based on whether the doc has any
    // labels:
    //
    //   (a) "Label-authoritative" mode  — used when at least one
    //       component pin sits on a label. Every pin that has a
    //       co-located label inherits that label's net. Wires are
    //       treated as visual-only; they don't contribute to net
    //       identity. This is what imported netlists rely on: each
    //       pin is tagged with its ground-truth node name at import
    //       time, so we don't need geometry to derive connectivity.
    //
    //   (b) "Geometric" mode — used for fully user-drawn docs with
    //       no labels. Pins at the same coord are unioned; wire
    //       polylines are rubber-bands; segment-through-pin counts
    //       as a T-junction. Straightforward SPICE-style wire
    //       connectivity.
    //
    // Interactive edits add many `doc.labels` (wire tool stamps names at
    // endpoints) — those must NOT flip the whole doc into label-only mode
    // or wires stop conducting and parts look "floating" after small moves.
    // Only netlist imports set meta.labelNetAuthority = true.
    if (doc.meta?.labelNetAuthority === true) {
        return resolveNetsLabelMode(doc);
    }
    return resolveNetsGeometricMode(doc);
}

/* ------------------------- label-authoritative ------------------- */

function resolveNetsLabelMode(doc) {
    // 1) Index labels by coord and by name.
    const labelsAtCoord = new Map(); // coordKey → Set<name>
    for (const lab of doc.labels) {
        const nm = String(lab.name).toLowerCase();
        const k = coordKey(lab.x, lab.y);
        if (!labelsAtCoord.has(k)) labelsAtCoord.set(k, new Set());
        labelsAtCoord.get(k).add(nm);
    }

    // 2) Union-find over unique label NAMES.
    const nameList = [];
    const nameIdx = new Map();
    function registerName(nm) {
        if (nameIdx.has(nm)) return nameIdx.get(nm);
        const i = nameList.length;
        nameList.push(nm); nameIdx.set(nm, i);
        return i;
    }
    for (const nm of labelsAtCoord.values()) for (const n of nm) registerName(n);

    const parent = ufMake(nameList.length);

    // If two names share the same coordinate, they're the same net.
    for (const nameSet of labelsAtCoord.values()) {
        const names = [...nameSet];
        for (let i = 1; i < names.length; i++) {
            ufUnion(parent, nameIdx.get(names[0]), nameIdx.get(names[i]));
        }
    }
    // Ground pins drag their co-located name into the ground class.
    for (const comp of doc.components) {
        if (comp.elementType !== 'GND') continue;
        const k = coordKey(comp.pos.x, comp.pos.y);
        const names = labelsAtCoord.get(k);
        if (!names) continue;
        for (const n of names) {
            ufUnion(parent, nameIdx.get(n), registerName('gnd'));
        }
    }

    // 3) Assign node ids: root with 'gnd' gets 0.
    const rootToNode = new Map();
    let nextId = 1;
    if (nameIdx.has('gnd')) rootToNode.set(ufFind(parent, nameIdx.get('gnd')), 0);
    if (nameIdx.has('0'))   rootToNode.set(ufFind(parent, nameIdx.get('0')), 0);
    for (let i = 0; i < nameList.length; i++) {
        const r = ufFind(parent, i);
        if (!rootToNode.has(r)) rootToNode.set(r, nextId++);
    }

    function nodeIdAt(x, y) {
        const names = labelsAtCoord.get(coordKey(x, y));
        if (!names) return null;
        const first = names.values().next().value;
        const i = nameIdx.get(first);
        if (i == null) return null;
        return rootToNode.get(ufFind(parent, i));
    }

    const pinNodeMap = new Map();
    const floatingPins = [];
    for (const comp of doc.components) {
        if (comp.elementType === 'GND') continue;
        for (const pin of componentPins(comp)) {
            const k = coordKey(pin.x, pin.y);
            const names = labelsAtCoord.get(k);
            if (!names) { floatingPins.push({ comp, pinId: pin.id }); continue; }
            const i = nameIdx.get([...names][0]);
            pinNodeMap.set(`${comp.id}|${pin.id}`, rootToNode.get(ufFind(parent, i)));
        }
    }
    function pinNode(comp, pinId) { return pinNodeMap.get(`${comp.id}|${pinId}`); }

    // Node labels — pick the first non-auto name per net.
    const nodeLabels = new Map();
    for (const [, nid] of rootToNode) nodeLabels.set(nid, nid === 0 ? 'gnd' : `n${nid}`);
    for (let i = 0; i < nameList.length; i++) {
        const nid = rootToNode.get(ufFind(parent, i));
        const nm = nameList[i];
        if (nid == null || nid === 0) continue;
        // Prefer user-supplied names over auto 'n<id>'.
        if (!/^n\d+$/.test(nm)) nodeLabels.set(nid, nm);
    }

    // Junctions: ≥3 distinct “branches” (pin vs net name). Count each
    // net label name once per coord so pin + duplicate labels are not 3×.
    const junctionSets = new Map();
    function jAdd(k, id) {
        if (!junctionSets.has(k)) junctionSets.set(k, new Set());
        junctionSets.get(k).add(id);
    }
    for (const lab of doc.labels) {
        const k = coordKey(lab.x, lab.y);
        jAdd(k, `n:${String(lab.name).toLowerCase()}`);
    }
    for (const comp of doc.components) {
        for (const pin of componentPins(comp)) {
            const k = coordKey(pin.x, pin.y);
            jAdd(k, `p:${comp.id}:${pin.id}`);
        }
    }
    const junctions = [];
    for (const [k, set] of junctionSets) {
        if (set.size >= 3) {
            const [x, y] = k.split('|').map(Number);
            junctions.push({ x, y });
        }
    }

    return {
        nodeIdAt,
        pinNode,
        nodeCount: nextId,
        nodeLabels,
        junctions,
        floatingPins,
    };
}

/* ----------------------------- geometric ------------------------- */

function resolveNetsGeometricMode(doc) {
    const vertices = [];
    function addVertex(v) { vertices.push(v); return vertices.length - 1; }

    for (const comp of doc.components) {
        for (const pin of componentPins(comp)) {
            addVertex({
                kind: 'pin',
                x: pin.x, y: pin.y,
                comp, pinId: pin.id,
                isGround: comp.elementType === 'GND',
            });
        }
    }
    for (const wire of doc.wires) {
        for (const [x, y] of wire.points) {
            addVertex({ kind: 'wire', x, y, wireId: wire.id });
        }
    }
    for (const lab of doc.labels || []) {
        addVertex({
            kind: 'label',
            x: lab.x,
            y: lab.y,
            labelId: lab.id,
            name: String(lab.name),
        });
    }

    const p = ufMake(vertices.length);

    // ---- Phase 1: pre-compute label coverage ---------------------
    // Which coordinates host a label? We need this so wire-mediated
    // unions don't cross label boundaries (e.g. two crossing auto-
    // routed wires shouldn't collapse unrelated nets just because
    // they share a grid cell mid-path).
    const labelsByCoord = new Map(); // coordKey → Set<name>
    for (const lab of doc.labels || []) {
        const k = coordKey(lab.x, lab.y);
        const nm = String(lab.name).toLowerCase();
        if (!labelsByCoord.has(k)) labelsByCoord.set(k, new Set());
        labelsByCoord.get(k).add(nm);
    }
    function labelsAt(x, y) { return labelsByCoord.get(coordKey(x, y)); }
    function coordsCompatible(aKey, bKey) {
        // Two coords can union via geometry if neither side forces a
        // different label name. If both have labels, they must share
        // at least one name.
        const la = labelsByCoord.get(aKey);
        const lb = labelsByCoord.get(bKey);
        if (!la || !lb) return true;
        for (const n of la) if (lb.has(n)) return true;
        return false;
    }

    // ---- Phase 2: coord-share unions ----------------------------
    // Any two vertices at the same (x,y) merge (modulo label guard).
    const byCoord = new Map();
    for (let i = 0; i < vertices.length; i++) {
        const k = coordKey(vertices[i].x, vertices[i].y);
        if (byCoord.has(k)) ufUnion(p, i, byCoord.get(k));
        else byCoord.set(k, i);
    }

    // ---- Phase 3: wire polyline unions --------------------------
    // Each wire is a single rubber band ONLY IF its endpoints don't
    // cross label boundaries. Otherwise we keep its individual vertex
    // unions (from coord-share above) but don't force the whole
    // polyline into one net.
    for (const wire of doc.wires) {
        let baseIdx = null;
        let baseKey = null;
        let conflict = false;
        for (let i = 0; i < vertices.length; i++) {
            const v = vertices[i];
            if (v.kind !== 'wire' || v.wireId !== wire.id) continue;
            const k = coordKey(v.x, v.y);
            if (baseIdx == null) { baseIdx = i; baseKey = k; continue; }
            if (!coordsCompatible(baseKey, k)) { conflict = true; break; }
        }
        if (conflict) continue;
        for (let i = 0; i < vertices.length; i++) {
            const v = vertices[i];
            if (v.kind !== 'wire' || v.wireId !== wire.id) continue;
            if (i !== baseIdx) ufUnion(p, i, baseIdx);
        }
    }

    // ---- Phase 4: "wire passes through a pin" T-junctions -------
    // A segment passing through a pin without stopping is treated
    // as connected. Same label guard applies: skip if merging would
    // bridge two distinct net labels.
    const pinCoords = vertices.filter((v) => v.kind === 'pin');
    for (const wire of doc.wires) {
        const pts = wire.points;
        for (let s = 1; s < pts.length; s++) {
            const [x1, y1] = pts[s - 1];
            const [x2, y2] = pts[s];
            const horizontal = y1 === y2;
            const vertical = x1 === x2;
            if (!horizontal && !vertical) continue;
            for (const pin of pinCoords) {
                const onSeg = (horizontal && pin.y === y1 && pin.x > Math.min(x1, x2) && pin.x < Math.max(x1, x2))
                           || (vertical && pin.x === x1 && pin.y > Math.min(y1, y2) && pin.y < Math.max(y1, y2));
                if (!onSeg) continue;
                // Find any wire vertex we could tie to.
                let wireIdx = -1;
                for (let k = 0; k < vertices.length; k++) {
                    if (vertices[k].kind === 'wire' && vertices[k].wireId === wire.id) { wireIdx = k; break; }
                }
                const pinIdx = vertices.indexOf(pin);
                if (wireIdx < 0 || pinIdx < 0) continue;
                const kPin = coordKey(pin.x, pin.y);
                const kWire = coordKey(vertices[wireIdx].x, vertices[wireIdx].y);
                if (coordsCompatible(kPin, kWire)) ufUnion(p, wireIdx, pinIdx);
            }
        }
    }

    // ---- Phase 5: labels with the same name are the same net ---
    // This is the authoritative rule for imported docs: regardless of
    // how wires are drawn, labels define connectivity.
    const nameToRep = new Map();
    for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        if (v.kind !== 'label') continue;
        if (nameToRep.has(v.name)) ufUnion(p, i, nameToRep.get(v.name));
        else nameToRep.set(v.name, i);
    }

    // ---- Phase 6: ground -----------------------------------------
    let groundRoot = null;
    for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        const isGnd = v.isGround || (v.kind === 'label' && (v.name === 'gnd' || v.name === '0'));
        if (isGnd) {
            if (groundRoot == null) groundRoot = ufFind(p, i);
            else ufUnion(p, i, groundRoot);
        }
    }

    const rootToNode = new Map();
    let nextId = 1;
    if (groundRoot != null) rootToNode.set(ufFind(p, groundRoot), 0);
    for (let i = 0; i < vertices.length; i++) {
        const r = ufFind(p, i);
        if (!rootToNode.has(r)) rootToNode.set(r, nextId++);
    }

    // 5) Build lookups.
    const coordToRoot = new Map();
    for (let i = 0; i < vertices.length; i++) {
        const k = coordKey(vertices[i].x, vertices[i].y);
        coordToRoot.set(k, ufFind(p, i));
    }
    function nodeIdAt(x, y) {
        const r = coordToRoot.get(coordKey(x, y));
        return r != null ? rootToNode.get(r) : null;
    }

    const pinNodeMap = new Map(); // "compId|pinId" → node id
    for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        if (v.kind === 'pin') {
            pinNodeMap.set(`${v.comp.id}|${v.pinId}`, rootToNode.get(ufFind(p, i)));
        }
    }
    function pinNode(comp, pinId) {
        return pinNodeMap.get(`${comp.id}|${pinId}`);
    }

    // Node labels: prefer any user-visible label attached to the net,
    // otherwise auto-name. Ground is always 'gnd' for SPICE output.
    const nodeLabels = new Map();
    for (const [, id] of rootToNode) {
        nodeLabels.set(id, id === 0 ? 'gnd' : `n${id}`);
    }
    for (const v of vertices) {
        if (v.kind !== 'label') continue;
        const r = ufFind(p, vertices.indexOf(v));
        const id = rootToNode.get(r);
        if (id === 0 || id == null) continue;
        nodeLabels.set(id, v.name);
    }

    // 7) Junction dots: ≥3 distinct branches (pins + wire bodies).
    // Labels name nets but are not extra branches — avoids a false dot
    // at every pin that also has a wire-tool label.
    const junctionSets = new Map();
    function gjAdd(k, id) {
        if (!junctionSets.has(k)) junctionSets.set(k, new Set());
        junctionSets.get(k).add(id);
    }
    for (const v of vertices) {
        const k = coordKey(v.x, v.y);
        if (v.kind === 'pin') gjAdd(k, `p:${v.comp.id}:${v.pinId}`);
        else if (v.kind === 'wire') gjAdd(k, `w:${v.wireId}`);
    }
    const junctions = [];
    for (const [k, set] of junctionSets) {
        if (set.size >= 3) {
            const [x, y] = k.split('|').map(Number);
            junctions.push({ x, y });
        }
    }

    // 8) Floating pins (not connected to anything else at their coord
    //    and not through a wire).
    const floatingPins = [];
    for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        if (v.kind !== 'pin') continue;
        let shared = false;
        for (let j = 0; j < vertices.length; j++) {
            if (i === j) continue;
            if (ufFind(p, i) === ufFind(p, j)) { shared = true; break; }
        }
        if (!shared) floatingPins.push({ comp: v.comp, pinId: v.pinId });
    }

    return {
        nodeIdAt,
        pinNode,
        nodeCount: nextId,
        nodeLabels,
        junctions,
        floatingPins,
    };
}
