/**
 * Run each Phase-2 demo through parse + DC op-point to make sure the
 * canned netlists survive the real parser/solver pipeline. We skip
 * AC/Tran here to keep this test fast; those are covered implicitly
 * by the solver's generic smoke-test (test-phase2.mjs).
 */
import { parseNetlist } from './src/circuit/netlist.js';
import { buildContext, solveDC, solveTran, solveAC } from './src/circuit/solver.js';
import { DEMOS } from './src/circuit/demos.js';

for (const d of DEMOS) {
    console.log(`\n====  ${d.id}  ====`);
    const p = parseNetlist(d.netlist);
    if (p.errors.length) {
        console.log('  PARSE ERRORS:', p.errors);
        continue;
    }
    if (p.warnings.length) console.log('  warnings:', p.warnings);
    const ctx = buildContext(p);
    try {
        const dc = solveDC(ctx);
        console.log(`  DC OK (${dc.iters} iter)`);
        for (let i = 1; i < p.nNodes; i++) {
            console.log(`    V(${p.nodeNames[i]}) = ${dc.x[i - 1].toFixed(4)}`);
        }
    } catch (err) {
        console.log(`  DC FAILED: ${err.message}`);
        continue;
    }
    const tranDir = p.directives.find((d2) => d2.kind === 'tran');
    if (tranDir && d.id === 'astable') {
        // Only run transient for astable (it's the interesting one)
        try {
            const tr = solveTran(ctx, tranDir);
            console.log(`  Tran OK: ${tr.t.length} samples, t[last]=${tr.t[tr.t.length - 1].toFixed(3)}s`);
            const c1 = p.nodeIndex('c1') - 1;
            let minV = Infinity, maxV = -Infinity;
            for (let k = 0; k < tr.nodeV[c1].length; k++) {
                if (tr.nodeV[c1][k] < minV) minV = tr.nodeV[c1][k];
                if (tr.nodeV[c1][k] > maxV) maxV = tr.nodeV[c1][k];
            }
            console.log(`    V(c1): ${minV.toFixed(3)} → ${maxV.toFixed(3)} V  (should oscillate ~0 to ~5 V)`);
        } catch (err) {
            console.log(`  Tran FAILED: ${err.message}`);
        }
    }
    const acDir = p.directives.find((d2) => d2.kind === 'ac');
    if (acDir && d.id === 'ce-bjt-amp') {
        try {
            const ac = solveAC(ctx, acDir);
            const idx = p.nodeIndex('vout') - 1;
            // Find max gain magnitude in the sweep
            let maxMag = 0, maxF = 0;
            for (let k = 0; k < ac.freqs.length; k++) {
                const re = ac.V[idx][k].re;
                const im = ac.V[idx][k].im;
                const m = Math.hypot(re, im);
                if (m > maxMag) { maxMag = m; maxF = ac.freqs[k]; }
            }
            console.log(`  AC OK: peak |V(vout)| = ${maxMag.toFixed(2)} at f=${maxF.toExponential(2)} Hz`);
            console.log(`    (expected mid-band gain ≈ gm·Rc||RL, should be > 50 with Ce active)`);
        } catch (err) {
            console.log(`  AC FAILED: ${err.message}`);
        }
    }
}

console.log('\nAll demos exercised.');
