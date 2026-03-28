import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import {
    ResponsiveContainer,
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ReferenceLine,
    ReferenceArea,
    Brush
} from 'recharts';
import { AlertCircle, Activity, RotateCcw, Target, Layers, Copy, Image as ImageIcon, Droplets } from 'lucide-react';
import { motion } from 'framer-motion';
import { toPng } from 'html-to-image';
import { isKnownPlotFile, parseConcentrationMetaFromFile } from '../utils/workspaceFilename';
import './NormalizePage.css';

/* Extended Palette for multi-file comparison */
const PALETTE = [
    '#38bdf8', '#fbbf24', '#34d399', '#f472b6', '#a78bfa', '#f87171', '#60a5fa', '#c084fc',
    '#2dd4bf', '#fb923c', '#4ade80', '#e879f9', '#818cf8', '#fca5a5', '#94a3b8', '#a3e635'
];

/** Stable color from file path when no concentration meta (avoids collisions with conc palette) */
const UNCATEGORIZED_PALETTE = ['#64748b', '#78716c', '#52525b', '#71717a', '#57534e'];

function hashString(s) {
    let h = 0;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i);
    return Math.abs(h);
}

/* ── Helpers ──────────────────────────────────────────────────────── */
/* Returns date/time column if present, else null (caller uses index 1,2,3...) */
function detectXKey(row) {
    if (!row) return null;
    const keys = Object.keys(row);
    return keys.find(k => {
        const low = k.toLowerCase();
        return low.includes('date') || low.includes('time') || low.includes('stamp') || low.includes('createat') || low.includes('created');
    }) || null;
}

function shortName(fileName = '') {
    return fileName.replace(/\.[^/.]+$/, '').slice(0, 12);
}

/** Same ranking as Dashboard ChartArea — finds event/phase column for recovery filtering */
function findEventColumn(sampleRow) {
    if (!sampleRow || typeof sampleRow !== 'object') return null;
    const keys = Object.keys(sampleRow);
    const ranked = keys
        .map((col) => {
            const l = col.toLowerCase();
            let score = 0;
            if (l === 'event_name' || l === 'phase' || l === 'mode' || l === 'state') score = 100;
            else if (l === 'event' || l === 'events' || l.endsWith('_phase') || l.endsWith('_event')) score = 85;
            else if (l.includes('event') && !l.includes('reference')) score = 70;
            else if (l.includes('phase') && !l.includes('reference')) score = 55;
            return { col, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
    return ranked[0]?.col ?? null;
}

function parseConcentrationMeta(fileName, data = null) {
    return parseConcentrationMetaFromFile(fileName, data);
}

function extractConcentration(fileName = '', data = null) {
    const meta = parseConcentrationMeta(fileName, data);
    return meta ? meta.label : null;
}

function sortConcentrationOptions(options) {
    const unitRank = { ppb: 0, ppm: 1 };
    return [...options].sort((a, b) => {
        if (a.numericValue !== b.numericValue) return a.numericValue - b.numericValue;
        return (unitRank[a.unit] ?? 2) - (unitRank[b.unit] ?? 2);
    });
}

/** When concentration toggles exist, file must match a selected key; unlabeled files always pass */
function fileMatchesSelectedConcentrations(fileName, fileData, selectedSet, filteringActive) {
    if (!filteringActive) return true;
    const meta = parseConcentrationMeta(fileName, fileData);
    if (!meta) return true;
    return selectedSet.has(meta.key);
}

function getLineLabel(fileName, key, fileData = null) {
    const conc = extractConcentration(fileName, fileData);
    if (conc) return `${conc} - ${key}`;
    return `${shortName(fileName)} - ${key}`;
}

/* ── Custom tooltip ────────────────────────────────────────────────── */
const NormalizeTooltip = ({ active, payload, label, isNormalized }) => {
    if (!active || !payload || !payload.length) return null;

    // Find event name from original row, if available
    let eventNameValue = null;
    if (payload[0] && payload[0].payload) {
        const row = payload[0].payload;
        // Search columns commonly used for event labels
        const eventKey = Object.keys(row).find(k => {
            const str = k.toLowerCase();
            return str === 'event' || str.includes('event_name') || str.includes('phase') || str.includes('mode') || str.includes('annotation');
        });

        if (eventKey && row[eventKey] !== undefined && row[eventKey] !== null) {
            let val = String(row[eventKey]).trim();
            // Prevent massive raw JSON dumps from bleeding into the UI badge
            if (!val.startsWith('{') && val.length < 45 && val !== '') {
                eventNameValue = val;
            }
        }
    }

    return (
        <div style={{
            background: 'rgba(15,23,42,0.05)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: '0.8rem',
            pointerEvents: 'none',
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
            maxHeight: 320,
            overflowY: 'auto',
            maxWidth: 320,
            zIndex: 50
        }}>
            <div style={{ color: '#94a3b8', marginBottom: 6, fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.07)', paddingBottom: 4, display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
                <span>{String(label)}</span>
                {eventNameValue && (
                    <span style={{ color: '#10b981' }}>{eventNameValue}</span>
                )}
            </div>
            {payload.map((entry, i) => {
                // Remove the cmpX_ prefix from the tooltip name for clean display
                let displayName = entry.name;
                if (typeof displayName === 'string' && displayName.startsWith('cmp')) {
                    const match = displayName.match(/^cmp\d+_(.*)/);
                    if (match) displayName = match[1];
                }
                return (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, color: entry.color, marginBottom: 3, alignItems: 'center' }}>
                        <span style={{ opacity: 0.9, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: 180, fontSize: '0.76rem' }}>
                            {displayName}
                        </span>
                        <strong style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                            {isNormalized
                                ? `${entry.value >= 0 ? '+' : ''}${(entry.value * 100).toFixed(2)}%`
                                : typeof entry.value === 'number' ? entry.value.toFixed(3) : entry.value}
                        </strong>
                    </div>
                );
            })}
        </div>
    );
};

/* ── Main component ────────────────────────────────────────────────── */
const NormalizePage = ({ data, fileName, compareDataList = [] }) => {
    const [removeRecoveryEvents, setRemoveRecoveryEvents] = useState(true);
    const [filterUnknown, setFilterUnknown] = useState(true);
    const [selectedConcentrationKeys, setSelectedConcentrationKeys] = useState([]);

    const isKnownFile = (fName, fileData = null) => {
        if (!filterUnknown) return true;
        if (!fName) return false;
        return isKnownPlotFile(fName, fileData);
    };

    /* Unique concentrations across main + compare (filename or in-file columns) */
    const concentrationOptions = useMemo(() => {
        const map = new Map();
        const add = (fn, fd) => {
            const meta = parseConcentrationMeta(fn, fd);
            if (meta && !map.has(meta.key)) map.set(meta.key, meta);
        };
        if (fileName) add(fileName, data);
        (compareDataList || []).forEach((c) => add(c?.fileName, c?.data));
        return sortConcentrationOptions(Array.from(map.values()));
    }, [fileName, data, compareDataList]);

    const concOptionKeysSig = useMemo(
        () => concentrationOptions.map((o) => o.key).sort().join(','),
        [concentrationOptions]
    );

    const workspaceSignature = useMemo(() => {
        const parts = [];
        if (fileName) parts.push(fileName);
        (compareDataList || []).forEach((c) => {
            if (c?.fileName) parts.push(c.fileName);
        });
        return parts.sort().join('\n');
    }, [fileName, compareDataList]);

    /* New workspace or new concentration in folder: keep prior selection where possible; default new keys on */
    useEffect(() => {
        setSelectedConcentrationKeys((prev) => {
            const allKeys = concentrationOptions.map((o) => o.key);
            if (allKeys.length === 0) return prev.length === 0 ? prev : [];
            const allSet = new Set(allKeys);
            const kept = prev.filter((k) => allSet.has(k));
            const added = allKeys.filter((k) => !kept.includes(k));
            const next = prev.length === 0 ? allKeys : [...kept, ...added];
            if (prev.length === next.length && prev.every((k, i) => k === next[i])) return prev;
            return next;
        });
    }, [workspaceSignature, concOptionKeysSig]);

    const selectedConcSet = useMemo(
        () => new Set(selectedConcentrationKeys),
        [selectedConcentrationKeys.join('\0')]
    );

    const concFilterActive = concentrationOptions.length > 0;

    /** Same concentration label → same stroke (main + compare), independent of file order */
    const concKeyToColor = useMemo(() => {
        const m = new Map();
        concentrationOptions.forEach((o, i) => {
            m.set(o.key, PALETTE[i % PALETTE.length]);
        });
        return m;
    }, [concentrationOptions]);

    const strokeForWorkspaceFile = useCallback(
        (fn, fd) => {
            const meta = parseConcentrationMeta(fn, fd);
            if (meta && concKeyToColor.has(meta.key)) return concKeyToColor.get(meta.key);
            const h = hashString(fn || '');
            return UNCATEGORIZED_PALETTE[h % UNCATEGORIZED_PALETTE.length];
        },
        [concKeyToColor]
    );

    /**
     * Main (sidebar) first, then compares — same order as the workspace.
     * First entry that passes known-file + concentration filters becomes the chart "main";
     * the rest are compares. Fixes empty plot when sidebar main is e.g. 10 ppb toggled off
     * but 5 ppb / 100 ppb compare files are still selected.
     */
    const eligibleWorkspaceFiles = useMemo(() => {
        const out = [];
        const pushIfOk = (fn, fileData) => {
            if (!fileData?.length || !fn) return;
            if (filterUnknown && !isKnownFile(fn, fileData)) return;
            if (!fileMatchesSelectedConcentrations(fn, fileData, selectedConcSet, concFilterActive)) return;
            out.push({ fileName: fn, data: fileData });
        };
        pushIfOk(fileName, data);
        (compareDataList || []).forEach((c) => pushIfOk(c?.fileName, c?.data));
        return out;
    }, [data, fileName, compareDataList, filterUnknown, selectedConcSet, concFilterActive]);

    const plotMainFileName = eligibleWorkspaceFiles[0]?.fileName ?? fileName ?? '';
    const activeData = eligibleWorkspaceFiles[0]?.data ?? [];
    /** Must be memoized: .slice(1) each render was a new array → cmpFiles/prefixedKeysMap churn → visibleSeries effect #185 loop */
    const activeCompareList = useMemo(
        () => eligibleWorkspaceFiles.slice(1),
        [eligibleWorkspaceFiles]
    );

    const toggleConcentrationKey = useCallback((key) => {
        setSelectedConcentrationKeys((prev) =>
            prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
        );
    }, []);

    const selectAllConcentrations = useCallback(() => {
        setSelectedConcentrationKeys(concentrationOptions.map((o) => o.key));
    }, [concentrationOptions]);

    const clearAllConcentrations = useCallback(() => {
        setSelectedConcentrationKeys([]);
    }, []);

    /* ── 1. Prepare Main Data ── */
    const { xKey, seriesKeys, chartData } = useMemo(() => {
        if (!activeData || activeData.length === 0) return { xKey: '', seriesKeys: [], chartData: [] };

        // Filter out recovery phase if checked
        let processedData = activeData;
        const keys = Object.keys(activeData[0]);
        const eventCol = findEventColumn(activeData[0]);
        if (removeRecoveryEvents && eventCol) {
            processedData = activeData.filter((row) => {
                const eNorm = String(row[eventCol] ?? '').toLowerCase().replace(/\s+/g, '');
                return !eNorm.includes('recovery');
            });
        }

        if (!processedData || processedData.length === 0) return { xKey: '', seriesKeys: [], chartData: [] };

        const x = detectXKey(processedData[0]);
        if (x) {
            const series = Object.keys(processedData[0]).filter(k => k !== x && k.toLowerCase() !== 'index' && typeof processedData[0][k] === 'number');
            return { xKey: x, seriesKeys: series, chartData: processedData };
        }
        const series = Object.keys(processedData[0]).filter(k => k.toLowerCase() !== 'index' && typeof processedData[0][k] === 'number');
        const chartDataWithIndex = processedData.map((row, i) => ({ ...row, index: i + 1 }));
        return { xKey: 'index', seriesKeys: series, chartData: chartDataWithIndex };
    }, [activeData, removeRecoveryEvents]);

    /* ── 2. Prepare Compare Data List ── */
    const cmpFiles = useMemo(() => {
        if (!activeCompareList || activeCompareList.length === 0) return [];
        return activeCompareList.map((file, idx) => {
            if (!file?.data || file.data.length === 0) return null;

            // Filter out recovery phase if checked
            let processedData = file.data;
            const eventCol = findEventColumn(file.data[0]);
            if (removeRecoveryEvents && eventCol) {
                processedData = file.data.filter((row) => {
                    const eNorm = String(row[eventCol] ?? '').toLowerCase().replace(/\s+/g, '');
                    return !eNorm.includes('recovery');
                });
            }

            if (!processedData || processedData.length === 0) return null;

            const x = detectXKey(processedData[0]);
            if (x) {
                const series = Object.keys(processedData[0]).filter(k => k !== x && k.toLowerCase() !== 'index' && typeof processedData[0][k] === 'number');
                return { id: idx, fileName: file.fileName, shortName: shortName(file.fileName), xKey: x, seriesKeys: series, data: processedData };
            }
            const series = Object.keys(processedData[0]).filter(k => k.toLowerCase() !== 'index' && typeof processedData[0][k] === 'number');
            const dataWithIndex = processedData.map((row, i) => ({ ...row, index: i + 1 }));
            return { id: idx, fileName: file.fileName, shortName: shortName(file.fileName), xKey: 'index', seriesKeys: series, data: dataWithIndex };
        }).filter(Boolean);
    }, [activeCompareList, removeRecoveryEvents]);

    const hasCompare = cmpFiles.length > 0;

    /* ── 3. Identify Common Columns (Intersection) ── */
    const commonColumns = useMemo(() => {
        if (!hasCompare) return [];
        // Start with main series
        let common = new Set(seriesKeys);
        // Intersect with each compare file
        cmpFiles.forEach(f => {
            const fileSet = new Set(f.seriesKeys);
            common = new Set([...common].filter(x => fileSet.has(x)));
        });
        return Array.from(common).sort();
    }, [seriesKeys, cmpFiles, hasCompare]);

    /* ── 4. Merge Data (Index-Aligned) ── */
    /*
       Key Format:
       Main: "key"
       Cmp[i]: "shortName::key"  (using double colon to reduce collision probability)
    */
    const prefixedKeysMap = useMemo(() => {
        const map = {}; // fileIndex -> { original -> prefixed }
        cmpFiles.forEach((f, idx) => {
            map[idx] = {};
            f.seriesKeys.forEach(k => {
                map[idx][k] = `cmp${idx}_${f.shortName}::${k}`;
            });
        });
        return map;
    }, [cmpFiles]);

    const mergedData = useMemo(() => {
        if (!hasCompare) return chartData;

        // Find max length among all files
        let maxLen = chartData.length;
        cmpFiles.forEach(f => {
            if (f.data.length > maxLen) maxLen = f.data.length;
        });

        // Create merged rows
        return Array.from({ length: maxLen }, (_, i) => {
            const row = {};

            // Main file data
            if (i < chartData.length) {
                Object.assign(row, chartData[i]);
            } else {
                row[xKey] = xKey === 'index' ? i + 1 : i;
                seriesKeys.forEach(k => { row[k] = null; });
            }

            // Compare files data
            cmpFiles.forEach((f, idx) => {
                const prefixMap = prefixedKeysMap[idx];
                if (i < f.data.length) {
                    f.seriesKeys.forEach(k => {
                        row[prefixMap[k]] = f.data[i][k];
                    });
                } else {
                    f.seriesKeys.forEach(k => {
                        row[prefixMap[k]] = null;
                    });
                }
            });

            return row;
        });
    }, [chartData, cmpFiles, seriesKeys, xKey, prefixedKeysMap, hasCompare]);


    /* ── 5. All Display Keys ── */
    const allDisplayKeys = useMemo(() => {
        let keys = [...seriesKeys];
        cmpFiles.forEach((f, idx) => {
            f.seriesKeys.forEach(k => {
                keys.push(prefixedKeysMap[idx][k]);
            });
        });
        return keys;
    }, [seriesKeys, cmpFiles, prefixedKeysMap]);

    /* ── 6. Visible Series State ── */
    /* Default: first 4 from main file */
    const [visibleSeries, setVisibleSeries] = useState([]);

    // Initialize on load or when file selection changes
    useEffect(() => {
        setVisibleSeries(prevVisible => {
            const stillValidBase = prevVisible.some(k => seriesKeys.includes(k));

            if (prevVisible.length === 0 || (!stillValidBase && seriesKeys.length > 0)) {
                // Identifies common columns across main and all compare files
                let common = seriesKeys;
                if (cmpFiles.length > 0) {
                    const allSets = [new Set(seriesKeys), ...cmpFiles.map(f => new Set(f.seriesKeys))];
                    common = seriesKeys.filter(k => allSets.every(s => s.has(k)));
                }

                // If common columns exist, select only 1 of them for ALL files by default
                if (common.length > 0) {
                    const initial = [];
                    const cols = common.slice(0, 1);
                    cols.forEach(c => {
                        initial.push(c); // Main
                        cmpFiles.forEach((f, idx) => {
                            // prefixedKeysMap is stable as it depends on cmpFiles
                            if (prefixedKeysMap[idx] && prefixedKeysMap[idx][c]) {
                                initial.push(prefixedKeysMap[idx][c]);
                            }
                        });
                    });
                    return initial;
                } else {
                    // Fallback: Just main file keys
                    return seriesKeys.slice(0, 1);
                }
            } else {
                // Preserve previous selections and fold in any new comparison file's equivalents
                const baseNames = new Set();
                prevVisible.forEach(key => {
                    if (seriesKeys.includes(key)) {
                        baseNames.add(key);
                    } else {
                        Object.values(prefixedKeysMap).forEach(map => {
                            const entry = Object.entries(map).find(([orig, prefixed]) => prefixed === key);
                            if (entry) baseNames.add(entry[0]);
                        });
                    }
                });

                const newVisible = new Set(prevVisible.filter(k => {
                    if (seriesKeys.includes(k)) return true;
                    let isKnownCompare = false;
                    Object.values(prefixedKeysMap).forEach(map => {
                        if (Object.values(map).includes(k)) isKnownCompare = true;
                    });
                    return isKnownCompare;
                }));

                baseNames.forEach(baseName => {
                    cmpFiles.forEach((f, idx) => {
                        if (prefixedKeysMap[idx] && prefixedKeysMap[idx][baseName]) {
                            newVisible.add(prefixedKeysMap[idx][baseName]);
                        }
                    });
                });

                return Array.from(newVisible);
            }
        });
    }, [seriesKeys.join(','), cmpFiles.length, prefixedKeysMap]);

    const toggleSeries = (key, isMulti = true) => {
        // 1. Identify the base column name
        let colName = key;

        // Check if it's a prefixed key (from comparison file)
        // Format: "ShortName::ColName" or just "ColName"
        // We need to reverse lookup or parse.
        // Since we don't have a direct reverse map easily accessible in this scope without searching,
        // we can iterate through prefixedKeysMap to find the colName.

        let found = false;
        // Check main series first
        if (seriesKeys.includes(key)) {
            colName = key;
            found = true;
        } else {
            // Check comparison maps
            Object.values(prefixedKeysMap).forEach(map => {
                const entry = Object.entries(map).find(([orig, prefixed]) => prefixed === key);
                if (entry) {
                    colName = entry[0];
                    found = true;
                }
            });
        }

        if (!found) return; // Should not happen

        // 2. Find ALL keys corresponding to this base column
        const keysToToggle = [];
        if (seriesKeys.includes(colName)) keysToToggle.push(colName);

        cmpFiles.forEach((f, idx) => {
            if (prefixedKeysMap[idx] && prefixedKeysMap[idx][colName]) {
                keysToToggle.push(prefixedKeysMap[idx][colName]);
            }
        });

        // 3. Determine new state
        // If the *clicked* key is currently active, we turn ALL off.
        // If the *clicked* key is inactive, we turn ALL on.
        const isClickActive = visibleSeries.includes(key);
        const shouldActivate = !isClickActive;

        setVisibleSeries(prev => {
            const current = new Set(prev);
            keysToToggle.forEach(k => {
                if (shouldActivate) current.add(k);
                else current.delete(k);
            });
            return Array.from(current);
        });
    };

    /* activateCommon: Show ONLY this column for ALL files (Exclusive Mode) */
    const activateCommon = (colName, isMulti = false) => {
        const keysToActive = [];

        // 1. Identify all keys corresponding to this column
        if (seriesKeys.includes(colName)) keysToActive.push(colName);

        cmpFiles.forEach((f, idx) => {
            // prefixedKeysMap is stable
            if (prefixedKeysMap[idx] && prefixedKeysMap[idx][colName]) {
                keysToActive.push(prefixedKeysMap[idx][colName]);
            }
        });

        if (keysToActive.length === 0) return;

        // 2. Update Selection
        if (isMulti) {
            // Toggle Logic (if holding Ctrl/Cmd)
            const allActive = keysToActive.every(k => visibleSeries.includes(k));
            if (allActive) {
                // If all are already active, remove them
                setVisibleSeries(prev => prev.filter(k => !keysToActive.includes(k)));
            } else {
                // Add them to existing selection
                setVisibleSeries(prev => [...new Set([...prev, ...keysToActive])]);
            }
        } else {
            // Exclusive Logic (default): Replace entire selection
            setVisibleSeries(keysToActive);
        }
    };


    /* ── Filter Logic ── */
    const [filterType, setFilterType] = useState('none'); // 'none', 'ma', 'gaussian'
    const [filterWindow, setFilterWindow] = useState(5); // Window size or Sigma * 2

    const filteredData = useMemo(() => {
        if (filterType === 'none' || filterWindow <= 1 || !mergedData.length) return mergedData;

        // Helper: Get numeric keys to filter
        // We filter ALL display keys (Main + Compare) to keep them synced
        const keysToFilter = allDisplayKeys;

        const result = new Array(mergedData.length);
        const len = mergedData.length;

        // 1. Moving Average (Centered)
        if (filterType === 'ma') {
            const half = Math.floor(filterWindow / 2);
            for (let i = 0; i < len; i++) {
                const row = { ...mergedData[i] };
                const start = Math.max(0, i - half);
                const end = Math.min(len, i + half + 1);
                const count = end - start;

                keysToFilter.forEach(key => {
                    if (typeof row[key] !== 'number') return;
                    let sum = 0;
                    let valid = 0;
                    for (let j = start; j < end; j++) {
                        const val = mergedData[j][key];
                        if (typeof val === 'number') {
                            sum += val;
                            valid++;
                        }
                    }
                    if (valid > 0) row[key] = sum / valid;
                });
                result[i] = row;
            }
        }
        // 2. Gaussian Smoothing (Simple Kernel)
        else if (filterType === 'gaussian') {
            // Sigma approx filterWindow / 4 for visual equivalence range
            const sigma = Math.max(0.5, filterWindow / 4);
            const radius = Math.ceil(sigma * 3);
            const kernel = [];
            let kSum = 0;
            for (let x = -radius; x <= radius; x++) {
                const g = Math.exp(-(x * x) / (2 * sigma * sigma));
                kernel.push(g);
                kSum += g;
            }
            // Normalize kernel
            const normKernel = kernel.map(v => v / kSum);

            for (let i = 0; i < len; i++) {
                const row = { ...mergedData[i] };
                keysToFilter.forEach(key => {
                    if (typeof row[key] !== 'number') return;
                    let sum = 0;
                    let wSum = 0;
                    for (let k = 0; k < normKernel.length; k++) {
                        const idx = i + (k - radius);
                        if (idx >= 0 && idx < len) {
                            const val = mergedData[idx][key];
                            if (typeof val === 'number') {
                                sum += val * normKernel[k];
                                wSum += normKernel[k];
                            }
                        }
                    }
                    if (wSum > 0) row[key] = sum / wSum;
                });
                result[i] = row;
            }
        } else {
            return mergedData;
        }

        return result;
    }, [mergedData, filterType, filterWindow, allDisplayKeys]);


    /* ── 7. Baseline / Normalization Logic ── */
    const [baselineLeft, setBaselineLeft] = useState(null);
    const [baselineRight, setBaselineRight] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragRight, setDragRight] = useState('');
    const [brushStartIdx, setBrushStartIdx] = useState(0);
    const [brushEndIdx, setBrushEndIdx] = useState(null);
    const [hoverLabel, setHoverLabel] = useState(null);
    const chartWrapperRef = useRef(null);

    const handleDownloadPng = async () => {
        const el = chartWrapperRef.current;
        if (!el) return;
        try {
            const dataUrl = await toPng(el, {
                backgroundColor: '#0f172a',
                pixelRatio: 2,
                style: { margin: 0, paddingRight: '20px' }
            });
            const link = document.createElement('a');
            link.download = `normalized_${plotMainFileName || fileName || 'chart'}.png`;
            link.href = dataUrl;
            link.click();
        } catch (err) {
            console.error('Download PNG failed:', err);
        }
    };

    /* Reset baseline only when the sidebar primary file, axis mode, or recovery trim changes — not when adding compares or toggling concentrations */
    useEffect(() => {
        setBaselineLeft(null);
        setBaselineRight(null);
        setIsDragging(false);
        setDragRight('');
        setBrushStartIdx(0);
        setBrushEndIdx(null);
    }, [fileName, xKey, removeRecoveryEvents]);

    /** Drop baseline if x labels no longer exist (e.g. file swap); avoids bogus full-chart averaging */
    useEffect(() => {
        if (!baselineLeft || !baselineRight || !filteredData.length) return;
        const okL = filteredData.some((d) => String(d[xKey]) === String(baselineLeft));
        const okR = filteredData.some((d) => String(d[xKey]) === String(baselineRight));
        if (!okL || !okR) {
            setBaselineLeft(null);
            setBaselineRight(null);
            setIsDragging(false);
            setDragRight('');
        }
    }, [filteredData, xKey, baselineLeft, baselineRight]);

    const baselineRange = useMemo(() => {
        if (!baselineLeft || !baselineRight || !filteredData.length) return null;
        const s = filteredData.findIndex((d) => String(d[xKey]) === String(baselineLeft));
        const e = filteredData.findIndex((d) => String(d[xKey]) === String(baselineRight));
        if (s < 0 || e < 0) return null;
        let startIdx = s;
        let endIdx = e;
        if (startIdx > endIdx) [startIdx, endIdx] = [endIdx, startIdx];
        return { startIdx, endIdx };
    }, [baselineLeft, baselineRight, filteredData, xKey]);

    const baselineAvgs = useMemo(() => {
        if (!baselineRange) return null;
        const { startIdx, endIdx } = baselineRange;
        const slice = filteredData.slice(startIdx, endIdx + 1);
        const avgs = {};
        allDisplayKeys.forEach(key => {
            const vals = slice.map(r => r[key]).filter(v => typeof v === 'number' && isFinite(v));
            avgs[key] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        });
        return avgs;
    }, [baselineRange, filteredData, allDisplayKeys]);

    const displayData = useMemo(() => {
        if (!baselineAvgs) return filteredData;
        return filteredData.map(row => {
            const out = { ...row };
            allDisplayKeys.forEach(key => {
                const avg = baselineAvgs[key];
                const val = row[key];
                if (avg !== null && avg !== undefined && avg !== 0 && typeof val === 'number') {
                    out[key] = (val - avg) / avg;
                } else {
                    out[key] = val;
                }
            });
            return out;
        });
    }, [baselineAvgs, filteredData, allDisplayKeys, xKey]);

    const isNormalized = !!baselineAvgs;

    /* ── Mouse Handlers ── */
    const handleMouseDown = (e) => {
        if (e && e.activeLabel !== undefined && e.activeLabel !== null) {
            setIsDragging(true);
            setBaselineLeft(String(e.activeLabel));
            setDragRight(String(e.activeLabel));
            setBaselineRight(null);
        }
    };
    const handleMouseMove = (e) => {
        if (!e) return;
        if (e.activeLabel !== undefined && e.activeLabel !== null) {
            setHoverLabel(String(e.activeLabel));
            if (isDragging) setDragRight(String(e.activeLabel));
        }
    };
    const handleMouseUp = () => {
        if (!isDragging) return;
        const finalRight = dragRight || baselineLeft;
        const lIdx = filteredData.findIndex(d => String(d[xKey]) === String(baselineLeft));
        const rIdx = filteredData.findIndex(d => String(d[xKey]) === String(finalRight));
        if (lIdx <= rIdx) {
            setBaselineRight(finalRight);
        } else {
            setBaselineLeft(finalRight);
            setBaselineRight(baselineLeft);
        }
        setDragRight('');
        setIsDragging(false);
    };

    /* ── Wheel Zoom ── */
    const handleWheel = useCallback((e) => {
        if (!filteredData || filteredData.length === 0) return;
        e.preventDefault();
        const zoomIn = e.deltaY < 0;
        const lastIdx = filteredData.length - 1;
        const startIdx = brushStartIdx;
        const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;
        const currentSpan = endIdx - startIdx;
        const minSpan = 4;
        if (currentSpan < minSpan && zoomIn) return;
        const delta = Math.max(1, Math.floor(currentSpan * 0.15));
        let pivotIdx = Math.floor(startIdx + currentSpan / 2);
        if (hoverLabel) {
            const hi = filteredData.findIndex(d => String(d[xKey]) === String(hoverLabel));
            if (hi >= startIdx && hi <= endIdx) pivotIdx = hi;
        }
        const ratio = currentSpan > 0 ? (pivotIdx - startIdx) / currentSpan : 0.5;
        let newStart, newEnd;
        if (zoomIn) newStart = startIdx + Math.floor(delta * ratio);
        else newStart = Math.max(0, startIdx - Math.floor(delta * ratio));
        if (zoomIn) newEnd = endIdx - Math.ceil(delta * (1 - ratio));
        else newEnd = Math.min(lastIdx, endIdx + Math.ceil(delta * (1 - ratio)));
        if (newEnd - newStart < minSpan) {
            newStart = Math.max(0, pivotIdx - 2);
            newEnd = Math.min(lastIdx, pivotIdx + 2);
        }
        setBrushStartIdx(newStart);
        setBrushEndIdx(newEnd);
    }, [filteredData, brushStartIdx, brushEndIdx, xKey, hoverLabel]);

    useEffect(() => {
        const el = chartWrapperRef.current;
        if (!el) return;
        el.addEventListener('wheel', handleWheel, { passive: false });
        // Handle filter type change reset if needed? No, keep zoom.
        return () => el.removeEventListener('wheel', handleWheel);
    }, [handleWheel]);

    const clearBaseline = () => { setBaselineLeft(null); setBaselineRight(null); setDragRight(''); setIsDragging(false); };
    const formatYAxis = (v) => (!isNormalized ? (typeof v === 'number' ? v.toFixed(2) : v) : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);

    /* ── Render ── */
    if (!data || data.length === 0) return (
        <div className="normalize-empty">
            <AlertCircle size={48} color="#475569" />
            <p>Select a file from the sidebar to begin.</p>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Ctrl+click files to overlay.</p>
        </div>
    );

    if (eligibleWorkspaceFiles.length === 0) return (
        <div className="normalize-empty">
            <Droplets size={48} color="#475569" />
            <p>No files match the current filters.</p>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', maxWidth: 420, textAlign: 'center' }}>
                {concFilterActive
                    ? 'Turn on at least one concentration, or disable “No Unknowns” if filenames omit ppb/ppm. If the sidebar main file is off, the first selected compare is used as the base trace.'
                    : 'Try disabling “No Unknowns” if your filenames do not include a concentration (ppb/ppm).'}
            </p>
            {concFilterActive && concentrationOptions.length > 0 && (
                <div className="normalize-concentration-bar normalize-concentration-bar--standalone">
                    <span className="normalize-conc-label"><Droplets size={14} /> Concentrations</span>
                    <div className="normalize-conc-toggles">
                        {concentrationOptions.map((opt) => (
                            <button
                                key={opt.key}
                                type="button"
                                className={`normalize-conc-toggle${selectedConcSet.has(opt.key) ? ' normalize-conc-toggle--on' : ''}`}
                                onClick={() => toggleConcentrationKey(opt.key)}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                    <button type="button" className="normalize-conc-action" onClick={selectAllConcentrations}>All</button>
                    <button type="button" className="normalize-conc-action" onClick={clearAllConcentrations}>None</button>
                </div>
            )}
        </div>
    );

    const baselR = baselineRight || (isDragging ? dragRight : null);

    return (
        <motion.div className="normalize-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>

            {/* ── Header ── */}
            <div className="normalize-header">
                <div className="header-left">
                    <Activity size={15} color="#fbbf24" style={{ flexShrink: 0 }} />
                    <span className="normalize-title" title={plotMainFileName || fileName}>{shortName(plotMainFileName || fileName)}</span>
                    {cmpFiles.slice(0, 2).map((f, i) => (
                        <span key={i} className="normalize-title" style={{ color: PALETTE[(i + 1) % PALETTE.length], fontSize: '0.85rem' }}>
                            <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>vs</span>
                            {f.shortName}
                        </span>
                    ))}
                    {cmpFiles.length > 2 && (
                        <span className="normalize-title" style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginLeft: 6 }}>
                            +{cmpFiles.length - 2} more...
                        </span>
                    )}

                    {/* Filter Controls (Inline) */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 16, borderLeft: '1px solid var(--border-color)', paddingLeft: 12 }}>
                        <Layers size={14} color="var(--text-muted)" style={{ marginRight: 4 }} title="Noise Filter" />
                        <select
                            value={filterType}
                            onChange={(e) => setFilterType(e.target.value)}
                            style={{
                                background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
                                color: 'var(--text-primary)', fontSize: '0.75rem', padding: '2px 4px', borderRadius: 4, cursor: 'pointer'
                            }}>
                            <option value="none">No Filter</option>
                            <option value="ma">Moving Avg</option>
                            <option value="gaussian">Gaussian</option>
                        </select>
                        {filterType !== 'none' && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{filterType === 'ma' ? 'Width:' : 'Sigma:'} {filterWindow}</span>
                                <input
                                    type="range" min="1" max="50" step="1"
                                    value={filterWindow} onChange={(e) => setFilterWindow(Number(e.target.value))}
                                    style={{ width: 60, height: 4, accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                                />
                            </div>
                        )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', marginLeft: 16, borderLeft: '1px solid var(--border-color)', paddingLeft: 12, gap: 12 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.75rem', color: '#94a3b8' }} title="Remove Recovery Phase data from visualization">
                            <input
                                type="checkbox"
                                checked={removeRecoveryEvents}
                                onChange={(e) => setRemoveRecoveryEvents(e.target.checked)}
                                style={{ accentColor: '#fbbf24', cursor: 'pointer', margin: 0, width: 14, height: 14 }}
                            />
                            Remove Recovery
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.75rem', color: '#94a3b8' }}>
                            <input
                                type="checkbox"
                                checked={filterUnknown}
                                onChange={(e) => setFilterUnknown(e.target.checked)}
                                style={{ accentColor: '#fbbf24', cursor: 'pointer', margin: 0, width: 14, height: 14 }}
                            />
                            No Unknowns
                        </label>
                    </div>

                </div>

                {/* Common Columns Shortcuts */}
                {hasCompare && commonColumns.length > 0 && commonColumns.length < 8 && (
                    <div className="common-cols-bar">
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginRight: 6 }}>Quick Compare:</span>
                        {commonColumns.map(col => (
                            <button key={col}
                                onClick={(e) => activateCommon(col, e.ctrlKey || e.metaKey)}
                                title="Click to view only this column (Ctrl+Click to add)"
                                className={`common-col-btn${visibleSeries.includes(col) ? ' active' : ''}`}>
                                <Copy size={10} style={{ marginRight: 3 }} />
                                {col}
                            </button>
                        ))}
                    </div>
                )}

                <div className="header-controls">

                    <button className="icon-btn" onClick={handleDownloadPng} title="Download View as PNG (Image)" style={{
                        background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '6px',
                        padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer',
                        color: 'var(--text-primary)', fontSize: '0.8rem', marginRight: '8px'
                    }}>
                        <ImageIcon size={14} /> PNG
                    </button>

                    {isNormalized && <span className="norm-badge">✓ Norm</span>}
                    {baselineLeft && (
                        <button onClick={clearBaseline} className="clear-btn">
                            <RotateCcw size={12} /> Clear
                        </button>
                    )}
                </div>
            </div>

            {/* ── Concentration toggles (from filenames: 5 ppm, 10 ppb, …) ── */}
            {concentrationOptions.length > 0 && (
                <div className="normalize-concentration-bar">
                    <span className="normalize-conc-label" title="Parsed from main + compare filenames. Toggle which concentrations are merged on the chart.">
                        <Droplets size={14} />
                        Concentrations
                    </span>
                    <div className="normalize-conc-toggles">
                        {concentrationOptions.map((opt) => (
                            <button
                                key={opt.key}
                                type="button"
                                className={`normalize-conc-toggle${selectedConcSet.has(opt.key) ? ' normalize-conc-toggle--on' : ''}`}
                                onClick={() => toggleConcentrationKey(opt.key)}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                    <button type="button" className="normalize-conc-action" onClick={selectAllConcentrations}>All</button>
                    <button type="button" className="normalize-conc-action" onClick={clearAllConcentrations}>None</button>
                    <span className="normalize-conc-hint">
                        {eligibleWorkspaceFiles.length} file{eligibleWorkspaceFiles.length !== 1 ? 's' : ''} in plot
                    </span>
                </div>
            )}

            {/* ── Chips (Scrollable) ── */}
            <div className="series-chip-bar">
                {/* Main */}
                <span className="chip-group-label" title={plotMainFileName || fileName}>{shortName(plotMainFileName || fileName)}</span>
                {seriesKeys.map((key, i) => {
                    const active = visibleSeries.includes(key);
                    return (
                        <button key={key} onClick={() => toggleSeries(key)}
                            className={`series-chip${active ? ' active' : ''}`}
                            style={{ borderColor: active ? PALETTE[0] : 'transparent', color: active ? PALETTE[0] : 'var(--text-muted)' }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: PALETTE[0], display: 'inline-block' }} />
                            {key}
                        </button>
                    );
                })}

                {/* Compare Files */}
                {cmpFiles.map((f, idx) => {
                    const color = PALETTE[(idx + 1) % PALETTE.length];
                    const prefixMap = prefixedKeysMap[idx];
                    return (
                        <React.Fragment key={idx}>
                            <div className="chip-separator" />
                            <span className="chip-group-label" style={{ color: color }}>{f.shortName}</span>
                            {f.seriesKeys.map((key) => {
                                const prefKey = prefixMap[key];
                                const active = visibleSeries.includes(prefKey);
                                return (
                                    <button key={prefKey} onClick={() => toggleSeries(prefKey)}
                                        className={`series-chip${active ? ' active' : ''}`}
                                        style={{ borderColor: active ? color : 'transparent', color: active ? color : 'var(--text-muted)', borderStyle: 'dashed' }}>
                                        <span style={{ width: 6, height: 6, borderRadius: 1, background: color, display: 'inline-block' }} />
                                        {key}
                                    </button>
                                );
                            })}
                        </React.Fragment>
                    );
                })}
            </div>

            {/* ── Info Bar ── */}
            <div className="baseline-info-bar">
                {!baselineLeft ? (
                    <span>
                        <Target size={12} style={{ display: 'inline', marginRight: 5, verticalAlign: 'middle', color: '#fbbf24' }} />
                        <strong style={{ color: '#fbbf24' }}>Drag on chart</strong> to set baseline window
                        {hasCompare && <span style={{ color: 'var(--text-muted)' }}> — applies to all files</span>}
                    </span>
                ) : (
                    <span>
                        Baseline: <strong style={{ color: '#fbbf24' }}>{baselineLeft}</strong> → <strong style={{ color: '#fbbf24' }}>{baselR}</strong>
                        {baselineRange && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>({baselineRange.endIdx - baselineRange.startIdx + 1} rows)</span>}
                    </span>
                )}
            </div>

            {/* ── Chart ── */}
            <div className="normalize-chart-scroll">
                <div ref={chartWrapperRef} className={`normalize-chart-wrapper${isDragging ? ' selecting-baseline' : ''}`}>
                    <div className="normalize-mode-hint" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                        {isDragging ? '🎯 Release to set baseline' : isNormalized ? '📊 showing % change' : '🖱️ Drag to set baseline'}
                    </div>

                    <ResponsiveContainer width="100%" height="99%">
                        <LineChart data={displayData} margin={{ top: 40, right: 30, left: 10, bottom: 60 }}
                            onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.4} />
                            <XAxis dataKey={xKey} stroke="#94a3b8" tick={{ fill: '#94a3b8', fontSize: 11 }}
                                minTickGap={30} interval="preserveStartEnd" tickFormatter={v => String(v)} />
                            <YAxis stroke="#94a3b8" tick={{ fill: '#94a3b8', fontSize: 11 }}
                                domain={['auto', 'auto']} width={isNormalized ? 72 : 58} tickFormatter={formatYAxis} />
                            <Tooltip content={<NormalizeTooltip isNormalized={isNormalized} />} />
                            <Brush dataKey={xKey} height={24} stroke="#fbbf24" fill="#1e293b" travellerWidth={8}
                                startIndex={brushStartIdx} endIndex={brushEndIdx !== null ? brushEndIdx : Math.max(0, displayData.length - 1)}
                                onChange={(r) => { if (r && r.startIndex !== undefined) { setBrushStartIdx(r.startIndex); setBrushEndIdx(r.endIndex); } }}
                                tickFormatter={() => ''} />

                            {isNormalized && <ReferenceLine y={0} stroke="rgba(255,255,255,0.28)" strokeDasharray="5 3" label={{ value: '0%', fill: '#64748b', fontSize: 11, position: 'right' }} />}
                            {isDragging && baselineLeft && dragRight && <ReferenceArea x1={baselineLeft} x2={dragRight} fill="rgba(251,191,36,0.15)" stroke="rgba(251,191,36,0.6)" />}
                            {!isDragging && baselineLeft && baselineRight && <ReferenceArea x1={baselineLeft} x2={baselineRight} fill="rgba(251,191,36,0.06)" stroke="rgba(251,191,36,0.35)" />}

                            {/* Main Lines */}
                            {seriesKeys.filter(k => visibleSeries.includes(k)).map((key) => (
                                <Line key={key} type="monotone" dataKey={key}
                                    stroke={strokeForWorkspaceFile(plotMainFileName || fileName, activeData)} strokeWidth={2} dot={false}
                                    activeDot={{ r: 4 }} name={getLineLabel(plotMainFileName || fileName, key, activeData)} isAnimationActive={false} connectNulls />
                            ))}

                            {/* Compare Lines — color by concentration, not compare-file index */}
                            {cmpFiles.map((f, idx) => {
                                const prefixMap = prefixedKeysMap[idx];
                                const color = strokeForWorkspaceFile(f.fileName, f.data);
                                return f.seriesKeys
                                    .filter(k => visibleSeries.includes(prefixMap[k]))
                                    .map(key => (
                                        <Line key={prefixMap[key]} type="monotone" dataKey={prefixMap[key]}
                                            stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4 }}
                                            name={getLineLabel(f.fileName, key, f.data)} isAnimationActive={false} connectNulls />
                                    ));
                            })}
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            </div>
            {/* ── Footer ── */}
            <div className="normalize-footer">
                <span className="stat">Rows (main): <strong>{chartData.length}</strong></span>
                {cmpFiles.map((f, i) => (
                    <span key={f.fileName || i} className="stat" style={{ color: strokeForWorkspaceFile(f.fileName, f.data) }}>
                        {f.shortName}: <strong>{f.data.length}</strong>
                    </span>
                ))}
                <span className="stat">Baseline: <strong>{baselineRange ? (baselineRange.endIdx - baselineRange.startIdx + 1) : 0} rows</strong></span>
            </div>
        </motion.div>
    );
};

export default NormalizePage;
