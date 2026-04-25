// Thermal AC noise: solver PSD is finite and scales sensibly with R.
import assert from 'node:assert/strict';
import { parseNetlist } from './src/circuit/netlist.js';
import { buildContext, runWithStep, solveAcThermalNoisePSD } from './src/circuit/solver.js';

const KB = 1.380649e-23;
const T = 300;

const net = `
Vin 1 0 DC 5 AC 0 0
R1 1 vout 1k
R2 vout 0 1k
.ac lin 5 1 100
.end
`;
const parsed = parseNetlist(net);
assert.equal(parsed.errors.length, 0);
const ctx = buildContext(parsed);
const acDir = parsed.directives.find((d) => d.kind === 'ac');

const n1 = solveAcThermalNoisePSD(ctx, acDir, 'vout', { tempK: T });
assert.equal(n1.freqs.length, 5);
assert.ok(Number.isFinite(n1.noiseV2PerHz[0]) && n1.noiseV2PerHz[0] > 0, 'PSD > 0');
assert.equal(n1.outputNode.toLowerCase(), 'vout');

// Same topology with larger R → larger output noise (fewer A²/Hz from each R, but |H|² grows).
const netHi = `
Vin 1 0 DC 5 AC 0 0
R1 1 vout 10k
R2 vout 0 10k
.ac lin 3 10 10
.end
`;
const p2 = parseNetlist(netHi);
const c2 = buildContext(p2);
const d2 = p2.directives.find((d) => d.kind === 'ac');
const nLoR = solveAcThermalNoisePSD(ctx, acDir, 'vout', { tempK: T }).noiseV2PerHz[0];
const nHiR = solveAcThermalNoisePSD(c2, d2, 'vout', { tempK: T }).noiseV2PerHz[0];
assert.ok(nHiR > nLoR * 2, `expected larger R to increase output PSD (${nLoR} vs ${nHiR})`);

// runWithStep attaches acNoise when requested
const runs = runWithStep(ctx, null, { ac: acDir, acNoise: { outputNode: 'vout', tempK: T } });
assert.ok(runs[0].acNoise?.noiseV2PerHz?.length === runs[0].ac.freqs.length);
assert.ok(runs[0].acNoise.outputNode);

// White check: two equal resistors to mid-rail → ~ kT/R_total for Vout PSD at DC of small network
// (same as two equal R noise contributions to a floating node split).
const sv = n1.noiseV2PerHz[0];
const rpar = 500;
const approx = 4 * KB * T * rpar; // V^2/Hz for single R = rpar to ground at that node order-of-mag
assert.ok(Math.abs(sv - approx) / approx < 0.05, `PSD ${sv} vs ~4kTR ${approx}`);

console.log('test-ac-noise: OK');
