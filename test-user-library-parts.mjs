import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SYMBOLS } from './src/circuit/symbols.js';
import { buildUserLibraryPartsFromSpiceLibs, extractModelsFromSpiceLibraryText } from './src/circuit/userLibraryParts.js';
import { partLabelForSpiceModelName } from './src/circuit/modelCatalog.js';

const basicPath = new URL('./public/circuit-models/basic_analog.inc', import.meta.url);
const basic = fs.readFileSync(basicPath, 'utf8');
const d1 = buildUserLibraryPartsFromSpiceLibs([{ id: 'b1', name: 'basic_analog.inc', content: basic }]).find((p) => p.modelRef === 'D1N914');
assert.equal(d1.symbolKey, 'D');
assert.ok(SYMBOLS.D);
const mn = buildUserLibraryPartsFromSpiceLibs([{ id: 'b1', name: 'basic_analog.inc', content: basic }]).find((p) => p.modelRef === 'SMALLNMOS');
assert.equal(mn.symbolKey, 'M_NMOS');
assert.ok(SYMBOLS.M_NMOS);

const bjtPath = new URL('./public/circuit-models/bjt_small_signal.inc', import.meta.url);
const bjt = fs.readFileSync(bjtPath, 'utf8');
const ext = extractModelsFromSpiceLibraryText(bjt);
assert.ok(ext.some((m) => m.name === 'Q2N3904' && m.type === 'NPN'));

const parts = buildUserLibraryPartsFromSpiceLibs([{ id: 't1', name: 'bjt_small_signal.inc', content: bjt }]);
const q3904 = parts.find((p) => p.modelRef === 'Q2N3904');
assert.ok(q3904);
assert.equal(q3904.elementType, 'Q');
assert.equal(q3904.symbolKey, 'Q_NPN');
assert.ok(SYMBOLS[q3904.symbolKey], 'palette symbolKey must exist in SYMBOLS');
assert.equal(q3904.partNumber, '2N3904');
assert.equal(partLabelForSpiceModelName('Q2N3904'), '2N3904');
assert.ok(q3904.contributesUserModel?.params);

console.log('test-user-library-parts: OK');
