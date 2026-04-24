import assert from 'node:assert/strict';
import { parseNetlist } from './src/circuit/netlist.js';
import { findStructuralDcDisconnectedSpiceNodes } from './src/circuit/dcDiagnostics.js';

// Two-node island linked only by capacitors — no DC path to ground.
const netCapIsland = `
V1 1 0 DC 1
C1 1 2 1u
C2 2 0 1u
.end
`;
{
    const p = parseNetlist(netCapIsland);
    assert.equal(p.errors.length, 0);
    const bad = findStructuralDcDisconnectedSpiceNodes(p);
    assert.ok(bad.includes(2) && !bad.includes(1), `only node 2 is a pure-cap island; got ${bad}`);
}

// Same but resistor also ties node 2 to ground path through R — OK.
const netRdcPath = `
V1 1 0 DC 1
R1 1 2 1k
R2 2 0 10k
C1 2 0 1u
.end
`;
{
    const p = parseNetlist(netRdcPath);
    assert.equal(p.errors.length, 0);
    const bad = findStructuralDcDisconnectedSpiceNodes(p);
    assert.equal(bad.length, 0, `expected no DC islands, got ${bad}`);
}

// Current source does not short its pins at DC — node on one side can float.
const netIopen = `
I1 1 0 DC 1m
R1 1 0 1k
.end
`;
{
    const p = parseNetlist(netIopen);
    assert.equal(p.errors.length, 0);
    const bad = findStructuralDcDisconnectedSpiceNodes(p);
    assert.equal(bad.length, 0, 'I1 n+ connects through R1 to ground');
}

console.log('✓ dc-diagnostics structural checks OK');
