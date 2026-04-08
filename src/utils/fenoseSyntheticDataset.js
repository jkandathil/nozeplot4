import { parseFenoseDeviceIdFromFilename } from './fenoseModel.js';
import { getFeNOseAromaTrimPhaseLayout, FENOSE_AROMA_TRIM_DEFAULTS } from './fenoseAromaTrim.js';

/**
 * Synthetic FeNOse-style tabular rows for workspace training / demos.
 * Phases and columns match extractFenoseFeaturesFromRows:
 * AmbientSamplingRFC, BreathSampleCollection (baseline), FeNOWindow, FeNOMeasurement (canonical time order); A1–H8; AQT0, AQH0, AQP0.
 *
 * Temporal behaviour (wash-in, FeNO window decay, drift) is designed so ML features (means, feno std,
 * window deltas) resemble real captures, not IID plateaus per phase.
 *
 * **No hardware recovery phase.** Rows with `recoveryOff` or any `event_name` containing
 * `recovery` are never emitted.
 *
 * Phase order (chronological, matching real FeNOse captures):
 *   AmbientSamplingRFC → BreathSampleCollection → FeNOWindow → FeNOMeasurement
 *
 * When `windowBeforeMeasurement` is false (non-canonical / some older captures), the order is
 * RFC → BSC → FeNOMeasurement → FeNOWindow instead.
 *
 * RFC vs BSC levels (critical for Aroma / ALAAC plots)
 * ────────────────────────────────────────────────────
 * FeNOse ML uses BreathSampleCollection (BSC) as the baseline for deltas. Aroma normalises
 * traces with the median of **AmbientSamplingRFC** (room air). If synthetic RFC rows were
 * generated at the **same** raw level as BSC (historical bug: one `amb_med` from BSC only),
 * RFC-normalised plots look flat: there is almost no room-air → breath → FeNO structure.
 * We now carry **rfc_med** and **bsc_med** per sensor; RFC phase uses rfc_med, BSC/FeNO/window
 * use bsc_med for the breath-matrix + ND model (nd_slope still fitted vs BSC-referenced ND).
 *
 * Calibration strategy
 * ─────────────────────
 * Call computeCalibrationFromFiles(parsedRealFiles) to derive per-sensor parameters
 * (levels + ND statistics) from real device captures in the workspace. Pass the result
 * as the `calibration` argument to generateSyntheticFenoseRows.
 *
 * If real data is unavailable the generator falls back to FALLBACK_CALIBRATION
 * (empirical, device 0000000018-0926-asu-nz, 18-2 batch, 7 ppb levels × 5 reps).
 *
 * Environmental **AQT0 / AQH0 / AQP0** (temperature, humidity, pressure) are not sensor calibration:
 * {@link computeEnvAuxFromFiles} pools room-air vs breath-matrix means, replicate spread, within-RFC noise,
 * and FeNO-phase roughness from your batch so synthetics follow the same ambient dynamics as originals.
 *
 * Calibration fields per sensor
 * ───────────────────────────────
 *  rfc_med      typical room-air (AmbientSamplingRFC) level — drives synthetic RFC rows
 *  bsc_med      typical breath-matrix (BreathSampleCollection) level — FeNO/BSC/window
 *  amb_med      same as bsc_med (legacy alias for ML / merges)
 *  nd_slope     linear ΔND/Δppb from OLS fit (ND vs BSC or RFC fallback; FeNOse-consistent)
 *  amb_cv       std/mean of ambient across captures         (inter-replicate baseline spread)
 *  noise_cv     within-breath-baseline (BSC) std / mean    (row noise for BSC / FeNO / window)
 *  noise_cv_rfc within-RFC-phase std / mean                (quieter row noise for AmbientSamplingRFC only)
 *  sens_cv      std(nd@100ppb) / |nd_slope×100|             (capture-to-capture sensitivity variation ~13%)
 *  zero_std_nd  std(nd) at 0 ppb                            (baseline ND offset noise)
 *  nd_env_t_coef, nd_env_h_coef  ND coupling to FeNO-phase ΔT / ΔRH (after ppb slope); from batch OLS when aux + spread sufficient
 *
 * `calibration.ndEnvRef`: batch median FeNO-phase AQT0/AQH0 used as T/H origin for coupling.
 *
 * sens_cv and zero_std_nd remain critical for realistic cross-replicate ND spread.
 */

const SENSOR_COLS = Array.from({ length: 8 }, (_, r) => 'ABCDEFGH'[r]).flatMap((row) =>
    Array.from({ length: 8 }, (_, c) => `${row}${c + 1}`)
);

// ─── internal helpers ────────────────────────────────────────────────────────

function _safeNum(x) {
    if (x === null || x === undefined || x === '') return null;
    const n = typeof x === 'number' ? x : parseFloat(String(x).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}
function _mean(arr) {
    let s = 0, k = 0;
    for (const v of arr) { if (Number.isFinite(v)) { s += v; k++; } }
    return k ? s / k : 0;
}
function _std(arr) {
    const m = _mean(arr);
    let ss = 0, k = 0;
    for (const v of arr) { if (Number.isFinite(v)) { ss += (v - m) ** 2; k++; } }
    return k ? Math.sqrt(ss / k) : 0;
}
function _median(arr) {
    const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return 0;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function _linregSlope(xs, ys) {
    const n = xs.length;
    if (n < 2) return 0;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx; num += dx * (ys[i] - my); den += dx * dx; }
    return den > 1e-12 ? num / den : 0;
}

/**
 * Explains ND **after subtracting the ppb–ND linear trend** using FeNO-phase ΔT / ΔRH vs batch refs.
 * y ~ bT*dt + bH*dh, no intercept (y already residual). Clamps pathological small-batch fits.
 *
 * @param {Array<{ dt: number, dh: number, y: number }>} rows
 * @returns {{ bT: number, bH: number }}
 */
function _olsNdEnvCoupling(rows) {
    const n = rows.length;
    if (n < 3) return { bT: 0, bH: 0 };
    let Stt = 0;
    let Shh = 0;
    let Sth = 0;
    let Sty = 0;
    let Shy = 0;
    for (const r of rows) {
        const { dt, dh, y } = r;
        Stt += dt * dt;
        Shh += dh * dh;
        Sth += dt * dh;
        Sty += dt * y;
        Shy += dh * y;
    }
    const det = Stt * Shh - Sth * Sth;
    const eps = 1e-18 * Math.max(Stt * Shh, 1);
    if (Math.abs(det) <= eps) {
        if (Stt > 1e-12) return { bT: Sty / Stt, bH: 0 };
        if (Shh > 1e-12) return { bT: 0, bH: Shy / Shh };
        return { bT: 0, bH: 0 };
    }
    const bT = (Shh * Sty - Sth * Shy) / det;
    const bH = (Stt * Shy - Sth * Sty) / det;
    /* ±0.02 ND / °C and ±0.01 ND / %RH are generous guards vs spurious tiny-batch regression */
    return {
        bT: _clampEnv(bT, -0.02, 0.02),
        bH: _clampEnv(bH, -0.01, 0.01),
    };
}
function _parsePpbFromName(name) {
    const b = String(name || '').split(/[/\\]/).pop() || '';
    const m = b.match(/(\d+(?:\.\d+)?)\s*ppb\b/i);
    return m ? parseFloat(m[1]) : null;
}
function _rowsOfPhase(data, phase) {
    return (data || []).filter((r) => String(r?.event_name ?? '').trim() === phase);
}

// ─── Fallback calibration (auto-generated from real data, device 0000000027-4125-asu-nz) ──
// Fields: { amb_med, nd_slope, amb_cv, noise_cv, noise_cv_rfc, sens_cv, zero_std_nd } (+ rfc_med, bsc_med after init loop)
const FALLBACK_CALIBRATION = {
    A1: { amb_med:      1273.9, nd_slope:  -2.1853e-04, amb_cv: 0.1500, noise_cv: 0.00087, sens_cv: 0.3500, zero_std_nd: 6.19553e-04 },
    A2: { amb_med:    484956.9, nd_slope:  -5.0717e-05, amb_cv: 0.1500, noise_cv: 0.00134, sens_cv: 0.3500, zero_std_nd: 1.29570e-03 },
    A3: { amb_med:    199165.6, nd_slope:  -9.4493e-06, amb_cv: 0.1500, noise_cv: 0.00052, sens_cv: 0.3500, zero_std_nd: 4.61227e-04 },
    A4: { amb_med:      8126.2, nd_slope:  -2.3583e-05, amb_cv: 0.1500, noise_cv: 0.00020, sens_cv: 0.3500, zero_std_nd: 2.08792e-04 },
    A5: { amb_med:      7130.3, nd_slope:   1.8016e-05, amb_cv: 0.1500, noise_cv: 0.00012, sens_cv: 0.3500, zero_std_nd: 1.17325e-04 },
    A6: { amb_med:     25973.3, nd_slope:   1.8798e-05, amb_cv: 0.1500, noise_cv: 0.00017, sens_cv: 0.3500, zero_std_nd: 2.15358e-04 },
    A7: { amb_med:    183698.4, nd_slope:   1.1201e-05, amb_cv: 0.1500, noise_cv: 0.00042, sens_cv: 0.3500, zero_std_nd: 5.93451e-04 },
    A8: { amb_med:    178342.0, nd_slope:   9.4436e-06, amb_cv: 0.1500, noise_cv: 0.00035, sens_cv: 0.3500, zero_std_nd: 1.25928e-03 },
    B1: { amb_med:    233642.9, nd_slope:  -3.5780e-05, amb_cv: 0.1500, noise_cv: 0.00114, sens_cv: 0.3500, zero_std_nd: 1.21108e-03 },
    B2: { amb_med:     69007.6, nd_slope:  -3.5452e-05, amb_cv: 0.1500, noise_cv: 0.00095, sens_cv: 0.3500, zero_std_nd: 2.04667e-03 },
    B3: { amb_med:    124439.8, nd_slope:  -1.3979e-04, amb_cv: 0.1500, noise_cv: 0.00036, sens_cv: 0.0946, zero_std_nd: 2.23950e-03 },
    B4: { amb_med:     18636.8, nd_slope:  -1.3667e-04, amb_cv: 0.1500, noise_cv: 0.00013, sens_cv: 0.1115, zero_std_nd: 4.92469e-05 },
    B5: { amb_med:    274913.0, nd_slope:  -5.5435e-05, amb_cv: 0.1500, noise_cv: 0.00320, sens_cv: 0.3500, zero_std_nd: 2.10139e-03 },
    B6: { amb_med:      5780.5, nd_slope:  -3.8324e-04, amb_cv: 0.1500, noise_cv: 0.00316, sens_cv: 0.3500, zero_std_nd: 2.43086e-03 },
    B7: { amb_med:     19027.9, nd_slope:  -1.0751e-04, amb_cv: 0.1252, noise_cv: 0.00019, sens_cv: 0.1802, zero_std_nd: 1.10134e-03 },
    B8: { amb_med:     36939.8, nd_slope:  -2.7102e-05, amb_cv: 0.1500, noise_cv: 0.00026, sens_cv: 0.3500, zero_std_nd: 4.57558e-04 },
    C1: { amb_med:    257042.8, nd_slope:  -8.7958e-05, amb_cv: 0.1500, noise_cv: 0.00109, sens_cv: 0.1137, zero_std_nd: 7.27444e-04 },
    C2: { amb_med:     51930.3, nd_slope:  -8.8873e-05, amb_cv: 0.1500, noise_cv: 0.00033, sens_cv: 0.2995, zero_std_nd: 5.46570e-04 },
    C3: { amb_med:    190655.7, nd_slope:  -8.7085e-05, amb_cv: 0.1500, noise_cv: 0.00323, sens_cv: 0.2141, zero_std_nd: 4.19093e-03 },
    C4: { amb_med:     19813.6, nd_slope:  -7.1628e-05, amb_cv: 0.1500, noise_cv: 0.00038, sens_cv: 0.1400, zero_std_nd: 1.83758e-03 },
    C5: { amb_med:      6900.9, nd_slope:  -3.1829e-05, amb_cv: 0.1500, noise_cv: 0.00020, sens_cv: 0.3500, zero_std_nd: 6.48565e-05 },
    C6: { amb_med:     13216.0, nd_slope:  -3.9771e-05, amb_cv: 0.1500, noise_cv: 0.00088, sens_cv: 0.3500, zero_std_nd: 8.40666e-04 },
    C7: { amb_med:     26557.3, nd_slope:  -3.2617e-05, amb_cv: 0.0924, noise_cv: 0.00056, sens_cv: 0.3500, zero_std_nd: 4.25891e-03 },
    C8: { amb_med:     45514.2, nd_slope:  -1.4056e-05, amb_cv: 0.0864, noise_cv: 0.00033, sens_cv: 0.3500, zero_std_nd: 3.54843e-04 },
    D1: { amb_med:   2910064.0, nd_slope:  -1.5430e-04, amb_cv: 0.1500, noise_cv: 0.00350, sens_cv: 0.3500, zero_std_nd: 1.18858e-03 },
    D2: { amb_med:    361014.8, nd_slope:   2.8594e-05, amb_cv: 0.1500, noise_cv: 0.00436, sens_cv: 0.3500, zero_std_nd: 6.64172e-03 },
    D3: { amb_med:   1352507.0, nd_slope:   2.9015e-05, amb_cv: 0.1500, noise_cv: 0.00289, sens_cv: 0.3500, zero_std_nd: 6.98704e-03 },
    D4: { amb_med:   3571632.9, nd_slope:  -1.0878e-04, amb_cv: 0.1500, noise_cv: 0.00278, sens_cv: 0.3500, zero_std_nd: 1.43166e-03 },
    D5: { amb_med:  11177095.1, nd_slope:   9.9291e-05, amb_cv: 0.1500, noise_cv: 0.00249, sens_cv: 0.3500, zero_std_nd: 1.64004e-03 },
    D6: { amb_med:      5565.3, nd_slope:   1.0208e-04, amb_cv: 0.1500, noise_cv: 0.00032, sens_cv: 0.3500, zero_std_nd: 7.14208e-04 },
    D7: { amb_med:     70319.0, nd_slope:  -6.2304e-05, amb_cv: 0.1500, noise_cv: 0.01279, sens_cv: 0.3500, zero_std_nd: 1.28253e-02 },
    D8: { amb_med: 131004660.0, nd_slope:   5.1107e-05, amb_cv: 0.1192, noise_cv: 0.01403, sens_cv: 0.3500, zero_std_nd: 6.33036e-03 },
    E1: { amb_med:  60078038.6, nd_slope:  -9.4423e-06, amb_cv: 0.1500, noise_cv: 0.01042, sens_cv: 0.3500, zero_std_nd: 5.81890e-03 },
    E2: { amb_med:     21024.5, nd_slope:  -1.7987e-05, amb_cv: 0.1500, noise_cv: 0.00024, sens_cv: 0.3500, zero_std_nd: 4.89730e-04 },
    E3: { amb_med:     86090.8, nd_slope:  -1.3164e-05, amb_cv: 0.1500, noise_cv: 0.00030, sens_cv: 0.3500, zero_std_nd: 3.94628e-04 },
    E4: { amb_med:    202329.4, nd_slope:  -2.5044e-05, amb_cv: 0.1500, noise_cv: 0.00053, sens_cv: 0.3500, zero_std_nd: 3.89660e-04 },
    E5: { amb_med:    671837.5, nd_slope:   5.4089e-06, amb_cv: 0.1500, noise_cv: 0.00050, sens_cv: 0.3500, zero_std_nd: 1.70652e-04 },
    E6: { amb_med:      4329.5, nd_slope:   5.0093e-06, amb_cv: 0.1500, noise_cv: 0.00026, sens_cv: 0.3500, zero_std_nd: 5.77704e-04 },
    E7: { amb_med:   2815520.5, nd_slope:  -2.6915e-05, amb_cv: 0.1500, noise_cv: 0.00305, sens_cv: 0.0202, zero_std_nd: 6.62460e-03 },
    E8: { amb_med:   1128986.2, nd_slope:  -1.9418e-05, amb_cv: 0.1500, noise_cv: 0.00234, sens_cv: 0.3500, zero_std_nd: 4.00247e-03 },
    F1: { amb_med:     62940.3, nd_slope:  -6.2133e-05, amb_cv: 0.1500, noise_cv: 0.00036, sens_cv: 0.3500, zero_std_nd: 3.30767e-04 },
    F2: { amb_med:    488785.7, nd_slope:  -4.4531e-05, amb_cv: 0.1500, noise_cv: 0.00098, sens_cv: 0.3500, zero_std_nd: 9.23956e-04 },
    F3: { amb_med:     21186.8, nd_slope:  -1.4679e-05, amb_cv: 0.1500, noise_cv: 0.00044, sens_cv: 0.3500, zero_std_nd: 5.73239e-04 },
    F4: { amb_med:    826433.7, nd_slope:  -1.9851e-05, amb_cv: 0.1500, noise_cv: 0.00152, sens_cv: 0.3500, zero_std_nd: 1.40299e-03 },
    F5: { amb_med:       698.6, nd_slope:  -4.8664e-05, amb_cv: 0.0936, noise_cv: 0.00070, sens_cv: 0.2092, zero_std_nd: 1.25027e-03 },
    F6: { amb_med:    434667.5, nd_slope:  -3.8089e-05, amb_cv: 0.0738, noise_cv: 0.00091, sens_cv: 0.3500, zero_std_nd: 3.11502e-03 },
    F7: { amb_med:    444243.5, nd_slope:   1.2996e-05, amb_cv: 0.1500, noise_cv: 0.00085, sens_cv: 0.3500, zero_std_nd: 1.00441e-03 },
    F8: { amb_med:    237809.1, nd_slope:   9.6350e-06, amb_cv: 0.1500, noise_cv: 0.00039, sens_cv: 0.3500, zero_std_nd: 9.51739e-04 },
    G1: { amb_med:    925387.8, nd_slope:  -5.4927e-05, amb_cv: 0.1500, noise_cv: 0.00188, sens_cv: 0.0990, zero_std_nd: 2.13247e-03 },
    G2: { amb_med:     69757.0, nd_slope:  -6.9945e-05, amb_cv: 0.0261, noise_cv: 0.00035, sens_cv: 0.1022, zero_std_nd: 4.96436e-04 },
    G3: { amb_med:     77255.6, nd_slope:  -1.1558e-04, amb_cv: 0.1500, noise_cv: 0.00039, sens_cv: 0.1849, zero_std_nd: 3.41268e-04 },
    G4: { amb_med:     17195.1, nd_slope:  -7.4851e-05, amb_cv: 0.1500, noise_cv: 0.00035, sens_cv: 0.3500, zero_std_nd: 5.07239e-04 },
    G5: { amb_med:      4159.4, nd_slope:  -5.6505e-05, amb_cv: 0.1500, noise_cv: 0.00129, sens_cv: 0.3500, zero_std_nd: 3.19357e-03 },
    G6: { amb_med:    276434.4, nd_slope:   2.5321e-06, amb_cv: 0.1005, noise_cv: 0.00223, sens_cv: 0.3500, zero_std_nd: 9.02165e-04 },
    G7: { amb_med:     14907.7, nd_slope:  -1.3586e-05, amb_cv: 0.1278, noise_cv: 0.00134, sens_cv: 0.3500, zero_std_nd: 1.05511e-03 },
    G8: { amb_med:    142655.4, nd_slope:  -4.8656e-05, amb_cv: 0.1311, noise_cv: 0.00520, sens_cv: 0.3500, zero_std_nd: 6.30546e-03 },
    H1: { amb_med:     32046.9, nd_slope:  -1.5412e-05, amb_cv: 0.1500, noise_cv: 0.00061, sens_cv: 0.3500, zero_std_nd: 3.59895e-03 },
    H2: { amb_med:    402971.2, nd_slope:  -4.1504e-05, amb_cv: 0.1500, noise_cv: 0.00062, sens_cv: 0.3500, zero_std_nd: 4.62220e-04 },
    H3: { amb_med:   1099485.7, nd_slope:  -5.9535e-06, amb_cv: 0.1500, noise_cv: 0.00144, sens_cv: 0.3500, zero_std_nd: 6.06220e-04 },
    H4: { amb_med:     58532.0, nd_slope:  -1.4156e-05, amb_cv: 0.0757, noise_cv: 0.00025, sens_cv: 0.3500, zero_std_nd: 1.07346e-04 },
    H5: { amb_med:      7260.4, nd_slope:   2.4827e-05, amb_cv: 0.1500, noise_cv: 0.00010, sens_cv: 0.3500, zero_std_nd: 1.10169e-04 },
    H6: { amb_med:    122526.0, nd_slope:   3.0959e-05, amb_cv: 0.1500, noise_cv: 0.00108, sens_cv: 0.3500, zero_std_nd: 1.08580e-03 },
    H7: { amb_med:     13563.7, nd_slope:   2.3673e-05, amb_cv: 0.1500, noise_cv: 0.00046, sens_cv: 0.3500, zero_std_nd: 6.21968e-04 },
    H8: { amb_med:    606881.0, nd_slope:   3.9491e-05, amb_cv: 0.1500, noise_cv: 0.00150, sens_cv: 0.3500, zero_std_nd: 1.72213e-03 },
};

/** When only legacy `amb_med` (BSC-typical) exists, RFC room-air is a few % lower on average. */
const SYNTH_RFC_TO_BSC_RATIO = 0.988;

/** Breath baseline (BSC) is noisier than room-air (RFC); never apply full `noise_cv` to RFC rows.
 * Learned `noise_cv_rfc` from real RFC phase; fallback is a fraction of `noise_cv`. */
const SYNTH_RFC_NOISE_FRAC_FALLBACK = 0.34;

for (const s of SENSOR_COLS) {
    const e = FALLBACK_CALIBRATION[s];
    if (!e) continue;
    const bsc = e.bsc_med ?? e.amb_med;
    e.bsc_med = Math.max(1e-6, bsc);
    e.rfc_med = Math.max(1e-6, bsc * SYNTH_RFC_TO_BSC_RATIO);
    e.amb_med = e.bsc_med;
    const nv = Number(e.noise_cv) || 0.0001;
    e.noise_cv_rfc = Math.max(3e-5, Math.min(0.05, Math.min(nv * SYNTH_RFC_NOISE_FRAC_FALLBACK, nv)));
}

/**
 * Default environmental aux (AQT0 ≈ °C, AQH0 ≈ %RH, AQP0 pressure in file units) when no batch stats exist.
 * Superseded by {@link computeEnvAuxFromFiles} on `calibration.envAux` after merge.
 */
export const FALLBACK_ENV_AUX = {
    rfc_aqt_mean: 22,
    rfc_aqt_std: 1.5,
    rfc_aqh_mean: 45,
    rfc_aqh_std: 8,
    rfc_aqp_mean: 990,
    rfc_aqp_std: 5,
    within_rfc_aqt_std: 0.03,
    within_rfc_aqh_std: 0.3,
    within_rfc_aqp_std: 0.5,
    bsc_noise_mult_aqt: 2,
    bsc_noise_mult_aqh: 2,
    bsc_noise_mult_aqp: 1.2,
    feno_aux_noise_mult_aqt: 1.35,
    feno_aux_noise_mult_aqh: 1.35,
    feno_aux_noise_mult_aqp: 1,
    breath_delta_aqt_mean: 10,
    breath_delta_aqt_std: 2,
    breath_delta_aqh_mean: 35,
    breath_delta_aqh_std: 6,
    breath_delta_aqp_mean: 0,
    breath_delta_aqp_std: 1.5,
    aqt_slope_std: 0.04,
    aqh_slope_std: 0.35,
    aqp_slope_std: 0.55,
};

const ENV_AUX_COLS = ['AQT0', 'AQH0', 'AQP0'];

function _phaseAuxStats(rows) {
    if (!rows || rows.length < 3) return null;
    const out = {};
    for (const col of ENV_AUX_COLS) {
        const vals = rows.map((r) => _safeNum(r?.[col])).filter((v) => v !== null && Number.isFinite(v));
        if (vals.length < 3) return null;
        out[col] = { mean: _mean(vals), std: Math.max(1e-9, _std(vals)) };
    }
    return out;
}

function _clampEnv(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
}

/**
 * Pool **ambient / breath environmental** statistics from labelled files (same filter as sensor calibration):
 * RFC & BSC phase means for AQT0, AQH0, AQP0; capture-to-capture spread; within-phase row noise; BSC–RFC step;
 * optional FeNO-phase noise ratio vs RFC. Used for careful synthetic aux traces.
 *
 * @param {Array<{ fileName?: string, name?: string, data?: object[] }>} files
 * @returns {typeof FALLBACK_ENV_AUX | null}
 */
export function computeEnvAuxFromFiles(files) {
    const perFile = [];
    const slopeAQT = [];
    const slopeAQH = [];
    const slopeAQP = [];
    const ratBscT = [];
    const ratBscH = [];
    const ratBscP = [];
    const ratFenoT = [];
    const ratFenoH = [];
    const ratFenoP = [];

    for (const f of files || []) {
        const ppb = _parsePpbFromName(f.fileName || f.name || '');
        if (!Number.isFinite(ppb) || ppb < 0) continue;
        const data = f.data;
        if (!Array.isArray(data) || data.length < 12 || !data[0]) continue;
        if (!ENV_AUX_COLS.every((k) => Object.prototype.hasOwnProperty.call(data[0], k))) continue;

        const rfcRows = _rowsOfPhase(data, 'AmbientSamplingRFC');
        const bscRows = _rowsOfPhase(data, 'BreathSampleCollection');
        if (rfcRows.length < 3 || bscRows.length < 3) continue;

        const rfcS = _phaseAuxStats(rfcRows);
        const bscS = _phaseAuxStats(bscRows);
        if (!rfcS || !bscS) continue;

        perFile.push({
            rfc_aqt: rfcS.AQT0.mean,
            rfc_aqh: rfcS.AQH0.mean,
            rfc_aqp: rfcS.AQP0.mean,
            within_rfc_aqt: rfcS.AQT0.std,
            within_rfc_aqh: rfcS.AQH0.std,
            within_rfc_aqp: rfcS.AQP0.std,
            delta_aqt: bscS.AQT0.mean - rfcS.AQT0.mean,
            delta_aqh: bscS.AQH0.mean - rfcS.AQH0.mean,
            delta_aqp: bscS.AQP0.mean - rfcS.AQP0.mean,
        });

        ratBscT.push(bscS.AQT0.std / Math.max(rfcS.AQT0.std, 1e-9));
        ratBscH.push(bscS.AQH0.std / Math.max(rfcS.AQH0.std, 1e-9));
        ratBscP.push(bscS.AQP0.std / Math.max(rfcS.AQP0.std, 1e-9));

        const n = rfcRows.length;
        if (n >= 5) {
            const xs = Array.from({ length: n }, (_, i) => i);
            for (const [col, bucket] of [
                ['AQT0', slopeAQT],
                ['AQH0', slopeAQH],
                ['AQP0', slopeAQP],
            ]) {
                const ys = rfcRows.map((r) => _safeNum(r?.[col]));
                if (ys.some((v) => v === null || !Number.isFinite(v))) continue;
                const sl = _linregSlope(xs, ys);
                if (Number.isFinite(sl)) bucket.push(sl);
            }
        }

        const fenoRows = _rowsOfPhase(data, 'FeNOMeasurement');
        if (fenoRows.length >= 8) {
            const fenoS = _phaseAuxStats(fenoRows);
            if (fenoS) {
                ratFenoT.push(fenoS.AQT0.std / Math.max(rfcS.AQT0.std, 1e-9));
                ratFenoH.push(fenoS.AQH0.std / Math.max(rfcS.AQH0.std, 1e-9));
                ratFenoP.push(fenoS.AQP0.std / Math.max(rfcS.AQP0.std, 1e-9));
            }
        }
    }

    if (perFile.length < 2) return null;

    const med = _median;
    const spread = (arr, lo, hi) => {
        const sd = _std(arr);
        if (!Number.isFinite(sd)) return lo;
        return _clampEnv(sd, lo, hi);
    };

    const slopeSd = (arr, lo, hi, fb) => {
        if (arr.length < 2) return fb;
        return _clampEnv(_std(arr), lo, hi);
    };

    const out = {
        ...FALLBACK_ENV_AUX,
        rfc_aqt_mean: med(perFile.map((p) => p.rfc_aqt)),
        rfc_aqh_mean: med(perFile.map((p) => p.rfc_aqh)),
        rfc_aqp_mean: med(perFile.map((p) => p.rfc_aqp)),
        rfc_aqt_std: spread(
            perFile.map((p) => p.rfc_aqt),
            0.2,
            10
        ),
        rfc_aqh_std: spread(perFile.map((p) => p.rfc_aqh), 0.5, 30),
        rfc_aqp_std: spread(perFile.map((p) => p.rfc_aqp), 0.5, 25),
        within_rfc_aqt_std: _clampEnv(med(perFile.map((p) => p.within_rfc_aqt)), 0.008, 0.25),
        within_rfc_aqh_std: _clampEnv(med(perFile.map((p) => p.within_rfc_aqh)), 0.03, 2.5),
        within_rfc_aqp_std: _clampEnv(med(perFile.map((p) => p.within_rfc_aqp)), 0.05, 3),
        breath_delta_aqt_mean: med(perFile.map((p) => p.delta_aqt)),
        breath_delta_aqh_mean: med(perFile.map((p) => p.delta_aqh)),
        breath_delta_aqp_mean: med(perFile.map((p) => p.delta_aqp)),
        breath_delta_aqt_std: spread(perFile.map((p) => p.delta_aqt), 0.25, 12),
        breath_delta_aqh_std: spread(perFile.map((p) => p.delta_aqh), 0.5, 25),
        breath_delta_aqp_std: spread(perFile.map((p) => p.delta_aqp), 0.2, 15),
        aqt_slope_std: slopeSd(slopeAQT, 0.002, 0.12, FALLBACK_ENV_AUX.aqt_slope_std),
        aqh_slope_std: slopeSd(slopeAQH, 0.02, 1.2, FALLBACK_ENV_AUX.aqh_slope_std),
        aqp_slope_std: slopeSd(slopeAQP, 0.05, 2, FALLBACK_ENV_AUX.aqp_slope_std),
    };

    if (ratBscT.length >= 2) out.bsc_noise_mult_aqt = _clampEnv(med(ratBscT), 1.05, 4);
    if (ratBscH.length >= 2) out.bsc_noise_mult_aqh = _clampEnv(med(ratBscH), 1.05, 4);
    if (ratBscP.length >= 2) out.bsc_noise_mult_aqp = _clampEnv(med(ratBscP), 1.02, 3.5);

    if (ratFenoT.length >= 2) out.feno_aux_noise_mult_aqt = _clampEnv(med(ratFenoT), 1, 5);
    if (ratFenoH.length >= 2) out.feno_aux_noise_mult_aqh = _clampEnv(med(ratFenoH), 1, 5);
    if (ratFenoP.length >= 2) out.feno_aux_noise_mult_aqp = _clampEnv(med(ratFenoP), 1, 5);

    return out;
}

// ─── Dynamic calibration ──────────────────────────────────────────────────────

/**
 * Derive per-sensor calibration from parsed real data files.
 *
 * Each element of `files`:  { fileName|name: string, data: Array<row> }
 * Returns calibration object or null when < 2 usable files.
 */
export function computeCalibrationFromFiles(files) {
    if (!files || files.length < 2) return null;

    const fileSamples = [];
    for (const f of files) {
        const ppb = _parsePpbFromName(f.fileName || f.name || '');
        if (!Number.isFinite(ppb) || ppb < 0) continue;
        const data = f.data;
        if (!Array.isArray(data) || data.length === 0) continue;

        /* ND / noise for slope fit: BSC if present (matches FeNOse ML), else RFC */
        const rfcRows = _rowsOfPhase(data, 'AmbientSamplingRFC');
        const bscRows = _rowsOfPhase(data, 'BreathSampleCollection');
        let baseline = bscRows.length >= 3 ? bscRows : rfcRows;
        const feno = _rowsOfPhase(data, 'FeNOMeasurement');
        if (baseline.length < 3 || feno.length < 5) continue;

        const sample = { ppb };
        let found = 0;
        const rowKeys = Object.keys(data[0] || {});

        for (const s of SENSOR_COLS) {
            const col = rowKeys.find(
                (k) =>
                    k.toUpperCase() === s.toUpperCase() || k.toUpperCase() === ('CHR' + s).toUpperCase()
            );
            if (!col) continue;

            const rfcVals = rfcRows.map((r) => _safeNum(r?.[col])).filter((v) => v !== null);
            const bscVals = bscRows.map((r) => _safeNum(r?.[col])).filter((v) => v !== null);
            const bv = baseline.map((r) => _safeNum(r?.[col])).filter((v) => v !== null);
            const fv = feno.map((r) => _safeNum(r?.[col])).filter((v) => v !== null);
            if (bv.length < 3 || fv.length < 3) continue;
            const bm = _mean(bv);
            const fm = _mean(fv);
            if (Math.abs(bm) < 1e-6) continue;
            const rfcMean = rfcVals.length >= 3 ? _mean(rfcVals) : null;
            const bscMean = bscVals.length >= 3 ? _mean(bscVals) : null;
            const noiseCvRfc =
                rfcVals.length >= 3 && rfcMean != null && Math.abs(rfcMean) > 1e-9
                    ? _std(rfcVals) / Math.abs(rfcMean)
                    : null;
            sample[s] = {
                ambMean: bm,
                rfcMean,
                bscMean,
                nd: (fm - bm) / Math.abs(bm),
                noiseCv: _std(bv) / Math.abs(bm),
                noiseCvRfc,
            };
            found++;
        }

        let feno_aqt_mean = null;
        let feno_aqh_mean = null;
        const row0 = data[0] || {};
        if (
            feno.length >= 5 &&
            ENV_AUX_COLS.every((k) => Object.prototype.hasOwnProperty.call(row0, k))
        ) {
            const tVals = feno.map((r) => _safeNum(r?.AQT0)).filter((v) => v !== null && Number.isFinite(v));
            const hVals = feno.map((r) => _safeNum(r?.AQH0)).filter((v) => v !== null && Number.isFinite(v));
            if (tVals.length >= 5 && hVals.length >= 5) {
                feno_aqt_mean = _mean(tVals);
                feno_aqh_mean = _mean(hVals);
            }
        }
        sample.feno_aqt_mean = feno_aqt_mean;
        sample.feno_aqh_mean = feno_aqh_mean;

        if (found >= SENSOR_COLS.length / 2) fileSamples.push(sample);
    }

    if (fileSamples.length < 2) return null;

    const samplesWithAux = fileSamples.filter(
        (f) => f.feno_aqt_mean != null && f.feno_aqh_mean != null
    );
    const globalNdEnvRef =
        samplesWithAux.length >= 2
            ? {
                  feno_aqt_ref: _median(samplesWithAux.map((f) => f.feno_aqt_mean)),
                  feno_aqh_ref: _median(samplesWithAux.map((f) => f.feno_aqh_mean)),
              }
            : null;

    const calibration = {};
    for (const s of SENSOR_COLS) {
        const ws = fileSamples.filter((f) => f[s] != null);
        if (ws.length < 2) {
            calibration[s] = FALLBACK_CALIBRATION[s] ? { ...FALLBACK_CALIBRATION[s] } : null;
            continue;
        }
        const ambMeans = ws.map((f) => f[s].ambMean);
        const amb_med = _median(ambMeans);
        const ambAvg = _mean(ambMeans);
        const amb_cv = Math.max(0.001, Math.min(0.15, _std(ambMeans) / (Math.abs(ambAvg) + 1e-9)));
        const noise_cv = Math.max(0.00005, Math.min(0.05, _mean(ws.map((f) => f[s].noiseCv))));
        const rfcNoisePool = ws
            .map((f) => f[s].noiseCvRfc)
            .filter((v) => v != null && Number.isFinite(v) && v > 0);
        let noise_cv_rfc =
            rfcNoisePool.length >= 1
                ? _mean(rfcNoisePool)
                : noise_cv * SYNTH_RFC_NOISE_FRAC_FALLBACK;
        noise_cv_rfc = Math.max(0.00003, Math.min(0.05, noise_cv_rfc));
        noise_cv_rfc = Math.min(noise_cv_rfc, noise_cv);

        const rfcPool = ws.map((f) => f[s].rfcMean).filter((v) => v != null && Number.isFinite(v));
        const bscPool = ws.map((f) => f[s].bscMean).filter((v) => v != null && Number.isFinite(v));
        let bsc_med =
            bscPool.length >= 2
                ? _median(bscPool)
                : amb_med;
        let rfc_med =
            rfcPool.length >= 2
                ? _median(rfcPool)
                : Math.max(1e-6, bsc_med * SYNTH_RFC_TO_BSC_RATIO);
        if (rfc_med > bsc_med * 1.001) {
            [rfc_med, bsc_med] = [bsc_med * SYNTH_RFC_TO_BSC_RATIO, bsc_med];
        }

        // Fit slope ND vs y_effective (saturated) so it's compatible with generator logic
        const xs = ws.map((f) => effectivePpbForNd(f.ppb, 0));
        const ys = ws.map((f) => f[s].nd);
        const nd_slope = _linregSlope(xs, ys);

        // zero_std_nd — spread of nd at lowest available ppb (prefer 0)
        const minPpb = Math.min(...ws.map((f) => f.ppb));
        const ndAtLow = ws.filter((f) => f.ppb === minPpb).map((f) => f[s].nd);
        const zero_std_nd =
            ndAtLow.length >= 2
                ? _std(ndAtLow)
                : FALLBACK_CALIBRATION[s]?.zero_std_nd ?? 0;

        // sens_cv — prefer replicates at 100 ppb; else variation across any ppb level with ≥2 files
        const nd100 = ws.filter((f) => f.ppb === 100).map((f) => f[s].nd);
        let sens_cv;
        const eff100 = effectivePpbForNd(100, 0);
        if (nd100.length >= 2 && Math.abs(nd_slope * eff100) > 1e-9) {
            sens_cv = Math.max(0.01, Math.min(0.35, _std(nd100) / Math.abs(nd_slope * eff100)));
        } else {
            const byPpb = new Map();
            for (const f of ws) {
                const k = f.ppb;
                if (!byPpb.has(k)) byPpb.set(k, []);
                byPpb.get(k).push(f[s].nd);
            }
            let maxStd = 0;
            for (const arr of byPpb.values()) {
                if (arr.length >= 2) maxStd = Math.max(maxStd, _std(arr));
            }
            const refPpb = Math.max(...ws.map((f) => f.ppb), 50);
            const effRef = effectivePpbForNd(refPpb, 0);
            const denom = Math.abs(nd_slope * effRef) + 1e-12;
            if (maxStd > 1e-12) {
                sens_cv = Math.max(0.01, Math.min(0.35, maxStd / denom));
            } else {
                sens_cv = FALLBACK_CALIBRATION[s]?.sens_cv ?? 0.15;
            }
        }

        let nd_env_t_coef = 0;
        let nd_env_h_coef = 0;
        if (globalNdEnvRef && ws.length >= 3) {
            const olsRows = [];
            for (const f of ws) {
                if (f.feno_aqt_mean == null || f[s] == null) continue;
                const eff = effectivePpbForNd(f.ppb, 0);
                const y = f[s].nd - nd_slope * eff;
                olsRows.push({
                    dt: f.feno_aqt_mean - globalNdEnvRef.feno_aqt_ref,
                    dh: f.feno_aqh_mean - globalNdEnvRef.feno_aqh_ref,
                    y,
                });
            }
            if (olsRows.length >= 3) {
                const spreadT = _std(olsRows.map((r) => r.dt));
                const spreadH = _std(olsRows.map((r) => r.dh));
                const { bT, bH } = _olsNdEnvCoupling(olsRows);
                nd_env_t_coef = spreadT >= 0.04 ? bT : 0;
                nd_env_h_coef = spreadH >= 0.25 ? bH : 0;
            }
        }

        calibration[s] = {
            amb_med: Math.max(1, bsc_med),
            bsc_med: Math.max(1, bsc_med),
            rfc_med: Math.max(1e-6, rfc_med),
            nd_slope: Number.isFinite(nd_slope) ? nd_slope : 0,
            amb_cv,
            noise_cv,
            noise_cv_rfc,
            sens_cv,
            zero_std_nd: Math.max(0, zero_std_nd),
            nd_env_t_coef,
            nd_env_h_coef,
        };
    }

    const allPresent = SENSOR_COLS.every((s) => calibration[s] != null);
    if (!allPresent) return null;

    if (globalNdEnvRef) {
        calibration.ndEnvRef = globalNdEnvRef;
    }

    const envAux = computeEnvAuxFromFiles(files);
    if (envAux) calibration.envAux = envAux;

    return calibration;
}

/**
 * Merge live calibration with fallback — live values take precedence per sensor.
 * Merges {@link FALLBACK_ENV_AUX} with any `envAux` on `live` / `fallback` for synthetic AQT0/AQH0/AQP0.
 * Merges `ndEnvRef` (FeNO-phase T/H centres for ND–env coupling) when present.
 */
export function mergeCalibration(live, fallback) {
    const base = fallback != null ? { ...fallback } : { ...FALLBACK_CALIBRATION };
    const envMerged = {
        ...FALLBACK_ENV_AUX,
        ...(fallback && fallback.envAux ? fallback.envAux : {}),
        ...(live && live.envAux ? live.envAux : {}),
    };
    const ndRefMerged = {
        ...(fallback && fallback.ndEnvRef ? fallback.ndEnvRef : {}),
        ...(live && live.ndEnvRef ? live.ndEnvRef : {}),
    };
    const attachNdRef = (obj) => {
        if (Object.keys(ndRefMerged).length > 0) {
            obj.ndEnvRef = { ...ndRefMerged };
        }
        return obj;
    };
    if (!live) {
        return attachNdRef({ ...base, envAux: envMerged });
    }
    const merged = { ...base, envAux: envMerged };
    attachNdRef(merged);
    for (const s of SENSOR_COLS) {
        if (live[s]) merged[s] = live[s];
    }
    return merged;
}

/** Map key for captures with no `##########-####-asu-nz` id in the filename */
export const FENOSE_SYNTH_UNKNOWN_KEY = '__UNKNOWN__';

/**
 * Group parsed calibration files by Aroma Unit device id (from filename).
 * Files without a device id share the {@link FENOSE_SYNTH_UNKNOWN_KEY} bucket.
 */
export function groupFenoseCalibrationFilesByDevice(files) {
    const m = new Map();
    for (const f of files || []) {
        const raw = parseFenoseDeviceIdFromFilename(f.fileName || f.name || '');
        const key = raw === 'UNKNOWN' ? FENOSE_SYNTH_UNKNOWN_KEY : String(raw).toUpperCase();
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(f);
    }
    return m;
}

/**
 * Per-AU calibration when ≥2 files exist for that unit; else pooled workspace calibration;
 * else full fallback table.
 */
export function resolveSyntheticCalibration(devFiles, pooledCalibration) {
    let live = null;
    if (Array.isArray(devFiles) && devFiles.length >= 2) {
        live = computeCalibrationFromFiles(devFiles);
    }
    if (live) return mergeCalibration(live, null);
    if (pooledCalibration) return mergeCalibration(pooledCalibration, null);
    return mergeCalibration(null, null);
}

/** Default row counts per phase when no workspace template exists. */
export const SYNTH_DEFAULT_PHASE_COUNTS = {
    nAmbient: 100,
    nBsc: 27,
    nFeno: 85,
    nWindow: 15,
    windowBeforeMeasurement: true,
};

/** Synthetic FeNOse must not include post-capture hardware recovery (`recoveryOff`, etc.). */
function isRecoveryLikeEventName(eventName) {
    const e = String(eventName ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');
    return e.includes('recovery');
}

/**
 * Map event_name / phase string to a coarse FeNOse stage (recovery-like rows skipped).
 * Tolerates minor casing/spacing differences vs strict equality.
 */
export function classifyFenosePhaseRow(eventName) {
    if (isRecoveryLikeEventName(eventName)) return null;
    const e = String(eventName ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');
    if (!e) return null;
    if (e === 'ambientsamplingrfc' || (e.includes('ambient') && e.includes('rfc'))) return 'rfc';
    if (e.includes('breathsamplecollection')) return 'bsc';
    if (e.includes('fenowindow')) return 'window';
    if (e.includes('fenomeasurement')) return 'feno';
    return null;
}

/**
 * Count FeNOse phase rows in one parsed capture.
 * @returns {{ nAmbient: number, nBsc: number, nFeno: number, nWindow: number } | null}
 */
export function countPhasesOneFile(data) {
    if (!Array.isArray(data) || data.length < 15 || !data[0]) return null;
    if (!('event_name' in data[0]) && !('phase' in data[0])) return null;
    const col = 'event_name' in data[0] ? 'event_name' : 'phase';
    let nAmbient = 0;
    let nBsc = 0;
    let nFeno = 0;
    let nWindow = 0;
    for (const r of data) {
        const kind = classifyFenosePhaseRow(r?.[col]);
        if (kind === 'rfc') nAmbient++;
        else if (kind === 'bsc') nBsc++;
        else if (kind === 'feno') nFeno++;
        else if (kind === 'window') nWindow++;
    }
    if (nAmbient < 3 || nFeno < 5) return null;
    return { nAmbient, nBsc, nFeno, nWindow };
}

/**
 * Whether FeNOWindow rows appear before FeNOMeasurement in file order (recovery-like rows ignored).
 * Same boolean as {@link getFeNOseAromaTrimPhaseLayout} but without aroma trim — for fallbacks when trim fails.
 *
 * @returns {boolean | null}
 */
export function inferWindowBeforeMeasurementFromRawData(data) {
    if (!Array.isArray(data) || data.length < 5 || !data[0]) return null;
    if (!('event_name' in data[0]) && !('phase' in data[0])) return null;
    const col = 'event_name' in data[0] ? 'event_name' : 'phase';
    let firstM = null;
    let firstW = null;
    for (let i = 0; i < data.length; i++) {
        const kind = classifyFenosePhaseRow(data[i]?.[col]);
        if (firstM === null && kind === 'feno') firstM = i;
        if (firstW === null && kind === 'window') firstW = i;
        if (firstM !== null && firstW !== null) break;
    }
    if (firstM === null || firstW === null) return null;
    return firstW < firstM;
}

/**
 * Pick phase row counts from the **single real file** with the longest RFC+BSC prefix (legacy helper).
 *
 * @param {Array<{ data?: object[] }>} files
 * @returns {{ nAmbient: number, nBsc: number, nFeno: number, nWindow: number } | null}
 */
export function pickPhaseRowCountsTemplateFromFiles(files) {
    let best = null;
    let bestPrefix = -1;
    for (const f of files || []) {
        const c = countPhasesOneFile(f?.data);
        if (!c) continue;
        const prefix = c.nAmbient + c.nBsc;
        if (prefix > bestPrefix) {
            bestPrefix = prefix;
            best = { ...c };
        }
    }
    return best;
}

function _medianInt(arr) {
    const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return 15;
    const m = Math.floor(s.length / 2);
    return s.length % 2 !== 0 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * When minima come from different captures, `min(nAmbient)+min(nBsc) ≤ min(feNoStart)` always holds; we set
 * `nBsc = min(feNoStart) − nAmbientEff` so synthetic **FeNO start** = `min(feNoStart)` (red line).
 */
function _buildAromaAlignedFallbackMaxPrefixMinDuration(layouts) {
    let template = layouts[0];
    for (const L of layouts) {
        if (L.feNoStart > template.feNoStart) template = L;
    }
    const wbmCount = layouts.filter((L) => L.windowBeforeMeasurement).length;
    const wbm = wbmCount > layouts.length / 2;
    const durs = layouts
        .map((L) => wbm ? (L.feNoStart - L.windowStart) : (L.windowStart - L.feNoStart))
        .filter((d) => Number.isFinite(d) && d >= 1);
    if (durs.length === 0) return null;
    if (wbm) {
        const nWindow = Math.max(1, Math.min(120, Math.min(...durs)));
        return {
            nAmbient: Math.max(8, template.nAmbient),
            nBsc: Math.max(0, Math.min(80, template.nBsc)),
            nFeno: Math.max(8, Math.min(220, _medianInt(layouts.map((L) => L.nFeno)))),
            nWindow,
            windowBeforeMeasurement: true,
        };
    }
    const nFeno = Math.max(8, Math.min(220, Math.min(...durs)));
    return {
        nAmbient: Math.max(8, template.nAmbient),
        nBsc: Math.max(0, Math.min(80, template.nBsc)),
        nFeno,
        nWindow: Math.max(1, _medianInt(layouts.map((L) => L.nWindow))),
        windowBeforeMeasurement: false,
    };
}

/**
 * Phase counts aligned with **Multi AU** vertical markers: `processAromaBatchCore` draws each dashed line at
 * `Math.min` of that phase’s **start index** across files in the column (sequence index 0 = first event, …).
 *
 * So synthetic must match **per-phase minima**, not one file’s split:
 * - **BSC start** = `min_i(nAmbient_i)` → synthetic `nAmbient = max(8, min nAmbient)`.
 * - **FeNO start** = `min_i(feNoStart_i)` → `nBsc = min(feNoStart) − nAmbientEff` (clamped), since `feNoStart = nAmbient + nBsc` per file.
 * - **FeNOWindow start** = `min_i(windowStart_i)` → `nFeno = min(windowStart) − min(feNoStart)`.
 * - **nWindow** — median window block length.
 *
 * Using only the file with smallest `feNoStart` for both `nAmbient` and `nBsc` was wrong when another file
 * had a shorter RFC segment: dashed lines shifted right on synthetic vs real (your A1 plot).
 *
 * @param {Array<{ data?: object[] }>} files
 * @returns {{ nAmbient: number, nBsc: number, nFeno: number, nWindow: number } | null}
 */
export function buildAromaAlignedPhaseCountsFromFiles(files) {
    const layouts = [];
    for (const f of files || []) {
        const L = getFeNOseAromaTrimPhaseLayout(f?.data, FENOSE_AROMA_TRIM_DEFAULTS);
        if (!L) continue;
        layouts.push(L);
    }
    if (layouts.length === 0) return null;

    /* Detect dominant phase order from real files. */
    const wbmCount = layouts.filter((L) => L.windowBeforeMeasurement).length;
    const windowBeforeMeasurement = wbmCount > layouts.length / 2;

    const minAmbient = Math.min(...layouts.map((L) => L.nAmbient));
    const nAmbientEff = Math.max(8, Math.floor(minAmbient));

    if (windowBeforeMeasurement) {
        /* Canonical order: RFC → BSC → FeNOWindow → FeNOMeasurement.
         * windowStart < feNoStart; third-phase ref line = min(windowStart). */
        const minWindowStart = Math.min(...layouts.map((L) => L.windowStart));
        const minFeNoStart = Math.min(...layouts.map((L) => L.feNoStart));

        let nBsc = minWindowStart - nAmbientEff;
        if (!Number.isFinite(nBsc) || nBsc < 0 || nBsc > 80) {
            return _buildAromaAlignedFallbackMaxPrefixMinDuration(layouts);
        }
        nBsc = Math.floor(nBsc);

        let nWindow = minFeNoStart - minWindowStart;
        if (!Number.isFinite(nWindow) || nWindow < 1) {
            return _buildAromaAlignedFallbackMaxPrefixMinDuration(layouts);
        }
        nWindow = Math.max(1, Math.min(120, Math.floor(nWindow)));

        return {
            nAmbient: nAmbientEff,
            nBsc,
            nFeno: Math.max(8, Math.min(220, _medianInt(layouts.map((L) => L.nFeno)))),
            nWindow,
            windowBeforeMeasurement: true,
        };
    }

    /* Non-canonical order: RFC → BSC → FeNOMeasurement → FeNOWindow.
     * feNoStart < windowStart; third-phase ref line = min(feNoStart). */
    const minFeNoStart = Math.min(...layouts.map((L) => L.feNoStart));
    const minWindowStart = Math.min(...layouts.map((L) => L.windowStart));

    let nBsc = minFeNoStart - nAmbientEff;
    if (!Number.isFinite(nBsc) || nBsc < 0 || nBsc > 80) {
        return _buildAromaAlignedFallbackMaxPrefixMinDuration(layouts);
    }
    nBsc = Math.floor(nBsc);

    let nFeno = minWindowStart - minFeNoStart;
    if (!Number.isFinite(nFeno) || nFeno < 3) {
        return _buildAromaAlignedFallbackMaxPrefixMinDuration(layouts);
    }
    nFeno = Math.max(8, Math.min(220, Math.floor(nFeno)));

    return {
        nAmbient: nAmbientEff,
        nBsc,
        nFeno,
        nWindow: Math.max(1, _medianInt(layouts.map((L) => L.nWindow))),
        windowBeforeMeasurement: false,
    };
}

function _pickMedianTotalPhaseCounts(rows, windowBeforeMeasurement) {
    if (!rows || rows.length === 0) return null;
    if (rows.length === 1) {
        const x = rows[0];
        return { nAmbient: x.nAmbient, nBsc: x.nBsc, nFeno: x.nFeno, nWindow: x.nWindow, windowBeforeMeasurement };
    }
    const sorted = [...rows].sort((a, b) => {
        const ta = a.nAmbient + a.nBsc + a.nFeno + a.nWindow;
        const tb = b.nAmbient + b.nBsc + b.nFeno + b.nWindow;
        return ta - tb || a.nAmbient - b.nAmbient;
    });
    const mid = Math.floor((sorted.length - 1) / 2);
    const pick = sorted[mid];
    return {
        nAmbient: pick.nAmbient,
        nBsc: pick.nBsc,
        nFeno: pick.nFeno,
        nWindow: pick.nWindow,
        windowBeforeMeasurement,
    };
}

/**
 * Phase row counts taken from **one** real capture (all four phases together — not blended across files).
 * Prefers {@link getFeNOseAromaTrimPhaseLayout} (same trim as Multi AU: Remove Recovery + No Unknowns);
 * if no file yields a layout, uses {@link countPhasesOneFile} per file. Among all successful captures,
 * picks the one with **median total row count** so synthetics match a typical original length and shape.
 *
 * @param {Array<{ data?: object[] }>} files
 * @returns {{ nAmbient: number, nBsc: number, nFeno: number, nWindow: number } | null}
 */
export function pickRepresentativePhaseCountsFromFiles(files) {
    const trimRows = [];
    let wbmCount = 0;
    for (const f of files || []) {
        const L = getFeNOseAromaTrimPhaseLayout(f?.data, FENOSE_AROMA_TRIM_DEFAULTS);
        if (L) {
            if (L.windowBeforeMeasurement) wbmCount++;
            trimRows.push({
                nAmbient: L.nAmbient,
                nBsc: L.nBsc,
                nFeno: L.nFeno,
                nWindow: L.nWindow,
            });
        }
    }
    const wbm = wbmCount > trimRows.length / 2;
    const fromTrim = _pickMedianTotalPhaseCounts(trimRows, wbm);
    if (fromTrim) return fromTrim;

    const rawRows = [];
    let wbmTrue = 0;
    let wbmFalse = 0;
    for (const f of files || []) {
        const c = countPhasesOneFile(f?.data);
        if (c) rawRows.push({ ...c });
        const inf = inferWindowBeforeMeasurementFromRawData(f?.data);
        if (inf === true) wbmTrue++;
        else if (inf === false) wbmFalse++;
    }
    /* trimRows was empty ⇒ wbm above is false (0 > 0); re-vote from raw event order. */
    let wbmRaw =
        trimRows.length === 0 && (wbmTrue > 0 || wbmFalse > 0)
            ? wbmTrue > wbmFalse
            : wbm;
    if (trimRows.length === 0 && wbmTrue === 0 && wbmFalse === 0) {
        wbmRaw = SYNTH_DEFAULT_PHASE_COUNTS.windowBeforeMeasurement;
    }
    return _pickMedianTotalPhaseCounts(rawRows, wbmRaw);
}

/**
 * Median row counts per FeNOse phase from real files.
 * Rows with `recoveryOff` or other phases are ignored — they are not reproduced in synthetic files.
 *
 * @param {Array<{ fileName?: string, name?: string, data?: object[] }>} files
 * @returns {{ nAmbient: number, nBsc: number, nFeno: number, nWindow: number } | null}
 */
export function computePhaseRowMediansFromFiles(files) {
    const samples = [];
    let wbmTrue = 0;
    let wbmFalse = 0;
    for (const f of files || []) {
        const c = countPhasesOneFile(f?.data);
        if (c) samples.push(c);
        const L = getFeNOseAromaTrimPhaseLayout(f?.data, FENOSE_AROMA_TRIM_DEFAULTS);
        if (L) {
            if (L.windowBeforeMeasurement) wbmTrue++;
            else wbmFalse++;
        } else {
            const inf = inferWindowBeforeMeasurementFromRawData(f?.data);
            if (inf === true) wbmTrue++;
            else if (inf === false) wbmFalse++;
        }
    }
    if (samples.length === 0) return null;

    const med = (arr) => {
        const s = [...arr].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 !== 0 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
    };

    const out = {
        nAmbient: med(samples.map((x) => x.nAmbient)),
        nBsc: med(samples.map((x) => x.nBsc)),
        nFeno: med(samples.map((x) => x.nFeno)),
        /* Median 0 drops FeNOWindow rows → Multi AU plots lose the purple phase marker vs real data. */
        nWindow: Math.max(1, med(samples.map((x) => x.nWindow))),
    };
    if (wbmTrue + wbmFalse > 0) {
        out.windowBeforeMeasurement = wbmTrue > wbmFalse;
    }
    return out;
}

/**
 * Median **total row count** over batch files for phases we reproduce in synthetics
 * (RFC + BSC + FeNOWindow + FeNOMeasurement), using the same trim as Multi AU when available.
 * Excludes recovery / unknown rows — matches what {@link generateSyntheticFenoseRows} emits.
 *
 * @param {Array<{ data?: object[] }>} files
 * @returns {number | null}
 */
export function medianTotalSynthableRowsFromFiles(files) {
    const totals = [];
    for (const f of files || []) {
        const L = getFeNOseAromaTrimPhaseLayout(f?.data, FENOSE_AROMA_TRIM_DEFAULTS);
        if (L) {
            totals.push(L.nAmbient + L.nBsc + L.nFeno + L.nWindow);
            continue;
        }
        const c = countPhasesOneFile(f?.data);
        if (c && (c.nWindow ?? 0) >= 1 && c.nFeno >= 5) {
            totals.push(c.nAmbient + c.nBsc + c.nFeno + c.nWindow);
        }
    }
    if (totals.length === 0) return null;
    const s = [...totals].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 !== 0 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Adjust RFC/BSC/FeNO/window **row counts** so their sum equals `targetTotal`, respecting generator bounds.
 * Prefers changing **nFeno** first (longest flexible segment), then nWindow, nAmbient, nBsc — and the reverse when shrinking.
 *
 * @returns {{ nAmbient: number, nBsc: number, nFeno: number, nWindow: number }}
 */
function reconcilePhaseRowCountsToTargetTotal(phase, targetTotal) {
    let { nAmbient, nBsc, nFeno, nWindow } = phase;
    const sum = () => nAmbient + nBsc + nFeno + nWindow;
    let diff = targetTotal - sum();
    if (diff === 0) return { nAmbient, nBsc, nFeno, nWindow };

    const AM_LO = 8;
    const AM_HI = 220;
    const BSC_HI = 80;
    const FE_LO = 8;
    const FE_HI = 220;
    const WIN_LO = 1;
    const WIN_HI = 120;

    if (diff > 0) {
        let add = diff;
        const stepF = Math.min(add, FE_HI - nFeno);
        nFeno += stepF;
        add -= stepF;
        if (add > 0) {
            const stepW = Math.min(add, WIN_HI - nWindow);
            nWindow += stepW;
            add -= stepW;
        }
        if (add > 0) {
            const stepA = Math.min(add, AM_HI - nAmbient);
            nAmbient += stepA;
            add -= stepA;
        }
        if (add > 0) {
            const stepB = Math.min(add, BSC_HI - nBsc);
            nBsc += stepB;
            add -= stepB;
        }
        return { nAmbient, nBsc, nFeno, nWindow };
    }

    let rem = -diff;
    const subF = Math.min(rem, nFeno - FE_LO);
    nFeno -= subF;
    rem -= subF;
    if (rem > 0) {
        const subW = Math.min(rem, nWindow - WIN_LO);
        nWindow -= subW;
        rem -= subW;
    }
    if (rem > 0) {
        const subB = Math.min(rem, nBsc - 0);
        nBsc -= subB;
        rem -= subB;
    }
    if (rem > 0) {
        const subA = Math.min(rem, nAmbient - AM_LO);
        nAmbient -= subA;
        rem -= subA;
    }
    return { nAmbient, nBsc, nFeno, nWindow };
}

/**
 * Pooled phase counts: {@link buildAromaAlignedPhaseCountsFromFiles} (Multi AU marker alignment), else
 * {@link pickRepresentativePhaseCountsFromFiles}, else per-phase medians.
 */
export function resolvePooledSyntheticPhaseCounts(files) {
    return (
        buildAromaAlignedPhaseCountsFromFiles(files) ||
        pickRepresentativePhaseCountsFromFiles(files) ||
        computePhaseRowMediansFromFiles(files)
    );
}

/**
 * Phase counts from **only** captures whose filename matches `deviceKey` (ASU id), so synthetics for that unit
 * mirror originals for that AU. Falls back to the full workspace pool if none match.
 *
 * @param {string} deviceKey — upper-case id from {@link parseFenoseDeviceIdFromFilename} / device jobs
 * @param {Array<{ fileName?: string, name?: string, data?: object[] }>} allParsedFiles
 */
export function resolvePooledSyntheticPhaseCountsForDeviceKey(deviceKey, allParsedFiles) {
    const key = String(deviceKey || '');
    const all = allParsedFiles || [];
    const globalPool = resolvePooledSyntheticPhaseCounts(all);
    if (!key || key === FENOSE_SYNTH_UNKNOWN_KEY) return globalPool;
    const sub = all.filter(
        (f) => parseFenoseDeviceIdFromFilename(f.fileName || f.name || '') === key
    );
    if (sub.length === 0) return globalPool;
    return resolvePooledSyntheticPhaseCounts(sub) || globalPool;
}

/**
 * Row counts for synthetic generation: explicit opts win; else {@link buildAromaAlignedPhaseCountsFromFiles}
 * from device files, else {@link pickRepresentativePhaseCountsFromFiles}, else pooled; else {@link SYNTH_DEFAULT_PHASE_COUNTS}.
 *
 * When `devFiles` is non-empty and no explicit phase counts are passed in `opts`, the sum
 * `nAmbient + nBsc + nFeno + nWindow` is reconciled to the **median total** of those phases over the batch
 * (trimmed like Multi AU), so synthetic CSVs match original capture **length** on average.
 *
 * @param {object[]} devFiles — same bucket as calibration for this AU
 * @param {object | null} pooledPhaseCounts — from {@link resolvePooledSyntheticPhaseCounts}
 * @param {object} [opts] — optional nAmbient, nBsc, nFeno, nWindow (finite numbers override inference and skip reconciliation)
 */
export function resolveSyntheticPhaseCounts(devFiles, pooledPhaseCounts, opts = {}) {
    const fromDev =
        devFiles?.length > 0
            ? buildAromaAlignedPhaseCountsFromFiles(devFiles) ||
              pickRepresentativePhaseCountsFromFiles(devFiles) ||
              computePhaseRowMediansFromFiles(devFiles)
            : null;
    const src = fromDev || pooledPhaseCounts;
    const fb = SYNTH_DEFAULT_PHASE_COUNTS;

    const finiteOpt = (k) => {
        const n = Number(opts[k]);
        return Number.isFinite(n) ? Math.floor(n) : null;
    };

    const userTouchedPhase =
        finiteOpt('nAmbient') !== null ||
        finiteOpt('nBsc') !== null ||
        finiteOpt('nFeno') !== null ||
        finiteOpt('nWindow') !== null;

    const pick = (key, lo, hi) => {
        const o = finiteOpt(key);
        if (o !== null) return Math.max(lo, Math.min(hi, o));
        if (src && src[key] != null && Number.isFinite(src[key])) {
            return Math.max(lo, Math.min(hi, Math.floor(src[key])));
        }
        return Math.max(lo, Math.min(hi, fb[key]));
    };

    const windowBeforeMeasurement =
        src && typeof src.windowBeforeMeasurement === 'boolean'
            ? src.windowBeforeMeasurement
            : fb.windowBeforeMeasurement;

    let nAmbient = pick('nAmbient', 8, 220);
    let nBsc = pick('nBsc', 0, 80);
    let nFeno = pick('nFeno', 8, 220);
    let nWindow = pick('nWindow', 1, 120);

    if (
        !userTouchedPhase &&
        devFiles?.length > 0 &&
        opts.matchBatchTotalRows !== false
    ) {
        const target = medianTotalSynthableRowsFromFiles(devFiles);
        const minSum = 8 + 0 + 8 + 1;
        if (target != null && target >= minSum) {
            const adj = reconcilePhaseRowCountsToTargetTotal(
                { nAmbient, nBsc, nFeno, nWindow },
                target
            );
            nAmbient = adj.nAmbient;
            nBsc = adj.nBsc;
            nFeno = adj.nFeno;
            nWindow = adj.nWindow;
        }
    }

    return {
        nAmbient,
        nBsc,
        nFeno,
        nWindow,
        windowBeforeMeasurement,
    };
}

/** `undefined` → default placeholder id in {@link buildSyntheticFenoseFileName} */
export function deviceSuffixForSyntheticFile(deviceGroupKey) {
    if (!deviceGroupKey || deviceGroupKey === FENOSE_SYNTH_UNKNOWN_KEY) return undefined;
    return deviceGroupKey;
}

// ─── RNG ─────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
    let a = seed >>> 0;
    return function rand() {
        a += 0x6d2b79f5;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randNormal(rnd, mean = 0, std = 1) {
    const u1 = Math.max(rnd(), 1e-10);
    const u2 = rnd();
    return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Mild saturation / curvature in ND vs ppb (linear calibration remains primary).
 * @param {number} curveJitter  N(0,1)-scaled term, fixed per synthetic capture
 */
function effectivePpbForNd(ppb, curveJitter) {
    const y = Math.max(0, Number(ppb) || 0);
    if (y <= 0) return 0;
    const sat = 1 / (1 + 0.0065 * y);
    const cj = Number.isFinite(curveJitter) ? curveJitter : 0;
    const curve = 1 + cj * Math.min(1, y / 80);
    return y * sat * curve;
}

/**
 * Within-phase drift coefficients — AMBIENT / BSC phase (sensor is in steady-state).
 * Real gas sensors stabilize quickly; within-capture drift over ~33 s is < 0.2%.
 * Large values here create an artificial inverted funnel in ALAAC because normalization
 * baseline is taken from the LAST rows of ambient.
 */
function sampleAmbientDriftCoeffs(rnd) {
    return { lin: randNormal(rnd, 0, 0.002), quad: randNormal(rnd, 0, 0.001) };
}

/**
 * Within-phase drift coefficients — MEASUREMENT / WINDOW phase.
 * Slightly more drift allowed due to breath humidity transients.
 */
function sampleMeasurementDriftCoeffs(rnd) {
    return { lin: randNormal(rnd, 0, 0.004), quad: randNormal(rnd, 0, 0.002) };
}

/** Normalized time 0..1 within phase; coeffs from sampleAmbient/MeasurementDriftCoeffs. */
function phaseDriftMultiplierFromCoeffs(c, t01) {
    const u = t01 * 2 - 1;
    return 1 + c.lin * u + c.quad * (u * u - 0.33);
}

// ─── Generator ───────────────────────────────────────────────────────────────

function _clampSynthCount(v, fallback, lo, hi) {
    const n = Math.floor(Number(v));
    const x = Number.isFinite(n) ? n : fallback;
    return Math.max(lo, Math.min(hi, x));
}

/**
 * Generate synthetic FeNOse rows whose phase structure matches real captures.
 *
 * Per-capture variability (unchanged statistical core):
 *   1. Baseline offset: ambBase[s] = amb_med × exp(N(0, amb_cv²))
 *   2. Sensitivity jitter: nd_slope × (1 + N(0, sens_cv))
 *   3. Zero-offset in ND: zero_std_nd
 *
 * Dynamics layered on top (v2):
 *   • Ambient: slow within-phase baseline drift (linear + quadratic in time).
 *   • FeNO: wash-in 1 − exp(−i/τ); τ grows slightly with ppb; extra noise during transient.
 *   • FeNOWindow: exponential decay of excess ND toward breath baseline + mild damped ripple (not recoveryOff).
 *   • ND vs ppb: mild saturation + per-capture curvature on top of linear slope (concentration-specific shape).
 *   • ND vs FeNO-phase **temperature & humidity**: per-cell `nd_env_t_coef` / `nd_env_h_coef` from batch OLS on
 *     (ND − nd_slope·effectivePpb) vs ΔT, ΔRH (after {@link computeCalibrationFromFiles}); scales with wash-in / decay.
 *   • Aux (AQT/AQH/AQP): drift + noise from `calibration.envAux` when present (learned from batch), else {@link FALLBACK_ENV_AUX}.
 *   • Tiny common-mode multiplicative noise per row (shared airflow / thermal).
 *
 * @param {object} opts
 * @param {number}  opts.ppb
 * @param {number}  [opts.seed=42]
 * @param {number}  [opts.nAmbient]        — default {@link SYNTH_DEFAULT_PHASE_COUNTS}
 * @param {number}  [opts.nBsc]            — BreathSampleCollection rows (breath matrix, no analyte)
 * @param {number}  [opts.nFeno]
 * @param {number}  [opts.nWindow]
 * @param {boolean} [opts.windowBeforeMeasurement] — true: RFC→BSC→FeNOWindow→FeNOMeasurement; false: FeNO wash-in then window decay. Default {@link SYNTH_DEFAULT_PHASE_COUNTS}.
 * @param {object}  [opts.calibration]  — from computeCalibrationFromFiles / mergeCalibration
 */
export function generateSyntheticFenoseRows({
    ppb,
    seed     = 42,
    nAmbient = SYNTH_DEFAULT_PHASE_COUNTS.nAmbient,
    nBsc     = SYNTH_DEFAULT_PHASE_COUNTS.nBsc,
    nFeno    = SYNTH_DEFAULT_PHASE_COUNTS.nFeno,
    nWindow  = SYNTH_DEFAULT_PHASE_COUNTS.nWindow,
    windowBeforeMeasurement = SYNTH_DEFAULT_PHASE_COUNTS.windowBeforeMeasurement,
    calibration = null,
}) {
    const y = Number(ppb);
    if (!Number.isFinite(y) || y < 0) {
        throw new Error('generateSyntheticFenoseRows: ppb must be ≥ 0');
    }

    const fb = SYNTH_DEFAULT_PHASE_COUNTS;
    /* Wide upper bounds so inferred medians from long real captures are not truncated. */
    const rowsAmbient = _clampSynthCount(nAmbient, fb.nAmbient, 8, 220);
    const rowsBsc = _clampSynthCount(nBsc, fb.nBsc, 0, 80);
    const rowsFeno = _clampSynthCount(nFeno, fb.nFeno, 8, 220);
    const rowsWindow = _clampSynthCount(nWindow, fb.nWindow, 1, 120);

    const cal = calibration || FALLBACK_CALIBRATION;
    const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);

    // ── Per-capture parameters ──────────────────────────────────────────────
    const rfcBase = {};
    const bscBase = {};
    const noiseSig = {};
    const noiseSigRfc = {};
    const effNdSlope = {};
    const zeroOffset = {};
    const tauRecover = {};

    for (const s of SENSOR_COLS) {
        const c = cal[s] || FALLBACK_CALIBRATION[s];
        const bsc0 = Math.max(1e-6, c.bsc_med ?? c.amb_med);
        const rfc0 = Math.max(1e-6, c.rfc_med ?? bsc0 * SYNTH_RFC_TO_BSC_RATIO);

        const deviceOffset = Math.exp(randNormal(rnd, 0, c.amb_cv));
        rfcBase[s] = rfc0 * deviceOffset;
        bscBase[s] = bsc0 * deviceOffset;
        noiseSig[s] = bscBase[s] * c.noise_cv;
        const ncvRfcRaw =
            c.noise_cv_rfc != null && Number.isFinite(c.noise_cv_rfc)
                ? c.noise_cv_rfc
                : c.noise_cv * SYNTH_RFC_NOISE_FRAC_FALLBACK;
        const ncvRfc = Math.max(3e-5, Math.min(0.05, Math.min(ncvRfcRaw, c.noise_cv)));
        noiseSigRfc[s] = rfcBase[s] * ncvRfc;

        const sensJitter = 1 + randNormal(rnd, 0, c.sens_cv);
        effNdSlope[s] = c.nd_slope * sensJitter;

        zeroOffset[s] = randNormal(rnd, 0, c.zero_std_nd);

        const tauBase = (2.6 + 3.8 * rnd()) * (1 + 0.28 * y / (y + 28));
        tauRecover[s] = Math.max(0.9, tauBase * Math.exp(randNormal(rnd, 0, 0.14)));
    }

    const yNd = effectivePpbForNd(y, randNormal(rnd, 0, 0.012));
    const riseTau =
        (3 + 2.9 * y / (y + 32)) * (0.86 + 0.28 * rnd());
    const riseTauClamped = Math.max(0.55, riseTau);
    // Subtle wash-in noise boost: real FeNO transient is only 5–10% noisier than steady state.
    // A large boost (was 1.28–1.83×) creates an inverted funnel in ALAAC that looks nothing like real data.
    const transientNoiseBoost = 1.03 + 0.07 * rnd();
    /* Small: large ripple reads as a false “recovery” spike on RFC-normalised Aroma plots. */
    const rippleAmp = (0.008 + 0.014 * rnd()) * Math.min(1, y / (y + 15));

    const driftAmb  = sampleAmbientDriftCoeffs(rnd);
    const driftBsc  = sampleAmbientDriftCoeffs(rnd);
    const driftFeno = sampleMeasurementDriftCoeffs(rnd);
    const driftWin  = sampleMeasurementDriftCoeffs(rnd);

    /* ── Environmental aux (temperature / humidity / pressure) ─────────────── */
    const env = { ...FALLBACK_ENV_AUX, ...(cal.envAux || {}) };

    const aqt0 = env.rfc_aqt_mean + randNormal(rnd, 0, env.rfc_aqt_std);
    const aqh0 = env.rfc_aqh_mean + randNormal(rnd, 0, env.rfc_aqh_std);
    const aqp0 = env.rfc_aqp_mean + randNormal(rnd, 0, env.rfc_aqp_std);
    const aqtSlope = randNormal(rnd, 0, env.aqt_slope_std);
    const aqhSlope = randNormal(rnd, 0, env.aqh_slope_std);
    const aqpSlope = randNormal(rnd, 0, env.aqp_slope_std);

    const breathTempShift =
        env.breath_delta_aqt_mean + randNormal(rnd, 0, env.breath_delta_aqt_std);
    const breathHumShift =
        env.breath_delta_aqh_mean + randNormal(rnd, 0, env.breath_delta_aqh_std);
    const breathPresShift =
        env.breath_delta_aqp_mean + randNormal(rnd, 0, env.breath_delta_aqp_std);

    const nrT = env.within_rfc_aqt_std;
    const nrH = env.within_rfc_aqh_std;
    const nrP = env.within_rfc_aqp_std;
    const bscT = Math.max(nrT * env.bsc_noise_mult_aqt, 0.02);
    const bscH = Math.max(nrH * env.bsc_noise_mult_aqh, 0.05);
    const bscP = Math.max(nrP * env.bsc_noise_mult_aqp, 0.08);
    const fnT = Math.max(nrT * env.feno_aux_noise_mult_aqt, 0.02);
    const fnH = Math.max(nrH * env.feno_aux_noise_mult_aqh, 0.05);
    const fnP = Math.max(nrP * env.feno_aux_noise_mult_aqp, 0.08);

    /* FeNO-phase T/H references for ND–environment coupling (learned batch medians or this draw). */
    const tRefNd = cal.ndEnvRef?.feno_aqt_ref ?? aqt0 + breathTempShift;
    const hRefNd = cal.ndEnvRef?.feno_aqh_ref ?? aqh0 + breathHumShift;

    /**
     * Breath-matrix replicate-to-replicate inconsistency per sensor:
     * Exhaled breath creates a systematic humidity/temperature shift (captured by the
     * BreathSampleCollection normalization in ML features).  The REPLICATE-TO-REPLICATE
     * inconsistency of this shift is very small in practice (~0.1%), because breath
     * composition and flow are nearly identical between replicates of the same session.
     *
     * IMPORTANT: keep this << analyte signal.  Aroma / ALAAC normalise against
     * AmbientSamplingRFC median; RFC rows use rfc_med and BSC/FeNO use bsc_med so the
     * room-air → breath step is visible before the FeNO wash-in.
     * At 0.8% std it completely buries low-concentration NO signals (~0.05–0.2% ND).
     */
    const bscBaselineShift = {};
    for (const s of SENSOR_COLS) {
        bscBaselineShift[s] = randNormal(rnd, 0, 0.001);  // ±0.1% replicate-to-replicate inconsistency
    }

    const rows = [];

    // ── AmbientSamplingRFC ──────────────────────────────────────────────────
    for (let i = 0; i < rowsAmbient; i++) {
        const t01 = rowsAmbient <= 1 ? 0 : i / (rowsAmbient - 1);
        const driftM = phaseDriftMultiplierFromCoeffs(driftAmb, t01);
        const row = {
            event_name: 'AmbientSamplingRFC',
            AQT0: aqt0 + aqtSlope * t01 + randNormal(rnd, 0, nrT),
            AQH0: aqh0 + aqhSlope * t01 + randNormal(rnd, 0, nrH),
            AQP0: aqp0 + aqpSlope * t01 + randNormal(rnd, 0, nrP),
        };
        /* Room-air phase is calmer than BSC: weaker common-mode than later phases. */
        const cm = 1 + randNormal(rnd, 0, 0.0011);
        for (const s of SENSOR_COLS) {
            const base = rfcBase[s] * driftM;
            row[s] = cm * (base + randNormal(rnd, 0, noiseSigRfc[s]));
        }
        rows.push(row);
    }

    // ── BreathSampleCollection (breath matrix on sensor, NO analyte yet) ────
    if (rowsBsc > 0) {
        for (let i = 0; i < rowsBsc; i++) {
            const t01 = rowsBsc <= 1 ? 0 : i / (rowsBsc - 1);
            const driftM = phaseDriftMultiplierFromCoeffs(driftBsc, t01);
            const row = {
                event_name: 'BreathSampleCollection',
                AQT0: aqt0 + breathTempShift * (0.6 + 0.4 * t01) + randNormal(rnd, 0, bscT),
                AQH0: aqh0 + breathHumShift * (0.5 + 0.5 * t01) + randNormal(rnd, 0, bscH),
                AQP0: aqp0 + breathPresShift + randNormal(rnd, 0, bscP),
            };
            const cm = 1 + randNormal(rnd, 0, 0.0020);
            for (const s of SENSOR_COLS) {
                const base = bscBase[s] * driftM * (1 + bscBaselineShift[s]);
                row[s] = cm * (base + randNormal(rnd, 0, noiseSig[s]));
            }
            rows.push(row);
        }
    }

    // ── Phase 3 & 4: order depends on windowBeforeMeasurement ─────────────
    // Real captures: FeNOWindow (breath-level baseline) → FeNOMeasurement (analyte wash-in)
    // Non-canonical: FeNOMeasurement → FeNOWindow

    function _emitFeNOMeasurement() {
        let lastRise = 0;
        for (let i = 0; i < rowsFeno; i++) {
            const rise = 1 - Math.exp(-i / riseTauClamped);
            lastRise = rise;
            const t01 = rowsFeno <= 1 ? 1 : i / (rowsFeno - 1);
            const driftM = phaseDriftMultiplierFromCoeffs(driftFeno, t01);
            const transient = transientNoiseBoost * (1 - rise);
            const row = {
                event_name: 'FeNOMeasurement',
                AQT0: aqt0 + breathTempShift + aqtSlope * 0.15 * t01 + randNormal(rnd, 0, fnT),
                AQH0: aqh0 + breathHumShift + aqhSlope * 0.12 * t01 + randNormal(rnd, 0, fnH),
                AQP0: aqp0 + breathPresShift + aqpSlope * 0.12 * t01 + randNormal(rnd, 0, fnP),
            };
            const cm = 1 + randNormal(rnd, 0, 0.0022);
            for (const s of SENSOR_COLS) {
                const cS = cal[s] || FALLBACK_CALIBRATION[s];
                const ndEnvRow =
                    (Number(cS.nd_env_t_coef) || 0) * (row.AQT0 - tRefNd) +
                    (Number(cS.nd_env_h_coef) || 0) * (row.AQH0 - hRefNd);
                const ndResp = effNdSlope[s] * yNd * rise + ndEnvRow * rise;
                const ndTot = bscBaselineShift[s] + ndResp + zeroOffset[s];
                const base = bscBase[s] * driftM * (1 + ndTot);
                const sig = noiseSig[s] * Math.sqrt(1 + transient * transient);
                row[s] = cm * (base + randNormal(rnd, 0, sig));
            }
            rows.push(row);
        }
        return lastRise;
    }

    function _emitFeNOWindow(lastRise) {
        if (rowsWindow <= 0) return;
        for (let j = 0; j < rowsWindow; j++) {
            const t01 = rowsWindow <= 1 ? 0 : j / (rowsWindow - 1);
            const driftM = phaseDriftMultiplierFromCoeffs(driftWin, t01);
            const row = {
                event_name: 'FeNOWindow',
                AQT0: aqt0 + breathTempShift * (0.9 - 0.15 * t01) + aqtSlope * 0.08 * t01 + randNormal(rnd, 0, fnT),
                AQH0: aqh0 + breathHumShift * (0.9 - 0.15 * t01) + aqhSlope * 0.08 * t01 + randNormal(rnd, 0, fnH),
                AQP0: aqp0 + breathPresShift + aqpSlope * 0.08 * t01 + randNormal(rnd, 0, fnP),
            };
            const cm = 1 + randNormal(rnd, 0, 0.0018);
            for (const s of SENSOR_COLS) {
                const cS = cal[s] || FALLBACK_CALIBRATION[s];
                const ndEnvRow =
                    (Number(cS.nd_env_t_coef) || 0) * (row.AQT0 - tRefNd) +
                    (Number(cS.nd_env_h_coef) || 0) * (row.AQH0 - hRefNd);
                const excess0 =
                    effNdSlope[s] * yNd * lastRise + ndEnvRow * lastRise;
                const tr = tauRecover[s];
                const decay = Math.exp(-j / tr);
                const ripple =
                    rippleAmp * Math.sin((j + 0.7) * 0.95) * decay * Math.abs(excess0);
                const ndTot = bscBaselineShift[s] + zeroOffset[s] + excess0 * decay + ripple;
                const base = bscBase[s] * driftM * (1 + ndTot);
                const relax = 0.35 + 0.65 * (1 - decay);
                const sig = noiseSig[s] * Math.sqrt(Math.max(0.2, relax));
                row[s] = cm * (base + randNormal(rnd, 0, sig));
            }
            rows.push(row);
        }
    }

    if (windowBeforeMeasurement) {
        /* Real order: RFC → BSC → FeNOWindow → FeNOMeasurement */
        _emitFeNOWindow(0);           // Window at breath baseline (no prior wash-in)
        _emitFeNOMeasurement();       // Measurement with analyte wash-in
    } else {
        /* Non-canonical: RFC → BSC → FeNOMeasurement → FeNOWindow */
        const lastRise = _emitFeNOMeasurement();
        _emitFeNOWindow(lastRise);    // Window decays from wash-in plateau
    }

    /* Ground truth for batch validation if basename is missing or ambiguous (see workspaceFilename last-match ppb). */
    if (rows.length > 0) {
        rows[0].target_ppb = y;
    }

    return rows.filter((r) => !isRecoveryLikeEventName(r?.event_name));
}

// ─── Filename helpers ────────────────────────────────────────────────────────

export const SYNTHETIC_DEFAULT_DEVICE_SUFFIX = '0000000009-0926-asu-nz';

export function buildSyntheticFenoseFileName({ ppb, replicateIndex = 0, deviceSuffix = SYNTHETIC_DEFAULT_DEVICE_SUFFIX }) {
    const p       = Number(ppb);
    const safePpb = Number.isFinite(p) ? String(p).replace(/[^\d.]/g, '') : '0';
    const idx     = Math.max(0, Math.floor(replicateIndex));
    const dev     = String(deviceSuffix || SYNTHETIC_DEFAULT_DEVICE_SUFFIX).replace(/[^\d\-a-z]/gi, '');
    return `fenose_synth_${dev}_r${idx}_${safePpb}ppb.csv`;
}

export function parseConcentrationsList(text) {
    return String(text || '')
        .split(/[,;\s]+/)
        .map((s) => parseFloat(s.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0);
}
