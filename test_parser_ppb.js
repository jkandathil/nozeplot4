import { parseConcentrationMetaFromFile } from './src/utils/workspaceFilename.js';

const file = 'normalized_ABGv5-50ppb-10RH-75ccm-Anthony-Q425_40a0b3a5_0000000027-4125-asu-nz_0000000018-3024-oms-nz_20260119-0048.csv';
console.log(parseConcentrationMetaFromFile(file));
