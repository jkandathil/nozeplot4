import { parseFenoseDeviceIdFromFilename } from './fenoseModel.js';

/**
 * Synthetic FeNOse-style tabular rows for workspace training / demos.
 * Phases and columns match extractFenoseFeaturesFromRows:
 * AmbientSamplingRFC, FeNOMeasurement, optional FeNOWindow; A1–H8; AQT0, AQH0, AQP0.
 *
 * Calibration strategy
 * ─────────────────────
 * Call computeCalibrationFromFiles(parsedRealFiles) to derive all six per-sensor
 * parameters directly from real device captures in the workspace.  Pass the result
 * as the `calibration` argument to generateSyntheticFenoseRows.
 *
 * If real data is unavailable the generator falls back to FALLBACK_CALIBRATION
 * (empirical, device 0000000018-0926-asu-nz, 18-2 batch, 7 ppb levels × 5 reps).
 *
 * Six calibration parameters per sensor
 * ──────────────────────────────────────
 *  amb_med      median ambient reading across all captures  (baseline level)
 *  nd_slope     linear ΔND/Δppb from OLS fit               (sensitivity)
 *  amb_cv       std/mean of ambient across captures         (inter-replicate baseline spread)
 *  noise_cv     within-ambient-phase std / mean             (row-to-row measurement noise)
 *  sens_cv      std(nd@100ppb) / |nd_slope×100|             (capture-to-capture sensitivity variation ~13%)
 *  zero_std_nd  std(nd) at 0 ppb                            (baseline ND offset noise)
 *
 * The first four existed in v1; sens_cv and zero_std_nd are new and critical —
 * they explain the ×10-20 under-dispersion seen in v1 synthetic nd features.
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

        const ambient = _rowsOfPhase(data, 'AmbientSamplingRFC');
        const feno    = _rowsOfPhase(data, 'FeNOMeasurement');
        if (ambient.length < 5 || feno.length < 5) continue;

        const sample = { ppb };
        let found = 0;
        for (const s of SENSOR_COLS) {
            const av = ambient.map((r) => _safeNum(r?.[s])).filter((v) => v !== null);
            const fv = feno.map((r)    => _safeNum(r?.[s])).filter((v) => v !== null);
            if (av.length < 3 || fv.length < 3) continue;
            const am = _mean(av); const fm = _mean(fv);
            if (Math.abs(am) < 1e-6) continue;
            sample[s] = {
                ambMean: am,
                nd:      (fm - am) / Math.abs(am),
                noiseCv: _std(av) / Math.abs(am),
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
        const ambMeans  = ws.map((f) => f[s].ambMean);
        const amb_med   = _median(ambMeans);
        const ambAvg    = _mean(ambMeans);
        const amb_cv    = Math.max(0.001, Math.min(0.15, _std(ambMeans) / (Math.abs(ambAvg) + 1e-9)));
        const noise_cv  = Math.max(0.0001, Math.min(0.10, _mean(ws.map((f) => f[s].noiseCv))));

        const xs = ws.map((f) => f.ppb);
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
        if (nd100.length >= 2 && Math.abs(nd_slope * 100) > 1e-9) {
            sens_cv = Math.max(0.01, Math.min(0.35, _std(nd100) / Math.abs(nd_slope * 100)));
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
            const denom = Math.abs(nd_slope * refPpb) + 1e-12;
            if (maxStd > 1e-12) {
                sens_cv = Math.max(0.01, Math.min(0.35, maxStd / denom));
            } else {
                sens_cv = FALLBACK_CALIBRATION[s]?.sens_cv ?? 0.15;
            }
        }

        calibration[s] = {
            amb_med:     Math.max(1, amb_med),
            nd_slope:    Number.isFinite(nd_slope) ? nd_slope : 0,
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

// ─── Generator ───────────────────────────────────────────────────────────────

function _clampSynthCount(v, fallback, lo, hi) {
    const n = Math.floor(Number(v));
    const x = Number.isFinite(n) ? n : fallback;
    return Math.max(lo, Math.min(hi, x));
}

/**
 * Generate synthetic FeNOse rows whose nd feature distribution matches real data.
 *
 * Per-capture variability model (three independent noise sources):
 *   1. Baseline offset  : ambBase[s] = amb_med × exp(N(0, amb_cv²))
 *      → shifts absolute sensor level but cancels in nd (kept for realism)
 *   2. Sensitivity jitter: effective_slope = nd_slope × (1 + N(0, sens_cv²))
 *      → the dominant source of nd variability between captures (~13%)
 *   3. Zero-offset noise : per-capture additive offset in nd space (zero_std_nd)
 *      → residual environmental / drift component independent of ppb
 *
 * @param {object} opts
 * @param {number}  opts.ppb
 * @param {number}  [opts.seed=42]
 * @param {number}  [opts.nAmbient=100]
 * @param {number}  [opts.nFeno=100]
 * @param {number}  [opts.nWindow=15]
 * @param {object}  [opts.calibration]  — from computeCalibrationFromFiles / mergeCalibration
 */
export function generateSyntheticFenoseRows({
    ppb,
    seed     = 42,
    nAmbient = 100,
    nFeno    = 100,
    nWindow  = 15,
    calibration = null,
}) {
    const y = Number(ppb);
    if (!Number.isFinite(y) || y < 0) {
        throw new Error('generateSyntheticFenoseRows: ppb must be ≥ 0');
    }

    const rowsAmbient = _clampSynthCount(nAmbient, 100, 8, 120);
    const rowsFeno = _clampSynthCount(nFeno, 100, 8, 120);
    const rowsWindow = _clampSynthCount(nWindow, 15, 0, 80);

    const cal = calibration || FALLBACK_CALIBRATION;
    const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);

    // ── Per-capture parameters ──────────────────────────────────────────────
    const ambBase     = {};   // absolute baseline level for this capture
    const noiseSig    = {};   // row-level absolute noise std
    const effNdSlope  = {};   // effective nd_slope with capture-to-capture jitter
    const zeroOffset  = {};   // per-capture zero nd offset

    for (const s of SENSOR_COLS) {
        const c = cal[s] || FALLBACK_CALIBRATION[s];

        // 1. Baseline (log-normal so always positive)
        const deviceOffset = Math.exp(randNormal(rnd, 0, c.amb_cv));
        ambBase[s]  = c.amb_med * deviceOffset;
        noiseSig[s] = ambBase[s] * c.noise_cv;

        // 2. Sensitivity jitter (normal ±sens_cv around nominal slope)
        const sensJitter = 1 + randNormal(rnd, 0, c.sens_cv);
        effNdSlope[s] = c.nd_slope * sensJitter;

        // 3. Zero-offset noise in nd space (independent of ppb)
        zeroOffset[s] = randNormal(rnd, 0, c.zero_std_nd);
    }

    const aqt = 22 + randNormal(rnd, 0, 1.5);
    const aqh = 45 + randNormal(rnd, 0, 8);
    const aqp = 990 + randNormal(rnd, 0, 5);

    const rows = [];

    // ── AmbientSamplingRFC ──────────────────────────────────────────────────
    for (let i = 0; i < rowsAmbient; i++) {
        const row = {
            event_name: 'AmbientSamplingRFC',
            AQT0: aqt + randNormal(rnd, 0, 0.03),
            AQH0: aqh + randNormal(rnd, 0, 0.3),
            AQP0: aqp + randNormal(rnd, 0, 0.5),
        };
        for (const s of SENSOR_COLS) {
            row[s] = ambBase[s] + randNormal(rnd, 0, noiseSig[s]);
        }
        rows.push(row);
    }

    // ── FeNOMeasurement ─────────────────────────────────────────────────────
    // Target nd = effNdSlope[s] * y + zeroOffset[s]
    // → absolute target = ambBase[s] * (1 + target_nd) = ambBase[s] + delta
    for (let i = 0; i < rowsFeno; i++) {
        const row = {
            event_name: 'FeNOMeasurement',
            AQT0: aqt + 0.2  + randNormal(rnd, 0, 0.03),
            AQH0: aqh         + randNormal(rnd, 0, 0.3),
            AQP0: aqp         + randNormal(rnd, 0, 0.5),
        };
        for (const s of SENSOR_COLS) {
            const targetNd = effNdSlope[s] * y + zeroOffset[s];
            row[s] = ambBase[s] * (1 + targetNd) + randNormal(rnd, 0, noiseSig[s]);
        }
        rows.push(row);
    }

    // ── FeNOWindow ──────────────────────────────────────────────────────────
    if (rowsWindow > 0) {
        for (let i = 0; i < rowsWindow; i++) {
            const frac = 0.15 + (i / Math.max(rowsWindow - 1, 1)) * 0.55;
            const row = {
                event_name: 'FeNOWindow',
                AQT0: aqt + randNormal(rnd, 0, 0.03),
                AQH0: aqh + randNormal(rnd, 0, 0.3),
                AQP0: aqp + randNormal(rnd, 0, 0.5),
            };
            for (const s of SENSOR_COLS) {
                const fullNd    = effNdSlope[s] * y + zeroOffset[s];
                const partialNd = fullNd * (1 - frac);
                row[s] = ambBase[s] * (1 + partialNd) + randNormal(rnd, 0, noiseSig[s]);
            }
            rows.push(row);
        }
    }

    return rows;
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
