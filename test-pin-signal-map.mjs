// Regression test: verifies that the pin-signal snapshot captured at
// simulation time survives a post-run edit to the schematic. This is
// what keeps the SCOPE modal working after the user drags a component
// (or the scope itself) after hitting Run.

import { DEMOS } from './src/circuit/demos.js';
import { resolveNets, componentPins, translateComponentRubber } from './src/circuit/schematicDoc.js';
import { importNetlistToDoc } from './src/circuit/importNetlist.js';

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }
function ok(msg)   { console.log('  ok:', msg); }

// Replicate the buildPinSignalMap helper from CircuitStudioPage.jsx.
function buildPinSignalMap(doc, nets) {
    const map = new Map();
    const labelFor = (nodeId) => {
        if (nodeId == null || nodeId === 0) return null;
        const lab = nets.nodeLabels?.get(nodeId);
        return (lab && !/^n\d+$/i.test(lab) && lab !== 'gnd') ? lab : `n${nodeId}`;
    };
    for (const c of doc.components) {
        if (c.elementType === 'GND') continue;
        for (const p of componentPins(c) || []) {
            const nid = nets.pinNode(c, p.id);
            const lab = labelFor(nid);
            if (lab) map.set(`${c.id}|${p.id}`, `V(${lab})`);
        }
    }
    return map;
}

const demo = DEMOS.find((d) => d.id === 'scope-rc');
const { doc } = importNetlistToDoc(demo.netlist);
demo.postImport?.(doc);

// Snapshot at "Run time".
const nets1 = resolveNets(doc);
const pinMap = buildPinSignalMap(doc, nets1);
const scope = doc.components.find((c) => c.elementType === 'SCOPE');
const originalSignal = pinMap.get(`${scope.id}|tip`);
console.log('[pin-map] scope.tip signal at run:', originalSignal);
if (originalSignal !== 'V(vout)') fail(`expected V(vout), got ${originalSignal}`);
ok('snapshot records V(vout) for scope.tip at run time');

// Now simulate the user dragging the scope AWAY from the vout node.
// In label-authoritative mode this detaches the tip (no label at new
// coord), so the CURRENT resolveNets can no longer produce a signal
// name for the tip.
translateComponentRubber(doc, scope.id, 60, 0);
const nets2 = resolveNets(doc);
const currentNode = nets2.pinNode(scope, 'tip');
console.log('[pin-map] scope.tip current nodeId after drag:', currentNode);
ok('scope was successfully moved (test scaffolding OK)');

// The old snapshot (pinMap) should still hold V(vout) — it's frozen at
// run time. The NEW resolveNets may return null / different / floating.
const stillSnap = pinMap.get(`${scope.id}|tip`);
if (stillSnap !== 'V(vout)') fail('snapshot was mutated by a downstream edit');
ok('pinSignalMap snapshot is immune to post-run edits');

// Replicate scopeSignalsFor (CH1 / CH2) with snapshot-fallback behavior.
function scopeSignalsFor(comp, nets, runResult) {
    const slots = [{ pin: 'tip', label: 'CH1' }, { pin: 'tip2', label: 'CH2' }];
    return {
        channels: slots.map(({ pin, label }) => {
            const pinKey = `${comp.id}|${pin}`;
            const snap = runResult?.pinSignalMap?.get(pinKey);
            if (snap) {
                const lab = snap.replace(/^V\((.*)\)$/, '$1');
                return { pin, label, signalName: snap, nodeLabel: lab };
            }
            const nodeId = nets.pinNode(comp, pin);
            if (nodeId == null || nodeId === 0) {
                return { pin, label, signalName: null, nodeLabel: null };
            }
            const lab = nets.nodeLabels?.get(nodeId);
            const nodeLabel = (lab && !/^n\d+$/i.test(lab) && lab !== 'gnd') ? lab : `n${nodeId}`;
            return { pin, label, signalName: `V(${nodeLabel})`, nodeLabel };
        }),
    };
}

const runResult = { pinSignalMap: pinMap };
const { channels } = scopeSignalsFor(scope, nets2, runResult);
const ch1 = channels.find((c) => c.pin === 'tip');
console.log('[pin-map] scope CH1 after drag ->', ch1);
if (ch1.signalName !== 'V(vout)') fail(`expected V(vout), got ${ch1.signalName}`);
ok('scope CH1 prefers the snapshot even after the doc was edited');

const { channels: chFloat } = scopeSignalsFor(scope, nets2, null);
const ch1b = chFloat.find((c) => c.pin === 'tip');
if (ch1b.signalName !== null) fail(`expected null CH1 fallback, got ${ch1b.signalName}`);
ok('without a snapshot, a detached scope CH1 falls back to the no-connection state');

console.log('\n[pin-signal-map] ALL OK');
