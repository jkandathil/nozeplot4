/**
 * PCB document model for PCB Studio — up to 8 copper layers (signal + plane routing).
 * Stack order top → bottom: F.Cu, In1…In6, B.Cu (matches common 8-layer naming).
 */

export const PCB_LAYERS = [
    'F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'In5.Cu', 'In6.Cu', 'B.Cu',
    'F.SilkS', 'B.SilkS', 'Edge.Cuts',
];

export const COPPER_LAYERS = [
    'F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'In5.Cu', 'In6.Cu', 'B.Cu',
];

/** Allowed copper layer counts (even stacks; 8 = full inner set). */
export const COPPER_LAYER_COUNT_OPTIONS = [2, 4, 6, 8];

/** Preset grid steps (mm) for the board editor. */
export const PCB_GRID_PRESETS_MM = [0.05, 0.1, 0.25, 0.5, 1.0];

/**
 * @param {object} doc
 * @returns {string[]} Active copper layer ids for this board (length = meta.copperLayerCount or 2).
 */
export function activeCopperLayerIds(doc) {
    const n = Number(doc?.meta?.copperLayerCount);
    const count = COPPER_LAYER_COUNT_OPTIONS.includes(n) ? n : 2;
    return COPPER_LAYERS.slice(0, count);
}

/**
 * Normalize loaded docs (localStorage / imports): copper layer count + valid track layers.
 * @param {object} doc
 */
export function migratePcbDoc(doc) {
    if (!doc || typeof doc !== 'object') return emptyPcbDoc();
    const next = JSON.parse(JSON.stringify(doc));
    next.meta = next.meta || {};
    const n = Number(next.meta.copperLayerCount);
    next.meta.copperLayerCount = COPPER_LAYER_COUNT_OPTIONS.includes(n) ? n : 2;
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
    return next;
}

export function emptyPcbDoc() {
    return {
        version: 1,
        meta: {
            name: 'Untitled board',
            boardWmm: 80,
            boardHmm: 50,
            copperLayerCount: 2,
            defaultTrackMm: 0.35,
            defaultViaDrillMm: 0.4,
            defaultViaDiamMm: 0.8,
            gridMm: 0.5,
            snapToGrid: true,
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
