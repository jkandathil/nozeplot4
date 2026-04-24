import { DEMOS } from './src/circuit/demos.js';
import { importNetlistToDoc } from './src/circuit/importNetlist.js';
import { componentPins, resolveNets } from './src/circuit/schematicDoc.js';
import { emitNetlist } from './src/circuit/emitNetlist.js';

const demo = DEMOS.find(d => d.id === 'tia');
const { doc } = importNetlistToDoc(demo.netlist);

const nets = resolveNets(doc);
console.log('Node labels:', nets.nodeLabels);
console.log('\nPer-component pin nets:');
for (const c of doc.components) {
    const ps = componentPins(c);
    const labs = doc.labels.filter(l =>
        ps.some(p => l.x === p.x && l.y === p.y));
    console.log(` ${c.ref}:`, ps.map(p => `${p.id}@(${p.x},${p.y})→node ${nets.pinNode(c, p.id)}`).join(' | '));
    console.log('    pin-site labels:', labs.map(l => `${l.name}@(${l.x},${l.y})`));
}
console.log('\nEmitted netlist:');
console.log(emitNetlist(doc).text);
