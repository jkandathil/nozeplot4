/**
 * Solvent suggestion engine — find solvents matching a Hansen sphere.
 */

import { hspRa, hspRED, hspSolubilityZone } from './hspMath.js';

/**
 * Rank solvents by compatibility with a sphere.
 *
 * @param {Array<object>} solvents
 * @param {{ dD,dP,dH,R, R_inner?, R_outer? }} sphere
 * @param {{
 *   maxRED?: number,
 *   zone?: 'good'|'marginal'|'any',
 *   categories?: string[],
 *   excludeNames?: string[],
 *   bpMin?: number,
 *   bpMax?: number,
 *   sortBy?: 'RED'|'Ra'|'name'|'bp',
 *   limit?: number,
 * }} [opts]
 */
export function suggestSolvents(solvents, sphere, opts = {}) {
    const maxRED = opts.maxRED ?? 1.0;
    const zone = opts.zone ?? 'good';
    const cats = opts.categories?.length ? new Set(opts.categories) : null;
    const exclude = new Set((opts.excludeNames || []).map((n) => n.toLowerCase()));
    const sortBy = opts.sortBy ?? 'RED';
    const limit = opts.limit ?? 200;

    const rows = [];
    for (const s of solvents || []) {
        if (!s?.name) continue;
        if (exclude.has(s.name.toLowerCase())) continue;
        if (cats && !cats.has(s.category)) continue;
        if (opts.bpMin != null && s.bp < opts.bpMin) continue;
        if (opts.bpMax != null && s.bp > opts.bpMax) continue;

        const pt = { dD: s.dD, dP: s.dP, dH: s.dH };
        const Ra = hspRa(pt, sphere);
        const RED = hspRED(pt, sphere);
        const z = hspSolubilityZone(pt, sphere);

        if (zone === 'good' && z !== 'good') continue;
        if (zone === 'marginal' && z === 'bad') continue;
        if (RED > maxRED && zone === 'good') continue;

        rows.push({ ...s, Ra, RED, zone: z });
    }

    const dir = sortBy === 'name' ? 1 : -1;
    rows.sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        if (sortBy === 'bp') return (a.bp ?? 0) - (b.bp ?? 0);
        if (sortBy === 'Ra') return a.Ra - b.Ra;
        return a.RED - b.RED;
    });

    return rows.slice(0, limit);
}

/**
 * Greedy multi-solvent blend suggestion toward target HSP (SolvPred-lite).
 * Picks up to `n` solvents whose volume-fraction blend minimizes Ra to target.
 */
export function suggestBlendSolvents(solvents, target, n = 4) {
    const pool = suggestSolvents(solvents, { ...target, R: 999 }, {
        maxRED: 5,
        zone: 'any',
        sortBy: 'Ra',
        limit: 40,
    });
    if (pool.length === 0) return [];
    const picked = [pool[0]];
    while (picked.length < n && picked.length < pool.length) {
        let best = null;
        let bestRa = Infinity;
        for (const cand of pool) {
            if (picked.some((p) => p.name === cand.name)) continue;
            const trial = [...picked, cand];
            const phi = 1 / trial.length;
            let dD = 0, dP = 0, dH = 0;
            for (const t of trial) {
                dD += phi * t.dD;
                dP += phi * t.dP;
                dH += phi * t.dH;
            }
            const Ra = hspRa({ dD, dP, dH }, target);
            if (Ra < bestRa) {
                bestRa = Ra;
                best = cand;
            }
        }
        if (best) picked.push(best);
        else break;
    }
    return picked;
}
