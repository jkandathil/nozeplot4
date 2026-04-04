import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion'; // eslint-disable-line no-unused-vars
import { LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, CartesianGrid, Scatter, ScatterChart, ZAxis, Brush } from 'recharts';
import { Activity, Settings, Maximize2, X, Download, LineChart as LineChartIcon } from 'lucide-react';
import { toPng } from 'html-to-image';
import { isKnownPlotFile, looksLikeSiacCaptureData, parseConcentrationMetaFromFile } from '../utils/workspaceFilename.js';
import { parseFile } from '../utils/fileParser';
import { extractChronoSortKey } from '../utils/recoveryChronoSort.js';
import './AromaAnalysisPage.css'; // Reuse styles

const SATURATION_VAPOR_PRESSURE_0C = 6.112;
const MAGNUS_COEFFICIENT_A = 17.67;
const MAGNUS_COEFFICIENT_B = 243.5;
const GAS_CONSTANT_RATIO = 2.1674;
const KELVIN_OFFSET = 273.15;

/** SiAC32-V2 flattened JSON rows use CHR0…CHR31 (device `t` map); RH/T key names vary by firmware — include common substrings. */
const SIAC32_V2_CHR_SENSORS = Array.from({ length: 32 }, (_, i) => `CHR${i}`).join(', ');
const SIAC32_V2_HUM_COL_HINTS = 'AQH0, TRHH0, rh, hmd, humidity';
const SIAC32_V2_TEMP_COL_HINTS = 'AQT0, TRHT0, temp, t';

/**
 * True if this event block should **start** a drift trial as the gas / challenge phase.
 * FeNOse curated data: `FeNOWindow` is post-breath idle — not a separate exposure (Help: measurement vs window).
 * Short keywords like `feno` match both measurement and window; window is excluded unless keyword contains `window`.
 */
function isExposureBlockEvent(blockEventLower, exposureKeywordRaw, recoveryKeywordRaw) {
    const e = String(blockEventLower || '').trim();
    const expKey = String(exposureKeywordRaw || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');
    const recKey = String(recoveryKeywordRaw || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');

    if (recKey && e.includes(recKey)) return false;

    if (expKey) {
        if (!e.includes(expKey)) return false;
        if (e.includes('fenowindow') && !expKey.includes('window')) return false;
        return true;
    }

    if (e.includes('ambient') || e.includes('baseline') || e.includes('reference') || e.includes('flush')) return false;
    if (e.includes('fenowindow')) return false;
    return true;
}

const RecoveryAnalysisPage = ({
    data,
    fileName,
    compareDataList = [],
    availableFiles = [],
    primaryFileId = null,
}) => {
    const [isSidebarVisible, setIsSidebarVisible] = useState(() => localStorage.getItem('zenMode') !== 'true');

    useEffect(() => {
        const handleZenMode = (e) => setIsSidebarVisible(!e.detail.isZen);
        window.addEventListener('zen-mode-toggle', handleZenMode);
        return () => window.removeEventListener('zen-mode-toggle', handleZenMode);
    }, []);

    // Pipeline Config State
    const [sensingElements, setSensingElements] = useState('A1, A2, A3, A4, A5, A6, A7, A8, B1, B2, B3, B4, B5, B6, B7, B8, C1, C2, C3, C4, C5, C6, C7, C8, D1, D2, D3, D4, D5, D6, D7, D8, E1, E2, E3, E4, E5, E6, E7, E8, F1, F2, F3, F4, F5, F6, F7, F8, G1, G2, G3, G4, G5, G6, G7, G8, H1, H2, H3, H4, H5, H6, H7, H8');
    const [isProcessing, setIsProcessing] = useState(false);
    const [exposureKeyword, setExposureKeyword] = useState('');
    const [recoveryKeyword, setRecoveryKeyword] = useState('recovery');
    const [ignoreHardwareRecovery, setIgnoreHardwareRecovery] = useState(true);
    const [humCols, setHumCols] = useState('AQH0, TRHH0');
    const [tempCols, setTempCols] = useState('AQT0, TRHT0');
    const [filterUnknown, setFilterUnknown] = useState(true);

    const isKnownFile = (fName, fileData = null) => {
        if (!filterUnknown) return true;
        if (!fName) return false;
        return isKnownPlotFile(fName, fileData);
    };

    const siacAutoAppliedForFileRef = React.useRef('');

    useEffect(() => {
        if (!fileName || !data?.length) return;
        if (!looksLikeSiacCaptureData(data)) {
            if (siacAutoAppliedForFileRef.current === fileName) siacAutoAppliedForFileRef.current = '';
            return;
        }
        if (siacAutoAppliedForFileRef.current === fileName) return;
        siacAutoAppliedForFileRef.current = fileName;
        setSensingElements(SIAC32_V2_CHR_SENSORS);
        setHumCols(SIAC32_V2_HUM_COL_HINTS);
        setTempCols(SIAC32_V2_TEMP_COL_HINTS);
    }, [fileName, data]);

    // Results
    const [recoveryResults, setRecoveryResults] = useState(null);
    /** Set when Analyze finds no usable workspace files (vs trials parsed but empty). */
    const [driftInputError, setDriftInputError] = useState(null);
    const [selectedPlot, setSelectedPlot] = useState(null);
    const [maxPlotEnvMetric, setMaxPlotEnvMetric] = useState('absHumidity'); // 'none', 'absHumidity', 'relHumidity', 'temperature'

    // Chrono Plot State
    const [showChrono, setShowChrono] = useState(false);
    const [chronoEnvMetric, setChronoEnvMetric] = useState('absHumidity'); // 'none', 'absHumidity', 'relHumidity', 'temperature'
    const [chronoSensor, setChronoSensor] = useState('');
    const [includeRecoveryPlot, setIncludeRecoveryPlot] = useState(true);
    const [chronoBrushStartIdx, setChronoBrushStartIdx] = useState(0);
    const [chronoBrushEndIdx, setChronoBrushEndIdx] = useState(null);
    const chronoChartWrapperRef = React.useRef(null);

    const handleProcessRecovery = () => {
        setIsProcessing(true);
        setDriftInputError(null);
        setTimeout(() => {
            void (async () => {
            try {
                const collected = [];
                const seen = new Set();
                const pushIfKnown = (nm, rows, dedupeKey) => {
                    if (!nm || !rows?.length) return;
                    const k = dedupeKey != null ? String(dedupeKey) : nm;
                    if (seen.has(k)) return;
                    if (!isKnownFile(nm, rows)) return;
                    seen.add(k);
                    collected.push({ fileName: nm, data: rows });
                };

                if (data?.length && fileName) {
                    pushIfKnown(fileName, data, primaryFileId != null ? String(primaryFileId) : fileName);
                }
                for (const c of compareDataList || []) {
                    if (c?.fileName && c?.data?.length) {
                        pushIfKnown(c.fileName, c.data, c.id != null ? String(c.id) : c.fileName);
                    }
                }
                // Help: analyze the batch you selected (main + compares). Only scan the whole workspace if nothing is selected.
                if (collected.length === 0) {
                    for (const f of availableFiles || []) {
                        if (!f || f.isFolder) continue;
                        const key = f.id != null ? String(f.id) : f.name;
                        if (seen.has(key)) continue;
                        let rows = Array.isArray(f.data) && f.data.length > 0 ? f.data : null;
                        let nm = f.name;
                        if (!rows) {
                            try {
                                const parsed = await parseFile(f);
                                rows = parsed?.data;
                                nm = parsed?.fileName || nm;
                            } catch {
                                continue;
                            }
                        }
                        pushIfKnown(nm, rows, key);
                    }
                }

                const allFiles = collected;

                if (allFiles.length === 0) {
                    setRecoveryResults([]);
                    setDriftInputError(
                        'No labelled captures found. Add CSV/XLSX files with ppb/ppm in the name (or known SiAC/raw patterns), or select a main file, then analyze again.'
                    );
                    return;
                }

                // Strictly sort files chronologically based on their trailing timestamp to guarantee chronological trial numbering
                allFiles.sort((a, b) => extractChronoSortKey(a.fileName).localeCompare(extractChronoSortKey(b.fileName)));

                const sElementsArr = sensingElements.split(',').map(s => s.trim()).filter(Boolean);
                const humKeysArr = humCols.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                const tempKeysArr = tempCols.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

                const getAsauId = (path) => {
                    const baseName = String(path).split('/').pop().split('\\').pop();
                    const fileParts = baseName.split('_');
                    const asauPart = fileParts.find(p => p.toLowerCase().includes('asu') || p.toLowerCase().includes('asau'));
                    return asauPart ? asauPart.toUpperCase() : 'UNKNOWN_AU';
                };

                const getBatchGroupId = (fileObj) => {
                    const sn = fileObj.data?.[0]?.sn;
                    const s = sn != null ? String(sn).trim() : '';
                    if (s) return s.toUpperCase();
                    return getAsauId(fileObj.fileName);
                };

                const groupedFiles = {};
                allFiles.forEach(f => {
                    const auId = getBatchGroupId(f);
                    if (!groupedFiles[auId]) groupedFiles[auId] = [];
                    groupedFiles[auId].push(f);
                });

                const newRecoveryResults = [];
                let totalTrialsProcessed = 0;

                Object.keys(groupedFiles).forEach(auId => {
                    const auStr = auId === 'UNKNOWN_AU' ? 'Unknown AU' : auId;

                    const unifiedTrialsData = {};
                    sElementsArr.forEach(prefix => {
                        unifiedTrialsData[prefix] = [];
                    });

                    let globalTrialIndex = 0;
                    const processedFileNames = [];
                    let lastFileSensingKeysMap = {};

                    groupedFiles[auId].forEach(fileObj => {
                        const fileData = fileObj.data;
                        if (!fileData || fileData.length === 0) return;

                        const sampleKeys = Object.keys(fileData[0]);
                        const eventCol = sampleKeys.find(col => {
                            const l = col.toLowerCase();
                            return l === 'event_name' || l === 'phase' || l === 'mode' || l === 'state' || (l.includes('event') && !l.includes('reference'));
                        });

                        if (!eventCol) return; // Need an event column to parse trials

                        const humColMatch = sampleKeys.find(col => humKeysArr.some(h => col.toLowerCase().includes(h)));
                        const tempColMatch = sampleKeys.find(col => tempKeysArr.some(t => col.toLowerCase().includes(t)));

                        const fileSensingKeysMap = {};
                        lastFileSensingKeysMap = fileSensingKeysMap;
                        sElementsArr.forEach(prefix => {
                            const pLow = prefix.toLowerCase();

                            // Strict boundary match approach to prevent A1 from matching A10 or mA1 but guaranteeing it matches normalized_A1
                            let match = sampleKeys.find(k => {
                                const kLow = k.toLowerCase().trim();
                                if (kLow === pLow) return true;

                                let idx = kLow.indexOf(pLow);
                                while (idx !== -1) {
                                    const prev = idx > 0 ? kLow[idx - 1] : null;
                                    const next = (idx + pLow.length) < kLow.length ? kLow[idx + pLow.length] : null;
                                    const isPrevValid = prev === null || !(/[a-z0-9]/.test(prev));
                                    const isNextValid = next === null || !(/[a-z0-9]/.test(next));

                                    if (isPrevValid && isNextValid) return true;
                                    idx = kLow.indexOf(pLow, idx + 1);
                                }
                                return false;
                            });

                            // Fallback attempt: if strictly not found, try a simple include as a last resort
                            if (!match) {
                                match = sampleKeys.find(k => k.toLowerCase().includes(pLow));
                            }

                            if (match) {
                                fileSensingKeysMap[prefix] = match;
                            }
                        });

                        console.log("Mapped Sensing Keys:", fileSensingKeysMap);

                        // Map continuous events into a chronological block list
                        const blocks = [];
                        let currentBlock = null;

                        fileData.forEach((row, idx) => {
                            const ev = String(row[eventCol] || '').toLowerCase().trim();
                            if (currentBlock && currentBlock.event === ev) {
                                currentBlock.endIdx = idx;
                                currentBlock.endRow = row;
                                currentBlock.rows.push(row);
                            } else {
                                if (currentBlock) blocks.push(currentBlock);
                                currentBlock = { event: ev, startIdx: idx, endIdx: idx, startRow: row, endRow: row, rows: [row] };
                            }
                        });
                        if (currentBlock) blocks.push(currentBlock);

                        // Find trial sequences
                        const trials = [];

                        for (let i = 0; i < blocks.length; i++) {
                            const b = blocks[i];
                            const recKey = recoveryKeyword.trim().toLowerCase();

                            const isExposure = isExposureBlockEvent(b.event, exposureKeyword, recoveryKeyword);

                            if (isExposure) {
                                // Find the preceding baseline
                                let prevBlock = null;
                                let sequenceStartIdx = blocks[i].startIdx;

                                // Traverse backward to find the ACTUAL baseline start
                                for (let j = i - 1; j >= 0; j--) {
                                    const evJ = blocks[j].event;
                                    if (recKey && evJ.includes(recKey)) continue;

                                    // We reached the start of the baseline
                                    if (evJ.includes('baseline') || evJ.includes('ambient') || evJ.includes('reference') || evJ.includes('flush')) {
                                        prevBlock = blocks[j];
                                        break; // Drop out BEFORE expanding sequence to include the baseline itself!
                                    }

                                    // Expand block inclusively backwards for things like "BreathSampleCollection"
                                    sequenceStartIdx = blocks[j].startIdx;

                                    // If we hit another exposure anchor before a baseline, stop tracing backward
                                    if (isExposureBlockEvent(evJ, exposureKeyword, recoveryKeyword)) {
                                        break;
                                    }
                                }

                                // Look forward to find the true endpoints mapping the actual wait/response block
                                let recoveryBlock = null;
                                let nextBaseBlock = null;

                                // To map the full sequence, we trace until the NEXT baseline explicitly or a recovery phase
                                let sequenceEndIdx = b.endIdx;

                                for (let j = i + 1; j < blocks.length; j++) {
                                    const evJ = blocks[j].event;

                                    if (recKey && !recoveryBlock && evJ.includes(recKey)) {
                                        recoveryBlock = blocks[j];
                                    }

                                    if (evJ.includes('baseline') || evJ.includes('ambient') || evJ.includes('reference') || evJ.includes('flush')) {
                                        if (!nextBaseBlock) nextBaseBlock = blocks[j];
                                        break;
                                    }

                                    // Expand the sequence boundary to include these subsequent phases before the next baseline
                                    // Only expand if it's not a recovery event (which is handled separately) and not a baseline/ambient/reference/flush
                                    const notRecoveryPhase = !recKey || !evJ.includes(recKey);
                                    if (notRecoveryPhase && !evJ.includes('baseline') && !evJ.includes('ambient') && !evJ.includes('reference') && !evJ.includes('flush')) {
                                        sequenceEndIdx = blocks[j].endIdx;
                                    }
                                }

                                // Define the active "Sequence" to include everything EXCEPT recovery and next baseline
                                let finalSequenceEndIdx = sequenceEndIdx;
                                if (recoveryBlock) {
                                    finalSequenceEndIdx = recoveryBlock.startIdx - 1;
                                } else if (nextBaseBlock) {
                                    finalSequenceEndIdx = nextBaseBlock.startIdx - 1;
                                }

                                finalSequenceEndIdx = Math.max(finalSequenceEndIdx, b.endIdx);
                                const rawSequence = fileData.slice(sequenceStartIdx, finalSequenceEndIdx + 1);

                                if (ignoreHardwareRecovery) {
                                    if (prevBlock) {
                                        trials.push({
                                            targetConcentration: b.event,
                                            baseline: prevBlock,
                                            exposure: b,
                                            nextBaseline: nextBaseBlock,
                                            rawSequence
                                        });
                                    }
                                } else {
                                    if (prevBlock && recoveryBlock) {
                                        trials.push({
                                            targetConcentration: b.event,
                                            baseline: prevBlock,
                                            exposure: b,
                                            recovery: recoveryBlock,
                                            rawSequence
                                        });
                                    }
                                }
                            }
                        }

                        if (trials.length === 0) return;

                        let extConc = '';
                        const metaConc = parseConcentrationMetaFromFile(fileObj.fileName, fileData);
                        if (metaConc?.label) {
                            extConc = metaConc.label;
                        } else {
                            const concMatch = fileObj.fileName.match(/(\d+(?:\.\d+)?\s*(?:ppb|ppm|ppt|%))/i);
                            if (concMatch) extConc = concMatch[1];
                        }

                        processedFileNames.push(fileObj.fileName);

                        trials.forEach(t => {
                            globalTrialIndex++;

                            sElementsArr.forEach(prefix => {
                                // If user typed A1, they expect a plot even if missing, but we'll only plot if exists
                                const exactCol = fileSensingKeysMap[prefix];
                                if (!exactCol) return; // Sensor missing in this file

                                // Calculate averages for this column
                                const getColAvg = (blockRows, colName) => {
                                    if (!blockRows || blockRows.length === 0 || !colName) return 0;
                                    const sum = blockRows.reduce((acc, row) => acc + (Number(row[colName]) || 0), 0);
                                    return sum / blockRows.length;
                                };

                                const preExposureBase = getColAvg(t.baseline.rows, exactCol);
                                const baselineRH = humColMatch ? getColAvg(t.baseline.rows, humColMatch) : 0;
                                const baselineTemp = tempColMatch ? getColAvg(t.baseline.rows, tempColMatch) : 25; // Default to 25C if missing

                                let absHumidity = 0;
                                if (baselineRH > 0) {
                                    // Calculate Absolute Humidity (g/m3) from Relative Humidity (%) and Temp (C) using Magnus formula
                                    absHumidity = (SATURATION_VAPOR_PRESSURE_0C * Math.exp((MAGNUS_COEFFICIENT_A * baselineTemp) / (baselineTemp + MAGNUS_COEFFICIENT_B)) * baselineRH * GAS_CONSTANT_RATIO) / (baselineTemp + KELVIN_OFFSET);
                                }

                                // Capture starting value of FeNo measurement event
                                let fenoStartValue = preExposureBase;
                                if (t.rawSequence && t.rawSequence.length > 0) {
                                    const fenoRow = t.rawSequence.find(r => r[eventCol] && r[eventCol].toLowerCase().replace(/\s+/g, '').includes('fenomeasurement'));
                                    if (fenoRow && fenoRow[exactCol] !== undefined) {
                                        fenoStartValue = Number(fenoRow[exactCol]);
                                    }
                                }

                                unifiedTrialsData[prefix].push({
                                    trial: `Trial ${globalTrialIndex} ${processedFileNames.length > 1 ? `(F${processedFileNames.length})` : ''}`,
                                    concentration: extConc || t.targetConcentration,
                                    baselineValue: fenoStartValue,
                                    humidity: Number((absHumidity).toFixed(2)),
                                    relHumidity: Number((baselineRH).toFixed(2)),
                                    temperature: Number((baselineTemp).toFixed(2)),
                                    sourceFile: fileObj.fileName,
                                    rawBaseline: t.baseline.rows,
                                    rawExposure: t.exposure.rows,
                                    rawRecovery: ignoreHardwareRecovery ? (t.nextBaseline ? t.nextBaseline.rows : null) : (t.recovery ? t.recovery.rows : null),
                                    rawSequence: t.rawSequence,
                                    exactCol: exactCol,
                                    eventCol: eventCol,
                                    humCol: humColMatch,
                                    tempCol: tempColMatch,
                                    recoveryValue: getColAvg(ignoreHardwareRecovery ? (t.nextBaseline ? t.nextBaseline.rows : null) : (t.recovery ? t.recovery.rows : null), exactCol)
                                });
                            });
                        }); // End of trials.forEach
                    }); // End of groupedFiles[auId].forEach

                    if (globalTrialIndex > 0) {
                        totalTrialsProcessed += globalTrialIndex;
                        const finalSensorPlots = {};

                        // Force plot wrappers for EVERY sensor the user requested, even if 0 data points were found
                        sElementsArr.forEach(prefix => {
                            finalSensorPlots[prefix] = {
                                sensorName: prefix,
                                data: unifiedTrialsData[prefix] || []
                            };
                        });

                        newRecoveryResults.push({
                            fileName: `AU_ID: ${auStr} (${processedFileNames.length} Files)`,
                            debugMap: JSON.stringify(lastFileSensingKeysMap),
                            trialsCount: globalTrialIndex,
                            sensorPlots: finalSensorPlots
                        });
                    }
                }); // End of Object.keys(groupedFiles).forEach

                if (totalTrialsProcessed === 0) {
                    setRecoveryResults([]);
                    setDriftInputError(null);
                    return;
                }

                setRecoveryResults(newRecoveryResults);
                setDriftInputError(null);

            } catch (err) {
                console.error("Error analyzing recovery:", err);
                setRecoveryResults([{
                    fileName: "Error processing files",
                    debugMap: `{"error": "${err.message}"}`,
                    trialsCount: 0,
                    sensorPlots: {}
                }]);
                setDriftInputError(null);
            } finally {
                setIsProcessing(false);
            }
            })();
        }, 100);
    };

    const handleDownloadPng = async (plotId) => {
        const el = document.getElementById(plotId);
        if (!el) return;
        try {
            const dataUrl = await toPng(el, { backgroundColor: '#0f172a', pixelRatio: 2 });
            const link = document.createElement('a');
            link.download = `recovery_drift_${plotId}.png`;
            link.href = dataUrl;
            link.click();
        } catch (err) {
            console.error('Download failed:', err);
        }
    };

    const handleExportAllCSV = () => {
        if (!recoveryResults || recoveryResults.length === 0) return;

        const csvRows = [];
        // Header
        csvRows.push(['Batch File', 'Sensor', 'Trial', 'Concentration', 'Baseline Avg (Ohms)', 'Absolute Humidity', 'Source File'].join(','));

        recoveryResults.forEach(batch => {
            Object.keys(batch.sensorPlots).forEach(sensorName => {
                const sensorObj = batch.sensorPlots[sensorName];
                if (!sensorObj.data || sensorObj.data.length === 0) return;

                sensorObj.data.forEach(d => {
                    const row = [
                        `"${batch.fileName}"`,
                        `"${sensorName}"`, // Force strings to accommodate commas safely
                        `"${d.trial}"`,
                        `"${d.concentration}"`,
                        d.baselineValue,
                        d.humidity,
                        `"${d.sourceFile}"`
                    ];
                    csvRows.push(row.join(','));
                });
            });
        });

        const csvString = csvRows.join('\n');
        const blob = new Blob([csvString], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `recovery_analysis_all_sensors_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const [chronoData, chronoLineKeys, rawChronoStitched] = useMemo(() => {
        if (!recoveryResults || recoveryResults.length === 0 || !chronoSensor) return [[], [], []];

        const stitched = [];
        let timeIndex = 0;
        const lineKeys = new Set();

        recoveryResults.forEach(batch => {
            const sensorObj = batch.sensorPlots[chronoSensor];
            if (!sensorObj || !sensorObj.data) return;

            sensorObj.data.forEach((d) => {
                const tNumMatch = d.trial.match(/\d+/);
                const tNum = tNumMatch ? tNumMatch[0] : '';
                const concStr = d.concentration ? String(d.concentration).replace(/\s+/g, '') : '';

                let asauSuffix = '';

                // The file name has multiple underscores. Find the specific chunk that represents the ASAU ID.
                const baseName = String(d.sourceFile).split('/').pop().split('\\').pop();
                const fileParts = baseName.split('_');
                const asauPart = fileParts.find(p => p.toLowerCase().includes('asu') || p.toLowerCase().includes('asau'));

                if (asauPart) {
                    asauSuffix = `_${asauPart}`;
                } else {
                    // Formatting fallback if 'asu' string isn't found
                    asauSuffix = '';
                }

                const rowKey = `Trial ${tNum}_${concStr}${asauSuffix}`;
                lineKeys.add(rowKey);

                const pushRows = (rows, isRecovery = false) => {
                    if (!rows) return;
                    rows.forEach(r => {
                        const dynamicPhase = isRecovery ? 'Recovery' : (r[d.eventCol] || 'Sequence');

                        let rowAbsHumidity = 0;
                        let rowRelHumidity = 0;
                        let rowTemperature = 0;
                        if (d.humCol && d.tempCol) {
                            const rh = Number(r[d.humCol]) || 0;
                            const tc = Number(r[d.tempCol]) || 25;
                            rowRelHumidity = rh;
                            rowTemperature = tc;
                            if (rh > 0) {
                                rowAbsHumidity = (6.112 * Math.exp((17.67 * tc) / (tc + 243.5)) * rh * 2.1674) / (tc + 273.15);
                            }
                        }

                        stitched.push({
                            time: timeIndex++,
                            [rowKey]: Number(r[d.exactCol]) || 0,
                            all: Number(r[d.exactCol]) || 0,
                            phase: dynamicPhase,
                            activeKey: rowKey,
                            absHumidity: Number(rowAbsHumidity.toFixed(2)),
                            relHumidity: Number(rowRelHumidity.toFixed(2)),
                            temperature: Number(rowTemperature.toFixed(2))
                        });
                    });
                };

                // Replaces individual baseline/exposure array plotting with the verbatim file sequence block
                pushRows(d.rawSequence, false);

                // If ignoreHardwareRecovery is TRUE, rawRecovery is just the NEXT trial's baseline.
                // Pushing it here would duplicate the sequence, so we strictly ignore it.
                if (includeRecoveryPlot && !ignoreHardwareRecovery) {
                    pushRows(d.rawRecovery, true);
                }
            });
        }); // End of recoveryResults.forEach(batch => {

        // Massive performance optimization: Downsample to a maximum of ~2000 data nodes for rendering
        // Prevents Recharts from freezing the main thread when plotting gigabytes of trial sequence
        let finalData = stitched;
        const MAX_POINTS = 2000;
        if (stitched.length > MAX_POINTS) {
            const step = Math.ceil(stitched.length / MAX_POINTS);
            finalData = stitched.filter((_, idx) => idx % step === 0);
        }

        // Return the final data for plotting, the line keys, and the COMPLETE un-downsampled dataset for the CSV export.
        return [finalData, Array.from(lineKeys), stitched];
    }, [recoveryResults, chronoSensor, includeRecoveryPlot]);

    const chronoBrushRef = React.useRef({ start: 0, end: null });

    React.useEffect(() => {
        const end = chronoData.length > 0 ? chronoData.length - 1 : null;
        setChronoBrushStartIdx(0);
        setChronoBrushEndIdx(end);
        chronoBrushRef.current = { start: 0, end };
    }, [chronoData]);

    const activeChronoData = React.useMemo(() => {
        if (!chronoData || chronoData.length === 0) return [];
        const end = chronoBrushEndIdx !== null ? chronoBrushEndIdx : chronoData.length - 1;
        // Native slicing removes the burden of tracking invisible nodes from the DOM heavily
        let sliced = chronoData.slice(chronoBrushStartIdx, end + 1);

        // Guarantee flawless 60fps interaction on standard screens
        const MAX_ACTIVE_NODES = 400;
        if (sliced.length > MAX_ACTIVE_NODES) {
            const step = Math.ceil(sliced.length / MAX_ACTIVE_NODES);
            sliced = sliced.filter((_, i) => i % step === 0);
        }
        return sliced;
    }, [chronoData, chronoBrushStartIdx, chronoBrushEndIdx]);

    const rAFRef = React.useRef(null);
    const scrollAccumulator = React.useRef(0);

    const handleChronoWheel = React.useCallback((e) => {
        try {
            if (!chronoData || chronoData.length === 0) return;

            // Important: only prevent default if we are zooming (holding Ctrl) or hovering over the chart area to stop page scroll
            e.preventDefault();

            scrollAccumulator.current += e.deltaY;

            if (rAFRef.current) return; // Prevent state updates from stacking

            rAFRef.current = setTimeout(() => {
                const totalDeltaY = scrollAccumulator.current;
                scrollAccumulator.current = 0;

                const zoomIn = totalDeltaY < 0;
                const lastIdx = chronoData.length - 1;

                // Read from instantaneous ref to avoid state closure lag during fast scrolling
                const startIdx = chronoBrushRef.current.start;
                const endIdx = chronoBrushRef.current.end !== null ? chronoBrushRef.current.end : lastIdx;

                const currentSpan = endIdx - startIdx;
                const minSpan = 10;
                if (currentSpan < minSpan && zoomIn) {
                    rAFRef.current = null;
                    return;
                }

                // Scale intensity by accumulated delta
                const intensity = Math.min(Math.abs(totalDeltaY) * 0.004, 0.4);
                const delta = Math.max(1, Math.floor(currentSpan * intensity));

                // Dynamic Pivot using mouse position (approx)
                const rect = chronoChartWrapperRef.current.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const chartWidth = rect.width;
                const relativeMouseX = Math.max(0, Math.min(1, mouseX / chartWidth));

                // Adjust pivot based on where mouse is
                let pivotIdx = startIdx + Math.floor(currentSpan * relativeMouseX);
                const ratio = currentSpan > 0 ? (pivotIdx - startIdx) / currentSpan : 0.5;

                let newStart, newEnd;
                if (zoomIn) {
                    newStart = startIdx + Math.floor(delta * ratio);
                    newEnd = endIdx - Math.ceil(delta * (1 - ratio));
                } else {
                    newStart = Math.max(0, startIdx - Math.floor(delta * ratio));
                    newEnd = Math.min(lastIdx, endIdx + Math.ceil(delta * (1 - ratio)));
                }

                if (newEnd - newStart < minSpan) {
                    newStart = Math.max(0, pivotIdx - (minSpan / 2));
                    newEnd = Math.min(lastIdx, pivotIdx + (minSpan / 2));
                }

                // Prevent going out of bounds cleanly
                newStart = Math.max(0, newStart);
                newEnd = Math.min(lastIdx, newEnd);

                // Update ref and state safely capped at 25 fps
                chronoBrushRef.current = { start: newStart, end: newEnd };
                setChronoBrushStartIdx(newStart);
                setChronoBrushEndIdx(newEnd);

                rAFRef.current = null;
            }, 40);
        } catch (err) {
            console.warn('handleChronoWheel Error:', err);
            rAFRef.current = null;
        }
    }, [chronoData]);

    React.useEffect(() => {
        const el = chronoChartWrapperRef.current;
        if (!el) return;

        // Use passive: false to allow e.preventDefault()
        const listener = (e) => handleChronoWheel(e);
        el.addEventListener('wheel', listener, { passive: false });
        return () => el.removeEventListener('wheel', listener);
    }, [handleChronoWheel, showChrono]);

    useEffect(() => {
        if (!showChrono) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = prev;
        };
    }, [showChrono]);

    const COLORS = ['#38bdf8', '#10b981', '#f43f5e', '#a855f7', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1'];

    // Update brush ref when brush is dragged manually
    const handleBrushChange = (e) => {
        if (e) {
            setChronoBrushStartIdx(e.startIndex);
            setChronoBrushEndIdx(e.endIndex);
            chronoBrushRef.current = { start: e.startIndex, end: e.endIndex };
        }
    };

    if (showChrono) {
        let chronoDeltaR = 0;
        let chronoPctDrift = 0;
        let chronoDeltaRh = 0;
        let chronoDeltaTc = 0;
        if (activeChronoData && activeChronoData.length > 0) {
            const rVals = activeChronoData.map(d => d.all).filter(v => v !== undefined && !isNaN(v));
            if (rVals.length > 0) {
                const maxR = Math.max(...rVals);
                const minR = Math.min(...rVals);
                chronoDeltaR = maxR - minR;
                chronoPctDrift = Math.abs(minR) > 0 ? (chronoDeltaR / Math.abs(minR)) * 100 : 0;
            }

            const rhVals = activeChronoData.map(d => d.relHumidity).filter(v => v !== undefined && !isNaN(v));
            if (rhVals.length > 0) chronoDeltaRh = Math.max(...rhVals) - Math.min(...rhVals);

            const tcVals = activeChronoData.map(d => d.temperature).filter(v => v !== undefined && !isNaN(v));
            if (tcVals.length > 0) chronoDeltaTc = Math.max(...tcVals) - Math.min(...tcVals);
        }

        const chronoOverlay = (
            <div
                className="chrono-fullscreen glass-panel"
                style={{
                    position: 'fixed',
                    top: 'var(--auth-session-bar-height, 0px)',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    zIndex: 20000,
                    background: '#0f172a',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    boxSizing: 'border-box',
                }}
            >
                <div className="modal-header" style={{ padding: '20px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.03)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <h2 style={{ margin: 0, color: '#f8fafc', fontSize: '1.2rem' }}>Chronological Plot</h2>
                            {(chronoDeltaR > 0 || chronoDeltaRh >= 0 || chronoDeltaTc >= 0) && (
                                <span style={{ fontSize: '0.75rem', color: '#f59e0b', fontWeight: 500 }}>
                                    ΔR = {chronoDeltaR.toFixed(3)} Ω ({chronoPctDrift.toFixed(1)}%) | ΔRH: {chronoDeltaRh.toFixed(1)}% | ΔT: {chronoDeltaTc.toFixed(1)}°C
                                </span>
                            )}
                        </div>
                        <select value={chronoSensor} onChange={(e) => setChronoSensor(e.target.value)} className="text-input" style={{ width: '150px', padding: '6px' }}>
                            <option value="" disabled>Select Sensor</option>
                            {Object.keys(recoveryResults?.[0]?.sensorPlots || {}).map(s => {
                                if (recoveryResults[0].sensorPlots[s].data.length > 0) {
                                    return <option key={s} value={s}>{s}</option>;
                                }
                                return null;
                            })}
                        </select>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#e2e8f0', fontSize: '0.85rem', cursor: 'pointer' }}>
                            <input type="checkbox" checked={includeRecoveryPlot} onChange={e => setIncludeRecoveryPlot(e.target.checked)} style={{ accentColor: '#f59e0b', width: 14, height: 14 }} />
                            Include Recovery Portion
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 10, background: 'rgba(0,0,0,0.2)', padding: '4px 10px', borderRadius: 6 }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#e2e8f0', fontSize: '0.80rem', cursor: 'pointer' }}>
                                <input type="radio" name="chronoEnvMetric" checked={chronoEnvMetric === 'none'} onChange={() => setChronoEnvMetric('none')} style={{ accentColor: '#94a3b8' }} /> None
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#eab308', fontSize: '0.80rem', cursor: 'pointer' }}>
                                <input type="radio" name="chronoEnvMetric" checked={chronoEnvMetric === 'absHumidity'} onChange={() => setChronoEnvMetric('absHumidity')} style={{ accentColor: '#eab308' }} /> Abs. Hum
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#10b981', fontSize: '0.80rem', cursor: 'pointer' }}>
                                <input type="radio" name="chronoEnvMetric" checked={chronoEnvMetric === 'relHumidity'} onChange={() => setChronoEnvMetric('relHumidity')} style={{ accentColor: '#10b981' }} /> Rel. Hum
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ef4444', fontSize: '0.80rem', cursor: 'pointer' }}>
                                <input type="radio" name="chronoEnvMetric" checked={chronoEnvMetric === 'temperature'} onChange={() => setChronoEnvMetric('temperature')} style={{ accentColor: '#ef4444' }} /> Temp
                            </label>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <button
                            className="process-btn"
                            onClick={() => {
                                if (!chronoChartWrapperRef.current) return;
                                toPng(chronoChartWrapperRef.current, { backgroundColor: '#0f172a', pixelRatio: 2 })
                                    .then((dataUrl) => {
                                        const link = document.createElement('a');
                                        link.download = `Chrono_Plot_${chronoSensor || 'Sensor'}.png`;
                                        link.href = dataUrl;
                                        document.body.appendChild(link);
                                        link.click();
                                        document.body.removeChild(link);
                                    })
                                    .catch(err => console.error("Could not download plot", err));
                            }}
                            style={{ background: 'linear-gradient(135deg, #334155, #1e293b)', borderColor: '#475569', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 6 }}
                        >
                            <Download size={16} /> PNG
                        </button>
                        <button
                            className="process-btn"
                            onClick={() => {
                                if (!rawChronoStitched || rawChronoStitched.length === 0) return;

                                let csvStr = "Index,Trial,Phase,Resistance (Ohms)\n";
                                rawChronoStitched.forEach(r => {
                                    // Protect commas in trial string mapping
                                    csvStr += `${r.time},"${r.activeKey}",${r.phase},${r.all}\n`;
                                });

                                const blob = new Blob([csvStr], { type: 'text/csv' });
                                const url = URL.createObjectURL(blob);
                                const link = document.createElement('a');
                                link.href = url;
                                link.download = `Chrono_Data_${chronoSensor || 'Sensor'}.csv`;
                                document.body.appendChild(link);
                                link.click();
                                document.body.removeChild(link);
                                URL.revokeObjectURL(url);
                            }}
                            style={{ background: 'linear-gradient(135deg, #10b981, #047857)', borderColor: '#059669', color: '#fff', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 6 }}
                        >
                            <Download size={16} /> CSV
                        </button>
                        <button className="process-btn" onClick={() => setShowChrono(false)} style={{ background: 'linear-gradient(135deg, #334155, #1e293b)', borderColor: '#475569', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <X size={16} /> Close
                        </button>
                    </div>
                </div>
                <div className="modal-body" style={{ flex: 1, padding: '20px', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }} ref={chronoChartWrapperRef}>
                    {chronoData.length > 0 ? (
                        <>
                            {/* FOREGROUND HIGH-PERFORMANCE PLOT */}
                            <ResponsiveContainer width="100%" height="85%">
                                <LineChart data={activeChronoData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                    <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} hide={true} />
                                    <YAxis yAxisId="left" domain={['auto', 'auto']} stroke="#334155" tick={{ fill: '#38bdf8' }} label={{ value: 'Resistance (Ohms)', angle: -90, position: 'insideLeft', fill: '#38bdf8' }} />
                                    {chronoEnvMetric === 'absHumidity' && (
                                        <YAxis yAxisId="right" orientation="right" domain={['auto', 'auto']} stroke="#eab308" tick={{ fill: '#eab308', fontSize: 11 }} tickFormatter={(val) => val.toFixed(1)} label={{ value: 'Abs. Humidity (g/m³)', angle: 90, position: 'insideRight', fill: '#eab308' }} />
                                    )}
                                    {chronoEnvMetric === 'relHumidity' && (
                                        <YAxis yAxisId="right" orientation="right" domain={['auto', 'auto']} stroke="#10b981" tick={{ fill: '#10b981', fontSize: 11 }} tickFormatter={(val) => val.toFixed(1)} label={{ value: 'Rel. Humidity (%)', angle: 90, position: 'insideRight', fill: '#10b981' }} />
                                    )}
                                    {chronoEnvMetric === 'temperature' && (
                                        <YAxis yAxisId="right" orientation="right" domain={['auto', 'auto']} stroke="#ef4444" tick={{ fill: '#ef4444', fontSize: 11 }} tickFormatter={(val) => val.toFixed(1)} label={{ value: 'Temperature (°C)', angle: 90, position: 'insideRight', fill: '#ef4444' }} />
                                    )}
                                    <RechartsTooltip
                                        cursor={{ stroke: '#475569', strokeDasharray: '3 3' }}
                                        contentStyle={{ backgroundColor: 'rgba(0,0,0,0.8)', border: '1px solid #334155', borderRadius: 8 }}
                                        labelStyle={{ color: '#fff', fontSize: '12px', marginBottom: 4 }}
                                        itemStyle={{ fontSize: '13px', padding: '2px 0' }}
                                        formatter={(value, name, props) => {
                                            if (name === 'all') return []; // Hide from tooltip
                                            if (name === 'Absolute Humidity') return [Number(value).toFixed(2) + ' g/m³', 'Environment'];
                                            if (name === 'Relative Humidity') return [Number(value).toFixed(2) + ' %', 'Environment'];
                                            if (name === 'Temperature') return [Number(value).toFixed(2) + ' °C', 'Environment'];
                                            return [Number(value).toFixed(4) + ' Ω', props.payload.phase];
                                        }}
                                        labelFormatter={(label, payload) => {
                                            if (payload && payload.length > 0) {
                                                return payload[0].payload.activeKey;
                                            }
                                            return label;
                                        }}
                                    />
                                    <Line yAxisId="left" type="linear" dataKey="all" stroke="#ffffff" strokeWidth={2} strokeDasharray="5 5" opacity={0.65} dot={false} isAnimationActive={false} connectNulls={true} activeDot={false} />
                                    {chronoEnvMetric === 'absHumidity' && (
                                        <Line yAxisId="right" type="monotone" name="Absolute Humidity" dataKey="absHumidity" stroke="#eab308" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls={true} activeDot={false} opacity={0.35} />
                                    )}
                                    {chronoEnvMetric === 'relHumidity' && (
                                        <Line yAxisId="right" type="monotone" name="Relative Humidity" dataKey="relHumidity" stroke="#10b981" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls={true} activeDot={false} opacity={0.35} />
                                    )}
                                    {chronoEnvMetric === 'temperature' && (
                                        <Line yAxisId="right" type="monotone" name="Temperature" dataKey="temperature" stroke="#ef4444" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls={true} activeDot={false} opacity={0.35} />
                                    )}
                                    {chronoLineKeys.map((key, index) => (
                                        <Line
                                            yAxisId="left"
                                            key={key}
                                            type="linear"
                                            dataKey={key}
                                            stroke={COLORS[index % COLORS.length]}
                                            strokeWidth={2}
                                            dot={false}
                                            isAnimationActive={false}
                                            connectNulls={false}
                                            activeDot={false}
                                        />
                                    ))}
                                </LineChart>
                            </ResponsiveContainer>

                            {/* BACKGROUND NAVIGATOR BRUSH - Isolated to prevent recursive DOM duplication */}
                            <ResponsiveContainer width="100%" height="15%">
                                <LineChart data={chronoData}>
                                    <Line type="linear" dataKey="all" stroke="#ffffff" strokeWidth={1} strokeDasharray="3 3" opacity={0.4} dot={false} isAnimationActive={false} activeDot={false} connectNulls={true} />
                                    <Brush dataKey="time" startIndex={chronoBrushStartIdx} endIndex={chronoBrushEndIdx} onChange={handleBrushChange} height={30} stroke="#38bdf8" fill="rgba(15, 23, 42, 0.8)" tickFormatter={() => ''} travellerWidth={10} />
                                </LineChart>
                            </ResponsiveContainer>
                        </>
                    ) : (
                        <div style={{ color: '#94a3b8', textAlign: 'center', marginTop: 100, fontSize: '1rem' }}>
                            Select a sensing element from the top dropdown to render its full chronological curve.
                        </div>
                    )}
                </div>
            </div>
        );

        return createPortal(chronoOverlay, document.body);
    }

    return (
        <motion.div className="aroma-analysis-container" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
            <div className="aroma-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div className="icon-wrapper">
                        <Activity size={18} color="#f59e0b" />
                    </div>
                    <h1 className="page-title">Baseline Drift & Recovery Tracker</h1>
                </div>
                {recoveryResults && recoveryResults.length > 0 && (
                    <div style={{ display: 'flex', gap: '10px' }}>
                        <button className="icon-btn" onClick={() => setShowChrono(true)} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', padding: '8px 16px', background: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.2)', borderRadius: '6px' }} title="Plot Trials in Chronological Sequence">
                            <LineChartIcon size={16} /> Chronological Plot
                        </button>
                        <button className="icon-btn" onClick={handleExportAllCSV} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', padding: '8px 16px', background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', border: '1px solid rgba(56, 189, 248, 0.2)', borderRadius: '6px' }} title="Download All Data as CSV">
                            <Download size={16} /> Export CSV
                        </button>
                    </div>
                )}
            </div>

            <div className="aroma-content">
                <div 
                    className="config-panel glass-panel" 
                    style={{ 
                        width: isSidebarVisible ? 340 : 0, 
                        opacity: isSidebarVisible ? 1 : 0,
                        overflowY: isSidebarVisible ? 'auto' : 'hidden', 
                        overflowX: 'hidden',
                        transition: 'all 0.4s cubic-bezier(0.33, 1, 0.68, 1)',
                        padding: isSidebarVisible ? '16px' : '16px 0',
                        borderWidth: isSidebarVisible ? '1px' : '0'
                    }}>
                    <div style={{ width: 340 - 32, opacity: isSidebarVisible ? 1 : 0, transition: 'opacity 0.2s', visibility: isSidebarVisible ? 'visible' : 'hidden' }}>
                    <h3 className="panel-title"><Settings size={16} /> Analysis Config</h3>

                    <div className="form-group">
                        <label>Target Sensors (A1, A2, or CHR0, CHR1, …)</label>
                        <input
                            type="text"
                            className="text-input"
                            value={sensingElements}
                            onChange={e => setSensingElements(e.target.value)}
                            title="ASU grid uses A1–H8. SiAC32-V2 workspace captures auto-fill CHR0–CHR31 when the CSV has CHR/RRF columns."
                        />
                    </div>

                    <div className="form-group" style={{ marginBottom: '16px' }}>
                        <label>Relative Humidity / Temp Columns</label>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <input
                                type="text"
                                className="text-input"
                                value={humCols}
                                onChange={e => setHumCols(e.target.value)}
                                placeholder="RH (e.g. AQH0)"
                                title="Relative Humidity %"
                            />
                            <input
                                type="text"
                                className="text-input"
                                value={tempCols}
                                onChange={e => setTempCols(e.target.value)}
                                placeholder="Temp (e.g. AQT0)"
                                title="Temperature °C"
                            />
                        </div>
                    </div>

                    <div className="form-group" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
                        <div>
                            <label style={{ fontSize: '0.75rem' }}>Exposure Keyword</label>
                            <input
                                type="text"
                                className="text-input"
                                value={exposureKeyword}
                                onChange={e => setExposureKeyword(e.target.value)}
                                placeholder="Auto (FeNO measurement, not window)"
                                title="Empty = auto: FeNOMeasurement and similar challenge phases; FeNOWindow is excluded. Use a substring (e.g. measurement) or fenowindow to target a phase explicitly."
                                style={{ padding: '6px' }}
                            />
                        </div>
                        <div>
                            <label style={{ fontSize: '0.75rem' }}>Recovery Keyword</label>
                            <input
                                type="text"
                                className="text-input"
                                value={recoveryKeyword}
                                onChange={e => setRecoveryKeyword(e.target.value)}
                                placeholder="recovery"
                                style={{ padding: '6px' }}
                            />
                        </div>
                    </div>

                    <div className="form-group" style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px', background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '8px' }}>
                        <input
                            type="checkbox"
                            checked={ignoreHardwareRecovery}
                            onChange={(e) => setIgnoreHardwareRecovery(e.target.checked)}
                            id="ignore-recovery-chk"
                            style={{ width: 14, height: 14, accentColor: '#f59e0b', cursor: 'pointer', flexShrink: 0, marginTop: '2px' }}
                        />
                        <label htmlFor="ignore-recovery-chk" style={{ margin: 0, cursor: 'pointer', fontSize: '0.75rem', lineHeight: 1.4, color: '#e2e8f0' }}>
                            <strong>Mux Disabled During Recovery</strong> <br />
                            <span style={{ color: '#94a3b8' }}>Skips the recovery event block and uses the subsequent trial's start block to measure drift.</span>
                        </label>
                    </div>

                    <div className="form-group" style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '16px', background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '8px' }}>
                        <input
                            type="checkbox"
                            checked={filterUnknown}
                            onChange={(e) => setFilterUnknown(e.target.checked)}
                            id="filter-unknown-chk"
                            style={{ width: 14, height: 14, accentColor: '#f59e0b', cursor: 'pointer', flexShrink: 0, marginTop: '2px' }}
                        />
                        <label htmlFor="filter-unknown-chk" style={{ margin: 0, cursor: 'pointer', fontSize: '0.75rem', lineHeight: 1.4, color: '#e2e8f0' }}>
                            <strong>No Unknowns</strong> <br />
                            <span style={{ color: '#94a3b8' }}>Ignores files that are not “known” plots: ppb/ppm in the name, raw ASU-style CSVs, catalog paths, in-file concentration columns, or SiAC32-V2 serial captures (CHR/RRF rows).</span>
                        </label>
                    </div>

                    <button className="process-btn" onClick={handleProcessRecovery} disabled={isProcessing} style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}>
                        {isProcessing ? 'Analyzing Recovery...' : 'Analyze baseline drift'}
                    </button>
                    </div>
                </div>

                <div className="plots-panel">
                    {!recoveryResults ? (
                        <div className="empty-state">
                            <Activity size={48} color="#334155" />
                            <p>Configure settings and click "Analyze baseline drift" to generate chronological drift & recovery plots.</p>
                        </div>
                    ) : recoveryResults.length === 0 ? (
                        <div className="empty-state">
                            {driftInputError ? (
                                <p style={{ color: '#f59e0b', maxWidth: 520, textAlign: 'center', lineHeight: 1.5 }}>{driftInputError}</p>
                            ) : (
                                <p style={{ color: '#ef4444' }}>No exposure trials found in the loaded files.</p>
                            )}
                        </div>
                    ) : (
                        <div className="results-wrapper" style={{ overflowY: 'auto', paddingRight: 10 }}>
                            {recoveryResults.map((resultBatch, bIdx) => (
                                <div key={bIdx} style={{ marginBottom: 40 }}>
                                    <h2 style={{ fontSize: '1rem', color: '#f8fafc', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid #334155' }}>
                                        File: <span style={{ color: '#38bdf8' }}>{resultBatch.fileName}</span> ({resultBatch.trialsCount} Trails found)
                                    </h2>

                                    <div className="grid-plot-container">
                                        {Object.keys(resultBatch.sensorPlots).map((sensorName, sIdx) => {
                                            const sensorObj = resultBatch.sensorPlots[sensorName];
                                            if (sensorObj.data.length === 0) return null;

                                            const dataVals = sensorObj.data.map(d => d.baselineValue);
                                            const recVals = sensorObj.data.map(d => d.recoveryValue).filter(v => v > 0);
                                            const minR = Math.min(...dataVals);
                                            const maxR = Math.max(...dataVals);
                                            const deltaR = maxR - minR;
                                            const pctDrift = Math.abs(minR) > 0 ? ((deltaR / Math.abs(minR)) * 100).toFixed(1) : 0;

                                            const minRec = recVals.length > 0 ? Math.min(...recVals) : 0;
                                            const maxRec = recVals.length > 0 ? Math.max(...recVals) : 0;
                                            const deltaRec = maxRec - minRec;
                                            const pctRecDrift = Math.abs(minRec) > 0 ? ((deltaRec / Math.abs(minRec)) * 100).toFixed(1) : 0;

                                            const maxRh = Math.max(...sensorObj.data.map(d => d.relHumidity));
                                            const minRh = Math.min(...sensorObj.data.map(d => d.relHumidity));
                                            const deltaRh = maxRh - minRh;

                                            const maxTc = Math.max(...sensorObj.data.map(d => d.temperature));
                                            const minTc = Math.min(...sensorObj.data.map(d => d.temperature));
                                            const deltaTc = maxTc - minTc;

                                            const plotId = `rec_plot_${bIdx}_${sIdx}`;

                                            return (
                                                <div key={sensorName} className="grid-plot-item glass-panel" id={plotId}>
                                                    <div className="grid-plot-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                                            <h4 style={{ margin: 0, fontSize: '0.85rem', color: '#e2e8f0', display: 'flex', alignItems: 'center', gap: 6 }}>
                                                                {sensorName} <span style={{ color: '#94a3b8', fontSize: '0.7rem' }}>Drift & Recovery Map</span>
                                                            </h4>
                                                            <span style={{ fontSize: '0.75rem', color: '#f59e0b', fontWeight: 500 }}>
                                                                ΔR Base: {deltaR.toFixed(3)} Ω ({pctDrift}%) {deltaRec > 0 ? `| ΔR Rec: ${deltaRec.toFixed(3)} Ω (${pctRecDrift}%)` : ''} | ΔRH: {deltaRh.toFixed(1)}% | ΔT: {deltaTc.toFixed(1)}°C
                                                            </span>
                                                        </div>
                                                        <div style={{ display: 'flex', gap: 4 }}>
                                                            <button type="button" className="icon-btn small" onClick={() => handleDownloadPng(plotId)} title="Download plot as PNG">
                                                                <Download size={14} />
                                                            </button>
                                                            <button type="button" className="icon-btn small" onClick={() => setSelectedPlot({ ...sensorObj, title: `${resultBatch.fileName} - ${sensorName}` })}>
                                                                <Maximize2 size={14} />
                                                            </button>
                                                        </div>
                                                    </div>

                                                    <div style={{ height: 260, width: '100%' }}>
                                                        <ResponsiveContainer width="100%" height="100%">
                                                            <LineChart data={sensorObj.data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                                                                <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                                                <XAxis dataKey="trial" tick={{ fontSize: 10, fill: '#64748b' }} stroke="#334155" />

                                                                <YAxis
                                                                    yAxisId="left"
                                                                    tick={{ fontSize: 10, fill: '#38bdf8' }}
                                                                    stroke="#334155"
                                                                    domain={['auto', 'auto']}
                                                                    label={{ value: 'Baseline Avg (Ohms)', angle: -90, position: 'insideLeft', fill: '#38bdf8', fontSize: 10 }}
                                                                />

                                                                <YAxis
                                                                    yAxisId="right"
                                                                    orientation="right"
                                                                    tick={{ fontSize: 10, fill: '#eab308' }}
                                                                    stroke="#334155"
                                                                    domain={['auto', 'auto']}
                                                                    label={{ value: 'Absolute Humidity', angle: 90, position: 'insideRight', fill: '#eab308', fontSize: 10 }}
                                                                />

                                                                <RechartsTooltip
                                                                    cursor={false}
                                                                    wrapperStyle={{ outline: 'none' }}
                                                                    contentStyle={{ backgroundColor: 'rgba(0, 0, 0, 0)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: 'none', borderRadius: '12px', padding: '12px', boxShadow: 'none' }}
                                                                    itemStyle={{ fontSize: '11px', padding: '2px 0' }}
                                                                    labelStyle={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, marginBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '4px' }}
                                                                    formatter={(value, name) => {
                                                                        if (name === 'concentration') return [value, 'Concentration'];
                                                                        return [value, name];
                                                                    }}
                                                                />
                                                                <Legend wrapperStyle={{ fontSize: '0.7rem' }} />

                                                                {/* Hidden lines to just get attributes in the tooltip */}
                                                                <Line type="monotone" dataKey="concentration" name="concentration" stroke="none" activeDot={false} dot={false} />

                                                                {/* Lines */}
                                                                <Line yAxisId="left" type="monotone" dataKey="baselineValue" name="Baseline Avg (Ohms)" stroke="#38bdf8" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={true} />
                                                                <Line yAxisId="left" type="monotone" dataKey="recoveryValue" name="Recovery Avg (Ohms)" stroke="#10b981" strokeWidth={2} strokeDasharray="5 5" dot={{ r: 3 }} isAnimationActive={true} />
                                                                <Line yAxisId="right" type="monotone" dataKey="humidity" name="Ab. Humidity" stroke="#eab308" strokeWidth={1} dot={{ r: 2 }} opacity={0.5} isAnimationActive={true} />
                                                            </LineChart>
                                                        </ResponsiveContainer>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Maximized Modal Plot */}
            {selectedPlot && (() => {
                const dataVals = selectedPlot.data.map(d => d.baselineValue);
                const minR = Math.min(...dataVals);
                const maxR = Math.max(...dataVals);
                const deltaR = maxR - minR;
                const pctDrift = Math.abs(minR) > 0 ? ((deltaR / Math.abs(minR)) * 100).toFixed(1) : 0;

                const maxRh = Math.max(...selectedPlot.data.map(d => d.relHumidity));
                const minRh = Math.min(...selectedPlot.data.map(d => d.relHumidity));
                const deltaRh = maxRh - minRh;

                const maxTc = Math.max(...selectedPlot.data.map(d => d.temperature));
                const minTc = Math.min(...selectedPlot.data.map(d => d.temperature));
                const deltaTc = maxTc - minTc;

                const recVals = selectedPlot.data.map(d => d.recoveryValue).filter(v => v > 0);
                const minRec = recVals.length > 0 ? Math.min(...recVals) : 0;
                const maxRec = recVals.length > 0 ? Math.max(...recVals) : 0;
                const deltaRec = maxRec - minRec;
                const pctRecDrift = Math.abs(minRec) > 0 ? ((deltaRec / Math.abs(minRec)) * 100).toFixed(1) : 0;

                return (
                    <div className="modal-overlay" onClick={() => setSelectedPlot(null)} style={{ zIndex: 9999 }}>
                        <div
                            className="zoomable-plot-modal glass-panel"
                            onClick={(e) => e.stopPropagation()}
                            style={{
                                pointerEvents: 'auto',
                                width: '90%',
                                height: 'calc(85vh - var(--auth-session-bar-height, 0px))',
                                maxHeight: 'calc(85dvh - var(--auth-session-bar-height, 0px))',
                                display: 'flex',
                                flexDirection: 'column',
                            }}
                        >
                            <div className="modal-header" style={{ flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    <h3 style={{ margin: 0 }}>{selectedPlot.title}</h3>
                                    <span style={{ fontSize: '0.9rem', color: '#f59e0b', fontWeight: 600 }}>
                                        ΔR Base: {deltaR.toFixed(3)} Ω ({pctDrift}% Drift) {deltaRec > 0 ? `| ΔR Rec: ${deltaRec.toFixed(3)} Ω (${pctRecDrift}%)` : ''} | ΔRH: {deltaRh.toFixed(1)}% | ΔT: {deltaTc.toFixed(1)}°C
                                    </span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(0,0,0,0.2)', padding: '4px 10px', borderRadius: 6, marginRight: 20 }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#e2e8f0', fontSize: '0.80rem', cursor: 'pointer' }}>
                                        <input type="radio" name="maxPlotEnvMetric" checked={maxPlotEnvMetric === 'none'} onChange={() => setMaxPlotEnvMetric('none')} style={{ accentColor: '#94a3b8' }} /> None
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#eab308', fontSize: '0.80rem', cursor: 'pointer' }}>
                                        <input type="radio" name="maxPlotEnvMetric" checked={maxPlotEnvMetric === 'absHumidity'} onChange={() => setMaxPlotEnvMetric('absHumidity')} style={{ accentColor: '#eab308' }} /> Abs. Hum
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#10b981', fontSize: '0.80rem', cursor: 'pointer' }}>
                                        <input type="radio" name="maxPlotEnvMetric" checked={maxPlotEnvMetric === 'relHumidity'} onChange={() => setMaxPlotEnvMetric('relHumidity')} style={{ accentColor: '#10b981' }} /> Rel. Hum
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ef4444', fontSize: '0.80rem', cursor: 'pointer' }}>
                                        <input type="radio" name="maxPlotEnvMetric" checked={maxPlotEnvMetric === 'temperature'} onChange={() => setMaxPlotEnvMetric('temperature')} style={{ accentColor: '#ef4444' }} /> Temp
                                    </label>
                                </div>
                                <button className="icon-btn close-btn" onClick={() => setSelectedPlot(null)}>
                                    <X size={24} />
                                </button>
                            </div>
                            <div className="modal-body" style={{ flex: 1, position: 'relative', width: '100%' }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={selectedPlot.data} margin={{ top: 30, right: 50, left: 30, bottom: 30 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                        <XAxis dataKey="trial" tick={{ fill: '#94a3b8' }} stroke="#334155" />
                                        <YAxis yAxisId="left" tick={{ fill: '#38bdf8' }} stroke="#334155" domain={['auto', 'auto']} label={{ value: 'Baseline Avg (Ohms)', angle: -90, position: 'insideLeft', fill: '#38bdf8' }} />
                                        {maxPlotEnvMetric === 'absHumidity' && (
                                            <YAxis yAxisId="right" orientation="right" tick={{ fill: '#eab308' }} stroke="#334155" domain={['auto', 'auto']} label={{ value: 'Absolute Humidity (g/m³)', angle: 90, position: 'insideRight', fill: '#eab308' }} />
                                        )}
                                        {maxPlotEnvMetric === 'relHumidity' && (
                                            <YAxis yAxisId="right" orientation="right" tick={{ fill: '#10b981' }} stroke="#334155" domain={['auto', 'auto']} label={{ value: 'Relative Humidity (%)', angle: 90, position: 'insideRight', fill: '#10b981' }} />
                                        )}
                                        {maxPlotEnvMetric === 'temperature' && (
                                            <YAxis yAxisId="right" orientation="right" tick={{ fill: '#ef4444' }} stroke="#334155" domain={['auto', 'auto']} label={{ value: 'Temperature (°C)', angle: 90, position: 'insideRight', fill: '#ef4444' }} />
                                        )}

                                        <RechartsTooltip
                                            cursor={false}
                                            wrapperStyle={{ outline: 'none' }}
                                            contentStyle={{ backgroundColor: 'rgba(0, 0, 0, 0)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: 'none', borderRadius: '12px', padding: '16px' }}
                                            itemStyle={{ fontSize: '13px', padding: '4px 0' }}
                                            labelStyle={{ color: '#94a3b8', fontSize: '14px', fontWeight: 600, marginBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '4px' }}
                                            formatter={(value, name) => {
                                                if (name === 'concentration') return [value, 'Concentration'];
                                                if (name === 'Ab. Humidity') return [Number(value).toFixed(2) + ' g/m³', 'Environment'];
                                                if (name === 'Rel. Humidity') return [Number(value).toFixed(2) + ' %', 'Environment'];
                                                if (name === 'Temperature') return [Number(value).toFixed(2) + ' °C', 'Environment'];
                                                return [value, name];
                                            }}
                                        />
                                        <Legend wrapperStyle={{ fontSize: '0.9rem', bottom: 0 }} />

                                        {/* Hidden lines to just get attributes in the tooltip */}
                                        <Line type="monotone" dataKey="concentration" name="concentration" stroke="none" activeDot={false} dot={false} isAnimationActive={false} />

                                        <Line yAxisId="left" type="monotone" dataKey="baselineValue" name="Baseline Avg (Ohms)" stroke="#38bdf8" strokeWidth={3} dot={{ r: 5 }} activeDot={{ r: 8 }} isAnimationActive={false} />
                                        <Line yAxisId="left" type="monotone" dataKey="recoveryValue" name="Recovery Avg (Ohms)" stroke="#10b981" strokeWidth={3} strokeDasharray="8 8" dot={{ r: 5 }} activeDot={{ r: 8 }} isAnimationActive={false} />
                                        {maxPlotEnvMetric === 'absHumidity' && (
                                            <Line yAxisId="right" type="monotone" dataKey="humidity" name="Ab. Humidity" stroke="#eab308" strokeWidth={1.5} dot={{ r: 3 }} activeDot={{ r: 6 }} opacity={0.6} isAnimationActive={false} />
                                        )}
                                        {maxPlotEnvMetric === 'relHumidity' && (
                                            <Line yAxisId="right" type="monotone" dataKey="relHumidity" name="Rel. Humidity" stroke="#10b981" strokeWidth={1.5} dot={{ r: 3 }} activeDot={{ r: 6 }} opacity={0.6} isAnimationActive={false} />
                                        )}
                                        {maxPlotEnvMetric === 'temperature' && (
                                            <Line yAxisId="right" type="monotone" dataKey="temperature" name="Temperature" stroke="#ef4444" strokeWidth={1.5} dot={{ r: 3 }} activeDot={{ r: 6 }} opacity={0.6} isAnimationActive={false} />
                                        )}
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    </div>
                );
            })()}
        </motion.div>
    );
};

export default RecoveryAnalysisPage;
