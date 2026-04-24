/**
 * Auto-measurement helpers for Circuit Studio plots.
 *
 * All functions are pure and operate on plain arrays so they can be
 * unit-tested outside the React tree. They intentionally live in
 * `src/circuit` rather than `src/components` because they're really
 * bits of signal-processing logic, not UI primitives.
 *
 *   Transient:
 *     steadyStateEst(y)            → final-value estimate (last 5 % mean)
 *     peakToPeak(y)                → max − min
 *     riseTime(t, y)               → 10 % → 90 % rise (first transition)
 *     fallTime(t, y)               → 90 % → 10 % fall (first transition)
 *     settlingTime(t, y, tolFrac)  → last |y−ss| > tol · |ss−y0|
 *     overshoot(y)                 → (max − ss) / (ss − y0)  in %
 *
 *   AC:
 *     corner3dB(f, mag)            → first frequency where mag drops 3 dB below peak
 *     peakGain(f, mag)             → peak magnitude in dB (linear input in V)
 *     unityGainFreq(f, mag)        → first frequency where mag crosses unity (0 dB)
 *     phaseMargin(f, mag, phase)   → 180 + phase at unity-gain freq
 *     gainMargin(f, mag, phase)    → −mag(dB) at first −180° crossing
 *
 *   Utility:
 *     sampleAt(xArr, yArr, x)      → linearly-interpolated y value at x
 */

// ---------------------------------------------------------------
// Transient helpers
// ---------------------------------------------------------------

export function steadyStateEst(y) {
    if (!y || y.length === 0) return NaN;
    const n = y.length;
    // Average over the last 5 % of samples, minimum of 5.
    const tailCount = Math.max(5, Math.round(n * 0.05));
    const start = Math.max(0, n - tailCount);
    let sum = 0;
    for (let i = start; i < n; i++) sum += y[i];
    return sum / (n - start);
}

export function peakToPeak(y) {
    if (!y || y.length === 0) return NaN;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < y.length; i++) {
        if (y[i] < min) min = y[i];
        if (y[i] > max) max = y[i];
    }
    return max - min;
}

/** Linear-interpolate t at which y crosses `target` (assumes monotonic
 *  segment between idx-1 and idx). */
function interpCross(t, y, idx, target) {
    if (idx <= 0) return t[0];
    const t0 = t[idx - 1]; const t1 = t[idx];
    const y0 = y[idx - 1]; const y1 = y[idx];
    if (y1 === y0) return t1;
    return t0 + (target - y0) * (t1 - t0) / (y1 - y0);
}

/** Rise time: 10 % → 90 % of the first step from initial to steady-state. */
export function riseTime(t, y) {
    if (!t || !y || t.length < 3) return NaN;
    const y0 = y[0];
    const ss = steadyStateEst(y);
    const delta = ss - y0;
    if (Math.abs(delta) < 1e-18) return NaN;

    const lo = y0 + 0.1 * delta;
    const hi = y0 + 0.9 * delta;
    const rising = delta > 0;

    let tLo = NaN; let tHi = NaN;
    for (let i = 1; i < y.length; i++) {
        if (Number.isNaN(tLo)) {
            const crossed = rising ? (y[i - 1] < lo && y[i] >= lo)
                                   : (y[i - 1] > lo && y[i] <= lo);
            if (crossed) tLo = interpCross(t, y, i, lo);
        } else if (Number.isNaN(tHi)) {
            const crossed = rising ? (y[i - 1] < hi && y[i] >= hi)
                                   : (y[i - 1] > hi && y[i] <= hi);
            if (crossed) { tHi = interpCross(t, y, i, hi); break; }
        }
    }
    if (Number.isNaN(tLo) || Number.isNaN(tHi)) return NaN;
    return tHi - tLo;
}

/** Fall time: 90 % → 10 % of the first step when the signal moves
 *  from initial toward steady-state in the *opposite* direction.
 *  (If the first transition is a rise, this returns NaN.) */
export function fallTime(t, y) {
    if (!t || !y || t.length < 3) return NaN;
    const y0 = y[0];
    const ss = steadyStateEst(y);
    const delta = ss - y0;
    if (Math.abs(delta) < 1e-18) return NaN;
    if (delta > 0) return NaN;

    const hi = y0 + 0.1 * delta; // "10 %" crossing (further from y0)
    const lo = y0 + 0.9 * delta; // "90 %" crossing (closer to y0)

    let tHi = NaN; let tLo = NaN;
    for (let i = 1; i < y.length; i++) {
        if (Number.isNaN(tHi)) {
            if (y[i - 1] > lo && y[i] <= lo) tHi = interpCross(t, y, i, lo);
        } else if (Number.isNaN(tLo)) {
            if (y[i - 1] > hi && y[i] <= hi) { tLo = interpCross(t, y, i, hi); break; }
        }
    }
    if (Number.isNaN(tHi) || Number.isNaN(tLo)) return NaN;
    return tLo - tHi;
}

/** Settling time: time until |y − steady-state| stays below
 *  `tolFrac · |ss − y0|` (default 5 %). */
export function settlingTime(t, y, tolFrac = 0.05) {
    if (!t || !y || t.length < 3) return NaN;
    const y0 = y[0];
    const ss = steadyStateEst(y);
    const delta = Math.abs(ss - y0);
    if (delta < 1e-18) return NaN;
    const tol = tolFrac * delta;

    // Walk backwards: the settling time is the last t at which
    // |y[i] − ss| exceeds tolerance.
    let lastOutside = -1;
    for (let i = 0; i < y.length; i++) {
        if (Math.abs(y[i] - ss) > tol) lastOutside = i;
    }
    if (lastOutside < 0) return 0;
    if (lastOutside >= y.length - 1) return NaN; // never settled
    return t[lastOutside + 1];
}

/** Percent overshoot relative to the step from y0 → ss. */
export function overshoot(y) {
    if (!y || y.length < 3) return NaN;
    const y0 = y[0];
    const ss = steadyStateEst(y);
    const delta = ss - y0;
    if (Math.abs(delta) < 1e-18) return NaN;

    if (delta > 0) {
        let peak = -Infinity;
        for (let i = 0; i < y.length; i++) if (y[i] > peak) peak = y[i];
        return Math.max(0, (peak - ss) / delta) * 100;
    } else {
        let trough = Infinity;
        for (let i = 0; i < y.length; i++) if (y[i] < trough) trough = y[i];
        return Math.max(0, (ss - trough) / (-delta)) * 100;
    }
}

// ---------------------------------------------------------------
// AC helpers — expect `mag` already in LINEAR units (|H|); the
// UI converts to dB for display.
// ---------------------------------------------------------------

/** First frequency where magnitude drops 3 dB below the peak.
 *  Returns NaN if the signal never drops 3 dB below peak. */
export function corner3dB(f, mag) {
    if (!f || !mag || f.length < 2) return NaN;
    let peakIdx = 0;
    for (let i = 0; i < mag.length; i++) if (mag[i] > mag[peakIdx]) peakIdx = i;
    const peak = mag[peakIdx];
    const target = peak / Math.SQRT2; // −3 dB = 1/√2
    // Search forward from the peak for the first crossing below target.
    for (let i = peakIdx + 1; i < mag.length; i++) {
        if (mag[i - 1] >= target && mag[i] < target) {
            // Log-interpolate in frequency, linear in dB.
            const m0 = 20 * Math.log10(Math.max(mag[i - 1], 1e-18));
            const m1 = 20 * Math.log10(Math.max(mag[i], 1e-18));
            const tgt = 20 * Math.log10(target);
            const logf0 = Math.log10(f[i - 1]);
            const logf1 = Math.log10(f[i]);
            if (m1 === m0) return f[i];
            const logf = logf0 + (tgt - m0) * (logf1 - logf0) / (m1 - m0);
            return Math.pow(10, logf);
        }
    }
    return NaN;
}

export function peakGain(mag) {
    if (!mag || mag.length === 0) return NaN;
    let peak = 0;
    for (let i = 0; i < mag.length; i++) if (mag[i] > peak) peak = mag[i];
    return peak === 0 ? NaN : 20 * Math.log10(peak);
}

/** Unity-gain crossover: first frequency where |H| = 1 (0 dB). */
export function unityGainFreq(f, mag) {
    if (!f || !mag || f.length < 2) return NaN;
    for (let i = 1; i < mag.length; i++) {
        if ((mag[i - 1] > 1 && mag[i] <= 1) || (mag[i - 1] < 1 && mag[i] >= 1)) {
            const m0 = 20 * Math.log10(Math.max(mag[i - 1], 1e-18));
            const m1 = 20 * Math.log10(Math.max(mag[i], 1e-18));
            const logf0 = Math.log10(f[i - 1]);
            const logf1 = Math.log10(f[i]);
            if (m1 === m0) return f[i];
            const logf = logf0 + (0 - m0) * (logf1 - logf0) / (m1 - m0);
            return Math.pow(10, logf);
        }
    }
    return NaN;
}

/** Phase margin: 180 + phase(at unity-gain freq). Returns NaN if no
 *  unity crossover. Phase array expected in degrees. */
export function phaseMargin(f, mag, phase) {
    const fug = unityGainFreq(f, mag);
    if (!Number.isFinite(fug)) return NaN;
    const p = sampleAt(f, phase, fug);
    if (!Number.isFinite(p)) return NaN;
    return 180 + p;
}

/** Gain margin: −mag(dB) at the first frequency where phase crosses
 *  −180° (useful for assessing stability in feedback systems). */
export function gainMargin(f, mag, phase) {
    if (!f || !mag || !phase || f.length < 2) return NaN;
    for (let i = 1; i < phase.length; i++) {
        if (phase[i - 1] > -180 && phase[i] <= -180) {
            const fAt = interpLogFreq(f, i, phase, -180);
            const m = sampleAt(f, mag, fAt);
            if (!Number.isFinite(m) || m <= 0) return NaN;
            return -20 * Math.log10(m);
        }
    }
    return NaN;
}

// ---------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------

/** Linear-interpolated lookup: returns y at x by searching a
 *  monotonically-increasing x-array. Clips to ends. */
export function sampleAt(xArr, yArr, x) {
    if (!xArr || !yArr || xArr.length === 0) return NaN;
    if (x <= xArr[0]) return yArr[0];
    if (x >= xArr[xArr.length - 1]) return yArr[yArr.length - 1];
    // Binary search.
    let lo = 0; let hi = xArr.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xArr[mid] <= x) lo = mid; else hi = mid;
    }
    const x0 = xArr[lo]; const x1 = xArr[hi];
    const y0 = yArr[lo]; const y1 = yArr[hi];
    if (x1 === x0) return y0;
    return y0 + (x - x0) * (y1 - y0) / (x1 - x0);
}

function interpLogFreq(f, idx, arr, target) {
    const v0 = arr[idx - 1]; const v1 = arr[idx];
    if (v1 === v0) return f[idx];
    const logf0 = Math.log10(f[idx - 1]);
    const logf1 = Math.log10(f[idx]);
    const logf = logf0 + (target - v0) * (logf1 - logf0) / (v1 - v0);
    return Math.pow(10, logf);
}
