/**
 * SMILES → UNIFAC first-order group counter (HSPiP Y-MB lite).
 *
 * Heuristic pattern matcher — not a full cheminformatics engine, but sufficient
 * for common solvents, monomers, and polymer repeat units. Users can always
 * override counts in the Calculator UI.
 *
 * Polymer attachment points: `0`, `[*]`, `*` at chain ends (HSPiP convention).
 */

/** Strip polymer wildcards and normalize aromaticity markers. */
export function normalizeSmiles(smiles) {
    return String(smiles || '')
        .replace(/\[\*\]/g, '0')
        .replace(/\*/g, '0')
        .replace(/\s/g, '')
        .trim();
}

/**
 * Expand a repeat unit SMILES to an n-mer oligomer for HSP estimation.
 * Joins at `0` attachment points; falls back to linear concatenation.
 *
 * @param {string} repeatUnit
 * @param {number} nMer 1–12
 */
export function expandPolymerSmiles(repeatUnit, nMer = 1) {
    const n = Math.max(1, Math.min(12, Math.floor(Number(nMer) || 1)));
    const unit = normalizeSmiles(repeatUnit);
    if (n === 1) return unit;

    const attachCount = (unit.match(/0/g) || []).length;
    if (attachCount === 2) {
        const core = unit.replace(/0/g, '');
        return '0' + core.repeat(n) + '0';
    }
    if (attachCount === 0) {
        return unit.repeat(n);
    }
    return unit.repeat(n);
}

/**
 * Count UNIFAC first-order groups from a SMILES string.
 * Returns { groups, warnings, molecularWeight }.
 *
 * @param {string} smiles
 * @returns {{ groups: Record<string, number>, warnings: string[], formula?: string }}
 */
export function smilesToUnifacGroups(smiles) {
    const warnings = [];
    let s = normalizeSmiles(smiles);
    if (!s) return { groups: {}, warnings: ['Empty SMILES'] };

    s = s.replace(/0/g, '');
    const groups = {};

    const add = (name, n = 1) => {
        if (n > 0) groups[name] = (groups[name] || 0) + n;
    };

    /* --- Specific functional groups (order matters) --- */
    const patterns = [
        [/C\(=O\)O[^=]/g, 'COOH', 1],
        [/OC\(=O\)/g, 'CH3COO', 1],
        [/C\(=O\)OC/g, 'CH2COO', 1],
        [/C\(=O\)C/g, 'CH3CO', 1],
        [/C\(=O\)[^OC]/g, 'CH2CO', 1],
        [/C=O/g, 'CHO (aldehydes)', 1],
        [/C#N/g, 'CH2CN', 1],
        [/N\(C\)=O/g, 'CON(CH3)2', 1],
        [/NC\(=O\)/g, 'CONH2', 1],
        [/O=C=N/g, 'O=C=N-', 1],
        [/NO2/g, 'ACNO2', 1],
        [/S\(=O\)=O/g, 'SO2', 1],
        [/C\(=S\)/g, '>C=S', 1],
        [/CF3/g, 'CF3', 1],
        [/CCl3/g, 'CCl3', 1],
        [/CCl2/g, 'CCl2', 1],
        [/CHCl2/g, 'CHCl2', 1],
        [/CF2/g, 'CF2', 1],
        [/OCCO/g, 'C2H5O2', 1],
    ];

    let scratch = s;
    for (const [re, name, per] of patterns) {
        const m = scratch.match(re);
        if (m) {
            add(name, m.length * per);
            scratch = scratch.replace(re, '§'.repeat(m[0].length));
        }
    }

    /* Aromatic rings — count benzenoid */
    const plainArom = (scratch.match(/c/gi) || []).length;
    if (plainArom >= 6) {
        const rings = Math.floor(plainArom / 6);
        add('ACH', rings * 4);
        add('AC', rings * 2);
        add('ACCH3', (scratch.match(/c\(C\)/gi) || []).length);
        scratch = scratch.replace(/c/gi, 'C');
    }

    /* Alcohol / ether / amine — detect -OH before stripping */
    const ohMatch = scratch.match(/O(?=H|$)|OH/g) || [];
    const ohCount = (scratch.match(/OH/g) || []).length + (scratch.match(/O(?![H\(=])/g) || []).length;
    if (ohCount) add('OH', Math.min(ohCount, 2));
    scratch = scratch.replace(/OH/g, '§');
    scratch = scratch.replace(/O(?![\(=])/g, '§');

    const nh2 = (scratch.match(/NH2/g) || []).length;
    if (nh2) add('CH2NH2', nh2);

    /* Halogen */
    for (const [sym, grp] of [['Cl', 'CH2Cl'], ['Br', 'Br'], ['I', 'I'], ['F', 'F (except above)']]) {
        const c = (scratch.match(new RegExp(sym, 'g')) || []).length;
        if (c) add(grp, c);
    }

    /* Double / triple bonds */
    const triple = (scratch.match(/#/g) || []).length;
    if (triple) add('C≡C', Math.ceil(triple / 2));

    const double = (scratch.match(/=/g) || []).length;
    if (double) add('-CH=CH-', Math.ceil(double / 2));

    /* Aliphatic carbons — partition remaining C tokens */
    let cTokens = (scratch.match(/C/g) || []).length;
    const branchC = (scratch.match(/C\(C\)/g) || []).length;
    if (branchC) {
        add('>C<', branchC);
        cTokens -= branchC * 2;
    }
    if (cTokens >= 3) {
        add('CH3', 1);
        add('CH2', cTokens - 2);
    } else if (cTokens === 2) {
        add('CH3', 1);
        add('CH2', 1);
    } else if (cTokens === 1) {
        add('CH3', 1);
    }

    /* Map to simpler Beerbower / VK / Hoy names */
    const mapped = mapToLegacyGroups(groups);

    if (Object.keys(groups).length === 0) {
        warnings.push('Could not parse groups — enter manually or check SMILES');
    }

    return { groups, mapped, warnings, smiles: normalizeSmiles(smiles) };
}

/**
 * Map UNIFAC names to Hansen/Beerbower, VK, Hoy table keys.
 */
export function mapToLegacyGroups(unifac) {
    const bb = {};
    const vk = {};
    const hoy = {};
    const alias = {
        CH3: ['CH3', 'CH3', 'CH3'],
        CH2: ['CH2', 'CH2', 'CH2'],
        'CH<': ['CH<', 'CH<', 'CH<'],
        '>C<': ['>C<', '>C<', '>C<'],
        'CH2=CH-': ['CH2=', 'CH2=', 'CH2='],
        '-CH=CH-': ['-CH=', '-CH=', '-CH='],
        OH: ['-OH', '-OH', '-OH (sec)'],
        'CH3COO': ['-COO-', '-COO-', '-COO-'],
        COOH: ['-COOH', '-COOH', '-COOH'],
        'CH2CO': ['>CO', '>CO', '>CO'],
        'CHO (aldehydes)': ['-CHO', '-CHO', '-HC=O'],
        'CH2O': ['-O-', '-O-', '-O-'],
        ACH: ['Phenyl', 'Phenyl', 'CH (arom)'],
        AC: ['Phenyl', 'Phenyl', 'C (arom)'],
        ACCH3: ['CH3', 'CH3', 'CH3'],
        Br: ['-Br', '-Br', '-Br (aliph)'],
        'CH2Cl': ['-Cl', '-Cl', '-Cl (prim)'],
        'CH2CN': ['-CN', '-CN', '-CN'],
        'CH2NH2': ['-NH2', '-NH2', '-NH2'],
    };

    for (const [name, count] of Object.entries(unifac || {})) {
        const c = Number(count) || 0;
        if (!c) continue;
        const [b, v, h] = alias[name] || [null, null, null];
        if (b) bb[b] = (bb[b] || 0) + c;
        if (v) vk[v] = (vk[v] || 0) + c;
        if (h) hoy[h] = (hoy[h] || 0) + c;
    }
    return { beerbower: bb, vanKrevelen: vk, hoy };
}

/** Known SMILES → name for quick lookup in UI. */
export const SMILES_EXAMPLES = {
    'CCO': 'Ethanol',
    'CC(=O)C': 'Acetone',
    'CCOC(=O)C': 'Ethyl acetate',
    'CCCCCC': 'n-Hexane',
    'c1ccccc1': 'Benzene',
    'CC(C)O': 'iso-Propanol',
    'CCCCCC=O': '1-Hexanal',
    'CC(=O)O': 'Acetic acid',
    '0CC0': 'Polyethylene repeat unit',
    '0CC(c1ccccc1)0': 'Polystyrene repeat unit',
    '0CC(C)(C(=O)OC)0': 'PMMA repeat unit',
};
