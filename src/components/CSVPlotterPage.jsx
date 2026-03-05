import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import Papa from 'papaparse';
import { ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { UploadCloud, Search, Trash2, ZoomIn, ZoomOut, RefreshCw } from 'lucide-react';
import './AromaAnalysisPage.css'; // Reuse existing styles

const COLORS = [
    '#38bdf8', '#fbbf24', '#10b981', '#f43f5e', '#a855f7',
    '#f97316', '#0ea5e9', '#ec4899', '#84cc16', '#14b8a6'
];

const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
        return (
            <div className="custom-tooltip" style={{
                maxHeight: '400px',
                overflowY: 'auto',
                pointerEvents: 'auto',
                minWidth: '220px',
                background: 'rgba(15, 23, 42, 0.05)',
                backdropFilter: 'blur(2px)',
                WebkitBackdropFilter: 'blur(2px)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '8px',
                padding: '10px',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)'
            }}>
                <p className="label" style={{
                    margin: '0 0 10px 0',
                    fontWeight: 'bold',
                    color: '#f8fafc',
                    position: 'sticky',
                    top: '-10px',
                    paddingTop: '10px',
                    paddingBottom: '5px',
                    background: 'rgba(15, 23, 42, 0.05)',
                    backdropFilter: 'blur(2px)',
                    WebkitBackdropFilter: 'blur(2px)',
                    zIndex: 2,
                    borderBottom: '1px solid rgba(255, 255, 255, 0.15)'
                }}>{`${label}`}</p>
                {payload.map((entry, index) => {
                    let valueDisplay = entry.value;
                    if (Array.isArray(entry.value)) {
                        valueDisplay = `[${Number(entry.value[0]).toFixed(3)}, ${Number(entry.value[1]).toFixed(3)}]`;
                    } else if (typeof entry.value === 'number') {
                        valueDisplay = Number(entry.value).toFixed(3);
                    }

                    return (
                        <div key={`item-${index}`} style={{ color: entry.color, padding: '4px 0', fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ marginRight: '16px', opacity: 0.9 }}>{entry.name}:</span>
                            <span style={{ fontWeight: 600 }}>{valueDisplay}</span>
                        </div>
                    );
                })}
            </div>
        );
    }
    return null;
};

const CSVPlotterPage = () => {
    const [fileName, setFileName] = useState('');
    const [csvData, setCsvData] = useState([]);
    const [columns, setColumns] = useState([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedColumns, setSelectedColumns] = useState([]);
    const [xAxisKey, setXAxisKey] = useState('');

    const [brushStartIdx, setBrushStartIdx] = useState(0);
    const [brushEndIdx, setBrushEndIdx] = useState(null);
    const chartWrapperRef = useRef(null);

    const visibleData = useMemo(() => {
        if (!csvData || csvData.length === 0) return [];
        const lastIdx = csvData.length - 1;
        const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;
        const start = Math.max(0, Math.min(brushStartIdx, lastIdx));
        const end = Math.max(0, Math.min(lastIdx, endIdx));
        if (start > end) return csvData;
        const sliced = csvData.slice(start, end + 1);
        return sliced.length > 0 ? sliced : csvData;
    }, [csvData, brushStartIdx, brushEndIdx]);

    const handleZoomInBtn = () => {
        if (!csvData || csvData.length === 0) return;
        const lastIdx = csvData.length - 1;
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
        if (!csvData || csvData.length === 0) return;
        const lastIdx = csvData.length - 1;
        const endIdx = brushEndIdx !== null ? brushEndIdx : lastIdx;
        const currentSpan = endIdx - brushStartIdx;
        const delta = Math.max(1, Math.floor(currentSpan * 0.35));
        const newStart = Math.max(0, brushStartIdx - delta);
        const newEnd = Math.min(lastIdx, endIdx + delta);
        setBrushStartIdx(newStart);
        setBrushEndIdx(newEnd === lastIdx && newStart === 0 ? null : newEnd);
    };

    const handleWheel = useCallback((e) => {
        if (!csvData || csvData.length === 0) return;
        e.preventDefault();

        const zoomIn = e.deltaY < 0;
        const lastIdx = csvData.length - 1;
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
    }, [csvData, brushStartIdx, brushEndIdx]);

    useEffect(() => {
        const el = chartWrapperRef.current;
        if (!el) return;
        el.addEventListener('wheel', handleWheel, { passive: false });
        // It's important to keep the handler functional so it stays fast with large zooms.
        return () => el.removeEventListener('wheel', handleWheel);
    }, [handleWheel]);

    const handleFileUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setFileName(file.name);
        Papa.parse(file, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,
            complete: (results) => {
                const data = results.data;
                if (data.length > 0) {
                    const cols = Object.keys(data[0]);
                    setColumns(cols);

                    // Best guess for x-axis
                    if (cols.includes('index')) setXAxisKey('index');
                    else if (cols.includes('time')) setXAxisKey('time');
                    else setXAxisKey(cols[0]);

                    // Pre-process range data for Recharts Area
                    const processedData = data.map(row => {
                        const newRow = { ...row };
                        // Look for sigma_min and sigma_max to create range arrays
                        cols.forEach(col => {
                            if (col.endsWith('_sigma_min')) {
                                const base = col.replace('_sigma_min', '');
                                const maxCol = `${base}_sigma_max`;
                                if (row[col] !== undefined && row[maxCol] !== undefined) {
                                    newRow[`${base}_range`] = [row[col], row[maxCol]];
                                }
                            }
                        });
                        return newRow;
                    });
                    setCsvData(processedData);
                    setBrushStartIdx(0);
                    setBrushEndIdx(null);
                }
            },
            error: (err) => {
                console.error("Error parsing CSV:", err);
                alert("Failed to parse CSV file.");
            }
        });
    };

    const handleClear = () => {
        setFileName('');
        setCsvData([]);
        setColumns([]);
        setSelectedColumns([]);
        setSearchTerm('');
        setXAxisKey('');
        setBrushStartIdx(0);
        setBrushEndIdx(null);
    };

    // Grouping logic for columns
    const groupedColumns = useMemo(() => {
        const groups = [];
        const processedBases = new Set();

        const filteredCols = columns.filter(c => c.toLowerCase().includes(searchTerm.toLowerCase()));

        filteredCols.forEach(col => {
            if (col.endsWith('_mean')) {
                const base = col.replace('_mean', '');
                if (!processedBases.has(base)) {
                    processedBases.add(base);
                    const hasMin = columns.includes(`${base}_sigma_min`);
                    const hasMax = columns.includes(`${base}_sigma_max`);
                    groups.push({
                        type: 'group',
                        id: base,
                        label: base,
                        hasSpread: hasMin && hasMax,
                        cols: [col, hasMin ? `${base}_sigma_min` : null, hasMax ? `${base}_sigma_max` : null].filter(Boolean)
                    });
                }
            } else if (col.endsWith('_sigma_min') || col.endsWith('_sigma_max')) {
                // Handled in group
            } else {
                // Individual column
                if (!processedBases.has(col)) {
                    groups.push({
                        type: 'single',
                        id: col,
                        label: col,
                        hasSpread: false,
                        cols: [col]
                    });
                }
            }
        });
        return groups;
    }, [columns, searchTerm]);

    const handleToggleSelection = (id) => {
        setSelectedColumns(prev =>
            prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
        );
    };

    const plotElements = useMemo(() => {
        const areaElements = [];
        const lineElements = [];

        // Parse concentration from column IDs to sort them and apply heatmap colors
        const parsedColumns = selectedColumns.map(id => {
            const match = id.match(/((?:\d*\.)?\d+)\s*ppb/i);
            return {
                id,
                concentration: match ? parseFloat(match[1]) : null
            };
        });

        // Sort parsed columns primarily by concentration (ascending), then alphabetically
        parsedColumns.sort((a, b) => {
            if (a.concentration !== null && b.concentration !== null) {
                return a.concentration - b.concentration;
            } else if (a.concentration !== null) {
                return -1;
            } else if (b.concentration !== null) {
                return 1;
            }
            return a.id.localeCompare(b.id);
        });

        const validConcentrations = parsedColumns.filter(p => p.concentration !== null).map(p => p.concentration);
        const useColorScale = validConcentrations.length > 0;

        let minConc = 0;
        let maxConc = 1;
        if (useColorScale) {
            minConc = Math.min(...validConcentrations);
            maxConc = Math.max(...validConcentrations);
        }

        // Helper function to generate color from violet (low) to red (high)
        const getColorForConcentration = (conc) => {
            if (minConc === maxConc) return 'hsl(0, 85%, 60%)'; // Red if only one value
            const ratio = (conc - minConc) / (maxConc - minConc);
            // hue goes from 270 (violet/purple) down to 0 (red)
            const hue = 270 * (1 - ratio);
            return `hsl(${Math.round(hue)}, 85%, 60%)`;
        };

        let colorIdx = 0;

        parsedColumns.forEach(({ id, concentration }) => {
            const group = groupedColumns.find(g => g.id === id);
            if (!group) return;

            let color;
            if (useColorScale && concentration !== null) {
                color = getColorForConcentration(concentration);
            } else {
                color = COLORS[colorIdx % COLORS.length];
                colorIdx++;
            }

            if (group.type === 'group') {
                if (group.hasSpread) {
                    areaElements.push(
                        <Area
                            key={`${id}_spread`}
                            type="monotone"
                            dataKey={`${id}_range`}
                            fill={color}
                            stroke="none"
                            fillOpacity={0.2}
                            name={`${id} Spread (\u00B11\u03C3)`}
                        />
                    );
                }
                lineElements.push(
                    <Line
                        key={`${id}_mean`}
                        type="monotone"
                        dataKey={`${id}_mean`}
                        stroke={color}
                        name={`${id} Mean`}
                        strokeWidth={2}
                        dot={false}
                    />
                );
            } else {
                lineElements.push(
                    <Line
                        key={id}
                        type="monotone"
                        dataKey={id}
                        stroke={color}
                        name={id}
                        strokeWidth={2}
                        dot={false}
                    />
                );
            }
        });

        return [...areaElements, ...lineElements];
    }, [selectedColumns, groupedColumns]);

    return (
        <div className="aroma-analysis-container">
            <div className="aroma-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div className="icon-wrapper">
                        <UploadCloud size={18} color="#f43f5e" />
                    </div>
                    <h1 className="page-title">SE Analysis</h1>
                </div>
            </div>

            <div className="aroma-content" style={{ display: 'flex', gap: '20px', flexDirection: 'column' }}>
                {!csvData.length ? (
                    <div className="empty-state" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', textAlign: 'center', background: '#1e293b', borderRadius: '12px', border: '1px dashed #334155' }}>
                        <UploadCloud size={48} color="#94a3b8" style={{ marginBottom: '16px' }} />
                        <h2 style={{ color: '#f8fafc', marginBottom: '8px' }}>Upload a CSV File</h2>
                        <p style={{ color: '#94a3b8', marginBottom: '20px' }}>Upload your SE Analysis CSV or any other data file to plot custom columns.</p>

                        <label
                            className="btn-primary"
                            style={{
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '8px',
                                padding: '10px 20px',
                                borderRadius: '8px',
                                background: '#a855f7',
                                color: '#fff',
                                flex: 'none',
                                width: 'fit-content',
                                margin: '0 auto',
                                border: 'none',
                                fontWeight: '600',
                                alignSelf: 'center'
                            }}
                        >
                            <UploadCloud size={18} /> Select CSV File
                            <input
                                type="file"
                                accept=".csv"
                                onChange={handleFileUpload}
                                style={{ display: 'none' }}
                            />
                        </label>
                    </div>
                ) : (
                    <div style={{ display: 'flex', gap: '20px', height: 'calc(100vh - 120px)' }}>
                        {/* Sidebar controls */}
                        <div style={{ width: '300px', background: '#1e293b', padding: '16px', borderRadius: '12px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <h3 style={{ fontSize: '1rem', color: '#f8fafc', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fileName}>
                                    {fileName}
                                </h3>
                                <button onClick={handleClear} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px' }} title="Clear File">
                                    <Trash2 size={16} />
                                </button>
                            </div>

                            <div style={{ marginBottom: '16px' }}>
                                <label style={{ display: 'block', fontSize: '0.85rem', color: '#94a3b8', marginBottom: '6px' }}>X-Axis</label>
                                <select
                                    value={xAxisKey}
                                    onChange={(e) => setXAxisKey(e.target.value)}
                                    style={{ width: '100%', padding: '8px', background: '#0f172a', border: '1px solid #334155', color: '#f8fafc', borderRadius: '6px' }}
                                >
                                    {columns.map(col => (
                                        <option key={col} value={col}>{col}</option>
                                    ))}
                                </select>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#0f172a', padding: '8px', borderRadius: '6px', border: '1px solid #334155', marginBottom: '12px' }}>
                                <Search size={14} color="#94a3b8" />
                                <input
                                    type="text"
                                    placeholder="Search columns..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    style={{ background: 'transparent', border: 'none', color: '#f8fafc', width: '100%', outline: 'none', fontSize: '0.85rem' }}
                                />
                            </div>

                            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {groupedColumns.map(group => (
                                    <label
                                        key={group.id}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px',
                                            background: selectedColumns.includes(group.id) ? 'rgba(56, 189, 248, 0.1)' : 'transparent',
                                            borderRadius: '6px', cursor: 'pointer',
                                            transition: 'background 0.2s'
                                        }}
                                        title={group.cols.join(', ')}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={selectedColumns.includes(group.id)}
                                            onChange={() => handleToggleSelection(group.id)}
                                            style={{ accentColor: '#38bdf8' }}
                                        />
                                        <span style={{ fontSize: '0.85rem', color: selectedColumns.includes(group.id) ? '#38bdf8' : '#cbd5e1' }}>
                                            {group.label} {group.hasSpread ? '(+ Spread)' : ''}
                                        </span>
                                    </label>
                                ))}
                                {groupedColumns.length === 0 && (
                                    <p style={{ color: '#64748b', fontSize: '0.85rem', textAlign: 'center', marginTop: '20px' }}>No columns found</p>
                                )}
                            </div>
                        </div>

                        {/* Chart Area */}
                        <div style={{ flex: 1, background: '#1e293b', borderRadius: '12px', border: '1px solid #334155', padding: '20px', display: 'flex', flexDirection: 'column' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                                <h2 style={{ fontSize: '1.2rem', color: '#f8fafc', margin: 0 }}>Plot View</h2>

                                {csvData.length > 0 && selectedColumns.length > 0 && (
                                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                        <button type="button" className="icon-btn small" onClick={handleZoomInBtn} title="Zoom In (fewer points)" style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #334155', cursor: 'pointer', background: 'rgba(168,85,247,0.1)', color: '#a855f7', display: 'flex', alignItems: 'center' }}>
                                            <ZoomIn size={18} /> <span style={{ fontSize: '0.8rem', marginLeft: 4, fontWeight: 600 }}>Zoom In</span>
                                        </button>
                                        <button type="button" className="icon-btn small" onClick={handleZoomOutBtn} title="Zoom Out (more points)" style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #334155', cursor: 'pointer', background: 'rgba(168,85,247,0.1)', color: '#a855f7', display: 'flex', alignItems: 'center' }}>
                                            <ZoomOut size={18} /> <span style={{ fontSize: '0.8rem', marginLeft: 4, fontWeight: 600 }}>Zoom Out</span>
                                        </button>
                                        {(brushStartIdx > 0 || (brushEndIdx !== null && brushEndIdx < csvData.length - 1)) && (
                                            <button type="button" className="icon-btn small" onClick={() => { setBrushStartIdx(0); setBrushEndIdx(null); }} style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid #334155', cursor: 'pointer', background: 'transparent', color: '#94a3b8', display: 'flex', alignItems: 'center' }}>
                                                <RefreshCw size={14} style={{ marginRight: 4 }} /> Reset Zoom
                                            </button>
                                        )}
                                        <span style={{ fontSize: '0.75rem', color: '#94a3b8', marginLeft: '8px' }}>
                                            {visibleData.length} / {csvData.length} pts
                                        </span>
                                    </div>
                                )}
                            </div>

                            {selectedColumns.length === 0 ? (
                                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                                    Select columns from the left sidebar to generate a plot
                                </div>
                            ) : (
                                <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
                                    {(brushStartIdx > 0 || (brushEndIdx !== null && brushEndIdx < csvData.length - 1)) && (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', background: 'rgba(0,0,0,0.2)', marginBottom: 8, borderRadius: 8, flexShrink: 0 }}>
                                            <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>X-Axis Interval:</span>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                <input
                                                    type="text"
                                                    style={{ width: 80, padding: '4px 8px', fontSize: '0.75rem', background: '#1e293b', border: '1px solid #334155', color: '#f8fafc', borderRadius: 4 }}
                                                    value={String(csvData[brushStartIdx]?.[xAxisKey] || '')}
                                                    onChange={(e) => {
                                                        const targetX = e.target.value;
                                                        const idx = csvData.findIndex(r => String(r[xAxisKey]).startsWith(targetX));
                                                        if (idx !== -1 && idx <= (brushEndIdx || csvData.length - 1)) {
                                                            setBrushStartIdx(idx);
                                                        }
                                                    }}
                                                    title="Start X"
                                                />
                                                <span style={{ color: '#94a3b8' }}>to</span>
                                                <input
                                                    type="text"
                                                    style={{ width: 80, padding: '4px 8px', fontSize: '0.75rem', background: '#1e293b', border: '1px solid #334155', color: '#f8fafc', borderRadius: 4 }}
                                                    value={String(csvData[brushEndIdx !== null ? brushEndIdx : csvData.length - 1]?.[xAxisKey] || '')}
                                                    onChange={(e) => {
                                                        const targetX = e.target.value;
                                                        const idx = csvData.findIndex(r => String(r[xAxisKey]).startsWith(targetX));
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
                                                max={Math.max(0, csvData.length - visibleData.length)}
                                                value={brushStartIdx}
                                                onChange={(e) => {
                                                    const newStart = parseInt(e.target.value, 10);
                                                    const currentSpan = (brushEndIdx !== null ? brushEndIdx : csvData.length - 1) - brushStartIdx;
                                                    setBrushStartIdx(newStart);
                                                    setBrushEndIdx(Math.min(csvData.length - 1, newStart + currentSpan));
                                                }}
                                                style={{ flex: 1, height: 6, accentColor: '#a855f7', cursor: 'pointer' }}
                                            />
                                        </div>
                                    )}
                                    <div style={{ flex: 1, minHeight: 0 }} ref={chartWrapperRef}>
                                        <ResponsiveContainer width="100%" height="100%">
                                            <ComposedChart data={visibleData.length > 0 ? visibleData : csvData} margin={{ top: 10, right: 30, left: 10, bottom: 20 }}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                                                <XAxis
                                                    dataKey={xAxisKey}
                                                    stroke="#94a3b8"
                                                    tick={{ fill: '#94a3b8', fontSize: 12 }}
                                                    tickLine={{ stroke: '#334155' }}
                                                    label={{ value: xAxisKey, position: 'insideBottom', offset: -15, fill: '#94a3b8' }}
                                                />
                                                <YAxis
                                                    stroke="#94a3b8"
                                                    tick={{ fill: '#94a3b8', fontSize: 12 }}
                                                    tickLine={{ stroke: '#334155' }}
                                                />
                                                <Tooltip
                                                    content={<CustomTooltip />}
                                                    wrapperStyle={{ zIndex: 100 }}
                                                />
                                                <Legend verticalAlign="top" height={36} wrapperStyle={{ paddingBottom: '20px' }} />

                                                {plotElements}
                                            </ComposedChart>
                                        </ResponsiveContainer>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CSVPlotterPage;
