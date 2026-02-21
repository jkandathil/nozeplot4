const fs = require('fs');
const path = require('path');

// Magnus Formula constants
const SATURATION_VAPOR_PRESSURE_0C = 6.112;
const MAGNUS_COEFFICIENT_A = 17.67;
const MAGNUS_COEFFICIENT_B = 243.5;
const GAS_CONSTANT_RATIO = 2.1674;
const KELVIN_OFFSET = 273.15;

function applyMovingAverage(data, windowSize, keysToFilter) {
    if (windowSize <= 1) return data;
    const result = [];
    for (let i = 0; i < data.length; i++) {
        const row = { ...data[i] };
        keysToFilter.forEach(key => {
            if (typeof row[key] === 'number') {
                let sum = 0;
                let count = 0;
                for (let j = Math.max(0, i - windowSize + 1); j <= i; j++) {
                    const val = data[j][key];
                    if (typeof val === 'number' && !isNaN(val)) {
                        sum += val;
                        count++;
                    }
                }
                row[key] = count > 0 ? sum / count : row[key];
            }
        });
        result.push(row);
    }
    return result;
}

function parseCSV(content) {
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',').map(s => s.trim());
    const data = [];
    for (let i = 1; i < Math.min(lines.length, 1000); i++) {
        const vals = lines[i].split(',');
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = parseFloat(vals[j]);
        }
        data.push(row);
    }
    return data;
}

function testPipeline() {
    const file1 = '20260118_NO_0-90ppb_27-4125_ABG1_30C/10AH/Files/normalized_ABGv5-0ppb-10RH-75ccm-Anthony-Q425_3693957d_0000000027-4125-asu-nz_0000000018-3024-oms-nz_20260119-0148.csv';
    const file2 = '20260118_NO_0-90ppb_27-4125_ABG1_30C/10AH/Files/normalized_ABGv5-90ppb-10RH-75ccm-Jude-Q425_179f4b5c_0000000027-4125-asu-nz_0000000018-3024-oms-nz_20260119-0055.csv';

    const d1 = parseCSV(fs.readFileSync(file1, 'utf8'));
    const d2 = parseCSV(fs.readFileSync(file2, 'utf8'));

    const allFiles = [
        { fileName: file1, data: d1 },
        { fileName: file2, data: d2 }
    ];

    const sensingElements = 'A1, A2, A3, B1, C1, H1';
    const tempCols = 'BT1, AQT0';
    const humCols = 'AQH0, TRHH0';
    const filterWindow = 5;

    const sElementsArr = sensingElements.split(',').map(s => s.trim()).filter(Boolean);
    const tColsArr = tempCols.split(',').map(s => s.trim()).filter(Boolean);
    const hColsArr = humCols.split(',').map(s => s.trim()).filter(Boolean);

    const newBatch = allFiles.map(fileObj => {
        let fileData = fileObj.data;
        if (!fileData || fileData.length === 0) return fileObj;

        const sampleKeys = Object.keys(fileData[0]);
        const sensingKeys = sampleKeys.filter(k =>
            sElementsArr.some(prefix => k.toLowerCase().includes(prefix.toLowerCase())) ||
            tColsArr.some(prefix => k.toLowerCase().includes(prefix.toLowerCase())) ||
            hColsArr.some(prefix => k.toLowerCase().includes(prefix.toLowerCase()))
        );

        let processedData = applyMovingAverage(fileData, filterWindow, sensingKeys);

        return { ...fileObj, data: processedData };
    });

    const processedBatch = {
        files: newBatch,
        sensingPrefixes: sElementsArr,
        tCodes: tColsArr,
        hCodes: hColsArr
    };

    const files = processedBatch.files;
    const sensingPrefixes = processedBatch.sensingPrefixes;

    // plot gen
    const extractConcentration = (name) => {
        const basename = name.split('/').pop();
        const m = basename.match(/(\d+(?:\.\d+)?)\s*(ppb|ppm)/i);
        if (m) return `${parseFloat(m[1])} ${m[2].toLowerCase()}`;
        return 'Unknown';
    };

    const extractConcValue = (name) => {
        const m = name.match(/(\d+(?:\.\d+)?)\s*(ppb|ppm)/i);
        return m ? parseFloat(m[1]) : 0;
    };

    const groups = {};
    files.forEach(f => {
        const c = extractConcentration(f.fileName);
        if (!groups[c]) groups[c] = [];
        groups[c].push(f);
    });

    console.log("Groups:", Object.keys(groups));

    const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
        if (a === 'Unknown') return 1;
        if (b === 'Unknown') return -1;
        return parseFloat(a) - parseFloat(b);
    });

    const maxLen = Math.max(...files.map(f => f.data.length));
    const filePrefixCache = files.map(() => ({}));

    files.forEach((f, fIdx) => {
        if (f.data.length > 0) {
            const keys = Object.keys(f.data[0]);
            sensingPrefixes.forEach(prefix => {
                const matchedKey = keys.find(k => k === prefix || k.startsWith(`${prefix}_`) || k.endsWith(`_${prefix}`));
                if (matchedKey) {
                    filePrefixCache[fIdx][prefix] = matchedKey;
                }
            });
        }
    });

    console.log("File Prefix Cache:", filePrefixCache);

    const combinedData = [];
    for (let i = 0; i < maxLen; i++) {
        combinedData.push({ index: i });
    }

    const calibrationDataMap = {};
    sensingPrefixes.forEach(prefix => {
        let hasData = false;
        for (let i = 0; i < maxLen; i++) {
            sortedGroupKeys.forEach((gName) => {
                const values = [];
                groups[gName].forEach(f => {
                    const absFIdx = files.indexOf(f);
                    const matchedKey = filePrefixCache[absFIdx][prefix];
                    if (matchedKey && i < f.data.length) {
                        const val = f.data[i][matchedKey];
                        if (typeof val === 'number') {
                            values.push(val);
                        }
                    }
                });

                if (values.length > 0) {
                    hasData = true;
                    const mean = values.reduce((a, b) => a + b, 0) / values.length;
                    const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
                    const std = Math.sqrt(variance) || 0;
                    combinedData[i][`${gName}_${prefix}_mean`] = mean;
                    combinedData[i][`${gName}_${prefix}_range`] = [mean - std, mean + std];
                }
            });
        }

        if (hasData) {
            sortedGroupKeys.forEach((gName, gIdx) => {
                if (gName !== 'Unknown') {
                    if (!calibrationDataMap[gName]) {
                        calibrationDataMap[gName] = { concLabel: gName, concentration: extractConcValue(gName) };
                    }
                    let maxMean = -Infinity;
                    let stdAtMax = 0;
                    for (let i = 0; i < maxLen; i++) {
                        const meanAtI = combinedData[i][`${gName}_${prefix}_mean`];
                        if (meanAtI !== undefined && meanAtI > maxMean) {
                            maxMean = meanAtI;
                            const r = combinedData[i][`${gName}_${prefix}_range`];
                            stdAtMax = r ? (r[1] - meanAtI) : 0;
                        }
                    }
                    if (maxMean !== -Infinity) {
                        calibrationDataMap[gName][`${prefix}_maxResponse`] = maxMean;
                    }
                }
            });
        }
    });

    const calibrationDataArray = Object.values(calibrationDataMap).sort((a, b) => a.concentration - b.concentration);
    console.log("Calibration Data:", calibrationDataArray);
}

testPipeline();
