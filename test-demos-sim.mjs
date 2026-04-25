/**
 * Integration: each Circuit Studio demo → import (+postImport) → emit
 * → parse → run default analysis (same solver entry points as Run).
 */
import { DEMOS } from './src/circuit/demos.js';
import { importNetlistToDoc } from './src/circuit/importNetlist.js';
import { emitNetlist } from './src/circuit/emitNetlist.js';
import { parseNetlist } from './src/circuit/netlist.js';
import { buildContext, solveDC, runWithStep } from './src/circuit/solver.js';

let failures = 0;

function fail(id, msg) {
    console.error(`  FAIL [${id}]: ${msg}`);
    failures++;
}

for (const demo of DEMOS) {
    const id = demo.id;
    console.log(`\n==== ${id} (${demo.defaultAnalysis || '?'}) ====`);
    let doc;
    try {
        const r = importNetlistToDoc(demo.netlist);
        doc = r.doc;
        if (typeof demo.postImport === 'function') demo.postImport(doc);
    } catch (e) {
        fail(id, `import: ${e?.message || e}`);
        continue;
    }

    let text;
    try {
        text = emitNetlist(doc).text;
    } catch (e) {
        fail(id, `emit: ${e?.message || e}`);
        continue;
    }

    const parsed = parseNetlist(text);
    if (parsed.errors?.length) {
        fail(id, `parse: ${parsed.errors.join('; ')}`);
        continue;
    }
    if (!parsed.elements?.length) {
        fail(id, 'parse: no elements');
        continue;
    }

    const stepDir = parsed.directives.find((d) => d.kind === 'step') || null;
    const primary = demo.defaultAnalysis || 'tran';

    const tryRun = (label, fn) => {
        try {
            fn();
            return null;
        } catch (e) {
            return `${label}: ${e?.message || e}`;
        }
    };

    const errs = [];
    if (parsed.directives.some((d) => d.kind === 'op')) {
        errs.push(tryRun('op', () => {
            const ctx = buildContext(parsed);
            solveDC(ctx);
        }));
    }
    const acDir = parsed.directives.find((d) => d.kind === 'ac');
    if (acDir) {
        errs.push(tryRun('ac', () => {
            const ctx = buildContext(parsed);
            const runs = runWithStep(ctx, stepDir, { ac: acDir });
            if (!runs?.[0]?.ac?.freqs?.length) throw new Error('no ac freqs');
        }));
    }
    const tranDir = parsed.directives.find((d) => d.kind === 'tran');
    if (tranDir) {
        errs.push(tryRun('tran', () => {
            const ctx = buildContext(parsed);
            const runs = runWithStep(ctx, stepDir, { tran: tranDir });
            if (!runs?.[0]?.tran) throw new Error('no tran result');
        }));
    }
    const dcDir = parsed.directives.find((d) => d.kind === 'dc');
    if (dcDir) {
        errs.push(tryRun('dc', () => {
            const ctx = buildContext(parsed);
            const runs = runWithStep(ctx, stepDir, { dc: dcDir });
            if (!runs?.[0]?.dc) throw new Error('no dc result');
        }));
    }

    const bad = errs.filter(Boolean);
    if (bad.length) {
        fail(id, bad.join(' | '));
        console.error(text.split('\n').slice(0, 22).join('\n'));
    } else {
        console.log(`  OK (primary=${primary}; ran ${[acDir && 'ac', tranDir && 'tran', dcDir && 'dc', 'op'].filter(Boolean).join(', ')})`);
    }
}

console.log(failures ? `\nDone: ${failures} failure(s)` : '\nAll demos: all present analyses OK');
process.exit(failures ? 1 : 0);
