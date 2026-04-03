/**
 * Piezo pump over SiAC64 USB shell: `rpc send "…"` with method SET_PIEZO_PUMP.
 *
 * Examples:
 *   {"method":"SET_PIEZO_PUMP","params":{"setFlow":450,"enable":1}}
 *   {"method":"SET_PIEZO_PUMP","params":{"enable":0}}
 *   {"method":"SET_PIEZO_PUMP"}
 */

/** Upper clamp for slider / setFlow (examples use up to 450 CCM). */
export const SIAC64_DEFAULT_MAX_FLOW_CCM = 500;

export function clampTargetFlowCcm(v, maxCcm = SIAC64_DEFAULT_MAX_FLOW_CCM) {
    const max = Number(maxCcm);
    const cap = Number.isFinite(max) && max > 0 ? max : SIAC64_DEFAULT_MAX_FLOW_CCM;
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(cap, n));
}

/** Set target flow and turn pump on. */
export function buildSiAc64SetPumpFlowPayload(flowCcm, maxCcm = SIAC64_DEFAULT_MAX_FLOW_CCM) {
    const setFlow = clampTargetFlowCcm(flowCcm, maxCcm);
    return {
        method: 'SET_PIEZO_PUMP',
        params: { setFlow, enable: 1 },
    };
}

/** Disable pump (enable: 0). */
export function buildSiAc64PumpDisablePayload() {
    return {
        method: 'SET_PIEZO_PUMP',
        params: { enable: 0 },
    };
}

/** Bare method — firmware may return/query pump state. */
export function buildSiAc64PumpQueryPayload() {
    return { method: 'SET_PIEZO_PUMP' };
}

/** @deprecated use {@link buildSiAc64SetPumpFlowPayload} */
export function buildSiAc64SetTargetFlowCcmPayload(ccm, maxCcm = SIAC64_DEFAULT_MAX_FLOW_CCM) {
    return buildSiAc64SetPumpFlowPayload(ccm, maxCcm);
}
