/**
 * Wire tool stamps invisible labels at endpoints. Those labels must not
 * force label-only net resolution (wires ignored) on hand-built docs.
 */
import assert from 'node:assert/strict';
import {
    emptyDoc,
    addComponent,
    addWirePath,
    addLabel,
    resolveNets,
    componentPins,
} from './src/circuit/schematicDoc.js';
import { importNetlistToDoc } from './src/circuit/importNetlist.js';
import { buildPcbBridgePayload } from './src/pcb/schematicBridge.js';

{
    const d = emptyDoc();
    const r1 = addComponent(d, 'R', 100, 100, 0);
    const r2 = addComponent(d, 'R', 300, 100, 0);
    const p1 = componentPins(r1).find((p) => p.id === 'n2');
    const p2 = componentPins(r2).find((p) => p.id === 'n1');
    addWirePath(d, [[p1.x, p1.y], [p2.x, p2.y]]);
    addLabel(d, p1.x, p1.y, 'n_auto', false);
    addLabel(d, p2.x, p2.y, 'n_auto', false);
    assert.equal(d.meta.labelNetAuthority, false);
    const nets = resolveNets(d);
    const na = nets.pinNode(r1, 'n2');
    const nb = nets.pinNode(r2, 'n1');
    assert.equal(na, nb, 'wire + endpoint labels: pins must share one net');
    // Unwired ends of the two resistors are still floating — expected.
    assert.equal(nets.floatingPins.length, 2);
}

{
    const { doc } = importNetlistToDoc(`*t
V1 1 0 DC 1
R1 1 0 1k
.end`);
    assert.equal(doc.meta.labelNetAuthority, true);
    const nets = resolveNets(doc);
    assert.ok(nets.pinNode(doc.components.find((c) => c.ref === 'V1'), 'n1') != null);
}

// PCB bridge: missing pinNode must not be coerced to GND net '0' (regression).
{
    const d = emptyDoc();
    addComponent(d, 'R', 10, 10, 0);
    const nets = {
        pinNode: (_c, pinId) => (pinId === 'n1' ? undefined : 5),
        nodeLabels: new Map([[5, 'sig']]),
    };
    const bp = buildPcbBridgePayload(d, nets);
    const rPl = bp.placements.find((p) => p.ref === 'R1');
    assert.ok(rPl);
    assert.equal(rPl.padNets['1'], undefined);
    assert.equal(rPl.padNets['2'], 'sig');
    const netsGnd = {
        pinNode: () => 0,
        nodeLabels: new Map([[0, 'gnd']]),
    };
    const bp2 = buildPcbBridgePayload(d, netsGnd);
    const r2 = bp2.placements.find((p) => p.ref === 'R1');
    assert.equal(r2.padNets['1'], '0');
    assert.equal(r2.padNets['2'], '0');
}

console.log('✓ net-resolution authority (hand-built vs import) OK');
