// Smoke test: verify that the PropertyPopup's source-spec helpers
// correctly round-trip pulse / sin / dc / ac waveforms through the
// normalise → edit → build pipeline. We import the helpers via a
// dynamic eval against the source file so we don't need to pull the
// React component tree at runtime.

import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(
    path.resolve('src/components/circuit/PropertyPopup.jsx'),
    'utf-8',
);

// Extract everything from SI_MAP declaration through the source-spec
// helpers (stopping right before modelChoicesFor). This pulls in
// parseSiValue, formatForEdit, and the new pulse/sin/dc helpers as a
// single contiguous block.
const start = src.indexOf('const SI_MAP');
const end   = src.indexOf('function modelChoicesFor');
const bundle = src.slice(start, end) +
    '\nexport { normaliseSpecs, buildWaveSpec, buildAcSpec, waveFieldDefs, defaultWaveFields };\n';

// Write to a tmp ESM file and import it.
const tmp = path.resolve('.tmp-pulse-helpers.mjs');
fs.writeFileSync(tmp, bundle);
const helpers = await import(tmp);
fs.unlinkSync(tmp);

function check(label, cond, extra = '') {
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ ${label} ${extra}`); process.exitCode = 1; }
}

console.log('normaliseSpecs — existing PULSE source:');
{
    const spec = [{ kind: 'pulse', v1: 0, v2: 5, td: 100e-6, tr: 1e-6, tf: 1e-6, pw: 500e-6, per: 2e-3 }];
    const n = helpers.normaliseSpecs(spec);
    check('picks pulse kind', n.waveKind === 'pulse');
    check('formats low',  n.waveFields.v1 === '0');
    check('formats high', n.waveFields.v2 === '5');
    check('formats delay (100u)', /^100u/.test(n.waveFields.td));
    check('formats width (500u)', /^500u/.test(n.waveFields.pw));
    check('formats period (2m)',  /^2m/.test(n.waveFields.per));
    check('no ac default', n.acMag === '' && n.acPhase === '');
}

console.log('normaliseSpecs — DC+AC source:');
{
    const spec = [{ kind: 'dc', v: 3.3 }, { kind: 'ac', mag: 1, phase: 90 }];
    const n = helpers.normaliseSpecs(spec);
    check('picks dc kind', n.waveKind === 'dc');
    check('dc level is 3.3', n.waveFields.v === '3.3');
    check('ac mag is 1', n.acMag === '1');
    check('ac phase is 90', n.acPhase === '90');
}

console.log('buildWaveSpec — pulse round trip:');
{
    const fields = { v1: '-5', v2: '5', td: '0', tr: '1u', tf: '1u', pw: '1m', per: '2m' };
    const s = helpers.buildWaveSpec('pulse', fields);
    check('kind=pulse', s.kind === 'pulse');
    check('negative v1 preserved (polarity swap)', s.v1 === -5);
    check('v2 = 5', s.v2 === 5);
    check('tr parsed to 1e-6', Math.abs(s.tr - 1e-6) < 1e-18);
    check('per parsed to 2e-3', Math.abs(s.per - 2e-3) < 1e-15);
}

console.log('buildWaveSpec — rejects missing required fields:');
{
    const s = helpers.buildWaveSpec('pulse', { v1: '0', v2: '5', pw: '', per: '' });
    check('returns null for missing pw/per', s === null);
}

console.log('buildWaveSpec — sine:');
{
    const fields = { vo: '0', va: '2.5', f: '1k', td: '', theta: '' };
    const s = helpers.buildWaveSpec('sin', fields);
    check('kind=sin', s.kind === 'sin');
    check('amplitude parsed', s.va === 2.5);
    check('frequency parsed (1k)', s.f === 1e3);
    check('defaults td to 0', s.td === 0);
    check('defaults theta to 0', s.theta === 0);
}

console.log('buildAcSpec:');
{
    const s = helpers.buildAcSpec('1', '180');
    check('kind=ac', s.kind === 'ac');
    check('mag=1, phase=180', s.mag === 1 && s.phase === 180);
    check('empty mag -> null', helpers.buildAcSpec('', '0') === null);
}

console.log('waveFieldDefs shape:');
{
    const pulse = helpers.waveFieldDefs('pulse', 'V');
    check('pulse has 7 fields', pulse.length === 7);
    check('pulse field keys', pulse[0][0] === 'v1' && pulse[6][0] === 'per');
    const ip = helpers.waveFieldDefs('pulse', 'I');
    check('current source shows A units', ip[0][1].includes('(A)'));
}

console.log('defaultWaveFields — current sources use mA defaults:');
{
    const dI = helpers.defaultWaveFields('pulse', true);
    check('current pulse v2 = 1m',  dI.v2 === '1m');
    const dV = helpers.defaultWaveFields('pulse', false);
    check('voltage pulse v2 = 5', dV.v2 === '5');
}

if (process.exitCode) console.log('\n✗ some assertions failed');
else console.log('\n✓ all pulse-editor assertions passed');
