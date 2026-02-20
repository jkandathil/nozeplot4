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
import { AlertCircle, Activity, RotateCcw, Target, Layers, Copy } from 'lucide-react';
import { motion } from 'framer-motion';
import './NormalizePage.css';

/* Extended Palette for multi-file comparison */
const PALETTE = [
    '#38bdf8', '#fbbf24', '#34d399', '#f472b6', '#a78bfa', '#f87171', '#60a5fa', '#c084fc',
    '#2dd4bf', '#fb923c', '#4ade80', '#e879f9', '#818cf8', '#fca5a5', '#94a3b8', '#a3e635'
];

/* Line styles for different files */
const getLineStyle = (index) => {
    switch (index) {
        case 0: return { strokeDasharray: undefined };      // Main: Solid
        case 1: return { strokeDasharray: '5 5' };          // Cmp1: Dashed
        case 2: return { strokeDasharray: '2 2' };          // Cmp2: Dotted
        case 3: return { strokeDasharray: '10 5' };         // Cmp3: Long Dash
        case 4: return { strokeDasharray: '10 2 2 2' };     // Cmp4: Dash Dot
        default: return { strokeDasharray: '5 5' };
    }
};

/* ── Helpers ──────────────────────────────────────────────────────── */
function detectXKey(row) {
    if (!row) return '';
    const keys = Object.keys(row);
    return keys.find(k =>
        k.toLowerCase().includes('date') ||
        k.toLowerCase().includes('time') ||
        k.toLowerCase().includes('stamp')
    ) || keys[0];
}

function shortName(fileName = '') {
    return fileName.replace(/\.[^/.]+$/, '').slice(0, 12);
}

/* ── Custom tooltip ────────────────────────────────────────────────── */
const NormalizeTooltip = ({ active, payload, label, isNormalized }) => {
    if (!active || !payload || !payload.length) return null;
    return (
        <div style={{
            background: 'rgba(15,23,42,0.97)',
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
            <p style={{ color: '#94a3b8', marginBottom: 6, fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.07)', paddingBottom: 4 }}>
                {String(label)}
            </p>
            {payload.map((entry, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, color: entry.color, marginBottom: 3, alignItems: 'center' }}>
                    <span style={{ opacity: 0.9, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: 180, fontSize: '0.76rem' }}>
                        {entry.name}
                    </span>
                    <strong style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                        {isNormalized
                            ? `${entry.value >= 0 ? '+' : ''}${(entry.value * 100).toFixed(2)}%`
                            : typeof entry.value === 'number' ? entry.value.toFixed(3) : entry.value}
                    </strong>
                </div>
            ))}
        </div>
    );
};

/* ── Main component ────────────────────────────────────────────────── */
const NormalizePage = ({ data, fileName, compareDataList = [] }) => {

    /* ── 1. Prepare Main Data ── */
    const { xKey, seriesKeys, chartData } = useMemo(() => {
        if (!data || data.length === 0) return { xKey: '', seriesKeys: [], chartData: [] };
        const x = detectXKey(data[0]);
        const series = Object.keys(data[0]).filter(k => k !== x && typeof data[0][k] === 'number');
        return { xKey: x, seriesKeys: series, chartData: data };
    }, [data]);

    /* ── 2. Prepare Compare Data List ── */
    const cmpFiles = useMemo(() => {
        if (!compareDataList || compareDataList.length === 0) return [];
        return compareDataList.map((file, idx) => {
            if (!file?.data || file.data.length === 0) return null;
            const x = detectXKey(file.data[0]);
            const series = Object.keys(file.data[0]).filter(k => k !== x && typeof file.data[0][k] === 'number');
            return {
                id: idx,
                fileName: file.fileName,
                shortName: shortName(file.fileName),
                xKey: x,
                seriesKeys: series,
                data: file.data
            };
        }).filter(Boolean);
    }, [compareDataList]);

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
                map[idx][k] = `${f.shortName}::${k}`;
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
                row[xKey] = chartData[i][xKey]; // Use main X key
                seriesKeys.forEach(k => { row[k] = chartData[i][k]; });
            } else {
                row[xKey] = i; // Fallback X
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
        // Identifies common columns across main and all compare files
        let common = seriesKeys;
        if (cmpFiles.length > 0) {
            const allSets = [new Set(seriesKeys), ...cmpFiles.map(f => new Set(f.seriesKeys))];
            common = seriesKeys.filter(k => allSets.every(s => s.has(k)));
        }

        // If common columns exist, select up to 4 of them for ALL files
        if (common.length > 0) {
            const initial = [];
            const cols = common.slice(0, 4);
            cols.forEach(c => {
                initial.push(c); // Main
                cmpFiles.forEach((f, idx) => {
                    // prefixedKeysMap is stable as it depends on cmpFiles
                    if (prefixedKeysMap[idx] && prefixedKeysMap[idx][c]) {
                        initial.push(prefixedKeysMap[idx][c]);
                    }
                });
            });
            setVisibleSeries(initial);
        } else {
            // Fallback: Just main file keys
            setVisibleSeries(seriesKeys.slice(0, 5));
        }
    }, [seriesKeys.join(','), cmpFiles.length]); // Only re-run if main keys change or compare count changes

    const toggleSeries = (key) => {
        setVisibleSeries(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
    };

    /* activateCommon: Show this column for ALL files */
    const activateCommon = (colName) => {
        const keysToActive = [];
        // Add main
        if (seriesKeys.includes(colName)) keysToActive.push(colName);
        // Add all compares
        cmpFiles.forEach((f, idx) => {
            if (f.seriesKeys.includes(colName)) {
                keysToActive.push(prefixedKeysMap[idx][colName]);
            }
        });
        // Check if all are already active -> Toggle OFF
        const allActive = keysToActive.every(k => visibleSeries.includes(k));
        if (allActive) {
            setVisibleSeries(prev => prev.filter(k => !keysToActive.includes(k)));
        } else {
            // Add unique
            setVisibleSeries(prev => [...new Set([...prev, ...keysToActive])]);
        }
    };


    /* ── 7. Baseline / Normalization Logic ── */
    const [baselineLeft, setBaselineLeft] = useState(null);
    const [baselineRight, setBaselineRight] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragRight, setDragRight] = useState('');
    const [brushStartIdx, setBrushStartIdx] = useState(0);
    const [brushEndIdx, setBrushEndIdx] = useState(null);
    const [hoverLabel, setHoverLabel] = useState(null);
    const chartWrapperRef = useRef(null);

    useEffect(() => {
        setBaselineLeft(null); setBaselineRight(null);
        setIsDragging(false); setDragRight('');
        setBrushStartIdx(0); setBrushEndIdx(null);
    }, [data, fileName, compareDataList]);

    const baselineRange = useMemo(() => {
        if (!baselineLeft || !baselineRight || !mergedData.length) return null;
        let s = mergedData.findIndex(d => String(d[xKey]) === String(baselineLeft));
        let e = mergedData.findIndex(d => String(d[xKey]) === String(baselineRight));
        if (s < 0) s = 0;
        if (e < 0) e = mergedData.length - 1;
        if (s > e) [s, e] = [e, s];
        return { startIdx: s, endIdx: e };
    }, [baselineLeft, baselineRight, mergedData, xKey]);

    const baselineAvgs = useMemo(() => {
        if (!baselineRange) return null;
        const { startIdx, endIdx } = baselineRange;
        const slice = mergedData.slice(startIdx, endIdx + 1);
        const avgs = {};
        allDisplayKeys.forEach(key => {
            const vals = slice.map(r => r[key]).filter(v => typeof v === 'number' && isFinite(v));
            avgs[key] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        });
        return avgs;
    }, [baselineRange, mergedData, allDisplayKeys]);

    const displayData = useMemo(() => {
        if (!baselineAvgs) return mergedData;
        return mergedData.map(row => {
            const out = { [xKey]: row[xKey] };
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
    }, [baselineAvgs, mergedData, allDisplayKeys, xKey]);

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
        const lIdx = mergedData.findIndex(d => String(d[xKey]) === String(baselineLeft));
        const rIdx = mergedData.findIndex(d => String(d[xKey]) === String(finalRight));
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
        if (!mergedData || mergedData.length === 0) return;
        e.preventDefault();
        const zoomIn = e.deltaY < 0;
        const lastIdx = mergedData.length - 1;
        const startIdx = brushStartIdx;
        const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;
        const currentSpan = endIdx - startIdx;
        const minSpan = 4;
        if (currentSpan < minSpan && zoomIn) return;
        const delta = Math.max(1, Math.floor(currentSpan * 0.15));
        let pivotIdx = Math.floor(startIdx + currentSpan / 2);
        if (hoverLabel) {
            const hi = mergedData.findIndex(d => String(d[xKey]) === String(hoverLabel));
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
    }, [mergedData, brushStartIdx, brushEndIdx, xKey, hoverLabel]);

    useEffect(() => {
        const el = chartWrapperRef.current;
        if (!el) return;
        el.addEventListener('wheel', handleWheel, { passive: false });
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

    const baselR = baselineRight || (isDragging ? dragRight : null);

    return (
        <motion.div className="normalize-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>

            {/* ── Header ── */}
            <div className="normalize-header">
                <div className="header-left">
                    <Activity size={15} color="#fbbf24" style={{ flexShrink: 0 }} />
                    <span className="normalize-title">{shortName(fileName)}</span>
                    {cmpFiles.map((f, i) => (
                        <span key={i} className="normalize-title" style={{ color: PALETTE[(i + 1) % PALETTE.length], fontSize: '0.85rem' }}>
                            <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>vs</span>
                            {f.shortName}
                        </span>
                    ))}
                </div>

                {/* Common Columns Shortcuts */}
                {hasCompare && commonColumns.length > 0 && commonColumns.length < 8 && (
                    <div className="common-cols-bar">
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginRight: 6 }}>Quick Compare:</span>
                        {commonColumns.map(col => (
                            <button key={col} onClick={() => activateCommon(col)} className="common-col-btn">
                                <Copy size={10} style={{ marginRight: 3 }} />
                                {col}
                            </button>
                        ))}
                    </div>
                )}

                <div className="header-controls">
                    {isNormalized && <span className="norm-badge">✓ (y−ȳ₀)/ȳ₀</span>}
                    {baselineLeft && (
                        <button onClick={clearBaseline} className="clear-btn">
                            <RotateCcw size={12} /> Clear
                        </button>
                    )}
                </div>
            </div>

            {/* ── Chips (Scrollable) ── */}
            <div className="series-chip-bar">
                {/* Main */}
                <span className="chip-group-label">{shortName(fileName)}</span>
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

                    <ResponsiveContainer width="100%" height={740}>
                        <LineChart data={displayData} margin={{ top: 40, right: 30, left: 10, bottom: 60 }}
                            onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.4} />
                            <XAxis dataKey={xKey} stroke="#94a3b8" tick={{ fill: '#94a3b8', fontSize: 11 }}
                                minTickGap={30} interval="preserveStartEnd" tickFormatter={v => String(v)} />
                            <YAxis stroke="#94a3b8" tick={{ fill: '#94a3b8', fontSize: 11 }}
                                domain={['auto', 'auto']} width={isNormalized ? 72 : 58} tickFormatter={formatYAxis} />
                            <Tooltip content={<NormalizeTooltip isNormalized={isNormalized} />} />
                            <Legend verticalAlign="bottom" formatter={(v) => <span style={{ color: '#e2e8f0', fontSize: '0.72rem' }}>{v}</span>} />
                            <Brush dataKey={xKey} height={24} stroke="#fbbf24" fill="#1e293b" travellerWidth={8}
                                startIndex={brushStartIdx} endIndex={brushEndIdx !== null ? brushEndIdx : Math.max(0, displayData.length - 1)}
                                onChange={(r) => { if (r && r.startIndex !== undefined) { setBrushStartIdx(r.startIndex); setBrushEndIdx(r.endIndex); } }}
                                tickFormatter={() => ''} />

                            {isNormalized && <ReferenceLine y={0} stroke="rgba(255,255,255,0.28)" strokeDasharray="5 3" label={{ value: '0%', fill: '#64748b', fontSize: 11, position: 'right' }} />}
                            {isDragging && baselineLeft && dragRight && <ReferenceArea x1={baselineLeft} x2={dragRight} fill="rgba(251,191,36,0.15)" stroke="rgba(251,191,36,0.6)" />}
                            {!isDragging && baselineLeft && baselineRight && <ReferenceArea x1={baselineLeft} x2={baselineRight} fill="rgba(251,191,36,0.06)" stroke="rgba(251,191,36,0.35)" />}

                            {/* Main Lines */}
                            {seriesKeys.filter(k => visibleSeries.includes(k)).map((key, i) => (
                                <Line key={key} type="monotone" dataKey={key} stroke={PALETTE[0]} strokeWidth={2} dot={false}
                                    activeDot={{ r: 4 }} name={`${shortName(fileName)}: ${key}`} isAnimationActive={false} connectNulls />
                            ))}

                            {/* Compare Lines */}
                            {cmpFiles.map((f, idx) => {
                                const prefixMap = prefixedKeysMap[idx];
                                const color = PALETTE[(idx + 1) % PALETTE.length];
                                const style = getLineStyle(idx + 1);
                                return f.seriesKeys
                                    .filter(k => visibleSeries.includes(prefixMap[k]))
                                    .map(key => (
                                        <Line key={prefixMap[key]} type="monotone" dataKey={prefixMap[key]}
                                            stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4 }}
                                            strokeDasharray={style.strokeDasharray}
                                            name={`${f.shortName}: ${key}`} isAnimationActive={false} connectNulls />
                                    ));
                            })}
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            </div>
            {/* ── Footer ── */}
            <div className="normalize-footer">
                <span className="stat">Rows: <strong>{data.length}</strong></span>
                {cmpFiles.map((f, i) => <span key={i} className="stat" style={{ color: PALETTE[(i + 1) % PALETTE.length] }}>{f.shortName}: <strong>{f.data.length}</strong></span>)}
                <span className="stat">Baseline: <strong>{baselineRange ? (baselineRange.endIdx - baselineRange.startIdx + 1) : 0} rows</strong></span>
            </div>
        </motion.div>
    );
};

export default NormalizePage;
