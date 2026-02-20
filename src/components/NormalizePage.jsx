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
import { AlertCircle, Activity, RotateCcw, Target, Layers } from 'lucide-react';
import { motion } from 'framer-motion';
import './NormalizePage.css';

/* Palette: first 8 = main file, next 8 = compare file */
const MAIN_COLORS = ['#38bdf8', '#818cf8', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#f87171', '#60a5fa'];
const CMP_COLORS = ['#0ea5e9', '#6366f1', '#10b981', '#ec4899', '#f59e0b', '#8b5cf6', '#ef4444', '#3b82f6'];

/* ── Helpers ──────────────────────────────────────────────────────── */
function detectXKey(row) {
    const keys = Object.keys(row);
    return keys.find(k =>
        k.toLowerCase().includes('date') ||
        k.toLowerCase().includes('time') ||
        k.toLowerCase().includes('stamp')
    ) || keys[0];
}

function shortName(fileName = '') {
    return fileName.replace(/\.[^/.]+$/, '').slice(0, 14);
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
            maxHeight: 300,
            overflowY: 'auto',
            maxWidth: 300
        }}>
            <p style={{ color: '#94a3b8', marginBottom: 4, fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.07)', paddingBottom: 3 }}>
                {String(label)}
            </p>
            {payload.map((entry, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, color: entry.color, marginBottom: 2 }}>
                    <span style={{ opacity: 0.85, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: 160 }}>{entry.name}</span>
                    <strong style={{ whiteSpace: 'nowrap' }}>
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

    /* ── Derive main file keys ── */
    const { xKey, seriesKeys, chartData } = useMemo(() => {
        if (!data || data.length === 0) return { xKey: '', seriesKeys: [], chartData: [] };
        const x = detectXKey(data[0]);
        const series = Object.keys(data[0]).filter(k => k !== x && typeof data[0][k] === 'number');
        return { xKey: x, seriesKeys: series, chartData: data };
    }, [data]);

    /* ── Derive compare file keys (first compare file only) ── */
    const compareFile = compareDataList?.[0];
    const { cmpXKey, cmpSeriesKeys, cmpData, cmpShortName } = useMemo(() => {
        if (!compareFile?.data || compareFile.data.length === 0)
            return { cmpXKey: '', cmpSeriesKeys: [], cmpData: [], cmpShortName: '' };
        const x = detectXKey(compareFile.data[0]);
        const series = Object.keys(compareFile.data[0]).filter(k => k !== x && typeof compareFile.data[0][k] === 'number');
        return {
            cmpXKey: x,
            cmpSeriesKeys: series,
            cmpData: compareFile.data,
            cmpShortName: shortName(compareFile.fileName)
        };
    }, [compareFile]);

    const hasCompare = cmpData.length > 0;

    /* ── Merged data for the chart (index-aligned) ── */
    /* Prefixed compare keys: "cmpShortName:key" */
    const prefixedCmpKeys = useMemo(
        () => cmpSeriesKeys.map(k => `${cmpShortName}:${k}`),
        [cmpSeriesKeys, cmpShortName]
    );

    const mergedData = useMemo(() => {
        if (!hasCompare) return chartData;
        const maxLen = Math.max(chartData.length, cmpData.length);
        return Array.from({ length: maxLen }, (_, i) => {
            const row = {};
            // Main x label
            row[xKey] = i < chartData.length ? chartData[i][xKey] : i;
            // Main series
            if (i < chartData.length) {
                seriesKeys.forEach(k => { row[k] = chartData[i][k]; });
            } else {
                seriesKeys.forEach(k => { row[k] = null; });
            }
            // Compare series
            if (i < cmpData.length) {
                cmpSeriesKeys.forEach(k => { row[`${cmpShortName}:${k}`] = cmpData[i][k]; });
            } else {
                cmpSeriesKeys.forEach(k => { row[`${cmpShortName}:${k}`] = null; });
            }
            return row;
        });
    }, [hasCompare, chartData, cmpData, seriesKeys, cmpSeriesKeys, xKey, cmpShortName]);

    /* All series keys for display purposes */
    const allSeriesKeys = useMemo(() => [...seriesKeys, ...prefixedCmpKeys], [seriesKeys, prefixedCmpKeys]);

    /* ── Visible series toggles ── */
    const [visibleSeries, setVisibleSeries] = useState([]);
    useEffect(() => {
        setVisibleSeries(allSeriesKeys.slice(0, Math.min(allSeriesKeys.length, 8)));
    }, [allSeriesKeys.join(',')]);   // eslint-disable-line
    const toggleSeries = (key) =>
        setVisibleSeries(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);

    /* ── Baseline / zoom state ── */
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
    }, [data, fileName]);

    /* ── Baseline index range (on merged data) ── */
    const baselineRange = useMemo(() => {
        if (!baselineLeft || !baselineRight || !mergedData.length) return null;
        let s = mergedData.findIndex(d => String(d[xKey]) === String(baselineLeft));
        let e = mergedData.findIndex(d => String(d[xKey]) === String(baselineRight));
        if (s < 0) s = 0;
        if (e < 0) e = mergedData.length - 1;
        if (s > e) [s, e] = [e, s];
        return { startIdx: s, endIdx: e };
    }, [baselineLeft, baselineRight, mergedData, xKey]);

    /* ── Baseline averages per series ── */
    const baselineAvgs = useMemo(() => {
        if (!baselineRange) return null;
        const { startIdx, endIdx } = baselineRange;
        const slice = mergedData.slice(startIdx, endIdx + 1);
        const avgs = {};
        allSeriesKeys.forEach(key => {
            const vals = slice.map(r => r[key]).filter(v => typeof v === 'number' && isFinite(v));
            avgs[key] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        });
        return avgs;
    }, [baselineRange, mergedData, allSeriesKeys]);

    /* ── Normalized display data ── */
    const displayData = useMemo(() => {
        if (!baselineAvgs) return mergedData;
        return mergedData.map(row => {
            const out = { [xKey]: row[xKey] };
            allSeriesKeys.forEach(key => {
                const avg = baselineAvgs[key];
                if (avg !== null && avg !== undefined && avg !== 0 && typeof row[key] === 'number') {
                    out[key] = (row[key] - avg) / avg;
                } else {
                    out[key] = row[key];
                }
            });
            return out;
        });
    }, [baselineAvgs, mergedData, allSeriesKeys, xKey]);

    const isNormalized = !!baselineAvgs;

    /* ── Mouse handlers ── */
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

    /* ── Wheel zoom ── */
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
        if (zoomIn) {
            newStart = startIdx + Math.floor(delta * ratio);
            newEnd = endIdx - Math.ceil(delta * (1 - ratio));
        } else {
            newStart = Math.max(0, startIdx - Math.floor(delta * ratio));
            newEnd = Math.min(lastIdx, endIdx + Math.ceil(delta * (1 - ratio)));
        }
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

    const clearBaseline = () => {
        setBaselineLeft(null); setBaselineRight(null);
        setDragRight(''); setIsDragging(false);
    };

    const formatYAxis = (v) => {
        if (!isNormalized) return typeof v === 'number' ? v.toFixed(2) : v;
        return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
    };

    /* ── Empty states ── */
    if (!data || data.length === 0) {
        return (
            <div className="normalize-empty">
                <AlertCircle size={48} color="#475569" />
                <p>Select a file from the sidebar to begin normalization.</p>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Ctrl+click a second file to overlay and compare.
                </p>
            </div>
        );
    }
    if (seriesKeys.length === 0) {
        return (
            <div className="normalize-empty">
                <AlertCircle size={48} color="#f87171" />
                <p>No numeric columns found to normalize.</p>
            </div>
        );
    }

    const baselR = baselineRight || (isDragging ? dragRight : null);

    return (
        <motion.div className="normalize-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>

            {/* ── Compact header ── */}
            <div className="normalize-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, overflow: 'hidden' }}>
                    <Activity size={15} color="#fbbf24" style={{ flexShrink: 0 }} />
                    <span className="normalize-title">{shortName(fileName)}</span>
                    {hasCompare && (
                        <>
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>vs</span>
                            <span className="normalize-title" style={{ color: CMP_COLORS[0] }}>
                                <Layers size={13} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
                                {cmpShortName}
                            </span>
                        </>
                    )}
                    {!hasCompare && (
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginLeft: 4 }}>
                            · Ctrl+click a second file to overlay
                        </span>
                    )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {isNormalized && (
                        <span style={{ fontSize: '0.73rem', color: '#34d399', fontWeight: 600 }}>✓ (y−ȳ₀)/ȳ₀</span>
                    )}
                    {baselineLeft && (
                        <button onClick={clearBaseline} className="clear-btn">
                            <RotateCcw size={12} /> Clear baseline
                        </button>
                    )}
                </div>
            </div>

            {/* ── Series chip bar — single scrollable row ── */}
            <div className="series-chip-bar">
                {/* Main file chips */}
                {seriesKeys.length > 0 && (
                    <span style={{
                        fontSize: '0.68rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', marginRight: 2,
                        borderRight: hasCompare ? '1px solid var(--border-color)' : 'none', paddingRight: hasCompare ? 6 : 0
                    }}>
                        {shortName(fileName)}
                    </span>
                )}
                {seriesKeys.map((key, i) => {
                    const active = visibleSeries.includes(key);
                    return (
                        <button key={key} onClick={() => toggleSeries(key)}
                            className={`series-chip${active ? ' active' : ''}`}
                            style={{
                                borderColor: active ? MAIN_COLORS[i % MAIN_COLORS.length] : 'transparent',
                                color: MAIN_COLORS[i % MAIN_COLORS.length]
                            }}
                            title={active ? 'Hide' : 'Show'}>
                            <span style={{
                                width: 7, height: 7, borderRadius: '50%',
                                background: MAIN_COLORS[i % MAIN_COLORS.length], display: 'inline-block', flexShrink: 0
                            }} />
                            {key}
                        </button>
                    );
                })}

                {/* Compare file chips */}
                {hasCompare && (
                    <>
                        <span style={{
                            fontSize: '0.68rem', color: CMP_COLORS[0], whiteSpace: 'nowrap',
                            marginLeft: 6, borderLeft: '1px solid var(--border-color)', paddingLeft: 6
                        }}>
                            <Layers size={10} style={{ display: 'inline', marginRight: 3 }} />{cmpShortName}
                        </span>
                        {cmpSeriesKeys.map((key, i) => {
                            const prefKey = `${cmpShortName}:${key}`;
                            const active = visibleSeries.includes(prefKey);
                            return (
                                <button key={prefKey} onClick={() => toggleSeries(prefKey)}
                                    className={`series-chip${active ? ' active' : ''}`}
                                    style={{
                                        borderColor: active ? CMP_COLORS[i % CMP_COLORS.length] : 'transparent',
                                        color: CMP_COLORS[i % CMP_COLORS.length],
                                        borderStyle: 'dashed'
                                    }}
                                    title={active ? 'Hide' : 'Show'}>
                                    <span style={{
                                        width: 7, height: 7, borderRadius: 1,
                                        background: CMP_COLORS[i % CMP_COLORS.length], display: 'inline-block', flexShrink: 0
                                    }} />
                                    {key}
                                </button>
                            );
                        })}
                    </>
                )}
            </div>

            {/* ── Baseline info bar ── */}
            <div className="baseline-info-bar">
                {!baselineLeft ? (
                    <span>
                        <Target size={12} style={{ display: 'inline', marginRight: 5, verticalAlign: 'middle', color: '#fbbf24' }} />
                        <strong style={{ color: '#fbbf24' }}>Click &amp; drag</strong> on the chart to select baseline window
                        — normalises each series to <strong>(y − ȳ₀) / ȳ₀</strong> shown as <strong>%</strong>
                        {hasCompare && <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>· Both files use same window</span>}
                    </span>
                ) : (
                    <>
                        <span>
                            Baseline: <strong style={{ color: '#fbbf24' }}>{baselineLeft}</strong>
                            {baselR && baselR !== baselineLeft && <> → <strong style={{ color: '#fbbf24' }}>{baselR}</strong></>}
                            {baselineRange && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>({baselineRange.endIdx - baselineRange.startIdx + 1} rows)</span>}
                        </span>
                        {isNormalized && <span style={{ color: '#34d399' }}>Y-axis = % change from baseline average</span>}
                    </>
                )}
            </div>

            {/* ── Chart scroll container ── */}
            <div className="normalize-chart-scroll">
                <div ref={chartWrapperRef}
                    className={`normalize-chart-wrapper${isDragging ? ' selecting-baseline' : ''}`}>
                    <div className="normalize-mode-hint" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                        {isDragging ? '🎯 Release to set baseline'
                            : isNormalized ? '📊 % change from baseline — drag to reselect · scroll to zoom'
                                : '🖱️ Drag to define baseline window · scroll to zoom'}
                    </div>

                    <ResponsiveContainer width="100%" height={700}>
                        <LineChart
                            data={displayData}
                            margin={{ top: 40, right: 30, left: 10, bottom: 60 }}
                            onMouseDown={handleMouseDown}
                            onMouseMove={handleMouseMove}
                            onMouseUp={handleMouseUp}
                            onMouseLeave={handleMouseUp}
                        >
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.4} />
                            <XAxis dataKey={xKey} stroke="#94a3b8"
                                tick={{ fill: '#94a3b8', fontSize: 11 }}
                                minTickGap={30} interval="preserveStartEnd"
                                tickFormatter={v => String(v)} />
                            <YAxis stroke="#94a3b8" tick={{ fill: '#94a3b8', fontSize: 11 }}
                                domain={['auto', 'auto']}
                                width={isNormalized ? 72 : 58}
                                tickFormatter={formatYAxis}
                                label={isNormalized ? {
                                    value: '% change', angle: -90, position: 'insideLeft',
                                    fill: '#64748b', fontSize: 11, dx: 10
                                } : undefined} />
                            <Tooltip content={<NormalizeTooltip isNormalized={isNormalized} />} />
                            <Legend verticalAlign="bottom"
                                formatter={(v) => <span style={{ color: '#e2e8f0', fontSize: '0.72rem' }}>{v}</span>} />
                            <Brush dataKey={xKey} height={24} stroke="#fbbf24" fill="#1e293b" travellerWidth={8}
                                startIndex={brushStartIdx}
                                endIndex={brushEndIdx !== null ? brushEndIdx : Math.max(0, displayData.length - 1)}
                                onChange={(range) => {
                                    if (range && range.startIndex !== undefined) {
                                        setBrushStartIdx(range.startIndex);
                                        setBrushEndIdx(range.endIndex);
                                    }
                                }}
                                tickFormatter={() => ''} />

                            {isNormalized && (
                                <ReferenceLine y={0} stroke="rgba(255,255,255,0.28)" strokeDasharray="5 3"
                                    label={{ value: '0%', fill: '#64748b', fontSize: 11, position: 'right' }} />
                            )}
                            {isDragging && baselineLeft && dragRight && (
                                <ReferenceArea x1={baselineLeft} x2={dragRight}
                                    fill="rgba(251,191,36,0.15)" stroke="rgba(251,191,36,0.6)" strokeWidth={1.5} />
                            )}
                            {!isDragging && baselineLeft && baselineRight && (
                                <ReferenceArea x1={baselineLeft} x2={baselineRight}
                                    fill="rgba(251,191,36,0.06)" stroke="rgba(251,191,36,0.35)"
                                    strokeWidth={1} strokeDasharray="4 3" />
                            )}

                            {/* Main file lines — solid */}
                            {seriesKeys.filter(k => visibleSeries.includes(k)).map((key, i) => (
                                <Line key={key} type="monotone" dataKey={key}
                                    stroke={MAIN_COLORS[i % MAIN_COLORS.length]}
                                    strokeWidth={2} dot={false} activeDot={{ r: 4 }}
                                    name={key} isAnimationActive={false} connectNulls />
                            ))}

                            {/* Compare file lines — dashed */}
                            {hasCompare && cmpSeriesKeys.filter(k => visibleSeries.includes(`${cmpShortName}:${k}`)).map((key, i) => (
                                <Line key={`${cmpShortName}:${key}`} type="monotone"
                                    dataKey={`${cmpShortName}:${key}`}
                                    stroke={CMP_COLORS[i % CMP_COLORS.length]}
                                    strokeWidth={2} strokeDasharray="6 3"
                                    dot={false} activeDot={{ r: 4 }}
                                    name={`${cmpShortName}:${key}`}
                                    isAnimationActive={false} connectNulls />
                            ))}
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {/* ── Footer ── */}
            <div className="normalize-footer">
                <span className="stat">Main rows: <strong>{data.length}</strong></span>
                {hasCompare && <span className="stat">Compare rows: <strong>{cmpData.length}</strong></span>}
                <span className="stat">Main series: <strong>{seriesKeys.length}</strong></span>
                {hasCompare && <span className="stat">Cmp series: <strong>{cmpSeriesKeys.length}</strong></span>}
                <span className="stat">Visible: <strong>{visibleSeries.length}</strong></span>
                {baselineRange && (
                    <span className="stat" style={{ color: '#fbbf24' }}>
                        Baseline: <strong>{baselineRange.endIdx - baselineRange.startIdx + 1} rows</strong>
                    </span>
                )}
                {isNormalized && (
                    <span className="stat" style={{ color: '#34d399' }}>Mode: <strong>(y − ȳ₀) / ȳ₀ × 100%</strong></span>
                )}
            </div>
        </motion.div>
    );
};

export default NormalizePage;
