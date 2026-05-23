/**
 * Hansen Solubility Parameter (HSP) math kernel.
 *
 * Conventions:
 *   - Every HSP triplet is `{ dD, dP, dH }` in **MPa^½**.
 *   - A "sphere" is `{ dD, dP, dH, R }` where R (MPa^½) is the radius of
 *     interaction in the same 3-D space, after Hansen's empirical
 *     **factor-of-4** rescaling on the dispersion axis (i.e. the metric
 *     used by `hspRa`).
 *   - Mixtures use **volume-fraction** averaging — Hansen's defaults; you
 *     can also pass weight fractions converted ahead of time by the caller.
 *
 * Everything here is plain numbers — no React, no DOM — so it can run from
 * the page, a worker, or a node test without modification.
 *
 * The "factor of 4" on the dispersion term in `hspRa` is the standard
 * empirical correction described by Hansen. Drop it and the sphere
 * collapses to an ellipsoid that mis-predicts countless polymer–solvent
 * pairings — keep it.
 */

/** Compute the Hansen distance Ra between two HSP triplets (MPa^½). */
export function hspRa(a, b) {
    const dD = (a.dD ?? 0) - (b.dD ?? 0);
    const dP = (a.dP ?? 0) - (b.dP ?? 0);
    const dH = (a.dH ?? 0) - (b.dH ?? 0);
    return Math.sqrt(4 * dD * dD + dP * dP + dH * dH);
}

/** Relative Energy Difference (RED): Ra / R. <1 ⇒ inside sphere ⇒ soluble. */
export function hspRED(point, sphere) {
    if (!sphere || !(sphere.R > 0)) return Infinity;
    return hspRa(point, sphere) / sphere.R;
}

/**
 * Total Hildebrand parameter δ_t = √(δD² + δP² + δH²) for reference only —
 * Hansen's whole point is that you almost never want this for predicting
 * miscibility, but it's the historical anchor and the polymer tools still
 * print it.
 */
export function hspTotal(p) {
    const dD = p.dD ?? 0;
    const dP = p.dP ?? 0;
    const dH = p.dH ?? 0;
    return Math.sqrt(dD * dD + dP * dP + dH * dH);
}

/**
 * Volume-fraction-weighted HSP of a blend. `entries` is an array of
 * `{ dD, dP, dH, phi }` with `phi` >= 0; phis don't have to sum to 1 — the
 * function normalises them. Returns `{ dD, dP, dH, sumPhi }`.
 *
 * @param {Array<{dD:number, dP:number, dH:number, phi:number}>} entries
 */
export function hspBlend(entries) {
    let sumPhi = 0;
    let dD = 0, dP = 0, dH = 0;
    for (const e of entries) {
        const phi = Math.max(0, Number(e?.phi) || 0);
        if (phi === 0) continue;
        dD += phi * (e.dD ?? 0);
        dP += phi * (e.dP ?? 0);
        dH += phi * (e.dH ?? 0);
        sumPhi += phi;
    }
    if (sumPhi === 0) return { dD: 0, dP: 0, dH: 0, sumPhi: 0 };
    return { dD: dD / sumPhi, dP: dP / sumPhi, dH: dH / sumPhi, sumPhi };
}

/**
 * Find non-negative volume fractions `phi[i]` of `candidates` that minimise
 * the **Ra² distance** of the blend to `target` (an HSP triplet), subject to
 * `Σ phi[i] = 1`.
 *
 * Algorithm: projected-gradient descent on the simplex.
 *   - Objective f(phi) = 4·(dDblend − targetdD)² + (dPblend − ⋯)² + (dHblend − ⋯)²
 *   - Gradient is a simple matrix-vector product; we step against it with
 *     a small learning rate, then project onto the unit simplex
 *     (sort-and-subtract algorithm — exact, O(N log N) per iter).
 *   - 1500 iterations is plenty for N ≤ 8; convergence tolerance bails out
 *     earlier when the gradient is ~zero.
 *
 * Why this beats a generic QP library: zero deps, deterministic, very fast
 * for the small N (≤ 8) the UI exposes. The simplex projection guarantees
 * `phi[i] ≥ 0` and `Σ phi[i] = 1` after every step.
 *
 * @param {Array<{dD:number, dP:number, dH:number}>} candidates
 * @param {{dD:number, dP:number, dH:number}} target
 * @param {{ maxIter?:number, tol?:number, lr?:number }} [opts]
 * @returns {{ phi:number[], blend:{dD:number,dP:number,dH:number}, Ra:number }}
 */
export function optimiseBlend(candidates, target, opts = {}) {
    const N = candidates.length;
    if (N === 0) return { phi: [], blend: { dD: 0, dP: 0, dH: 0 }, Ra: Infinity };
    if (N === 1) {
        const c = candidates[0];
        return {
            phi: [1],
            blend: { dD: c.dD, dP: c.dP, dH: c.dH },
            Ra: hspRa(c, target),
        };
    }
    const maxIter = opts.maxIter ?? 1500;
    const tol = opts.tol ?? 1e-9;
    const lr = opts.lr ?? 0.04;
    /* Uniform initial guess — equal-weight blend. */
    let phi = new Array(N).fill(1 / N);
    /* Pre-scale candidate axes by Hansen's factor-of-4 metric (multiply
       dD by 2 so squared diffs reproduce 4*(δD-δD0)^2 without per-step
       branching). */
    const cdD = candidates.map((c) => 2 * (c.dD ?? 0));
    const cdP = candidates.map((c) => (c.dP ?? 0));
    const cdH = candidates.map((c) => (c.dH ?? 0));
    const tdD = 2 * (target.dD ?? 0);
    const tdP = target.dP ?? 0;
    const tdH = target.dH ?? 0;

    const projectSimplex = (v) => {
        /* Sort-and-subtract simplex projection (Wang & Carreira-Perpiñán). */
        const u = [...v].sort((a, b) => b - a);
        let cum = 0;
        let rho = 0;
        for (let i = 0; i < u.length; i++) {
            cum += u[i];
            const t = (cum - 1) / (i + 1);
            if (u[i] - t > 0) rho = i + 1;
        }
        cum = 0;
        for (let i = 0; i < rho; i++) cum += u[i];
        const theta = (cum - 1) / rho;
        return v.map((x) => Math.max(0, x - theta));
    };

    for (let it = 0; it < maxIter; it++) {
        /* Blend in pre-scaled coords. */
        let bD = 0, bP = 0, bH = 0;
        for (let i = 0; i < N; i++) {
            const p = phi[i];
            bD += p * cdD[i];
            bP += p * cdP[i];
            bH += p * cdH[i];
        }
        const eD = bD - tdD;
        const eP = bP - tdP;
        const eH = bH - tdH;
        /* ∇f w.r.t. phi[i] = 2 * (eD*cdD[i] + eP*cdP[i] + eH*cdH[i]). */
        let gradMax = 0;
        const grad = new Array(N);
        for (let i = 0; i < N; i++) {
            const g = 2 * (eD * cdD[i] + eP * cdP[i] + eH * cdH[i]);
            grad[i] = g;
            const ag = Math.abs(g);
            if (ag > gradMax) gradMax = ag;
        }
        if (gradMax < tol) break;
        /* Gradient step + project onto simplex. */
        const next = phi.map((p, i) => p - lr * grad[i]);
        phi = projectSimplex(next);
    }
    /* Compute final blend in real units. */
    const blend = hspBlend(
        candidates.map((c, i) => ({ dD: c.dD, dP: c.dP, dH: c.dH, phi: phi[i] }))
    );
    return {
        phi,
        blend: { dD: blend.dD, dP: blend.dP, dH: blend.dH },
        Ra: hspRa(blend, target),
    };
}

/**
 * Fit a Hansen sphere `(dD, dP, dH, R)` to a list of solvents that are
 * tagged as **good** (score=1, dissolves polymer) or **bad** (score=0).
 *
 * Quality function:
 *   For each solvent compute distance Ra to the candidate centre.
 *   A_i =
 *     - 1                              if good & inside, or bad & outside
 *     - exp(R - Ra)                    if good but outside (penalty < 1)
 *     - exp(Ra - R)                    if bad but inside  (penalty < 1)
 *   FIT = (Π A_i)^(1/N), maximised over (dD, dP, dH, R).
 *
 * Search strategy:
 *   1. Seed centre at the volume-weighted mean of good solvents (or the
 *      grand mean if no goods); seed R at 8.
 *   2. Coordinate-descent: cycle through {dD, dP, dH, R} doing a 1-D
 *      line search with a shrinking step (golden-section style, but
 *      enumerated for simplicity).
 *
 * Deterministic and fast; for ≤ 60 data points it converges in a handful
 * of ms which is what the UI needs. For harder datasets use
 * {@link fitHansenSphereDE} (differential evolution, HSPiPy-style).
 *
 * @param {Array<{dD:number, dP:number, dH:number, score:0|1, weight?:number}>} points
 * @returns {{
 *   center: {dD:number, dP:number, dH:number},
 *   R: number,
 *   fit: number,
 *   misclassifiedGood: number,
 *   misclassifiedBad: number,
 *   iterations: number,
 * }}
 */
export function fitHansenSphere(points) {
    const pts = (points || []).filter(
        (p) => p && Number.isFinite(p.dD) && Number.isFinite(p.dP) && Number.isFinite(p.dH)
    );
    if (pts.length === 0) {
        return {
            center: { dD: 18, dP: 8, dH: 8 },
            R: 8,
            fit: 0,
            misclassifiedGood: 0,
            misclassifiedBad: 0,
            iterations: 0,
        };
    }
    /* Seed centre at the mean of "good" solvents (Hansen's classic
       starting point). Falls back to grand mean if no goods are tagged. */
    let cx = 0, cy = 0, cz = 0, wsum = 0;
    let countGood = 0;
    for (const p of pts) {
        const isGood = p.score === 1 || p.score === '1' || p.score === true;
        const w = isGood ? (p.weight ?? 1) : 0;
        if (w > 0) {
            cx += w * p.dD;
            cy += w * p.dP;
            cz += w * p.dH;
            wsum += w;
            countGood++;
        }
    }
    if (wsum === 0) {
        for (const p of pts) { cx += p.dD; cy += p.dP; cz += p.dH; }
        cx /= pts.length; cy /= pts.length; cz /= pts.length;
    } else {
        cx /= wsum; cy /= wsum; cz /= wsum;
    }
    let R = 8;
    /* Auto-pick a reasonable starting radius: 90th-percentile of distances
       to the good cluster, clamped to [4, 18]. */
    if (countGood >= 3) {
        const dists = pts
            .filter((p) => p.score === 1 || p.score === true)
            .map((p) => hspRa({ dD: p.dD, dP: p.dP, dH: p.dH }, { dD: cx, dP: cy, dH: cz }))
            .sort((a, b) => a - b);
        if (dists.length) {
            const idx = Math.floor(dists.length * 0.9);
            R = Math.max(4, Math.min(18, dists[Math.min(idx, dists.length - 1)] || 8));
        }
    }

    const score = (cD, cP, cH, rad) => {
        if (rad <= 0) return 0;
        let logFit = 0;
        for (const p of pts) {
            const dD = p.dD - cD;
            const dP = p.dP - cP;
            const dH = p.dH - cH;
            const Ra = Math.sqrt(4 * dD * dD + dP * dP + dH * dH);
            const isGood = p.score === 1 || p.score === true;
            if (isGood) {
                if (Ra > rad) logFit += rad - Ra; /* exp() of this < 1 */
            } else {
                if (Ra < rad) logFit += Ra - rad;
            }
        }
        return Math.exp(logFit / pts.length);
    };

    /* Stages of decreasing step size for each coordinate axis + R. */
    const stages = [
        { delta: 2.0, sweeps: 6 },
        { delta: 0.7, sweeps: 6 },
        { delta: 0.2, sweeps: 6 },
        { delta: 0.05, sweeps: 8 },
        { delta: 0.01, sweeps: 6 },
    ];

    let bestFit = score(cx, cy, cz, R);
    let iters = 0;
    for (const stage of stages) {
        const delta = stage.delta;
        for (let s = 0; s < stage.sweeps; s++) {
            const order = ['x', 'y', 'z', 'r'];
            let improved = false;
            for (const axis of order) {
                const candidates = [-2, -1, 1, 2].map((k) => k * delta);
                for (const d of candidates) {
                    let nx = cx, ny = cy, nz = cz, nr = R;
                    if (axis === 'x') nx = cx + d;
                    if (axis === 'y') ny = cy + d;
                    if (axis === 'z') nz = cz + d;
                    if (axis === 'r') nr = Math.max(0.5, R + d);
                    const f = score(nx, ny, nz, nr);
                    iters++;
                    if (f > bestFit + 1e-9) {
                        bestFit = f;
                        cx = nx; cy = ny; cz = nz; R = nr;
                        improved = true;
                    }
                }
            }
            if (!improved) break;
        }
    }

    /* Final misclassification counts. */
    let mg = 0, mb = 0;
    for (const p of pts) {
        const Ra = hspRa({ dD: p.dD, dP: p.dP, dH: p.dH }, { dD: cx, dP: cy, dH: cz });
        const isGood = p.score === 1 || p.score === true;
        if (isGood && Ra > R) mg++;
        if (!isGood && Ra < R) mb++;
    }
    return {
        center: { dD: cx, dP: cy, dH: cz },
        R,
        fit: bestFit,
        misclassifiedGood: mg,
        misclassifiedBad: mb,
        iterations: iters,
        engine: 'gradient',
    };
}

/** Binary good/bad Hansen fit objective — shared by gradient and DE solvers. */
function hansenSphereFitScore(pts, cx, cy, cz, R) {
    if (R <= 0 || !pts.length) return 0;
    let logFit = 0;
    for (const p of pts) {
        const Ra = hspRa({ dD: p.dD, dP: p.dP, dH: p.dH }, { dD: cx, dP: cy, dH: cz });
        const isGood = p.score === 1 || p.score === true || p.score === '1';
        if (isGood) {
            if (Ra > R) logFit += R - Ra;
        } else if (Ra < R) {
            logFit += Ra - R;
        }
    }
    return Math.exp(logFit / pts.length);
}

function hansenSphereMisclass(pts, cx, cy, cz, R) {
    let mg = 0;
    let mb = 0;
    for (const p of pts) {
        const Ra = hspRa({ dD: p.dD, dP: p.dP, dH: p.dH }, { dD: cx, dP: cy, dH: cz });
        const isGood = p.score === 1 || p.score === true || p.score === '1';
        if (isGood && Ra > R) mg++;
        if (!isGood && Ra < R) mb++;
    }
    return { misclassifiedGood: mg, misclassifiedBad: mb };
}

function normalizeBinaryFitPoints(points) {
    return (points || []).filter(
        (p) => p && Number.isFinite(p.dD) && Number.isFinite(p.dP) && Number.isFinite(p.dH)
    ).map((p) => ({
        ...p,
        score: (p.score >= 1 || p.score === true || p.score === '1') ? 1 : 0,
    }));
}

const DE_BOUNDS = {
    dD: [8, 32],
    dP: [0, 22],
    dH: [0, 45],
    R: [1, 22],
};

function clipDeVector(v) {
    return [
        Math.max(DE_BOUNDS.dD[0], Math.min(DE_BOUNDS.dD[1], v[0])),
        Math.max(DE_BOUNDS.dP[0], Math.min(DE_BOUNDS.dP[1], v[1])),
        Math.max(DE_BOUNDS.dH[0], Math.min(DE_BOUNDS.dH[1], v[2])),
        Math.max(DE_BOUNDS.R[0], Math.min(DE_BOUNDS.R[1], v[3])),
    ];
}

function randomDeVector(seed = null, spread = 1) {
    const pick = (lo, hi, centre) => {
        if (centre != null && Math.random() < 0.6) {
            return centre + (Math.random() * 2 - 1) * spread * (hi - lo) * 0.15;
        }
        return lo + Math.random() * (hi - lo);
    };
    return clipDeVector([
        pick(DE_BOUNDS.dD[0], DE_BOUNDS.dD[1], seed?.[0]),
        pick(DE_BOUNDS.dP[0], DE_BOUNDS.dP[1], seed?.[1]),
        pick(DE_BOUNDS.dH[0], DE_BOUNDS.dH[1], seed?.[2]),
        pick(DE_BOUNDS.R[0], DE_BOUNDS.R[1], seed?.[3]),
    ]);
}

/**
 * Differential-evolution Hansen sphere fit (HSPiPy-style global search).
 *
 * @param {Array<{dD,dP,dH,score}>} points
 * @param {{ population?: number, generations?: number }} [opts]
 */
export function fitHansenSphereDE(points, opts = {}) {
    const pts = normalizeBinaryFitPoints(points);
    if (pts.length === 0) {
        return {
            center: { dD: 18, dP: 8, dH: 8 },
            R: 8,
            fit: 0,
            misclassifiedGood: 0,
            misclassifiedBad: 0,
            iterations: 0,
            engine: 'de',
        };
    }

    const gradient = fitHansenSphere(pts);
    const seed = [gradient.center.dD, gradient.center.dP, gradient.center.dH, gradient.R];
    const POP = opts.population ?? 36;
    const GENS = opts.generations ?? 100;
    const F = 0.75;
    const CR = 0.85;

    const vecScore = (v) => hansenSphereFitScore(pts, v[0], v[1], v[2], v[3]);

    let pop = [clipDeVector(seed)];
    while (pop.length < POP) pop.push(randomDeVector(seed, 1.2));

    let best = pop[0];
    let bestFit = vecScore(best);
    let evals = POP;

    for (let gen = 0; gen < GENS; gen++) {
        const next = [];
        for (let i = 0; i < POP; i++) {
            let a = 0;
            let b = 0;
            let c = 0;
            do { a = Math.floor(Math.random() * POP); } while (a === i);
            do { b = Math.floor(Math.random() * POP); } while (b === i || b === a);
            do { c = Math.floor(Math.random() * POP); } while (c === i || c === a || c === b);

            const mutant = clipDeVector([
                pop[a][0] + F * (pop[b][0] - pop[c][0]),
                pop[a][1] + F * (pop[b][1] - pop[c][1]),
                pop[a][2] + F * (pop[b][2] - pop[c][2]),
                pop[a][3] + F * (pop[b][3] - pop[c][3]),
            ]);

            const trial = [...pop[i]];
            const jRand = Math.floor(Math.random() * 4);
            for (let j = 0; j < 4; j++) {
                if (Math.random() < CR || j === jRand) trial[j] = mutant[j];
            }
            trial[3] = Math.max(DE_BOUNDS.R[0], trial[3]);

            const trialFit = vecScore(trial);
            const curFit = vecScore(pop[i]);
            evals += 2;
            if (trialFit >= curFit) {
                next.push(trial);
                if (trialFit > bestFit) {
                    bestFit = trialFit;
                    best = trial;
                }
            } else {
                next.push(pop[i]);
            }
        }
        pop = next;
    }

    const [cx, cy, cz, R] = best;
    const { misclassifiedGood, misclassifiedBad } = hansenSphereMisclass(pts, cx, cy, cz, R);
    return {
        center: { dD: cx, dP: cy, dH: cz },
        R,
        fit: bestFit,
        misclassifiedGood,
        misclassifiedBad,
        iterations: evals,
        engine: 'de',
    };
}

/**
 * Concentric double sphere: same centre, inner radius Rᵢ (good) and outer Rₒ (marginal).
 * score: 2 = good, 1 = marginal, 0 = bad.
 *
 * @returns {{ center, R_inner, R_outer, fit, misclassified, iterations }}
 */
export function fitConcentricDoubleSphere(points, opts = {}) {
    const seedFn = opts.engine === 'de' ? fitHansenSphereDE : fitHansenSphere;
    const single = seedFn(
        (points || []).map((p) => ({
            ...p,
            score: p.score >= 2 || p.score === '2' ? 1 : p.score >= 1 ? 1 : 0,
        }))
    );
    const cx = single.center.dD, cy = single.center.dP, cz = single.center.dH;
    const pts = (points || []).filter(
        (p) => p && Number.isFinite(p.dD) && Number.isFinite(p.dP) && Number.isFinite(p.dH)
    );
    let Ri = Math.max(2, single.R * 0.75);
    let Ro = Math.max(Ri + 1, single.R * 1.25);

    const classify = (sc) => {
        if (sc >= 2 || sc === '2') return 'good';
        if (sc >= 1 || sc === '1') return 'marginal';
        return 'bad';
    };

    const scoreFn = (ri, ro) => {
        if (ri <= 0 || ro < ri) return 0;
        let logFit = 0;
        for (const p of pts) {
            const Ra = hspRa({ dD: p.dD, dP: p.dP, dH: p.dH }, { dD: cx, dP: cy, dH: cz });
            const cls = classify(p.score);
            if (cls === 'good') {
                if (Ra > ri) logFit += ri - Ra;
            } else if (cls === 'marginal') {
                if (Ra > ro) logFit += ro - Ra;
                else if (Ra < ri) logFit += Ra - ri;
            } else {
                if (Ra < ro) logFit += Ra - ro;
            }
        }
        return Math.exp(logFit / Math.max(1, pts.length));
    };

    let bestFit = scoreFn(Ri, Ro);
    let iters = 0;
    for (const delta of [1.5, 0.5, 0.15, 0.04]) {
        for (let sweep = 0; sweep < 8; sweep++) {
            let improved = false;
            for (const [dRi, dRo] of [[delta, 0], [-delta, 0], [0, delta], [0, -delta], [delta, delta]]) {
                const nRi = Math.max(1, Ri + dRi);
                const nRo = Math.max(nRi + 0.5, Ro + dRo);
                const f = scoreFn(nRi, nRo);
                iters++;
                if (f > bestFit + 1e-9) {
                    bestFit = f;
                    Ri = nRi;
                    Ro = nRo;
                    improved = true;
                }
            }
            if (!improved) break;
        }
    }

    let mis = 0;
    for (const p of pts) {
        const Ra = hspRa({ dD: p.dD, dP: p.dP, dH: p.dH }, { dD: cx, dP: cy, dH: cz });
        const cls = classify(p.score);
        if (cls === 'good' && Ra > Ri) mis++;
        if (cls === 'marginal' && (Ra > Ro || Ra < Ri)) mis++;
        if (cls === 'bad' && Ra < Ro) mis++;
    }

    return {
        center: { dD: cx, dP: cy, dH: cz },
        R_inner: Ri,
        R_outer: Ro,
        R: Ri,
        fit: bestFit,
        misclassified: mis,
        iterations: iters + single.iterations,
        engine: single.engine ?? 'gradient',
    };
}

/**
 * Solubility zone for concentric double sphere.
 * @returns {'good'|'marginal'|'bad'}
 */
export function hspSolubilityZone(point, sphere) {
    const Ra = hspRa(point, sphere);
    const Ri = sphere.R_inner ?? sphere.R ?? 8;
    const Ro = sphere.R_outer ?? Ri * 1.3;
    if (Ra <= Ri) return 'good';
    if (Ra <= Ro) return 'marginal';
    return 'bad';
}

/** Fit two independent Hansen spheres (HSPiPy n_spheres=2 style). */
export function fitDoubleHansenSpheres(points) {
    const goods = (points || []).filter((p) => p.score >= 1 || p.score === true);
    if (goods.length < 4) {
        const s = fitHansenSphere(points);
        return {
            spheres: [{ ...s.center, R: s.R, label: 'A' }],
            fit: s.fit,
            mode: 'single-fallback',
        };
    }
    const mid = Math.floor(goods.length / 2);
    const sorted = [...goods].sort((a, b) => a.dD - b.dD);
    const g1 = sorted.slice(0, mid);
    const g2 = sorted.slice(mid);
    const mean = (arr) => {
        let dD = 0, dP = 0, dH = 0;
        for (const p of arr) { dD += p.dD; dP += p.dP; dH += p.dH; }
        const n = arr.length || 1;
        return { dD: dD / n, dP: dP / n, dH: dH / n };
    };
    const c1 = mean(g1);
    const c2 = mean(g2);
    const r1 = fitHansenSphere(goods.map((p) => ({
        ...p,
        score: hspRa(p, c1) <= hspRa(p, c2) ? 1 : 0,
    })));
    const r2 = fitHansenSphere(goods.map((p) => ({
        ...p,
        score: hspRa(p, c2) <= hspRa(p, c1) ? 1 : 0,
    })));
    return {
        spheres: [
            { ...r1.center, R: r1.R, label: 'A' },
            { ...r2.center, R: r2.R, label: 'B' },
        ],
        fit: (r1.fit + r2.fit) / 2,
        mode: 'dual',
    };
}

/**
 * Simulate composition drift of a multi-solvent blend during evaporation.
 *
 * Assumes constant temperature, well-mixed liquid, gas-phase carries each
 * component away at a rate proportional to its mole fraction times its
 * **relative evaporation rate** (RER, n-butyl acetate = 1.0). This is the
 * standard formulator's heuristic (good enough for paint/coatings work,
 * not a substitute for a real UNIFAC VLE model — that lives in HSPiP's
 * separate VLE module and is out of scope here).
 *
 * @param {Array<{
 *   name:string,
 *   dD:number, dP:number, dH:number,
 *   phi:number,            // initial volume fraction (sum to 1)
 *   rer:number,            // relative evap rate
 *   molarVolume?:number,   // cm^3/mol; used to convert vol↔mol (defaults 100)
 * }>} components
 * @param {{ totalFractionEvaporated?:number, steps?:number }} [opts]
 * @returns {Array<{
 *   t:number,
 *   evap:number,
 *   phi:number[],
 *   blend:{dD:number,dP:number,dH:number}
 * }>}
 */
export function simulateEvaporation(components, opts = {}) {
    const N = components.length;
    if (N === 0) return [];
    const target = Math.min(0.99, Math.max(0.05, opts.totalFractionEvaporated ?? 0.95));
    const steps = Math.max(20, Math.min(800, opts.steps ?? 200));
    /* Track number of moles per component; mole fraction governs evap. */
    const Vm = components.map((c) => Math.max(20, Number(c.molarVolume) || 100));
    const rer = components.map((c) => Math.max(1e-3, Number(c.rer) || 0));
    /* Start with 100 cm^3 of total mixture; n_i = phi_i * V_total / Vm_i. */
    const Vtotal0 = 100;
    let n = components.map((c, i) => (c.phi * Vtotal0) / Vm[i]);
    const n0total = n.reduce((s, v) => s + v, 0);
    const history = [];
    const stepDuration = target / steps;
    /* Picking the per-step molar evaporation: at each step, remove a fixed
       fraction of CURRENT moles, distributed across components by their
       relative rates × current mole fractions. */
    for (let s = 0; s <= steps; s++) {
        const tot = n.reduce((a, v) => a + v, 0);
        if (tot <= 0) break;
        const x = n.map((v) => v / tot);
        /* Volume fractions today */
        const Vi = n.map((v, i) => v * Vm[i]);
        const Vtot = Vi.reduce((a, v) => a + v, 0);
        const phi = Vi.map((v) => (Vtot ? v / Vtot : 0));
        const blend = hspBlend(
            components.map((c, i) => ({ dD: c.dD, dP: c.dP, dH: c.dH, phi: phi[i] }))
        );
        const evap = 1 - tot / n0total;
        history.push({
            t: s / steps,
            evap,
            phi,
            blend: { dD: blend.dD, dP: blend.dP, dH: blend.dH },
        });
        if (evap >= target) break;
        /* Compute composite evap rates and remove the per-step amount. */
        const rates = x.map((xi, i) => xi * rer[i]);
        const rateSum = rates.reduce((a, v) => a + v, 0) || 1;
        const dN = tot * stepDuration; /* moles removed in this step */
        for (let i = 0; i < N; i++) {
            const fraction = rates[i] / rateSum;
            n[i] = Math.max(0, n[i] - dN * fraction);
        }
    }
    return history;
}

/**
 * Convert a list of `{ name, mass, density, molarVolume }` into a blend
 * with `phi` volume fractions ready for {@link hspBlend} /
 * {@link simulateEvaporation}. Optional helper for callers that want to
 * work in grams. Density in g/cm^3, mass in g.
 */
export function massToVolumeFractions(rows) {
    const Vs = rows.map((r) => {
        const d = Number(r.density) || 0;
        const m = Number(r.mass) || 0;
        return d > 0 ? m / d : 0;
    });
    const total = Vs.reduce((a, v) => a + v, 0);
    return Vs.map((v) => (total ? v / total : 0));
}
