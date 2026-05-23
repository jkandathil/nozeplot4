/**
 * Design rule check (DRC) rule-set schema for MEMS mask layouts.
 * Serializable JSON for foundry/process reuse.
 */

export const DRC_RULESET_VERSION = 1;

/**
 * @typedef {'error'|'warning'} DrcSeverity
 */

/** @typedef {{
 *   enabled?: boolean,
 *   layers: string[],
 *   minUm: number,
 *   severity?: DrcSeverity,
 * }} MinWidthRule */

/** @typedef {{
 *   enabled?: boolean,
 *   layers: string[],
 *   minUm: number,
 *   severity?: DrcSeverity,
 * }} MinSpacingRule */

/** @typedef {{
 *   enabled?: boolean,
 *   layerA: string,
 *   layerB: string,
 *   minUm: number,
 *   severity?: DrcSeverity,
 * }} ClearanceRule */

/** @typedef {{
 *   enabled?: boolean,
 *   innerLayer: string,
 *   outerLayer: string,
 *   minUm: number,
 *   severity?: DrcSeverity,
 * }} EnclosureRule */

/** @typedef {{
 *   enabled?: boolean,
 *   layerA: string,
 *   layerB: string,
 *   minAreaUm2: number,
 *   severity?: DrcSeverity,
 * }} MinOverlapRule */

/** @typedef {{
 *   enabled?: boolean,
 *   layers: string[],
 *   minUm2: number,
 *   severity?: DrcSeverity,
 * }} MinAreaRule */

/** @typedef {{
 *   enabled?: boolean,
 *   layers: string[],
 *   maxUm2: number,
 *   severity?: DrcSeverity,
 * }} MaxAreaRule */

/** @typedef {{
 *   enabled?: boolean,
 *   layers: string[],
 *   minInteriorDeg: number,
 *   severity?: DrcSeverity,
 * }} AcuteAngleRule */

/** @typedef {{
 *   enabled?: boolean,
 *   layerPattern: string,
 *   minWidthUm: number,
 *   minHeightUm: number,
 *   severity?: DrcSeverity,
 * }} PadRule */

/** @typedef {{
 *   enabled?: boolean,
 *   layerPattern: string,
 *   minDiameterUm?: number,
 *   maxDiameterUm?: number,
 *   severity?: DrcSeverity,
 * }} ViaTsvRule */

/** @typedef {{
 *   enabled?: boolean,
 *   id: string,
 *   note: string,
 *   severity?: DrcSeverity,
 * }} MemsProcessNoteRule */

/**
 * @returns {object}
 */
export function defaultDrcRuleSet() {
    return {
        version: DRC_RULESET_VERSION,
        name: 'Generic MEMS',
        meta: {
            foundry: '',
            process: '',
            notes: '',
        },
        kernel: {
            lineHalfWidthUm: 0.005,
            pathCapUm: 0.01,
            arcToleranceUm: 0.25,
        },
        minWidth: [
            {
                enabled: true,
                layers: ['*'],
                minUm: 2,
                severity: 'error',
            },
        ],
        minSpacing: [
            {
                enabled: true,
                layers: ['*'],
                minUm: 2,
                severity: 'error',
            },
        ],
        clearance: [],
        enclosure: [],
        minOverlap: [],
        minArea: [],
        maxArea: [],
        acuteAngle: [
            {
                enabled: false,
                layers: ['*'],
                minInteriorDeg: 85,
                severity: 'warning',
            },
        ],
        pads: [],
        viaTsv: [],
        memsNotes: [],
    };
}

/** Simple glob: * matches any substring; otherwise exact or prefix/suffix * */
export function layerNameMatches(pattern, layerName) {
    const p = String(pattern || '').trim();
    const n = String(layerName || '');
    if (!p || p === '*') return true;
    if (p.includes('*')) {
        const parts = p.split('*').filter(Boolean);
        if (!parts.length) return true;
        let pos = 0;
        for (const part of parts) {
            const i = n.indexOf(part, pos);
            if (i < 0) return false;
            pos = i + part.length;
        }
        return true;
    }
    return n === p;
}

export function ruleMatchesLayers(ruleLayers, layerName) {
    const arr = Array.isArray(ruleLayers) ? ruleLayers : ['*'];
    return arr.some((pat) => layerNameMatches(pat, layerName));
}

/**
 * Merge imported JSON with current schema defaults (forward-compatible).
 */
export function migrateDrcRuleSet(raw) {
    const d = defaultDrcRuleSet();
    if (!raw || typeof raw !== 'object') return d;
    return {
        ...d,
        ...raw,
        version: typeof raw.version === 'number' ? raw.version : DRC_RULESET_VERSION,
        meta: { ...d.meta, ...(raw.meta || {}) },
        kernel: { ...d.kernel, ...(raw.kernel || {}) },
        minWidth: raw.minWidth ?? d.minWidth,
        minSpacing: raw.minSpacing ?? d.minSpacing,
        clearance: raw.clearance ?? d.clearance,
        enclosure: raw.enclosure ?? d.enclosure,
        minOverlap: raw.minOverlap ?? d.minOverlap,
        minArea: raw.minArea ?? d.minArea,
        maxArea: raw.maxArea ?? d.maxArea,
        acuteAngle: raw.acuteAngle ?? d.acuteAngle,
        pads: raw.pads ?? d.pads,
        viaTsv: raw.viaTsv ?? d.viaTsv,
        memsNotes: raw.memsNotes ?? d.memsNotes,
    };
}
