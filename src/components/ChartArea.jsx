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
    Brush,
    ReferenceArea
} from 'recharts';
import { Download, Grid, Square, Maximize2, AlertCircle, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react';
import { motion } from 'framer-motion';
import MultiFileSelect from './MultiFileSelect';
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
            <div className="custom-tooltip glass-panel">
                <p className="label">{`${label}`}</p>
                {Object.keys(groups).map((key) => {
                    const group = groups[key];
                    return (
                        <div key={key} style={{ marginBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 4 }}>
                            <p style={{ color: group.color, fontWeight: 700, marginBottom: 2 }}>{key}</p>
                            <div style={{ paddingLeft: 8, fontSize: '0.8rem' }}>
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

    // Index-based zoom: controls Brush startIndex/endIndex.
    // domain-based approach doesn't work for type="category" XAxis in Recharts.
    const [brushStartIdx, setBrushStartIdx] = useState(0);
    const [brushEndIdx, setBrushEndIdx] = useState(null); // null = last index
    const [currentHoverLabel, setCurrentHoverLabel] = useState(null);
    const [isRightClicking, setIsRightClicking] = useState(false);
    const [refAreaLeft, setRefAreaLeft] = useState('');
    const [refAreaRight, setRefAreaRight] = useState('');
    const [animation, setAnimation] = useState(true);

    // Ref for chart wrapper — used to attach non-passive wheel listener
    const chartWrapperRef = useRef(null);

    // Identify X-axis and Series
    const { seriesKeys: mainSeriesKeys, xKey, chartData } = useMemo(() => {
        if (!data || data.length === 0) return { seriesKeys: [], xKey: '', chartData: [] };

        const keys = Object.keys(data[0]);
        let x = keys[0];
        const potentialX = keys.find(k => k.toLowerCase().includes('date') || k.toLowerCase().includes('time'));
        if (potentialX) x = potentialX;

        const series = keys.filter(k => k !== x && typeof data[0][k] === 'number');

        return { seriesKeys: series, xKey: x, chartData: data };
    }, [data]);

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
    const processedChartData = useMemo(() => {
        if (!chartData || chartData.length === 0) return [];
        if (!compareDataList || compareDataList.length === 0) return chartData;

        // For each comparison file: detect its xKey and build value-based lookup
        const compLookups = compareDataList.map(c => {
            const lookup = {};
            if (!c.data || c.data.length === 0) return { lookup, compXKey: null, data: [] };

            const keys = Object.keys(c.data[0]);
            const compXKey = keys.find(k => k.toLowerCase().includes('date') || k.toLowerCase().includes('time')) || keys[0];

            c.data.forEach(row => {
                const xVal = row[compXKey] ?? row[xKey];
                if (xVal !== undefined && xVal !== null) lookup[String(xVal)] = row;
            });
            return { lookup, compXKey, data: c.data };
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
                // Main file has no row here – use the first comparison file's x-value
                // so we still have a valid x coordinate
                const firstComp = compLookups.find(cl => rowIdx < cl.data.length);
                if (!firstComp) break;
                const compXKey = firstComp.compXKey;
                const xVal = firstComp.data[rowIdx][compXKey] ?? firstComp.data[rowIdx][xKey];
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

    // Reset zoom when data changes
    React.useEffect(() => {
        setBrushStartIdx(0);
        setBrushEndIdx(null);
        setRefAreaLeft('');
        setRefAreaRight('');
        setAnimation(true);
    }, [data, fileName]);

    // useCallback so the ref-based effect depends on it without stale closures
    const handleWheel = useCallback((e) => {
        if (viewMode !== 'single' || !processedChartData || processedChartData.length === 0) return;
        e.preventDefault();

        const zoomIn = e.deltaY < 0;
        const lastIdx = processedChartData.length - 1;
        const startIdx = brushStartIdx;
        const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;

        const currentSpan = endIdx - startIdx;
        const minSpan = 4;
        if (currentSpan < minSpan && zoomIn) return;

        const zoomFactor = 0.15;
        const delta = Math.max(1, Math.floor(currentSpan * zoomFactor));

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
        setAnimation(false);
    }, [viewMode, processedChartData, brushStartIdx, brushEndIdx, xKey, currentHoverLabel]);

    // Attach wheel listener as non-passive so preventDefault() actually works.
    useEffect(() => {
        const el = chartWrapperRef.current;
        if (!el) return;
        el.addEventListener('wheel', handleWheel, { passive: false });
        return () => el.removeEventListener('wheel', handleWheel);
    }, [handleWheel]);

    // Drag-to-zoom: use the selected area labels to find their indices
    const zoomSelection = () => {
        if (!refAreaLeft || !refAreaRight) {
            setRefAreaLeft('');
            setRefAreaRight('');
            setIsRightClicking(false);
            return;
        }

        let lIdx = processedChartData.findIndex(i => String(i[xKey]) === String(refAreaLeft));
        let rIdx = processedChartData.findIndex(i => String(i[xKey]) === String(refAreaRight));

        if (lIdx < 0) lIdx = 0;
        if (rIdx < 0) rIdx = processedChartData.length - 1;
        if (lIdx > rIdx) [lIdx, rIdx] = [rIdx, lIdx];

        setRefAreaLeft('');
        setRefAreaRight('');
        setBrushStartIdx(lIdx);
        setBrushEndIdx(rIdx);
        setAnimation(false);
        setIsRightClicking(false);
    };

    const zoomOut = () => {
        setBrushStartIdx(0);
        setBrushEndIdx(null);
        setRefAreaLeft('');
        setRefAreaRight('');
        setAnimation(true);
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
                <div className="chart-controls">
                    {/* Zoom Out Button only in Single View */}
                    {viewMode === 'single' && (brushStartIdx > 0 || (brushEndIdx !== null && brushEndIdx < processedChartData.length - 1)) && (
                        <button className="icon-btn" onClick={zoomOut} title="Reset Zoom">
                            <RefreshCw size={16} /> <span style={{ fontSize: '0.8rem', marginLeft: 4 }}>Reset</span>
                        </button>
                    )}

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

                    <button className="icon-btn" onClick={handleDownload} title="Export Chart">
                        <Download size={20} />
                    </button>
                </div>
            </div>

            <div className="charts-scroll-container">
                {viewMode === 'single' ? (
                    <div
                        ref={chartWrapperRef}
                        className="chart-container-wrapper glass-panel single-chart-view"
                        style={{ height: '700px', width: '100%', position: 'relative' }}
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
                            <span style={{ color: 'var(--accent-primary)' }}>Drag chart</span> or <span style={{ color: 'var(--accent-primary)' }}>Move slider</span> bottom to zoom
                        </div>
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart
                                data={processedChartData}
                                margin={{ top: 30, right: 40, left: 20, bottom: 80 }}
                                onMouseDown={(e) => {
                                    if (e && e.activeLabel) {
                                        setIsRightClicking(true);
                                        setRefAreaLeft(e.activeLabel);
                                    } else if (e) {
                                        setIsRightClicking(true);
                                    }
                                }}
                                onMouseMove={(e) => {
                                    if (e && e.activeLabel) {
                                        setCurrentHoverLabel(e.activeLabel);
                                        if (isRightClicking) {
                                            setRefAreaRight(e.activeLabel);
                                        }
                                    }
                                }}
                                onMouseUp={zoomSelection}
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
                                <Tooltip content={<CustomTooltip />} />
                                <Legend
                                    verticalAlign="bottom"
                                    wrapperStyle={{ paddingTop: '10px', bottom: 50 }}
                                    formatter={(value) => (
                                        <span style={{ color: '#e2e8f0', fontSize: '0.8rem' }}>{value}</span>
                                    )}
                                />
                                <Brush
                                    dataKey={xKey}
                                    height={28}
                                    stroke="#38bdf8"
                                    fill="#1e293b"
                                    travellerWidth={8}
                                    tickFormatter={formatXAxis}
                                    y={600}
                                    startIndex={brushStartIdx}
                                    endIndex={brushEndIdx !== null ? brushEndIdx : (processedChartData.length - 1)}
                                    onChange={(range) => {
                                        if (range && range.startIndex !== undefined) {
                                            setBrushStartIdx(range.startIndex);
                                            setBrushEndIdx(range.endIndex);
                                        }
                                    }}
                                />
                                {singleViewKeys.map((key, index) => (
                                    <React.Fragment key={key}>
                                        <Line
                                            type="monotone"
                                            dataKey={key}
                                            stroke={COLORS[allSeriesKeys.indexOf(key) % COLORS.length]}
                                            strokeWidth={2}
                                            dot={false}
                                            activeDot={{ r: 6 }}
                                            name={key}
                                            isAnimationActive={animation}
                                        />
                                        {/* Render Comparison Lines */}
                                        {compareKeysMap[key] && compareKeysMap[key].map((comp, cIdx) => (
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
                                                isAnimationActive={animation}
                                            />
                                        ))}
                                    </React.Fragment>
                                ))}
                                {refAreaLeft && refAreaRight ? (
                                    <ReferenceArea x1={refAreaLeft} x2={refAreaRight} strokeOpacity={0.3} fill="var(--accent-primary)" fillOpacity={0.15} />
                                ) : null}
                            </LineChart>
                        </ResponsiveContainer>
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
                                <div className="mini-chart-wrapper">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <LineChart data={processedChartData} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                            <XAxis
                                                dataKey={xKey}
                                                stroke="#64748b"
                                                tick={{ fill: '#64748b', fontSize: 10 }}
                                                height={30}
                                                minTickGap={20}
                                                tickFormatter={formatXAxis}
                                            />
                                            <YAxis stroke="#94a3b8" tick={{ fill: '#94a3b8', fontSize: 10 }} domain={['auto', 'auto']} width={40} />
                                            <Tooltip content={<CustomTooltip />} />
                                            <React.Fragment key={key}>
                                                <Line
                                                    type="monotone"
                                                    dataKey={key}
                                                    stroke={COLORS[index % COLORS.length]}
                                                    strokeWidth={2}
                                                    dot={false}
                                                    activeDot={{ r: 4 }}
                                                    name={key}
                                                    isAnimationActive={false}
                                                />
                                                {/* Render Comparison Lines */}
                                                {compareKeysMap[key] && compareKeysMap[key].map((comp, cIdx) => (
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
                                                ))}
                                            </React.Fragment>
                                        </LineChart>
                                    </ResponsiveContainer>
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
