/**
 * Goal seek on AC stability metrics by adjusting one sweepable element (R/C/L/V/I).
 */

import { buildContext, setElementValue, solveAC } from './solver.js';
import { phaseMargin, gainMargin } from './measurements.js';

export function nodeVoltageIndex(parsed, nodeName) {
    const want = String(nodeName || '').trim().toLowerCase();
    if (!want) return -1;
    for (let i = 1; i < parsed.nNodes; i++) {
        const n = parsed.nodeNames[i];
        if (String(n || `n${i}`).toLowerCase() === want) return i - 1;
    }
    return -1;
}

function metricAtFreqs(f, mag, phase, metric) {
    const m = metric === 'gm' ? 'gm' : 'pm';
    if (m === 'gm') return gainMargin(f, mag, phase);
    return phaseMargin(f, mag, phase);
}

export function stabilityMetricAt(parsed, acDir, elementRef, value, nodeIdx, metric) {
    const ctx = buildContext(parsed);
    if (!setElementValue(ctx, elementRef, value)) {
        throw new Error(`Goal seek: no sweepable element "${elementRef}" (use R, C, L, V, or I).`);
    }
    const ac = solveAC(ctx, acDir);
    const row = ac.V[nodeIdx];
    const mag = new Array(row.length);
    const phase = new Array(row.length);
    for (let i = 0; i < row.length; i++) {
        const s = row[i];
        mag[i] = Math.hypot(s.re, s.im);
        phase[i] = Math.atan2(s.im, s.re) * 180 / Math.PI;
    }
    return metricAtFreqs(ac.freqs, mag, phase, metric);
}

/**
 * Bisection on f(x) = metric(x) − target.
 *   metric `'pm'` → target in degrees; `'gm'` → target in dB (gain margin).
 */
export function goalSeekAcStabilityTarget({
    parsed, acDir, elementRef, lo, hi, observeNode,
    metric = 'pm',
    target,
    relBracket = 1e-4, maxIter = 60,
}) {
    const nodeIdx = nodeVoltageIndex(parsed, observeNode);
    if (nodeIdx < 0) throw new Error(`Goal seek: unknown observe node "${observeNode}"`);
    const tgt = Number(target);
    if (!Number.isFinite(tgt)) throw new Error('Goal seek: target must be a finite number.');
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
        throw new Error('Goal seek: low and high values must be finite and distinct.');
    }
    const m = metric === 'gm' ? 'gm' : 'pm';

    const fn = (x) => stabilityMetricAt(parsed, acDir, elementRef, x, nodeIdx, m) - tgt;
    let a = lo;
    let b = hi;
    let fa = fn(a);
    let fb = fn(b);
    if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
        throw new Error(
            `Goal seek: ${m === 'gm' ? 'gain' : 'phase'} margin is not finite at one or both ends — check AC stimulus and bracket.`,
        );
    }
    if (Math.abs(fa) < 0.05) {
        const achieved = stabilityMetricAt(parsed, acDir, elementRef, a, nodeIdx, m);
        return { value: a, achieved };
    }
    if (Math.abs(fb) < 0.05) {
        const achieved = stabilityMetricAt(parsed, acDir, elementRef, b, nodeIdx, m);
        return { value: b, achieved };
    }
    if (fa * fb > 0) {
        throw new Error(
            `Goal seek: ${m === 'gm' ? 'GM' : 'PM'} at both ends lies on the same side of the target — widen the bracket or pick another component.`,
        );
    }

    let lastMid = (a + b) / 2;
    for (let iter = 0; iter < maxIter; iter++) {
        const mid = (a + b) / 2;
        lastMid = mid;
        const fm = fn(mid);
        if (!Number.isFinite(fm)) throw new Error(`Goal seek: non-finite ${m === 'gm' ? 'GM' : 'PM'} inside the bracket.`);
        const span = Math.abs(b - a);
        const scale = Math.max(Math.abs(a), Math.abs(b), 1e-18);
        if (span <= relBracket * scale || Math.abs(fm) < 0.05) {
            const achieved = stabilityMetricAt(parsed, acDir, elementRef, mid, nodeIdx, m);
            return { value: mid, achieved };
        }
        if (fa * fm <= 0) {
            b = mid;
            fb = fm;
        } else {
            a = mid;
            fa = fm;
        }
    }
    const achieved = stabilityMetricAt(parsed, acDir, elementRef, lastMid, nodeIdx, m);
    return { value: lastMid, achieved };
}

/** @deprecated Use {@link goalSeekAcStabilityTarget} with metric `'pm'`. Returns scalar value only. */
export function goalSeekPhaseMarginTarget({
    parsed, acDir, elementRef, lo, hi, targetPmDeg, observeNode,
    relBracket, maxIter,
}) {
    const { value } = goalSeekAcStabilityTarget({
        parsed,
        acDir,
        elementRef,
        lo,
        hi,
        observeNode,
        metric: 'pm',
        target: targetPmDeg,
        relBracket,
        maxIter,
    });
    return value;
}
