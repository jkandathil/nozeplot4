// Smoke-test the .step family-of-curves wiring end-to-end:
// parse → buildContext → runWithStep → check multiple runs come back.

import { parseNetlist } from './src/circuit/netlist.js';
import { buildContext, runWithStep } from './src/circuit/solver.js';

function check(label, cond, detail = '') {
    const tag = cond ? 'OK  ' : 'FAIL';
    console.log(`  ${tag}  ${label}${detail ? ' — ' + detail : ''}`);
    if (!cond) process.exitCode = 1;
}

// --- Test 1: .step on a resistor in a divider ---
{
    const nl = `* R divider with stepped R2
V1 vin 0 5
R1 vin vout 1k
R2 vout 0 1k
.step R2 500 2500 500
.op
.end`;
    const parsed = parseNetlist(nl);
    const stepDir = parsed.directives.find((d) => d.kind === 'step');
    check('.step directive parsed', !!stepDir, JSON.stringify(stepDir));

    const ctx = buildContext(parsed);
    const runs = runWithStep(ctx, stepDir, { op: {} });
    check('produces 5 runs (500..2500 step 500)', runs.length === 5);
    for (const r of runs) {
        check(`  run @R2=${r.stepValue} converged`, r.op?.converged === true);
    }
    const voutIdx = parsed.nodeNames.indexOf('vout') - 1;
    console.log('\n  Family of Vout values:');
    for (const r of runs) {
        console.log(`    R2=${r.stepValue}Ω  →  V(vout) = ${r.op.x[voutIdx].toFixed(4)} V`);
    }
}

// --- Test 2: .step on a capacitor in an RC filter, AC sweep ---
{
    const nl = `* RC low-pass with stepped C
V1 vin 0 AC 1
R1 vin vout 1k
C1 vout 0 100n
.step C1 10n 1u 100n
.ac dec 10 10 1meg
.end`;
    const parsed = parseNetlist(nl);
    const stepDir = parsed.directives.find((d) => d.kind === 'step');
    const acDir   = parsed.directives.find((d) => d.kind === 'ac');
    const ctx = buildContext(parsed);
    const runs = runWithStep(ctx, stepDir, { ac: acDir });
    check('AC family produced', runs.length > 1, `${runs.length} runs`);
    check('each run has frequency sweep', runs.every((r) => r.ac.freqs.length > 0));

    // Corner frequency should scale inversely with C — eyeball a couple.
    console.log('\n  Family of AC sweeps:');
    const voutIdx = parsed.nodeNames.indexOf('vout') - 1;
    for (const r of runs) {
        const freqs = r.ac.freqs;
        const vs = r.ac.V[voutIdx];
        // Find -3 dB point
        const peak = Math.max(...vs.map((s) => Math.hypot(s.re, s.im)));
        const target = peak / Math.SQRT2;
        let f3dB = null;
        for (let i = 1; i < vs.length; i++) {
            const m0 = Math.hypot(vs[i - 1].re, vs[i - 1].im);
            const m1 = Math.hypot(vs[i].re, vs[i].im);
            if (m0 >= target && m1 < target) { f3dB = freqs[i]; break; }
        }
        console.log(`    C1=${(r.stepValue * 1e9).toFixed(0)}nF  →  f_-3dB ≈ ${f3dB?.toFixed(0) ?? 'n/a'} Hz (theory: ${(1 / (2 * Math.PI * 1e3 * r.stepValue)).toFixed(0)} Hz)`);
    }
}

console.log('\nDone.');
