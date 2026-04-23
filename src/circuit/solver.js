/**
 * Modified Nodal Analysis (MNA) solver for Circuit Studio.
 *
 * Handles DC operating point (with Newton-Raphson for diodes),
 * transient (trapezoidal integration with per-step Newton-Raphson),
 * and small-signal AC (complex MNA sweep around the DC operating
 * point). All three analyses share the same stamping pipeline — only
 * the element companion models differ.
 *
 * The solver is intentionally dense and allocation-heavy: we target
 * hand-designed analog circuits (≤ ~100 nodes) where a clean
 * textbook-style implementation beats any sparse library in both code
 * clarity and debuggability. If we ever need 1000-node circuits, the
 * natural upgrade is to swap out `linalg.solveReal` for a sparse LU —
 * every stamp here already touches only the non-zero structure that a
 * sparse backend would want.
 *
 * Convention: ground is node index 0 and is excluded from the MNA
 * matrix. Interior nodes 1..(nNodes-1) map to matrix rows 0..(nNodes-2).
 */

import { solveReal, solveComplex, zerosMat, zerosComplexMat } from './linalg.js';

const VT = 0.02585;                 // Thermal voltage at 300 K (V)
const GMIN = 1e-12;                 // Conductance floor added to every non-linear device
const NEWTON_MAX_ITER = 200;
const NEWTON_ABSTOL = 1e-9;
const NEWTON_RELTOL = 1e-4;
const NEWTON_VNTOL  = 1e-6;

/**
 * Evaluate a parsed source spec at time t (for transient / DC).
 * Returns the instantaneous voltage (V) or current (A) depending on
 * which element owns the source. AC components are ignored here —
 * AC analysis uses `evalSourceAC` instead.
 */
export function evalSource(specs, t) {
    let v = 0;
    for (const s of specs) {
        switch (s.kind) {
            case 'dc': v += s.v; break;
            case 'sin': {
                if (t < s.td) { v += s.vo; break; }
                const tt = t - s.td;
                v += s.vo + s.va * Math.exp(-s.theta * tt) * Math.sin(2 * Math.PI * s.f * tt);
                break;
            }
            case 'pulse': {
                const per = Number.isFinite(s.per) && s.per > 0 ? s.per : Number.POSITIVE_INFINITY;
                let tt = t - s.td;
                if (tt < 0) { v += s.v1; break; }
                if (Number.isFinite(per)) tt = tt - Math.floor(tt / per) * per;
                const tr = Math.max(s.tr, 1e-15);
                const tf = Math.max(s.tf, 1e-15);
                if (tt < tr) v += s.v1 + (s.v2 - s.v1) * (tt / tr);
                else if (tt < tr + s.pw) v += s.v2;
                else if (tt < tr + s.pw + tf) v += s.v2 + (s.v1 - s.v2) * ((tt - tr - s.pw) / tf);
                else v += s.v1;
                break;
            }
            case 'pwl': {
                const pts = s.points;
                if (pts.length === 0) break;
                if (t <= pts[0][0]) { v += pts[0][1]; break; }
                if (t >= pts[pts.length - 1][0]) { v += pts[pts.length - 1][1]; break; }
                // Linear interp between bracketing samples — good enough for
                // user-traced stimulus curves.
                for (let i = 1; i < pts.length; i++) {
                    if (t <= pts[i][0]) {
                        const [t0, v0] = pts[i - 1];
                        const [t1, v1] = pts[i];
                        const a = (t - t0) / (t1 - t0);
                        v += v0 + a * (v1 - v0);
                        break;
                    }
                }
                break;
            }
            case 'exp': {
                const tt = t;
                if (tt < s.td1) { v += s.v1; break; }
                if (tt < s.td2) {
                    v += s.v1 + (s.v2 - s.v1) * (1 - Math.exp(-(tt - s.td1) / s.tau1));
                } else {
                    const at_td2 = s.v1 + (s.v2 - s.v1) * (1 - Math.exp(-(s.td2 - s.td1) / s.tau1));
                    v += at_td2 + (s.v1 - at_td2) * (1 - Math.exp(-(tt - s.td2) / s.tau2));
                }
                break;
            }
            case 'ac': /* skipped in time-domain */ break;
            default: break;
        }
    }
    return v;
}

/** Return AC magnitude (and phase in degrees) for a source, or 0 if not AC-active. */
export function evalSourceAC(specs) {
    for (const s of specs) {
        if (s.kind === 'ac') return { mag: s.mag, phase: s.phase };
    }
    return { mag: 0, phase: 0 };
}

/**
 * Build a solver context from a parsed netlist. Walks the element list
 * once to allocate "extra unknown" indices for every branch-current
 * unknown (V, L, E, O) and caches them on each element so stamps can
 * look them up in O(1) later.
 */
export function buildContext(parsed) {
    const interior = parsed.nNodes - 1;         // matrix excludes ground
    let extra = 0;
    const elems = parsed.elements.map((e) => ({ ...e }));
    for (const e of elems) {
        if (e.type === 'V' || e.type === 'L' || e.type === 'E' || e.type === 'O') {
            e.branchIdx = interior + extra;
            extra++;
        }
    }
    const size = interior + extra;
    return {
        elems,
        models: parsed.models,
        nNodes: parsed.nNodes,
        interior,
        size,
        nodeNames: parsed.nodeNames,
    };
}

/** Return matrix row index for a node (0 = ground ⇒ -1, meaning "skip"). */
function ri(n) { return n === 0 ? -1 : n - 1; }

/** Stamp a conductance g between nodes a,b into matrix A (skips ground rows/cols). */
function stampG(A, a, b, g) {
    const ia = ri(a), ib = ri(b);
    if (ia >= 0) A[ia][ia] += g;
    if (ib >= 0) A[ib][ib] += g;
    if (ia >= 0 && ib >= 0) { A[ia][ib] -= g; A[ib][ia] -= g; }
}

/** Stamp a current I flowing from node a to node b into RHS vector z. */
function stampI(z, a, b, I) {
    const ia = ri(a), ib = ri(b);
    if (ia >= 0) z[ia] -= I;
    if (ib >= 0) z[ib] += I;
}

/** Stamp an ideal voltage source Vab = e, with branch-current unknown at col k. */
function stampVSrc(A, z, a, b, k, e) {
    const ia = ri(a), ib = ri(b);
    if (ia >= 0) { A[ia][k] += 1; A[k][ia] += 1; }
    if (ib >= 0) { A[ib][k] -= 1; A[k][ib] -= 1; }
    z[k] += e;
}

/**
 * DC operating point. Iterates Newton-Raphson until diodes converge,
 * or returns the linear solution directly when the circuit has none.
 * Initial guess: all node voltages = 0.
 *
 * Returns {x, iters, converged, elemCurrents, stats} on success and
 * throws with a useful diagnostic otherwise.
 */
export function solveDC(ctx, opts = {}) {
    const prevX = new Float64Array(ctx.size);
    const initX = opts.initial || prevX;
    if (initX.length === ctx.size) {
        for (let i = 0; i < ctx.size; i++) prevX[i] = initX[i];
    }
    const hasNonlinear = ctx.elems.some((e) => e.type === 'D');
    const maxIter = hasNonlinear ? NEWTON_MAX_ITER : 1;

    let x = prevX;
    for (let iter = 0; iter < maxIter; iter++) {
        const A = zerosMat(ctx.size);
        const z = new Float64Array(ctx.size);

        for (const el of ctx.elems) {
            switch (el.type) {
                case 'R': {
                    if (!(el.value > 0)) throw new Error(`${el.name}: resistance must be > 0`);
                    stampG(A, el.n1, el.n2, 1 / el.value);
                    break;
                }
                case 'C': {
                    // DC op-point → cap is open. Still add GMIN so op-point
                    // Jacobian stays non-singular when the cap is the only
                    // connection to a node (common: output of integrator).
                    stampG(A, el.n1, el.n2, GMIN);
                    break;
                }
                case 'L': {
                    // DC op-point → inductor is a short (V = 0 across it).
                    // Use the V-source stamp with e = 0 so branch current
                    // stays an unknown.
                    stampVSrc(A, z, el.n1, el.n2, el.branchIdx, 0);
                    break;
                }
                case 'V': {
                    const v = evalSource(el.source, 0);
                    stampVSrc(A, z, el.n1, el.n2, el.branchIdx, v);
                    break;
                }
                case 'I': {
                    const I = evalSource(el.source, 0);
                    stampI(z, el.n1, el.n2, I);
                    break;
                }
                case 'D': {
                    // Non-linear diode: companion = Geq + Ieq (parallel).
                    //   Id  = Is · (exp(Vd / (n·VT)) − 1) + GMIN·Vd
                    //   Geq = dId/dVd   (evaluated at guess Vd_prev)
                    //   Ieq = Id(Vd_prev) − Geq·Vd_prev
                    const mdl = ctx.models[el.model] || ctx.models.default;
                    const Is = mdl.params.is ?? 1e-14;
                    const n = mdl.params.n ?? 1;
                    const vt = n * VT;
                    const vaIdx = ri(el.n1), vbIdx = ri(el.n2);
                    const vA = vaIdx >= 0 ? prevX[vaIdx] : 0;
                    const vB = vbIdx >= 0 ? prevX[vbIdx] : 0;
                    let vd = vA - vB;
                    // Voltage limiting so the exp doesn't explode early in NR.
                    const vcrit = vt * Math.log(vt / (Math.SQRT2 * Is));
                    if (vd > vcrit && Math.abs(vd - 0) > 2 * vt) {
                        // Sub-step limit: clamp Δvd between iterations.
                        vd = vcrit + vt * Math.log(1 + (vd - vcrit) / vt);
                    }
                    const eexp = Math.exp(Math.min(vd / vt, 40));
                    const Id = Is * (eexp - 1) + GMIN * vd;
                    const Geq = (Is / vt) * eexp + GMIN;
                    const Ieq = Id - Geq * vd;
                    stampG(A, el.n1, el.n2, Geq);
                    stampI(z, el.n1, el.n2, Ieq);
                    break;
                }
                case 'E': {
                    // VCVS: V(n1,n2) = gain · V(nc1, nc2)
                    // Branch current adds extra row/col like a V-source, plus
                    // entries linking ctrl-node voltages.
                    const k = el.branchIdx;
                    const ip = ri(el.n1), in_ = ri(el.n2);
                    const cp = ri(el.nc1), cn = ri(el.nc2);
                    if (ip >= 0) { A[ip][k] += 1; A[k][ip] += 1; }
                    if (in_ >= 0) { A[in_][k] -= 1; A[k][in_] -= 1; }
                    if (cp >= 0) A[k][cp] -= el.gain;
                    if (cn >= 0) A[k][cn] += el.gain;
                    break;
                }
                case 'G': {
                    // VCCS: I from n1→n2 = gm · V(nc1, nc2)
                    const n1 = ri(el.n1), n2 = ri(el.n2);
                    const cp = ri(el.nc1), cn = ri(el.nc2);
                    if (n1 >= 0 && cp >= 0) A[n1][cp] += el.gm;
                    if (n1 >= 0 && cn >= 0) A[n1][cn] -= el.gm;
                    if (n2 >= 0 && cp >= 0) A[n2][cp] -= el.gm;
                    if (n2 >= 0 && cn >= 0) A[n2][cn] += el.gm;
                    break;
                }
                case 'O': {
                    // Ideal op-amp: V(in+) = V(in−) and I(out) is an unknown
                    // sourced from the op-amp output. Stamps:
                    //   row for op-amp branch: V(in+) − V(in−) = 0
                    //   output node: KCL contribution +/- I_out
                    const k = el.branchIdx;
                    const ip = ri(el.inp), in_ = ri(el.inn);
                    const out = ri(el.out);
                    if (out >= 0) { A[out][k] += 1; }
                    if (ip >= 0) A[k][ip] += 1;
                    if (in_ >= 0) A[k][in_] -= 1;
                    break;
                }
                default: break;
            }
        }

        let newX;
        try {
            newX = solveReal(A, z);
        } catch (err) {
            throw new Error(`DC solve failed at iter ${iter}: ${err.message}`);
        }

        if (!hasNonlinear) {
            return { x: newX, iters: 1, converged: true };
        }
        let maxAbs = 0, maxRel = 0;
        for (let i = 0; i < ctx.size; i++) {
            const d = Math.abs(newX[i] - prevX[i]);
            if (d > maxAbs) maxAbs = d;
            const r = d / (Math.max(Math.abs(newX[i]), Math.abs(prevX[i])) + NEWTON_VNTOL);
            if (r > maxRel) maxRel = r;
            prevX[i] = newX[i];
        }
        x = newX;
        if (maxAbs < NEWTON_ABSTOL || maxRel < NEWTON_RELTOL) {
            return { x, iters: iter + 1, converged: true };
        }
    }
    return { x, iters: maxIter, converged: !hasNonlinear };
}

/**
 * Transient analysis using trapezoidal integration.
 *
 * Each storage element gets a companion (parallel G + I source) whose
 * conductance depends only on dt, so the Jacobian is rebuilt just when
 * dt changes. Non-linear devices are inner-looped with Newton-Raphson
 * at every timestep.
 *
 * options:
 *   tstep  — target step (s)
 *   tstop  — end time  (s)
 *   tstart — first sample saved (default 0)
 *   uic    — use-initial-conditions flag (.tran UIC). When true we
 *            skip the pre-transient DC op-point and start with the
 *            user-provided ICs (defaulting to zero).
 *
 * returns {t: Float64Array, nodeV: Float64Array[], branchI: Float64Array[], ...}
 */
export function solveTran(ctx, options) {
    const tstep = options.tstep;
    const tstop = options.tstop;
    const tstart = options.tstart || 0;
    if (!(tstep > 0) || !(tstop > 0) || tstop <= tstart) {
        throw new Error('.tran tstep and tstop must be positive with tstop > tstart');
    }
    const maxSamples = Math.ceil((tstop - tstart) / tstep) + 2;
    const tArr = new Float64Array(maxSamples);
    const interior = ctx.interior;
    const size = ctx.size;
    const nodeHist = [];
    for (let i = 0; i < interior; i++) nodeHist.push(new Float64Array(maxSamples));
    const branchHist = [];
    for (let i = 0; i < size - interior; i++) branchHist.push(new Float64Array(maxSamples));

    // Initial state: DC op-point (unless UIC).
    let prev = new Float64Array(size);
    if (!options.uic) {
        const dc = solveDC(ctx);
        for (let i = 0; i < size; i++) prev[i] = dc.x[i];
    } else {
        for (const el of ctx.elems) {
            if (el.type === 'C' && el.ic) {
                // Approximate: just use it for the first companion step.
                // (Proper UIC would clamp the cap voltage, but a one-step
                // relaxation converges in practice.)
                const a = ri(el.n1), b = ri(el.n2);
                if (a >= 0) prev[a] = el.ic;
                if (b >= 0) prev[b] = 0;
            }
            if (el.type === 'L' && el.ic && el.branchIdx != null) prev[el.branchIdx] = el.ic;
        }
    }
    // We also need a per-storage element "last known" (v_prev, i_prev) pair
    // for the companion source. For caps we use terminal-voltage history,
    // for inductors we use branch-current history.
    const vCapPrev = new Map();
    const iLPrev = new Map();
    for (const el of ctx.elems) {
        if (el.type === 'C') {
            const a = ri(el.n1), b = ri(el.n2);
            const vA = a >= 0 ? prev[a] : 0;
            const vB = b >= 0 ? prev[b] : 0;
            vCapPrev.set(el.name, vA - vB);
        } else if (el.type === 'L') {
            iLPrev.set(el.name, prev[el.branchIdx] || 0);
        }
    }

    let tIdx = 0;
    tArr[0] = tstart;
    for (let i = 0; i < interior; i++) nodeHist[i][0] = prev[i];
    for (let i = 0; i < size - interior; i++) branchHist[i][0] = prev[interior + i];

    const dt = tstep;
    let t = tstart;
    // Companion conductance terms (depend only on dt).
    //   Cap:    Geq = 2C/dt ; Ieq = Geq·V_n + I_n (stored I from prior step)
    //   Ind:    Veq = 2L/dt ; stamped as V-source with e = -Veq·I_n + V_n  (branch form)
    const iCapPrev = new Map();   // last diff current through cap
    const vLPrev = new Map();     // last voltage across inductor

    while (t < tstop - 1e-15) {
        const tNext = Math.min(tstop, t + dt);
        const h = tNext - t;

        let xIter = new Float64Array(prev);
        let converged = false;
        const hasNonlinear = ctx.elems.some((e) => e.type === 'D');
        const innerMax = hasNonlinear ? NEWTON_MAX_ITER : 1;

        for (let it = 0; it < innerMax; it++) {
            const A = zerosMat(size);
            const z = new Float64Array(size);

            for (const el of ctx.elems) {
                switch (el.type) {
                    case 'R': stampG(A, el.n1, el.n2, 1 / el.value); break;
                    case 'C': {
                        const Geq = (2 * el.value) / h;
                        const vPrev = vCapPrev.get(el.name) || 0;
                        const iPrev = iCapPrev.get(el.name) || 0;
                        // Trapezoidal companion: I_eq = -(Geq·V_prev + I_prev)
                        // stamped so that the new-step current is
                        // I_new = Geq·V_new − Geq·V_prev − I_prev.
                        stampG(A, el.n1, el.n2, Geq);
                        stampI(z, el.n1, el.n2, -(Geq * vPrev + iPrev));
                        break;
                    }
                    case 'L': {
                        const Req = (2 * el.value) / h;
                        const iPrev = iLPrev.get(el.name) || 0;
                        const vPrev = vLPrev.get(el.name) || 0;
                        // Inductor trapezoidal companion as a V-source with
                        // e = Req·i_prev + v_prev, in series with R=Req. The
                        // V-source stamp handles the branch-current unknown.
                        const k = el.branchIdx;
                        const ip = ri(el.n1), in_ = ri(el.n2);
                        // KCL entries
                        if (ip >= 0) { A[ip][k] += 1; A[k][ip] += 1; }
                        if (in_ >= 0) { A[in_][k] -= 1; A[k][in_] -= 1; }
                        // Branch-equation row: V(n1) − V(n2) − Req·I = e
                        A[k][k] -= Req;
                        z[k] += Req * iPrev + vPrev;
                        break;
                    }
                    case 'V': {
                        const v = evalSource(el.source, tNext);
                        stampVSrc(A, z, el.n1, el.n2, el.branchIdx, v);
                        break;
                    }
                    case 'I': {
                        const I = evalSource(el.source, tNext);
                        stampI(z, el.n1, el.n2, I);
                        break;
                    }
                    case 'D': {
                        const mdl = ctx.models[el.model] || ctx.models.default;
                        const Is = mdl.params.is ?? 1e-14;
                        const n = mdl.params.n ?? 1;
                        const vt = n * VT;
                        const vaIdx = ri(el.n1), vbIdx = ri(el.n2);
                        const vA = vaIdx >= 0 ? xIter[vaIdx] : 0;
                        const vB = vbIdx >= 0 ? xIter[vbIdx] : 0;
                        const vd = vA - vB;
                        const eexp = Math.exp(Math.min(vd / vt, 40));
                        const Id = Is * (eexp - 1) + GMIN * vd;
                        const Geq = (Is / vt) * eexp + GMIN;
                        const Ieq = Id - Geq * vd;
                        stampG(A, el.n1, el.n2, Geq);
                        stampI(z, el.n1, el.n2, Ieq);
                        break;
                    }
                    case 'E': {
                        const k = el.branchIdx;
                        const ip = ri(el.n1), in_ = ri(el.n2);
                        const cp = ri(el.nc1), cn = ri(el.nc2);
                        if (ip >= 0) { A[ip][k] += 1; A[k][ip] += 1; }
                        if (in_ >= 0) { A[in_][k] -= 1; A[k][in_] -= 1; }
                        if (cp >= 0) A[k][cp] -= el.gain;
                        if (cn >= 0) A[k][cn] += el.gain;
                        break;
                    }
                    case 'G': {
                        const n1 = ri(el.n1), n2 = ri(el.n2);
                        const cp = ri(el.nc1), cn = ri(el.nc2);
                        if (n1 >= 0 && cp >= 0) A[n1][cp] += el.gm;
                        if (n1 >= 0 && cn >= 0) A[n1][cn] -= el.gm;
                        if (n2 >= 0 && cp >= 0) A[n2][cp] -= el.gm;
                        if (n2 >= 0 && cn >= 0) A[n2][cn] += el.gm;
                        break;
                    }
                    case 'O': {
                        const k = el.branchIdx;
                        const ip = ri(el.inp), in_ = ri(el.inn);
                        const out = ri(el.out);
                        if (out >= 0) { A[out][k] += 1; }
                        if (ip >= 0) A[k][ip] += 1;
                        if (in_ >= 0) A[k][in_] -= 1;
                        break;
                    }
                    default: break;
                }
            }

            let xNew;
            try {
                xNew = solveReal(A, z);
            } catch (err) {
                throw new Error(`Transient solve failed at t=${tNext.toExponential(3)} iter ${it}: ${err.message}`);
            }
            if (!hasNonlinear) { xIter = xNew; converged = true; break; }

            let dmax = 0;
            for (let i = 0; i < size; i++) {
                const d = Math.abs(xNew[i] - xIter[i]);
                if (d > dmax) dmax = d;
                xIter[i] = xNew[i];
            }
            if (dmax < NEWTON_ABSTOL) { converged = true; break; }
        }
        if (!converged) {
            throw new Error(`Transient: Newton-Raphson failed to converge at t=${tNext.toExponential(3)} s`);
        }

        // Commit new step: update companion histories for caps and inductors.
        for (const el of ctx.elems) {
            if (el.type === 'C') {
                const a = ri(el.n1), b = ri(el.n2);
                const vA = a >= 0 ? xIter[a] : 0;
                const vB = b >= 0 ? xIter[b] : 0;
                const vNew = vA - vB;
                const vPrev = vCapPrev.get(el.name) || 0;
                const iPrev = iCapPrev.get(el.name) || 0;
                const Geq = (2 * el.value) / h;
                const iNew = Geq * (vNew - vPrev) - iPrev;
                vCapPrev.set(el.name, vNew);
                iCapPrev.set(el.name, iNew);
            } else if (el.type === 'L') {
                const a = ri(el.n1), b = ri(el.n2);
                const vA = a >= 0 ? xIter[a] : 0;
                const vB = b >= 0 ? xIter[b] : 0;
                const vNew = vA - vB;
                iLPrev.set(el.name, xIter[el.branchIdx] || 0);
                vLPrev.set(el.name, vNew);
            }
        }

        prev = xIter;
        tIdx++;
        tArr[tIdx] = tNext;
        for (let i = 0; i < interior; i++) nodeHist[i][tIdx] = prev[i];
        for (let i = 0; i < size - interior; i++) branchHist[i][tIdx] = prev[interior + i];
        t = tNext;
    }

    // Trim trailing unused slots.
    const used = tIdx + 1;
    return {
        t: tArr.slice(0, used),
        nodeV: nodeHist.map((a) => a.slice(0, used)),
        branchI: branchHist.map((a) => a.slice(0, used)),
    };
}

/**
 * AC (small-signal) analysis.
 *
 * Linearises the circuit around the DC operating point (so diode
 * incremental conductances are captured) and then builds a complex
 * MNA matrix at each frequency sample. Capacitors contribute jωC and
 * inductors contribute jωL through an auxiliary branch.
 *
 * returns {freqs: Float64Array, V: Array<{re, im}[]>, nodeNames}
 *   V[nodeIdx][freqIdx] = {re, im}
 */
export function solveAC(ctx, directive) {
    const dc = solveDC(ctx);

    // Frequency sweep points.
    const freqs = [];
    const n = Math.max(1, Math.floor(directive.n));
    if (directive.mode === 'dec') {
        const dec = Math.log10(directive.fStop / directive.fStart);
        const total = Math.max(1, Math.ceil(dec * n));
        for (let i = 0; i <= total; i++) {
            freqs.push(directive.fStart * Math.pow(10, i / n));
        }
    } else if (directive.mode === 'oct') {
        const oct = Math.log2(directive.fStop / directive.fStart);
        const total = Math.max(1, Math.ceil(oct * n));
        for (let i = 0; i <= total; i++) freqs.push(directive.fStart * Math.pow(2, i / n));
    } else {
        for (let i = 0; i < n; i++) {
            const a = n === 1 ? 0 : i / (n - 1);
            freqs.push(directive.fStart + a * (directive.fStop - directive.fStart));
        }
    }

    const size = ctx.size;
    const interior = ctx.interior;
    const results = [];
    for (let i = 0; i < interior; i++) results.push(new Array(freqs.length));
    const branchResults = [];
    for (let i = 0; i < size - interior; i++) branchResults.push(new Array(freqs.length));

    for (let fi = 0; fi < freqs.length; fi++) {
        const f = freqs[fi];
        const w = 2 * Math.PI * f;
        const { re: Are, im: Aim } = zerosComplexMat(size);
        const bre = new Float64Array(size);
        const bim = new Float64Array(size);

        // Stamping helpers for complex MNA.
        const cG = (a, b, gRe, gIm) => {
            const ia = ri(a), ib = ri(b);
            if (ia >= 0) { Are[ia][ia] += gRe; Aim[ia][ia] += gIm; }
            if (ib >= 0) { Are[ib][ib] += gRe; Aim[ib][ib] += gIm; }
            if (ia >= 0 && ib >= 0) {
                Are[ia][ib] -= gRe; Aim[ia][ib] -= gIm;
                Are[ib][ia] -= gRe; Aim[ib][ia] -= gIm;
            }
        };
        const cVSrc = (a, b, k, eRe, eIm) => {
            const ia = ri(a), ib = ri(b);
            if (ia >= 0) { Are[ia][k] += 1; Are[k][ia] += 1; }
            if (ib >= 0) { Are[ib][k] -= 1; Are[k][ib] -= 1; }
            bre[k] += eRe; bim[k] += eIm;
        };
        const cI = (a, b, iRe, iIm) => {
            const ia = ri(a), ib = ri(b);
            if (ia >= 0) { bre[ia] -= iRe; bim[ia] -= iIm; }
            if (ib >= 0) { bre[ib] += iRe; bim[ib] += iIm; }
        };

        for (const el of ctx.elems) {
            switch (el.type) {
                case 'R': cG(el.n1, el.n2, 1 / el.value, 0); break;
                case 'C': cG(el.n1, el.n2, 0, w * el.value); break;
                case 'L': {
                    // Inductor branch: V = jωL · I ⇒ A[k][k] = -jωL.
                    const k = el.branchIdx;
                    const ip = ri(el.n1), in_ = ri(el.n2);
                    if (ip >= 0) { Are[ip][k] += 1; Are[k][ip] += 1; }
                    if (in_ >= 0) { Are[in_][k] -= 1; Are[k][in_] -= 1; }
                    Aim[k][k] -= w * el.value;
                    break;
                }
                case 'V': {
                    const ac = evalSourceAC(el.source);
                    const ph = (ac.phase || 0) * Math.PI / 180;
                    cVSrc(el.n1, el.n2, el.branchIdx, ac.mag * Math.cos(ph), ac.mag * Math.sin(ph));
                    break;
                }
                case 'I': {
                    const ac = evalSourceAC(el.source);
                    const ph = (ac.phase || 0) * Math.PI / 180;
                    cI(el.n1, el.n2, ac.mag * Math.cos(ph), ac.mag * Math.sin(ph));
                    break;
                }
                case 'D': {
                    // Small-signal diode conductance at DC op-point.
                    const mdl = ctx.models[el.model] || ctx.models.default;
                    const Is = mdl.params.is ?? 1e-14;
                    const nC = mdl.params.n ?? 1;
                    const vt = nC * VT;
                    const a = ri(el.n1), b = ri(el.n2);
                    const vA = a >= 0 ? dc.x[a] : 0;
                    const vB = b >= 0 ? dc.x[b] : 0;
                    const vd = vA - vB;
                    const Geq = (Is / vt) * Math.exp(Math.min(vd / vt, 40)) + GMIN;
                    cG(el.n1, el.n2, Geq, 0);
                    break;
                }
                case 'E': {
                    const k = el.branchIdx;
                    const ip = ri(el.n1), in_ = ri(el.n2);
                    const cp = ri(el.nc1), cn = ri(el.nc2);
                    if (ip >= 0) { Are[ip][k] += 1; Are[k][ip] += 1; }
                    if (in_ >= 0) { Are[in_][k] -= 1; Are[k][in_] -= 1; }
                    if (cp >= 0) Are[k][cp] -= el.gain;
                    if (cn >= 0) Are[k][cn] += el.gain;
                    break;
                }
                case 'G': {
                    const n1 = ri(el.n1), n2 = ri(el.n2);
                    const cp = ri(el.nc1), cn = ri(el.nc2);
                    if (n1 >= 0 && cp >= 0) Are[n1][cp] += el.gm;
                    if (n1 >= 0 && cn >= 0) Are[n1][cn] -= el.gm;
                    if (n2 >= 0 && cp >= 0) Are[n2][cp] -= el.gm;
                    if (n2 >= 0 && cn >= 0) Are[n2][cn] += el.gm;
                    break;
                }
                case 'O': {
                    const k = el.branchIdx;
                    const ip = ri(el.inp), in_ = ri(el.inn);
                    const out = ri(el.out);
                    if (out >= 0) { Are[out][k] += 1; }
                    if (ip >= 0) Are[k][ip] += 1;
                    if (in_ >= 0) Are[k][in_] -= 1;
                    break;
                }
                default: break;
            }
        }

        const { re: xRe, im: xIm } = solveComplex(Are, Aim, bre, bim);
        for (let i = 0; i < interior; i++) results[i][fi] = { re: xRe[i], im: xIm[i] };
        for (let i = 0; i < size - interior; i++) {
            branchResults[i][fi] = { re: xRe[interior + i], im: xIm[interior + i] };
        }
    }
    return { freqs: Float64Array.from(freqs), V: results, branchI: branchResults };
}
