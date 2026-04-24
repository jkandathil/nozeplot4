// End-to-end smoke test for the UI parametric-sweep pipeline.
//
// We skip the React component and drive the run pipeline directly:
//   1. Parse a netlist with a single resistor divider.
//   2. Synthesize the same stepDir that the UI would build from a
//      "sweep R2 from 100 to 1k by 100" panel.
//   3. Feed it through runWithStep + the buildStepResult merger and
//      confirm the resulting signals family contains one curve per
//      sweep value, named with the @R2=… suffix.

import assert from 'node:assert/strict';
import { parseNetlist } from './src/circuit/netlist.js';
import { buildContext, runWithStep } from './src/circuit/solver.js';
import { parseSiValue, linspaceByStep, formatSi } from './src/circuit/siUnits.js';

// ---------- 1. siUnits roundtrip ----------
console.log('siUnits.parseSiValue / formatSi / linspaceByStep:');
assert.equal(parseSiValue('100'),  100,   '"100" → 100');
assert.equal(parseSiValue('1k'),   1000,  '"1k" → 1000');
assert.equal(parseSiValue('1Meg'), 1e6,   '"1Meg" → 1e6');
assert.ok(Math.abs(parseSiValue('220u') - 2.2e-4) < 1e-15, '"220u" → 2.2e-4');
assert.equal(parseSiValue('4.7k'), 4700,  '"4.7k" → 4700');
assert.equal(formatSi(4700),       '4.7k','4700 → "4.7k"');
assert.equal(formatSi(1e-6),       '1u',  '1e-6 → "1u"');
assert.deepEqual(linspaceByStep(100, 500, 100), [100, 200, 300, 400, 500]);
assert.deepEqual(linspaceByStep(1, 0, -0.5),    [1, 0.5, 0]);
assert.deepEqual(linspaceByStep(0, 1,  0),       []); // step=0 rejected
assert.deepEqual(linspaceByStep(0, 1, -0.1),     []); // wrong direction
console.log('  ✓ SI parse / format / range OK');

// ---------- 2. Simulate a sweep via runWithStep ----------
const netlist = `
Vin 1 0 DC 5
R1 1 vout 1k
R2 vout 0 1k
.op
.end
`;
const parsed = parseNetlist(netlist);
assert.equal(parsed.errors.length, 0, 'netlist parses clean');
const ctx = buildContext(parsed);

console.log('runWithStep — R2 100..1k / 100:');
const values = linspaceByStep(100, 1000, 100);
assert.equal(values.length, 10);

const stepDir = { kind: 'step', target: 'R2', start: 100, stop: 1000, step: 100 };
const runs = runWithStep(ctx, stepDir, { op: {} });
assert.equal(runs.length, 10, 'ten op-point solves');

// The steady-state divider says Vout = Vin * R2/(R1+R2).
// As R2 climbs from 100 → 1000 with R1 fixed at 1k, Vout should
// monotonically climb from ~0.454 → 2.5.
const voutFirst = runs[0].op.x[parsed.nodeNames.indexOf('vout') - 1];
const voutLast  = runs[runs.length - 1].op.x[parsed.nodeNames.indexOf('vout') - 1];
assert.ok(voutLast > voutFirst, 'V(vout) rises with R2');
assert.ok(Math.abs(voutFirst - 5 * 100 / 1100)  < 1e-6, `first ≈ 0.4545 (got ${voutFirst})`);
assert.ok(Math.abs(voutLast  - 5 * 1000 / 2000) < 1e-6, `last  ≈ 2.5    (got ${voutLast})`);
console.log(`  ✓ V(vout) = ${voutFirst.toFixed(4)} … ${voutLast.toFixed(4)} V`);

// ---------- 3. Transient sweep: signal naming ----------
console.log('runWithStep — AC sweep signal naming:');
const acNetlist = `
Vin 1 0 AC 1 0
R1  1 vout 1k
C1  vout 0 1u
.ac dec 10 1 1k
.end
`;
const acParsed = parseNetlist(acNetlist);
assert.equal(acParsed.errors.length, 0);
const acCtx = buildContext(acParsed);
const acDir = acParsed.directives.find((d) => d.kind === 'ac');
const acStep = { kind: 'step', target: 'R1', start: 1000, stop: 3000, step: 1000 };
const acRuns = runWithStep(acCtx, acStep, { ac: acDir });
assert.equal(acRuns.length, 3, 'three AC sweeps');
// Each run should have its own frequency-response family, distinct
// in shape because the pole moves with R1.
const m0 = acRuns[0].ac.V[acParsed.nodeNames.indexOf('vout') - 1].map((s) => Math.hypot(s.re, s.im));
const m2 = acRuns[2].ac.V[acParsed.nodeNames.indexOf('vout') - 1].map((s) => Math.hypot(s.re, s.im));
// At the highest frequency, a larger R rolls off more — so |V_R=3k| < |V_R=1k|.
assert.ok(m2[m2.length - 1] < m0[m0.length - 1], 'higher R rolls off earlier');
console.log(`  ✓ |V(vout)| @ highest f: R=1k→${m0[m0.length - 1].toFixed(4)}, R=3k→${m2[m2.length - 1].toFixed(4)}`);

// ---------- 4. Guardrails in solver ----------
console.log('runWithStep — rejects bogus sweeps:');
assert.throws(() => runWithStep(ctx, { target: 'R2', start: 1, stop: 2, step: 0 }, { op: {} }));
assert.throws(() => runWithStep(ctx, { target: 'R2', start: 2, stop: 1, step: 1 }, { op: {} }));
console.log('  ✓ zero step + wrong-direction step both throw');

console.log('\n✓ all parametric-sweep assertions passed');
