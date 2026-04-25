import assert from 'node:assert/strict';
import { searchModelCatalog, BUNDLED_MODEL_PACKS } from './src/circuit/modelCatalog.js';

const r = searchModelCatalog('mosfet');
assert.ok(r.bundled.some((p) => p.id === 'basic-analog'));
const rPart = searchModelCatalog('2N3904');
assert.ok(rPart.bundled.some((p) => p.id === 'bjt-small'));
const rPartNorm = searchModelCatalog('  2n3904  ');
assert.ok(rPartNorm.bundled.some((p) => p.id === 'bjt-small'));
const rDiode = searchModelCatalog('1N914');
assert.ok(rDiode.bundled.some((p) => p.id === 'basic-analog'));
const r2 = searchModelCatalog('xyznone');
assert.equal(r2.bundled.length, 0);
assert.equal(BUNDLED_MODEL_PACKS.length, 2);
console.log('test-model-catalog: OK');
