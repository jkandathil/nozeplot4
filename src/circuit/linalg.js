/**
 * Dense linear algebra helpers for the Circuit Studio solver.
 *
 * We keep the implementation deliberately small and dependency-free —
 * MNA matrices for hand-designed analog circuits are typically
 * ≤ 50×50, so a plain Gaussian-elimination with partial pivoting is
 * faster than pulling in a sparse library and is exact enough for
 * Newton-Raphson iteration to converge.
 *
 * Two solvers live here:
 *   • solveReal(A, b)   — standard double-precision Gaussian elimination.
 *   • solveComplex(A,b) — same algorithm on a 2-array {re, im} representation,
 *                         used by AC analysis (frequency-domain MNA).
 *
 * Both mutate the caller's matrices — that's intentional and lets the
 * solver reuse allocations from one Newton iteration to the next.
 */

/** Solve A x = b where A is n×n, returning x as a Float64Array of length n. */
export function solveReal(A, b) {
    const n = b.length;
    for (let k = 0; k < n; k++) {
        // Partial pivot — pick the row with the largest |A[i][k]| to avoid
        // catastrophic cancellation when small diagonals appear during LU.
        let piv = k;
        let maxAbs = Math.abs(A[k][k]);
        for (let i = k + 1; i < n; i++) {
            const v = Math.abs(A[i][k]);
            if (v > maxAbs) { maxAbs = v; piv = i; }
        }
        if (maxAbs < 1e-18) {
            throw new Error(`Singular matrix at column ${k} (max pivot ${maxAbs.toExponential(2)}). Check for floating nodes or missing ground reference.`);
        }
        if (piv !== k) {
            const tmp = A[k]; A[k] = A[piv]; A[piv] = tmp;
            const tb = b[k]; b[k] = b[piv]; b[piv] = tb;
        }
        // Eliminate
        const akk = A[k][k];
        for (let i = k + 1; i < n; i++) {
            const f = A[i][k] / akk;
            if (f === 0) continue;
            for (let j = k; j < n; j++) A[i][j] -= f * A[k][j];
            b[i] -= f * b[k];
        }
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = b[i];
        for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
        x[i] = s / A[i][i];
    }
    return x;
}

/**
 * Complex linear solver. Matrices are passed as {re: number[][], im: number[][]}
 * and b as {re: number[], im: number[]}. Returns {re: Float64Array, im: Float64Array}.
 *
 * Used exclusively by AC analysis, where each frequency sample needs a
 * fresh solve on a jω-dependent matrix.
 */
export function solveComplex(Are, Aim, bre, bim) {
    const n = bre.length;
    for (let k = 0; k < n; k++) {
        let piv = k;
        let maxAbs = Math.hypot(Are[k][k], Aim[k][k]);
        for (let i = k + 1; i < n; i++) {
            const v = Math.hypot(Are[i][k], Aim[i][k]);
            if (v > maxAbs) { maxAbs = v; piv = i; }
        }
        if (maxAbs < 1e-18) {
            throw new Error(`Singular complex matrix at column ${k}. Check for resonances or lossless L/C loops.`);
        }
        if (piv !== k) {
            let tmp = Are[k]; Are[k] = Are[piv]; Are[piv] = tmp;
            tmp = Aim[k]; Aim[k] = Aim[piv]; Aim[piv] = tmp;
            let tb = bre[k]; bre[k] = bre[piv]; bre[piv] = tb;
            tb = bim[k]; bim[k] = bim[piv]; bim[piv] = tb;
        }
        const akkRe = Are[k][k];
        const akkIm = Aim[k][k];
        const denom = akkRe * akkRe + akkIm * akkIm;
        for (let i = k + 1; i < n; i++) {
            const aikRe = Are[i][k];
            const aikIm = Aim[i][k];
            // factor f = A[i][k] / A[k][k] in complex arithmetic
            const fRe = (aikRe * akkRe + aikIm * akkIm) / denom;
            const fIm = (aikIm * akkRe - aikRe * akkIm) / denom;
            if (fRe === 0 && fIm === 0) continue;
            for (let j = k; j < n; j++) {
                const aRe = Are[k][j];
                const aIm = Aim[k][j];
                Are[i][j] -= fRe * aRe - fIm * aIm;
                Aim[i][j] -= fRe * aIm + fIm * aRe;
            }
            bre[i] -= fRe * bre[k] - fIm * bim[k];
            bim[i] -= fRe * bim[k] + fIm * bre[k];
        }
    }
    const xRe = new Float64Array(n);
    const xIm = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let sRe = bre[i];
        let sIm = bim[i];
        for (let j = i + 1; j < n; j++) {
            sRe -= Are[i][j] * xRe[j] - Aim[i][j] * xIm[j];
            sIm -= Are[i][j] * xIm[j] + Aim[i][j] * xRe[j];
        }
        const dRe = Are[i][i];
        const dIm = Aim[i][i];
        const d = dRe * dRe + dIm * dIm;
        xRe[i] = (sRe * dRe + sIm * dIm) / d;
        xIm[i] = (sIm * dRe - sRe * dIm) / d;
    }
    return { re: xRe, im: xIm };
}

/** Allocate an n×n real matrix filled with zeros. */
export function zerosMat(n) {
    const M = new Array(n);
    for (let i = 0; i < n; i++) M[i] = new Float64Array(n);
    return M;
}

/** Allocate a complex n×n matrix as {re, im} pair. */
export function zerosComplexMat(n) {
    return { re: zerosMat(n), im: zerosMat(n) };
}
