/**
 * PCB document model for PCB Studio — **fixed 4-layer** stack only (KiCad-style ids).
 * Top → bottom: **F.Cu** (top copper), **In1.Cu** (GND), **In2.Cu** (VCC), **B.Cu** (bottom copper).
 */

/** Physical copper stack (frozen). In1/In2 are the inner plane pair; ids match KiCad 4-layer naming. */
export const PCB_FIXED_COPPER_STACK = Object.freeze(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);

/** @deprecated alias — use {@link PCB_FIXED_COPPER_STACK} */
export const COPPER_LAYERS = PCB_FIXED_COPPER_STACK;

export const PCB_COPPER_LAYER_COUNT = 4;

export const PCB_LAYERS = [...PCB_FIXED_COPPER_STACK, 'F.SilkS', 'B.SilkS', 'Edge.Cuts'];

/** Preset grid steps (mm) for the board editor. */
export const PCB_GRID_PRESETS_MM = [0.05, 0.1, 0.25, 0.5, 1.0];

/** Default design rules (Eagle/KiCad-style fields — full DRC suite). */
export const DEFAULT_DESIGN_RULES = {
    /** Minimum copper-to-copper clearance (mm). */
    minCopperClearanceMm: 0.2,
    /** Minimum track width (mm). */
    minTrackWidthMm: 0.15,
    /** Minimum via drill diameter (mm). */
    minViaDrillMm: 0.2,
    /** Minimum via annular ring (mm). */
    minAnnularRingMm: 0.125,
    /** Minimum clearance from board edge (mm). */
    edgeClearanceMm: 0.25,
};

/**
 * Whether a copper layer is shown on the canvas (editor visibility, not manufacturing).
 * @param {object} doc
 * @param {string} layerId — e.g. F.Cu
 */
export function isCopperLayerVisible(doc, layerId) {
    const vis = doc?.meta?.layerVisibility;
    if (vis == null || vis[layerId] === undefined) return true;
    return vis[layerId] !== false;
}

/**
 * @param {object} [_doc] reserved; stack is always the fixed 4-layer board
 * @returns {readonly string[]} F.Cu, In1.Cu (GND), In2.Cu (VCC), B.Cu
 */
export function activeCopperLayerIds(_doc) {
    return PCB_FIXED_COPPER_STACK;
}

/**
 * User-facing copper name (editor labels). Canonical ids stay KiCad-style for export.
 * @param {string} layerId
 * @param {number} [_copperLayerCount] ignored (stack is always four layers)
 */
export function getCopperLayerDisplayName(layerId, _copperLayerCount) {
    const id = String(layerId || '');
    if (id === 'F.Cu') return 'Top copper';
    if (id === 'In1.Cu') return 'GND';
    if (id === 'In2.Cu') return 'VCC';
    if (id === 'B.Cu') return 'Bottom copper';
    return id.replace(/\.Cu$/, '') || id;
}

/**
 * Normalize loaded docs (localStorage / imports): copper layer count + valid track layers.
 * @param {object} doc
 */
export function migratePcbDoc(doc) {
    if (!doc || typeof doc !== 'object') return emptyPcbDoc();
    const next = JSON.parse(JSON.stringify(doc));
    next.meta = next.meta || {};
    next.meta.copperLayerCount = PCB_COPPER_LAYER_COUNT;
    const allowed = new Set(activeCopperLayerIds(next));
    next.placements = Array.isArray(next.placements) ? next.placements : [];
    next.tracks = (Array.isArray(next.tracks) ? next.tracks : [])
        .filter((t) => t && Array.isArray(t.points))
        .map((t) => (allowed.has(t.layer) ? t : { ...t, layer: 'F.Cu' }));
    next.vias = Array.isArray(next.vias) ? next.vias : [];
    next.polygons = (Array.isArray(next.polygons) ? next.polygons : [])
        .filter((p) => p && Array.isArray(p.points) && p.points.length >= 3)
        .map((p) => (allowed.has(p.layer) ? p : { ...p, layer: 'F.Cu' }));
    const g = Number(next.meta.gridMm);
    next.meta.gridMm = PCB_GRID_PRESETS_MM.includes(g) ? g : 0.5;
    if (typeof next.meta.snapToGrid !== 'boolean') next.meta.snapToGrid = true;
    if (typeof next.meta.routeFreeAngle !== 'boolean') next.meta.routeFreeAngle = false;
    next.meta.designRules = {
        ...DEFAULT_DESIGN_RULES,
        ...(next.meta.designRules && typeof next.meta.designRules === 'object' ? next.meta.designRules : {}),
    };
    const c = Number(next.meta.designRules.minCopperClearanceMm);
    next.meta.designRules.minCopperClearanceMm = Number.isFinite(c) ? Math.min(2, Math.max(0.05, c)) : DEFAULT_DESIGN_RULES.minCopperClearanceMm;
    const tw = Number(next.meta.designRules.minTrackWidthMm);
    next.meta.designRules.minTrackWidthMm = Number.isFinite(tw) ? Math.min(2, Math.max(0.08, tw)) : DEFAULT_DESIGN_RULES.minTrackWidthMm;
    if (next.meta.layerVisibility == null || typeof next.meta.layerVisibility !== 'object') {
        next.meta.layerVisibility = {};
    }
    const bw = Number(next.meta.boardWmm);
    const bh = Number(next.meta.boardHmm);
    next.meta.boardWmm = Number.isFinite(bw) ? Math.min(2000, Math.max(5, bw)) : 80;
    next.meta.boardHmm = Number.isFinite(bh) ? Math.min(2000, Math.max(5, bh)) : 50;
    const stack = activeCopperLayerIds(next);
    if (stack.length && stack.every((ly) => !isCopperLayerVisible(next, ly))) {
        next.meta.layerVisibility = {};
    }
    return next;
}

export function emptyPcbDoc() {
    return {
        version: 1,
        meta: {
            name: 'Untitled board',
            boardWmm: 80,
            boardHmm: 50,
            copperLayerCount: PCB_COPPER_LAYER_COUNT,
            defaultTrackMm: 0.35,
            defaultViaDrillMm: 0.4,
            defaultViaDiamMm: 0.8,
            gridMm: 0.5,
            snapToGrid: true,
            /** If true, route tool uses arbitrary angles + per-axis grid snap (legacy). Default false = 45°/90° octilinear. */
            routeFreeAngle: false,
            /** Per-copper-layer canvas visibility (Eagle-style layer display). */
            layerVisibility: {},
            /** Professional DRC inputs (extensible). */
            designRules: { ...DEFAULT_DESIGN_RULES },
        },
        /** @type {Array<{ id: string, footprintId: string, ref: string, x: number, y: number, rot: number, value?: string }>} */
        placements: [],
        /** @type {Array<{ id: string, layer: string, widthMm: number, net: string, points: number[][] }>} */
        tracks: [],
        /** @type {Array<{ id: string, x: number, y: number, drillMm: number, diamMm: number, net: string }>} */
        vias: [],
        /** Filled copper regions (closed polygon in board mm, same coords as tracks). */
        /** @type {Array<{ id: string, layer: string, net: string, points: number[][] }>} */
        polygons: [],
    };
}

export function newId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Parse a saved board JSON string into a migrated, valid PcbDoc.
 * @param {string} text
 * @returns {object}
 */
export function parsePcbDocJson(text) {
    const raw = JSON.parse(String(text));
    if (!raw || typeof raw !== 'object') throw new Error('Board file must be a JSON object');
    return migratePcbDoc(raw);
}

export function applyBridgePayload(doc, bridge) {
    if (!bridge || !Array.isArray(bridge.placements)) return doc;
    const next = { ...doc, placements: [...doc.placements] };
    const cols = Math.max(4, Math.ceil(Math.sqrt(bridge.placements.length + 1)));
    let i = 0;
    for (const p of bridge.placements) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        next.placements.push({
            id: newId('fp'),
            footprintId: p.footprintId,
            ref: p.ref,
            x: 15 + col * 12,
            y: 15 + row * 12,
            rot: 0,
            value: p.value,
            padNets: p.padNets || {},
        });
        i++;
    }
    if (bridge.meta?.boardWmm) next.meta = { ...next.meta, boardWmm: bridge.meta.boardWmm };
    if (bridge.meta?.boardHmm) next.meta = { ...next.meta, boardHmm: bridge.meta.boardHmm };
    if (bridge.meta?.name != null && String(bridge.meta.name).trim()) {
        next.meta = { ...next.meta, name: String(bridge.meta.name).trim() };
    }
    return next;
}

/**
 * Sync bridge payload into an existing PCB doc — updates refs, padNets, and
 * footprint IDs while preserving placement positions, existing tracks, and vias.
 *
 * Matching strategy:
 *   1. Match by ref directly (e.g. schematic "R1" → existing PCB "R1").
 *   2. Match by footprintId + order when refs diverged (e.g. schematic "V2"
 *      matches existing PCB "V1" because both use PIN2_HDR and are the only V).
 *   3. Any unmatched bridge placements are added at grid positions.
 *   4. Any PCB placements with no schematic counterpart are removed.
 *   5. Tracks whose net label no longer exists in any padNet are pruned
 *      (prevents stale wrong-net connections from persisting).
 *
 * @param {object} doc — existing PcbDoc
 * @param {object} bridge — bridge payload from buildPcbBridgePayload
 * @returns {object} next PcbDoc (immutable)
 */
export function syncBridgePayload(doc, bridge) {
    if (!bridge || !Array.isArray(bridge.placements)) return doc;

    const existingPlacements = [...(doc.placements || [])];
    const bridgePlacements = bridge.placements;

    // Phase 1: Match bridge entries to existing placements
    const matched = new Map(); // bridgeIdx → existingIdx
    const usedExisting = new Set();

    // Pass A: exact ref match
    for (let bi = 0; bi < bridgePlacements.length; bi++) {
        const bp = bridgePlacements[bi];
        for (let ei = 0; ei < existingPlacements.length; ei++) {
            if (usedExisting.has(ei)) continue;
            if (existingPlacements[ei].ref === bp.ref) {
                matched.set(bi, ei);
                usedExisting.add(ei);
                break;
            }
        }
    }

    // Pass B: match by footprintId + prefix for unmatched (handles V1→V2 renames)
    for (let bi = 0; bi < bridgePlacements.length; bi++) {
        if (matched.has(bi)) continue;
        const bp = bridgePlacements[bi];
        const prefix = (bp.ref || '').replace(/\d+$/, '');
        for (let ei = 0; ei < existingPlacements.length; ei++) {
            if (usedExisting.has(ei)) continue;
            const ep = existingPlacements[ei];
            const epPrefix = (ep.ref || '').replace(/\d+$/, '');
            if (ep.footprintId === bp.footprintId && epPrefix === prefix) {
                matched.set(bi, ei);
                usedExisting.add(ei);
                break;
            }
        }
    }

    // Phase 2: Build new placements array
    const nextPlacements = [];
    const cols = Math.max(4, Math.ceil(Math.sqrt(bridgePlacements.length + 1)));
    let addIdx = 0;

    // Build an old→new net rename map so we can fix track net labels
    const netRenames = new Map();

    for (let bi = 0; bi < bridgePlacements.length; bi++) {
        const bp = bridgePlacements[bi];
        const ei = matched.get(bi);
        if (ei != null) {
            // Existing placement — preserve position, update ref/padNets/footprint
            const ep = existingPlacements[ei];

            // Build net rename map from old padNets → new padNets
            const oldNets = ep.padNets || {};
            const newNets = bp.padNets || {};
            for (const padKey of Object.keys(oldNets)) {
                const oldNet = oldNets[padKey];
                const newNet = newNets[padKey];
                if (oldNet && newNet && oldNet !== newNet) {
                    netRenames.set(oldNet, newNet);
                }
            }

            nextPlacements.push({
                ...ep,
                ref: bp.ref,
                footprintId: bp.footprintId,
                value: bp.value,
                padNets: bp.padNets || {},
            });
        } else {
            // New placement — add at grid position
            const col = addIdx % cols;
            const row = Math.floor(addIdx / cols);
            nextPlacements.push({
                id: newId('fp'),
                footprintId: bp.footprintId,
                ref: bp.ref,
                x: 15 + col * 12,
                y: 15 + row * 12,
                rot: 0,
                value: bp.value,
                padNets: bp.padNets || {},
            });
            addIdx++;
        }
    }

    // Phase 3: Collect all valid net labels from the new placements
    const validNets = new Set();
    for (const pl of nextPlacements) {
        for (const net of Object.values(pl.padNets || {})) {
            if (net != null && net !== '') validNets.add(net);
        }
    }

    // Phase 4: Fix track/via net labels, then prune stale ones.
    // 4a: Rename nets that changed (e.g. schematic rewiring moved a pin to a different node)
    let nextTracks = (doc.tracks || []).map((tr) => {
        if (tr.net && netRenames.has(tr.net)) {
            return { ...tr, net: netRenames.get(tr.net) };
        }
        return tr;
    });
    let nextVias = (doc.vias || []).map((v) => {
        if (v.net && netRenames.has(v.net)) {
            return { ...v, net: netRenames.get(v.net) };
        }
        return v;
    });

    // 4b: Prune tracks and vias whose net no longer exists in ANY pad
    // (e.g. a component was removed from the schematic). Keep GND ('0')
    // tracks because GND plane connectivity doesn't need a padNet entry.
    nextTracks = nextTracks.filter((tr) => {
        if (!tr.net || tr.net === '') return true; // keep unassigned
        if (tr.net === '0') return true; // GND is always valid
        return validNets.has(tr.net);
    });
    nextVias = nextVias.filter((v) => {
        if (!v.net || v.net === '') return true;
        if (v.net === '0') return true;
        return validNets.has(v.net);
    });

    // Phase 5: Update meta from bridge (board size is PCB-only — do not overwrite on sync).
    let nextMeta = { ...doc.meta };
    if (bridge.meta?.name != null && String(bridge.meta.name).trim()) {
        nextMeta.name = String(bridge.meta.name).trim();
    }

    return {
        ...doc,
        meta: nextMeta,
        placements: nextPlacements,
        tracks: nextTracks,
        vias: nextVias,
    };
}

/*
 * Professional PCB direction (Eagle/KiCad-class), incremental roadmap:
 * 1) Design rules + DRC depth (net classes, via rules, keepouts) — started: clearance + min width in meta.
 * 2) Layer system (silk/mask/paste, visibility, locked layers) — started: copper visibility.
 * 3) Library & footprints (pad stacks, courtyards, 3D) + in-app footprint editor.
 * 4) Routing (push-shove, diffpairs, teardrops) + copper pour keepouts.
 * 5) Manufacturing (full stack Gerber/Drill, IPC-D-356, pick-and-place) — JSON import/export round-trip started.
 */
