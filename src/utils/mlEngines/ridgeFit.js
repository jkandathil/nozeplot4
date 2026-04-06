import { Matrix, inverse } from 'ml-matrix';

/**
 * Ridge regression with intercept: y ≈ X @ w + b (last column of augmented X is 1).
 * @param {number[][]} Xrows — n × d
 * @param {number[]} yVec — length n
 * @param {number} lambda — L2 penalty (applied to all coeffs including intercept slot; small e.g. 0.01–1)
 * @returns {{ coef: number[], intercept: number }}
 */
export function ridgeFitWithIntercept(Xrows, yVec, lambda = 0.05) {
    const n = Xrows.length;
    if (n < 2) throw new Error('Ridge fit needs at least 2 samples.');
    const d = Xrows[0]?.length ?? 0;
    if (d < 1) throw new Error('Ridge fit needs at least one feature.');
    if (yVec.length !== n) throw new Error('Ridge: y length must match X rows.');

    const X1 = Xrows.map((row) => [...row, 1]);
    const Xm = new Matrix(X1);
    const yM = Matrix.columnVector(yVec);
    const XtX = Xm.transpose().mmul(Xm);
    const dAug = d + 1;
    for (let i = 0; i < dAug; i++) {
        XtX.set(i, i, XtX.get(i, i) + lambda);
    }
    const Xty = Xm.transpose().mmul(yM);
    const XtXInv = inverse(XtX);
    const wCol = XtXInv.mmul(Xty);
    const flat = wCol.to1DArray();
    const intercept = flat[dAug - 1] ?? 0;
    const coef = flat.slice(0, d);
    return { coef, intercept };
}
