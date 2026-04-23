import { evalPulse } from './analytes.js';

/**
 * LBM D2Q9 BGK solver for 2D incompressible viscous flow, with an
 * optional passive-scalar transport overlay for species (aroma analyte)
 * concentration. Also handles sensor probes — fluid cells flagged as
 * bordering a "sensor" edge get their mean near-wall c(t) and |u|(t)
 * reported back each snapshot.
 *
 * Runs entirely inside a Web Worker. The main thread ships an `init`
 * message with the rasterized geometry (fluid/wall/inlet/outlet mask),
 * physical gas properties, and boundary velocities. The worker then
 * marches the lattice forward and posts back periodic snapshots of
 * the velocity field + convergence residual.
 *
 * Species transport (when enabled by `species.enabled === true`):
 *   - Scalar field c(x, y, t) advances in lockstep with the LBM step
 *     using an explicit first-order upwind advection + central diffusion
 *     FD scheme. It's lattice-unit consistent: dx_lb = 1, dt_lb = 1,
 *     so the scheme is
 *       c' = c - (ux · dc/dx + uy · dc/dy)  - upwind
 *              + D_lb · (d²c/dx² + d²c/dy²) - central
 *     Stability: |u_lb| < 1 (CFL) and D_lb ≤ 0.25.
 *   - Inlet cells get c = cInletValue, recomputed **every LBM step**
 *     inside this worker as evalPulse(pulseId, pulseParams, iter·dt_s).
 *     (The main thread used to post `species-bc` only on each rendered
 *     frame — tens or hundreds of lattice steps apart — which kept the
 *     inlet "stuck" at the last value and made rectangular pulses never
 *     shut off in sim time; that caused c(t) traces that never returned
 *     to zero.) Optional `species-bc` / `species-pulse` messages remain
 *     for overrides / hot-reload of pulse parameters without a full init.
 *   - Outlet cells use zero-gradient (copy from upstream neighbour).
 *   - Wall cells are simply skipped. Zero-flux is emergent because no
 *     flux stencil reads across walls (we zero-clamp wall neighbours
 *     in the stencil).
 *
 * Cell types encoded in `mask`:
 *   0 = fluid       (collide + stream)
 *   1 = wall        (half-way bounce-back)
 *   2 = inlet       (prescribed velocity → equilibrium)
 *   3 = outlet      (zero-gradient copy from neighbour)
 */

/* ───────── D2Q9 lattice vectors ───────── */
const CX = new Int8Array([0, 1, 0, -1, 0, 1, -1, -1, 1]);
const CY = new Int8Array([0, 0, 1, 0, -1, 1, 1, -1, -1]);
const W = new Float32Array([
    4 / 9,
    1 / 9, 1 / 9, 1 / 9, 1 / 9,
    1 / 36, 1 / 36, 1 / 36, 1 / 36,
]);
const OPP = new Int8Array([0, 3, 4, 1, 2, 7, 8, 5, 6]);

const FLUID = 0;
const WALL = 1;
const INLET = 2;
const OUTLET = 3;

let state = null;

function buildInitialState({
    nx, ny, mask, inletDir, inletU_lb, outletDir,
    inletDirsPerCell, inletCPerCell,
    tau, stepsPerPost, postEvery,
    species, sensorEdges, dt_s,
    pulseId, pulseParams,
}) {
    const N = nx * ny;
    const f = new Float32Array(N * 9);
    const fNext = new Float32Array(N * 9);
    const rho = new Float32Array(N);
    const ux = new Float32Array(N);
    const uy = new Float32Array(N);
    const prevUmag = new Float32Array(N);

    for (let k = 0; k < N; k++) {
        rho[k] = 1;
        for (let i = 0; i < 9; i++) f[k * 9 + i] = W[i];
    }

    // Species state (only allocated when enabled to keep small sims lean).
    let c = null, cNext = null, D_lb = 0, cInletValue = 0;
    if (species && species.enabled) {
        c = new Float32Array(N);
        cNext = new Float32Array(N);
        D_lb = species.D_lb;
        cInletValue = 0; // overwritten each species step from evalPulse
    }

    const pid = typeof pulseId === 'string' ? pulseId : 'step';
    const pparams = pulseParams && typeof pulseParams === 'object' ? { ...pulseParams } : {};

    return {
        nx, ny, N, mask,
        f, fNext, rho, ux, uy, prevUmag,
        inletDir, inletU_lb, outletDir,
        // Per-INLET-cell overrides. When present, each INLET cell uses
        // its own inward normal + concentration multiplier instead of
        // the single global inletDir / cInletValue. Multi-stream
        // mixers (two streams with c=1 / c=0) need these.
        inletDirsPerCell: inletDirsPerCell || null,
        inletCPerCell: inletCPerCell || null,
        tau, invTau: 1 / tau,
        iter: 0,
        residual: 1,
        stepsPerPost: stepsPerPost || 8,
        postEvery: postEvery || 16,
        lastPostTime: 0,
        running: false,
        paused: false,
        // Species
        speciesEnabled: !!(species && species.enabled),
        c, cNext, D_lb, cInletValue,
        pulseId: pid,
        pulseParams: pparams,
        // Timing — main thread chose dt_s, we mirror it so sensor probes
        // can stamp absolute wall-clock time (seconds of simulated flow).
        dt_s: dt_s || 0,
        // Sensor probes — each entry: { edgeIdx, cells, length_mm, label }
        sensorEdges: sensorEdges || [],
        // Rolling sensor history buffer (downsampled every `postEvery`).
        // Kept in the worker so the main thread only receives the latest
        // slice, which it can append to its own React-state history.
        lastSensorIter: -1,
    };
}

function feq(rho, ux, uy, i) {
    const cu = CX[i] * ux + CY[i] * uy;
    const usq = ux * ux + uy * uy;
    return W[i] * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * usq);
}

function step(s) {
    const { nx, ny, N, mask, f, fNext, rho, ux, uy, invTau, inletDir, inletU_lb } = s;

    /* 1. Macroscopic moments. */
    for (let k = 0; k < N; k++) {
        if (mask[k] === WALL) continue;
        let r = 0, vx = 0, vy = 0;
        const off = k * 9;
        for (let i = 0; i < 9; i++) {
            const fi = f[off + i];
            r += fi;
            vx += fi * CX[i];
            vy += fi * CY[i];
        }
        if (r > 0) {
            ux[k] = vx / r;
            uy[k] = vy / r;
        } else {
            ux[k] = 0;
            uy[k] = 0;
        }
        rho[k] = r;
    }

    /* 2. Inlet / outlet BCs. */
    const idPerCell = s.inletDirsPerCell;
    for (let k = 0; k < N; k++) {
        if (mask[k] !== INLET) continue;
        // Per-cell inward direction if available (multi-stream mixer),
        // else fall back to the global inlet direction (single-inlet case).
        let dxDir = inletDir[0];
        let dyDir = inletDir[1];
        if (idPerCell) {
            const dxp = idPerCell[2 * k];
            const dyp = idPerCell[2 * k + 1];
            if (dxp !== 0 || dyp !== 0) { dxDir = dxp; dyDir = dyp; }
        }
        const tx = dxDir * inletU_lb;
        const ty = dyDir * inletU_lb;
        ux[k] = tx;
        uy[k] = ty;
        rho[k] = 1;
        const off = k * 9;
        for (let i = 0; i < 9; i++) f[off + i] = feq(1, tx, ty, i);
    }
    for (let k = 0; k < N; k++) {
        if (mask[k] !== OUTLET) continue;
        const x = k % nx;
        const y = (k / nx) | 0;
        const nxn = Math.max(0, Math.min(nx - 1, x - s.outletDir[0]));
        const nyn = Math.max(0, Math.min(ny - 1, y - s.outletDir[1]));
        const kn = nyn * nx + nxn;
        if (mask[kn] !== WALL) {
            const off = k * 9;
            const on = kn * 9;
            for (let i = 0; i < 9; i++) f[off + i] = f[on + i];
            ux[k] = ux[kn];
            uy[k] = uy[kn];
            rho[k] = rho[kn];
        }
    }

    /* 3. BGK collision. */
    for (let k = 0; k < N; k++) {
        if (mask[k] === WALL) continue;
        const r = rho[k], vx = ux[k], vy = uy[k];
        const off = k * 9;
        for (let i = 0; i < 9; i++) {
            const fi = f[off + i];
            f[off + i] = fi - invTau * (fi - feq(r, vx, vy, i));
        }
    }

    /* 4. Streaming with half-way bounce-back. */
    fNext.set(f);
    for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
            const k = y * nx + x;
            if (mask[k] === WALL) continue;
            const off = k * 9;
            for (let i = 1; i < 9; i++) {
                const nxp = x + CX[i];
                const nyp = y + CY[i];
                if (nxp < 0 || nxp >= nx || nyp < 0 || nyp >= ny) continue;
                const kn = nyp * nx + nxp;
                if (mask[kn] === WALL) {
                    fNext[off + OPP[i]] = f[off + i];
                } else {
                    fNext[kn * 9 + i] = f[off + i];
                }
            }
        }
    }
    const tmp = s.f;
    s.f = s.fNext;
    s.fNext = tmp;

    /* 5. Species transport (if enabled).
     *   Explicit 1st-order upwind advection + central diffusion on the
     *   same lattice. This is NOT the LBM scalar-collision formulation
     *   (which would require a second set of 9 populations) — the FD
     *   version is much cheaper and plenty accurate for Sc ≈ 1 gas-phase
     *   aroma problems. Walls are treated as zero-flux by short-circuit:
     *   any stencil sample that lands in a wall cell copies the centre
     *   value, which nulls that directional flux. */
    if (s.speciesEnabled) {
        /* Update inlet concentration in **simulation time** (iter · dt_s)
           every LBM sub-step — otherwise the pulse only refreshes when
           the main thread posts `species-bc` on each rendered frame,
           which is tens-to-hundreds of lattice steps apart and makes
           rectangular pulses never shut off in sim time → c(t) that
           never returns to zero. */
        const tSim = s.iter * s.dt_s;
        const prevCInlet = s.cInletValue;
        s.cInletValue = evalPulse(s.pulseId, s.pulseParams, tSim);
        /* One-time diagnostics so a user inspecting DevTools can tell,
           within the first few seconds of sim time, whether the pulse
           evaluator is firing at all. Three lines total in normal
           operation: first step, first rise, first fall. If "first rise"
           never prints while sim time is inside the pulse window, the
           solver is receiving bad pulseId / pulseParams / dt_s. */
        if (!s._dbgLoggedFirst) {
            console.log('[lbm] species step #1', {
                pulseId: s.pulseId, pulseParams: s.pulseParams,
                dt_s: s.dt_s, tSim, cInletValue: s.cInletValue,
            });
            s._dbgLoggedFirst = true;
        }
        if (!s._dbgLoggedRise && prevCInlet < 1e-6 && s.cInletValue >= 1e-6) {
            console.log('[lbm] inlet pulse RISE @ tSim =', tSim.toFixed(4),
                's → cInletValue =', s.cInletValue.toFixed(3));
            s._dbgLoggedRise = true;
        }
        if (!s._dbgLoggedFall && prevCInlet >= 1e-6 && s.cInletValue < 1e-6) {
            console.log('[lbm] inlet pulse FALL @ tSim =', tSim.toFixed(4),
                's → cInletValue =', s.cInletValue.toFixed(3));
            s._dbgLoggedFall = true;
        }
        const { c, cNext, D_lb } = s;
        for (let y = 0; y < ny; y++) {
            for (let x = 0; x < nx; x++) {
                const k = y * nx + x;
                const m = mask[k];
                if (m === WALL) { cNext[k] = 0; continue; }
                if (m === INLET) {
                    // Two-stream mixers: each INLET cell carries a
                    // per-edge multiplier (0..1). Streams tagged c=0
                    // stay clean even while the pulse is on at c=1.
                    const mul = s.inletCPerCell ? s.inletCPerCell[k] : 1;
                    cNext[k] = s.cInletValue * mul;
                    continue;
                }
                // Sample neighbours with zero-flux wall fallback (copy centre).
                const cC = c[k];
                const kE = x + 1 < nx ? k + 1 : k;
                const kW = x - 1 >= 0 ? k - 1 : k;
                const kN = y + 1 < ny ? k + nx : k;
                const kS = y - 1 >= 0 ? k - nx : k;
                const cE = mask[kE] === WALL ? cC : c[kE];
                const cW = mask[kW] === WALL ? cC : c[kW];
                const cN = mask[kN] === WALL ? cC : c[kN];
                const cS = mask[kS] === WALL ? cC : c[kS];
                // Upwind advection (lattice units, dx=dt=1):
                const uxc = ux[k];
                const uyc = uy[k];
                const adv =
                    (uxc >= 0 ? uxc * (cC - cW) : uxc * (cE - cC)) +
                    (uyc >= 0 ? uyc * (cC - cS) : uyc * (cN - cC));
                // Central diffusion (5-point Laplacian):
                const lap = cE + cW + cN + cS - 4 * cC;
                let cn = cC - adv + D_lb * lap;
                // Outlet → zero-gradient: copy from upstream neighbour
                // (in the dominant outward direction).
                if (m === OUTLET) {
                    const odx = s.outletDir[0];
                    const ody = s.outletDir[1];
                    const kup = ((y - ody) * nx + (x - odx));
                    if (kup >= 0 && kup < s.N && mask[kup] !== WALL) cn = c[kup];
                }
                // Clamp to avoid blow-ups from any tiny instability —
                // concentrations are logically in [0, ≈10], clipping at
                // [−0.05, 10] stays invisible to any reasonable profile.
                if (cn < -0.05) cn = -0.05;
                else if (cn > 10) cn = 10;
                cNext[k] = cn;
            }
        }
        // Double-buffer swap.
        const tmpC = s.c;
        s.c = s.cNext;
        s.cNext = tmpC;
    }

    s.iter++;
}

function computeResidual(s) {
    const { N, ux, uy, prevUmag } = s;
    let num = 0, den = 0;
    for (let k = 0; k < N; k++) {
        const m = Math.hypot(ux[k], uy[k]);
        const dm = m - prevUmag[k];
        num += dm * dm;
        den += m * m;
        prevUmag[k] = m;
    }
    s.residual = Math.sqrt(num / (den + 1e-12));
}

/* Compute per-sensor aggregates (mean c, mean |u|, max |u|, cell count).
   Only takes a few µs per sensor even on big grids — all done each snapshot. */
function computeSensorSnapshots(s) {
    const out = [];
    if (!s.sensorEdges || s.sensorEdges.length === 0) return out;
    for (const sen of s.sensorEdges) {
        const cells = sen.cells;
        if (!cells || cells.length === 0) {
            out.push({ edgeIdx: sen.edgeIdx, label: sen.label, c_mean: 0, u_mean: 0, u_max: 0, count: 0 });
            continue;
        }
        let csum = 0, usum = 0, umax = 0;
        const hasC = s.speciesEnabled && s.c;
        for (const k of cells) {
            if (hasC) csum += s.c[k];
            const m = Math.hypot(s.ux[k], s.uy[k]);
            usum += m;
            if (m > umax) umax = m;
        }
        out.push({
            edgeIdx: sen.edgeIdx,
            label: sen.label,
            c_mean: hasC ? csum / cells.length : 0,
            u_mean: usum / cells.length,
            u_max: umax,
            count: cells.length,
        });
    }
    return out;
}

function postField(s) {
    const umag = new Float32Array(s.N);
    let umax = 0;
    for (let k = 0; k < s.N; k++) {
        if (s.mask[k] === WALL) { umag[k] = 0; continue; }
        const m = Math.hypot(s.ux[k], s.uy[k]);
        umag[k] = m;
        if (m > umax) umax = m;
    }
    const msg = {
        type: 'field',
        iter: s.iter,
        residual: s.residual,
        umag,
        ux: new Float32Array(s.ux),
        uy: new Float32Array(s.uy),
        umax,
        t_s: s.iter * s.dt_s,
        sensorSnapshot: computeSensorSnapshots(s),
    };
    if (s.speciesEnabled && s.c) {
        msg.c = new Float32Array(s.c);
        msg.cInletValue = s.cInletValue;
        /* Scan the whole scalar field for the max concentration, plus
           the max AT fluid cells that are NOT inlet cells. The second
           value is the crucial one: if it stays 0 while cInletValue
           is non-zero, the species solver is not transporting the
           puff away from the inlet boundary (mask / direction bug).
           Include in field message so the UI can display it live
           without scraping console. */
        let cMax = 0, cMaxFluid = 0;
        for (let k = 0; k < s.N; k++) {
            const v = s.c[k];
            if (v > cMax) cMax = v;
            if (s.mask[k] === FLUID && v > cMaxFluid) cMaxFluid = v;
        }
        msg.cMax = cMax;
        msg.cMaxFluid = cMaxFluid;
        /* One-off console breadcrumb the first time the *interior*
           concentration goes non-zero — confirms advection/diffusion
           are actually running. */
        if (!s._dbgLoggedInterior && cMaxFluid > 1e-6) {
            console.log('[lbm] interior c first non-zero @ tSim =',
                (s.iter * s.dt_s).toFixed(4), 's, max c in fluid =',
                cMaxFluid.toFixed(4));
            s._dbgLoggedInterior = true;
        }
    }
    self.postMessage(msg);
}

function loop() {
    if (!state || !state.running) return;
    for (let s = 0; s < state.stepsPerPost; s++) {
        if (!state.running) break;
        step(state);
    }
    computeResidual(state);
    const now = performance.now();
    if (now - state.lastPostTime > state.postEvery) {
        postField(state);
        state.lastPostTime = now;
    }
    setTimeout(loop, 0);
}

/* ───────── Message handler ───────── */
self.onmessage = (ev) => {
    const m = ev.data || {};
    switch (m.type) {
        case 'init': {
            state = buildInitialState(m);
            self.postMessage({ type: 'ready', nx: state.nx, ny: state.ny, tau: state.tau });
            break;
        }
        case 'start': {
            if (!state) break;
            state.running = true;
            state.paused = false;
            loop();
            break;
        }
        case 'pause': {
            if (!state) break;
            state.running = false;
            state.paused = true;
            break;
        }
        case 'stop': {
            state = null;
            break;
        }
        case 'snapshot': {
            if (state) postField(state);
            break;
        }
        case 'species-bc': {
            /* Legacy: hard-set inlet c (rare). Per-step pulse is the default. */
            if (state) state.cInletValue = Number(m.cInletValue) || 0;
            break;
        }
        case 'species-pulse': {
            if (state && state.speciesEnabled) {
                if (typeof m.pulseId === 'string') state.pulseId = m.pulseId;
                if (m.pulseParams && typeof m.pulseParams === 'object') {
                    state.pulseParams = { ...m.pulseParams };
                }
            }
            break;
        }
        case 'species-reset': {
            // Wipe the scalar field (for restart between parametric runs).
            if (state && state.c) {
                state.c.fill(0);
                state.cNext.fill(0);
                state.cInletValue = 0;
            }
            break;
        }
    }
};
