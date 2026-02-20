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
import { AlertCircle, Activity, RotateCcw, Target } from 'lucide-react';
import { motion } from 'framer-motion';
import './NormalizePage.css';

const COLORS = ['#38bdf8', '#818cf8', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#f87171', '#60a5fa'];

/* ── Custom tooltip ────────────────────────────────────────────────── */
const NormalizeTooltip = ({ active, payload, label, isNormalized }) => {
    if (!active || !payload || !payload.length) return null;
    return (
        <div style={{
            background: 'rgba(15,23,42,0.97)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: '0.82rem',
            pointerEvents: 'none',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            maxHeight: 260,
            overflowY: 'auto'
        }}>
            <p style={{ color: '#94a3b8', marginBottom: 4, fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 3 }}>
                {String(label)}
            </p>
            {payload.map((entry, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, color: entry.color, marginBottom: 2 }}>
                    <span style={{ opacity: 0.85 }}>{entry.name}</span>
                    <strong>
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
const NormalizePage = ({ data, fileName }) => {

    /* Derive xKey / seriesKeys */
    const { xKey, seriesKeys, chartData } = useMemo(() => {
        if (!data || data.length === 0) return { xKey: '', seriesKeys: [], chartData: [] };
        const keys = Object.keys(data[0]);
        let x = keys[0];
        const potentialX = keys.find(k => k.toLowerCase().includes('date') || k.toLowerCase().includes('time') || k.toLowerCase().includes('stamp'));
        if (potentialX) x = potentialX;
        const series = keys.filter(k => k !== x && typeof data[0][k] === 'number');
        return { xKey: x, seriesKeys: series, chartData: data };
    }, [data]);

    /* Visible series toggle */
    const [visibleSeries, setVisibleSeries] = useState([]);
    useEffect(() => {
        setVisibleSeries(seriesKeys.slice(0, Math.min(seriesKeys.length, 8)));
    }, [seriesKeys]);
    const toggleSeries = (key) =>
        setVisibleSeries(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);

    /* Baseline state */
    const [baselineLeft, setBaselineLeft] = useState(null);
    const [baselineRight, setBaselineRight] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragRight, setDragRight] = useState('');

    /* Brush/zoom state */
    const [brushStartIdx, setBrushStartIdx] = useState(0);
    const [brushEndIdx, setBrushEndIdx] = useState(null);
    const [hoverLabel, setHoverLabel] = useState(null);

    const chartWrapperRef = useRef(null);

    /* Reset on new file */
    useEffect(() => {
        setBaselineLeft(null);
        setBaselineRight(null);
        setIsDragging(false);
        setDragRight('');
        setBrushStartIdx(0);
        setBrushEndIdx(null);
    }, [data, fileName]);

    /* Baseline index range */
    const baselineRange = useMemo(() => {
        if (!baselineLeft || !baselineRight || !chartData.length) return null;
        let s = chartData.findIndex(d => String(d[xKey]) === String(baselineLeft));
        let e = chartData.findIndex(d => String(d[xKey]) === String(baselineRight));
        if (s < 0) s = 0;
        if (e < 0) e = chartData.length - 1;
        if (s > e) [s, e] = [e, s];
        return { startIdx: s, endIdx: e };
    }, [baselineLeft, baselineRight, chartData, xKey]);

    /* Per-series averages over baseline window */
    const baselineAvgs = useMemo(() => {
        if (!baselineRange) return null;
        const { startIdx, endIdx } = baselineRange;
        const slice = chartData.slice(startIdx, endIdx + 1);
        const avgs = {};
        seriesKeys.forEach(key => {
            const vals = slice.map(r => r[key]).filter(v => typeof v === 'number' && isFinite(v));
            avgs[key] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        });
        return avgs;
    }, [baselineRange, chartData, seriesKeys]);

    /* Normalized data: (y - avg) / avg */
    const displayData = useMemo(() => {
        if (!baselineAvgs) return chartData;
        return chartData.map(row => {
            const out = { [xKey]: row[xKey] };
            seriesKeys.forEach(key => {
                const avg = baselineAvgs[key];
                if (avg !== null && avg !== undefined && avg !== 0 && typeof row[key] === 'number') {
                    out[key] = (row[key] - avg) / avg;
                } else {
                    out[key] = row[key];
                }
            });
            return out;
        });
    }, [baselineAvgs, chartData, seriesKeys, xKey]);

    const isNormalized = !!baselineAvgs;

    /* Mouse handlers — drag to select baseline */
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
        const lIdx = chartData.findIndex(d => String(d[xKey]) === String(baselineLeft));
        const rIdx = chartData.findIndex(d => String(d[xKey]) === String(finalRight));
        if (lIdx <= rIdx) {
            setBaselineRight(finalRight);
        } else {
            setBaselineLeft(finalRight);
            setBaselineRight(baselineLeft);
        }
        setDragRight('');
        setIsDragging(false);
    };

    /* Wheel zoom */
    const handleWheel = useCallback((e) => {
        if (!chartData || chartData.length === 0) return;
        e.preventDefault();
        const zoomIn = e.deltaY < 0;
        const lastIdx = chartData.length - 1;
        const startIdx = brushStartIdx;
        const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;
        const currentSpan = endIdx - startIdx;
        const minSpan = 4;
        if (currentSpan < minSpan && zoomIn) return;
        const delta = Math.max(1, Math.floor(currentSpan * 0.15));
        let pivotIdx = Math.floor(startIdx + currentSpan / 2);
        if (hoverLabel) {
            const hi = chartData.findIndex(d => String(d[xKey]) === String(hoverLabel));
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
    }, [chartData, brushStartIdx, brushEndIdx, xKey, hoverLabel]);

    useEffect(() => {
        const el = chartWrapperRef.current;
        if (!el) return;
        el.addEventListener('wheel', handleWheel, { passive: false });
        return () => el.removeEventListener('wheel', handleWheel);
    }, [handleWheel]);

    const clearBaseline = () => {
        setBaselineLeft(null);
        setBaselineRight(null);
        setDragRight('');
        setIsDragging(false);
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

    const baselL = baselineLeft;
    const baselR = baselineRight || (isDragging ? dragRight : null);

    return (
        <motion.div className="normalize-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>

            {/* ── Compact header ── */}
            <div className="normalize-header">
                <span className="normalize-title">
                    <Activity size={15} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle', color: '#fbbf24' }} />
                    Baseline Normalization
                    {fileName && <em style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>— {fileName}</em>}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {isNormalized && (
                        <span style={{ fontSize: '0.75rem', color: '#34d399', fontWeight: 600 }}>✓ Normalized (y−ȳ₀)/ȳ₀</span>
                    )}
                    {baselineLeft && (
                        <button
                            onClick={clearBaseline}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 5,
                                background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                                color: '#f87171', borderRadius: 6, padding: '4px 10px',
                                fontSize: '0.75rem', cursor: 'pointer'
                            }}
                        >
                            <RotateCcw size={12} /> Clear baseline
                        </button>
                    )}
                </div>
            </div>

            {/* ── Series chip bar — horizontally scrollable, single row ── */}
            <div className="series-chip-bar">
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', marginRight: 4 }}>Series:</span>
                {seriesKeys.map((key) => {
                    const colorIdx = seriesKeys.indexOf(key) % COLORS.length;
                    const active = visibleSeries.includes(key);
                    return (
                        <button
                            key={key}
                            onClick={() => toggleSeries(key)}
                            className={`series-chip${active ? ' active' : ''}`}
                            style={{ borderColor: active ? COLORS[colorIdx] : 'transparent', color: COLORS[colorIdx] }}
                            title={active ? 'Hide' : 'Show'}
                        >
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: COLORS[colorIdx], display: 'inline-block', flexShrink: 0 }} />
                            {key}
                        </button>
                    );
                })}
            </div>

            {/* ── Baseline info / instruction bar ── */}
            <div className="baseline-info-bar">
                {!baselineLeft ? (
                    <span>
                        <Target size={12} style={{ display: 'inline', marginRight: 5, verticalAlign: 'middle', color: '#fbbf24' }} />
                        <strong style={{ color: '#fbbf24' }}>Click &amp; drag</strong> on the chart to select a baseline interval
                        — the chart normalises to <strong>(y − ȳ₀) / ȳ₀</strong> shown as <strong>%</strong>
                    </span>
                ) : (
                    <>
                        <span>
                            Baseline: <strong style={{ color: '#fbbf24' }}>{baselL}</strong>
                            {baselR && baselR !== baselL && <> → <strong style={{ color: '#fbbf24' }}>{baselR}</strong></>}
                            {baselineRange && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>({baselineRange.endIdx - baselineRange.startIdx + 1} rows)</span>}
                        </span>
                        {isNormalized && <span style={{ color: '#34d399' }}>Y-axis = % change from baseline avg</span>}
                    </>
                )}
            </div>

            {/* ── Chart scroll container ── */}
            <div className="normalize-chart-scroll">
                <div
                    ref={chartWrapperRef}
                    className={`normalize-chart-wrapper${isDragging ? ' selecting-baseline' : ''}`}
                >
                    {/* Floating hint — pointer-events:none so it never blocks drag */}
                    <div className="normalize-mode-hint" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                        {isDragging
                            ? '🎯 Release to set baseline'
                            : isNormalized
                                ? '📊 % change from baseline — drag to reselect, scroll to zoom'
                                : '🖱️ Drag on chart to define baseline window · scroll to zoom'}
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
                            <XAxis
                                dataKey={xKey}
                                stroke="#94a3b8"
                                tick={{ fill: '#94a3b8', fontSize: 11 }}
                                minTickGap={30}
                                interval="preserveStartEnd"
                                tickFormatter={v => String(v)}
                            />
                            <YAxis
                                stroke="#94a3b8"
                                tick={{ fill: '#94a3b8', fontSize: 11 }}
                                domain={['auto', 'auto']}
                                width={isNormalized ? 72 : 55}
                                tickFormatter={formatYAxis}
                                label={isNormalized ? {
                                    value: '% change', angle: -90, position: 'insideLeft',
                                    fill: '#64748b', fontSize: 11, dx: 10
                                } : undefined}
                            />
                            <Tooltip content={<NormalizeTooltip isNormalized={isNormalized} />} />
                            <Legend
                                verticalAlign="bottom"
                                formatter={(v) => <span style={{ color: '#e2e8f0', fontSize: '0.75rem' }}>{v}</span>}
                            />
                            <Brush
                                dataKey={xKey}
                                height={24}
                                stroke="#fbbf24"
                                fill="#1e293b"
                                travellerWidth={8}
                                startIndex={brushStartIdx}
                                endIndex={brushEndIdx !== null ? brushEndIdx : Math.max(0, displayData.length - 1)}
                                onChange={(range) => {
                                    if (range && range.startIndex !== undefined) {
                                        setBrushStartIdx(range.startIndex);
                                        setBrushEndIdx(range.endIndex);
                                    }
                                }}
                                tickFormatter={() => ''}
                            />

                            {/* Zero reference when normalised */}
                            {isNormalized && (
                                <ReferenceLine y={0} stroke="rgba(255,255,255,0.3)" strokeDasharray="5 3"
                                    label={{ value: '0%', fill: '#64748b', fontSize: 11, position: 'right' }} />
                            )}

                            {/* Live drag highlight */}
                            {isDragging && baselineLeft && dragRight && (
                                <ReferenceArea x1={baselineLeft} x2={dragRight}
                                    fill="rgba(251,191,36,0.15)" stroke="rgba(251,191,36,0.6)" strokeWidth={1.5} />
                            )}
                            {/* Committed baseline band */}
                            {!isDragging && baselineLeft && baselineRight && (
                                <ReferenceArea x1={baselineLeft} x2={baselineRight}
                                    fill="rgba(251,191,36,0.06)" stroke="rgba(251,191,36,0.35)" strokeWidth={1} strokeDasharray="4 3" />
                            )}

                            {/* Lines */}
                            {visibleSeries.map((key) => (
                                <Line
                                    key={key}
                                    type="monotone"
                                    dataKey={key}
                                    stroke={COLORS[seriesKeys.indexOf(key) % COLORS.length]}
                                    strokeWidth={2}
                                    dot={false}
                                    activeDot={{ r: 4 }}
                                    name={key}
                                    isAnimationActive={false}
                                    connectNulls
                                />
                            ))}
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {/* ── Footer stats ── */}
            <div className="normalize-footer">
                <span className="stat">Rows: <strong>{data.length}</strong></span>
                <span className="stat">Total series: <strong>{seriesKeys.length}</strong></span>
                <span className="stat">Showing: <strong>{visibleSeries.length}</strong></span>
                <span className="stat">X-axis: <strong>{xKey}</strong></span>
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
