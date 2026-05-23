/**
 * Unified solvent database — core Hansen handbook entries + SolvPred v2 (249)
 * + user custom solvents (persisted via localStorage by the UI).
 */

import solvPredDb from './data/solvPredDb.json';

/** Original curated set (~71) with hand-tuned RER values. */
const CORE_SOLVENTS = [
    { name: 'n-Pentane', cas: '109-66-0', category: 'alkane', dD: 14.5, dP: 0.0, dH: 0.0, mw: 72.15, density: 0.626, bp: 36, rer: 12.0 },
    { name: 'n-Hexane', cas: '110-54-3', category: 'alkane', dD: 14.9, dP: 0.0, dH: 0.0, mw: 86.18, density: 0.659, bp: 69, rer: 8.3 },
    { name: 'n-Heptane', cas: '142-82-5', category: 'alkane', dD: 15.3, dP: 0.0, dH: 0.0, mw: 100.20, density: 0.684, bp: 98, rer: 3.5 },
    { name: 'n-Octane', cas: '111-65-9', category: 'alkane', dD: 15.5, dP: 0.0, dH: 0.0, mw: 114.23, density: 0.703, bp: 126, rer: 1.4 },
    { name: 'Cyclohexane', cas: '110-82-7', category: 'alkane', dD: 16.8, dP: 0.0, dH: 0.2, mw: 84.16, density: 0.779, bp: 81, rer: 4.0 },
    { name: 'Toluene', cas: '108-88-3', category: 'aromatic', dD: 18.0, dP: 1.4, dH: 2.0, mw: 92.14, density: 0.867, bp: 111, rer: 2.0 },
    { name: 'Ethanol', cas: '64-17-5', category: 'alcohol', dD: 15.8, dP: 8.8, dH: 19.4, mw: 46.07, density: 0.789, bp: 78, rer: 3.0 },
    { name: 'Acetone', cas: '67-64-1', category: 'ketone', dD: 15.5, dP: 10.4, dH: 7.0, mw: 58.08, density: 0.784, bp: 56, rer: 5.8 },
    { name: 'Water', cas: '7732-18-5', category: 'water', dD: 15.5, dP: 16.0, dH: 42.3, mw: 18.02, density: 0.998, bp: 100, rer: 0.36 },
];

/** Merge core + SolvPred; core wins on CAS conflict for RER accuracy. */
function buildMergedSolvents() {
    const byCas = new Map();
    const byName = new Map();
    for (const s of solvPredDb) {
        if (s.cas) byCas.set(s.cas, { ...s });
        byName.set(s.name.toLowerCase(), { ...s });
    }
    for (const s of CORE_SOLVENTS) {
        if (s.cas) byCas.set(s.cas, { ...byCas.get(s.cas), ...s, source: 'core' });
        byName.set(s.name.toLowerCase(), { ...s, source: 'core' });
    }
    const merged = [...byCas.values()].sort((a, b) => a.name.localeCompare(b.name));
    return merged;
}

export const HSP_SOLVENTS = buildMergedSolvents();

export const HSP_SOLVENT_BY_NAME = (() => {
    const map = new Map();
    for (const s of HSP_SOLVENTS) map.set(s.name.toLowerCase(), s);
    return map;
})();

export const HSP_SOLVENT_BY_CAS = (() => {
    const map = new Map();
    for (const s of HSP_SOLVENTS) {
        if (s.cas) map.set(s.cas, s);
    }
    return map;
})();

export const HSP_CATEGORIES = Array.from(new Set(HSP_SOLVENTS.map((s) => s.category))).sort();

export function findSolventByName(name) {
    if (!name) return null;
    const key = String(name).trim().toLowerCase();
    const direct = HSP_SOLVENT_BY_NAME.get(key);
    if (direct) return direct;
    /* HSPiP-style aliases: "Methyl ethyl ketone (MEK)" → canonical name. */
    const stripped = key.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (stripped !== key) {
        const alias = HSP_SOLVENT_BY_NAME.get(stripped);
        if (alias) return alias;
    }
    for (const [k, s] of HSP_SOLVENT_BY_NAME) {
        if (k.startsWith(stripped) || stripped.startsWith(k)) return s;
    }
    return null;
}

export function findSolventByCas(cas) {
    if (!cas) return null;
    return HSP_SOLVENT_BY_CAS.get(String(cas).trim()) ?? null;
}

export function getSolventsByName(names) {
    return (names || []).map((n) => findSolventByName(n));
}

/** Merge user custom solvents (from localStorage) on top of built-in DB. */
export function mergeCustomSolvents(customList = []) {
    const base = [...HSP_SOLVENTS];
    const casSet = new Set(base.map((s) => s.cas).filter(Boolean));
    const nameSet = new Set(base.map((s) => s.name.toLowerCase()));
    for (const s of customList || []) {
        if (!s?.name) continue;
        if (s.cas && casSet.has(s.cas)) continue;
        if (nameSet.has(s.name.toLowerCase())) continue;
        base.push({ ...s, source: 'custom' });
        if (s.cas) casSet.add(s.cas);
        nameSet.add(s.name.toLowerCase());
    }
    return base.sort((a, b) => a.name.localeCompare(b.name));
}

export const HSP_POLYMER_SPHERES = [
    { name: 'Polystyrene (PS)', dD: 21.3, dP: 5.8, dH: 4.3, R: 12.7, R_outer: 15.0 },
    { name: 'Poly(methyl methacrylate) (PMMA)', dD: 18.6, dP: 10.5, dH: 7.5, R: 8.6, R_outer: 11.0 },
    { name: 'Polyvinyl chloride (PVC)', dD: 17.6, dP: 7.8, dH: 3.4, R: 3.5, R_outer: 6.0 },
    { name: 'Polycarbonate (PC, Lexan)', dD: 18.1, dP: 5.9, dH: 6.9, R: 7.1, R_outer: 10.0 },
    { name: 'Polyamide 66 (Nylon)', dD: 18.6, dP: 5.1, dH: 12.2, R: 10.0, R_outer: 13.0 },
    { name: 'Polysulfone (Udel)', dD: 19.7, dP: 8.3, dH: 8.3, R: 8.0, R_outer: 11.0 },
    { name: 'Polyetheretherketone (PEEK)', dD: 19.7, dP: 9.4, dH: 7.4, R: 7.6, R_outer: 10.5 },
    { name: 'Epoxy (DGEBA)', dD: 17.4, dP: 10.5, dH: 9.0, R: 11.8, R_outer: 14.0 },
    { name: 'Polyurethane (Estane 5715)', dD: 19.0, dP: 9.7, dH: 7.2, R: 9.0, R_outer: 12.0 },
    { name: 'Polyvinyl acetate (PVAc)', dD: 20.9, dP: 11.3, dH: 9.6, R: 13.7, R_outer: 16.0 },
    { name: 'Polyethylene (LDPE)', dD: 16.9, dP: 0.8, dH: 2.8, R: 8.0, R_outer: 11.0 },
    { name: 'Polypropylene (PP)', dD: 17.4, dP: 1.9, dH: 4.7, R: 8.2, R_outer: 11.5 },
    { name: 'Polyacrylonitrile (PAN)', dD: 21.7, dP: 14.1, dH: 9.1, R: 10.9, R_outer: 13.5 },
    { name: 'Cellulose acetate (CA)', dD: 18.6, dP: 12.7, dH: 11.0, R: 7.6, R_outer: 10.0 },
    { name: 'Polydimethylsiloxane (PDMS)', dD: 15.9, dP: 0.1, dH: 4.7, R: 6.0, R_outer: 9.0 },
];

export const SOLVENT_DB_STATS = {
    total: HSP_SOLVENTS.length,
    solvPred: solvPredDb.length,
    core: CORE_SOLVENTS.length,
};
