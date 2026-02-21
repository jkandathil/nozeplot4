const fs = require('fs');
const path = require('path');

function parseCSV(content) {
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',').map(s => s.trim());
    const data = [];
    for (let i = 1; i < Math.min(lines.length, 5000); i++) {
        const vals = lines[i].split(',');
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = parseFloat(vals[j]);
        }
        data.push(row);
    }
    return data;
}

function printStats(file) {
    const d = parseCSV(fs.readFileSync(file, 'utf8'));
    const a1 = d.map(r => r['normalized_A1']).filter(v => !isNaN(v));
    const max = Math.max(...a1);
    const min = Math.min(...a1);
    const first = a1[0];
    const last = a1[a1.length - 1];
    console.log(`File: ${path.basename(file)}`);
    console.log(`A1 - start: ${first}, end: ${last}, min: ${min}, max: ${max}`);
}

printStats('20260118_NO_0-90ppb_27-4125_ABG1_30C/10AH/Files/normalized_ABGv5-0ppb-10RH-75ccm-Anthony-Q425_3693957d_0000000027-4125-asu-nz_0000000018-3024-oms-nz_20260119-0148.csv');
printStats('20260118_NO_0-90ppb_27-4125_ABG1_30C/10AH/Files/normalized_ABGv5-90ppb-10RH-75ccm-Jude-Q425_179f4b5c_0000000027-4125-asu-nz_0000000018-3024-oms-nz_20260119-0055.csv');
