/**
 * Worker host for the MEMS thermal solver. Runs SOR / FTCS off the main thread
 * and streams snapshot copies of the temperature field back to the UI.
 *
 * Message protocol (host → worker):
 *   { type: 'init',          opts }                 build state, post 'ready'
 *   { type: 'set-materials', materialIdx: ArrayBuffer }
 *   { type: 'set-heater',    heaterMask: ArrayBuffer, totalPowerW: number }
 *   { type: 'set-bcs',       hTop?, hBot?, ambientK?, thicknessUm? }
 *   { type: 'reset' }
 *   { type: 'run-steady',    opts? }                runs to convergence, posts 'steady-done'
 *   { type: 'start-transient', stepsPerFrame?: number, snapshotEveryMs?: number }
 *   { type: 'pause' }
 *   { type: 'set-probe',     i: number, j: number }
 *
 * (worker → host):
 *   { type: 'ready', Nx, Ny, dx, t_z, T_amb }
 *   { type: 'steady-done', result, T (ArrayBuffer), stats, simT }
 *   { type: 'transient-snapshot', T (ArrayBuffer), simT, dt, stats, history }
 *   { type: 'paused', simT }
 *   { type: 'error', message }
 */

import {
    makeThermalState,
    setMaterials,
    setHeaterPower as solverSetHeater,
    setSourceQwPerM3 as solverSetSourceQ,
    setDirichletPins as solverSetDirichletPins,
    solveSteady,
    stepTransient,
    maxStableDt,
    fieldStats,
    resetField,
    applyElectroThermalDrive,
} from './heatSolver.js';

/** @type {import('./heatSolver.js').ThermalState | null} */
let state = null;
let heaterMask = null;
let heaterPowerW = 0;
/** Optional per-cell initial-T override (from rasterizer). */
let initialMask = null;
let initialValueK = null;

/** Electrothermal source: { mode: 'V'|'I'|'P', value, R0Ohm, tcrPerK, refK }
    or null when the user wants the simple constant-power source. */
let drive = null;
let lastDriveReadout = null;

let mode = 'idle'; // 'idle' | 'transient'
let simT = 0;
let probeIdx = 0;
let history = []; // { t, Tprobe }
let stopRequested = false;

function postSnapshot(type, extra = {}) {
    if (!state) return;
    const buf = state.T.slice().buffer;
    self.postMessage(
        {
            type,
            T: buf,
            stats: fieldStats(state.T),
            simT,
            drive: lastDriveReadout,
            ...extra,
        },
        [buf]
    );
}

/** Re-apply the electrothermal drive (if set) — runs each step inside the
    transient loop so R(T), V, I, P all track the rising temperature. */
function refreshDrivePower() {
    if (!drive || !heaterMask || !state) return;
    lastDriveReadout = applyElectroThermalDrive(state, heaterMask, drive);
}

self.onmessage = (ev) => {
    const m = ev.data;
    try {
        if (m.type === 'init') {
            const opts = { ...m.opts };
            if (opts.materialIdx) opts.materialIdx = new Uint8Array(opts.materialIdx);
            state = makeThermalState(opts);
            heaterMask = null;
            heaterPowerW = 0;
            mode = 'idle';
            simT = 0;
            history = [];
            probeIdx = Math.floor((state.Nx * state.Ny) / 2);
            self.postMessage({
                type: 'ready',
                Nx: state.Nx,
                Ny: state.Ny,
                dx: state.dx,
                t_z: state.t_z,
                T_amb: state.T_amb,
            });
            return;
        }
        if (!state) return;
        if (m.type === 'set-materials') {
            setMaterials(state, new Uint8Array(m.materialIdx));
            return;
        }
        if (m.type === 'set-heater') {
            heaterMask = new Uint8Array(m.heaterMask);
            heaterPowerW = Number(m.totalPowerW) || 0;
            if (drive) {
                refreshDrivePower();
            } else {
                solverSetHeater(state, heaterMask, heaterPowerW);
            }
            return;
        }
        if (m.type === 'set-source-q') {
            const arr = new Float64Array(m.sourceQwPerM3);
            solverSetSourceQ(state, arr);
            return;
        }
        if (m.type === 'set-dirichlet') {
            const pinMask = m.pinMask ? new Uint8Array(m.pinMask) : null;
            const pinValueK = m.pinValueK ? new Float64Array(m.pinValueK) : null;
            solverSetDirichletPins(state, pinMask, pinValueK);
            return;
        }
        if (m.type === 'set-initial') {
            initialMask = m.initialMask ? new Uint8Array(m.initialMask) : null;
            initialValueK = m.initialValueK ? new Float64Array(m.initialValueK) : null;
            return;
        }
        if (m.type === 'set-drive') {
            if (m.drive && (m.drive.mode === 'V' || m.drive.mode === 'I' || m.drive.mode === 'P')) {
                drive = { ...m.drive };
                refreshDrivePower();
            } else {
                drive = null;
                lastDriveReadout = null;
                if (heaterMask) solverSetHeater(state, heaterMask, heaterPowerW);
            }
            return;
        }
        if (m.type === 'set-bcs') {
            if (Number.isFinite(m.ambientK)) state.T_amb = m.ambientK;
            if (Number.isFinite(m.hTop)) state.h_top = m.hTop;
            if (Number.isFinite(m.hBot)) state.h_bot = m.hBot;
            if (Number.isFinite(m.thicknessUm) && m.thicknessUm > 0)
                state.t_z = m.thicknessUm * 1e-6;
            state.h_eff_per_thick = (state.h_top + state.h_bot) / state.t_z;
            if (heaterMask) solverSetHeater(state, heaterMask, heaterPowerW);
            return;
        }
        if (m.type === 'set-probe') {
            const i = Math.max(0, Math.min(state.Nx - 1, m.i | 0));
            const j = Math.max(0, Math.min(state.Ny - 1, m.j | 0));
            probeIdx = j * state.Nx + i;
            return;
        }
        if (m.type === 'reset') {
            resetField(state, { initialMask, initialValueK });
            simT = 0;
            history = [];
            stopRequested = false;
            mode = 'idle';
            postSnapshot('transient-snapshot', { dt: 0, history: history.slice() });
            return;
        }
        if (m.type === 'run-steady') {
            stopRequested = false;
            mode = 'idle';
            /* For V/I drives we iterate steady → re-evaluate drive (T-dependent R)
               → re-solve, until the dissipated power converges. Quick fixed-point
               loop, usually 3-5 outer iters. */
            let result = null;
            const outerMax = drive ? 12 : 1;
            const outerTolFracP = 1e-3;
            let lastP = -Infinity;
            for (let outer = 0; outer < outerMax; outer++) {
                if (drive) refreshDrivePower();
                result = solveSteady(state, m.opts || {});
                const P = lastDriveReadout?.P ?? null;
                if (P === null) break;
                if (lastP > 0 && Math.abs(P - lastP) / lastP < outerTolFracP) break;
                lastP = P;
            }
            postSnapshot('steady-done', { result });
            return;
        }
        if (m.type === 'start-transient') {
            mode = 'transient';
            stopRequested = false;
            const stepsPerFrame = Math.max(1, m.stepsPerFrame | 0 || 80);
            const snapshotEveryMs = Math.max(8, Number(m.snapshotEveryMs) || 16);
            let lastPost = 0;
            const tick = () => {
                if (mode !== 'transient' || stopRequested) {
                    self.postMessage({ type: 'paused', simT, drive: lastDriveReadout });
                    return;
                }
                const dt = maxStableDt(state);
                for (let s = 0; s < stepsPerFrame; s++) {
                    /* Update Joule heating each step so R(T), V, I, P track the
                       rising temperature when the user is driving with V or I. */
                    if (drive) refreshDrivePower();
                    stepTransient(state, dt);
                    simT += dt;
                }
                const Tprobe = state.T[probeIdx];
                history.push({
                    t: simT,
                    Tprobe,
                    P: lastDriveReadout?.P ?? null,
                    R: lastDriveReadout?.R ?? null,
                    V: lastDriveReadout?.V ?? null,
                    I: lastDriveReadout?.I ?? null,
                });
                if (history.length > 20000) history = history.slice(-20000);
                const now = Date.now();
                if (now - lastPost >= snapshotEveryMs) {
                    lastPost = now;
                    postSnapshot('transient-snapshot', { dt, history: history.slice() });
                }
                /* yield to message queue so 'pause' can land */
                setTimeout(tick, 0);
            };
            tick();
            return;
        }
        if (m.type === 'pause') {
            stopRequested = true;
            mode = 'idle';
            return;
        }
    } catch (err) {
        self.postMessage({
            type: 'error',
            message: err && err.message ? err.message : String(err),
        });
    }
};
