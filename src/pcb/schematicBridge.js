/**
 * Build a PCB bridge payload from a Circuit Studio schematic + resolved nets.
 */

import { componentPins } from '../circuit/schematicDoc.js';

/**
 * PCB net string for a resolved schematic node id.
 * Only integer **0** is GND (`'0'`). `null` / `undefined` means no node (e.g. floating
 * pin in label-authoritative mode) — must **not** be coerced to GND or pads short
 * to the pour / GND in PCB Studio.
 */
function netLabelFromNodeId(nets, nodeId) {
    if (nodeId === 0) return '0';
    if (nodeId == null) return null;
    const lab = nets.nodeLabels?.get(nodeId);
    if (lab && !/^n\d+$/i.test(lab) && lab !== 'gnd') return String(lab);
    return `n${nodeId}`;
}

function mapPadIdToFootprintPad(comp, pinId) {
    const t = comp.elementType;
    if (t === 'R' || t === 'C' || t === 'L') {
        return pinId === 'n1' ? '1' : '2';
    }
    if (t === 'D') return pinId === 'n1' ? '1' : '2';
    if (t === 'Q') {
        if (pinId === 'nc') return '1';
        if (pinId === 'nb') return '2';
        if (pinId === 'ne') return '3';
    }
    if (t === 'M') {
        if (pinId === 'nd') return '1';
        if (pinId === 'ng') return '2';
        if (pinId === 'ns') return '3';
    }
    if (t === 'REG') {
        if (pinId === 'n_in') return '1';
        if (pinId === 'n_gnd') return '2';
        if (pinId === 'n_out') return '3';
    }
    if (t === 'V' || t === 'I' || t === 'IP') {
        if (pinId === 'n1') return '1';
        if (pinId === 'n2') return '2';
    }
    if (t === 'O') {
        if (pinId === 'inp') return '1';
        if (pinId === 'inn') return '2';
        if (pinId === 'out') return '3';
    }
    if (t === 'E' || t === 'G') {
        if (pinId === 'n1') return '1';
        if (pinId === 'n2') return '2';
        if (pinId === 'nc1') return '3';
        if (pinId === 'nc2') return '4';
    }
    if (t === 'SCOPE') {
        if (pinId === 'tip') return '1';
        if (pinId === 'tip2') return '2';
    }
    return pinId;
}

export function footprintIdForComponent(comp) {
    const pid = comp.partId || '';
    const t = comp.elementType;
    if (t === 'R') return 'R_0805';
    if (t === 'C') return 'C_0805';
    if (t === 'L') return 'L_1210';
    if (t === 'D') return 'SOD323';
    if (t === 'Q' || t === 'M') return 'SOT23_3';
    if (t === 'REG') return 'TO220_3';
    if (t === 'V' || t === 'I' || t === 'IP') return 'PIN2_HDR';
    if (t === 'O') return 'SOT23_3';
    if (t === 'E' || t === 'G') return 'CHIP_4SQ';
    /** Dual-channel scope → two THT pads (probe / scope cable landings); single → one test pad. */
    if (t === 'SCOPE') return comp.scopeChannelMode === 'single' ? 'TP_1mm' : 'HDR_1x2';
    if (pid.startsWith('ulib:')) return 'SOT23_3';
    return 'DIP8';
}

/**
 * @param {object} doc — SchematicDoc
 * @param {object} nets — resolveNets(doc)
 * @returns {{ version: number, meta: object, placements: object[], netlistHint?: string }}
 */
export function buildPcbBridgePayload(doc, nets, netlistHint = '') {
    const placements = [];
    if (!doc?.components || !nets) {
        return { version: 1, meta: { boardWmm: 100, boardHmm: 80 }, placements: [], netlistHint };
    }
    // GND / rail symbols have no footprint; VP is a single-node probe (skip unless we add a TP later).
    // SCOPE is included as test-point header(s) so CH1/CH2 nets appear on the PCB for bring-up.
    for (const c of doc.components) {
        if (['GND', 'VP'].includes(c.elementType)) continue;
        const fp = footprintIdForComponent(c);
        const padNets = {};
        try {
            for (const pin of componentPins(c) || []) {
                const nid = nets.pinNode(c, pin.id);
                const lbl = netLabelFromNodeId(nets, nid);
                if (lbl == null || lbl === '') continue;
                const key = mapPadIdToFootprintPad(c, pin.id);
                padNets[key] = lbl;
            }
        } catch { /* symbol missing */ }
        let value = '';
        if (c.value != null && Number.isFinite(c.value)) value = String(c.value);
        if (c.modelRef) value = value ? `${value} ${c.modelRef}` : c.modelRef;
        placements.push({
            ref: c.ref,
            footprintId: fp,
            value,
            padNets,
        });
    }
    return {
        version: 1,
        meta: { boardWmm: 100, boardHmm: 80 },
        placements,
        netlistHint,
    };
}

export const PCB_BRIDGE_KEY = 'nozePcbBridge:v1';

/** Fired after sessionStorage bridge write so PCB Studio can consume it even if already mounted. */
export const PCB_BRIDGE_READY_EVENT = 'noze-pcb-bridge-ready';

/** Tag carried in bridge JSON when opened from the Circuit Studio Gerber walkthrough demo. */
export const PCB_WORKFLOW_DEMO_ID = 'pcb-gerber-walkthrough';
