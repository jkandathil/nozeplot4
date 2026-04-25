/**
 * Quick checks for Monte Carlo helpers and trace math merge.
 */
import assert from 'node:assert/strict';
import { parseNetlist } from './src/circuit/netlist.js';
import { buildContext } from './src/circuit/solver.js';
import {
    buildMonteAcResult,
    runMonteAcSamples,
    buildMonteMetaFromRuns,
} from './src/circuit/monteCarlo.js';
import { mergeDerivedSignals } from './src/circuit/signalMath.js';

const netlist = `
V1 in 0 DC 0 AC 1 0
R1 in out 1k
C1 out 0 100n
.ac dec 5 10 100k
.end
`;

const parsed = parseNetlist(netlist);
assert.ok(parsed && !parsed.errors?.length);
const acDir = { kind: 'ac', mode: 'dec', n: 5, fStart: 10, fStop: 100e3 };

const runs = runMonteAcSamples(parsed, acDir, 8, 10);
assert.equal(runs.length, 8);
const ctx0 = buildContext(parsed);
const meta = { ...buildMonteMetaFromRuns(runs, parsed, 'out'), tolPercent: 10 };
const merged = buildMonteAcResult(runs, parsed, ctx0, meta);
assert.equal(merged.kind, 'ac');
assert.ok(merged.signals.some((s) => s.name === 'V(out)' && s.mag?.length));
assert.equal(merged.monte.runs, 8);

const sigOut = merged.signals.find((s) => s.name === 'V(out)');
const sigIn = merged.signals.find((s) => s.name === 'V(in)');
const withDerived = mergeDerivedSignals(merged, {
    enabled: true,
    op: 'minus',
    sigA: sigOut.name,
    sigB: sigIn.name,
});
const d = withDerived.signals.find((s) => s.derived);
assert.ok(d && d.kind === 'ac' && d.mag.length === sigOut.mag.length);

console.log('test-monte-trace-math: ok');
