/**
 * Phase 2 solver smoke test. Runs a handful of tiny canonical circuits
 * and prints operating points so I can eyeball whether BJT / MOSFET /
 * zener / .step behaviour is in the right ballpark.
 */

import { parseNetlist } from './src/circuit/netlist.js';
import { buildContext, solveDC, solveTran, solveAC, runWithStep, setElementValue } from './src/circuit/solver.js';

function fmt(v) {
    if (!Number.isFinite(v)) return String(v);
    if (Math.abs(v) < 1e-3 && v !== 0) return v.toExponential(3);
    return v.toFixed(6);
}

function dumpOP(parsed, dc, label) {
    console.log(`\n---- ${label} ----`);
    for (let i = 1; i < parsed.nNodes; i++) {
        console.log(`  V(${parsed.nodeNames[i]}) = ${fmt(dc.x[i - 1])}`);
    }
}

// ---- Test 1: common-emitter BJT DC bias ----
const tia1 = `
* Simple CE NPN amp: should have Vc ~ 8 V, Vb ~ 0.7 V, Ve ~ 0 V (ish)
Vcc vcc 0 12
Rc  vcc vc 4.7k
Rb  vcc vb 470k
Q1  vc vb 0 QNPN
.model QNPN NPN(Is=1e-15 Bf=200)
.op
.end
`;
{
    const p = parseNetlist(tia1);
    if (p.errors.length) console.log('parse errors:', p.errors);
    const ctx = buildContext(p);
    const dc = solveDC(ctx);
    dumpOP(p, dc, 'CE NPN bias (expect Vb~0.7, Vc falls below Vcc by Ic·Rc)');
    console.log(`  DC iterations: ${dc.iters}`);
}

// ---- Test 2: NMOS diode-connected ----
const nmos1 = `
* Diode-connected NMOS: gate tied to drain, Vgs = Vds
Vdd vdd 0 5
R1  vdd vd 10k
M1  vd vd 0 0 MN W=10u L=1u
.model MN NMOS(Vto=1 Kp=200u Lambda=0)
.op
.end
`;
{
    const p = parseNetlist(nmos1);
    if (p.errors.length) console.log('parse errors:', p.errors);
    const ctx = buildContext(p);
    const dc = solveDC(ctx);
    dumpOP(p, dc, 'NMOS diode-connected (expect Vd ~1.5-2 V depending on bias)');
    console.log(`  DC iterations: ${dc.iters}`);
}

// ---- Test 3: Zener DC ----
const zener1 = `
* Zener reference: shunt regulator
Vin vin 0 12
R1 vin vout 1k
D1 0 vout ZD
.model ZD D(Is=1e-14 BV=5.1 Ibv=1e-3)
.op
.end
`;
{
    const p = parseNetlist(zener1);
    if (p.errors.length) console.log('parse errors:', p.errors);
    const ctx = buildContext(p);
    const dc = solveDC(ctx);
    dumpOP(p, dc, 'Zener 5.1V regulator (expect Vout ~ 5.1 V)');
    console.log(`  DC iterations: ${dc.iters}`);
}

// ---- Test 4: .step sweep ----
const step1 = `
* RC voltage divider — sweep R1
V1 vin 0 10
R1 vin vout 1k
R2 vout 0 1k
.op
.step R1 1k 5k 1k
.end
`;
{
    const p = parseNetlist(step1);
    const stepDir = p.directives.find((d) => d.kind === 'step');
    console.log(`\n---- .step R1 sweep (5 runs, Vout should fall from 5 V toward 1.67 V) ----`);
    for (let v = stepDir.start; v <= stepDir.stop + 1e-9; v += stepDir.step) {
        const ctx = buildContext(p);
        setElementValue(ctx, 'R1', v);
        const dc = solveDC(ctx);
        const idx = p.nodeIndex('vout');
        console.log(`  R1 = ${v.toExponential(2)}  Vout = ${fmt(dc.x[idx - 1])}`);
    }
}

// ---- Test 5: Inverter VTC (NMOS + PMOS) ----
const inv = `
* CMOS inverter: sweep Vin, observe Vout
Vdd vdd 0 3.3
Vin vin 0 0
M1 vout vin 0   0   MN
M2 vout vin vdd vdd MP
.model MN NMOS(Vto=0.5 Kp=200u Lambda=0.02)
.model MP PMOS(Vto=-0.5 Kp=100u Lambda=0.02)
.op
.end
`;
{
    const p = parseNetlist(inv);
    const vals = [0, 0.5, 1.0, 1.5, 1.65, 1.8, 2.5, 3.3];
    console.log('\n---- CMOS inverter Vin -> Vout sweep (should cross at ~Vdd/2) ----');
    for (const v of vals) {
        const ctx = buildContext(p);
        setElementValue(ctx, 'Vin', v);
        const dc = solveDC(ctx);
        const idx = p.nodeIndex('vout');
        console.log(`  Vin=${v.toFixed(2)}  Vout=${fmt(dc.x[idx - 1])}`);
    }
}

console.log('\nAll smoke tests completed without throwing.');
