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

const NormalizeTooltip = ({ active, payload, label, isNormalized }) => {
    if (!active || !payload || !payload.length) return null;
    return (
        <div style={{
            background: 'rgba(15,23,42,0.95)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: '0.82rem',
            pointerEvents: 'none',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)'
        }}>
            <p style={{ color: '#94a3b8', marginBottom: 4, fontWeight: 600 }}>{String(label)}</p>
            {payload.map((entry, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, color: entry.color }}>
                    <span style={{ opacity: 0.85 }}>{entry.name}</span>
                    <strong>
                        {isNormalized
                            ? `${entry.value >= 0 ? '+' : ''}${(entry.value * 100).toFixed(2)}%`
                            : entry.value}
                    </strong>
                </div>
            ))}
        </div>
    );
};

const NormalizePage = ({ data, fileName, xKey: propXKey, seriesKeys: propSeriesKeys }) => {
    // ── Derive series info ────────────────────────────────────────────────
    const { xKey, seriesKeys, chartData } = useMemo(() => {
        if (!data || data.length === 0) return { xKey: '', seriesKeys: [], chartData: [] };
        const keys = Object.keys(data[0]);
        let x = keys[0];
        const potentialX = keys.find(k => k.toLowerCase().includes('date') || k.toLowerCase().includes('time'));
        if (potentialX) x = potentialX;
        const series = keys.filter(k => k !== x && typeof data[0][k] === 'number');
        return { xKey: x, seriesKeys: series, chartData: data };
    }, [data]);

    // ── Visible series (chips) ────────────────────────────────────────────
    const [visibleSeries, setVisibleSeries] = useState([]);
    useEffect(() => {
        setVisibleSeries(seriesKeys.slice(0, Math.min(seriesKeys.length, 6)));
    }, [seriesKeys]);
    const toggleSeries = (key) => {
        setVisibleSeries(prev =>
            prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
        );
    };

    // ── Baseline selection state ──────────────────────────────────────────
    const [baselineLeft, setBaselineLeft] = useState(null);   // committed x labels
    const [baselineRight, setBaselineRight] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragRight, setDragRight] = useState('');           // live drag endpoint

    // ── Brush zoom state ──────────────────────────────────────────────────
    const [brushStartIdx, setBrushStartIdx] = useState(0);
    const [brushEndIdx, setBrushEndIdx] = useState(null);

    // Current hover label (for tooltip etc.)
    const [hoverLabel, setHoverLabel] = useState(null);

    // ── Ref for non-passive wheel ─────────────────────────────────────────
    const chartWrapperRef = useRef(null);

    // Reset everything when data changes
    useEffect(() => {
        setBaselineLeft(null);
        setBaselineRight(null);
        setIsDragging(false);
        setDragRight('');
        setBrushStartIdx(0);
        setBrushEndIdx(null);
        setVisibleSeries(seriesKeys.slice(0, Math.min(seriesKeys.length, 6)));
    }, [data, fileName]);

    // ── Baseline indices ──────────────────────────────────────────────────
    const baselineRange = useMemo(() => {
        if (!baselineLeft || !baselineRight || !chartData.length) return null;
        let s = chartData.findIndex(d => String(d[xKey]) === String(baselineLeft));
        let e = chartData.findIndex(d => String(d[xKey]) === String(baselineRight));
        if (s < 0) s = 0;
        if (e < 0) e = chartData.length - 1;
        if (s > e) [s, e] = [e, s];
        return { startIdx: s, endIdx: e };
    }, [baselineLeft, baselineRight, chartData, xKey]);

    // ── Per-series baseline averages ──────────────────────────────────────
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

    // ── Normalized display data: (y - avg) / avg ──────────────────────────
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

    // ── Mouse handlers on the chart ───────────────────────────────────────
    const handleMouseDown = (e) => {
        if (e && e.activeLabel) {
            setIsDragging(true);
            setBaselineLeft(e.activeLabel);
            setDragRight(e.activeLabel);
            // Clear previous baseline when starting new selection
            setBaselineRight(null);
        }
    };

    const handleMouseMove = (e) => {
        if (e && e.activeLabel) {
            setHoverLabel(e.activeLabel);
            if (isDragging) setDragRight(e.activeLabel);
        }
    };

    const handleMouseUp = () => {
        if (isDragging) {
            const finalRight = dragRight || baselineLeft;
            // Ensure left < right
            const lIdx = chartData.findIndex(d => String(d[xKey]) === String(baselineLeft));
            const rIdx = chartData.findIndex(d => String(d[xKey]) === String(finalRight));
            if (lIdx <= rIdx) {
                setBaselineRight(finalRight);
            } else {
                // swap
                setBaselineLeft(finalRight);
                setBaselineRight(baselineLeft);
            }
            setDragRight('');
            setIsDragging(false);
        }
    };

    // ── Wheel zoom (same mechanism as ChartArea) ──────────────────────────
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
        if (!isNormalized) return v;
        return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
    };

    // ── Baseline stats for info bar ───────────────────────────────────────
    const baselineStats = useMemo(() => {
        if (!baselineAvgs || !baselineRange) return [];
        return visibleSeries.map(key => ({
            key,
            avg: baselineAvgs[key] !== null ? baselineAvgs[key] : null
        }));
    }, [baselineAvgs, baselineRange, visibleSeries]);

    // ── Empty state ───────────────────────────────────────────────────────
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

    // Labels for the committed baseline area (sorted)
    const baselL = baselineLeft;
    const baselR = baselineRight || dragRight;

    return (
        <motion.div className="normalize-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>

            {/* ── Header ── */}
            <div className="normalize-header">
                <span className="normalize-title">
                    <Activity size={16} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle', color: '#fbbf24' }} />
                    Baseline Normalization — <em style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>{fileName}</em>
                </span>
                <div className="normalize-controls">
                    {/* Series chips */}
                    <div className="series-selector">
                        {seriesKeys.map((key, i) => (
                            <button
                                key={key}
                                className={`series-chip ${visibleSeries.includes(key) ? 'active' : ''}`}
                                style={{ color: COLORS[i % COLORS.length] }}
                                onClick={() => toggleSeries(key)}
                                title={visibleSeries.includes(key) ? 'Hide series' : 'Show series'}
                            >
                                <span style={{
                                    display: 'inline-block', width: 8, height: 8,
                                    borderRadius: '50%', background: COLORS[i % COLORS.length]
                                }} />
                                {key}
                            </button>
                        ))}
                    </div>
                    {baselineLeft && (
                        <button
                            className="icon-btn"
                            style={{ color: '#fbbf24', fontSize: '0.78rem', gap: 4, display: 'flex', alignItems: 'center' }}
                            onClick={clearBaseline}
                            title="Clear baseline"
                        >
                            <RotateCcw size={14} /> Clear Baseline
                        </button>
                    )}
                </div>
            </div>

            {/* ── Baseline info bar ── */}
            <div className="baseline-info-bar">
                {!baselineLeft ? (
                    <span>
                        <Target size={13} style={{ display: 'inline', marginRight: 5, verticalAlign: 'middle', color: '#fbbf24' }} />
                        <strong>Drag on the chart</strong> to select your baseline interval — the chart will normalize to <strong>(y − ȳ₀) / ȳ₀</strong>
                    </span>
                ) : (
                    <>
                        <span>
                            Baseline: <strong>{baselL}</strong>
                            {baselR && baselR !== baselL && <> → <strong>{baselR}</strong></>}
                            {baselineRange && ` (${baselineRange.endIdx - baselineRange.startIdx + 1} rows)`}
                        </span>
                        {baselineStats.slice(0, 4).map(({ key, avg }) => avg !== null && (
                            <span key={key} className="baseline-stat">
                                <span style={{ color: COLORS[seriesKeys.indexOf(key) % COLORS.length] }}>●</span>
                                {key}: <strong>{avg.toFixed(3)}</strong>
                            </span>
                        ))}
                        {isNormalized && <span style={{ color: '#34d399', fontWeight: 600, marginLeft: 4 }}>✓ Normalized</span>}
                        <button className="clear-baseline-btn" onClick={clearBaseline}>✕ Clear</button>
                    </>
                )}
            </div>

            {/* ── Chart ── */}
            <div className="normalize-chart-area">
                <div
                    ref={chartWrapperRef}
                    className={`normalize-chart-wrapper${isDragging ? ' selecting-baseline' : ''}`}
                    style={{ height: '100%' }}
                >
                    <div className="normalize-mode-hint">
                        {isDragging
                            ? '🎯 Release to set baseline'
                            : isNormalized
                                ? '📊 Showing (y − ȳ₀) / ȳ₀ — drag to reselect baseline'
                                : '🖱️ Drag on chart to define baseline interval, scroll to zoom'}
                    </div>

                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                            data={displayData}
                            margin={{ top: 36, right: 30, left: 20, bottom: 80 }}
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
                                width={isNormalized ? 70 : 55}
                                tickFormatter={formatYAxis}
                            />
                            <Tooltip
                                content={<NormalizeTooltip isNormalized={isNormalized} />}
                            />
                            <Legend
                                verticalAlign="bottom"
                                wrapperStyle={{ paddingTop: 8, bottom: 48 }}
                                formatter={(v) => (
                                    <span style={{ color: '#e2e8f0', fontSize: '0.78rem' }}>{v}</span>
                                )}
                            />
                            <Brush
                                dataKey={xKey}
                                height={26}
                                stroke="#fbbf24"
                                fill="#1e293b"
                                travellerWidth={8}
                                y={560}
                                startIndex={brushStartIdx}
                                endIndex={brushEndIdx !== null ? brushEndIdx : (displayData.length - 1)}
                                onChange={(range) => {
                                    if (range && range.startIndex !== undefined) {
                                        setBrushStartIdx(range.startIndex);
                                        setBrushEndIdx(range.endIndex);
                                    }
                                }}
                                tickFormatter={v => String(v)}
                            />

                            {/* Zero reference line when normalized */}
                            {isNormalized && (
                                <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" strokeDasharray="6 3" />
                            )}

                            {/* Live drag selection */}
                            {isDragging && baselineLeft && dragRight && (
                                <ReferenceArea
                                    x1={baselineLeft} x2={dragRight}
                                    fill="rgba(251,191,36,0.12)"
                                    stroke="rgba(251,191,36,0.5)"
                                    strokeWidth={1}
                                />
                            )}
                            {/* Committed baseline */}
                            {!isDragging && baselineLeft && baselineRight && (
                                <ReferenceArea
                                    x1={baselineLeft} x2={baselineRight}
                                    fill="rgba(251,191,36,0.08)"
                                    stroke="rgba(251,191,36,0.4)"
                                    strokeWidth={1}
                                    strokeDasharray="4 3"
                                />
                            )}

                            {/* Series lines */}
                            {visibleSeries.map((key, i) => (
                                <Line
                                    key={key}
                                    type="monotone"
                                    dataKey={key}
                                    stroke={COLORS[seriesKeys.indexOf(key) % COLORS.length]}
                                    strokeWidth={2}
                                    dot={false}
                                    activeDot={{ r: 5 }}
                                    name={key}
                                    isAnimationActive={false}
                                    connectNulls
                                />
                            ))}
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            </div>

            {/* ── Footer ── */}
            <div className="normalize-footer">
                <span className="stat">Rows: <strong>{data.length}</strong></span>
                <span className="stat">Series: <strong>{seriesKeys.length}</strong></span>
                <span className="stat">X-axis: <strong>{xKey}</strong></span>
                {baselineRange && (
                    <span className="stat" style={{ color: '#fbbf24' }}>
                        Baseline window: <strong>{baselineRange.endIdx - baselineRange.startIdx + 1} rows</strong>
                    </span>
                )}
                {isNormalized && (
                    <span className="stat" style={{ color: '#34d399' }}>
                        Mode: <strong>(y − ȳ₀) / ȳ₀</strong>
                    </span>
                )}
            </div>
        </motion.div>
    );
};

export default NormalizePage;
