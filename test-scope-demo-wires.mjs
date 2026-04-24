import { DEMOS } from './src/circuit/demos.js';
import { resolveNets, componentPins } from './src/circuit/schematicDoc.js';
import { importNetlistToDoc } from './src/circuit/importNetlist.js';
import { validateSchematic } from './src/circuit/validate.js';

const demo = DEMOS.find((d) => d.id === 'scope-rc');
const { doc } = importNetlistToDoc(demo.netlist);
if (demo.postImport) demo.postImport(doc);

console.log('=== COMPONENTS ===');
for (const c of doc.components) {
    console.log(`  ${c.ref.padEnd(6)} ${c.elementType.padEnd(6)} pos=(${c.pos.x},${c.pos.y}) rot=${c.rot}`);
    for (const p of componentPins(c)) {
        console.log(`      pin ${p.id} @ (${p.x},${p.y}) side=${p.side}`);
    }
}
console.log('\n=== WIRES ===');
for (const w of doc.wires) {
    console.log(`  ${w.id}: ${w.points.map(p => `(${p[0]},${p[1]})`).join(' → ')}`);
}
console.log('\n=== LABELS ===');
for (const l of doc.labels) {
    console.log(`  ${l.id}: "${l.name}" @ (${l.x},${l.y}) visible=${l.visible}`);
}

const nets = resolveNets(doc);
console.log('\n=== NETS ===');
console.log('nodeLabels:', Array.from(nets.nodeLabels.entries()));
console.log('floatingPins:', nets.floatingPins);

const validation = validateSchematic(doc, nets);
console.log('\n=== DRC ISSUES ===');
for (const iss of validation.issues) {
    console.log(`  [${iss.severity}] ${iss.id}: ${iss.message}`);
    if (iss.componentIds) console.log(`      components: ${iss.componentIds.join(', ')}`);
    if (iss.wireIds)      console.log(`      wires:      ${iss.wireIds.join(', ')}`);
    if (iss.endpoints)    console.log(`      endpoints:  ${JSON.stringify(iss.endpoints)}`);
}
