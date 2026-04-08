/**
 * Validates FeNOse synthetic generation: canonical phase order, ML feature extraction, phase resolution.
 * Run: npm run test:fenose-synth
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    generateSyntheticFenoseRows,
    resolveSyntheticPhaseCounts,
    SYNTH_DEFAULT_PHASE_COUNTS,
    inferWindowBeforeMeasurementFromRawData,
    medianTotalSynthableRowsFromFiles,
    mergeCalibration,
    computeEnvAuxFromFiles,
    FALLBACK_ENV_AUX,
} from '../src/utils/fenoseSyntheticDataset.js';
import { extractFenoseFeaturesFromRows } from '../src/utils/fenoseModel.js';

function phaseRunLengthNames(rows) {
    const out = [];
    for (const r of rows) {
        const e = r.event_name;
        if (!out.length || out[out.length - 1] !== e) out.push(e);
    }
    return out;
}

function countByEventName(rows) {
    const m = new Map();
    for (const r of rows) {
        const e = r.event_name;
        m.set(e, (m.get(e) || 0) + 1);
    }
    return m;
}

test('canonical default synthetic: phase order, counts, inference, features', () => {
    const rows = generateSyntheticFenoseRows({ ppb: 25, seed: 1 });
    assert.deepEqual(phaseRunLengthNames(rows), [
        'AmbientSamplingRFC',
        'BreathSampleCollection',
        'FeNOWindow',
        'FeNOMeasurement',
    ]);
    assert.equal(inferWindowBeforeMeasurementFromRawData(rows), true);

    const fb = SYNTH_DEFAULT_PHASE_COUNTS;
    const counts = countByEventName(rows);
    assert.equal(counts.get('AmbientSamplingRFC'), fb.nAmbient);
    assert.equal(counts.get('BreathSampleCollection'), fb.nBsc);
    assert.equal(counts.get('FeNOWindow'), fb.nWindow);
    assert.equal(counts.get('FeNOMeasurement'), fb.nFeno);

    const feats = extractFenoseFeaturesFromRows(rows);
    assert.ok(Number.isFinite(feats.d_A1));
    assert.ok(Number.isFinite(feats.nd_A1));
    assert.ok(Number.isFinite(feats.wd_A1));
    assert.ok(Number.isFinite(feats.ss_nd_A1));
    assert.equal(rows[0].target_ppb, 25);
});

test('non-canonical synthetic: FeNOMeasurement before FeNOWindow', () => {
    const rows = generateSyntheticFenoseRows({
        ppb: 10,
        seed: 2,
        windowBeforeMeasurement: false,
        nAmbient: 20,
        nBsc: 10,
        nFeno: 30,
        nWindow: 8,
    });
    assert.deepEqual(phaseRunLengthNames(rows), [
        'AmbientSamplingRFC',
        'BreathSampleCollection',
        'FeNOMeasurement',
        'FeNOWindow',
    ]);
    assert.equal(inferWindowBeforeMeasurementFromRawData(rows), false);
    const feats = extractFenoseFeaturesFromRows(rows);
    assert.ok(Number.isFinite(feats.d_A1));
});

function makeCanonicalCapture(nA, nB, nW, nF) {
    const d = [];
    const row = (ev) => ({ event_name: ev, A1: 500 });
    for (let i = 0; i < nA; i++) d.push(row('AmbientSamplingRFC'));
    for (let i = 0; i < nB; i++) d.push(row('BreathSampleCollection'));
    for (let i = 0; i < nW; i++) d.push(row('FeNOWindow'));
    for (let i = 0; i < nF; i++) d.push(row('FeNOMeasurement'));
    return { data: d };
}

test('median batch total and reconcile synthetic phase sum', () => {
    const f1 = makeCanonicalCapture(40, 10, 12, 60); // 122
    const f2 = makeCanonicalCapture(40, 10, 12, 72); // 134
    assert.equal(medianTotalSynthableRowsFromFiles([f1, f2]), 128);
    const p = resolveSyntheticPhaseCounts([f1, f2], null, {});
    assert.equal(p.nAmbient + p.nBsc + p.nFeno + p.nWindow, 128);
    const rows = generateSyntheticFenoseRows({
        ppb: 25,
        seed: 3,
        nAmbient: p.nAmbient,
        nBsc: p.nBsc,
        nFeno: p.nFeno,
        nWindow: p.nWindow,
        windowBeforeMeasurement: p.windowBeforeMeasurement,
    });
    assert.equal(rows.length, 128);
});

test('explicit phase opts skip batch total reconciliation', () => {
    const f1 = makeCanonicalCapture(40, 10, 12, 60);
    const f2 = makeCanonicalCapture(40, 10, 12, 72);
    const p = resolveSyntheticPhaseCounts([f1, f2], null, { nFeno: 50 });
    assert.equal(p.nFeno, 50);
});

test('resolveSyntheticPhaseCounts empty input uses SYNTH_DEFAULT_PHASE_COUNTS', () => {
    const p = resolveSyntheticPhaseCounts([], null, {});
    const fb = SYNTH_DEFAULT_PHASE_COUNTS;
    assert.equal(p.windowBeforeMeasurement, fb.windowBeforeMeasurement);
    assert.equal(p.nAmbient, fb.nAmbient);
    assert.equal(p.nBsc, fb.nBsc);
    assert.equal(p.nFeno, fb.nFeno);
    assert.equal(p.nWindow, fb.nWindow);
});

test('mergeCalibration attaches envAux for synthetic environmental aux', () => {
    const m = mergeCalibration(null, null);
    assert.ok(m.envAux);
    assert.equal(m.envAux.rfc_aqt_mean, FALLBACK_ENV_AUX.rfc_aqt_mean);
});

test('computeEnvAuxFromFiles learns aux from batch with AQT0/AQH0/AQP0', () => {
    const mk = (ppb, tRoom, hRoom, pRoom, dT, dH, dP) => {
        const d = [];
        const row = (ev, t, h, p) => ({ event_name: ev, A1: 600, AQT0: t, AQH0: h, AQP0: p });
        for (let i = 0; i < 20; i++) d.push(row('AmbientSamplingRFC', tRoom, hRoom, pRoom));
        for (let i = 0; i < 15; i++) d.push(row('BreathSampleCollection', tRoom + dT, hRoom + dH, pRoom + dP));
        for (let i = 0; i < 8; i++) d.push(row('FeNOWindow', tRoom + dT * 0.9, hRoom + dH * 0.9, pRoom + dP));
        for (let i = 0; i < 40; i++) d.push(row('FeNOMeasurement', tRoom + dT, hRoom + dH, pRoom + dP));
        return { fileName: `s_${ppb}ppb.csv`, data: d };
    };
    const f1 = mk(0, 23, 40, 985, 9, 32, 0.5);
    const f2 = mk(25, 24, 42, 988, 11, 30, -0.2);
    const env = computeEnvAuxFromFiles([f1, f2]);
    assert.ok(env);
    assert.ok(Math.abs(env.breath_delta_aqt_mean - 10) < 2);
    const rows = generateSyntheticFenoseRows({
        ppb: 10,
        seed: 7,
        nAmbient: 20,
        nBsc: 10,
        nFeno: 25,
        nWindow: 8,
        calibration: mergeCalibration({ envAux: env }, null),
    });
    const rfc = rows.filter((r) => r.event_name === 'AmbientSamplingRFC');
    const aqts = rfc.map((r) => r.AQT0);
    const m = aqts.reduce((a, b) => a + b, 0) / aqts.length;
    assert.ok(Math.abs(m - env.rfc_aqt_mean) < 2.5);
});

test('zero ppb synthetic still yields valid features', () => {
    const rows = generateSyntheticFenoseRows({ ppb: 0, seed: 99 });
    const feats = extractFenoseFeaturesFromRows(rows);
    assert.ok(Number.isFinite(feats.ss_nd_mean));
});
