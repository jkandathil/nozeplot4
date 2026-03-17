import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import {
    ResponsiveContainer,
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend
} from 'recharts';
import { Download, Grid, Square, Maximize2, AlertCircle, RefreshCw, ZoomIn, ZoomOut, MessageSquare, Image as ImageIcon } from 'lucide-react';
import { motion } from 'framer-motion';
import { toPng } from 'html-to-image';
import MultiFileSelect from './MultiFileSelect';
import LazyChart from './LazyChart';
import './ChartArea.css';

const COLORS = ['#38bdf8', '#818cf8', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#f87171', '#60a5fa'];
const COMPARE_COLORS = ['#FDA4AF', '#FCD34D', '#BEF264', '#5EEAD4', '#67E8F9', '#A5B4FC', '#F0ABFC', '#F9A8D4'];

const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
        const groups = {};

        payload.forEach(entry => {
            const dataKey = entry.dataKey;

            let baseKey = dataKey;
            let fileLabel = 'Main';
            let isCompare = false;

            if (dataKey.includes('_compare_')) {
                const parts = dataKey.split('_compare_');
                baseKey = parts[0];
                fileLabel = parts[1];
                isCompare = true;
            }

            if (!groups[baseKey]) {
                groups[baseKey] = { main: null, compares: [], color: entry.color };
            }

            if (isCompare) {
                groups[baseKey].compares.push({ label: fileLabel, value: entry.value, color: entry.color });
            } else {
                groups[baseKey].main = entry;
                groups[baseKey].color = entry.color;
            }
        });

        return (
            <div className="custom-tooltip glass-panel" style={{ maxHeight: '60vh', overflowY: 'auto', pointerEvents: 'auto', minWidth: '220px' }}>
                <p className="label" style={{ width: '100%', position: 'sticky', top: 0, background: 'rgba(15, 23, 42, 0.05)', zIndex: 2 }}>{`${label}`}</p>
                {Object.keys(groups).map((key) => {
                    const group = groups[key];
                    return (
                        <div key={key} style={{ marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                            <p style={{ color: group.color, fontWeight: 700, marginBottom: 1, fontSize: '0.75rem' }}>{key}</p>
                            <div style={{ paddingLeft: 4, fontSize: '0.7rem' }}>
                                {group.main && (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                        <span style={{ color: '#e2e8f0', opacity: 0.9 }}>Main:</span>
                                        <span style={{ fontWeight: 600 }}>{group.main.value}</span>
                                    </div>
                                )}
                                {group.compares.map((comp, idx) => (
                                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', color: comp.color }}>
                                        <span style={{ opacity: 0.8, marginRight: 8 }}>{comp.label}:</span>
                                        <span style={{ fontWeight: 600 }}>{comp.value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    }
    return null;
};

const ChartArea = ({ data, fileName, loading, compareDataList, availableFiles, onCompareSelect, compareFileIds }) => {
    const [viewMode, setViewMode] = useState('grid');
    const [focusSeries, setFocusSeries] = useState(null);
    const [removeRecoveryEvents, setRemoveRecoveryEvents] = useState(true);

    // Index-based zoom: controls Brush startIndex/endIndex.
    const [brushStartIdx, setBrushStartIdx] = useState(0);
    const [brushEndIdx, setBrushEndIdx] = useState(null); // null = last index
    const [currentHoverLabel, setCurrentHoverLabel] = useState(null);
    const [showTooltip, setShowTooltip] = useState(false);

    // Ref for chart wrapper — used to attach non-passive wheel listener
    const chartWrapperRef = useRef(null);
    const scrollContainerRef = useRef(null);

    // Identify X-axis and Series
    // Use date/time column if present; otherwise use count 1, 2, 3... (never first data column)
    const { seriesKeys: mainSeriesKeys, xKey, chartData } = useMemo(() => {
        if (!data || data.length === 0) return { seriesKeys: [], xKey: '', chartData: [] };

        let processedData = data;
        const keys = Object.keys(data[0]);
        const eventCol = keys.find(k => k.toLowerCase().includes('event') || k.toLowerCase().includes('mode') || k.toLowerCase().includes('phase'));
        if (removeRecoveryEvents && eventCol) {
            processedData = data.filter(row => !String(row[eventCol] || '').toLowerCase().includes('recovery'));
        }

        if (!processedData || processedData.length === 0) return { seriesKeys: [], xKey: '', chartData: [] };

        const potentialX = keys.find(k => {
            const low = k.toLowerCase();
            return low.includes('date') || low.includes('time') || low.includes('stamp') || low.includes('createat') || low.includes('created');
        });

        if (potentialX) {
            const series = keys.filter(k => k !== potentialX && typeof processedData[0][k] === 'number');
            return { seriesKeys: series, xKey: potentialX, chartData: processedData };
        }
        // No date/time: use index 1, 2, 3...
        const series = keys.filter(k => typeof processedData[0][k] === 'number');
        const chartDataWithIndex = processedData.map((row, i) => ({ ...row, index: i + 1 }));
        return { seriesKeys: series, xKey: 'index', chartData: chartDataWithIndex };
    }, [data, removeRecoveryEvents]);

    // Compute UNION of all series keys (Main + Comparisons)
    // This ensures we show variables that might only exist in comparison files
    const allSeriesKeys = useMemo(() => {
        const keys = new Set(mainSeriesKeys);
        if (compareDataList) {
            compareDataList.forEach(c => {
                if (c.meta && c.meta.fields) {
                    c.meta.fields.forEach(f => {
                        // Check if field is numeric in the first row of comparison data (heuristic)
                        if (f !== xKey && c.data && c.data.length > 0 && typeof c.data[0][f] === 'number') {
                            keys.add(f);
                        }
                    });
                }
            });
        }
        return Array.from(keys);
    }, [mainSeriesKeys, compareDataList, xKey]);

    // Process Comparison Data
    const compareKeysMap = useMemo(() => {
        if (!compareDataList || compareDataList.length === 0) return {};
        const map = {};

        // Iterate through ALL known series keys
        allSeriesKeys.forEach(key => {
            map[key] = [];
            compareDataList.forEach((compFile, idx) => {
                const hasKey = compFile.meta?.fields?.includes(key);
                if (hasKey) {
                    map[key].push({
                        fileName: compFile.fileName,
                        key: `${key}_compare_${compFile.fileName}`,
                        colorIndex: idx
                    });
                }
            });
        });
        return map;
    }, [allSeriesKeys, compareDataList]);

    // Merge Data for Recharts
    // Supports files with different x-axis column names (e.g. "time" vs "timestamp")
    // by using row-index alignment as fallback when value matching fails.
    // Extends the merged array to the MAXIMUM length across all files so that
    // comparison files with MORE rows than the main file are not truncated.
    const rawProcessedData = useMemo(() => {
        if (!chartData || chartData.length === 0) return [];
        if (!compareDataList || compareDataList.length === 0) return chartData;

        // For each comparison file: use date/time if present, else index 1,2,3...
        const compLookups = compareDataList.map(c => {
            const lookup = {};
            if (!c.data || c.data.length === 0) return { lookup, compXKey: null, data: [] };

            let processedCompData = c.data;
            const keys = Object.keys(c.data[0]);
            const eventCol = keys.find(k => k.toLowerCase().includes('event') || k.toLowerCase().includes('mode') || k.toLowerCase().includes('phase'));
            if (removeRecoveryEvents && eventCol) {
                processedCompData = c.data.filter(row => !String(row[eventCol] || '').toLowerCase().includes('recovery'));
            }

            if (!processedCompData || processedCompData.length === 0) return { lookup, compXKey: null, data: [] };

            const compTimeCol = keys.find(k => {
                const low = k.toLowerCase();
                return low.includes('date') || low.includes('time') || low.includes('stamp') || low.includes('createat') || low.includes('created');
            });
            const compXKey = compTimeCol || 'index';
            const compData = compTimeCol ? processedCompData : processedCompData.map((row, i) => ({ ...row, index: i + 1 }));

            compData.forEach((row, i) => {
                const xVal = compTimeCol ? row[compTimeCol] : i + 1;
                if (xVal !== undefined && xVal !== null) lookup[String(xVal)] = row;
            });
            return { lookup, compXKey, data: compData };
        });

        // Determine the maximum number of rows across all files
        const maxLen = Math.max(
            chartData.length,
            ...compareDataList.map(c => (c.data ? c.data.length : 0))
        );

        const merged = [];

        for (let rowIdx = 0; rowIdx < maxLen; rowIdx++) {
            // Base row: use main file data if available, otherwise create a synthetic
            // row using the comparison file's x-value so the x-axis stays continuous
            let baseRow;
            if (rowIdx < chartData.length) {
                baseRow = { ...chartData[rowIdx] };
            } else {
                // Main file has no row here – use index (1,2,3...) or first comp's x-value
                const firstComp = compLookups.find(cl => rowIdx < cl.data.length);
                if (!firstComp) break;
                const xVal = xKey === 'index' ? rowIdx + 1 : (firstComp.data[rowIdx][firstComp.compXKey] ?? firstComp.data[rowIdx][xKey] ?? rowIdx + 1);
                baseRow = { [xKey]: xVal };
            }

            const rowXVal = baseRow[xKey] != null ? String(baseRow[xKey]) : null;

            compLookups.forEach(({ lookup, compXKey, data }, idx) => {
                const compFile = compareDataList[idx];

                // Try value match first (works when both files share same x values)
                let compRow = rowXVal ? lookup[rowXVal] : undefined;

                // Fallback: row-index alignment
                if (!compRow && rowIdx < data.length) {
                    compRow = data[rowIdx];
                }

                if (compRow) {
                    Object.keys(compRow).forEach(key => {
                        if (typeof compRow[key] === 'number') {
                            baseRow[`${key}_compare_${compFile.fileName}`] = compRow[key];
                        }
                    });
                }
            });

            merged.push(baseRow);
        }

        return merged;
    }, [chartData, compareDataList, xKey]);

    // Dashboard shows basic merged data (recovery filtering applied beforehand, dynamically recalculates)
    const processedChartData = rawProcessedData;

    // Optimize Grid View: Downsample data to ~200 points for smooth scrolling
    const gridChartData = useMemo(() => {
        if (!processedChartData || processedChartData.length === 0) return [];

        let start = brushStartIdx;
        let end = brushEndIdx !== null ? brushEndIdx : (processedChartData.length - 1);

        // Ensure valid indices
        start = Math.max(0, start);
        end = Math.min(processedChartData.length - 1, end);
        if (start > end) [start, end] = [end, start];

        const slicedData = processedChartData.slice(start, end + 1);
        if (slicedData.length <= 200) return slicedData;

        const step = Math.ceil(slicedData.length / 200);
        return slicedData.filter((_, i) => i % step === 0);
    }, [processedChartData, brushStartIdx, brushEndIdx]);

    // Single view: slice data by zoom range (avoids Recharts Brush crash)
    const singleViewData = useMemo(() => {
        if (!processedChartData || processedChartData.length === 0) return [];
        const lastIdx = processedChartData.length - 1;
        const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;
        const start = Math.max(0, Math.min(brushStartIdx, lastIdx));
        const end = Math.max(0, Math.min(lastIdx, endIdx));
        if (start > end) return processedChartData;
        const sliced = processedChartData.slice(start, end + 1);
        return sliced.length > 0 ? sliced : processedChartData;
    }, [processedChartData, brushStartIdx, brushEndIdx]);

    const handleZoomInBtn = () => {
        try {
            if (!processedChartData || processedChartData.length === 0) return;
            const lastIdx = processedChartData.length - 1;
            const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;
            const currentSpan = endIdx - brushStartIdx;
            if (currentSpan < 4) return;
            const delta = Math.max(1, Math.floor(currentSpan * 0.35));
            const newStart = brushStartIdx + delta;
            const newEnd = endIdx - delta;
            if (newEnd <= newStart) return;
            setBrushStartIdx(newStart);
            setBrushEndIdx(newEnd);
        } catch (err) { console.warn('handleZoomInBtn error:', err); }
    };

    const handleZoomOutBtn = () => {
        try {
            if (!processedChartData || processedChartData.length === 0) return;
            const lastIdx = processedChartData.length - 1;
            const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;
            const currentSpan = endIdx - brushStartIdx;
            const delta = Math.max(1, Math.floor(currentSpan * 0.2));
            const newStart = Math.max(0, brushStartIdx - delta);
            const newEnd = Math.min(lastIdx, endIdx + delta);
            setBrushStartIdx(newStart);
            setBrushEndIdx(newEnd === lastIdx && newStart === 0 ? null : newEnd);
        } catch (err) { console.warn('handleZoomOutBtn error:', err); }
    };

    // Reset zoom when data changes
    React.useEffect(() => {
        setBrushStartIdx(0);
        setBrushEndIdx(null);
    }, [data, fileName, compareDataList]);

    // useCallback so the ref-based effect depends on it without stale closures
    const handleWheel = useCallback((e) => {
        try {
            if (viewMode !== 'single' || !processedChartData || processedChartData.length === 0) return;
            e.preventDefault();

            const zoomIn = e.deltaY < 0;
            const lastIdx = processedChartData.length - 1;
            const startIdx = brushStartIdx;
            const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;

            const currentSpan = endIdx - startIdx;
            const minSpan = 4;
            if (currentSpan < minSpan && zoomIn) return;

            // Trackpad friendly smooth zoom
            const intensity = Math.min(Math.abs(e.deltaY) * 0.002, 0.4);
            const delta = Math.max(1, Math.floor(currentSpan * intensity));

            let pivotIdx = Math.floor(startIdx + currentSpan / 2);
            if (currentHoverLabel) {
                const hoverIdx = processedChartData.findIndex(item => String(item[xKey]) === String(currentHoverLabel));
                if (hoverIdx >= startIdx && hoverIdx <= endIdx) pivotIdx = hoverIdx;
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
        } catch (err) { console.warn('handleWheel zoom error:', err); }
    }, [viewMode, processedChartData, brushStartIdx, brushEndIdx, xKey, currentHoverLabel]);

    // Keep a stable reference to the latest handleWheel callback
    const handleWheelRef = useRef(handleWheel);
    useEffect(() => {
        handleWheelRef.current = handleWheel;
    }, [handleWheel]);

    // Attach wheel listener as non-passive so preventDefault() actually works.
    // By depending only on viewMode, we avoid reattaching the listener 60 times a second during zoom.
    useEffect(() => {
        if (viewMode !== 'single') return;
        const el = chartWrapperRef.current;
        if (!el) return;
        const listener = (e) => handleWheelRef.current(e);
        el.addEventListener('wheel', listener, { passive: false });
        return () => el.removeEventListener('wheel', listener);
    }, [viewMode]);

    const zoomOut = () => {
        setBrushStartIdx(0);
        setBrushEndIdx(null);
    };

    const formatXAxis = (tickItem) => {
        if (!tickItem) return '';
        return String(tickItem);
    };

    const toggleViewMode = (mode) => {
        if (mode === 'grid') {
            zoomOut();
        }
        setViewMode(mode);
        // Always reset focus when switching main views via buttons
        setFocusSeries(null);
    };

    const handleFocus = (key) => {
        setFocusSeries(key);
        setViewMode('single');
    };

    const handleDownloadPng = async () => {
        const el = scrollContainerRef.current;
        if (!el) return;
        try {
            const dataUrl = await toPng(el, {
                backgroundColor: '#0f172a',
                pixelRatio: 2,
                style: { margin: 0 }
            });
            const link = document.createElement('a');
            link.download = `plot_${fileName || 'data'}.png`;
            link.href = dataUrl;
            link.click();
        } catch (err) {
            console.error('Download PNG failed:', err);
        }
    };

    const handleDownload = () => {
        // Simple CSV export of the current data
        if (!processedChartData || processedChartData.length === 0) return;

        const keys = Object.keys(processedChartData[0]);
        const csvContent = [
            keys.join(','),
            ...processedChartData.map(row => keys.map(k => row[k]).join(','))
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `export_${fileName || 'data'}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    if (loading) {
        return (
            <div className="chart-area-loading">
                <RefreshCw className="spinner" size={48} />
                <p>Parsing data...</p>
            </div>
        );
    }

    if (!data || data.length === 0) {
        return (
            <div className="chart-area-empty">
                <p>No valid data found in this file.</p>
            </div>
        );
    }

    if (allSeriesKeys.length === 0) {
        return (
            <div className="chart-area-empty">
                <AlertCircle size={48} color="#f87171" style={{ marginBottom: 16 }} />
                <p>No numeric columns found to plot.</p>
            </div>
        )
    }

    const singleViewKeys = focusSeries ? [focusSeries] : allSeriesKeys;

    return (
        <motion.div
            className="chart-area"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
        >
            <div className="chart-header">
                <h2 className="file-title">{fileName}</h2>
                <span className="raw-badge" style={{ fontSize: '0.7rem', color: 'var(--text-muted)', background: 'rgba(56,189,248,0.12)', padding: '2px 8px', borderRadius: 6, marginLeft: 8 }} title="Dashboard shows raw data only. Use Normalize tab for baseline normalization.">Raw Data</span>
                <div className="chart-controls">
                    {/* Zoom and Tooltip Controls available in both views! */}
                    <button className={`icon-btn ${showTooltip ? 'active' : ''}`} onClick={() => setShowTooltip(!showTooltip)} title="Show Data Values">
                        <MessageSquare size={18} /> <span style={{ fontSize: '0.8rem', marginLeft: 4 }}>Values</span>
                    </button>
                    <div className="separator" />
                    <button type="button" className="icon-btn" onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleZoomInBtn(); }} title="Zoom In (show fewer points)">
                        <ZoomIn size={18} /> <span style={{ fontSize: '0.75rem', marginLeft: 2 }}>In</span>
                    </button>
                    <button type="button" className="icon-btn" onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleZoomOutBtn(); }} title="Zoom Out (show more points)">
                        <ZoomOut size={18} /> <span style={{ fontSize: '0.75rem', marginLeft: 2 }}>Out</span>
                    </button>
                    {(brushStartIdx > 0 || (brushEndIdx !== null && brushEndIdx < processedChartData.length - 1)) && (
                        <button className="icon-btn" onClick={zoomOut} title="Reset Zoom">
                            <RefreshCw size={16} /> <span style={{ fontSize: '0.8rem', marginLeft: 4 }}>Reset</span>
                        </button>
                    )}
                    <div className="separator" />

                    <button
                        className={`icon-btn ${viewMode === 'grid' ? 'active' : ''}`}
                        onClick={() => toggleViewMode('grid')}
                        title="Grid View (2 Columns)"
                    >
                        <Grid size={20} />
                    </button>
                    <button
                        className={`icon-btn ${viewMode === 'single' ? 'active' : ''}`}
                        onClick={() => toggleViewMode('single')}
                        title="Single Chart View"
                    >
                        <Square size={20} />
                    </button>

                    <div className="separator" />

                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.75rem', color: '#94a3b8' }} title="Remove Recovery Phase data from visualization">
                        <input
                            type="checkbox"
                            checked={removeRecoveryEvents}
                            onChange={(e) => setRemoveRecoveryEvents(e.target.checked)}
                            style={{ accentColor: '#38bdf8', cursor: 'pointer', margin: 0, width: 14, height: 14 }}
                        />
                        Remove Recovery
                    </label>

                    <div className="separator" />

                    {/* Multi Comparison Select */}
                    <div style={{ marginRight: 12 }}>
                        <MultiFileSelect
                            options={availableFiles}
                            selected={compareFileIds || []}
                            onChange={onCompareSelect}
                            placeholder="Compare with..."
                        />
                    </div>

                    <div className="separator" />

                    <button className="icon-btn" onClick={handleDownloadPng} title="Download View as PNG (Image)">
                        <ImageIcon size={18} /> <span style={{ fontSize: '0.8rem', marginLeft: 4 }}>PNG</span>
                    </button>

                    <button className="icon-btn" onClick={handleDownload} title="Export CSV Data">
                        <Download size={18} /> <span style={{ fontSize: '0.8rem', marginLeft: 4 }}>CSV</span>
                    </button>
                </div>
            </div>

            {/* Global Zoom Range Controller */}
            {processedChartData && processedChartData.length > 4 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', background: 'rgba(15,23,42,0.8)', borderBottom: '1px solid var(--border-color)', zIndex: 10 }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>X-Axis Interval:</span>

                    {/* Manual Input Range */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                            type="number"
                            className="text-input"
                            style={{ width: 80, padding: '4px 8px', fontSize: '0.75rem' }}
                            value={String(processedChartData[brushStartIdx]?.[xKey] || '')}
                            onChange={(e) => {
                                const targetX = e.target.value;
                                const idx = processedChartData.findIndex(r => String(r[xKey]).startsWith(targetX));
                                if (idx !== -1 && idx <= (brushEndIdx || processedChartData.length - 1)) {
                                    setBrushStartIdx(idx);
                                }
                            }}
                            title={`Start ${xKey}`}
                        />
                        <span style={{ color: 'var(--text-muted)' }}>to</span>
                        <input
                            type="number"
                            className="text-input"
                            style={{ width: 80, padding: '4px 8px', fontSize: '0.75rem' }}
                            value={String(processedChartData[brushEndIdx !== null ? brushEndIdx : processedChartData.length - 1]?.[xKey] || '')}
                            onChange={(e) => {
                                const targetX = e.target.value;
                                const idx = processedChartData.findIndex(r => String(r[xKey]).startsWith(targetX));
                                if (idx !== -1 && idx >= brushStartIdx) {
                                    setBrushEndIdx(idx);
                                }
                            }}
                            title={`End ${xKey}`}
                        />
                    </div>

                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: 8 }}>Scroll/Pan:</span>
                    <input
                        type="range"
                        min={0}
                        max={Math.max(0, processedChartData.length - (singleViewData.length))}
                        value={brushStartIdx}
                        onChange={(e) => {
                            const newStart = parseInt(e.target.value, 10);
                            const currentSpan = (brushEndIdx !== null ? brushEndIdx : processedChartData.length - 1) - brushStartIdx;
                            setBrushStartIdx(newStart);
                            setBrushEndIdx(newStart + currentSpan);
                        }}
                        style={{ flex: 1, height: 6, accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                        title="Pan Left/Right"
                    />

                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', minWidth: 60, textAlign: 'right' }}>
                        {singleViewData.length} pts
                    </span>
                </div>
            )}

            <div className={`charts-scroll-container ${viewMode}`} ref={scrollContainerRef}>
                {viewMode === 'single' ? (
                    <div
                        ref={chartWrapperRef}
                        className="chart-container-wrapper glass-panel single-chart-view"
                        style={{ height: '100%', width: '100%', position: 'relative' }}
                    >
                        <div className="zoom-hint" style={{
                            position: 'absolute',
                            top: '10px',
                            left: '50%',
                            transform: 'translateX(-50%)',
                            zIndex: 10,
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)',
                            background: 'rgba(15, 23, 42, 0.8)',
                            padding: '4px 12px',
                            borderRadius: '20px',
                            pointerEvents: 'none',
                            border: '1px solid var(--border-color)',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
                        }}>
                            <span style={{ color: 'var(--accent-primary)' }}>Zoom In</span> / <span style={{ color: 'var(--accent-primary)' }}>Zoom Out</span> buttons or scroll — {brushStartIdx > 0 || (brushEndIdx !== null && processedChartData && brushEndIdx < processedChartData.length - 1) ? 'zoomed' : 'full range'}
                        </div>
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart
                                data={singleViewData}
                                margin={{ top: 10, right: 30, left: 0, bottom: 20 }}
                                onMouseMove={(e) => {
                                    if (e && e.activeLabel !== undefined) setCurrentHoverLabel(e.activeLabel);
                                }}
                                onContextMenu={(e) => e.preventDefault()}
                            >
                                <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.5} />
                                <XAxis
                                    dataKey={xKey}
                                    stroke="#94a3b8"
                                    tick={{ fill: '#94a3b8' }}
                                    minTickGap={30}
                                    tickFormatter={formatXAxis}
                                    interval="preserveStartEnd"
                                />
                                <YAxis
                                    stroke="#94a3b8"
                                    tick={{ fill: '#94a3b8' }}
                                    domain={['auto', 'auto']}
                                    width={55}
                                />
                                {showTooltip && (
                                    <Tooltip
                                        content={<CustomTooltip />}
                                        position={{ x: 60, y: 10 }}
                                        wrapperStyle={{ zIndex: 100 }}
                                    />
                                )}
                                <Legend
                                    verticalAlign="bottom"
                                    wrapperStyle={{ paddingTop: '10px', bottom: 20 }}
                                    formatter={(value) => (
                                        <span style={{ color: '#e2e8f0', fontSize: '0.8rem' }}>{value}</span>
                                    )}
                                />
                                {singleViewKeys.flatMap((key, index) => {
                                    const lines = [
                                        <Line
                                            key={`main-${key}`}
                                            type="monotone"
                                            dataKey={key}
                                            stroke={COLORS[allSeriesKeys.indexOf(key) % COLORS.length]}
                                            strokeWidth={2}
                                            dot={false}
                                            activeDot={{ r: 6 }}
                                            name={key}
                                            isAnimationActive={false}
                                        />
                                    ];
                                    if (compareKeysMap[key]) {
                                        compareKeysMap[key].forEach(comp => {
                                            lines.push(
                                                <Line
                                                    key={comp.key}
                                                    type="monotone"
                                                    dataKey={comp.key}
                                                    stroke={COMPARE_COLORS[(comp.colorIndex + allSeriesKeys.indexOf(key)) % COMPARE_COLORS.length]}
                                                    strokeWidth={2}
                                                    strokeOpacity={0.9}
                                                    dot={false}
                                                    activeDot={{ r: 4, strokeWidth: 0 }}
                                                    name={`${key} (${comp.fileName})`}
                                                    connectNulls
                                                    isAnimationActive={false}
                                                />
                                            );
                                        });
                                    }
                                    return lines;
                                })}
                            </LineChart>
                        </ResponsiveContainer>
                        {/* Zoom range slider moved to the global header */}
                    </div>
                ) : (
                    <div className="charts-grid">
                        {allSeriesKeys.map((key, index) => (
                            <div
                                key={key}
                                className="chart-grid-item glass-panel"
                                onClick={() => handleFocus(key)}
                                style={{ cursor: 'pointer' }}
                                title="Click to Maximize and Zoom"
                            >
                                <div className="chart-grid-header">
                                    <h3 className="chart-title">{key}</h3>
                                    <button
                                        className="icon-btn small"
                                        onClick={(e) => { e.stopPropagation(); handleFocus(key); }}
                                        title="Maximize & Zoom"
                                    >
                                        <Maximize2 size={14} />
                                    </button>
                                </div>
                                <div className="mini-chart-wrapper" style={{ flex: 1, minHeight: 0 }}>
                                    <LazyChart height={200}>
                                        <ResponsiveContainer width="100%" height="100%">
                                            <LineChart data={gridChartData} margin={{ top: 10, right: 10, left: 5, bottom: 5 }}>
                                                {/* Grid removed for performance */}
                                                <XAxis
                                                    dataKey={xKey}
                                                    stroke="#64748b"
                                                    tick={{ fill: '#64748b', fontSize: 10 }}
                                                    height={30}
                                                    minTickGap={30}
                                                    tickFormatter={formatXAxis}
                                                />
                                                <YAxis stroke="#94a3b8" tick={{ fill: '#94a3b8', fontSize: 10 }} domain={['auto', 'auto']} width={40} />
                                                {/* Tooltip removed */}
                                                {[
                                                    <Line
                                                        key={`main-${key}`}
                                                        type="monotone"
                                                        dataKey={key}
                                                        stroke={COLORS[index % COLORS.length]}
                                                        strokeWidth={2}
                                                        dot={false}
                                                        activeDot={{ r: 4 }}
                                                        name={key}
                                                        isAnimationActive={false}
                                                    />,
                                                    ...(compareKeysMap[key] ? compareKeysMap[key].map((comp, cIdx) => (
                                                        <Line
                                                            key={comp.key}
                                                            type="monotone"
                                                            dataKey={comp.key}
                                                            stroke={COMPARE_COLORS[comp.colorIndex % COMPARE_COLORS.length]}
                                                            strokeWidth={2}
                                                            strokeOpacity={0.8}
                                                            dot={false}
                                                            activeDot={{ r: 3, strokeWidth: 0 }}
                                                            name={`${key} (${comp.fileName})`}
                                                            connectNulls
                                                            isAnimationActive={false}
                                                        />
                                                    )) : [])
                                                ]}

                                            </LineChart>
                                        </ResponsiveContainer>
                                    </LazyChart>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="chart-footer">
                <div className="stat-card">
                    <span className="stat-label">Rows</span>
                    <span className="stat-value">{data.length}</span>
                </div>
                <div className="stat-card">
                    <span className="stat-label">Variables</span>
                    <span className="stat-value">{allSeriesKeys.length}</span>
                </div>
                <div className="stat-card">
                    <span className="stat-label">X-Axis</span>
                    <span className="stat-value">{xKey}</span>
                </div>
            </div>
        </motion.div >
    );
};

export default ChartArea;
