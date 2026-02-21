const fs = require('fs');
const readline = require('readline');

async function processLineByLine() {
    const fileStream = fs.createReadStream('20260118_NO_0-90ppb_27-4125_ABG1_30C/10AH/Files/normalized_ABGv5-50ppb-10RH-75ccm-Anthony-Q425_40a0b3a5_0000000027-4125-asu-nz_0000000018-3024-oms-nz_20260119-0048.csv');

    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let firstLine = '';
    for await (const line of rl) {
        firstLine = line;
        break;
    }

    const cols = firstLine.split(',');
    console.log("Total columns:", cols.length);
    console.log("First 50 columns:", cols.slice(0, 50).join(', '));
    const matches = cols.filter(c => c.toLowerCase().includes('a1') || c.toLowerCase().includes('a2') || c.toLowerCase().includes('b1'));
    console.log("Matching elements:", matches.join(', '));
}

processLineByLine();
