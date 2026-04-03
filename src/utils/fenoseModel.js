// FeNOse (NO concentration) predictor — browser-side implementation
// Mirrors data_fenoze/model/fenose_predict.py (feature extraction + v1 MLP forward pass).

import * as tf from '@tensorflow/tfjs';
import { PCA } from 'ml-pca';
import { Matrix } from 'ml-matrix';

const SENSOR_COLS = Array.from({ length: 8 }, (_, r) => 'ABCDEFGH'[r])
    .flatMap((row) => Array.from({ length: 8 }, (_, c) => `${row}${c + 1}`));

function safeNumber(x) {
    if (x === null || x === undefined || x === '') return null;
    const n = typeof x === 'number' ? x : parseFloat(String(x).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

function meanOf(nums) {
    let s = 0;
    let k = 0;
    for (const n of nums) {
        if (!Number.isFinite(n)) continue;
        s += n;
        k++;
    }
    return k ? s / k : 0;
}

function stdOf(nums) {
    const m = meanOf(nums);
    let ss = 0;
    let k = 0;
    for (const n of nums) {
        if (!Number.isFinite(n)) continue;
        const d = n - m;
        ss += d * d;
        k++;
    }
    return k ? Math.sqrt(ss / k) : 0;
}

function rowsWhereEventEquals(data, eventName) {
    return (data || []).filter((r) => String(r?.event_name ?? '').trim() === eventName);
}

/** Extracts the same feature dict as fenose_predict.py for one CSV dataset already parsed into rows. */
export function extractFenoseFeaturesFromRows(data) {
    const ambient = rowsWhereEventEquals(data, 'AmbientSamplingRFC');
    const feno = rowsWhereEventEquals(data, 'FeNOMeasurement');
    const window = rowsWhereEventEquals(data, 'FeNOWindow');
    if (!ambient.length || !feno.length) {
        throw new Error('Missing AmbientSamplingRFC or FeNOMeasurement phases (event_name column required).');
    }

    const ambMean = {};
    const fenoMean = {};
    const fenoStd = {};
    const windowMean = {};

    for (const s of SENSOR_COLS) {
        ambMean[s] = meanOf(ambient.map((r) => safeNumber(r?.[s])));
        const fVals = feno.map((r) => safeNumber(r?.[s])).filter((v) => v !== null);
        fenoMean[s] = meanOf(fVals);
        fenoStd[s] = stdOf(fVals);

        if (window.length) {
            windowMean[s] = meanOf(window.map((r) => safeNumber(r?.[s])));
        } else {
            windowMean[s] = 0;
        }
    }

    const feats = {};
    const deltas = [];
    const nds = [];

    for (const s of SENSOR_COLS) {
        const delta = fenoMean[s] - ambMean[s];
        const nd = delta / (Math.abs(ambMean[s]) + 1e-6);
        feats[`d_${s}`] = delta;
        feats[`nd_${s}`] = nd;
        feats[`fs_${s}`] = fenoStd[s] || 0;
        feats[`wd_${s}`] = window.length ? (windowMean[s] - ambMean[s]) : 0;
        deltas.push(delta);
        nds.push(nd);
    }

    for (const e of ['AQT0', 'AQH0', 'AQP0']) {
        feats[`env_${e}`] = meanOf((data || []).map((r) => safeNumber(r?.[e])));
    }

    feats.delta_mean = meanOf(deltas);
    feats.delta_max = deltas.length ? Math.max(...deltas) : 0;
    feats.delta_min = deltas.length ? Math.min(...deltas) : 0;
    feats.delta_std = stdOf(deltas);
    feats.nd_mean = meanOf(nds);
    feats.nd_std = stdOf(nds);

    return feats;
}

export function parseFenosePpbFromFilename(name) {
    const b = String(name || '').split(/[/\\]/).pop() || '';
    const m = b.match(/(\d+(?:\.\d+)?)\s*ppb\b/i);
    return m ? parseFloat(m[1]) : null;
}

/**
 * Extract an Aroma Unit (or device) id from a workspace filename.
 * Matches any NZ pipeline token `##########-####-<role>-nz` (e.g. asu-nz, oms-nz).
 * When several tokens appear, prefers `-asu-nz` (typical AU serial in captures).
 */
export function parseFenoseDeviceIdFromFilename(name) {
    const b = String(name || '').split(/[/\\]/).pop() || '';
    // Avoid \b: underscores count as “word” in JS, so tokens like …_0000000063-0926-asu-nz_… would not match.
    const re = /(?<![0-9])(\d{10}-\d{4}-[a-z0-9]+-nz)(?![A-Za-z0-9])/gi;
    const found = [];
    let m;
    while ((m = re.exec(b)) !== null) {
        found.push(m[1]);
    }
    if (found.length === 0) return 'UNKNOWN';
    const asu = found.find((x) => /-asu-nz$/i.test(x));
    return (asu || found[0]).toUpperCase();
}

function trainingSampleLabel(row) {
    const b = String(row?.fileName || row?.name || '').split(/[/\\]/).pop() || '';
    if (!b) return 'sample';
    return b.length > 42 ? `${b.slice(0, 40)}…` : b;
}

export function buildFenoseDatasetFromFiles(files) {
    const rows = [];
    for (const f of files || []) {
        if (!f?.data?.length) continue;
        const y = parseFenosePpbFromFilename(f.fileName || f.name || '');
        if (!Number.isFinite(y)) continue;
        const feats = extractFenoseFeaturesFromRows(f.data);
        rows.push({
            id: f.id || f.fileName || f.name,
            fileName: f.fileName || f.name || '',
            deviceId: parseFenoseDeviceIdFromFilename(f.fileName || f.name || ''),
            y,
            feats,
        });
    }
    if (!rows.length) {
        throw new Error('No valid training samples found. Need multiple curated CSVs with `event_name` and `...ppb...` in filename.');
    }
    const featCols = Array.from(
        rows.reduce((s, r) => {
            Object.keys(r.feats || {}).forEach((k) => s.add(k));
            return s;
        }, new Set())
    ).sort((a, b) => a.localeCompare(b));

    const X = rows.map((r) => featCols.map((k) => (Number.isFinite(r.feats[k]) ? r.feats[k] : 0)));
    const y = rows.map((r) => r.y);
    return { rows, featCols, X, y };
}

function corrAbs(Xcol, y) {
    const n = y.length;
    if (n < 3) return 0;
    let mx = 0,
        my = 0;
    for (let i = 0; i < n; i++) {
        mx += Xcol[i];
        my += y[i];
    }
    mx /= n;
    my /= n;
    let num = 0,
        dx = 0,
        dy = 0;
    for (let i = 0; i < n; i++) {
        const a = Xcol[i] - mx;
        const b = y[i] - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
    }
    const den = Math.sqrt(dx * dy) || 1e-12;
    return Math.abs(num / den);
}

function standardizeFit(X) {
    const n = X.length;
    const d = X[0]?.length || 0;
    const mean = new Array(d).fill(0);
    const std = new Array(d).fill(0);
    for (let j = 0; j < d; j++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += X[i][j];
        mean[j] = s / n;
    }
    for (let j = 0; j < d; j++) {
        let ss = 0;
        for (let i = 0; i < n; i++) {
            const v = X[i][j] - mean[j];
            ss += v * v;
        }
        std[j] = Math.sqrt(ss / n) || 1e-6;
    }
    return { mean, std };
}

function standardizeApply(X, mean, std) {
    return X.map((row) => row.map((v, j) => (v - (mean[j] ?? 0)) / (std[j] || 1e-6)));
}

function mse(yTrue, yPred) {
    const n = yTrue.length || 1;
    let s = 0;
    for (let i = 0; i < n; i++) {
        const d = (yPred[i] ?? 0) - (yTrue[i] ?? 0);
        s += d * d;
    }
    return s / n;
}

function mae(yTrue, yPred) {
    const n = yTrue.length || 1;
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs((yPred[i] ?? 0) - (yTrue[i] ?? 0));
    return s / n;
}

function rmse(yTrue, yPred) {
    return Math.sqrt(mse(yTrue, yPred));
}

function trainTestSplitStratifiedByY(rows, testFrac = 0.2, seed = 0) {
    // Bin by exact y (ppb levels), then take floor(frac) from each bin into test.
    const by = new Map();
    rows.forEach((r, idx) => {
        const k = String(r.y);
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(idx);
    });
    const rng = mulberry32(seed);
    const testIdx = new Set();
    for (const idxs of by.values()) {
        shuffleInPlace(idxs, rng);
        const nTest = Math.max(1, Math.floor(idxs.length * testFrac));
        idxs.slice(0, nTest).forEach((i) => testIdx.add(i));
    }
    const train = [];
    const test = [];
    rows.forEach((r, i) => (testIdx.has(i) ? test.push(r) : train.push(r)));
    return { train, test };
}

function mulberry32(a) {
    return function () {
        let t = (a += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffleInPlace(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

async function tfTrainMlp(X, y, { epochs = 200, lr = 1e-3, h1 = 64, h2 = 32 } = {}, onProgress = null) {
    const n = X.length;
    const d = X[0]?.length || 0;
    const model = tf.sequential();
    model.add(tf.layers.dense({ units: h1, inputShape: [d], activation: 'relu' }));
    model.add(tf.layers.dense({ units: h2, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 1, activation: 'linear' }));
    model.compile({ optimizer: tf.train.adam(lr), loss: 'meanSquaredError' });
    const xs = tf.tensor2d(X, [n, d], 'float32');
    const ys = tf.tensor2d(y.map((v) => [v]), [n, 1], 'float32');
    try {
        await model.fit(xs, ys, {
            epochs,
            batchSize: Math.min(32, n),
            shuffle: true,
            callbacks: {
                onEpochEnd: async (epoch, logs) => {
                    if (onProgress) onProgress({ epoch: epoch + 1, loss: logs?.loss ?? null });
                },
            },
        });
    } finally {
        xs.dispose();
        ys.dispose();
    }
    return model;
}

async function denseWeightsToFenoseJson(model) {
    const [l1, l2, l3] = model.layers;
    const [W1, b1] = l1.getWeights();
    const [W2, b2] = l2.getWeights();
    const [W3, b3] = l3.getWeights();
    const w = {
        W1: await W1.array(),
        b1: await b1.array(),
        W2: await W2.array(),
        b2: await b2.array(),
        W3: await W3.array(),
        b3: await b3.array(),
    };
    return w;
}

export async function trainFenoseV1FromFiles(
    files,
    { topK = 80, testFrac = 0.2, seed = 0, epochs = 300, lr = 1e-3, h1 = 64, h2 = 32 } = {},
    onProgress = null
) {
    const { rows, featCols, X, y } = buildFenoseDatasetFromFiles(files);
    const rowsWithX = rows.map((r, i) => ({ ...r, x: X[i] }));
    const yLog = y.map((v) => Math.log1p(Math.max(0, v)));

    // Top-K by abs correlation with log target
    const scores = featCols.map((_, j) => corrAbs(rowsWithX.map((r) => r.x[j]), yLog));
    const topIdx = scores
        .map((s, j) => ({ s, j }))
        .sort((a, b) => b.s - a.s)
        .slice(0, Math.max(1, Math.min(topK, featCols.length)))
        .map((o) => o.j);

    const split = trainTestSplitStratifiedByY(rowsWithX.map((r, i) => ({ ...r, y: yLog[i] })), testFrac, seed);
    const Xtrain = split.train.map((r) => topIdx.map((j) => r.x[j] ?? 0));
    const ytrain = split.train.map((r) => r.y);
    const Xtest = split.test.map((r) => topIdx.map((j) => r.x[j] ?? 0));

    const { mean, std } = standardizeFit(Xtrain);
    const XtrainSc = standardizeApply(Xtrain, mean, std);
    const XtestSc = standardizeApply(Xtest, mean, std);

    const model = await tfTrainMlp(XtrainSc, ytrain, { epochs, lr, h1, h2 }, onProgress);
    const predLog = tf.tidy(() => model.predict(tf.tensor2d(XtestSc, [XtestSc.length, XtestSc[0].length], 'float32')).dataSync());
    const predLogArr = Array.from(predLog);

    const predPpb = predLogArr.map((v) => Math.expm1(Math.max(0, Math.min(10, v))));
    const ytestPpb = split.test.map((r) => Math.expm1(r.y));
    const validationPoints = split.test.map((r, i) => ({
        actual: ytestPpb[i],
        predicted: predPpb[i],
        label: trainingSampleLabel(r),
    }));

    const weights = await denseWeightsToFenoseJson(model);
    const preprocessing = {
        feat_cols: featCols,
        top_idx: topIdx,
        scaler_mean: mean,
        scaler_std: std,
    };

    return {
        weights,
        preprocessing,
        metrics: {
            testCount: split.test.length,
            trainCount: split.train.length,
            MAE_ppb: mae(ytestPpb, predPpb),
            RMSE_ppb: rmse(ytestPpb, predPpb),
            validationPoints,
        },
    };
}

export async function trainFenoseV2FromFiles(
    files,
    { topK = 300, nPca = 50, testFrac = 0.2, seed = 0, epochs = 300, lr = 1e-3, h1 = 64, h2 = 32 } = {},
    onProgress = null
) {
    const { rows, featCols, X, y } = buildFenoseDatasetFromFiles(files);
    const rowsWithX = rows.map((r, i) => ({ ...r, x: X[i] }));

    // Build good_mask: select Top-K by abs corr with raw ppb (simple, deterministic)
    const scores = featCols.map((_, j) => corrAbs(rowsWithX.map((r) => r.x[j]), y));
    const goodIdx = scores
        .map((s, j) => ({ s, j }))
        .sort((a, b) => b.s - a.s)
        .slice(0, Math.max(1, Math.min(topK, featCols.length)))
        .map((o) => o.j);
    const goodMask = featCols.map((_, j) => goodIdx.includes(j));

    const split = trainTestSplitStratifiedByY(rowsWithX, testFrac, seed);
    const yMax = Math.max(...split.train.map((r) => r.y), 1);

    const XtrainG = split.train.map((r) => goodIdx.map((j) => r.x[j] ?? 0));
    const XtestG = split.test.map((r) => goodIdx.map((j) => r.x[j] ?? 0));

    const { mean, std } = standardizeFit(XtrainG);
    const XtrainSc = standardizeApply(XtrainG, mean, std);
    const XtestSc = standardizeApply(XtestG, mean, std);

    // PCA: TensorFlow.js does not expose tf.linalg.svd in the browser bundle; use ml-pca (SVD) instead.
    const nTrain = XtrainSc.length;
    const nFeat = XtrainSc[0]?.length || 0;
    const k = Math.max(1, Math.min(Math.max(1, Number(nPca) || 50), nFeat, Math.max(1, nTrain)));
    const Mtrain = new Matrix(XtrainSc);
    const pca = new PCA(Mtrain, { center: false, scale: false, method: 'SVD' });
    const U = pca.getEigenvectors();
    const nComp = Math.min(k, U.columns);
    const V = [];
    for (let i = 0; i < U.rows; i++) {
        const row = [];
        for (let j = 0; j < nComp; j++) row.push(U.get(i, j));
        V.push(row);
    }
    const XtrainPca = pca.predict(Mtrain, { nComponents: nComp }).to2DArray();
    const Mtest = new Matrix(XtestSc);
    const XtestPca = pca.predict(Mtest, { nComponents: nComp }).to2DArray();

    const yTrainScaled = split.train.map((r) => r.y / yMax);
    const yTest = split.test.map((r) => r.y);

    const model = await tfTrainMlp(XtrainPca, yTrainScaled, { epochs, lr, h1, h2 }, onProgress);
    const predScaled = tf.tidy(() =>
        model.predict(tf.tensor2d(XtestPca, [XtestPca.length, XtestPca[0].length], 'float32')).dataSync()
    );
    const predPpb = Array.from(predScaled).map((v) => Math.max(0, Math.min(yMax, v * yMax)));
    const validationPoints = split.test.map((r, i) => ({
        actual: yTest[i],
        predicted: predPpb[i],
        label: trainingSampleLabel(r),
    }));

    const weights = await denseWeightsToFenoseJson(model);

    // Store V_pca in *full feature space* like the inference code expects (it indexes with good_mask)
    const Vfull = featCols.map(() => new Array(V[0].length).fill(0));
    goodIdx.forEach((featIndex, iGood) => {
        Vfull[featIndex] = V[iGood];
    });

    const featMeanFull = featCols.map((_, j) => {
        const iGood = goodIdx.indexOf(j);
        return iGood >= 0 ? mean[iGood] : 0;
    });
    const featStdFull = featCols.map((_, j) => {
        const iGood = goodIdx.indexOf(j);
        return iGood >= 0 ? std[iGood] : 1;
    });

    const preprocessing = {
        feat_cols: featCols,
        good_mask: goodMask,
        feat_mean: featMeanFull,
        feat_std: featStdFull,
        V_pca: Vfull,
        y_max: yMax,
    };

    return {
        weights,
        preprocessing,
        metrics: {
            testCount: split.test.length,
            trainCount: split.train.length,
            MAE_ppb: mae(yTest, predPpb),
            RMSE_ppb: rmse(yTest, predPpb),
            validationPoints,
        },
    };
}

/**
 * Expected JSON format:
 * - weights: { W1:number[][], b1:number[], W2:number[][], b2:number[], W3:number[][], b3:number[] }
 * - preprocessing: { feat_cols:string[], top_idx:number[], scaler_mean:number[], scaler_std:number[] }
 */
async function fetchJsonFirstOk(urlOrUrls, label) {
    const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
    let lastErr = null;
    for (const url of urls) {
        try {
            const r = await fetch(url);
            if (!r.ok) {
                lastErr = new Error(`${label} HTTP ${r.status} at ${url}`);
                continue;
            }
            const ct = (r.headers.get('content-type') || '').toLowerCase();
            // If SPA fallback returns index.html, content-type is typically text/html.
            if (ct.includes('text/html')) {
                lastErr = new Error(`${label} returned HTML at ${url} (likely wrong base path)`);
                continue;
            }
            return await r.json();
        } catch (e) {
            lastErr = e;
        }
    }
    throw new Error(`Failed to load ${label} (${lastErr?.message || 'unknown error'})`);
}

export async function predictFenosePpbV1FromRows(
    dataRows,
    { weightsUrl, preprocessingUrl, weightsUrls, preprocessingUrls, weights, preprocessing } = {}
) {
    const [w, p] = weights && preprocessing
        ? [weights, preprocessing]
        : await Promise.all([
              fetchJsonFirstOk(weightsUrls || weightsUrl, 'weights'),
              fetchJsonFirstOk(preprocessingUrls || preprocessingUrl, 'preprocessing'),
          ]);

    const feats = extractFenoseFeaturesFromRows(dataRows);
    const featCols = Array.isArray(p?.feat_cols) ? p.feat_cols : [];
    const topIdx = Array.isArray(p?.top_idx) ? p.top_idx : [];
    const mu = Array.isArray(p?.scaler_mean) ? p.scaler_mean : [];
    const std = Array.isArray(p?.scaler_std) ? p.scaler_std : [];

    if (!featCols.length || !topIdx.length || !mu.length || !std.length) {
        throw new Error('Preprocessing JSON missing feat_cols/top_idx/scaler_mean/scaler_std.');
    }
    if (!w?.W1 || !w?.b1 || !w?.W2 || !w?.b2 || !w?.W3 || !w?.b3) {
        throw new Error('Weights JSON missing W1/b1/W2/b2/W3/b3.');
    }

    const Xfull = featCols.map((c) => {
        const v = feats[c];
        return Number.isFinite(v) ? v : 0;
    });
    const Xsel = topIdx.map((i) => Xfull[i] ?? 0);
    const Xsc = Xsel.map((v, i) => (v - (mu[i] ?? 0)) / (std[i] || 1e-6));

    // Forward pass using TFJS (keeps it fast and consistent).
    const y = tf.tidy(() => {
        const x = tf.tensor2d([Xsc], [1, Xsc.length], 'float32');
        const W1 = tf.tensor2d(w.W1, undefined, 'float32');
        const b1 = tf.tensor1d(w.b1, 'float32');
        const W2 = tf.tensor2d(w.W2, undefined, 'float32');
        const b2 = tf.tensor1d(w.b2, 'float32');
        const W3 = tf.tensor2d(w.W3, undefined, 'float32');
        const b3 = tf.tensor1d(w.b3, 'float32');
        const a1 = tf.relu(tf.add(tf.matMul(x, W1), b1));
        const a2 = tf.relu(tf.add(tf.matMul(a1, W2), b2));
        const out = tf.add(tf.matMul(a2, W3), b3);
        return out.dataSync()[0];
    });

    const yClipped = Math.max(0, Math.min(10, y));
    const ppb = Math.expm1(yClipped);
    return Math.round(ppb * 100) / 100;
}

export async function predictFenosePpbV2FromRows(
    dataRows,
    { weightsUrl, preprocessingUrl, weightsUrls, preprocessingUrls, weights, preprocessing } = {}
) {
    const [w, p] = weights && preprocessing
        ? [weights, preprocessing]
        : await Promise.all([
              fetchJsonFirstOk(weightsUrls || weightsUrl, 'weights'),
              fetchJsonFirstOk(preprocessingUrls || preprocessingUrl, 'preprocessing'),
          ]);

    const feats = extractFenoseFeaturesFromRows(dataRows);
    const featCols = Array.isArray(p?.feat_cols) ? p.feat_cols : [];
    const goodMask = Array.isArray(p?.good_mask) ? p.good_mask : null;
    const featMean = Array.isArray(p?.feat_mean) ? p.feat_mean : null;
    const featStd = Array.isArray(p?.feat_std) ? p.feat_std : null;
    const Vpca = Array.isArray(p?.V_pca) ? p.V_pca : null;
    const yMax = typeof p?.y_max === 'number' ? p.y_max : (Array.isArray(p?.y_max) ? Number(p.y_max[0]) : null);

    if (!featCols.length || !goodMask || !featMean || !featStd || !Vpca || !Number.isFinite(yMax)) {
        throw new Error('Preprocessing JSON missing feat_cols/good_mask/feat_mean/feat_std/V_pca/y_max.');
    }
    if (!w?.W1 || !w?.b1 || !w?.W2 || !w?.b2 || !w?.W3 || !w?.b3) {
        throw new Error('Weights JSON missing W1/b1/W2/b2/W3/b3.');
    }

    const Xfull = featCols.map((c) => {
        const v = feats[c];
        return Number.isFinite(v) ? v : 0;
    });

    const goodIdx = [];
    for (let i = 0; i < goodMask.length; i++) if (goodMask[i]) goodIdx.push(i);
    if (!goodIdx.length) throw new Error('good_mask selects 0 features.');

    const Xg = goodIdx.map((i) => Xfull[i] ?? 0);
    const mu = goodIdx.map((i) => featMean[i] ?? 0);
    const sd = goodIdx.map((i) => featStd[i] ?? 1);

    const Xsc = Xg.map((v, i) => (v - mu[i]) / ((sd[i] || 0) + 1e-8));

    // V_pca is expected to be [n_good x n_pca] (per training app.py)
    const nGood = Xsc.length;
    const nPca = Array.isArray(Vpca[0]) ? Vpca[0].length : 0;
    if (nPca <= 0) throw new Error('V_pca has invalid shape.');
    if (Vpca.length !== goodMask.length) {
        // Some exports may already be sliced; handle both.
        if (Vpca.length !== nGood) throw new Error(`V_pca rows (${Vpca.length}) mismatch good features (${nGood}).`);
    }

    const Vgood = (Vpca.length === nGood) ? Vpca : goodIdx.map((i) => Vpca[i]);

    const Xpca = new Array(nPca).fill(0);
    for (let j = 0; j < nPca; j++) {
        let s = 0;
        for (let i = 0; i < nGood; i++) {
            s += Xsc[i] * (Vgood[i][j] ?? 0);
        }
        Xpca[j] = s;
    }

    const raw = tf.tidy(() => {
        const x = tf.tensor2d([Xpca], [1, Xpca.length], 'float32');
        const W1 = tf.tensor2d(w.W1, undefined, 'float32');
        const b1 = tf.tensor1d(w.b1, 'float32');
        const W2 = tf.tensor2d(w.W2, undefined, 'float32');
        const b2 = tf.tensor1d(w.b2, 'float32');
        const W3 = tf.tensor2d(w.W3, undefined, 'float32');
        const b3 = tf.tensor1d(w.b3, 'float32');
        const a1 = tf.relu(tf.add(tf.matMul(x, W1), b1));
        const a2 = tf.relu(tf.add(tf.matMul(a1, W2), b2));
        const out = tf.add(tf.matMul(a2, W3), b3);
        return out.dataSync()[0];
    });

    const ppb = Math.max(0, Math.min(yMax, raw * yMax));
    return Math.round(ppb * 100) / 100;
}

