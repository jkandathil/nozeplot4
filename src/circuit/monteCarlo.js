/**
 * Monte Carlo tolerance on passive R/C/L values for AC analysis.
 */

import { buildContext, solveAC } from './solver.js';
import { phaseMargin } from './measurements.js';
import { nodeVoltageIndex } from './goalSeek.js';

export function perturbMonteRclUniform(ctx, tolPercent) {
    const u = Math.max(0, Number(tolPercent) || 0) / 100;
    if (u <= 0) return;
    for (const el of ctx.elems) {
        if (el.type === 'R' || el.type === 'C' || el.type === 'L') {
            el.value *= 1 + u * (2 * Math.random() - 1);
        }
    }
}

export function montePhaseMarginsForNode(runs, nodeIdx) {
    return runs.map((r) => {
        const row = r.ac.V[nodeIdx];
        const mag = new Array(row.length);
        const phase = new Array(row.length);
        for (let i = 0; i < row.length; i++) {
            const s = row[i];
            mag[i] = Math.hypot(s.re, s.im);
            phase[i] = Math.atan2(s.im, s.re) * 180 / Math.PI;
        }
        return phaseMargin(r.ac.freqs, mag, phase);
    });
}

function branchNameFromElem(el) {
    if (/^VIP\d+/i.test(el.name)) return el.name.slice(1);
    return el.name;
}

/**
 * @param {Array<{ ac: ReturnType<typeof solveAC> }>} runs
 * @param {object} parsed parseNetlist output
 * @param {object} ctx  any post-run context with branchElems (e.g. last buildContext)
 * @param {object} meta { runs, tolPercent, pmNode, phaseMargins, pmStats }
 */
export function buildMonteAcResult(runs, parsed, ctx, meta) {
    if (!runs?.length) throw new Error('Monte Carlo: no runs.');
    const nFreq = runs[0].ac.freqs.length;
    const nn = parsed.nNodes - 1;
    const signals = [];
    const freqs = runs[0].ac.freqs;

    for (let ni = 0; ni < nn; ni++) {
        const mag = new Float64Array(nFreq);
        const phase = new Float64Array(nFreq);
        for (let fi = 0; fi < nFreq; fi++) {
            let sre = 0;
            let sim = 0;
            for (let r = 0; r < runs.length; r++) {
                const s = runs[r].ac.V[ni][fi];
                sre += s.re;
                sim += s.im;
            }
            sre /= runs.length;
            sim /= runs.length;
            mag[fi] = Math.hypot(sre, sim);
            phase[fi] = Math.atan2(sim, sre) * 180 / Math.PI;
        }
        const nodeNm = parsed.nodeNames[ni + 1] || `n${ni + 1}`;
        signals.push({
            name: `V(${nodeNm})`,
            kind: 'ac',
            f: freqs,
            mag,
            phase,
            baseNode: nodeNm,
        });
    }

    const branchElems = ctx?.branchElems || [];
    const res0 = runs[0].ac;
    if (res0.branchI) {
        for (let b = 0; b < branchElems.length && b < res0.branchI.length; b++) {
            const mag = new Float64Array(nFreq);
            const phase = new Float64Array(nFreq);
            for (let fi = 0; fi < nFreq; fi++) {
                let sre = 0;
                let sim = 0;
                for (let r = 0; r < runs.length; r++) {
                    const s = runs[r].ac.branchI[b][fi];
                    sre += s.re;
                    sim += s.im;
                }
                sre /= runs.length;
                sim /= runs.length;
                mag[fi] = Math.hypot(sre, sim);
                phase[fi] = Math.atan2(sim, sre) * 180 / Math.PI;
            }
            const nm = branchNameFromElem(branchElems[b]);
            signals.push({
                name: `I(${nm})`,
                kind: 'ac',
                f: freqs,
                mag,
                phase,
                baseBranch: nm,
            });
        }
    }

    return {
        kind: 'ac',
        f: freqs,
        signals,
        step: null,
        monte: meta,
    };
}

export function runMonteAcSamples(parsed, acDir, nRuns, tolPercent) {
    const runs = [];
    for (let k = 0; k < nRuns; k++) {
        const ctx = buildContext(parsed);
        perturbMonteRclUniform(ctx, tolPercent);
        runs.push({ stepValue: null, ac: solveAC(ctx, acDir) });
    }
    return runs;
}

export function summarizePhaseMargins(pms) {
    const finite = pms.filter((x) => Number.isFinite(x));
    if (!finite.length) {
        return { min: NaN, max: NaN, mean: NaN, std: NaN };
    }
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const x of finite) {
        if (x < min) min = x;
        if (x > max) max = x;
        sum += x;
    }
    const mean = sum / finite.length;
    let varSum = 0;
    for (const x of finite) {
        const d = x - mean;
        varSum += d * d;
    }
    const std = Math.sqrt(varSum / finite.length);
    return { min, max, mean, std };
}

export function buildMonteMetaFromRuns(runs, parsed, pmNode) {
    const idx = nodeVoltageIndex(parsed, pmNode);
    const phaseMargins = idx >= 0 ? montePhaseMarginsForNode(runs, idx) : [];
    const pmStats = summarizePhaseMargins(phaseMargins);
    return {
        runs: runs.length,
        tolPercent: null,
        pmNode: idx >= 0 ? String(pmNode).trim() : null,
        phaseMargins,
        pmStats,
    };
}
