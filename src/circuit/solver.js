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
const EXP_CLAMP = 40;               // exp(V/Vt) clamp — anything above is effectively "on", keeps NR stable

/**
 * Limit a forward junction voltage step so exp(Vj/Vt) doesn't blow the
 * Jacobian off the rails. Classic SPICE pnjlim: once Vj exceeds vcrit
 * (the exponential's knee), switch to a log step. Returns a damped Vj
 * that preserves convergence direction.
 */
function pnjlim(vj, vjOld, vt, vcrit) {
    if (vj <= vcrit || Math.abs(vj - vjOld) <= 2 * vt) return vj;
    if (vjOld <= 0) return vcrit + vt * Math.log(Math.max(vj, vt) / vt);
    const arg = 1 + (vj - vjOld) / vt;
    if (arg > 0) return vjOld + vt * Math.log(arg);
    return vcrit;
}

/**
 * Reverse-breakdown limiter (for zener). Symmetric to pnjlim but on
 * the other side of the characteristic. Keeps the NR step from
 * overshooting -BV by more than a thermal voltage.
 */
function bvlim(vj, vjOld, vt, bv) {
    // Only engage when we're past -bv+2vt AND moving deeper in reverse.
    const knee = -bv;
    if (vj >= knee + 3 * vt || Math.abs(vj - vjOld) <= 2 * vt) return vj;
    if (vjOld >= knee) return knee - vt * Math.log(Math.max(knee - vj, vt) / vt);
    const arg = 1 + (vjOld - vj) / vt;
    if (arg > 0) return vjOld - vt * Math.log(arg);
    return knee;
}

/**
 * Apply both forward-on and reverse-breakdown limiting to a diode
 * junction, using the previous iteration's value (vjOld) as the
 * reference. Simplifies the call sites in stamp code.
 */
function limitDiode(vj, vjOld, params) {
    const vt = (params.n ?? 1) * VT;
    const Is = params.is ?? 1e-14;
    const vcrit = vt * Math.log(vt / (Math.SQRT2 * Is));
    let v = pnjlim(vj, vjOld, vt, vcrit);
    if (params.bv && params.bv > 0) v = bvlim(v, vjOld, vt, params.bv);
    return v;
}

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
    // Flat list of branch-unknown elements in the same order they were
    // assigned branchIdx above. Consumers (e.g. buildStepResult) use
    // this to produce named I(<ref>) signals without rescanning.
    const branchElems = elems
        .filter((e) => e.type === 'V' || e.type === 'L' || e.type === 'E' || e.type === 'O')
        .map((e) => ({ name: e.name, type: e.type }));
    return {
        elems,
        models: parsed.models,
        nNodes: parsed.nNodes,
        interior,
        size,
        nodeNames: parsed.nodeNames,
        branchElems,
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
 * Evaluate a diode companion at junction voltage vd (volts).
 * Handles the normal Shockley term AND a Zener reverse-breakdown term
 * (activated when BV > 0 and IBV > 0). The reverse-bias region blows
 * up exponentially below -BV — same functional form as ngspice's
 * "bv/ibv" diode model.
 */
function diodeEval(vd, params) {
    const Is = params.is ?? 1e-14;
    const n = params.n ?? 1;
    const vt = n * VT;
    const bv = params.bv ?? 0;
    const ibv = params.ibv ?? 1e-3;
    const eexp = Math.exp(Math.min(vd / vt, EXP_CLAMP));
    let Id = Is * (eexp - 1) + GMIN * vd;
    let Geq = (Is / vt) * eexp + GMIN;
    // Reverse-breakdown (Zener/avalanche): kicks in when Vd becomes very negative.
    if (bv > 0) {
        // Shift origin to -bv and use exp() of the excess in reverse direction.
        const vbr = -bv;                      // breakdown point
        if (vd < vbr + 3 * vt) {
            const eexpR = Math.exp(Math.min(-(vd - vbr) / vt, EXP_CLAMP));
            Id  += -ibv * (eexpR - 1);
            Geq +=  (ibv / vt) * eexpR;
        }
    }
    const Ieq = Id - Geq * vd;
    return { Id, Geq, Ieq };
}

/**
 * Ebers-Moll BJT evaluation in the "NPN-equivalent" junction frame.
 * vbe and vbc are already polarity-adjusted (p·(Vb-Ve) and p·(Vb-Vc))
 * and optionally voltage-limited by the caller. Returns port currents
 * (enter-device convention) and the Jacobian entries the stamp code
 * needs. PNP polarity is reapplied by the caller when converting back
 * into node-space KCL contributions.
 */
function bjtEval(vbe, vbc, mdl) {
    const Is  = mdl.params.is  ?? 1e-16;
    const Bf  = Math.max(mdl.params.bf  ?? 100, 1e-3);
    const Br  = Math.max(mdl.params.br  ?? 1,   1e-3);
    const Vaf = mdl.params.vaf;  // Early voltage — undefined/0 ⇒ disabled
    const Nf  = mdl.params.nf  ?? 1;
    const Nr  = mdl.params.nr  ?? 1;
    const Vtf = Nf * VT, Vtr = Nr * VT;

    const ebe = Math.exp(Math.min(vbe / Vtf, EXP_CLAMP));
    const ebc = Math.exp(Math.min(vbc / Vtr, EXP_CLAMP));

    // Core Ebers-Moll injection currents (NPN-equivalent)
    const Icc_F = Is * (ebe - 1);            // forward BE injection
    const Icc_R = Is * (ebc - 1);            // reverse BC injection

    // Early-effect modulator: (1 + Vcb/Vaf) clamped to a sane range.
    let early = 1;
    if (Vaf && Vaf > 0) {
        early = 1 + (-vbc) / Vaf;            // Vcb = -Vbc
        if (early < 0.25) early = 0.25;      // keep matrix well-conditioned
    }

    const Ic = Icc_F * early - Icc_R * (early + 1 / Br);
    const Ib = Icc_F / Bf + Icc_R / Br;

    // Partial derivatives wrt effective Vbe / Vbc (NPN frame)
    const dIF = (Is / Vtf) * ebe;            // ∂Icc_F / ∂Vbe
    const dIR = (Is / Vtr) * ebc;            // ∂Icc_R / ∂Vbc

    // Jacobian (ignoring ∂early/∂Vbc for simplicity; that term is O(Ic/Vaf) ≪ gm)
    const J_be_c =  dIF * early;                   // ∂Ic/∂Vbe
    const J_bc_c = -dIR * (early + 1 / Br);        // ∂Ic/∂Vbc
    const J_be_b =  dIF / Bf;                      // ∂Ib/∂Vbe
    const J_bc_b =  dIR / Br;                      // ∂Ib/∂Vbc

    return { Ic, Ib, Ie: -(Ic + Ib),
             J_be_c, J_bc_c, J_be_b, J_bc_b };
}

/**
 * Stamp a BJT (type 'Q') at the current NR iterate into the MNA
 * system. `history` is a mutable {vbe, vbc} object (one per BJT
 * instance) that remembers the previous NR iterate's limited junction
 * voltages — without this, exp(Vbe/Vt) blows up the first time a
 * fresh DC solve sees a 12 V base voltage and the solver never
 * recovers.
 */
function stampBJT(A, z, el, mdl, x, isNPN, history) {
    const p = isNPN ? +1 : -1;
    const iC = ri(el.nc), iB = ri(el.nb), iE = ri(el.ne);
    const vC = iC >= 0 ? x[iC] : 0;
    const vB = iB >= 0 ? x[iB] : 0;
    const vE = iE >= 0 ? x[iE] : 0;

    const Vtf = (mdl.params.nf ?? 1) * VT;
    const Is  = mdl.params.is ?? 1e-16;
    const vcrit = Vtf * Math.log(Vtf / (Math.SQRT2 * Is));

    let vbe = p * (vB - vE);
    let vbc = p * (vB - vC);
    if (history) {
        vbe = pnjlim(vbe, history.vbe ?? vbe, Vtf, vcrit);
        vbc = pnjlim(vbc, history.vbc ?? vbc, Vtf, vcrit);
        history.vbe = vbe;
        history.vbc = vbc;
    }

    const r = bjtEval(vbe, vbc, mdl);

    // Constant ("companion source") part per terminal, in real frame.
    const Kc = p * (r.Ic - (r.J_be_c * vbe + r.J_bc_c * vbc));
    const Kb = p * (r.Ib - (r.J_be_b * vbe + r.J_bc_b * vbc));
    const Ke = -(Kc + Kb);

    const { J_be_c, J_bc_c, J_be_b, J_bc_b } = r;
    const J_be_e = -(J_be_c + J_be_b);
    const J_bc_e = -(J_bc_c + J_bc_b);

    /* Row nc (terminal current = Ic enters collector):
         LHS += (J_be_c)·Vbe + (J_bc_c)·Vbc    with  Vbe=Vb-Ve, Vbc=Vb-Vc */
    const add = (row, nb, ne, nc_, Jbe, Jbc) => {
        if (row < 0) return;
        if (nb  >= 0) A[row][nb]  += (Jbe + Jbc);
        if (ne  >= 0) A[row][ne]  += (-Jbe);
        if (nc_ >= 0) A[row][nc_] += (-Jbc);
    };
    add(iC, iB, iE, iC, J_be_c, J_bc_c);
    add(iB, iB, iE, iC, J_be_b, J_bc_b);
    add(iE, iB, iE, iC, J_be_e, J_bc_e);

    if (iC >= 0) z[iC] += -Kc;
    if (iB >= 0) z[iB] += -Kb;
    if (iE >= 0) z[iE] += -Ke;

    // Convergence floor between each junction.
    stampG(A, el.nb, el.ne, GMIN);
    stampG(A, el.nb, el.nc, GMIN);
    return r;
}

/**
 * Level-1 Shichman-Hodges MOSFET evaluation. Returns drain current,
 * transconductances gm (wrt Vgs), go (wrt Vds), gmb (wrt Vbs).
 * Body effect is enabled only when gamma > 0.
 */
function mosEval(vG, vD, vS, vB, el, mdl, isN) {
    const p     = isN ? +1 : -1;
    const Vto   = mdl.params.vto    ?? 1.0;
    const Kp    = mdl.params.kp     ?? 50e-6;
    const lam   = mdl.params.lambda ?? 0;
    const gamma = mdl.params.gamma  ?? 0;
    const phi   = mdl.params.phi    ?? 0.6;
    const W     = el.W ?? mdl.params.w ?? 10e-6;
    const L     = el.L ?? mdl.params.l ?? 1e-6;
    const beta  = Kp * (W / L);

    const vgs = p * (vG - vS);
    const vds = p * (vD - vS);
    const vbs = p * (vB - vS);

    // Body-effect threshold; guard against negative argument.
    let Vth = Vto;
    let dVthdVbs = 0;
    if (gamma > 0) {
        const phiVbs = Math.max(phi - vbs, 0);
        const sqrtArg = Math.sqrt(phiVbs);
        Vth = Vto + gamma * (sqrtArg - Math.sqrt(phi));
        dVthdVbs = phiVbs > 0 ? -gamma / (2 * sqrtArg) : 0;
    }

    let Id = 0, gm = 0, go = 0, gmb = 0;
    const vov = vgs - Vth;
    if (vov <= 0) {
        // Cutoff — leave at zero, nothing to stamp except GMIN floor.
    } else if (vds < vov) {
        // Triode
        Id = beta * (vov - vds / 2) * vds * (1 + lam * vds);
        gm = beta * vds * (1 + lam * vds);
        go = beta * ((vov - vds) * (1 + lam * vds) + (vov * vds - vds * vds / 2) * lam);
        gmb = -gm * dVthdVbs;
    } else {
        // Saturation
        Id = 0.5 * beta * vov * vov * (1 + lam * vds);
        gm = beta * vov * (1 + lam * vds);
        go = 0.5 * beta * vov * vov * lam;
        gmb = -gm * dVthdVbs;
    }
    return { Id, gm, go, gmb, vgs, vds, vbs };
}

/**
 * Stamp a MOSFET ('M') into MNA at the current NR iterate. Gate and
 * bulk pins carry no DC current in this model, so only D and S get
 * conductance/current contributions. Adding GMIN between D and S keeps
 * the Jacobian well-conditioned when the device is cutoff.
 */
function stampMOSFET(A, z, el, mdl, x, isN) {
    const p  = isN ? +1 : -1;
    const iD = ri(el.nd), iG = ri(el.ng), iS = ri(el.ns), iB = ri(el.nbulk);
    const vG = iG >= 0 ? x[iG] : 0;
    const vD = iD >= 0 ? x[iD] : 0;
    const vS = iS >= 0 ? x[iS] : 0;
    const vB = iB >= 0 ? x[iB] : 0;

    const r = mosEval(vG, vD, vS, vB, el, mdl, isN);

    /* Linearisation: I_d_real = p·Id + gm·(Vg-Vs) + go·(Vd-Vs) + gmb·(Vb-Vs)
       where the gm/go/gmb numbers are computed in the "effective" frame
       so squaring with p² keeps magnitudes (signs carried by the const). */
    const Kd = p * (r.Id - (r.gm * r.vgs + r.go * r.vds + r.gmb * r.vbs));

    // Jacobian stamps — row iD
    if (iD >= 0) {
        if (iG >= 0) A[iD][iG] += r.gm;
        if (iS >= 0) A[iD][iS] -= (r.gm + r.go + r.gmb);
        if (iD >= 0) A[iD][iD] += r.go;
        if (iB >= 0) A[iD][iB] += r.gmb;
    }
    // Row iS — current leaves drain equals current enters source (plus any gate/bulk cap leakage, zero here)
    if (iS >= 0) {
        if (iG >= 0) A[iS][iG] -= r.gm;
        if (iD >= 0) A[iS][iD] -= r.go;
        if (iS >= 0) A[iS][iS] += (r.gm + r.go + r.gmb);
        if (iB >= 0) A[iS][iB] -= r.gmb;
    }
    if (iD >= 0) z[iD] += -Kd;
    if (iS >= 0) z[iS] +=  Kd;

    stampG(A, el.nd, el.ns, GMIN);
    return r;
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
    const hasNonlinear = ctx.elems.some((e) => e.type === 'D' || e.type === 'Q' || e.type === 'M');
    const maxIter = hasNonlinear ? NEWTON_MAX_ITER : 1;

    /* Per-element NR history: last-accepted junction voltage per
       non-linear device. Seeded at iteration 0 with the raw initial
       guess so pnjlim becomes a no-op (which is the right behavior —
       pnjlim needs a real previous step to damp toward). */
    const bjtHist = new Map();
    const diodeHist = new Map();

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
                    const mdl = ctx.models[el.model] || ctx.models.default;
                    const vaIdx = ri(el.n1), vbIdx = ri(el.n2);
                    const vA = vaIdx >= 0 ? prevX[vaIdx] : 0;
                    const vB = vbIdx >= 0 ? prevX[vbIdx] : 0;
                    const vdRaw = vA - vB;
                    const vdOld = diodeHist.get(el.name);
                    const vd = limitDiode(vdRaw, vdOld ?? vdRaw, mdl.params);
                    diodeHist.set(el.name, vd);
                    const { Geq, Ieq } = diodeEval(vd, mdl.params);
                    stampG(A, el.n1, el.n2, Geq);
                    stampI(z, el.n1, el.n2, Ieq);
                    break;
                }
                case 'Q': {
                    const mdl = ctx.models[el.model] || ctx.models.qdefault;
                    const isNPN = (mdl.type || 'NPN').toUpperCase() !== 'PNP';
                    if (!bjtHist.has(el.name)) bjtHist.set(el.name, {});
                    stampBJT(A, z, el, mdl, prevX, isNPN, bjtHist.get(el.name));
                    break;
                }
                case 'M': {
                    const mdl = ctx.models[el.model] || ctx.models.mdefault;
                    const t = (mdl.type || 'NMOS').toUpperCase();
                    stampMOSFET(A, z, el, mdl, prevX, t === 'NMOS');
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
    /* Size the output buffer generously — the adaptive step halver may
       drop dt by up to 256× on pathological events. If we run out of
       slots we silently bail out (the tIdx guard below), which is far
       preferable to re-allocating mid-sim. */
    const maxSamples = Math.ceil((tstop - tstart) / tstep) * 8 + 16;
    const tArr = new Float64Array(maxSamples);
    const interior = ctx.interior;
    const size = ctx.size;
    const nodeHist = [];
    for (let i = 0; i < interior; i++) nodeHist.push(new Float64Array(maxSamples));
    const branchHist = [];
    for (let i = 0; i < size - interior; i++) branchHist.push(new Float64Array(maxSamples));

    /* Initial state.
       Non-UIC: run a DC op-point first — caps are open, inductors are
       shorts, and the result gives us a consistent starting node
       vector.
       UIC: skip DC and seed each storage element's history directly
       from its IC= clause. Node voltages stay at zero; the first
       transient step will resolve them via NR once it has cap
       currents to work with. IC is correctly interpreted as the
       *voltage across the cap* (or *current through the inductor*),
       not as an absolute node voltage. */
    let prev = new Float64Array(size);
    if (!options.uic) {
        const dc = solveDC(ctx);
        for (let i = 0; i < size; i++) prev[i] = dc.x[i];
    }
    const vCapPrev = new Map();
    const iLPrev = new Map();
    for (const el of ctx.elems) {
        if (el.type === 'C') {
            if (options.uic) {
                vCapPrev.set(el.name, el.ic || 0);
            } else {
                const a = ri(el.n1), b = ri(el.n2);
                const vA = a >= 0 ? prev[a] : 0;
                const vB = b >= 0 ? prev[b] : 0;
                vCapPrev.set(el.name, vA - vB);
            }
        } else if (el.type === 'L') {
            if (options.uic) {
                iLPrev.set(el.name, el.ic || 0);
            } else {
                iLPrev.set(el.name, prev[el.branchIdx] || 0);
            }
        }
    }

    let tIdx = 0;
    tArr[0] = tstart;
    for (let i = 0; i < interior; i++) nodeHist[i][0] = prev[i];
    for (let i = 0; i < size - interior; i++) branchHist[i][0] = prev[interior + i];

    const dtBase = tstep;
    let dtNow = tstep;
    const dtMin = tstep / 256;   // don't halve forever — bail out after this
    let t = tstart;
    // Companion conductance terms (depend only on dt).
    //   Cap:    Geq = 2C/dt ; Ieq = Geq·V_n + I_n (stored I from prior step)
    //   Ind:    Veq = 2L/dt ; stamped as V-source with e = -Veq·I_n + V_n  (branch form)
    const iCapPrev = new Map();   // last diff current through cap
    const vLPrev = new Map();     // last voltage across inductor

    while (t < tstop - 1e-15) {
        const tNext = Math.min(tstop, t + dtNow);
        const h = tNext - t;

        let xIter = new Float64Array(prev);
        let converged = false;
        const hasNonlinear = ctx.elems.some((e) => e.type === 'D' || e.type === 'Q' || e.type === 'M');
        const innerMax = hasNonlinear ? NEWTON_MAX_ITER : 1;

        /* Per-step NR history — reset at the start of every time step
           so each Newton iteration's limiter reference is the
           current step's converging state, not the previous step's. */
        const bjtHist = new Map();
        const diodeHist = new Map();

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
                        const vaIdx = ri(el.n1), vbIdx = ri(el.n2);
                        const vA = vaIdx >= 0 ? xIter[vaIdx] : 0;
                        const vB = vbIdx >= 0 ? xIter[vbIdx] : 0;
                        const vdRaw = vA - vB;
                        const vdOld = diodeHist.get(el.name);
                        const vd = limitDiode(vdRaw, vdOld ?? vdRaw, mdl.params);
                        diodeHist.set(el.name, vd);
                        const { Geq, Ieq } = diodeEval(vd, mdl.params);
                        stampG(A, el.n1, el.n2, Geq);
                        stampI(z, el.n1, el.n2, Ieq);
                        break;
                    }
                    case 'Q': {
                        const mdl = ctx.models[el.model] || ctx.models.qdefault;
                        const isNPN = (mdl.type || 'NPN').toUpperCase() !== 'PNP';
                        if (!bjtHist.has(el.name)) bjtHist.set(el.name, {});
                        stampBJT(A, z, el, mdl, xIter, isNPN, bjtHist.get(el.name));
                        // Parasitic junction caps — treated as linear Cs in parallel
                        // with the junctions. Stored history piggybacks on the cap
                        // code below by injecting synthetic names into the maps.
                        const cje = mdl.params.cje || 0;
                        const cjc = mdl.params.cjc || 0;
                        if (cje > 0 || cjc > 0) {
                            const stampParasitic = (tag, n1, n2, C) => {
                                if (!(C > 0)) return;
                                const Geq = (2 * C) / h;
                                const vp = vCapPrev.get(tag) || 0;
                                const ip = iCapPrev.get(tag) || 0;
                                stampG(A, n1, n2, Geq);
                                stampI(z, n1, n2, -(Geq * vp + ip));
                            };
                            stampParasitic(`${el.name}__cje`, el.nb, el.ne, cje);
                            stampParasitic(`${el.name}__cjc`, el.nb, el.nc, cjc);
                        }
                        break;
                    }
                    case 'M': {
                        const mdl = ctx.models[el.model] || ctx.models.mdefault;
                        const isN = (mdl.type || 'NMOS').toUpperCase() === 'NMOS';
                        stampMOSFET(A, z, el, mdl, xIter, isN);
                        const cgso = mdl.params.cgso || 0;
                        const cgdo = mdl.params.cgdo || 0;
                        if (cgso > 0 || cgdo > 0) {
                            const stampParasitic = (tag, n1, n2, C) => {
                                if (!(C > 0)) return;
                                const Geq = (2 * C) / h;
                                const vp = vCapPrev.get(tag) || 0;
                                const ip = iCapPrev.get(tag) || 0;
                                stampG(A, n1, n2, Geq);
                                stampI(z, n1, n2, -(Geq * vp + ip));
                            };
                            stampParasitic(`${el.name}__cgs`, el.ng, el.ns, cgso);
                            stampParasitic(`${el.name}__cgd`, el.ng, el.nd, cgdo);
                        }
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
            /* Adaptive timestep fallback. Halve the step and retry the
               same t → tNext range. This transparently handles stiff
               regenerative events (e.g. a BJT astable snap) where the
               user's nominal step is too coarse for NR. If we hit dtMin
               we give up with a proper error. Successful "retry"
               attempts don't leak into future steps — we restore
               dtBase on the NEXT successful step below. */
            if (dtNow > dtMin) {
                dtNow = dtNow / 2;
                continue;
            }
            throw new Error(`Transient: Newton-Raphson failed to converge at t=${tNext.toExponential(3)} s`);
        }

        // Commit new step: update companion histories for caps, inductors,
        // and transistor parasitic caps (BJT Cje/Cjc, MOSFET Cgso/Cgdo).
        const commitCap = (tag, n1, n2, C) => {
            if (!(C > 0)) return;
            const a = ri(n1), b = ri(n2);
            const vA = a >= 0 ? xIter[a] : 0;
            const vB = b >= 0 ? xIter[b] : 0;
            const vNew = vA - vB;
            const vPrev = vCapPrev.get(tag) || 0;
            const iPrev = iCapPrev.get(tag) || 0;
            const Geq = (2 * C) / h;
            const iNew = Geq * (vNew - vPrev) - iPrev;
            vCapPrev.set(tag, vNew);
            iCapPrev.set(tag, iNew);
        };
        for (const el of ctx.elems) {
            if (el.type === 'C') {
                commitCap(el.name, el.n1, el.n2, el.value);
            } else if (el.type === 'L') {
                const a = ri(el.n1), b = ri(el.n2);
                const vA = a >= 0 ? xIter[a] : 0;
                const vB = b >= 0 ? xIter[b] : 0;
                const vNew = vA - vB;
                iLPrev.set(el.name, xIter[el.branchIdx] || 0);
                vLPrev.set(el.name, vNew);
            } else if (el.type === 'Q') {
                const mdl = ctx.models[el.model] || ctx.models.qdefault;
                commitCap(`${el.name}__cje`, el.nb, el.ne, mdl.params.cje || 0);
                commitCap(`${el.name}__cjc`, el.nb, el.nc, mdl.params.cjc || 0);
            } else if (el.type === 'M') {
                const mdl = ctx.models[el.model] || ctx.models.mdefault;
                commitCap(`${el.name}__cgs`, el.ng, el.ns, mdl.params.cgso || 0);
                commitCap(`${el.name}__cgd`, el.ng, el.nd, mdl.params.cgdo || 0);
            }
        }

        prev = xIter;
        tIdx++;
        if (tIdx >= tArr.length) break;      // array capacity — paranoid stop
        tArr[tIdx] = tNext;
        for (let i = 0; i < interior; i++) nodeHist[i][tIdx] = prev[i];
        for (let i = 0; i < size - interior; i++) branchHist[i][tIdx] = prev[interior + i];
        t = tNext;
        // Slowly grow the step back toward the user's nominal after a retry.
        if (dtNow < dtBase) dtNow = Math.min(dtBase, dtNow * 1.4);
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
                    // Small-signal diode conductance at DC op-point
                    // (includes the reverse-breakdown contribution via diodeEval).
                    const mdl = ctx.models[el.model] || ctx.models.default;
                    const a = ri(el.n1), b = ri(el.n2);
                    const vA = a >= 0 ? dc.x[a] : 0;
                    const vB = b >= 0 ? dc.x[b] : 0;
                    const { Geq } = diodeEval(vA - vB, mdl.params);
                    cG(el.n1, el.n2, Geq, 0);
                    break;
                }
                case 'Q': {
                    /* Hybrid-π small-signal stamp at the DC op-point:
                         gπ = dIb/dVbe   (base–emitter admittance)
                         gm = dIc/dVbe   (transconductance)
                         go = |dIc/dVbc| (output conductance, from Early)
                         gμ = dIb/dVbc   (feedback, often negligible)
                       Plus Cje (B-E), Cjc (B-C) as jωC admittances.         */
                    const mdl = ctx.models[el.model] || ctx.models.qdefault;
                    const isNPN = (mdl.type || 'NPN').toUpperCase() !== 'PNP';
                    const p = isNPN ? +1 : -1;
                    const iC = ri(el.nc), iB = ri(el.nb), iE = ri(el.ne);
                    const vC = iC >= 0 ? dc.x[iC] : 0;
                    const vB = iB >= 0 ? dc.x[iB] : 0;
                    const vE = iE >= 0 ? dc.x[iE] : 0;
                    const r = bjtEval(p * (vB - vE), p * (vB - vC), mdl);
                    const gPi = r.J_be_b + GMIN;
                    const gM  = r.J_be_c;
                    const gMu = r.J_bc_b + GMIN;
                    const gO  = -r.J_bc_c;     // flip sign → positive output conductance
                    const cje = mdl.params.cje || 0;
                    const cjc = mdl.params.cjc || 0;
                    // gπ + jωCje between B-E
                    cG(el.nb, el.ne, gPi, w * cje);
                    // gμ + jωCjc between B-C
                    cG(el.nb, el.nc, gMu, w * cjc);
                    // Output conductance go between C-E
                    cG(el.nc, el.ne, gO, 0);
                    // Transconductance: Ic = gm · Vbe  ≡ a VCCS from B→E driving C→E.
                    // Stamp: A[nc][nb] += gm, A[nc][ne] -= gm, A[ne][nb] -= gm, A[ne][ne] += gm.
                    if (iC >= 0 && iB >= 0) Are[iC][iB] += gM;
                    if (iC >= 0 && iE >= 0) Are[iC][iE] -= gM;
                    if (iE >= 0 && iB >= 0) Are[iE][iB] -= gM;
                    if (iE >= 0 && iE >= 0) Are[iE][iE] += gM;
                    break;
                }
                case 'M': {
                    const mdl = ctx.models[el.model] || ctx.models.mdefault;
                    const isN = (mdl.type || 'NMOS').toUpperCase() === 'NMOS';
                    const iD = ri(el.nd), iG = ri(el.ng), iS = ri(el.ns), iB = ri(el.nbulk);
                    const vG = iG >= 0 ? dc.x[iG] : 0;
                    const vD = iD >= 0 ? dc.x[iD] : 0;
                    const vS = iS >= 0 ? dc.x[iS] : 0;
                    const vB = iB >= 0 ? dc.x[iB] : 0;
                    const r = mosEval(vG, vD, vS, vB, el, mdl, isN);
                    const cgs = mdl.params.cgso || 0;
                    const cgd = mdl.params.cgdo || 0;
                    cG(el.ng, el.ns, 0, w * cgs);
                    cG(el.ng, el.nd, 0, w * cgd);
                    cG(el.nd, el.ns, r.go + GMIN, 0);
                    // gm: VCCS from G→S driving D→S
                    if (iD >= 0 && iG >= 0) Are[iD][iG] += r.gm;
                    if (iD >= 0 && iS >= 0) Are[iD][iS] -= r.gm;
                    if (iS >= 0 && iG >= 0) Are[iS][iG] -= r.gm;
                    if (iS >= 0)            Are[iS][iS] += r.gm;
                    if (r.gmb && iB >= 0) {
                        // Body transconductance (minor for most sims)
                        if (iD >= 0) Are[iD][iB] += r.gmb;
                        if (iD >= 0 && iS >= 0) Are[iD][iS] -= r.gmb;
                        if (iS >= 0) Are[iS][iB] -= r.gmb;
                        if (iS >= 0) Are[iS][iS] += r.gmb;
                    }
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

/**
 * Override a single element's primary value in a solver context,
 * in place. Returns true if the override was applied.
 *
 * This is the bolt-on `.step` hook: the page-level code clones the
 * context (shallow-copy of `elems`) once, then calls `setElementValue`
 * before each sweep step. Supported element kinds are anything with a
 * scalar `value` field (R, C, L), plus V and I where the DC level of
 * the first 'dc' source-spec is overridden. Anything else returns
 * false so the caller can surface a sensible error.
 */
export function setElementValue(ctx, elementName, value) {
    const target = String(elementName).toLowerCase();
    for (const el of ctx.elems) {
        if (String(el.name).toLowerCase() !== target) continue;
        switch (el.type) {
            case 'R': case 'C': case 'L':
                el.value = value;
                return true;
            case 'V': case 'I': {
                // Replace or inject a 'dc' spec while preserving any AC/PULSE/SIN.
                const hasDc = el.source.find((s) => s.kind === 'dc');
                if (hasDc) hasDc.v = value;
                else el.source.unshift({ kind: 'dc', v: value });
                return true;
            }
            default:
                return false;
        }
    }
    return false;
}

/**
 * Convenience wrapper that runs DC / AC / Transient once per `.step`
 * iteration and returns the full family-of-curves. If no `.step`
 * directive exists it runs exactly once with stepValue = null.
 *
 *   runs: Array<{ stepValue: number|null, op?, ac?, tran? }>
 *
 * The caller decides which analysis to read from each run; this keeps
 * the driver agnostic to downstream plotting.
 */
export function runWithStep(ctx, stepDirective, analyses) {
    const runs = [];
    if (!stepDirective) {
        runs.push({ stepValue: null, ...runAnalyses(ctx, analyses) });
        return runs;
    }
    const { target, start, stop, step } = stepDirective;
    if (!(Math.abs(step) > 0) || !(Math.sign(stop - start) === Math.sign(step))) {
        throw new Error(`.step: invalid sweep (${start} → ${stop} by ${step})`);
    }
    // Snap total iteration count to (stop-start)/step rounded with a
    // tiny tolerance — avoids off-by-one from floating-point drift.
    const tol = Math.abs(step) * 1e-6;
    for (let v = start; step > 0 ? v <= stop + tol : v >= stop - tol; v += step) {
        const applied = setElementValue(ctx, target, v);
        if (!applied) throw new Error(`.step: element ${target} has no sweepable value`);
        runs.push({ stepValue: v, ...runAnalyses(ctx, analyses) });
    }
    return runs;
}

function runAnalyses(ctx, analyses) {
    const out = {};
    if (analyses.op)   out.op   = solveDC(ctx);
    if (analyses.ac)   out.ac   = solveAC(ctx, analyses.ac);
    if (analyses.tran) out.tran = solveTran(ctx, analyses.tran);
    if (analyses.dc)   out.dc   = solveDCSweep(ctx, analyses.dc);
    return out;
}

/**
 * DC sweep (".dc Vin start stop step") — solves the operating point
 * at every value of a source between [start, stop] in increments of
 * step. Returns node voltages across the sweep as a family indexed by
 * the sweep variable, enabling VTC (voltage-transfer-characteristic)
 * plots without needing a transient envelope.
 *
 *   sweepDirective: { kind:'dc', src, start, stop, step }
 *   returns: { sweepValues, nodeV[node-1][k], converged: bool[] }
 *
 * The sweep source is assumed to be a V or I with a DC level. We
 * mutate it through `setElementValue`; after the sweep we restore the
 * final value (callers shouldn't need to care, but .tran following
 * .dc in the same netlist would otherwise see a shifted bias).
 */
export function solveDCSweep(ctx, sweepDirective) {
    const { src, start, stop, step } = sweepDirective;
    if (!(Math.abs(step) > 0) || !(Math.sign(stop - start) === Math.sign(step))) {
        throw new Error(`.dc: invalid sweep (${start} → ${stop} by ${step})`);
    }
    const tol = Math.abs(step) * 1e-6;
    const values = [];
    for (let v = start; step > 0 ? v <= stop + tol : v >= stop - tol; v += step) {
        values.push(v);
    }

    const nNodes = ctx.nNodes;
    // nodeV[i] is a length-K array holding V(node_{i+1}) across the sweep.
    const nodeV = new Array(nNodes - 1);
    for (let i = 0; i < nNodes - 1; i++) nodeV[i] = new Array(values.length);
    const nBranches = ctx.size - ctx.interior;
    const branchI = new Array(nBranches);
    for (let i = 0; i < nBranches; i++) branchI[i] = new Array(values.length);
    const converged = new Array(values.length);

    // Capture the source's original value so we can restore it.
    const targetEl = ctx.elems.find((e) => String(e.name).toLowerCase() === String(src).toLowerCase());
    const originalDc = targetEl && targetEl.source
        ? targetEl.source.find((s) => s.kind === 'dc')?.v
        : (targetEl?.value);

    // Use "continuation": seed each step's Newton-Raphson with the
    // previous step's solution. For smooth VTCs this dramatically
    // improves convergence and prevents the solver from jumping to
    // spurious operating points (which otherwise shows up as weird
    // vertical jumps mid-sweep, e.g. a −50 V artefact in a CMOS VTC).
    let prevSol = null;
    for (let k = 0; k < values.length; k++) {
        const applied = setElementValue(ctx, src, values[k]);
        if (!applied) throw new Error(`.dc: source ${src} has no sweepable value`);
        const dc = solveDC(ctx, prevSol ? { initial: prevSol } : {});
        converged[k] = dc.converged;
        for (let i = 0; i < nNodes - 1; i++) nodeV[i][k] = dc.x[i];
        for (let i = 0; i < nBranches; i++) branchI[i][k] = dc.x[ctx.interior + i];
        prevSol = dc.x;
    }

    if (originalDc !== undefined) setElementValue(ctx, src, originalDc);

    return {
        src,
        sweepValues: values,
        nodeV,
        branchI,
        converged,
    };
}
