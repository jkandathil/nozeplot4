/**
 * 2D heat-equation finite-difference solver for MEMS micro-hotplates.
 *
 * Governing equation (in-plane temperature field T(x,y) on a thin membrane of
 * thickness `t_z`, with out-of-plane convection lumped as a Robin sink):
 *
 *   ρc · ∂T/∂t = ∂/∂x(k ∂T/∂x) + ∂/∂y(k ∂T/∂y)
 *                - (h_top + h_bot)/t_z · (T - T_amb) + q'''(x, y)
 *
 *   ─────────────────────────────────  conduction in‑plane
 *                                       ─────────  out‑of‑plane convective loss
 *                                                   ────  volumetric heat source [W/m³]
 *
 * Discretisation:
 *   - Uniform grid (dx = dy = h), staggered conductivity using harmonic mean
 *     between adjacent cells. This handles material interfaces (e.g. Pt heater
 *     on Si3N4 membrane) without smearing the conductivity contrast.
 *   - Steady-state: Gauss-Seidel SOR, iterated until max |ΔT| < tolK.
 *   - Transient:    Explicit FTCS with stability `dt < 0.4 · h² / (4α + h²·H/ρc)`.
 *
 * All arrays are dense Float64 / Uint8 — fine for grids up to ~250×250 in the
 * browser; the worker streams snapshot copies back to the UI.
 */

import { THERMAL_MATERIAL_IDS, THERMAL_MATERIALS } from './materials.js';

/**
 * @typedef {{
 *   Nx: number,
 *   Ny: number,
 *   dx: number,                 cell pitch [m]
 *   t_z: number,                membrane thickness [m]
 *   T_amb: number,              ambient temperature [K]
 *   h_top: number,              top-surface convection [W/m²/K]
 *   h_bot: number,              bottom-surface convection [W/m²/K]
 *   h_eff_per_thick: number,    (h_top + h_bot) / t_z   [W/m³/K]
 *   materialIdx: Uint8Array,    cell → THERMAL_MATERIAL_IDS index
 *   k: Float64Array,            cell thermal conductivity [W/m/K]
 *   rhoc: Float64Array,         cell ρ·c volumetric heat capacity [J/m³/K]
 *   T: Float64Array,            current temperature field [K]
 *   Tnext: Float64Array,        scratch buffer for transient swap
 *   Q: Float64Array,            total volumetric heat source [W/m³]
 *   Qheater: Float64Array,      heater-only contribution to Q (rebuilt by drive)
 *   Qsource: Float64Array,      per-cell source Q from user-drawn regions
 *   dirichlet: Uint8Array,      1 = T fixed (boundary or pinned cell)
 *   dirichletValueK: Float64Array, pinned T (Kelvin); valid where dirichlet=1
 * }} ThermalState
 */

/** Harmonic mean — correct way to upscale conductivity at material faces. */
function harmonicMean(a, b) {
    const s = a + b;
    return s > 0 ? (2 * a * b) / s : 0;
}

/**
 * Build conductivity / capacity arrays from a material index grid.
 *
 * @param {Uint8Array} materialIdx
 * @returns {{ k: Float64Array, rhoc: Float64Array }}
 */
export function buildPropArrays(materialIdx) {
    const N = materialIdx.length;
    const k = new Float64Array(N);
    const rhoc = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const id = THERMAL_MATERIAL_IDS[materialIdx[i]] ?? 'air';
        const m = THERMAL_MATERIALS[id];
        k[i] = m.kWmK;
        rhoc[i] = m.rhoKgM3 * m.cJkgK;
    }
    return { k, rhoc };
}

/**
 * @param {{
 *   Nx: number, Ny: number, dx: number,
 *   thicknessUm?: number,
 *   ambientK?: number,
 *   hTop?: number, hBot?: number,
 *   materialIdx?: Uint8Array,
 *   pinFrame?: boolean,
 * }} opts
 * @returns {ThermalState}
 */
export function makeThermalState(opts) {
    const Nx = opts.Nx | 0;
    const Ny = opts.Ny | 0;
    if (Nx < 4 || Ny < 4) {
        throw new Error(`Thermal grid too small (${Nx}×${Ny}); need ≥ 4×4.`);
    }
    const N = Nx * Ny;
    const dx = Number(opts.dx);
    if (!(dx > 0)) throw new Error('Thermal grid pitch dx must be > 0 (meters).');
    const t_z = (Number(opts.thicknessUm) || 1) * 1e-6;
    const T_amb = Number.isFinite(opts.ambientK) ? opts.ambientK : 293.15;
    const h_top = Number.isFinite(opts.hTop) ? opts.hTop : 10;
    const h_bot = Number.isFinite(opts.hBot) ? opts.hBot : 10;
    const h_eff_per_thick = (h_top + h_bot) / t_z;

    const materialIdx = opts.materialIdx ? new Uint8Array(opts.materialIdx) : new Uint8Array(N);
    const { k, rhoc } = buildPropArrays(materialIdx);

    const T = new Float64Array(N);
    T.fill(T_amb);
    const Tnext = new Float64Array(N);
    Tnext.set(T);
    const Q = new Float64Array(N);
    const Qheater = new Float64Array(N);
    const Qsource = new Float64Array(N);
    const dirichlet = new Uint8Array(N);
    const dirichletValueK = new Float64Array(N);
    dirichletValueK.fill(T_amb);

    if (opts.pinFrame !== false) {
        for (let i = 0; i < Nx; i++) {
            dirichlet[i] = 1;
            dirichletValueK[i] = T_amb;
            dirichlet[(Ny - 1) * Nx + i] = 1;
            dirichletValueK[(Ny - 1) * Nx + i] = T_amb;
        }
        for (let j = 0; j < Ny; j++) {
            dirichlet[j * Nx] = 1;
            dirichletValueK[j * Nx] = T_amb;
            dirichlet[j * Nx + Nx - 1] = 1;
            dirichletValueK[j * Nx + Nx - 1] = T_amb;
        }
    }

    return {
        Nx,
        Ny,
        dx,
        t_z,
        T_amb,
        h_top,
        h_bot,
        h_eff_per_thick,
        materialIdx,
        k,
        rhoc,
        T,
        Tnext,
        Q,
        Qheater,
        Qsource,
        dirichlet,
        dirichletValueK,
    };
}

/** Replace material indices and rebuild k / ρc arrays in place. */
export function setMaterials(state, materialIdx) {
    if (materialIdx.length !== state.materialIdx.length) {
        throw new Error('Material grid size mismatch.');
    }
    state.materialIdx = new Uint8Array(materialIdx);
    const { k, rhoc } = buildPropArrays(state.materialIdx);
    state.k = k;
    state.rhoc = rhoc;
}

/** Apply Dirichlet pin values (frame edges + user-drawn fixed-T regions). */
export function pinDirichletCells(state) {
    const { dirichlet, dirichletValueK, T } = state;
    for (let p = 0; p < dirichlet.length; p++) {
        if (dirichlet[p]) T[p] = dirichletValueK[p];
    }
}

/** Recompute the total Q field as Qheater + Qsource. */
export function recomposeQ(state) {
    const { Q, Qheater, Qsource } = state;
    for (let p = 0; p < Q.length; p++) Q[p] = Qheater[p] + Qsource[p];
}

/** One Gauss-Seidel SOR sweep over interior cells. Returns max |ΔT| this sweep. */
export function steadySORSweep(state, omega) {
    const { Nx, Ny, dx, T, k, Q, dirichlet, h_eff_per_thick, T_amb } = state;
    const h2 = dx * dx;
    let maxDelta = 0;

    for (let j = 1; j < Ny - 1; j++) {
        const row = j * Nx;
        for (let i = 1; i < Nx - 1; i++) {
            const p = row + i;
            if (dirichlet[p]) continue;
            const kp = k[p];
            const ke = harmonicMean(kp, k[p + 1]);
            const kw = harmonicMean(kp, k[p - 1]);
            const kn = harmonicMean(kp, k[p + Nx]);
            const ks = harmonicMean(kp, k[p - Nx]);

            const C = (ke + kw + kn + ks) / h2 + h_eff_per_thick;
            if (C === 0) continue;

            const num =
                (ke * T[p + 1] + kw * T[p - 1] + kn * T[p + Nx] + ks * T[p - Nx]) / h2 +
                Q[p] +
                h_eff_per_thick * T_amb;
            const Tgs = num / C;
            const Tnew = T[p] + omega * (Tgs - T[p]);
            const d = Math.abs(Tnew - T[p]);
            if (d > maxDelta) maxDelta = d;
            T[p] = Tnew;
        }
    }
    return maxDelta;
}

/**
 * Solve to steady state with Gauss-Seidel SOR.
 *
 * @param {ThermalState} state
 * @param {{ tolK?: number, maxIters?: number, omega?: number }} [opts]
 */
export function solveSteady(state, opts = {}) {
    const tolK = Number.isFinite(opts.tolK) ? opts.tolK : 1e-3;
    const maxIters = Number.isFinite(opts.maxIters) ? opts.maxIters : 20000;
    const omega = Number.isFinite(opts.omega) ? opts.omega : 1.7;
    let iter = 0;
    let res = Infinity;
    for (; iter < maxIters; iter++) {
        res = steadySORSweep(state, omega);
        if (res < tolK) {
            iter++;
            break;
        }
    }
    return { iters: iter, residualK: res, converged: res < tolK };
}

/**
 * Maximum stable explicit time step (FTCS, with safety factor 0.4).
 *
 * Stability:  dt ≤ ρc·dx² / (4·k_max + dx² · H_eff)
 * Use cell-wise minimum so heaters with high k don't blow up.
 *
 * @param {ThermalState} state
 * @returns {number} dt in seconds
 */
export function maxStableDt(state) {
    const { Nx, Ny, dx, k, rhoc, h_eff_per_thick } = state;
    const h2 = dx * dx;
    let minDt = Infinity;
    const N = Nx * Ny;
    for (let p = 0; p < N; p++) {
        const rc = rhoc[p];
        if (!(rc > 0)) continue;
        const denom = 4 * k[p] + h2 * h_eff_per_thick;
        if (!(denom > 0)) continue;
        const dt = (rc * h2) / denom;
        if (dt < minDt) minDt = dt;
    }
    if (!Number.isFinite(minDt)) return 1e-6;
    return 0.4 * minDt;
}

/**
 * One explicit FTCS time step. T is updated in place via Tnext swap.
 *
 * @param {ThermalState} state
 * @param {number} dt
 */
export function stepTransient(state, dt) {
    const { Nx, Ny, dx, T, Tnext, k, rhoc, Q, dirichlet, h_eff_per_thick, T_amb } = state;
    const h2 = dx * dx;

    /* Boundaries: pin Dirichlet rows / columns (top, bottom, left, right). */
    Tnext.set(T);

    for (let j = 1; j < Ny - 1; j++) {
        const row = j * Nx;
        for (let i = 1; i < Nx - 1; i++) {
            const p = row + i;
            if (dirichlet[p]) continue;

            const kp = k[p];
            const ke = harmonicMean(kp, k[p + 1]);
            const kw = harmonicMean(kp, k[p - 1]);
            const kn = harmonicMean(kp, k[p + Nx]);
            const ks = harmonicMean(kp, k[p - Nx]);

            const cond =
                (ke * (T[p + 1] - T[p]) +
                    kw * (T[p - 1] - T[p]) +
                    kn * (T[p + Nx] - T[p]) +
                    ks * (T[p - Nx] - T[p])) /
                h2;
            const loss = h_eff_per_thick * (T[p] - T_amb);
            const rc = rhoc[p] > 0 ? rhoc[p] : 1;
            Tnext[p] = T[p] + (dt * (cond + Q[p] - loss)) / rc;
        }
    }

    /* swap (Float64Array.set is fast; keeps T as the public field). */
    T.set(Tnext);
}

/** Aggregate stats restricted to cells where mask !== 0 (or all if null). */
export function fieldStats(T, mask) {
    let mn = Infinity;
    let mx = -Infinity;
    let sum = 0;
    let n = 0;
    for (let p = 0; p < T.length; p++) {
        if (mask && !mask[p]) continue;
        const v = T[p];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v;
        n++;
    }
    if (n === 0) return { minK: 0, maxK: 0, meanK: 0, count: 0 };
    return { minK: mn, maxK: mx, meanK: sum / n, count: n };
}

/** Helper: K → °C. */
export const KtoC = (k) => k - 273.15;
/** Helper: °C → K. */
export const CtoK = (c) => c + 273.15;

/**
 * Set `Qheater` to deliver `totalPowerW` uniformly across cells where
 * `heaterMask[p] === 1`. The total Q field is recomposed (Qheater + Qsource).
 * Heat is volumetric (W/m³); area conversion uses dx² · t_z per cell.
 *
 * @param {ThermalState} state
 * @param {Uint8Array} heaterMask
 * @param {number} totalPowerW
 */
export function setHeaterPower(state, heaterMask, totalPowerW) {
    const { dx, t_z, Qheater } = state;
    Qheater.fill(0);
    let count = 0;
    for (let p = 0; p < heaterMask.length; p++) if (heaterMask[p]) count++;
    if (count > 0 && totalPowerW > 0) {
        const cellVol = dx * dx * t_z;
        const Qcell = totalPowerW / (count * cellVol);
        for (let p = 0; p < heaterMask.length; p++) if (heaterMask[p]) Qheater[p] = Qcell;
    }
    recomposeQ(state);
}

/**
 * Replace the per-cell source Q layer (W/m³) with a precomputed array (e.g.
 * from the rasterizer). Then recompose total Q.
 */
export function setSourceQwPerM3(state, sourceQ) {
    state.Qsource.set(sourceQ);
    recomposeQ(state);
}

/**
 * Replace the Dirichlet pin layer (mask + per-cell T values). Frame-edge pins
 * are merged with user-drawn pins. Cells not pinned by either keep dirichlet=0.
 */
export function setDirichletPins(state, interiorPinMask, interiorPinValueK) {
    const { Nx, Ny, T_amb } = state;
    const dirichlet = state.dirichlet;
    const dirichletValueK = state.dirichletValueK;
    /* Reset everywhere. */
    dirichlet.fill(0);
    dirichletValueK.fill(T_amb);
    /* Frame edges. */
    for (let i = 0; i < Nx; i++) {
        dirichlet[i] = 1;
        dirichletValueK[i] = T_amb;
        dirichlet[(Ny - 1) * Nx + i] = 1;
        dirichletValueK[(Ny - 1) * Nx + i] = T_amb;
    }
    for (let j = 0; j < Ny; j++) {
        dirichlet[j * Nx] = 1;
        dirichletValueK[j * Nx] = T_amb;
        dirichlet[j * Nx + Nx - 1] = 1;
        dirichletValueK[j * Nx + Nx - 1] = T_amb;
    }
    /* Merge user-drawn interior pins (override frame if any overlap on
       outermost ring — that's intentional, e.g. a hot pad on the rim). */
    if (interiorPinMask && interiorPinValueK) {
        for (let p = 0; p < dirichlet.length; p++) {
            if (interiorPinMask[p]) {
                dirichlet[p] = 1;
                dirichletValueK[p] = interiorPinValueK[p];
            }
        }
    }
    /* Re-apply pin values to T. */
    pinDirichletCells(state);
}

/**
 * Reset T to ambient (Dirichlet cells keep their pinned value; frame edges
 * therefore stay at T_amb but a user-drawn fixed-T region resets to its pin).
 *
 * @param {ThermalState} state
 * @param {{ initialMask?: Uint8Array, initialValueK?: Float64Array }} [opts]
 */
export function resetField(state, opts = {}) {
    state.T.fill(state.T_amb);
    if (opts.initialMask && opts.initialValueK) {
        for (let p = 0; p < state.T.length; p++) {
            if (opts.initialMask[p]) state.T[p] = opts.initialValueK[p];
        }
    }
    pinDirichletCells(state);
    state.Tnext.set(state.T);
}

/**
 * Electrothermal driver — converts a voltage / current / power source on the
 * heater region into a Joule heat flux, with **temperature-dependent resistance**:
 *
 *   R(T) = R₀ · ( 1 + α · (T_avg − T_ref) )
 *
 * where T_avg is the mean of T over the heater cells. The instantaneous power
 * is then dissipated uniformly across the heater volume:
 *
 *   mode 'V':  P = V² / R(T)
 *   mode 'I':  P = I² · R(T)
 *   mode 'P':  P = const (no electrothermal feedback)
 *
 * Returns the readout the UI charts ({ Tavg, R, P, V, I }).
 *
 * @param {ThermalState} state
 * @param {Uint8Array} heaterMask
 * @param {{
 *   mode: 'V'|'I'|'P',
 *   value: number,         volts | amps | watts (depending on mode)
 *   R0Ohm: number,         resistance at refK
 *   tcrPerK: number,       α
 *   refK: number,          T_ref in Kelvin
 *   maxPowerW?: number,    optional clamp (e.g. compliance limit)
 * }} drive
 */
export function applyElectroThermalDrive(state, heaterMask, drive) {
    if (!heaterMask || !drive) return null;
    let n = 0;
    let Tsum = 0;
    for (let p = 0; p < heaterMask.length; p++) {
        if (!heaterMask[p]) continue;
        Tsum += state.T[p];
        n++;
    }
    if (n === 0) return { Tavg: state.T_amb, R: drive.R0Ohm, P: 0, V: 0, I: 0 };
    const Tavg = Tsum / n;
    const R0 = Math.max(1e-9, Number(drive.R0Ohm) || 0);
    const alpha = Number.isFinite(drive.tcrPerK) ? drive.tcrPerK : 0;
    const refK = Number.isFinite(drive.refK) ? drive.refK : 293.15;
    const R = Math.max(1e-9, R0 * (1 + alpha * (Tavg - refK)));

    let P = 0;
    let V = 0;
    let I = 0;
    if (drive.mode === 'V') {
        V = Number(drive.value) || 0;
        I = V / R;
        P = (V * V) / R;
    } else if (drive.mode === 'I') {
        I = Number(drive.value) || 0;
        V = I * R;
        P = I * I * R;
    } else {
        P = Math.max(0, Number(drive.value) || 0);
        V = Math.sqrt(P * R);
        I = P > 0 ? V / R : 0;
    }
    if (Number.isFinite(drive.maxPowerW) && drive.maxPowerW > 0 && P > drive.maxPowerW) {
        P = drive.maxPowerW;
        V = Math.sqrt(P * R);
        I = P > 0 ? V / R : 0;
    }

    setHeaterPower(state, heaterMask, P);
    return { Tavg, R, P, V, I };
}
