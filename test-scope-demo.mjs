/**
 * Full-pipeline test of the new scope-rc demo:
 *   1. Grab the demo record.
 *   2. Run importNetlistToDoc + postImport (what CircuitStudioPage
 *      does when you click the demo tile).
 *   3. Verify SCOPE is present and its tip resolves to 'vout'.
 *   4. Emit netlist, parse, run .tran, build step result.
 *   5. Assert V(vout) exists with non-trivial data.
 */

import { DEMOS } from './src/circuit/demos.js';
import { resolveNets } from './src/circuit/schematicDoc.js';
import { emitNetlist } from './src/circuit/emitNetlist.js';
import { importNetlistToDoc } from './src/circuit/importNetlist.js';
import { parseNetlist as parse } from './src/circuit/netlist.js';
import { buildContext, runWithStep } from './src/circuit/solver.js';

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }
function ok(msg)   { console.log('  ok:', msg); }

const demo = DEMOS.find((d) => d.id === 'scope-rc');
if (!demo) fail('scope-rc demo is not registered');
ok('scope-rc demo exists');

const { doc } = importNetlistToDoc(demo.netlist);
if (typeof demo.postImport === 'function') demo.postImport(doc);
ok('demo imported and postImport ran');

const scope = doc.components.find((c) => c.elementType === 'SCOPE');
if (!scope) fail('SCOPE was not added by postImport');
ok(`SCOPE placed at ${JSON.stringify(scope.pos)} ref=${scope.ref}`);

const nets = resolveNets(doc);
const scopeNodeId = nets.pinNode(scope, 'tip');
const scopeNodeLabel = nets.nodeLabels?.get(scopeNodeId);
console.log('  scope tip → node id', scopeNodeId, 'label:', scopeNodeLabel);
if (scopeNodeLabel !== 'vout') fail(`scope is probing ${scopeNodeLabel}, expected vout`);
ok('scope tip is on the vout node');

const emit = emitNetlist(doc);
const parsed = parse(emit.text);
const ctx = buildContext(parsed);
const dir = parsed.directives.find((d) => d.kind === 'tran');
if (!dir) fail('no .tran directive parsed');
const runs = runWithStep(ctx, null, { tran: dir });
const res = runs[0].tran;
ok(`tran produced ${res.t.length} samples`);

// Replicate buildStepResult('tran', ...) just for V(vout).
const voutIdx = parsed.nodeNames.indexOf('vout');
if (voutIdx < 0) fail('parsed.nodeNames missing vout');
const y = res.nodeV[voutIdx - 1];
if (!y || y.length === 0) fail('V(vout) y[] is empty');
const ymin = Math.min(...y), ymax = Math.max(...y);
console.log('  V(vout) range:', ymin.toFixed(4), '..', ymax.toFixed(4));
if (ymax - ymin < 0.1) fail('V(vout) barely moves — something is wrong');
ok('V(vout) has a visible pulse response');

console.log('\n[scope-demo] full pipeline OK');
