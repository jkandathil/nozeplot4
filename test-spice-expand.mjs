import assert from 'node:assert/strict';
import { parseNetlist } from './src/circuit/netlist.js';
import { expandSpiceForParse } from './src/circuit/spiceExpand.js';

// ---------- .include merges library text ----------
const lib = `
.model MYD D(Is=1e-15 N=1)
`;
const main = `
.include "models.inc"
D1 a 0 MYD
.op
.end
`;
const p = parseNetlist(main, { includeFiles: { 'models.inc': lib } });
assert.equal(p.errors.length, 0, p.errors.join('; '));
assert.ok(p.models.myd, 'model from include');

// ---------- .subckt + X flatten ----------
const hier = `
.subckt resdiv in out ref
R1 in out 1k
R2 out ref 2k
.ends
Vin in ref DC 3
XU1 in vout ref resdiv
.op
.end
`;
const p2 = parseNetlist(hier, {});
assert.equal(p2.errors.length, 0, p2.errors.join('; '));
assert.equal(p2.elements.filter((e) => e.type === 'R').length, 2, 'X expanded to two resistors');
assert.equal(p2.elements.filter((e) => e.type === 'V').length, 1);

// ---------- missing include ----------
const bad = parseNetlist('.include "ghost.inc"\n.end', { includeFiles: {} });
assert.ok(bad.errors.length > 0, 'expected error for missing include');

// ---------- expandSpiceForParse API ----------
const ex = expandSpiceForParse('*t\n.include "a"\n.subckt z a b\nR1 a b 1\n.ends', { a: 'Rdummy x y 1\n' });
assert.ok(ex.text.includes('Rdummy'));
assert.equal(ex.errors.length, 0);

console.log('test-spice-expand: OK');
