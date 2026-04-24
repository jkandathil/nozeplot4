// Smoke test for findConnectedGroup + translateGroup.
// Build a tiny doc (V → R → C → GND all wired), drag R, confirm every
// connected element moves together and the net topology survives a
// round-trip through resolveNets().

import {
    emptyDoc, addComponent, addWirePath,
    componentPins, findConnectedGroup, translateGroup,
    resolveNets,
} from './src/circuit/schematicDoc.js';

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }
function pass(msg) { console.log('pass:', msg); }

const doc = emptyDoc();
const v = addComponent(doc, 'V_dc', 100, 200);
const r = addComponent(doc, 'R', 220, 160);
const c = addComponent(doc, 'C', 340, 200);
const g = addComponent(doc, 'GND', 100, 260);

// Wire V.+ → R.p1, R.p2 → C.p1, C.p2 → GND, V.- → GND.
function pin(comp, id) {
    const p = componentPins(comp).find((pp) => pp.id === id);
    if (!p) throw new Error(`pin ${id} not on ${comp.partId}`);
    return p;
}

addWirePath(doc, [[pin(v, 'n2').x, pin(v, 'n2').y], [pin(r, 'n1').x, pin(r, 'n1').y]]);
addWirePath(doc, [[pin(r, 'n2').x, pin(r, 'n2').y], [pin(c, 'n1').x, pin(c, 'n1').y]]);
addWirePath(doc, [[pin(c, 'n2').x, pin(c, 'n2').y], [pin(g, 'gnd').x, pin(g, 'gnd').y]]);
addWirePath(doc, [[pin(v, 'n1').x, pin(v, 'n1').y], [pin(g, 'gnd').x, pin(g, 'gnd').y]]);

const netsBefore = resolveNets(doc);
const nodeCountBefore = netsBefore.nodeCount;

// Seed on R — every component plus every wire should come along.
// (GND is intentionally excluded from the group so dragging doesn't
// uproot the ground symbol.)
const group = findConnectedGroup(doc, { kind: 'component', id: r.id });
console.log('group sizes:',
    'components=', group.componentIds.size,
    'wires=', group.wireIds.size,
    'labels=', group.labelIds.size,
);
console.log('pins:');
for (const comp of doc.components) {
    for (const p of componentPins(comp)) console.log(`  ${comp.partId}(${comp.id}).${p.id}: (${p.x}, ${p.y})`);
}
console.log('wires:');
for (const w of doc.wires) {
    console.log(`  ${w.id}: ${w.points.map((p) => `(${p[0]},${p[1]})`).join(' → ')} inGroup=${group.wireIds.has(w.id)}`);
}

if (!group.componentIds.has(v.id)) fail('V should be in R group (wired to it)');
if (!group.componentIds.has(r.id)) fail('R should be in its own group');
if (!group.componentIds.has(c.id)) fail('C should be in R group (wired to it)');
if (!group.componentIds.has(g.id)) fail('GND should be in R group (wired to it)');
if (group.wireIds.size !== 4) fail(`expected 4 wires in group, got ${group.wireIds.size}`);
pass('group membership correct');

// Snapshot positions + wire point sums for the move check.
const beforeR = { ...r.pos };
const beforeV = { ...v.pos };
const beforeC = { ...c.pos };
const wireSumBefore = doc.wires.reduce((s, w) => s + w.points.reduce((ss, [x, y]) => ss + x + y, 0), 0);

translateGroup(doc, group, 40, 20);

if (r.pos.x !== beforeR.x + 40 || r.pos.y !== beforeR.y + 20) fail('R did not move');
if (v.pos.x !== beforeV.x + 40 || v.pos.y !== beforeV.y + 20) fail('V did not move with R');
if (c.pos.x !== beforeC.x + 40 || c.pos.y !== beforeC.y + 20) fail('C did not move with R');
if (g.pos.x !== 100 + 40 || g.pos.y !== 260 + 20) fail(`GND should have moved with the circuit, got (${g.pos.x},${g.pos.y})`);
pass('positions shifted correctly (whole wired circuit moved together)');

// Wire point sums shifted by dx*N + dy*N for each vertex in the group.
const wireVertexCount = doc.wires.reduce((n, w) => n + w.points.length, 0);
const expectedDelta = (40 + 20) * wireVertexCount;
const wireSumAfter = doc.wires.reduce((s, w) => s + w.points.reduce((ss, [x, y]) => ss + x + y, 0), 0);
if (wireSumAfter - wireSumBefore !== expectedDelta) {
    fail(`wire sum shift ${wireSumAfter - wireSumBefore} !== expected ${expectedDelta}`);
}
pass('every wire point moved by the same (dx, dy)');

// Topology should survive the translate — same number of nodes.
const netsAfter = resolveNets(doc);
if (netsAfter.nodeCount !== nodeCountBefore) {
    fail(`node count changed: was ${nodeCountBefore}, now ${netsAfter.nodeCount} — connections broken!`);
}
pass(`net topology preserved (still ${netsAfter.nodeCount} nodes)`);

/* ---------------- second sub-circuit isolation ---------------- */
// Place another, unconnected R + GND far away. Dragging our circuit
// must not move them.
const doc2 = emptyDoc();
const r1 = addComponent(doc2, 'R', 120, 140);
const g1 = addComponent(doc2, 'GND', 120, 200);
addWirePath(doc2, [[pin(r1, 'n2').x, pin(r1, 'n2').y], [pin(g1, 'gnd').x, pin(g1, 'gnd').y]]);
const r2 = addComponent(doc2, 'R', 500, 140);
const g2 = addComponent(doc2, 'GND', 500, 200);
addWirePath(doc2, [[pin(r2, 'n2').x, pin(r2, 'n2').y], [pin(g2, 'gnd').x, pin(g2, 'gnd').y]]);

const isoGroup = findConnectedGroup(doc2, { kind: 'component', id: r1.id });
if (!isoGroup.componentIds.has(r1.id) || !isoGroup.componentIds.has(g1.id)) {
    fail('R1 group should contain its own GND');
}
if (isoGroup.componentIds.has(r2.id) || isoGroup.componentIds.has(g2.id)) {
    fail('R1 group should NOT contain the disconnected R2 / GND2');
}
pass('unrelated sub-circuit (incl. its GND) stays put');

console.log('\nAll group-drag assertions passed.');
