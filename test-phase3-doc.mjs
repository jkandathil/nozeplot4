import { DEMOS } from './src/circuit/demos.js';
import { importNetlistToDoc } from './src/circuit/importNetlist.js';
import { emitNetlist } from './src/circuit/emitNetlist.js';
import { parseNetlist } from './src/circuit/netlist.js';
import { buildContext, solveDC } from './src/circuit/solver.js';

let failures = 0;

function runOne(demo) {
    console.log('\n==== Demo:', demo.id, '—', demo.name, '====');
    const { doc, warnings } = importNetlistToDoc(demo.netlist);
    console.log('imported: components=%d wires=%d directives=%d',
        doc.components.length, doc.wires.length, doc.directives.length);
    if (warnings.length) console.log('  import warnings:', warnings);

    const out = emitNetlist(doc, { title: demo.name });
    if (out.warnings.length) console.log('  emit warnings:', out.warnings);

    try {
        const parsed = parseNetlist(out.text);
        const ctx = buildContext(parsed);
        const sol = solveDC(ctx);
        const origParsed = parseNetlist(demo.netlist);
        const origCtx = buildContext(origParsed);
        const origSol = solveDC(origCtx);
        const vA = Array.from(sol.v || []).map(x => +x.toFixed(4));
        const vB = Array.from(origSol.v || []).map(x => +x.toFixed(4));
        const sortedA = [...vA].sort();
        const sortedB = [...vB].sort();
        const match = sortedA.length === sortedB.length
            && sortedA.every((x, i) => Math.abs(x - sortedB[i]) < 1e-3);
        console.log(`  re-emit DC ok, nNodes=${ctx.nNodes} (orig=${origCtx.nNodes})  dc-match=${match}`);
        if (!match) {
            console.log('    orig V:', sortedB.slice(0, 10));
            console.log('    new  V:', sortedA.slice(0, 10));
            failures++;
        }
    } catch (err) {
        console.log('  !! re-emission failed:', err.message);
        console.log(out.text);
        failures++;
    }
}

const pickIds = ['rc-lp', 'tia', 'divider', 'ce-bjt-amp', 'cmos-inverter'];
for (const id of pickIds) {
    const d = DEMOS.find(x => x.id === id);
    if (d) runOne(d);
}

console.log('\n--- Tests complete. failures =', failures, '---');
process.exit(failures ? 1 : 0);
