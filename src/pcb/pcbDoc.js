/**
 * PCB document model for PCB Studio (v1 — manual route, 2 copper layers).
 */

export const PCB_LAYERS = [
    'F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'In5.Cu', 'In6.Cu', 'B.Cu',
    'F.SilkS', 'B.SilkS', 'Edge.Cuts'
];

export const COPPER_LAYERS = [
    'F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'In5.Cu', 'In6.Cu', 'B.Cu'
];

export function emptyPcbDoc() {
    return {
        version: 1,
        meta: {
            name: 'Untitled board',
            boardWmm: 80,
            boardHmm: 50,
            defaultTrackMm: 0.35,
            defaultViaDrillMm: 0.4,
            defaultViaDiamMm: 0.8,
        },
        /** @type {Array<{ id: string, footprintId: string, ref: string, x: number, y: number, rot: number, value?: string }>} */
        placements: [],
        /** @type {Array<{ id: string, layer: string, widthMm: number, net: string, points: number[][] }>} */
        tracks: [],
        /** @type {Array<{ id: string, x: number, y: number, drillMm: number, diamMm: number, net: string }>} */
        vias: [],
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
    return next;
}
