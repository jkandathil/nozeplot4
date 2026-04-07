import { parseFenoseDeviceIdFromFilename } from './fenoseModel.js';
import { getFeNOseAromaTrimPhaseLayout, FENOSE_AROMA_TRIM_DEFAULTS } from './fenoseAromaTrim.js';

/**
 * Synthetic FeNOse-style tabular rows for workspace training / demos.
 * Phases and columns match extractFenoseFeaturesFromRows:
 * AmbientSamplingRFC, BreathSampleCollection (baseline), FeNOMeasurement, optional FeNOWindow; A1–H8; AQT0, AQH0, AQP0.
 *
 * Temporal behaviour (wash-in, FeNO window decay, drift) is designed so ML features (means, feno std,
 * window deltas) resemble real captures, not IID plateaus per phase.
 *
 * **No hardware recovery phase:** outputs are only AmbientSamplingRFC → BreathSampleCollection →
 * FeNOMeasurement → FeNOWindow (same phase order as real FeNOse captures). Rows with `recoveryOff`
 * or any `event_name` containing `recovery` are never emitted (and would be stripped if introduced
 * by mistake).
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
 * Calibration fields per sensor
 * ───────────────────────────────
 *  rfc_med      typical room-air (AmbientSamplingRFC) level — drives synthetic RFC rows
 *  bsc_med      typical breath-matrix (BreathSampleCollection) level — FeNO/BSC/window
 *  amb_med      same as bsc_med (legacy alias for ML / merges)
 *  nd_slope     linear ΔND/Δppb from OLS fit (ND vs BSC or RFC fallback; FeNOse-consistent)
 *  amb_cv       std/mean of ambient across captures         (inter-replicate baseline spread)
 *  noise_cv     within-ambient-phase std / mean             (row-to-row measurement noise)
 *  sens_cv      std(nd@100ppb) / |nd_slope×100|             (capture-to-capture sensitivity variation ~13%)
 *  zero_std_nd  std(nd) at 0 ppb                            (baseline ND offset noise)
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
function _parsePpbFromName(name) {
    const b = String(name || '').split(/[/\\]/).pop() || '';
    const m = b.match(/(\d+(?:\.\d+)?)\s*ppb\b/i);
    return m ? parseFloat(m[1]) : null;
}
function _rowsOfPhase(data, phase) {
    return (data || []).filter((r) => String(r?.event_name ?? '').trim() === phase);
}

// ─── Fallback calibration (auto-generated from real data, device 0000000018-0926-asu-nz) ──
// Fields: { amb_med, nd_slope, amb_cv, noise_cv, sens_cv, zero_std_nd }
const FALLBACK_CALIBRATION = {
    A1: { amb_med:     706.4, nd_slope:  -1.8563e-04, amb_cv: 0.0480, noise_cv: 0.00131, sens_cv: 0.1343, zero_std_nd: 6.74967e-04 },
    A2: { amb_med:     601.5, nd_slope:  -2.4122e-04, amb_cv: 0.0656, noise_cv: 0.00063, sens_cv: 0.1328, zero_std_nd: 9.70983e-04 },
    A3: { amb_med:    5158.6, nd_slope:  -5.3692e-06, amb_cv: 0.0033, noise_cv: 0.00018, sens_cv: 0.3500, zero_std_nd: 3.16006e-04 },
    A4: { amb_med:    6645.8, nd_slope:  -5.7280e-06, amb_cv: 0.0033, noise_cv: 0.00017, sens_cv: 0.3500, zero_std_nd: 3.56626e-04 },
    A5: { amb_med:    4293.7, nd_slope:  -7.7957e-06, amb_cv: 0.0035, noise_cv: 0.00021, sens_cv: 0.3057, zero_std_nd: 3.73931e-04 },
    A6: { amb_med:    4077.1, nd_slope:  -6.9045e-06, amb_cv: 0.0036, noise_cv: 0.00013, sens_cv: 0.3500, zero_std_nd: 4.16936e-04 },
    A7: { amb_med:    7098.7, nd_slope:  -1.2627e-05, amb_cv: 0.0053, noise_cv: 0.00016, sens_cv: 0.1677, zero_std_nd: 3.28869e-04 },
    A8: { amb_med:    6761.5, nd_slope:  -1.2635e-05, amb_cv: 0.0059, noise_cv: 0.00035, sens_cv: 0.0662, zero_std_nd: 5.56202e-04 },
    B1: { amb_med:     266.2, nd_slope:  -2.3883e-05, amb_cv: 0.0093, noise_cv: 0.00044, sens_cv: 0.0942, zero_std_nd: 3.14417e-04 },
    B2: { amb_med:    9780.9, nd_slope:  -4.3115e-05, amb_cv: 0.0113, noise_cv: 0.00255, sens_cv: 0.3500, zero_std_nd: 2.03553e-03 },
    B3: { amb_med:    7919.8, nd_slope:  -7.1818e-05, amb_cv: 0.0273, noise_cv: 0.00275, sens_cv: 0.2461, zero_std_nd: 1.97145e-03 },
    B4: { amb_med:    2565.7, nd_slope:  -2.6950e-04, amb_cv: 0.0622, noise_cv: 0.00117, sens_cv: 0.1352, zero_std_nd: 2.26800e-03 },
    B5: { amb_med:    1905.4, nd_slope:  -1.0832e-04, amb_cv: 0.0298, noise_cv: 0.00181, sens_cv: 0.1535, zero_std_nd: 1.53398e-03 },
    B6: { amb_med:    2073.8, nd_slope:  -2.4093e-04, amb_cv: 0.0543, noise_cv: 0.00083, sens_cv: 0.1104, zero_std_nd: 1.32129e-03 },
    B7: { amb_med:   23127.9, nd_slope:  -1.0526e-04, amb_cv: 0.0274, noise_cv: 0.00695, sens_cv: 0.3208, zero_std_nd: 4.63940e-03 },
    B8: { amb_med:   15078.4, nd_slope:  -8.3099e-05, amb_cv: 0.0395, noise_cv: 0.00379, sens_cv: 0.3500, zero_std_nd: 4.85039e-03 },
    C1: { amb_med:     634.3, nd_slope:  -4.0271e-05, amb_cv: 0.0166, noise_cv: 0.00076, sens_cv: 0.1454, zero_std_nd: 5.75917e-04 },
    C2: { amb_med:    1835.3, nd_slope:  -1.8614e-05, amb_cv: 0.0081, noise_cv: 0.00121, sens_cv: 0.3500, zero_std_nd: 1.01398e-03 },
    C3: { amb_med:    7436.7, nd_slope:  -1.3296e-04, amb_cv: 0.0336, noise_cv: 0.00328, sens_cv: 0.3500, zero_std_nd: 1.63871e-03 },
    C4: { amb_med:     779.2, nd_slope:  -1.8340e-04, amb_cv: 0.0566, noise_cv: 0.00048, sens_cv: 0.1524, zero_std_nd: 5.59379e-04 },
    C5: { amb_med:   84877.9, nd_slope:  -9.5354e-06, amb_cv: 0.0063, noise_cv: 0.00027, sens_cv: 0.3500, zero_std_nd: 8.78561e-04 },
    C6: { amb_med:   60575.6, nd_slope:  -7.1767e-06, amb_cv: 0.0059, noise_cv: 0.00023, sens_cv: 0.3500, zero_std_nd: 7.51951e-04 },
    C7: { amb_med:   18995.5, nd_slope:  -2.2953e-06, amb_cv: 0.0025, noise_cv: 0.00021, sens_cv: 0.3500, zero_std_nd: 2.31060e-04 },
    C8: { amb_med:   17573.7, nd_slope:  -4.6845e-06, amb_cv: 0.0026, noise_cv: 0.00030, sens_cv: 0.3500, zero_std_nd: 4.12803e-04 },
    D1: { amb_med:     111.4, nd_slope:  -1.3778e-05, amb_cv: 0.0046, noise_cv: 0.00017, sens_cv: 0.1075, zero_std_nd: 3.44094e-05 },
    D2: { amb_med:     125.1, nd_slope:  -1.1752e-05, amb_cv: 0.0043, noise_cv: 0.00016, sens_cv: 0.1228, zero_std_nd: 3.70623e-05 },
    D3: { amb_med:    1163.3, nd_slope:  -2.0634e-05, amb_cv: 0.0090, noise_cv: 0.00156, sens_cv: 0.3500, zero_std_nd: 1.01071e-03 },
    D4: { amb_med:    1241.5, nd_slope:  -1.7237e-05, amb_cv: 0.0111, noise_cv: 0.00190, sens_cv: 0.3500, zero_std_nd: 1.18602e-03 },
    D5: { amb_med:     105.8, nd_slope:  -5.0515e-05, amb_cv: 0.0133, noise_cv: 0.00021, sens_cv: 0.1496, zero_std_nd: 2.73176e-04 },
    D6: { amb_med:     121.2, nd_slope:  -5.0811e-05, amb_cv: 0.0127, noise_cv: 0.00018, sens_cv: 0.1566, zero_std_nd: 2.18934e-04 },
    D7: { amb_med:     531.0, nd_slope:  -1.6793e-04, amb_cv: 0.0485, noise_cv: 0.00063, sens_cv: 0.1547, zero_std_nd: 1.06712e-03 },
    D8: { amb_med:     653.9, nd_slope:  -2.0748e-04, amb_cv: 0.0545, noise_cv: 0.00071, sens_cv: 0.1697, zero_std_nd: 1.00597e-03 },
    E1: { amb_med:     376.4, nd_slope:  -7.1905e-06, amb_cv: 0.0032, noise_cv: 0.00012, sens_cv: 0.3173, zero_std_nd: 2.73813e-04 },
    E2: { amb_med:     405.1, nd_slope:  -6.3985e-06, amb_cv: 0.0034, noise_cv: 0.00012, sens_cv: 0.2710, zero_std_nd: 3.33003e-04 },
    E3: { amb_med:     360.8, nd_slope:  -1.4134e-06, amb_cv: 0.0016, noise_cv: 0.00020, sens_cv: 0.3500, zero_std_nd: 3.52127e-04 },
    E4: { amb_med:     318.5, nd_slope:  -2.6451e-06, amb_cv: 0.0021, noise_cv: 0.00015, sens_cv: 0.3500, zero_std_nd: 4.43026e-04 },
    E5: { amb_med:    3518.3, nd_slope:  -5.8580e-06, amb_cv: 0.0061, noise_cv: 0.00033, sens_cv: 0.3500, zero_std_nd: 8.99730e-04 },
    E6: { amb_med:    2164.3, nd_slope:  -5.8944e-06, amb_cv: 0.0053, noise_cv: 0.00027, sens_cv: 0.3500, zero_std_nd: 8.69920e-04 },
    E7: { amb_med:     906.2, nd_slope:   1.0891e-07, amb_cv: 0.0019, noise_cv: 0.00018, sens_cv: 0.3500, zero_std_nd: 1.82785e-04 },
    E8: { amb_med:     737.4, nd_slope:  -1.6288e-06, amb_cv: 0.0018, noise_cv: 0.00010, sens_cv: 0.2995, zero_std_nd: 1.25908e-04 },
    F1: { amb_med:     894.4, nd_slope:  -1.7546e-04, amb_cv: 0.0513, noise_cv: 0.00138, sens_cv: 0.1503, zero_std_nd: 5.16851e-04 },
    F2: { amb_med:    5331.6, nd_slope:  -1.3706e-04, amb_cv: 0.0442, noise_cv: 0.00194, sens_cv: 0.1899, zero_std_nd: 1.56741e-03 },
    F3: { amb_med:    7279.1, nd_slope:  -5.1790e-06, amb_cv: 0.0030, noise_cv: 0.00013, sens_cv: 0.3500, zero_std_nd: 3.99951e-04 },
    F4: { amb_med:    8512.9, nd_slope:  -5.9207e-06, amb_cv: 0.0035, noise_cv: 0.00013, sens_cv: 0.1854, zero_std_nd: 5.07823e-04 },
    F5: { amb_med:   21156.0, nd_slope:  -3.8659e-05, amb_cv: 0.0133, noise_cv: 0.00099, sens_cv: 0.1454, zero_std_nd: 1.41900e-03 },
    F6: { amb_med:     803.3, nd_slope:  -2.2526e-05, amb_cv: 0.0105, noise_cv: 0.00015, sens_cv: 0.1144, zero_std_nd: 1.53776e-04 },
    F7: { amb_med:     925.4, nd_slope:  -3.7226e-05, amb_cv: 0.0141, noise_cv: 0.00097, sens_cv: 0.1733, zero_std_nd: 7.24415e-04 },
    F8: { amb_med:    1035.0, nd_slope:  -1.7140e-05, amb_cv: 0.0104, noise_cv: 0.00173, sens_cv: 0.3500, zero_std_nd: 9.05192e-04 },
    G1: { amb_med:   86488.1, nd_slope:  -8.8797e-06, amb_cv: 0.0061, noise_cv: 0.00022, sens_cv: 0.3500, zero_std_nd: 8.60722e-04 },
    G2: { amb_med:   87644.9, nd_slope:  -9.4444e-06, amb_cv: 0.0062, noise_cv: 0.00023, sens_cv: 0.3500, zero_std_nd: 8.40999e-04 },
    G3: { amb_med:   69830.6, nd_slope:  -8.7601e-06, amb_cv: 0.0059, noise_cv: 0.00020, sens_cv: 0.3500, zero_std_nd: 8.47328e-04 },
    G4: { amb_med:   73238.4, nd_slope:  -8.7484e-06, amb_cv: 0.0058, noise_cv: 0.00021, sens_cv: 0.3500, zero_std_nd: 9.23045e-04 },
    G5: { amb_med:   39898.5, nd_slope:  -8.4201e-06, amb_cv: 0.0063, noise_cv: 0.00525, sens_cv: 0.3500, zero_std_nd: 3.35965e-03 },
    G6: { amb_med:     227.2, nd_slope:  -3.7038e-05, amb_cv: 0.0155, noise_cv: 0.00018, sens_cv: 0.1251, zero_std_nd: 1.27743e-04 },
    G7: { amb_med:     479.5, nd_slope:  -4.6236e-05, amb_cv: 0.0194, noise_cv: 0.00060, sens_cv: 0.1043, zero_std_nd: 5.00408e-04 },
    G8: { amb_med:     218.0, nd_slope:  -4.0364e-05, amb_cv: 0.0172, noise_cv: 0.00039, sens_cv: 0.0986, zero_std_nd: 5.79473e-04 },
    H1: { amb_med:   21064.7, nd_slope:  -4.4584e-06, amb_cv: 0.0028, noise_cv: 0.00010, sens_cv: 0.0903, zero_std_nd: 1.73573e-04 },
    H2: { amb_med:   17019.6, nd_slope:  -4.1698e-06, amb_cv: 0.0025, noise_cv: 0.00010, sens_cv: 0.2321, zero_std_nd: 1.64787e-04 },
    H3: { amb_med:   15152.9, nd_slope:  -4.7980e-06, amb_cv: 0.0022, noise_cv: 0.00010, sens_cv: 0.1651, zero_std_nd: 1.59484e-04 },
    H4: { amb_med:   15850.8, nd_slope:  -3.8799e-06, amb_cv: 0.0020, noise_cv: 0.00010, sens_cv: 0.0949, zero_std_nd: 1.23269e-04 },
    H5: { amb_med:    7420.3, nd_slope:  -1.1427e-05, amb_cv: 0.0057, noise_cv: 0.00014, sens_cv: 0.1849, zero_std_nd: 3.40010e-04 },
    H6: { amb_med:    7049.0, nd_slope:  -1.3986e-05, amb_cv: 0.0061, noise_cv: 0.00016, sens_cv: 0.2064, zero_std_nd: 4.26563e-04 },
    H7: { amb_med:    6619.3, nd_slope:  -1.4163e-05, amb_cv: 0.0062, noise_cv: 0.00010, sens_cv: 0.1404, zero_std_nd: 3.53068e-04 },
    H8: { amb_med:    6100.3, nd_slope:  -1.3984e-05, amb_cv: 0.0064, noise_cv: 0.00011, sens_cv: 0.0942, zero_std_nd: 3.67491e-04 },
};

/** When only legacy `amb_med` (BSC-typical) exists, RFC room-air is a few % lower on average. */
const SYNTH_RFC_TO_BSC_RATIO = 0.988;

for (const s of SENSOR_COLS) {
    const e = FALLBACK_CALIBRATION[s];
    if (!e) continue;
    const bsc = e.bsc_med ?? e.amb_med;
    e.bsc_med = Math.max(1e-6, bsc);
    e.rfc_med = Math.max(1e-6, bsc * SYNTH_RFC_TO_BSC_RATIO);
    e.amb_med = e.bsc_med;
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
            sample[s] = {
                ambMean: bm,
                rfcMean,
                bscMean,
                nd: (fm - bm) / Math.abs(bm),
                noiseCv: _std(bv) / Math.abs(bm),
            };
            found++;
        }
        if (found >= SENSOR_COLS.length / 2) fileSamples.push(sample);
    }

    if (fileSamples.length < 2) return null;

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

        calibration[s] = {
            amb_med: Math.max(1, bsc_med),
            bsc_med: Math.max(1, bsc_med),
            rfc_med: Math.max(1e-6, rfc_med),
            nd_slope: Number.isFinite(nd_slope) ? nd_slope : 0,
            amb_cv,
            noise_cv,
            sens_cv,
            zero_std_nd: Math.max(0, zero_std_nd),
        };
    }

    const allPresent = SENSOR_COLS.every((s) => calibration[s] != null);
    return allPresent ? calibration : null;
}

/**
 * Merge live calibration with fallback — live values take precedence per sensor.
 */
export function mergeCalibration(live, fallback) {
    const base = fallback || FALLBACK_CALIBRATION;
    if (!live) return base;
    const merged = { ...base };
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
    const durs = layouts
        .map((L) => L.windowStart - L.feNoStart)
        .filter((d) => Number.isFinite(d) && d >= 3);
    if (durs.length === 0) return null;
    const nFeno = Math.max(8, Math.min(220, Math.min(...durs)));
    return {
        nAmbient: Math.max(8, template.nAmbient),
        nBsc: Math.max(0, Math.min(80, template.nBsc)),
        nFeno,
        nWindow: Math.max(1, _medianInt(layouts.map((L) => L.nWindow))),
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
        if (!L || L.windowBeforeMeasurement) continue;
        if (!(L.windowStart > L.feNoStart)) continue;
        layouts.push(L);
    }
    if (layouts.length === 0) return null;

    const minAmbient = Math.min(...layouts.map((L) => L.nAmbient));
    const minFeNoStart = Math.min(...layouts.map((L) => L.feNoStart));
    const minWindowStart = Math.min(...layouts.map((L) => L.windowStart));

    const nAmbientEff = Math.max(8, Math.floor(minAmbient));
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
    };
}

function _pickMedianTotalPhaseCounts(rows) {
    if (!rows || rows.length === 0) return null;
    if (rows.length === 1) {
        const x = rows[0];
        return { nAmbient: x.nAmbient, nBsc: x.nBsc, nFeno: x.nFeno, nWindow: x.nWindow };
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
    for (const f of files || []) {
        const L = getFeNOseAromaTrimPhaseLayout(f?.data, FENOSE_AROMA_TRIM_DEFAULTS);
        if (L) {
            trimRows.push({
                nAmbient: L.nAmbient,
                nBsc: L.nBsc,
                nFeno: L.nFeno,
                nWindow: L.nWindow,
            });
        }
    }
    const fromTrim = _pickMedianTotalPhaseCounts(trimRows);
    if (fromTrim) return fromTrim;

    const rawRows = [];
    for (const f of files || []) {
        const c = countPhasesOneFile(f?.data);
        if (c) rawRows.push({ ...c });
    }
    return _pickMedianTotalPhaseCounts(rawRows);
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
    for (const f of files || []) {
        const c = countPhasesOneFile(f?.data);
        if (c) samples.push(c);
    }
    if (samples.length === 0) return null;

    const med = (arr) => {
        const s = [...arr].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 !== 0 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
    };

    return {
        nAmbient: med(samples.map((x) => x.nAmbient)),
        nBsc: med(samples.map((x) => x.nBsc)),
        nFeno: med(samples.map((x) => x.nFeno)),
        /* Median 0 drops FeNOWindow rows → Multi AU plots lose the purple phase marker vs real data. */
        nWindow: Math.max(1, med(samples.map((x) => x.nWindow))),
    };
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
 * @param {object[]} devFiles — same bucket as calibration for this AU
 * @param {object | null} pooledPhaseCounts — from {@link resolvePooledSyntheticPhaseCounts}
 * @param {object} [opts] — optional nAmbient, nBsc, nFeno, nWindow (finite numbers override inference)
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

    const pick = (key, lo, hi) => {
        const o = finiteOpt(key);
        if (o !== null) return Math.max(lo, Math.min(hi, o));
        if (src && src[key] != null && Number.isFinite(src[key])) {
            return Math.max(lo, Math.min(hi, Math.floor(src[key])));
        }
        return Math.max(lo, Math.min(hi, fb[key]));
    };

    return {
        nAmbient: pick('nAmbient', 8, 220),
        nBsc: pick('nBsc', 0, 80),
        nFeno: pick('nFeno', 8, 220),
        nWindow: pick('nWindow', 1, 120),
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
 *   • Aux (AQT/AQH/AQP): gentle correlated drift across row index within each phase.
 *   • Tiny common-mode multiplicative noise per row (shared airflow / thermal).
 *
 * @param {object} opts
 * @param {number}  opts.ppb
 * @param {number}  [opts.seed=42]
 * @param {number}  [opts.nAmbient=100]
 * @param {number}  [opts.nBsc=27]         — BreathSampleCollection rows (breath matrix, no analyte)
 * @param {number}  [opts.nFeno=100]
 * @param {number}  [opts.nWindow=15]
 * @param {object}  [opts.calibration]  — from computeCalibrationFromFiles / mergeCalibration
 */
export function generateSyntheticFenoseRows({
    ppb,
    seed     = 42,
    nAmbient = 100,
    nBsc     = 27,
    nFeno    = 100,
    nWindow  = 15,
    calibration = null,
}) {
    const y = Number(ppb);
    if (!Number.isFinite(y) || y < 0) {
        throw new Error('generateSyntheticFenoseRows: ppb must be ≥ 0');
    }

    /* Wide upper bounds so inferred medians from long real captures are not truncated. */
    const rowsAmbient = _clampSynthCount(nAmbient, 100, 8, 220);
    const rowsBsc = _clampSynthCount(nBsc, 27, 0, 80);
    const rowsFeno = _clampSynthCount(nFeno, 100, 8, 220);
    const rowsWindow = _clampSynthCount(nWindow, 15, 1, 120);

    const cal = calibration || FALLBACK_CALIBRATION;
    const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);

    // ── Per-capture parameters ──────────────────────────────────────────────
    const rfcBase = {};
    const bscBase = {};
    const noiseSig = {};
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

    /* ── Ambient (room air) environmental conditions ────────────────────────── */
    const aqt0 = 22 + randNormal(rnd, 0, 1.5);
    const aqh0 = 45 + randNormal(rnd, 0, 8);
    const aqp0 = 990 + randNormal(rnd, 0, 5);
    const aqtSlope = randNormal(rnd, 0, 0.04);
    const aqhSlope = randNormal(rnd, 0, 0.35);
    const aqpSlope = randNormal(rnd, 0, 0.55);

    /* ── Breath-matrix shift: exhaled breath raises humidity and temperature ── */
    const breathTempShift  = 10 + randNormal(rnd, 0, 2);       // ~+10 °C from body heat
    const breathHumShift   = 35 + randNormal(rnd, 0, 6);       // ~+35 %RH saturated exhaled air
    const breathPresShift  = randNormal(rnd, 0, 1.5);          // ~neutral pressure shift

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
            AQT0: aqt0 + aqtSlope * t01 + randNormal(rnd, 0, 0.03),
            AQH0: aqh0 + aqhSlope * t01 + randNormal(rnd, 0, 0.3),
            AQP0: aqp0 + aqpSlope * t01 + randNormal(rnd, 0, 0.5),
        };
        const cm = 1 + randNormal(rnd, 0, 0.0018);
        for (const s of SENSOR_COLS) {
            const base = rfcBase[s] * driftM;
            row[s] = cm * (base + randNormal(rnd, 0, noiseSig[s]));
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
                AQT0: aqt0 + breathTempShift * (0.6 + 0.4 * t01) + randNormal(rnd, 0, 0.06),
                AQH0: aqh0 + breathHumShift  * (0.5 + 0.5 * t01) + randNormal(rnd, 0, 0.6),
                AQP0: aqp0 + breathPresShift + randNormal(rnd, 0, 0.6),
            };
            const cm = 1 + randNormal(rnd, 0, 0.0020);
            for (const s of SENSOR_COLS) {
                const base = bscBase[s] * driftM * (1 + bscBaselineShift[s]);
                row[s] = cm * (base + randNormal(rnd, 0, noiseSig[s]));
            }
            rows.push(row);
        }
    }

    // ── FeNOMeasurement (reaction / wash-in + elevated transient noise) ──────
    let lastRise = 0;
    for (let i = 0; i < rowsFeno; i++) {
        const rise = 1 - Math.exp(-i / riseTauClamped);
        lastRise = rise;
        const t01 = rowsFeno <= 1 ? 1 : i / (rowsFeno - 1);
        const driftM = phaseDriftMultiplierFromCoeffs(driftFeno, t01);
        const transient = transientNoiseBoost * (1 - rise);
        const row = {
            event_name: 'FeNOMeasurement',
            AQT0: aqt0 + breathTempShift + aqtSlope * 0.15 * t01 + randNormal(rnd, 0, 0.04),
            AQH0: aqh0 + breathHumShift + aqhSlope * 0.12 * t01 + randNormal(rnd, 0, 0.4),
            AQP0: aqp0 + breathPresShift + aqpSlope * 0.12 * t01 + randNormal(rnd, 0, 0.5),
        };
        const cm = 1 + randNormal(rnd, 0, 0.0022);
        for (const s of SENSOR_COLS) {
            const ndResp = effNdSlope[s] * yNd * rise;
            const ndTot = bscBaselineShift[s] + ndResp + zeroOffset[s];
            const base = bscBase[s] * driftM * (1 + ndTot);
            const sig = noiseSig[s] * Math.sqrt(1 + transient * transient);
            row[s] = cm * (base + randNormal(rnd, 0, sig));
        }
        rows.push(row);
    }

    // ── FeNOWindow (ND decay toward baseline + mild damped ripple; not recoveryOff) ─
    if (rowsWindow > 0) {
        for (let j = 0; j < rowsWindow; j++) {
            const t01 = rowsWindow <= 1 ? 0 : j / (rowsWindow - 1);
            const driftM = phaseDriftMultiplierFromCoeffs(driftWin, t01);
            const row = {
                event_name: 'FeNOWindow',
                AQT0: aqt0 + breathTempShift * (0.9 - 0.15 * t01) + aqtSlope * 0.08 * t01 + randNormal(rnd, 0, 0.04),
                AQH0: aqh0 + breathHumShift * (0.9 - 0.15 * t01) + aqhSlope * 0.08 * t01 + randNormal(rnd, 0, 0.4),
                AQP0: aqp0 + breathPresShift + aqpSlope * 0.08 * t01 + randNormal(rnd, 0, 0.5),
            };
            const cm = 1 + randNormal(rnd, 0, 0.0018);
            for (const s of SENSOR_COLS) {
                const ndPlateau = bscBaselineShift[s] + effNdSlope[s] * yNd * lastRise + zeroOffset[s];
                const excess0 = ndPlateau - bscBaselineShift[s] - zeroOffset[s];
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
