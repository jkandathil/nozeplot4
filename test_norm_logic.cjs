const fs = require('fs');
const path = require('path');

function parseCSV(content) {
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',').map(s => s.trim());
    const data = [];
    for (let i = 1; i < Math.min(lines.length, 500); i++) {
        const vals = lines[i].split(',');
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = parseFloat(vals[j]);
        }
        data.push(row);
    }
    return data;
}

function processBatchSim() {
    const files = [
        '20260118_NO_0-90ppb_27-4125_ABG1_30C/10AH/Files/P1_0000000027-4125-asu-nz_0ppb.csv',
        '20260118_NO_0-90ppb_27-4125_ABG1_30C/10AH/Files/P1_0000000027-4125-asu-nz_10ppb.csv'
    ].map(f => ({ fileName: f, data: parseCSV(fs.readFileSync(f, 'utf8')) }));

    const sensingElementsArr = ['A1', 'A2', 'B1'];
    const baselinePts = 50;

    files.forEach(f => {
        let processedData = f.data;
        const keys = Object.keys(processedData[0]);
        const sensingKeys = keys.filter(k => sensingElementsArr.some(prefix => k.toLowerCase().includes(prefix.toLowerCase())));

        console.log(`File: ${f.fileName}`);
        console.log(`Sensing keys found: ${sensingKeys.join(', ')}`);

        if (baselinePts > 0 && processedData.length > baselinePts) {
            const baselines = {};
            sensingKeys.forEach(k => {
                let sum = 0;
                let count = 0;
                for (let i = 0; i < baselinePts; i++) {
                    if (typeof processedData[i][k] === 'number' && !isNaN(processedData[i][k])) {
                        sum += processedData[i][k];
                        count++;
                    }
                }
                if (count > 0) baselines[k] = sum / count;
            });

            console.log(`Baselines:`, baselines);

            processedData = processedData.map((row, idx) => {
                const newRow = { ...row };
                sensingKeys.forEach(k => {
                    const b = baselines[k];
                    if (b !== undefined && typeof row[k] === 'number') {
                        if (b !== 0) {
                            newRow[k] = (row[k] - b) / Math.abs(b);
                        } else {
                            newRow[k] = row[k] - b;
                        }
                    }
                });
                return newRow;
            });
            f.processed = processedData;

            console.log(`Row 0 norm:`, sensingKeys.map(k => `${k}=${processedData[0][k]}`));
            console.log(`Row 100 norm:`, sensingKeys.map(k => `${k}=${processedData[100][k]}`));
        }
    });

}

processBatchSim();
