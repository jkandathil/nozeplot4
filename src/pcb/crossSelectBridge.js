/**
 * Bidirectional schematic ↔ PCB cross-highlight via sessionStorage + a window event
 * (same-tab navigation does not fire the storage event).
 */

import { componentPins } from '../circuit/schematicDoc.js';

/** Legacy single key (pre split); read only for one-time migration. */
export const CROSS_SELECT_KEY = 'nozeSchPcbCrossSelect:v1';
/** Schematic → PCB Studio (pads / footprint refs from canvas selection). */
export const CROSS_SELECT_KEY_SCH_TO_PCB = 'nozeSchPcbCrossSelect:v2:sch';
/** PCB Studio → schematic (placement refs + track/via/polygon nets). */
export const CROSS_SELECT_KEY_PCB_TO_SCH = 'nozeSchPcbCrossSelect:v2:pcb';
export const CROSS_SELECT_EVENT = 'noze-sch-pcb-cross';

/**
 * @param {{ from: 'schematic' | 'pcb', refs?: string[], nets?: string[] }} payload
 */
export function broadcastCrossSelect(payload) {
    try {
        const key = payload.from === 'pcb' ? CROSS_SELECT_KEY_PCB_TO_SCH : CROSS_SELECT_KEY_SCH_TO_PCB;
        sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), ...payload }));
    } catch {
        /* quota / private mode */
    }
    window.dispatchEvent(new Event(CROSS_SELECT_EVENT));
}

/** PCB Studio: read last schematic-driven highlight (own key — not overwritten when Circuit mounts). */
export function readCrossSelectFromSchematicStorage() {
    try {
        const raw = sessionStorage.getItem(CROSS_SELECT_KEY_SCH_TO_PCB);
        if (raw) return JSON.parse(raw);
        const leg = sessionStorage.getItem(CROSS_SELECT_KEY);
        if (!leg) return null;
        const o = JSON.parse(leg);
        return o?.from === 'schematic' ? o : null;
    } catch {
        return null;
    }
}

/** Circuit Studio: read last PCB-driven highlight (own key — not overwritten by schematic broadcast). */
export function readCrossSelectFromPcbStorage() {
    try {
        const raw = sessionStorage.getItem(CROSS_SELECT_KEY_PCB_TO_SCH);
        if (raw) return JSON.parse(raw);
        const leg = sessionStorage.getItem(CROSS_SELECT_KEY);
        if (!leg) return null;
        const o = JSON.parse(leg);
        return o?.from === 'pcb' ? o : null;
    } catch {
        return null;
    }
}

function netLabelFromNodeId(nets, nodeId) {
    if (nodeId == null || nodeId === 0) return 'gnd';
    const lab = nets.nodeLabels?.get(nodeId);
    if (lab && !/^n\d+$/i.test(String(lab)) && String(lab).toLowerCase() !== 'gnd') return String(lab);
    return `n${nodeId}`;
}

/**
 * Resolved net name for a wire (first vertex that sits on a resolved node).
 * @param {object} doc
 * @param {object} nets — resolveNets(doc)
 * @param {string} wireId
 * @returns {string | null}
 */
export function inferWireNetLabel(doc, nets, wireId) {
    if (!nets?.nodeIdAt) return null;
    const w = doc.wires?.find((x) => x.id === wireId);
    if (!w?.points?.length) return null;
    for (const [x, y] of w.points) {
        const nid = nets.nodeIdAt(x, y);
        if (nid != null) return netLabelFromNodeId(nets, nid);
    }
    return null;
}

function skipSchRef(comp) {
    if (!comp) return true;
    return ['GND', 'VP', 'SCOPE'].includes(comp.elementType);
}

/**
 * @param {object} doc
 * @param {object} nets
 * @param {object | null} selection — Canvas selection shape
 * @returns {{ refs: string[], nets: string[] }}
 */
export function collectSchematicCrossPayload(doc, nets, selection) {
    const refs = new Set();
    const netsOut = new Set();
    const addNet = (n) => {
        if (n == null || String(n).trim() === '') return;
        netsOut.add(String(n));
    };

    if (!selection) {
        return { refs: [], nets: [] };
    }

    if (selection.kind === 'component') {
        const c = doc.components?.find((x) => x.id === selection.id);
        if (!skipSchRef(c) && c?.ref) refs.add(c.ref);
        if (c && nets?.pinNode) {
            for (const pin of componentPins(c) || []) {
                const nid = nets.pinNode(c, pin.id);
                if (nid != null) netsOut.add(netLabelFromNodeId(nets, nid));
            }
        }
        return { refs: [...refs], nets: [...netsOut] };
    }

    if (selection.kind === 'wire' && nets) {
        const n = inferWireNetLabel(doc, nets, selection.id);
        if (n) addNet(n);
        return { refs: [], nets: [...netsOut] };
    }

    if (selection.kind === 'multi') {
        for (const cid of selection.componentIds || []) {
            const c = doc.components?.find((x) => x.id === cid);
            if (!skipSchRef(c) && c?.ref) refs.add(c.ref);
            if (c && nets?.pinNode) {
                for (const pin of componentPins(c) || []) {
                    const nid = nets.pinNode(c, pin.id);
                    if (nid != null) netsOut.add(netLabelFromNodeId(nets, nid));
                }
            }
        }
        for (const wid of selection.wireIds || []) {
            const n = nets ? inferWireNetLabel(doc, nets, wid) : null;
            if (n) addNet(n);
        }
        for (const lid of selection.labelIds || []) {
            const lab = doc.labels?.find((l) => l.id === lid);
            if (lab?.name) addNet(lab.name);
        }
        return { refs: [...refs], nets: [...netsOut] };
    }

    return { refs: [], nets: [] };
}

/**
 * @param {object} doc — PcbDoc
 * @param {Array<{ kind: string, id: string }>} selectedItems
 * @returns {{ refs: string[], nets: string[] }}
 */
export function collectPcbCrossPayload(doc, selectedItems) {
    const refs = new Set();
    const nets = new Set();
    const addNet = (n) => {
        if (n == null || String(n).trim() === '' || String(n) === '0') return;
        nets.add(String(n));
    };

    for (const s of selectedItems || []) {
        if (s.kind === 'placement') {
            const pl = doc.placements?.find((p) => p.id === s.id);
            if (pl?.ref) refs.add(pl.ref);
            const pn = pl?.padNets || {};
            for (const v of Object.values(pn)) addNet(v);
        } else if (s.kind === 'track') {
            const tr = doc.tracks?.find((t) => t.id === s.id);
            addNet(tr?.net);
        } else if (s.kind === 'via') {
            const v = doc.vias?.find((x) => x.id === s.id);
            addNet(v?.net);
        } else if (s.kind === 'polygon') {
            const po = doc.polygons?.find((p) => p.id === s.id);
            addNet(po?.net);
        }
    }
    return { refs: [...refs], nets: [...nets] };
}
