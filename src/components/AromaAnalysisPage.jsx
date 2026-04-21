import React, { useState, useMemo, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
    LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, ComposedChart, Area, Brush, CartesianGrid, ReferenceLine
} from 'recharts';
import { RefreshCw, Play, Settings, Activity, LineChart as LineChartIcon, Maximize2, X, ZoomIn, ZoomOut, Download, Layers } from 'lucide-react';
import { toPng } from 'html-to-image';
import './AromaAnalysisPage.css';
import { shouldRemoveRecoveryBlock } from '../utils/recoveryEventFilter';
import {
    findPlotEventColumn,
    FENO_MEASUREMENT_BLOCK_SUBSTRINGS,
    isUnknownOrCleaningPhaseNorm,
} from '../utils/normalizePlotRowFilter';
import { extractConcentration } from '../utils/aromaAnalysisPipeline';

/**
 * Magnus Formula constants
 */
const SATURATION_VAPOR_PRESSURE_0C = 6.112;
const MAGNUS_COEFFICIENT_A = 17.67;
const MAGNUS_COEFFICIENT_B = 243.5;
const GAS_CONSTANT_RATIO = 2.1674;
const KELVIN_OFFSET = 273.15;

const CustomAromaLegend = (props) => {
    const { payload, targetPlot } = props;
    return (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '12px' }}>
            {payload.map((entry, index) => {
                if (typeof entry.value === 'string' && entry.value.includes('Spread')) return null;

                let baselineStr = '';
                if (targetPlot && targetPlot.data && typeof entry.dataKey === 'string') {
                    const baseKey = entry.dataKey.replace('_mean', '');
                    for (let r = 0; r < Math.min(targetPlot.data.length, 50); r++) {
                        const rowObj = targetPlot.data[r];
                        if (rowObj && rowObj[`${baseKey}_raw_baseline`] !== undefined) {
                            baselineStr = `Baseline: ${rowObj[`${baseKey}_raw_baseline`].toFixed(1)} Ω`;
                            break;
                        }
                    }
                }
                return (
                    <li key={`item-${index}`} title={baselineStr} style={{ fontSize: '11px', cursor: baselineStr ? 'help' : 'default', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <svg width="8" height="8"><circle cx="4" cy="4" r="4" fill={entry.color} /></svg>
                        <span style={{ color: entry.color, fontWeight: 500 }}>{entry.value}</span>
                    </li>
                );
            })}
        </ul>
    );
};

const CustomTooltip = ({ active, payload, label, referenceLines }) => {
    if (active && payload && payload.length > 0) {
        let currentEvent = null;
        let eventColor = '#94a3b8';

        if (referenceLines && referenceLines.length > 0) {
            let matchedRef = null;
            for (let i = 0; i < referenceLines.length; i++) {
                if (referenceLines[i].x <= Number(label)) {
                    matchedRef = referenceLines[i];
                } else {
                    break;
                }
            }
            if (matchedRef && matchedRef.label) {
                currentEvent = matchedRef.label;
                eventColor = matchedRef.stroke;
            }
        }

        return (
            <div style={{ backgroundColor: 'rgba(15, 23, 42, 0.9)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '12px', color: '#f8fafc', fontSize: '11px', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
                <div style={{ marginBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '4px', fontWeight: 600, color: '#94a3b8' }}>
                    Index: {label}
                    {currentEvent && (
                        <div style={{ marginTop: '4px', color: eventColor }}>
                            <strong>Event:</strong> {currentEvent}
                        </div>
                    )}
                </div>
                {payload.map((entry, index) => {
                    let valDisplay = entry.value;
                    if (typeof valDisplay === 'number') {
                        valDisplay = (valDisplay % 1 !== 0) ? parseFloat(valDisplay.toFixed(3)) : valDisplay;
                    }
                    return (
                        <div key={index} style={{ color: entry.color || '#fff', padding: '1px 0' }}>
                            {entry.name}: {valDisplay}
                        </div>
                    );
                })}
            </div>
        );
    }
    return null;
};

// Utility to apply moving average
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

const CustomAromaTooltip = ({ active, payload, label, yAxisLabel, referenceLines }) => {
    if (!active || !payload || !payload.length) return null;

    let eventNameValue = null;
    let eventColor = '#10b981';

    if (referenceLines && referenceLines.length > 0) {
        let matchedRef = null;
        for (let i = 0; i < referenceLines.length; i++) {
            if (referenceLines[i].x <= Number(label)) {
                matchedRef = referenceLines[i];
            } else {
                break;
            }
        }
        if (matchedRef && matchedRef.label) {
            eventNameValue = matchedRef.label;
            eventColor = matchedRef.stroke;
        }
    } else if (payload[0] && payload[0].payload) {
        const row = payload[0].payload;
        if (row.event_name !== undefined && row.event_name !== null) {
            let val = String(row.event_name).trim();
            if (!val.startsWith('{') && val.length < 45 && val !== '') {
                eventNameValue = val;
            }
        }
    }

    return (
        <div style={{
            background: 'rgba(15,23,42,0.35)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 12,
            padding: '12px',
            fontSize: '0.8rem',
            pointerEvents: 'auto',
            boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
            maxHeight: 320,
            overflowY: 'auto',
            maxWidth: 400,
            zIndex: 50
        }}>
            <div style={{ color: '#94a3b8', marginBottom: 8, fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 4, display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
                <span>{String(label)}</span>
                {eventNameValue && (
                    <span style={{ color: eventColor }}>{eventNameValue}</span>
                )}
            </div>
            {payload.map((entry, i) => {
                let displayName = typeof entry.name === 'string' ? entry.name : String(entry.name);
                if (displayName.includes('Spread')) return null;
                if (Array.isArray(entry.value)) return null;

                const isPercent = yAxisLabel && yAxisLabel.includes('%');

                let minMaxStr = '';
                if (payload[0] && payload[0].payload && entry.dataKey && typeof entry.dataKey === 'string') {
                    const baseKey = entry.dataKey.replace('_mean', '');
                    const rowObj = payload[0].payload;

                    if (entry.dataKey.endsWith('_mean') && rowObj[`${baseKey}_min`] !== undefined && rowObj[`${baseKey}_max`] !== undefined) {
                        const minStr = rowObj[`${baseKey}_min`].toFixed(2);
                        const maxStr = rowObj[`${baseKey}_max`].toFixed(2);
                        const ps = isPercent ? '%' : '';
                        minMaxStr = ` (min: ${minStr}${ps}, max: ${maxStr}${ps})`;
                    }
                }

                return (
                    <div key={i} style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px',
                        color: entry.color,
                        marginBottom: 6,
                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                        paddingBottom: 4
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ opacity: 0.9, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', fontSize: '12px' }}>
                                {displayName}
                            </span>
                            <strong style={{ whiteSpace: 'nowrap', fontSize: '13px', marginLeft: '12px' }}>
                                {typeof entry.value === 'number' ? `${entry.value.toFixed(2)}${isPercent ? '%' : ''}` : entry.value}
                            </strong>
                        </div>
                        {minMaxStr && (
                            <div style={{ fontSize: '11px', opacity: 0.7 }}>
                                {minMaxStr}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

const ZoomablePlotViewer = ({ plot, onClose }) => {
    const chartWrapperRef = React.useRef(null);
    const chartContainerRef = React.useRef(null);
    const [brushStartIdx, setBrushStartIdx] = useState(0);
    const [brushEndIdx, setBrushEndIdx] = useState(null);

    const visibleData = React.useMemo(() => {
        if (!plot?.data || !Array.isArray(plot.data) || plot.data.length === 0) return [];
        const lastIdx = plot.data.length - 1;
        const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;
        const start = Math.max(0, Math.min(brushStartIdx, lastIdx));
        const end = Math.max(0, Math.min(lastIdx, endIdx));
        if (start > end) return plot.data;
        const sliced = plot.data.slice(start, end + 1);
        return sliced.length > 0 ? sliced : plot.data;
    }, [plot, brushStartIdx, brushEndIdx]);

    const handleZoomInBtn = () => {
        if (!plot?.data || plot.data.length === 0) return;
        const lastIdx = plot.data.length - 1;
        const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;
        const currentSpan = endIdx - brushStartIdx;
        if (currentSpan < 2) return;
        const delta = Math.max(1, Math.floor(currentSpan * 0.35));
        const newStart = brushStartIdx + delta;
        const newEnd = endIdx - delta;
        if (newEnd <= newStart) return;
        setBrushStartIdx(newStart);
        setBrushEndIdx(newEnd);
    };

    const handleZoomOutBtn = () => {
        try {
            if (!plot?.data || plot.data.length === 0) return;
            const lastIdx = plot.data.length - 1;
            const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;
            const currentSpan = endIdx - brushStartIdx;
            const delta = Math.max(1, Math.floor(currentSpan * 0.35));
            const newStart = Math.max(0, brushStartIdx - delta);
            const newEnd = Math.min(lastIdx, endIdx + delta);
            setBrushStartIdx(newStart);
            setBrushEndIdx(newEnd === lastIdx && newStart === 0 ? null : newEnd);
        } catch (err) { console.warn('handleZoomOutBtn error:', err); }
    };

    const handleWheel = React.useCallback((e) => {
        try {
            if (!plot || !plot.data || plot.data.length === 0) return;
            e.preventDefault();

            const zoomIn = e.deltaY < 0;
            const lastIdx = plot.data.length - 1;
            const startIdx = brushStartIdx;
            const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;

            const currentSpan = endIdx - startIdx;
            const minSpan = 4;
            if (currentSpan < minSpan && zoomIn) return;

            const intensity = Math.min(Math.abs(e.deltaY) * 0.002, 0.4);
            const delta = Math.max(1, Math.floor(currentSpan * intensity));

            let pivotIdx = Math.floor(startIdx + currentSpan / 2);
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
        } catch (err) { console.warn('handleWheel zoom error:', err); }
    }, [plot, brushStartIdx, brushEndIdx]);

    React.useEffect(() => {
        const el = chartWrapperRef.current;
        if (!el) return;
        el.addEventListener('wheel', handleWheel, { passive: false });
        return () => el.removeEventListener('wheel', handleWheel);
    }, [handleWheel]);

    const handleDownloadPng = async () => {
        const el = chartContainerRef.current;
        if (!el) return;
        try {
            const dataUrl = await toPng(el, {
                backgroundColor: '#0f172a',
                pixelRatio: 2,
                style: { margin: 0 }
            });
            const link = document.createElement('a');
            link.download = `${(plot?.title || 'plot').replace(/[^a-z0-9]/gi, '_')}.png`;
            link.href = dataUrl;
            link.click();
        } catch (err) {
            console.error('Download failed:', err);
        }
    };

    if (!plot || !plot.data) return null;

    const yAxisLabel = plot.yAxisLabel || 'Value';

    return (
        <div className="zoomable-plot-modal glass-panel" onClick={(e) => e.stopPropagation()} style={{ pointerEvents: 'auto' }}>
            <div className="modal-header" style={{ flexShrink: 0 }}>
                <h3>{plot?.title || 'Plot'}</h3>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', position: 'relative', zIndex: 1001 }}>
                    <button type="button" className="icon-btn small" onClick={(e) => { e.stopPropagation(); handleDownloadPng(); }} title="Download as PNG" style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #334155', cursor: 'pointer', background: 'rgba(16,185,129,0.1)' }}>
                        <Download size={18} /> <span style={{ fontSize: '0.8rem', marginLeft: 4, fontWeight: 600 }}>Download PNG</span>
                    </button>
                    <button type="button" className="icon-btn small" onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleZoomInBtn(); }} title="Zoom In (fewer points)" style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #334155', cursor: 'pointer', background: 'rgba(16,185,129,0.1)' }}>
                        <ZoomIn size={18} /> <span style={{ fontSize: '0.8rem', marginLeft: 4, fontWeight: 600 }}>Zoom In</span>
                    </button>
                    <button type="button" className="icon-btn small" onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleZoomOutBtn(); }} title="Zoom Out (more points)" style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #334155', cursor: 'pointer', background: 'rgba(16,185,129,0.1)' }}>
                        <ZoomOut size={18} /> <span style={{ fontSize: '0.8rem', marginLeft: 4, fontWeight: 600 }}>Zoom Out</span>
                    </button>
                    {(brushStartIdx > 0 || (brushEndIdx !== null && plot.data && brushEndIdx < plot.data.length - 1)) && (
                        <button type="button" className="icon-btn small" onClick={(e) => { e.stopPropagation(); setBrushStartIdx(0); setBrushEndIdx(null); }} style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #334155' }}>
                            <RefreshCw size={14} style={{ marginRight: 4 }} /> Reset Zoom
                        </button>
                    )}
                    <button className="icon-btn close-btn" onClick={onClose}>
                        <X size={24} />
                    </button>
                </div>
            </div>
            <div
                className="modal-body"
                ref={chartWrapperRef}
                style={{
                    width: '100%',
                    height: 'calc(100vh - 120px - var(--auth-session-bar-height, 0px))',
                    position: 'relative',
                }}
            >
                <div className="zoom-hint" style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 10, fontSize: '0.8rem', color: '#94a3b8', background: 'rgba(15,23,42,0.9)', padding: '6px 16px', borderRadius: 20, pointerEvents: 'none', border: '1px solid #334155' }}>
                    {(brushStartIdx > 0 || (brushEndIdx !== null && plot.data && brushEndIdx < plot.data.length - 1))
                        ? <strong style={{ color: '#10b981' }}>Zoomed: {visibleData.length} of {plot.data.length} points</strong>
                        : <span><span style={{ color: '#38bdf8' }}>Zoom In</span> / <span style={{ color: '#38bdf8' }}>Zoom Out</span> or scroll</span>}
                </div>
                {plot?.data && plot.data.length > 2 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', background: 'rgba(0,0,0,0.2)', marginBottom: 8, borderRadius: 8 }}>
                        <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>X-Axis Interval:</span>

                        {/* Manual Input Range */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <input
                                type="number"
                                style={{ width: 80, padding: '4px 8px', fontSize: '0.75rem', background: '#1e293b', border: '1px solid #334155', color: '#f8fafc', borderRadius: 4 }}
                                value={String(plot.data[brushStartIdx]?.[plot.xAxisKey || 'index'] || '')}
                                onChange={(e) => {
                                    const targetX = e.target.value;
                                    const xK = plot.xAxisKey || 'index';
                                    const idx = plot.data.findIndex(r => String(r[xK]).startsWith(targetX));
                                    if (idx !== -1 && idx <= (brushEndIdx || plot.data.length - 1)) {
                                        setBrushStartIdx(idx);
                                    }
                                }}
                                title="Start X"
                            />
                            <span style={{ color: '#94a3b8' }}>to</span>
                            <input
                                type="number"
                                style={{ width: 80, padding: '4px 8px', fontSize: '0.75rem', background: '#1e293b', border: '1px solid #334155', color: '#f8fafc', borderRadius: 4 }}
                                value={String(plot.data[brushEndIdx !== null ? brushEndIdx : plot.data.length - 1]?.[plot.xAxisKey || 'index'] || '')}
                                onChange={(e) => {
                                    const targetX = e.target.value;
                                    const xK = plot.xAxisKey || 'index';
                                    const idx = plot.data.findIndex(r => String(r[xK]).startsWith(targetX));
                                    if (idx !== -1 && idx >= brushStartIdx) {
                                        setBrushEndIdx(idx);
                                    }
                                }}
                                title="End X"
                            />
                        </div>

                        <span style={{ fontSize: '0.75rem', color: '#94a3b8', marginLeft: 8 }}>Scroll/Pan:</span>
                        <input
                            type="range"
                            min={0}
                            max={Math.max(0, plot.data.length - visibleData.length)}
                            value={brushStartIdx}
                            onChange={(e) => {
                                const newStart = parseInt(e.target.value, 10);
                                const currentSpan = (brushEndIdx !== null ? brushEndIdx : plot.data.length - 1) - brushStartIdx;
                                setBrushStartIdx(newStart);
                                setBrushEndIdx(Math.min(plot.data.length - 1, newStart + currentSpan));
                            }}
                            style={{ flex: 1, height: 6, accentColor: '#10b981', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: '0.75rem', color: '#94a3b8', minWidth: 70 }}>
                            {visibleData.length} / {plot.data.length} pts
                        </span>
                    </div>
                )}
                <div ref={chartContainerRef} style={{ width: '100%', height: '100%', minHeight: 300, background: '#0f172a', borderRadius: 8, padding: 12 }}>
                    <ResponsiveContainer width="100%" height="100%" style={{ minHeight: 300 }}>
                        {plot.isComposed ? (
                            <ComposedChart
                                key={`zoom-${brushStartIdx}-${brushEndIdx}`}
                                data={visibleData.length > 0 ? visibleData : plot.data}
                                margin={{ top: 20, right: 30, left: 40, bottom: 20 }}
                                onContextMenu={e => e.preventDefault()}
                            >
                                <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                <XAxis dataKey={plot.xAxisKey || "index"} tick={{ fill: '#94a3b8' }} stroke="#334155" />
                                <YAxis tick={{ fill: '#94a3b8' }} stroke="#334155" domain={['auto', 'auto']} width={65} label={{ value: yAxisLabel, angle: -90, position: 'insideLeft', fill: '#94a3b8', style: { textAnchor: 'middle' } }} tickFormatter={(val) => {
                                    const suffix = (yAxisLabel && yAxisLabel.includes('%')) ? '%' : '';
                                    return `${parseFloat(val.toFixed(3))}${suffix}`;
                                }} />
                                <RechartsTooltip
                                    content={<CustomAromaTooltip yAxisLabel={yAxisLabel} referenceLines={plot.referenceLines} />}
                                    cursor={false}
                                    wrapperStyle={{ pointerEvents: 'auto' }}
                                />
                                <Legend wrapperStyle={{ fontSize: '0.85rem', color: '#e2e8f0', bottom: 20 }} iconType="circle" />
                                {plot.referenceLines && plot.referenceLines.map((rl, rIdx) => (
                                    <ReferenceLine
                                        key={`ref-${rIdx}`}
                                        x={rl.x}
                                        stroke={rl.stroke}
                                        strokeDasharray="3 3"
                                        strokeOpacity={0.7}
                                    />
                                ))}
                                {plot.areas && plot.areas.map((area, aIdx) => <Area key={`area-${aIdx}`} type="monotone" dataKey={area.dataKey} name={area.name} fill={area.color} fillOpacity={0.15} stroke="none" isAnimationActive={false} connectNulls={false} legendType="none" />)}
                                {plot.lines && plot.lines.map((line, lIdx) => <Line key={`line-${lIdx}`} type="monotone" dataKey={line.dataKey} name={line.name} stroke={line.color} strokeWidth={2} dot={plot.xAxisKey ? true : false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} />)}
                            </ComposedChart>
                        ) : (
                            <LineChart
                                key={`zoom-${brushStartIdx}-${brushEndIdx}`}
                                data={visibleData.length > 0 ? visibleData : (plot.data || [])}
                                margin={{ top: 20, right: 30, left: 40, bottom: 20 }}
                                onContextMenu={e => e.preventDefault()}
                            >
                                <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                <XAxis dataKey="index" tick={{ fill: '#94a3b8' }} stroke="#334155" />
                                <YAxis tick={{ fill: '#94a3b8' }} stroke="#334155" domain={['auto', 'auto']} width={65} label={{ value: yAxisLabel, angle: -90, position: 'insideLeft', fill: '#94a3b8', style: { textAnchor: 'middle' } }} tickFormatter={(val) => {
                                    const suffix = (yAxisLabel && yAxisLabel.includes('%')) ? '%' : '';
                                    return `${parseFloat(val.toFixed(3))}${suffix}`;
                                }} />
                                <RechartsTooltip
                                    content={<CustomAromaTooltip yAxisLabel={yAxisLabel} referenceLines={plot.referenceLines} />}
                                    cursor={false}
                                    wrapperStyle={{ pointerEvents: 'auto' }}
                                />
                                <Legend wrapperStyle={{ fontSize: '0.85rem', color: '#e2e8f0', bottom: 20 }} iconType="circle" />
                                {(plot.lines || []).map((line, lIdx) => <Line key={lIdx} type="monotone" dataKey={line.dataKey} name={line.name} stroke={line.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />)}
                            </LineChart>
                        )}
                    </ResponsiveContainer>
                </div>
            </div>
        </div>
    );
};

const AromaAnalysisPage = ({ data, fileName, compareDataList = [], availableFiles = [], onPageChange }) => {
    const [isSidebarVisible, setIsSidebarVisible] = useState(() => localStorage.getItem('zenMode') !== 'true');

    useEffect(() => {
        const handleZenMode = (e) => setIsSidebarVisible(!e.detail.isZen);
        window.addEventListener('zen-mode-toggle', handleZenMode);
        return () => window.removeEventListener('zen-mode-toggle', handleZenMode);
    }, []);

    // Form config
    const defaultSensing = 'A1, A2, A3, A4, A5, A6, A7, A8, B1, B2, B3, B4, B5, B6, B7, B8, C1, C2, C3, C4, C5, C6, C7, C8, D1, D2, D3, D4, D5, D6, D7, D8, E1, E2, E3, E4, E5, E6, E7, E8, F1, F2, F3, F4, F5, F6, F7, F8, G1, G2, G3, G4, G5, G6, G7, G8, H1, H2, H3, H4, H5, H6, H7, H8';
    const [sensingElements, setSensingElements] = useState(() => localStorage.getItem('aroma_sensingElements') || defaultSensing);
    const [tempCols, setTempCols] = useState(() => localStorage.getItem('aroma_tempCols') || 'BT1, AQT0');
    const [humCols, setHumCols] = useState(() => localStorage.getItem('aroma_humCols') || 'AQH0, TRHH0');
    const [filterWindow, setFilterWindow] = useState(() => parseInt(localStorage.getItem('aroma_filterWindow') || '5', 10));
    const [baselinePts, setBaselinePts] = useState(() => parseInt(localStorage.getItem('aroma_baselinePts') || '50', 10));
    const [removeRecoveryEvents, setRemoveRecoveryEvents] = useState(() => localStorage.getItem('aroma_removeRecoveryEvents') === 'false' ? false : true);
    const [fenoTruncateSeconds, setFenoTruncateSeconds] = useState(() => parseInt(localStorage.getItem('aroma_fenoTruncateSeconds') || '0', 10));
    const [filterUnknown, setFilterUnknown] = useState(() => localStorage.getItem('aroma_filterUnknown') === 'false' ? false : true);
    const [separateByUnit, setSeparateByUnit] = useState(false);

    useEffect(() => {
        localStorage.setItem('aroma_sensingElements', sensingElements);
        localStorage.setItem('aroma_tempCols', tempCols);
        localStorage.setItem('aroma_humCols', humCols);
        localStorage.setItem('aroma_filterWindow', filterWindow.toString());
        localStorage.setItem('aroma_baselinePts', baselinePts.toString());
        localStorage.setItem('aroma_removeRecoveryEvents', removeRecoveryEvents.toString());
        localStorage.setItem('aroma_fenoTruncateSeconds', fenoTruncateSeconds.toString());
        localStorage.setItem('aroma_filterUnknown', filterUnknown.toString());
    }, [sensingElements, tempCols, humCols, filterWindow, baselinePts, removeRecoveryEvents, fenoTruncateSeconds, filterUnknown]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [gapStart, setGapStart] = useState('');
    const [gapEnd, setGapEnd] = useState('');
    const [selectedPlot, setSelectedPlot] = useState(null);
    const [sidebarWidth, setSidebarWidth] = useState(340);

    const handleMouseDown = React.useCallback((e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = sidebarWidth;

        const onMouseMove = (moveEvent) => {
            let newWidth = startWidth + (moveEvent.clientX - startX);
            if (newWidth < 250) newWidth = 250;
            if (newWidth > 600) newWidth = 600;
            setSidebarWidth(newWidth);
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = 'default';
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.body.style.cursor = 'col-resize';
    }, [sidebarWidth]);

    // Results
    const [processedBatch, setProcessedBatch] = useState(null);

    const handleProcessBatch = () => {
        setIsProcessing(true);
        setTimeout(() => {
            try {
                // Determine batch input
                const allFiles = [];
                if (data && fileName) {
                    allFiles.push({ fileName, data });
                }
                if (compareDataList && compareDataList.length > 0) {
                    compareDataList.forEach(c => allFiles.push(c));
                }

                if (allFiles.length === 0) {
                    setIsProcessing(false);
                    return;
                }

                const sElementsArr = sensingElements.split(',').map(s => s.trim()).filter(Boolean);
                const tColsArr = tempCols.split(',').map(s => s.trim()).filter(Boolean);
                const hColsArr = humCols.split(',').map(s => s.trim()).filter(Boolean);

                const newBatch = allFiles.map(fileObj => {
                    let fileData = fileObj.data;
                    if (!fileData || fileData.length === 0) return fileObj;

                    // 1. Identify sensing variables based on substring matches
                    const sampleKeys = Object.keys(fileData[0]);
                    const sensingKeys = sampleKeys.filter(k =>
                        sElementsArr.some(prefix => k.toLowerCase().includes(prefix.toLowerCase())) ||
                        tColsArr.some(prefix => k.toLowerCase().includes(prefix.toLowerCase())) ||
                        hColsArr.some(prefix => k.toLowerCase().includes(prefix.toLowerCase()))
                    );

                    // 1.5 ALAAC Smart Truncation: Delete Recovery events (so graph fills the area) & FeNO truncating
                    const originalData = [...fileData];
                    if (removeRecoveryEvents || fenoTruncateSeconds > 0 || filterUnknown) {
                        const eventCol =
                            findPlotEventColumn(fileData[0]) ||
                            sampleKeys.find((col) => {
                                const l = col.toLowerCase();
                                return (
                                    l === 'event_name' ||
                                    l === 'phase' ||
                                    l === 'mode' ||
                                    l === 'state' ||
                                    (l.includes('event') && !l.includes('reference'))
                                );
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
                            const allowedPlots = FENO_MEASUREMENT_BLOCK_SUBSTRINGS;
                            const hasBreathEvents = blocks.some((b) =>
                                allowedPlots.some((p) => b.event.includes(p))
                            );

                            blocks.forEach((b) => {
                                if (hasBreathEvents) {
                                    const isAllowedPLOT = allowedPlots.some((p) => b.event.includes(p));
                                    if (!isAllowedPLOT && b.event !== '') {
                                        for (let i = b.startIdx; i <= b.endIdx; i++) rowsToRemove.add(i);
                                    } else if (
                                        fenoTruncateSeconds > 0 &&
                                        (b.event.includes('feno') || b.event.includes('breath'))
                                    ) {
                                        const allowedRows = fenoTruncateSeconds * 3;
                                        for (let i = b.startIdx + allowedRows; i <= b.endIdx; i++)
                                            rowsToRemove.add(i);
                                    }
                                } else {
                                    if (removeRecoveryEvents && shouldRemoveRecoveryBlock(b.event)) {
                                        for (let i = b.startIdx; i <= b.endIdx; i++) rowsToRemove.add(i);
                                    }
                                    if (filterUnknown && isUnknownOrCleaningPhaseNorm(b.event)) {
                                        for (let i = b.startIdx; i <= b.endIdx; i++) rowsToRemove.add(i);
                                    }
                                    if (fenoTruncateSeconds > 0 && (b.event.includes('feno') || b.event.includes('breath'))) {
                                        const allowedRows = fenoTruncateSeconds * 3;
                                        for (let i = b.startIdx + allowedRows; i <= b.endIdx; i++)
                                            rowsToRemove.add(i);
                                    }
                                }
                            });
                            fileData = fileData.filter((_, idx) => !rowsToRemove.has(idx));
                        }
                    }

                    // Plot visual boundaries for events (calculated AFTER truncation so X-axis matches)
                    let detectedEvents = [];
                    const evCol =
                        findPlotEventColumn(fileData[0]) ||
                        sampleKeys.find((col) => {
                            const l = col.toLowerCase();
                            return (
                                l === 'event_name' ||
                                l === 'phase' ||
                                l === 'mode' ||
                                l === 'state' ||
                                (l.includes('event') && !l.includes('reference'))
                            );
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

                    // 2. Filter Signal
                    let processedData = applyMovingAverage(fileData, filterWindow, sensingKeys);

                    // 2.5 Baseline Normalization (Matches ALAAC: (value / median) - 1.0)
                    const normCols = sensingKeys.filter(k => k.toLowerCase().includes('normalized'));
                    const rawCols = sensingKeys.filter(k => !k.toLowerCase().includes('normalized'));

                    // Helper to get median of an array
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
                            // Check if file has an event column and 'RFC' event
                            const eventCol =
                                findPlotEventColumn(originalData[0]) ||
                                Object.keys(originalData[0] || {}).find((col) => {
                                    const l = col.toLowerCase();
                                    return (
                                        l === 'event_name' ||
                                        l === 'phase' ||
                                        l === 'mode' ||
                                        l === 'state' ||
                                        (l.includes('event') && !l.includes('reference'))
                                    );
                                });
                            let rfcEventRows = [];

                            if (eventCol) {
                                rfcEventRows = originalData.filter(row => row[eventCol] && typeof row[eventCol] === 'string' && (row[eventCol].includes('RFC') || row[eventCol].includes('AmbientSampling')));
                            }

                            if (rfcEventRows.length > 0) {
                                // Take last N points of the RFC event
                                const pts = Math.min(baselinePts, rfcEventRows.length);
                                const targetRows = rfcEventRows.slice(-pts);
                                baselineVals = targetRows.map(r => r[k]).filter(v => typeof v === 'number');
                            } else {
                                // Fallback: Take first N points of the file
                                const pts = Math.min(baselinePts, originalData.length);
                                for (let i = 0; i < pts; i++) {
                                    if (typeof originalData[i][k] === 'number') {
                                        baselineVals.push(originalData[i][k]);
                                    }
                                }
                            }

                            baselines[k] = getMedian(baselineVals);
                            // Prevent division by zero
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
                                    row[`${k}_unnormalized_pts`] = row[k]; 
                                    row[k] = ((row[k] / b) - 1.0) * 100.0;
                                    row[`${k}_raw_baseline`] = b;
                                } else {
                                    row[`${k}_unnormalized_pts`] = row[k]; 
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

                    // 3. Compute Absolute Humidity (Magnus Formula)
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
                sequenceAverages.forEach((seq) => {
                    if (removeRecoveryEvents && seq.str.includes('recovery')) return;
                    if (!colorMap[seq.label]) {
                        colorMap[seq.label] = uniqueColors[colorIdx % uniqueColors.length];
                        colorIdx++;
                    }
                    const avgStart = Math.min(...seq.starts); // Use conservative minimum boundary
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

                setProcessedBatch({
                    files: newBatch,
                    sensingPrefixes: sElementsArr,
                    tCodes: tColsArr,
                    hCodes: hColsArr,
                    gapStartVal: gapStart !== '' ? parseInt(gapStart, 10) : null,
                    gapEndVal: gapEnd !== '' ? parseInt(gapEnd, 10) : null,
                    filterUnknownVal: filterUnknown,
                    referenceLines: refLines,
                    auIdVal: finalAuIdVal,
                    separateByUnitVal: separateByUnit
                });

            } catch (err) {
                console.error("Batch processing error:", err);
            } finally {
                setIsProcessing(false);
            }
        }, 300); // Simulate async pipeline step
    };

    const channelPlotsData = useMemo(() => {
        if (!processedBatch || processedBatch.files.length === 0) return null;

        const { files, sensingPrefixes, tCodes, hCodes, gapStartVal, gapEndVal, filterUnknownVal, referenceLines, auIdVal, separateByUnitVal } = processedBatch;

        const auIdSuffix = auIdVal && auIdVal !== 'Unknown AU' && !separateByUnitVal ? ` (${auIdVal})` : '';

        // Plot container config variables
        const plots = [];

        // 1. Group files by concentration (ALAAC logic: only ppb, never ppm)
        const extractConcValue = (name) => {
            const m = String(name).match(/(\d+(?:\.\d+)?)\s*(ppb|ppm)\b/i);
            if (!m) return 0;
            const n = parseFloat(m[1]);
            return m[2].toLowerCase() === 'ppm' ? n * 1000 : n;
        };

        const groups = {}; // { '90 ppb': [f1, f2] }
        files.forEach(f => {
            const c = extractConcentration(f.fileName, false, separateByUnitVal, f.data);
            if (filterUnknownVal && c === 'Unknown') return;
            if (!groups[c]) groups[c] = [];
            groups[c].push(f);
        });

        const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
            if (a === 'Unknown') return 1;
            if (b === 'Unknown') return -1;
            const rawA = String(a).startsWith('Raw ·');
            const rawB = String(b).startsWith('Raw ·');
            if (rawA && !rawB) return 1;
            if (!rawA && rawB) return -1;
            if (rawA && rawB) return a.localeCompare(b);
            const numA = extractConcValue(a);
            const numB = extractConcValue(b);
            if (numA === numB) {
                return a.localeCompare(b);
            }
            return numA - numB;
        });

        // Determine max length only from the groups actively being plotted 
        // to prevent empty right-side padding if an unused file is longer
        let activeMaxLen = 0;
        sortedGroupKeys.forEach(g => {
            groups[g].forEach(f => {
                if (f.data.length > activeMaxLen) activeMaxLen = f.data.length;
            });
        });
        const maxLen = activeMaxLen;

        // Pre-detect the keys that map to each type to avoid searching inside the 3000+ iteration loop
        const tMatchKeys = new Array(files.length).fill(null);
        const hMatchKeys = new Array(files.length).fill(null);
        const absHMatchKeys = new Array(files.length).fill(null);

        // Structure to cache matching prefixes per file: filePrefixCache[fIdx][prefix] = "matchedKey"
        const filePrefixCache = files.map(() => ({}));

        files.forEach((f, fIdx) => {
            if (f.data.length > 0) {
                const keys = Object.keys(f.data[0]);

                // Map Temp, Hum, Abs-H keys once per file
                tMatchKeys[fIdx] = keys.find(k => tCodes.some(c => k.includes(c)));
                hMatchKeys[fIdx] = keys.find(k => hCodes.some(c => k.includes(c)) && !k.startsWith('abs-'));
                absHMatchKeys[fIdx] = keys.find(k => k.startsWith('abs-'));

                // Map Sensing Elements once per file (align with processing: use includes for flexible matching)
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

        // 3. Process time-series grouped calculations & populate monotonic variables
        const calibrationDataMap = {};

        sensingPrefixes.forEach(prefix => {
            const lines = [];
            const areas = [];
            let hasData = false;

            for (let i = 0; i < maxLen; i++) {
                if (gapStartVal !== null && gapEndVal !== null && i >= gapStartVal && i <= gapEndVal) continue;
                sortedGroupKeys.forEach((gName) => {
                    const values = [];
                    const rawValues = [];
                    let pureRawPrefix = '';
                    
                    groups[gName].forEach(f => {
                        const absFIdx = files.indexOf(f);
                        const matchedKey = filePrefixCache[absFIdx][prefix];

                        if (matchedKey && i < f.data.length) {
                            const val = f.data[i][matchedKey];
                            if (typeof val === 'number') {
                                values.push(val);
                                // Need to store raw mappings if we want individual lines later
                                combinedData[i][`f${absFIdx}_${matchedKey}`] = val;
                            }
                            
                            // Capture actual physical Ohms natively inside the ALAAC processing loop!
                            pureRawPrefix = matchedKey.replace(/norm(?:alized)?_?/gi, '');
                            let pureRawVal = f.data[i][`${pureRawPrefix}_unnormalized_pts`];
                            if (pureRawVal === undefined) pureRawVal = f.data[i][pureRawPrefix]; // fallback if not scaled
                            if (typeof pureRawVal === 'number') {
                                rawValues.push(pureRawVal);
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
                        
                        // Permanently inject the true raw un-normalized Physical Ohms into the exported CSV matrix
                        if (rawValues.length > 0 && pureRawPrefix) {
                            const rawMean = rawValues.reduce((a,b)=>a+b,0)/rawValues.length;
                            combinedData[i][`${gName}_${pureRawPrefix}_raw`] = rawMean;
                        }
                    }
                });
            }

            if (hasData) {
                sortedGroupKeys.forEach((gName, gIdx) => {
                    const color = COLORS[gIdx % COLORS.length];
                    lines.push({ dataKey: `${gName}_${prefix}_mean`, name: `${gName} Average`, color });
                    areas.push({ dataKey: `${gName}_${prefix}_range`, name: `${gName} Spread (±1σ)`, color });

                    if (gName !== 'Unknown' && !String(gName).startsWith('Raw ·')) {
                        const pureConcLabel = separateByUnitVal ? extractConcentration(groups[gName][0]?.fileName || "", true, false, groups[gName][0]?.data) : gName;
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
                    title: `Time Series Average: ${prefix}${auIdSuffix}`,
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
            sensingPrefixes.forEach((prefix, pIdx) => {
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

        // 5. Environmental properties (grouped if large, individual if small)
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
                        const conc = extractConcentration(f.fileName, false, separateByUnitVal, f.data);
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

        // Downsample large time-series to prevent rendering crashes
        const DOWNSAMPLE_LIMIT = 500;
        plots.forEach(p => {
            if (p.data && p.data.length > DOWNSAMPLE_LIMIT) {
                const step = Math.ceil(p.data.length / DOWNSAMPLE_LIMIT);
                p.data = p.data.filter((_, idx) => idx % step === 0);
            }
        });

        return plots;

    }, [processedBatch]);

    const handleDownloadFullDataCSV = () => {
        const timeSeriesPlot = (channelPlotsData || []).find(p => p.title && p.title.includes('Time Series Average:'));
        if (!timeSeriesPlot || !timeSeriesPlot.data) {
            alert('No analyzed data available to download. Please process a batch first.');
            return;
        }

        const data = timeSeriesPlot.data;
        const headers = Object.keys(data[0]);

        // Flatten the arrays into separate min/max columns
        const flatHeaders = [];
        headers.forEach(h => {
            if (h.endsWith('_range')) {
                const base = h.replace('_range', '');
                flatHeaders.push(`${base}_sigma_min`, `${base}_sigma_max`);
            } else {
                flatHeaders.push(h);
            }
        });

        // Build CSV rows
        const csvContent = [
            flatHeaders.join(','),
            ...data.map(row => flatHeaders.map(fh => {
                let val = '';
                if (fh.endsWith('_sigma_min')) {
                    const rangeProp = fh.replace('_sigma_min', '_range');
                    val = row[rangeProp] ? row[rangeProp][0] : '';
                } else if (fh.endsWith('_sigma_max')) {
                    const rangeProp = fh.replace('_sigma_max', '_range');
                    val = row[rangeProp] ? row[rangeProp][1] : '';
                } else {
                    val = row[fh];
                }
                // Handle missing values or quotes if needed
                return val !== undefined && val !== null ? val : '';
            }).join(','))
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `aroma_full_analysis_data${fileName ? '_' + fileName.split('.')[0] : ''}.csv`;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    return (
        <motion.div
            className="aroma-analysis-container"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
        >
            <div className="aroma-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div className="icon-wrapper">
                        <LineChartIcon size={18} color="#10b981" />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <h1 className="page-title" style={{ marginBottom: 0 }}>Aroma Sensor Batch Analysis</h1>
                        {processedBatch?.auIdVal && (
                            <span style={{ fontSize: '0.9rem', color: '#10b981', fontWeight: 600 }}>{processedBatch.auIdVal}</span>
                        )}
                    </div>
                </div>
                {(channelPlotsData || []).length > 0 && (
                    <button
                        onClick={handleDownloadFullDataCSV}
                        style={{ flex: 'none', width: 'auto', display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '6px', fontSize: '0.8rem', background: '#10b981', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                        title="Download Full Time Series Analysis Data as CSV"
                    >
                        <Download size={16} /> Download Full Data CSV
                    </button>
                )}
            </div>

            <div className="aroma-content">
                {isSidebarVisible && (
                <div 
                    className="config-panel glass-panel" style={{ width: sidebarWidth, position: 'relative' }}>
                    {/* Drag Handle */}
                    <div
                        onMouseDown={handleMouseDown}
                        style={{
                            position: 'absolute',
                            top: 0,
                            right: -5,
                            width: '10px',
                            height: '100%',
                            cursor: 'col-resize',
                            zIndex: 10,
                        }}
                    />
                    <h3 className="panel-title"><Settings size={16} /> Pipeline Configuration</h3>

                    <div className="form-group">
                        <label>Sensing Elements (Comma separated A1, A2...)</label>
                        <input
                            type="text"
                            className="text-input"
                            value={sensingElements}
                            onChange={e => setSensingElements(e.target.value)}
                        />
                    </div>

                    <div className="form-group-row">
                        <div className="form-group">
                            <label>Temp Column Code</label>
                            <input
                                type="text"
                                className="text-input"
                                value={tempCols}
                                onChange={e => setTempCols(e.target.value)}
                            />
                        </div>
                        <div className="form-group">
                            <label>Humidity Column Code</label>
                            <input
                                type="text"
                                className="text-input"
                                value={humCols}
                                onChange={e => setHumCols(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="form-group-row">
                        <div className="form-group">
                            <label>Truncate Gap Start (Idx)</label>
                            <input
                                type="number"
                                className="text-input"
                                value={gapStart}
                                onChange={e => setGapStart(e.target.value)}
                                placeholder="e.g. 500"
                            />
                        </div>
                        <div className="form-group">
                            <label>Truncate Gap End (Idx)</label>
                            <input
                                type="number"
                                className="text-input"
                                value={gapEnd}
                                onChange={e => setGapEnd(e.target.value)}
                                placeholder="e.g. 800"
                            />
                        </div>
                    </div>

                    <div className="form-group" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', marginBottom: '16px', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <input
                                type="checkbox"
                                checked={removeRecoveryEvents}
                                onChange={(e) => setRemoveRecoveryEvents(e.target.checked)}
                                id="remove-recovery-chk"
                                style={{ width: 14, height: 14, accentColor: '#10b981', cursor: 'pointer' }}
                            />
                            <label htmlFor="remove-recovery-chk" style={{ margin: 0, cursor: 'pointer', fontSize: '0.8rem' }}>No Recovery</label>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <input
                                type="checkbox"
                                checked={filterUnknown}
                                onChange={(e) => setFilterUnknown(e.target.checked)}
                                id="aroma-filter-unknown-chk"
                                style={{ width: 14, height: 14, accentColor: '#10b981', cursor: 'pointer' }}
                            />
                            <label htmlFor="aroma-filter-unknown-chk" style={{ margin: 0, cursor: 'pointer', fontSize: '0.8rem' }}>No Unknowns</label>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <input
                                type="radio"
                                checked={!separateByUnit}
                                onChange={() => setSeparateByUnit(false)}
                                name="auGroupMode"
                                id="au-group-merge"
                                style={{ width: 14, height: 14, accentColor: '#38bdf8', cursor: 'pointer' }}
                            />
                            <label htmlFor="au-group-merge" style={{ margin: 0, cursor: 'pointer', fontSize: '0.8rem', color: !separateByUnit ? '#38bdf8' : '#94a3b8' }}>Merge AUs / Calculate Average</label>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <input
                                type="radio"
                                checked={separateByUnit}
                                onChange={() => setSeparateByUnit(true)}
                                name="auGroupMode"
                                id="au-group-split"
                                style={{ width: 14, height: 14, accentColor: '#38bdf8', cursor: 'pointer' }}
                            />
                            <label htmlFor="au-group-split" style={{ margin: 0, cursor: 'pointer', fontSize: '0.8rem', color: separateByUnit ? '#38bdf8' : '#94a3b8' }}>Split AUs / Render Individual</label>
                        </div>
                        <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between', marginTop: '4px' }}>
                            <label style={{ fontSize: '0.8rem', margin: 0 }}>Cut FeNO tail (secs):</label>
                            <input
                                type="number"
                                className="text-input"
                                min="0"
                                value={fenoTruncateSeconds}
                                onChange={e => setFenoTruncateSeconds(e.target.value)}
                                placeholder="0"
                                style={{ width: '60px', padding: '4px 8px', fontSize: '0.8rem', height: '28px' }}
                            />
                        </div>
                    </div>

                    <div className="form-group">
                        <label>Noise Filter Window (Moving Average)</label>
                        <div className="slider-wrapper">
                            <input
                                type="range"
                                min="1" max="50"
                                value={filterWindow}
                                onChange={e => setFilterWindow(parseInt(e.target.value))}
                                className="range-slider"
                            />
                            <span className="slider-value">{filterWindow} pt</span>
                        </div>
                    </div>

                    <div className="form-group">
                        <label>Baseline Normalization (pts)</label>
                        <div className="slider-wrapper">
                            <input
                                type="range"
                                min="0" max="200"
                                value={baselinePts}
                                onChange={e => setBaselinePts(parseInt(e.target.value))}
                                className="range-slider"
                                style={{ accentColor: baselinePts > 0 ? '#fbbf24' : '#64748b' }}
                            />
                            <span className="slider-value">{baselinePts === 0 ? 'Off' : `${baselinePts} pt`}</span>
                        </div>
                        <small style={{ display: 'block', marginTop: 4, color: '#94a3b8' }}>Uses ALAAC Median logic ((Val / Median) - 1) on "RFC" event or first N pts.</small>
                    </div>

                    <div className="active-files-info">
                        <strong>Target Batch:</strong> {data ? '1 Main File' : '0 Files'} + {compareDataList.length} Comparison Files
                        <br />
                        <small style={{ color: 'var(--text-muted)' }}>Note: Add comparison files via Dashboard to batch process them together.</small>
                    </div>

                    <button
                        className="btn-primary process-btn"
                        onClick={handleProcessBatch}
                        disabled={isProcessing || (!data && compareDataList.length === 0)}
                        style={(!data && compareDataList.length === 0) ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                    >
                        {isProcessing ? <RefreshCw className="spinner" size={16} /> : <Play size={16} />}
                        {isProcessing ? 'Processing Batch...' : 'Run Pipeline & Plot'}
                    </button>
                    <button
                        className="btn-secondary process-btn"
                        onClick={() => onPageChange && onPageChange('folderCompareAroma')}
                        style={{ marginTop: '8px', width: '100%', border: '1px solid rgba(56, 189, 248, 0.4)', color: '#38bdf8', background: 'rgba(56, 189, 248, 0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                        title="Compare Aroma Analysis across all Workspace Custom Folders"
                    >
                        <Layers size={16} /> AU Batch Plots
                    </button>
                </div>
                )}

                <div className="results-panel">
                    {channelPlotsData ? (
                        <div className="plots-grid">
                            {channelPlotsData.map((plot, idx) => (
                                <div key={idx} className="plot-card glass-panel" style={{ cursor: 'pointer' }} onClick={() => setSelectedPlot(plot)}>
                                    <h4 className="plot-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        {plot.shortTitle || plot.title}
                                        <button className="icon-btn small" onClick={(e) => { e.stopPropagation(); setSelectedPlot(plot); }} title="Maximize & Zoom">
                                            <Maximize2 size={14} />
                                        </button>
                                    </h4>
                                    <div style={{ height: 280, width: '100%', position: 'relative' }}>
                                        <ResponsiveContainer width="100%" height="100%">
                                            {plot.isComposed ? (
                                                <ComposedChart data={plot.data} margin={{ top: 10, right: 10, left: 10, bottom: 5 }}>
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                                    <XAxis dataKey={plot.xAxisKey || "index"} tick={{ fontSize: 10, fill: '#64748b' }} stroke="#334155" />
                                                    <YAxis tick={{ fontSize: 10, fill: '#64748b' }} stroke="#334155" domain={['auto', 'auto']} width={65} tickFormatter={(val) => {
                                                        const suffix = (plot.yAxisLabel && plot.yAxisLabel.includes('%')) ? '%' : '';
                                                        return `${parseFloat(val.toFixed(3))}${suffix}`;
                                                    }} />
                                                    <RechartsTooltip content={<CustomTooltip referenceLines={plot.referenceLines} />} cursor={false} />
                                                    {((plot.lines?.length || 0) + (plot.areas?.length || 0)) <= 100 && (
                                                        <Legend content={<CustomAromaLegend targetPlot={plot} />} wrapperStyle={{ paddingTop: '0px', marginTop: '-10px', paddingBottom: '0px' }} />
                                                    )}
                                                    {plot.referenceLines && plot.referenceLines.map((rl, rIdx) => (
                                                        <ReferenceLine
                                                            key={`ref-${rIdx}`}
                                                            x={rl.x}
                                                            stroke={rl.stroke}
                                                            strokeDasharray="3 3"
                                                            strokeOpacity={0.7}
                                                        />
                                                    ))}
                                                    {plot.areas && plot.areas.map((area, aIdx) => (
                                                        <Area key={`area-${aIdx}`} type="monotone" dataKey={area.dataKey} name={area.name} fill={area.color} fillOpacity={0.15} stroke="none" isAnimationActive={false} connectNulls={false} legendType="none" />
                                                    ))}
                                                    {plot.lines && plot.lines.map((line, lIdx) => (
                                                        <Line key={`line-${lIdx}`} type="monotone" dataKey={line.dataKey} name={line.name} stroke={line.color} strokeWidth={2} dot={plot.xAxisKey ? true : false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} />
                                                    ))}
                                                </ComposedChart>
                                            ) : (
                                                <LineChart data={plot.data} margin={{ top: 10, right: 10, left: 10, bottom: 5 }}>
                                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                                    <XAxis dataKey="index" tick={{ fontSize: 10, fill: '#64748b' }} stroke="#334155" />
                                                    <YAxis tick={{ fontSize: 10, fill: '#64748b' }} stroke="#334155" domain={['auto', 'auto']} width={65} tickFormatter={(val) => {
                                                        const suffix = (plot.yAxisLabel && plot.yAxisLabel.includes('%')) ? '%' : '';
                                                        return `${parseFloat(val.toFixed(3))}${suffix}`;
                                                    }} />
                                                    <RechartsTooltip content={<CustomTooltip referenceLines={plot.referenceLines} />} cursor={false} />
                                                    {(plot.lines?.length || 0) <= 100 && (
                                                        <Legend content={<CustomAromaLegend targetPlot={plot} />} wrapperStyle={{ paddingTop: '0px', marginTop: '-10px', paddingBottom: '0px' }} />
                                                    )}
                                                    {(plot.lines || []).map((line, lIdx) => (
                                                        <Line
                                                            key={lIdx}
                                                            type="monotone"
                                                            dataKey={line.dataKey}
                                                            name={line.name}
                                                            stroke={line.color}
                                                            strokeWidth={2}
                                                            dot={false}
                                                            activeDot={{ r: 4 }}
                                                            isAnimationActive={false}
                                                        />
                                                    ))}
                                                </LineChart>
                                            )}
                                        </ResponsiveContainer>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="empty-results glass-panel">
                            <Activity size={48} color="#334155" />
                            <p>Configure and run the pipeline to generate batch parameter plots.</p>
                        </div>
                    )}
                </div>
            </div>

            {selectedPlot && (
                <ZoomablePlotViewer key={selectedPlot.title} plot={selectedPlot} onClose={() => setSelectedPlot(null)} />
            )}
        </motion.div>
    );
};

// Colors for multi-line plots (Matching Tableau Python Palette)
const COLORS = [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
    '#9467bd', '#8c564b', '#e377c2', '#7f7f7f',
    '#bcbd22', '#17becf', '#2E91E5', '#E15F99',
    '#1CA71C', '#FB0D0D', '#DA16FF'
];

export default AromaAnalysisPage;
