// Core mathematical constants for Absolute Humidity calculation (Magnus formula)
const SATURATION_VAPOR_PRESSURE_0C = 6.112; // hPa
const MAGNUS_COEFFICIENT_A = 17.67;
const MAGNUS_COEFFICIENT_B = 243.5; // °C
const GAS_CONSTANT_RATIO = 2.16679; // g·K/J
const KELVIN_OFFSET = 273.15;

export const COLORS = [
    '#2E91E5', '#E15F99', '#1CA71C', '#FB0D0D', '#DA16FF', '#B68100', '#750D86', '#EB663B', '#511CFB', '#00A08B',
    '#10b981', '#38bdf8', '#fbbf24', '#f43f5e', '#a855f7', '#64748b', '#ef4444', '#f97316', '#84cc16', '#14b8a6', '#4f46e5', '#db2777'
];
function applyMovingAverage(data, windowSize, keysToFilter) {
    if (windowSize <= 1) {
        return data.map(row => ({ ...row }));
    }
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

// Extract identical concentration parsing
export const extractConcentration = (name, ignoreAu = false, separateByUnitVal = false) => {
    const basename = name.split(/[/\\]/).pop();
    const m = basename.match(/(\d+(?:\.\d+)?)ppb/i);
    let conc = m ? `${parseFloat(m[1])} ppb` : 'Unknown';

    if (separateByUnitVal && !ignoreAu && conc !== 'Unknown') {
        const fileParts = basename.split('_');
        const asauPart = fileParts.find(p => p.toLowerCase().includes('asu') || p.toLowerCase().includes('asau'));
        if (asauPart) {
            return `${asauPart.toUpperCase()} - ${conc}`;
        }
    }
    return conc;
};

export const extractConcValue = (name) => {
    const m = name.match(/(\d+(?:\.\d+)?)ppb/i);
    return m ? parseFloat(m[1]) : 0;
};

export const processAromaBatchCore = async (filesArray, config) => {
    if (filesArray.length === 0) return null;

    const {
        sensingElements, // string e.g. "A1, A2"
        tempCols, // string
        humCols, // string
        filterWindow, // int
        baselinePts, // int
        removeRecoveryEvents, // bool
        fenoTruncateSeconds, // int
        filterUnknown, // bool
        gapStart, // string|null
        gapEnd, // string|null
        separateByUnit, // bool
        COLORS // array
    } = config;

    // Build configuration arrays
    const sElementsArr = sensingElements.split(',').map(s => s.trim()).filter(Boolean);
    const tColsArr = tempCols.split(',').map(s => s.trim()).filter(Boolean);
    const hColsArr = humCols.split(',').map(s => s.trim()).filter(Boolean);

    const newBatch = filesArray.map(fileObj => {
        let fileData = fileObj.data;
        if (!fileData || fileData.length === 0) return fileObj;

        // 1. Identify sensing variables based on substring matches
        const sampleKeys = Object.keys(fileData[0]);
        const sensingKeys = sampleKeys.filter(k =>
            sElementsArr.some(prefix => k.toLowerCase().includes(prefix.toLowerCase())) ||
            tColsArr.some(prefix => k.toLowerCase().includes(prefix.toLowerCase())) ||
            hColsArr.some(prefix => k.toLowerCase().includes(prefix.toLowerCase()))
        );

        // 1.5 ALAAC Smart Truncation
        const originalData = [...fileData];
        if (removeRecoveryEvents || fenoTruncateSeconds > 0) {
            const eventCol = sampleKeys.find(col => {
                const l = col.toLowerCase();
                return l === 'event_name' || l === 'phase' || l === 'mode' || l === 'state' || (l.includes('event') && !l.includes('reference'));
            });
            if (eventCol) {
                const blocks = [];
                let currentBlock = null;
                fileData.forEach((r, idx) => {
                    const ev = String(r[eventCol] || '').toLowerCase().replace(/\s+/g, '');
                    if (currentBlock && currentBlock.event === ev) {
                        currentBlock.endIdx = idx;
                        currentBlock.endRow = r;
                    } else {
                        if (currentBlock) blocks.push(currentBlock);
                        currentBlock = { event: ev, startIdx: idx, endIdx: idx, startRow: r, endRow: r };
                    }
                });
                if (currentBlock) blocks.push(currentBlock);

                const rowsToRemove = new Set();
                const allowedPlots = ['breathsamplecollection', 'fenowindow', 'fenomeasurement'];
                const hasBreathEvents = blocks.some(b => allowedPlots.some(p => b.event.includes(p)));

                blocks.forEach(b => {
                    if (hasBreathEvents) {
                        const isAllowedPLOT = allowedPlots.some(p => b.event.includes(p));
                        if (!isAllowedPLOT && b.event !== '') {
                            for (let i = b.startIdx; i <= b.endIdx; i++) rowsToRemove.add(i);
                        } else if (fenoTruncateSeconds > 0 && (b.event.includes('feno') || b.event.includes('breath'))) {
                            const allowedRows = fenoTruncateSeconds * 3;
                            for (let i = b.startIdx + allowedRows; i <= b.endIdx; i++) rowsToRemove.add(i);
                        }
                    } else {
                        if (removeRecoveryEvents && b.event.includes('recovery')) {
                            for (let i = b.startIdx; i <= b.endIdx; i++) rowsToRemove.add(i);
                        }
                        if (fenoTruncateSeconds > 0 && (b.event.includes('feno') || b.event.includes('breath'))) {
                            const allowedRows = fenoTruncateSeconds * 3;
                            for (let i = b.startIdx + allowedRows; i <= b.endIdx; i++) rowsToRemove.add(i);
                        }
                    }
                });
                fileData = fileData.filter((_, idx) => !rowsToRemove.has(idx));
            }
        }

        let detectedEvents = [];
        const evCol = sampleKeys.find(col => {
            const l = col.toLowerCase();
            return l === 'event_name' || l === 'phase' || l === 'mode' || l === 'state' || (l.includes('event') && !l.includes('reference'));
        });
        if (evCol) {
            let curEv = null;
            fileData.forEach((r, idx) => {
                const eName = r[evCol];
                if (eName && typeof eName === 'string') {
                    if (curEv && curEv.name === eName) {
                        curEv.end = idx;
                    } else {
                        if (curEv) detectedEvents.push(curEv);
                        curEv = { name: eName, start: idx, end: idx };
                    }
                }
            });
            if (curEv) detectedEvents.push(curEv);
        }

        let processedData = applyMovingAverage(fileData, filterWindow, sensingKeys);

        const normCols = sensingKeys.filter(k => k.toLowerCase().includes('normalized'));
        const rawCols = sensingKeys.filter(k => !k.toLowerCase().includes('normalized'));

        const getMedian = (arr) => {
            if (arr.length === 0) return 1.0;
            const sorted = [...arr].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        };

        if (baselinePts > 0) {
            const baselines = {};

            rawCols.forEach(k => {
                let baselineVals = [];
                const eventCol = Object.keys(originalData[0] || {}).find(col => {
                    const l = col.toLowerCase();
                    return l === 'event_name' || l === 'phase' || l === 'mode' || l === 'state' || (l.includes('event') && !l.includes('reference'));
                });
                let rfcEventRows = [];

                if (eventCol) {
                    rfcEventRows = originalData.filter(row => {
                        if (!row[eventCol] || typeof row[eventCol] !== 'string') return false;
                        const evUpper = row[eventCol].toUpperCase();
                        return evUpper.includes('RFC') || evUpper.includes('AMBIENT') || evUpper.includes('BL');
                    });
                }

                if (rfcEventRows.length > 0) {
                    const pts = Math.min(baselinePts, rfcEventRows.length);
                    const targetRows = rfcEventRows.slice(-pts);
                    baselineVals = targetRows.map(r => r[k]).filter(v => typeof v === 'number');
                } else {
                    const pts = Math.min(baselinePts, originalData.length);
                    for (let i = 0; i < pts; i++) {
                        if (typeof originalData[i][k] === 'number') {
                            baselineVals.push(originalData[i][k]);
                        }
                    }
                }

                baselines[k] = getMedian(baselineVals);
                if (baselines[k] === 0 || isNaN(baselines[k])) baselines[k] = 1.0;
            });

            processedData.forEach(row => {
                normCols.forEach(k => {
                    if (typeof row[k] === 'number') {
                        row[k] = row[k] * 100.0;
                    }
                });
                rawCols.forEach(k => {
                    const b = baselines[k];
                    if (b !== undefined && typeof row[k] === 'number') {
                        row[k] = ((row[k] / b) - 1.0) * 100.0;
                        row[`${k}_raw_baseline`] = b;
                    }
                });
            });
        } else {
            if (normCols.length > 0) {
                processedData.forEach(row => {
                    normCols.forEach(k => {
                        if (typeof row[k] === 'number') row[k] = row[k] * 100.0;
                    });
                });
            }
        }

        if (processedData.length > 0) {
            const fileKeys = Object.keys(processedData[0]);
            const tempMap = [];
            tColsArr.forEach((tCode, i) => {
                const hCode = hColsArr[i];
                if (!hCode) return;
                const matchedTempKeys = fileKeys.filter(k => k.includes(tCode));
                if (matchedTempKeys.length > 0) {
                    tempMap.push({ tCode, hCode, tempKeys: matchedTempKeys });
                }
            });

            if (tempMap.length > 0) {
                processedData.forEach(row => {
                    tempMap.forEach(({ tCode, hCode, tempKeys }) => {
                        tempKeys.forEach(tCol => {
                            const hCol = tCol.replace(tCode, hCode);
                            if (row[hCol] !== undefined) {
                                const tVal = row[tCol];
                                const hVal = row[hCol];
                                if (tVal !== null && hVal !== null && typeof tVal === 'number' && typeof hVal === 'number') {
                                    const absH = (SATURATION_VAPOR_PRESSURE_0C * Math.exp((MAGNUS_COEFFICIENT_A * tVal) / (tVal + MAGNUS_COEFFICIENT_B)) * hVal * GAS_CONSTANT_RATIO) / (tVal + KELVIN_OFFSET);
                                    row[`abs-${hCol}`] = absH;
                                }
                            }
                        });
                    });
                });
            }
        }

        return { ...fileObj, data: processedData, events: detectedEvents };
    });

    const sequenceAverages = [];
    newBatch.forEach(f => {
        if (f.events) {
            f.events.forEach((ev, seqIndex) => {
                const evStr = String(ev.name).toLowerCase().replace(/\s+/g, '');
                if (!sequenceAverages[seqIndex]) sequenceAverages[seqIndex] = { label: ev.name, str: evStr, starts: [] };
                sequenceAverages[seqIndex].starts.push(ev.start);
            });
        }
    });

    const uniqueColors = ['#10b981', '#38bdf8', '#f43f5e', '#a855f7', '#f59e0b', '#8b5cf6'];
    let colorIdx = 0;
    const colorMap = {};

    let refLines = [];
    sequenceAverages.forEach(seq => {
        if (seq.str.includes('recovery') && removeRecoveryEvents) return;
        if (!colorMap[seq.label]) {
            colorMap[seq.label] = uniqueColors[colorIdx % uniqueColors.length];
            colorIdx++;
        }
        const avgStart = Math.min(...seq.starts);
        refLines.push({ x: avgStart, stroke: colorMap[seq.label], label: seq.label });
    });

    const auIdsSet = new Set();
    newBatch.forEach(f => {
        if (!f.fileName) return;
        const baseName = String(f.fileName).split(/[/\\]/).pop();
        const fileParts = baseName.split('_');
        const asauPart = fileParts.find(p => p.toLowerCase().includes('asu') || p.toLowerCase().includes('asau'));
        if (asauPart) auIdsSet.add(asauPart.toUpperCase());
    });
    const finalAuIdVal = Array.from(auIdsSet).join(', ') || 'Unknown AU';

    const processedBatch = {
        files: newBatch,
        sensingPrefixes: sElementsArr,
        tCodes: tColsArr,
        hCodes: hColsArr,
        gapStartVal: gapStart !== '' && gapStart !== null ? parseInt(gapStart, 10) : null,
        gapEndVal: gapEnd !== '' && gapEnd !== null ? parseInt(gapEnd, 10) : null,
        filterUnknownVal: filterUnknown,
        referenceLines: refLines,
        auIdVal: finalAuIdVal,
        separateByUnitVal: separateByUnit
    };

    return generatePlotsFromBatch(processedBatch, COLORS);
};


export const generatePlotsFromBatch = (processedBatch, COLORS) => {
    if (!processedBatch || processedBatch.files.length === 0) return [];

    const { files, sensingPrefixes, tCodes, hCodes, gapStartVal, gapEndVal, filterUnknownVal, referenceLines, auIdVal, separateByUnitVal } = processedBatch;

    const auIdSuffix = auIdVal && auIdVal !== 'Unknown AU' && !separateByUnitVal ? ` (${auIdVal})` : '';

    const plots = [];

    const groups = {};
    files.forEach(f => {
        const c = extractConcentration(f.fileName, false, separateByUnitVal);
        if (filterUnknownVal && c === 'Unknown') return;
        if (!groups[c]) groups[c] = [];
        groups[c].push(f);
    });

    const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
        if (a === 'Unknown') return 1;
        if (b === 'Unknown') return -1;
        const numA = extractConcValue(a);
        const numB = extractConcValue(b);
        if (numA === numB) {
            return a.localeCompare(b);
        }
        return numA - numB;
    });

    let activeMaxLen = 0;
    sortedGroupKeys.forEach(g => {
        groups[g].forEach(f => {
            if (f.data.length > activeMaxLen) activeMaxLen = f.data.length;
        });
    });
    const maxLen = activeMaxLen;

    const tMatchKeys = new Array(files.length).fill(null);
    const hMatchKeys = new Array(files.length).fill(null);
    const absHMatchKeys = new Array(files.length).fill(null);
    const filePrefixCache = files.map(() => ({}));

    files.forEach((f, fIdx) => {
        if (f.data.length > 0) {
            const keys = Object.keys(f.data[0]);
            tMatchKeys[fIdx] = keys.find(k => tCodes.some(c => k.includes(c)));
            hMatchKeys[fIdx] = keys.find(k => hCodes.some(c => k.includes(c)) && !k.startsWith('abs-'));
            absHMatchKeys[fIdx] = keys.find(k => k.startsWith('abs-'));

            sensingPrefixes.forEach(prefix => {
                const low = prefix.toLowerCase();
                const matchedKey = keys.find(k => {
                    const kLow = k.toLowerCase();
                    return kLow === low || kLow.startsWith(`${low}_`) || kLow.endsWith(`_${low}`) || kLow.includes(low);
                });
                if (matchedKey) {
                    filePrefixCache[fIdx][prefix] = matchedKey;
                }
            });
        }
    });

    const eventCol = files[0]?.data.length > 0 ? Object.keys(files[0].data[0]).find(k => {
        const str = k.toLowerCase();
        return str === 'event' || str.includes('event_name') || str.includes('phase') || str.includes('mode') || str.includes('annotation');
    }) : null;

    const combinedData = [];
    for (let i = 0; i < maxLen; i++) {
        let eventVal = null;
        if (eventCol && i < files[0].data.length) {
            eventVal = files[0].data[i][eventCol];
        }
        combinedData.push({ index: i, event_name: eventVal });
    }

    const calibrationDataMap = {};

    sensingPrefixes.forEach(prefix => {
        const lines = [];
        const areas = [];
        let hasData = false;

        for (let i = 0; i < maxLen; i++) {
            if (gapStartVal !== null && gapEndVal !== null && i >= gapStartVal && i <= gapEndVal) continue;
            sortedGroupKeys.forEach((gName) => {
                const values = [];
                const rawBaselines = [];
                groups[gName].forEach(f => {
                    const absFIdx = files.indexOf(f);
                    const matchedKey = filePrefixCache[absFIdx][prefix];

                    if (matchedKey && i < f.data.length) {
                        const val = f.data[i][matchedKey];
                        if (typeof val === 'number') {
                            values.push(val);
                            combinedData[i][`f${absFIdx}_${matchedKey}`] = val;
                            if (typeof f.data[i][`${matchedKey}_raw_baseline`] === 'number') {
                                rawBaselines.push(f.data[i][`${matchedKey}_raw_baseline`]);
                                combinedData[i][`f${absFIdx}_${matchedKey}_raw_baseline`] = f.data[i][`${matchedKey}_raw_baseline`];
                            }
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
                    combinedData[i][`${gName}_${prefix}_min`] = Math.min(...values);
                    combinedData[i][`${gName}_${prefix}_max`] = Math.max(...values);
                    if (rawBaselines.length > 0) {
                        combinedData[i][`${gName}_${prefix}_raw_baseline`] = rawBaselines.reduce((a, b) => a + b, 0) / rawBaselines.length;
                    }
                }
            });
        }

        if (hasData) {
            sortedGroupKeys.forEach((gName, gIdx) => {
                const color = COLORS[gIdx % COLORS.length];
                lines.push({ dataKey: `${gName}_${prefix}_mean`, name: `${gName} Average`, color });
                areas.push({ dataKey: `${gName}_${prefix}_range`, name: `${gName} Spread (±1σ)`, color });

                if (gName !== 'Unknown') {
                    const pureConcLabel = separateByUnitVal ? extractConcentration(groups[gName][0]?.fileName || "", true) : gName;
                    if (!calibrationDataMap[pureConcLabel]) {
                        calibrationDataMap[pureConcLabel] = { concLabel: pureConcLabel, concentration: extractConcValue(gName) };
                    }
                    let peakMean = null;
                    let stdAtPeak = 0;
                    for (let i = 0; i < maxLen; i++) {
                        const meanAtI = combinedData[i][`${gName}_${prefix}_mean`];
                        if (meanAtI !== undefined && meanAtI !== null) {
                            if (peakMean === null || Math.abs(meanAtI) > Math.abs(peakMean)) {
                                peakMean = meanAtI;
                                const r = combinedData[i][`${gName}_${prefix}_range`];
                                stdAtPeak = r ? (r[1] - meanAtI) : 0;
                            }
                        }
                    }
                    if (peakMean !== null) {
                        calibrationDataMap[pureConcLabel][`${gName}_${prefix}_maxResponse`] = peakMean;
                        calibrationDataMap[pureConcLabel][`${gName}_${prefix}_range`] = [peakMean - stdAtPeak, peakMean + stdAtPeak];
                    }
                }
            });
            plots.push({
                title: `${prefix}${auIdSuffix}`,
                shortTitle: prefix,
                data: combinedData,
                lines,
                areas,
                referenceLines,
                isComposed: true,
                yAxisLabel: 'Response (%)'
            });
        }
    });

    // 4. Monotonic Plot Generation (Calibration curves)
    const calibrationDataArray = Object.values(calibrationDataMap).sort((a, b) => a.concentration - b.concentration);
    if (calibrationDataArray.length > 0) {
        sensingPrefixes.forEach((prefix) => {
            const hasPrefixCalibration = sortedGroupKeys.some(gName => calibrationDataArray.some(d => d[`${gName}_${prefix}_maxResponse`] !== undefined));

            if (hasPrefixCalibration) {
                const monoLines = [];
                const monoAreas = [];

                sortedGroupKeys.forEach((gName, gIdx) => {
                    const color = COLORS[gIdx % COLORS.length];
                    if (calibrationDataArray.some(d => d[`${gName}_${prefix}_maxResponse`] !== undefined)) {
                        const shortLabelName = separateByUnitVal ? gName.replace(/ - \d+ ppb/i, '') : gName;
                        monoLines.push({ dataKey: `${gName}_${prefix}_maxResponse`, name: `${shortLabelName} Max`, color });
                        monoAreas.push({ dataKey: `${gName}_${prefix}_range`, name: `${shortLabelName} Spread (±1σ)`, color });
                    }
                });

                plots.push({
                    title: `Monotonic Response Curve: ${prefix} (Max Signal vs Concentration)${auIdSuffix}`,
                    shortTitle: prefix,
                    data: calibrationDataArray,
                    isComposed: true,
                    xAxisKey: 'concLabel',
                    lines: monoLines,
                    areas: monoAreas,
                    yAxisLabel: 'Max Response (%)'
                });
            }
        });
    }

    ['T', 'H', 'Abs-H'].forEach((type) => {
        const lines = [];
        let hasData = false;

        if (files.length <= 15) {
            for (let i = 0; i < maxLen; i++) {
                if (gapStartVal !== null && gapEndVal !== null && i >= gapStartVal && i <= gapEndVal) continue;
                files.forEach((f, fIdx) => {
                    let matchKey = null;
                    if (type === 'T') matchKey = tMatchKeys[fIdx];
                    else if (type === 'H') matchKey = hMatchKeys[fIdx];
                    else if (type === 'Abs-H') matchKey = absHMatchKeys[fIdx];

                    if (matchKey && i < f.data.length) {
                        const val = f.data[i][matchKey];
                        if (typeof val === 'number') {
                            combinedData[i][`f${fIdx}_${matchKey}`] = val;
                        }
                    }
                });
            }
            files.forEach((f, fIdx) => {
                let matchKey = null;
                if (type === 'T') matchKey = tMatchKeys[fIdx];
                else if (type === 'H') matchKey = hMatchKeys[fIdx];
                else if (type === 'Abs-H') matchKey = absHMatchKeys[fIdx];

                if (matchKey) {
                    const conc = extractConcentration(f.fileName);
                    const gIdx = sortedGroupKeys.indexOf(conc);
                    const color = gIdx >= 0 && conc !== 'Unknown' ? COLORS[gIdx % COLORS.length] : COLORS[fIdx % COLORS.length];

                    lines.push({ dataKey: `f${fIdx}_${matchKey}`, name: `${f.fileName.split('/').pop()} (${matchKey})`, color });
                    hasData = true;
                }
            });
            if (hasData) {
                const yLabels = { 'T': 'Temperature (°C)', 'H': 'Humidity (%)', 'Abs-H': 'Abs. Humidity (g/m³)' };
                plots.push({ title: `Computed Property: ${type}${auIdSuffix}`, shortTitle: type, data: combinedData, lines, isComposed: false, yAxisLabel: yLabels[type] || 'Value' });
            }
        } else {
            const areas = [];
            for (let i = 0; i < maxLen; i++) {
                if (gapStartVal !== null && gapEndVal !== null && i >= gapStartVal && i <= gapEndVal) continue;
                sortedGroupKeys.forEach((gName) => {
                    const values = [];
                    groups[gName].forEach(f => {
                        const absFIdx = files.indexOf(f);
                        let matchKey = null;
                        if (type === 'T') matchKey = tMatchKeys[absFIdx];
                        else if (type === 'H') matchKey = hMatchKeys[absFIdx];
                        else if (type === 'Abs-H') matchKey = absHMatchKeys[absFIdx];

                        if (matchKey && i < f.data.length) {
                            const val = f.data[i][matchKey];
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
                        combinedData[i][`${gName}_${type}_mean`] = mean;
                        combinedData[i][`${gName}_${type}_range`] = [mean - std, mean + std];
                    }
                });
            }
            if (hasData) {
                sortedGroupKeys.forEach((gName, gIdx) => {
                    const color = COLORS[gIdx % COLORS.length];
                    lines.push({ dataKey: `${gName}_${type}_mean`, name: `${gName} Average`, color });
                    areas.push({ dataKey: `${gName}_${type}_range`, name: `${gName} Spread (±1σ)`, color });
                });
                const yLabels = { 'T': 'Temperature (°C)', 'H': 'Humidity (%)', 'Abs-H': 'Abs. Humidity (g/m³)' };
                plots.push({ title: `Computed Property Average: ${type}${auIdSuffix}`, shortTitle: type, data: combinedData, lines, areas, referenceLines, isComposed: true, yAxisLabel: yLabels[type] || 'Value' });
            }
        }
    });

    const DOWNSAMPLE_LIMIT = 500;
    plots.forEach(p => {
        if (p.data && p.data.length > DOWNSAMPLE_LIMIT) {
            const step = Math.ceil(p.data.length / DOWNSAMPLE_LIMIT);
            p.data = p.data.filter((_, idx) => idx % step === 0);
        }
    });

    return plots;
};
