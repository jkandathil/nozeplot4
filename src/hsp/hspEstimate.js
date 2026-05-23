/**
 * HSP estimation engines — HSPiP-style DIY calculator methods.
 *
 * Methods implemented (mirrors HSPiP Chapter 30):
 *   1. Physical properties  — δTot from ΔHv/MVol; δP from dipole (Beerbower);
 *                             δD from refractive index (Koenhen–Smolders); δH by difference
 *   2. Stefanis–Panayiotou  — UNIFAC 1st/2nd order group contribution
 *   3. van Krevelen         — Hoftyzer–van Krevelen with symmetry correction
 *   4. Hansen / Beerbower   — Table 1.1 group contributions (Hansen handbook)
 *   5. Hoy                  — Hoy group system with Lydersen aggregation (needs Tb)
 *   6. Polymer repeat unit  — S-P on n-mer oligomer SMILES / groups
 */

import { hspTotal } from './hspMath.js';
import {
    CGS_TO_MPA,
    SP_CONSTANTS,
    SP_FIRST_ORDER,
    SP_SECOND_ORDER,
    BEERBOWER_GROUPS,
    VK_GROUPS,
    HOY_GROUPS,
    HOY_BASE,
} from './hspGroupTables.js';

const J_PER_CAL = 4.184;
const RT_25C_J = 8.314 * 298.15; /* J/mol */

/** @typedef {{ dD:number, dP:number, dH:number, dT?:number, method:string, notes?:string[], warnings?:string[] }} HspEstimate */

/**
 * Sum group counts × table contributions.
 * @param {Record<string, number>} counts
 * @param {Record<string, object>} table
 * @param {'dD'|'dP'|'dH'|'lowDP'|'lowDH'} key
 */
function sumGroupContrib(counts, table, key) {
    let sum = 0;
    const warnings = [];
    for (const [name, n] of Object.entries(counts || {})) {
        const c = Math.max(0, Number(n) || 0);
        if (c === 0) continue;
        const row = table[name];
        if (!row) {
            warnings.push(`Unknown group "${name}"`);
            continue;
        }
        const v = row[key];
        if (v == null) {
            warnings.push(`No ${key} contribution for "${name}"`);
            continue;
        }
        sum += c * v;
    }
    return { sum, warnings };
}

/**
 * Method 1 — physical property correlations (HSPiP "enter enthalpy, MVol, RI, dipole").
 *
 * @param {{
 *   enthalpyVap?: number,  // kJ/mol at 25 °C
 *   molarVolume?: number,  // cm³/mol
 *   refractiveIndex?: number,
 *   dipoleMoment?: number, // Debye
 *   dDEstimate?: number,   // optional manual δD (MPa^½) if RI missing
 * }} props
 * @returns {HspEstimate}
 */
export function estimateFromPhysicalProps(props = {}) {
    const notes = [];
    const warnings = [];
    const V = Number(props.molarVolume);
    const Hv = Number(props.enthalpyVap); /* kJ/mol */
    const RI = Number(props.refractiveIndex);
    const mu = Number(props.dipoleMoment);
    const dDManual = Number(props.dDEstimate);

    if (!(V > 0)) {
        return { dD: 0, dP: 0, dH: 0, dT: 0, method: 'Physical properties', warnings: ['Molar volume required'] };
    }

    let dT = 0;
    if (Hv > 0) {
        const Ecoh = (Hv * 1000 - RT_25C_J) / V; /* J/cm³ */
        dT = Math.sqrt(Math.max(0, Ecoh / 1e6)); /* MPa^½ */
        notes.push(`δTot from ΔHv (${Hv} kJ/mol)`);
    } else {
        warnings.push('Enthalpy of vaporization not provided — δTot unavailable');
    }

    let dD = 0;
    if (RI > 1) {
        dD = (RI - 0.784) / 0.0395;
        notes.push('δD from refractive index (Koenhen–Smolders)');
    } else if (dDManual > 0) {
        dD = dDManual;
        notes.push('δD from manual estimate');
    } else {
        warnings.push('Provide RI or manual δD estimate');
    }

    let dP = 0;
    if (mu > 0) {
        dP = 36.1 * mu / Math.sqrt(V);
        notes.push('δP from dipole moment (Beerbower, HSPiP fit)');
    } else {
        warnings.push('Dipole moment not provided — δP unavailable');
    }

    let dH = 0;
    if (dT > 0 && dD > 0 && dP >= 0) {
        const rem = dT * dT - dD * dD - dP * dP;
        if (rem >= 0) {
            dH = Math.sqrt(rem);
            notes.push('δH by difference from δTot − δD − δP');
        } else {
            warnings.push('δD² + δP² > δTot² — check inputs');
        }
    }

    return {
        dD, dP, dH,
        dT: dT || hspTotal({ dD, dP, dH }),
        method: 'Physical properties',
        notes,
        warnings,
    };
}

/**
 * Method 2 — Stefanis–Panayiotou UNIFAC group contribution.
 *
 * @param {{
 *   firstOrder?: Record<string, number>,
 *   secondOrder?: Record<string, number>,
 *   useSecondOrder?: boolean,
 *   forceLowPolar?: boolean,
 *   forceLowHbond?: boolean,
 * }} opts
 */
export function estimateStefanisPanayiotou(opts = {}) {
    const first = opts.firstOrder || {};
    const second = opts.secondOrder || {};
    const use2 = opts.useSecondOrder !== false && Object.keys(second).some((k) => (second[k] || 0) > 0);
    const W = use2 ? 1 : 0;
    const warnings = [];

    const sumAxis = (table, key, lowKey) => {
        let s = 0;
        const r1 = sumGroupContrib(first, table, key);
        s += r1.sum;
        warnings.push(...r1.warnings);
        if (use2) {
            const r2 = sumGroupContrib(second, SP_SECOND_ORDER, key);
            s += r2.sum;
            warnings.push(...r2.warnings);
        }
        return s;
    };

    let rawD = sumAxis(SP_FIRST_ORDER, 'dD', 'dD') + SP_CONSTANTS.dD;
    let rawP = sumAxis(SP_FIRST_ORDER, 'dP', 'lowDP') + SP_CONSTANTS.dP;
    let rawH = sumAxis(SP_FIRST_ORDER, 'dH', 'lowDH') + SP_CONSTANTS.dH;

    if (opts.forceLowPolar || rawP < 3) {
        rawP = sumGroupContrib(first, SP_FIRST_ORDER, 'lowDP').sum
            + (use2 ? sumGroupContrib(second, SP_SECOND_ORDER, 'lowDP').sum : 0)
            + SP_CONSTANTS.dP_low;
    }
    if (opts.forceLowHbond || rawH < 3) {
        rawH = sumGroupContrib(first, SP_FIRST_ORDER, 'lowDH').sum
            + (use2 ? sumGroupContrib(second, SP_SECOND_ORDER, 'lowDH').sum : 0)
            + SP_CONSTANTS.dH_low;
    }

    const dD = Math.max(0, rawD);
    const dP = Math.max(0, rawP);
    const dH = Math.max(0, rawH);

    return {
        dD, dP, dH,
        dT: hspTotal({ dD, dP, dH }),
        method: `Stefanis–Panayiotou${use2 ? ' (2nd order)' : ''}`,
        notes: use2 ? ['Second-order UNIFAC groups included'] : ['First-order UNIFAC groups only'],
        warnings,
    };
}

/**
 * Method 3 — van Krevelen / Hoftyzer with symmetry correction on δP.
 *
 * @param {Record<string, number>} counts
 * @param {{ symmetryPlanes?: 0|1|2|3 }} [opts]
 */
export function estimateVanKrevelen(counts = {}, opts = {}) {
    const warnings = [];
    let V = 0, Fd = 0, Fp = 0, Eh = 0;
    for (const [name, n] of Object.entries(counts)) {
        const c = Math.max(0, Number(n) || 0);
        if (!c) continue;
        const g = VK_GROUPS[name];
        if (!g) { warnings.push(`Unknown VK group "${name}"`); continue; }
        V += c * g.V;
        Fd += c * g.Fd;
        Fp += c * g.Fp;
        Eh += c * g.Eh;
    }
    if (V <= 0) {
        return { dD: 0, dP: 0, dH: 0, dT: 0, method: 'van Krevelen', warnings: ['Zero molar volume'] };
    }

    const planes = opts.symmetryPlanes ?? 0;
    const sym = planes === 1 ? 0.5 : planes === 2 ? 0.25 : planes >= 3 ? 0 : 1;
    const symH = planes >= 3 ? 0 : 1;

    const dD = Math.sqrt(Math.max(0, Fd / V)) * CGS_TO_MPA;
    const dP = Math.sqrt(Math.max(0, Fp / V)) * CGS_TO_MPA * sym;
    const dH = Math.sqrt(Math.max(0, Eh / V)) * CGS_TO_MPA * symH;

    return {
        dD, dP, dH,
        dT: hspTotal({ dD, dP, dH }),
        method: 'van Krevelen',
        notes: planes > 0 ? [`Symmetry correction: ${planes} plane(s)`] : [],
        warnings,
    };
}

/**
 * Method 4 — Hansen / Beerbower Table 1.1 group contributions.
 *
 * @param {Record<string, number>} counts
 * @param {{ symmetryPlanes?: 0|1|2|3 }} [opts]
 */
export function estimateBeerbower(counts = {}, opts = {}) {
    const warnings = [];
    let V = 0, Ed = 0, Ep = 0, Eh = 0;
    for (const [name, n] of Object.entries(counts)) {
        const c = Math.max(0, Number(n) || 0);
        if (!c) continue;
        const g = BEERBOWER_GROUPS[name];
        if (!g) { warnings.push(`Unknown Beerbower group "${name}"`); continue; }
        V += c * g.V;
        Ed += c * g.Ed;
        Ep += c * g.Ep;
        Eh += c * g.Eh;
    }
    if (V <= 0) {
        return { dD: 0, dP: 0, dH: 0, dT: 0, method: 'Hansen / Beerbower', warnings: ['Zero molar volume'] };
    }

    const planes = opts.symmetryPlanes ?? 0;
    const sym = planes === 1 ? 0.5 : planes === 2 ? 0.25 : planes >= 3 ? 0 : 1;
    const symH = planes >= 3 ? 0 : 1;

    const dD = Math.sqrt(Math.max(0, Ed / V)) * CGS_TO_MPA;
    const dP = Math.sqrt(Math.max(0, Ep / V)) * CGS_TO_MPA * sym;
    const dH = Math.sqrt(Math.max(0, Eh / V)) * CGS_TO_MPA * symH;

    return {
        dD, dP, dH,
        dT: hspTotal({ dD, dP, dH }),
        method: 'Hansen / Beerbower',
        notes: planes > 0 ? [`Symmetry correction: ${planes} plane(s)`] : [],
        warnings,
    };
}

/**
 * Method 5 — Hoy group contribution (solvents).
 * Requires boiling point Tb (K) for the aggregation factor α.
 *
 * @param {Record<string, number>} counts
 * @param {{ boilingPointC?: number, repeatUnits?: number }} [opts]
 */
export function estimateHoy(counts = {}, opts = {}) {
    const warnings = [];
    let Ft = 0, Fp = 0, V = 0, T = 0;
    for (const [name, n] of Object.entries(counts)) {
        const c = Math.max(0, Number(n) || 0);
        if (!c) continue;
        const g = HOY_GROUPS[name];
        if (!g) { warnings.push(`Unknown Hoy group "${name}"`); continue; }
        Ft += c * g.Ft;
        Fp += c * g.Fp;
        V += c * g.V;
        T += c * g.T;
    }
    if (V <= 0) {
        return { dD: 0, dP: 0, dH: 0, dT: 0, method: 'Hoy', warnings: ['Zero molar volume'] };
    }

    const n = Math.max(1, opts.repeatUnits ?? 1);
    const Tb = opts.boilingPointC != null
        ? Number(opts.boilingPointC) + 273.15
        : estimateBoilingPointFromGroups(counts);

    const Tcr_ratio = 0.567 + T - (T / n) ** 2;
    const Tcr = Tb / Math.max(0.3, Tcr_ratio);
    const logAlpha = 3.39 * (Tb / Tcr) - 0.1585 - Math.log10(V);
    const alpha = Math.pow(10, logAlpha);

    const dT = Math.sqrt(Math.max(0, (Ft + HOY_BASE) / V));
    const dP = dT * Math.sqrt(Math.max(0, (1 / alpha) + (Fp / (Ft + HOY_BASE))));
    const dH = dT * Math.sqrt(Math.max(0, (alpha - 1) / alpha));
    const dD = Math.sqrt(Math.max(0, dT * dT - dP * dP - dH * dH));

    const notes = [];
    if (opts.boilingPointC == null) notes.push(`Tb estimated as ${(Tb - 273.15).toFixed(0)} °C from groups`);

    return {
        dD, dP, dH, dT,
        method: n > 1 ? `Hoy (polymer n=${n})` : 'Hoy',
        notes,
        warnings,
    };
}

/** Rough Tb estimate from group counts (Hoy-style additivity, °C baseline). */
function estimateBoilingPointFromGroups(counts) {
    let bp = 30;
    for (const [name, n] of Object.entries(counts)) {
        const c = Number(n) || 0;
        if (name === 'CH3') bp += c * 25;
        else if (name === 'CH2') bp += c * 22;
        else if (name.includes('OH')) bp += c * 55;
        else if (name.includes('COOH')) bp += c * 80;
        else if (name.includes('CHO') || name === '-HC=O') bp += c * 35;
        else if (name.includes('arom')) bp += c * 40;
    }
    return bp + 273.15;
}

/**
 * Run all applicable methods on the same group set and return comparison table.
 *
 * @param {{
 *   firstOrder?: Record<string, number>,
 *   secondOrder?: Record<string, number>,
 *   beerbower?: Record<string, number>,
 *   vanKrevelen?: Record<string, number>,
 *   hoy?: Record<string, number>,
 *   physical?: object,
 *   symmetryPlanes?: number,
 *   useSecondOrder?: boolean,
 *   boilingPointC?: number,
 *   repeatUnits?: number,
 * }} input
 */
export function estimateAllMethods(input = {}) {
    const first = input.firstOrder || {};
    const bb = input.beerbower || first;
    const vk = input.vanKrevelen || first;
    const hoy = input.hoy || first;
    const sym = input.symmetryPlanes ?? 0;

    const results = [];

    if (input.physical && (input.physical.molarVolume > 0)) {
        results.push(estimateFromPhysicalProps(input.physical));
    }

    if (Object.keys(first).length > 0) {
        results.push(estimateStefanisPanayiotou({
            firstOrder: first,
            secondOrder: input.secondOrder,
            useSecondOrder: input.useSecondOrder,
        }));
    }

    if (Object.keys(vk).length > 0) {
        results.push(estimateVanKrevelen(vk, { symmetryPlanes: sym }));
    }

    if (Object.keys(bb).length > 0) {
        results.push(estimateBeerbower(bb, { symmetryPlanes: sym }));
    }

    if (Object.keys(hoy).length > 0) {
        results.push(estimateHoy(hoy, {
            boilingPointC: input.boilingPointC,
            repeatUnits: input.repeatUnits,
        }));
    }

    return results;
}

/**
 * Surface tension estimate from HSP + molar volume (Koenhen–Smolders, HSPiP).
 * @param {{ dD:number, dP:number, dH:number, molarVolume:number }} p
 * @returns {number} mN/m
 */
export function estimateSurfaceTension(p) {
    const V = Number(p.molarVolume);
    if (!(V > 0)) return NaN;
    const term = 2.28 * p.dD ** 2 + p.dP ** 2 + p.dH ** 2;
    return 0.0146 * term * V ** 0.2;
}

/**
 * Teas fractional parameters (fd, fp, fh) as percentages summing to ~100.
 */
export function hspToTeas(p) {
    const sum = (p.dD ?? 0) + (p.dP ?? 0) + (p.dH ?? 0);
    if (sum <= 0) return { fd: 0, fp: 0, fh: 0 };
    return {
        fd: (100 * (p.dD ?? 0)) / sum,
        fp: (100 * (p.dP ?? 0)) / sum,
        fh: (100 * (p.dH ?? 0)) / sum,
    };
}

/**
 * Merge group count maps (for copolymers).
 * @param {Record<string, number>[]} maps
 * @param {number[]} [weights] volume or mole fractions (normalised)
 */
export function mergeGroupCounts(maps, weights) {
    const w = weights?.length === maps.length
        ? weights.map((x) => Math.max(0, Number(x) || 0))
        : maps.map(() => 1);
    const wsum = w.reduce((a, b) => a + b, 0) || 1;
    const out = {};
    maps.forEach((m, i) => {
        const f = w[i] / wsum;
        for (const [k, v] of Object.entries(m || {})) {
            out[k] = (out[k] || 0) + f * (Number(v) || 0);
        }
    });
    return out;
}
