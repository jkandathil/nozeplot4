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

import { SYMBOLS, rotateXY } from './symbols.js';
import { getPart } from './library.js';

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
        wires: [],
        directives: [],   // [{ id, kind, text, parsed }]
        userModels: [],   // [{ name, type, params }] — extra .model defs imported from user netlists
        meta: {
            nextUid: 1,
            refCounts: {},
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
    doc.components.push(comp);
    return comp;
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
    const sym = SYMBOLS[comp.symbolKey] || SYMBOLS[comp.elementType];
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
    // Most interesting docs live in mode (a): imports carry labels,
    // and when the user drops a new component the canvas stamps a
    // fresh label wherever the new pin ties into an existing net.
    const hasLabels = Array.isArray(doc.labels) && doc.labels.length > 0;
    return hasLabels ? resolveNetsLabelMode(doc) : resolveNetsGeometricMode(doc);
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

    // Junctions: any coord where ≥3 label/pin vertices coincide.
    const incidence = new Map();
    for (const lab of doc.labels) {
        const k = coordKey(lab.x, lab.y);
        incidence.set(k, (incidence.get(k) || 0) + 1);
    }
    for (const comp of doc.components) {
        for (const pin of componentPins(comp)) {
            const k = coordKey(pin.x, pin.y);
            incidence.set(k, (incidence.get(k) || 0) + 1);
        }
    }
    const junctions = [];
    for (const [k, n] of incidence) {
        if (n >= 3) {
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

    const p = ufMake(vertices.length);

    // ---- Phase 1: pre-compute label coverage ---------------------
    // Which coordinates host a label? We need this so wire-mediated
    // unions don't cross label boundaries (e.g. two crossing auto-
    // routed wires shouldn't collapse unrelated nets just because
    // they share a grid cell mid-path).
    const labelsByCoord = new Map(); // coordKey → Set<name>
    for (const v of vertices) {
        if (v.kind !== 'label') continue;
        const k = coordKey(v.x, v.y);
        if (!labelsByCoord.has(k)) labelsByCoord.set(k, new Set());
        labelsByCoord.get(k).add(v.name);
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

    // 7) Junction dots: any coord with ≥3 distinct incident segments
    //    (counting each wire leg and each pin as an incidence).
    const incidence = new Map(); // coordKey → count
    for (const v of vertices) {
        const k = coordKey(v.x, v.y);
        incidence.set(k, (incidence.get(k) || 0) + 1);
    }
    const junctions = [];
    for (const [k, n] of incidence) {
        if (n >= 3) {
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
