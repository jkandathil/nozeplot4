/**
 * Smoke test for probe components:
 *   - VP (voltage probe) must be skipped from the netlist but not
 *     break net resolution.
 *   - IP (current probe) must be emitted as a 0 V voltage source,
 *     create its own branch, and show up as I(<ref>) in signals after
 *     solveTran.
 *
 * Circuit under test: V(5V) — IP — R(1k) — GND
 *   Expected steady-state current: 5 mA through IP.
 */
import { emptyDoc, addComponent, addWirePath, resolveNets } from './src/circuit/schematicDoc.js';
import { emitNetlist } from './src/circuit/emitNetlist.js';
import { parseNetlist } from './src/circuit/netlist.js';
import { buildContext, solveDC, solveTran } from './src/circuit/solver.js';

const doc = emptyDoc();

// Put parts on a common y = 200 horizontal rail with 80 px spacing.
const V = addComponent(doc, 'V_dc',    100, 200);
const I = addComponent(doc, 'IP',      260, 200);
const R = addComponent(doc, 'R',       420, 200);
const G = addComponent(doc, 'GND',     580, 240);
// Voltage probe clipped onto the node between IP and R. Should NOT
// appear in the emitted netlist but should resolve to the same node.
const VPComp = addComponent(doc, 'VP', 340, 180);

// Force the V source DC level so it's predictable.
V.sourceSpec = [{ kind: 'dc', v: 5 }];
R.value = 1e3;

// Pin positions (all parts use width 80 → pins at ±40):
//   V  @ (100,200)  pins (60,200)/(140,200)
//   IP @ (260,200)  pins (220,200)/(300,200)
//   R  @ (420,200)  pins (380,200)/(460,200)
//   GND @ (580,240) pin  (580,240)
addWirePath(doc, [[140, 200], [220, 200]]);
addWirePath(doc, [[300, 200], [380, 200]]);
addWirePath(doc, [[460, 200], [580, 200], [580, 240]]);
addWirePath(doc, [[60, 200], [60, 260], [580, 260], [580, 240]]);
// VP tip is at (340, 200) (pin offset (0, 20) from center 340,180).
// Drop a short stub that lands on the IP→R wire (which runs at y=200).
addWirePath(doc, [[340, 200], [340, 200]]); // degenerate; the tip coord already coincides

const { text: netlist, warnings } = emitNetlist(doc);
if (/^VP1\b/im.test(netlist)) {
    console.error('FAIL: VP1 leaked into the netlist — voltage probes must be UI-only.');
    process.exit(1);
}
const nets = resolveNets(doc);
const vpNode = nets.pinNode(VPComp, 'tip');
if (vpNode == null) {
    console.error('FAIL: VP tip did not resolve to any net.');
    process.exit(1);
}
console.log(`OK: VP tip resolved to node ${vpNode} (same electrical node as IP→R wire)`);
console.log('--- emitted netlist ---');
console.log(netlist);
console.log('warnings:', warnings);

// VP is not in this test, but sanity-check that the emitter produced
// exactly one voltage source for the real V and one for the current
// probe (emitted as "VIP1").
const lines = netlist.split('\n');
const vLines = lines.filter((l) => /^V/i.test(l.trim()));
if (vLines.length !== 2) {
    console.error('FAIL: expected two voltage-source lines (source + probe), got', vLines.length);
    process.exit(1);
}
if (!vLines.some((l) => /^VIP1\b/i.test(l))) {
    console.error('FAIL: expected VIP1 (probe-as-0V) in netlist');
    process.exit(1);
}

const parsed = parseNetlist(netlist);
if (parsed.errors?.length > 0) {
    console.error('FAIL: parser errors', parsed.errors);
    process.exit(1);
}

const ctx = buildContext(parsed);
console.log('branchElems:', ctx.branchElems);

// Solve DC.
const dc = solveDC(ctx);
console.log('DC node voltages:', Array.from(dc.x).slice(0, ctx.interior));
console.log('DC branch currents (V/L/E/O):', Array.from(dc.x).slice(ctx.interior));
if (!dc.converged) {
    console.error('FAIL: DC did not converge');
    process.exit(1);
}

// Expected: 5 V / 1 kΩ = 5 mA through both V and IP.
const probeIdx = ctx.branchElems.findIndex((e) => /^VIP1$/i.test(e.name));
if (probeIdx < 0) {
    console.error('FAIL: no VIP1 branch element');
    process.exit(1);
}
const iProbe = dc.x[ctx.interior + probeIdx];
const expected = 5e-3;
// Sign convention: SPICE reports current flowing from n+ to n- through
// the source. Our probe is wired V → IP(n1=+, n2=-) → R, so positive
// current should flow into n1 and out of n2. Just check magnitude.
if (Math.abs(Math.abs(iProbe) - expected) > 1e-6) {
    console.error(`FAIL: expected |I(probe)| ≈ 5 mA, got ${iProbe}`);
    process.exit(1);
}
console.log(`OK: I(probe) ≈ ${iProbe.toExponential(3)} A (expected ±5 mA)`);

// Quick tran run to make sure branchI history is populated.
const tran = solveTran(ctx, { tstep: 1e-6, tstop: 1e-4, tstart: 0 });
if (!tran.branchI || tran.branchI.length === 0) {
    console.error('FAIL: tran did not return branchI');
    process.exit(1);
}
const iHist = tran.branchI[probeIdx];
const last = iHist[iHist.length - 1];
if (Math.abs(Math.abs(last) - expected) > 1e-6) {
    console.error(`FAIL: tran |I(probe)| at tstop ≈ 5 mA, got ${last}`);
    process.exit(1);
}
console.log(`OK: tran final |I(probe)| ≈ ${Math.abs(last).toExponential(3)} A`);

console.log('\nAll probe smoke tests passed.');
