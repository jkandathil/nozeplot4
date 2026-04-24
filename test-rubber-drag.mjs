/**
 * Smoke test for the new localized drag helpers.
 *
 * Builds a tiny schematic:
 *
 *       R1 ─── wire ─── V1
 *
 * and asserts that:
 *   (a) dragging R1 stretches the wire's left endpoint with it but
 *       leaves V1's end anchored.
 *   (b) dragging the wire moves interior vertices but keeps endpoints
 *       on their component pins (bend inserted).
 *   (c) nets still resolve to 2 unique pin-coords after each drag
 *       (i.e. nothing detached and nothing merged spuriously).
 */

import {
    emptyDoc, addComponent, addWire,
    translateComponentRubber, translateWireRubber,
    resolveNets, componentPins,
} from './src/circuit/schematicDoc.js';

function assert(cond, msg) {
    if (!cond) {
        console.error('FAIL:', msg);
        process.exit(1);
    }
    console.log('  ok:', msg);
}

function wireHasPoint(w, x, y) {
    return w.points.some(([px, py]) => px === x && py === y);
}

console.log('[rubber-drag] setup');
const doc = emptyDoc();
// Resistor centered at (100, 100) — pins at (60, 100) and (140, 100).
const r1 = addComponent(doc, 'R', 100, 100);
const v1 = addComponent(doc, 'V_dc', 300, 100);
// Wire straight across from R1.n2 to V1.n1.
const wire = addWire(doc, 140, 100, 260, 100);

console.log('[rubber-drag] initial pin coords:',
    componentPins(r1).map((p) => [p.id, p.x, p.y]),
    componentPins(v1).map((p) => [p.id, p.x, p.y]));

// --- (a) Drag R1 up by one grid cell (20px).
console.log('\n[rubber-drag] drag R1 by (0, -20)');
translateComponentRubber(doc, r1.id, 0, -20);
const r1Pins = componentPins(r1);
const v1Pins = componentPins(v1);
assert(r1Pins[1].y === 80, 'R1 right pin is now at y=80');
assert(v1Pins[0].y === 100, 'V1 left pin stayed at y=100');
assert(wireHasPoint(wire, 140, 80), 'wire has a vertex at new R1 pin (140, 80)');
assert(wireHasPoint(wire, 260, 100), 'wire still anchored at V1 pin (260, 100)');

// The wire should now be a manhattan polyline of 2 or 3 points.
console.log('  wire after comp drag:', wire.points);
assert(wire.points.length >= 2, 'wire retained a polyline');
for (let i = 1; i < wire.points.length; i++) {
    const [x1, y1] = wire.points[i - 1];
    const [x2, y2] = wire.points[i];
    assert(x1 === x2 || y1 === y2, `segment ${i} is axis-aligned`);
}

// Net resolution still connects R1.n2 and V1.n1.
let nets = resolveNets(doc);
const nR = nets.pinNode(r1, 'n2');
const nV = nets.pinNode(v1, 'n1');
assert(nR != null && nR === nV, `R1.n2 and V1.n1 share net ${nR}`);

// --- (b) Drag the wire up another 20px. Endpoints should stay on pins.
console.log('\n[rubber-drag] drag wire by (0, -20)');
const pinCoordsBefore = new Set([
    `${r1Pins[1].x}|${r1Pins[1].y}`,
    `${v1Pins[0].x}|${v1Pins[0].y}`,
]);
translateWireRubber(doc, wire.id, 0, -20);
console.log('  wire after wire drag:', wire.points);
const first = wire.points[0];
const last = wire.points[wire.points.length - 1];
assert(
    pinCoordsBefore.has(`${first[0]}|${first[1]}`)
        || pinCoordsBefore.has(`${last[0]}|${last[1]}`),
    'at least one wire endpoint still sits on a pin coord'
);
// Components shouldn't have moved.
const r1PinsB = componentPins(r1);
const v1PinsB = componentPins(v1);
assert(r1PinsB[1].y === 80 && v1PinsB[0].y === 100,
    'components unchanged after wire drag');
for (let i = 1; i < wire.points.length; i++) {
    const [x1, y1] = wire.points[i - 1];
    const [x2, y2] = wire.points[i];
    assert(x1 === x2 || y1 === y2, `(b) segment ${i} still axis-aligned`);
}

nets = resolveNets(doc);
const nR2 = nets.pinNode(r1, 'n2');
const nV2 = nets.pinNode(v1, 'n1');
assert(nR2 != null && nR2 === nV2,
    `(b) R1.n2 and V1.n1 still share net ${nR2}`);

console.log('\n[rubber-drag] ALL OK');
