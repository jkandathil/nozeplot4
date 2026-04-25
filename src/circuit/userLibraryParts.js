/**
 * Build palette / getPart entries from SPICE library rows (.model lines).
 * Used so downloaded includes become draggable parts with part-number labels.
 */

import { parseNetlist } from './netlist.js';
import { partLabelForSpiceModelName } from './modelCatalog.js';

/** @typedef {{ name: string, type: string, params: Record<string, number> }} ExtractedModel */

/**
 * Parse `.model` definitions from arbitrary SPICE text (comments + .end allowed).
 * @param {string} text
 * @returns {ExtractedModel[]}
 */
export function extractModelsFromSpiceLibraryText(text) {
    const body = String(text || '').trim();
    if (!body) return [];
    const src = `* __lib_extract__\n${body}\n.end\n`;
    let parsed;
    try {
        parsed = parseNetlist(src, {});
    } catch {
        return [];
    }
    const models = parsed?.models;
    if (!models || typeof models !== 'object') return [];
    return Object.keys(models).map((k) => {
        const m = models[k];
        return {
            name: m.name || k,
            type: String(m.type || 'D').toUpperCase(),
            params: { ...(m.params || {}) },
        };
    });
}

/** @param {string} spiceType */
export function elementTypeForSpiceModelType(spiceType) {
    const t = String(spiceType || '').toUpperCase();
    if (t === 'NPN' || t === 'PNP') return 'Q';
    if (t === 'NMOS' || t === 'PMOS') return 'M';
    if (t === 'D') return 'D';
    return null;
}

/** @param {string} spiceType — keys must match {@link SYMBOLS} in symbols.js */
export function symbolKeyForSpiceModelType(spiceType) {
    const t = String(spiceType || '').toUpperCase();
    if (t === 'NPN') return 'Q_NPN';
    if (t === 'PNP') return 'Q_PNP';
    if (t === 'NMOS') return 'M_NMOS';
    if (t === 'PMOS') return 'M_PMOS';
    if (t === 'D') return 'D';
    return 'D';
}

/**
 * @param {{ id?: string, name?: string, content?: string }[]} spiceLibs
 * @returns {object[]} Library-shaped part objects (see library.js schema + contributesUserModel)
 */
export function buildUserLibraryPartsFromSpiceLibs(spiceLibs) {
    const rows = Array.isArray(spiceLibs) ? spiceLibs : [];
    const out = [];
    for (const row of rows) {
        const libKey = String(row?.id || row?.name || 'lib').trim() || 'lib';
        const fname = String(row?.name || 'library.inc').trim() || 'library.inc';
        const defs = extractModelsFromSpiceLibraryText(row?.content || '');
        for (const m of defs) {
            const elType = elementTypeForSpiceModelType(m.type);
            if (!elType) continue;
            const partNumber = partLabelForSpiceModelName(m.name);
            const partId = `ulib:${libKey}:${m.name}`;
            out.push({
                id: partId,
                name: `${partNumber} · ${m.name}`,
                short: partNumber.length <= 10 ? partNumber : `${partNumber.slice(0, 8)}…`,
                category: 'Downloaded parts',
                description: `${m.type} — .model ${m.name} (from ${fname})`,
                elementType: elType,
                symbolKey: symbolKeyForSpiceModelType(m.type),
                refPrefix: elType,
                modelRef: m.name,
                partNumber,
                spiceModelName: m.name,
                contributesUserModel: {
                    name: m.name,
                    type: m.type,
                    params: { ...m.params },
                },
            });
        }
    }
    return out;
}
