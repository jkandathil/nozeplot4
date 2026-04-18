import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

const MotionControlsPanel = motion.div;
import Papa from 'papaparse';
import { ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { UploadCloud, Search, Trash2, ZoomIn, ZoomOut, RefreshCw } from 'lucide-react';
import { parseFile } from '../utils/fileParser';
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

function parsePlotAxisBound(raw) {
    const t = String(raw ?? '').trim();
    if (t === '') return undefined;
    const n = Number(t.replace(/,/g, ''));
    return Number.isFinite(n) ? n : undefined;
}

function plotRechartsDomain(minStr, maxStr) {
    const lo = parsePlotAxisBound(minStr);
    const hi = parsePlotAxisBound(maxStr);
    if (lo === undefined && hi === undefined) return undefined;
    if (lo !== undefined && hi !== undefined) return [lo, hi];
    if (lo !== undefined) return [lo, 'auto'];
    return ['auto', hi];
}

const CSVPlotterPage = ({ workspaceFiles = [], selectedFileId = null }) => {
    const [isSidebarVisible, setIsSidebarVisible] = useState(() => localStorage.getItem('zenMode') !== 'true');

    useEffect(() => {
        const handleZenMode = (e) => setIsSidebarVisible(!e.detail.isZen);
        window.addEventListener('zen-mode-toggle', handleZenMode);
        return () => window.removeEventListener('zen-mode-toggle', handleZenMode);
    }, []);

    const [fileName, setFileName] = useState('');
    const [csvData, setCsvData] = useState([]);
    const [columns, setColumns] = useState([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedColumns, setSelectedColumns] = useState([]);
    const [xAxisKey, setXAxisKey] = useState('');
    const [plotXMin, setPlotXMin] = useState('');
    const [plotXMax, setPlotXMax] = useState('');
    const [plotYMin, setPlotYMin] = useState('');
    const [plotYMax, setPlotYMax] = useState('');

    const [brushStartIdx, setBrushStartIdx] = useState(0);
    const [brushEndIdx, setBrushEndIdx] = useState(null);
    const chartWrapperRef = useRef(null);
    const [sidebarWidth, setSidebarWidth] = useState(300);
    const [fileLoading, setFileLoading] = useState(false);
    /** Bumps when user clears so we can reload the current sidebar selection if any */
    const [fileLoadNonce, setFileLoadNonce] = useState(0);
    const workspaceFilesRef = useRef(workspaceFiles);
    workspaceFilesRef.current = workspaceFiles;

    const ingestParsedRows = useCallback((data, name) => {
        if (!data || data.length === 0) return;
        const displayName = name ? String(name).split(/[/\\]/).pop() : 'data';
        setFileName(displayName);
        const cols = Object.keys(data[0]);
        setColumns(cols);
        if (cols.includes('index')) setXAxisKey('index');
        else if (cols.includes('time')) setXAxisKey('time');
        else setXAxisKey(cols[0]);
        const processedData = data.map((row) => {
            const newRow = { ...row };
            cols.forEach((col) => {
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
        setSelectedColumns([]);
        setSearchTerm('');
        setBrushStartIdx(0);
        setBrushEndIdx(null);
        setPlotXMin('');
        setPlotXMax('');
        setPlotYMin('');
        setPlotYMax('');
    }, []);

    const handleClear = useCallback(() => {
        setFileName('');
        setCsvData([]);
        setColumns([]);
        setSelectedColumns([]);
        setSearchTerm('');
        setXAxisKey('');
        setBrushStartIdx(0);
        setBrushEndIdx(null);
        setPlotXMin('');
        setPlotXMax('');
        setPlotYMin('');
        setPlotYMax('');
        setFileLoadNonce((n) => n + 1);
    }, []);

    useEffect(() => {
        if (!selectedFileId) return;
        const file = workspaceFilesRef.current.find((f) => f && f.id === selectedFileId && !f.isFolder);
        if (!file) return;
        let cancelled = false;
        setFileLoading(true);
        (async () => {
            try {
                const parsed = await parseFile(file);
                if (cancelled) return;
                if (parsed?.data?.length) {
                    ingestParsedRows(parsed.data, parsed.fileName);
                } else {
                    alert('No rows in this file.');
                }
            } catch (err) {
                if (!cancelled) {
                    console.error(err);
                    alert(err?.message || 'Could not load file.');
                }
            } finally {
                if (!cancelled) setFileLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [selectedFileId, fileLoadNonce, ingestParsedRows]);

    const handleMouseDown = useCallback((e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = sidebarWidth;

        const onMouseMove = (moveEvent) => {
            let newWidth = startWidth + (moveEvent.clientX - startX);
            if (newWidth < 200) newWidth = 200;
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

    const plotDataForChart = useMemo(
        () => (visibleData.length > 0 ? visibleData : csvData),
        [visibleData, csvData]
    );

    const xAxisNumericForPlot = useMemo(() => {
        if (!plotDataForChart.length || !xAxisKey) return false;
        return plotDataForChart.every((r) => {
            const v = r[xAxisKey];
            if (v === null || v === undefined || v === '') return false;
            return Number.isFinite(Number(v));
        });
    }, [plotDataForChart, xAxisKey]);

    const chartXDomain = useMemo(() => {
        if (!xAxisNumericForPlot) return undefined;
        return plotRechartsDomain(plotXMin, plotXMax);
    }, [xAxisNumericForPlot, plotXMin, plotXMax]);

    const chartYDomain = useMemo(() => plotRechartsDomain(plotYMin, plotYMax), [plotYMin, plotYMax]);
    const hasChartXDom = chartXDomain != null;
    const hasChartYDom = chartYDomain != null;

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

        Papa.parse(file, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,
            complete: (results) => {
                const data = results.data;
                if (data.length > 0) {
                    ingestParsedRows(data, file.name);
                }
            },
            error: (err) => {
                console.error("Error parsing CSV:", err);
                alert("Failed to parse CSV file.");
            }
        });
        e.target.value = '';
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

    const axisBoundsPanel = (
        <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '8px' }}>Axis bounds (optional)</label>
            <p style={{ margin: '0 0 8px 0', fontSize: '0.7rem', color: '#64748b', lineHeight: 1.35 }}>
                Leave blank for auto. X min/max apply only when the X column is numeric.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                {['X min', 'X max', 'Y min', 'Y max'].map((label, i) => {
                    const vals = [plotXMin, plotXMax, plotYMin, plotYMax];
                    const setters = [setPlotXMin, setPlotXMax, setPlotYMin, setPlotYMax];
                    return (
                        <label key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.72rem', color: '#94a3b8' }}>
                            {label}
                            <input
                                type="text"
                                inputMode="decimal"
                                value={vals[i]}
                                onChange={(e) => setters[i](e.target.value)}
                                placeholder="auto"
                                style={{
                                    width: '100%',
                                    padding: '6px 8px',
                                    fontSize: '0.78rem',
                                    background: '#0f172a',
                                    border: '1px solid #334155',
                                    color: '#f8fafc',
                                    borderRadius: 6,
                                    boxSizing: 'border-box',
                                }}
                            />
                        </label>
                    );
                })}
            </div>
        </div>
    );

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
                    <div className="empty-state" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', textAlign: 'center', background: '#1e293b', borderRadius: '12px', border: '1px dashed #334155', gap: 16 }}>
                        <UploadCloud size={48} color="#94a3b8" style={{ marginBottom: '4px' }} />
                        <h2 style={{ color: '#f8fafc', margin: 0 }}>Load data for SE Analysis</h2>
                        <p style={{ color: '#94a3b8', margin: 0, maxWidth: 480, lineHeight: 1.5 }}>
                            {fileLoading && selectedFileId
                                ? 'Loading the selected workspace file…'
                                : 'Choose a data file in the workspace sidebar, or upload a CSV from your computer.'}
                        </p>
                        <label
                            className="btn-primary"
                            style={{
                                cursor: fileLoading ? 'wait' : 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '8px',
                                padding: '10px 20px',
                                borderRadius: '8px',
                                background: '#a855f7',
                                color: '#fff',
                                border: 'none',
                                fontWeight: '600',
                                opacity: fileLoading ? 0.7 : 1,
                            }}
                        >
                            <UploadCloud size={18} /> Upload CSV
                            <input type="file" accept=".csv" onChange={handleFileUpload} style={{ display: 'none' }} disabled={fileLoading} />
                        </label>
                    </div>
                ) : (
                    <div
                        style={{
                            display: 'flex',
                            gap: '20px',
                            height: 'calc(100vh - 120px - var(--auth-session-bar-height, 0px))',
                        }}
                    >
                        {/* Sidebar controls */}
                        <AnimatePresence>
                        {isSidebarVisible && (
                        <MotionControlsPanel
                            initial={{ width: 0, opacity: 0 }}
                            animate={{ width: sidebarWidth, opacity: 1 }}
                            exit={{ width: 0, opacity: 0 }}
                            transition={{ duration: 0.5, ease: 'easeOut' }}
                            style={{ flexShrink: 0, position: 'relative', overflowX: 'hidden', overflowY: 'auto' }}>
                            <div style={{ width: sidebarWidth, background: '#1e293b', padding: '16px', borderRadius: '12px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', height: '100%' }}>
                            {/* Drag Handle */}
                            <div
                                onMouseDown={handleMouseDown}
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    right: -10,
                                    width: '12px',
                                    height: '100%',
                                    cursor: 'col-resize',
                                    zIndex: 10,
                                }}
                            />
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

                            {axisBoundsPanel}

                            {csvData.length > 0 && selectedColumns.length > 0 && (
                                <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                                    <button
                                        type="button"
                                        onClick={handleZoomInBtn}
                                        title="Zoom in (fewer points)"
                                        style={{
                                            padding: '6px 8px',
                                            borderRadius: 6,
                                            border: '1px solid #334155',
                                            cursor: 'pointer',
                                            background: 'rgba(168,85,247,0.12)',
                                            color: '#c4b5fd',
                                            display: 'flex',
                                            alignItems: 'center',
                                        }}
                                    >
                                        <ZoomIn size={16} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleZoomOutBtn}
                                        title="Zoom out (more points)"
                                        style={{
                                            padding: '6px 8px',
                                            borderRadius: 6,
                                            border: '1px solid #334155',
                                            cursor: 'pointer',
                                            background: 'rgba(168,85,247,0.12)',
                                            color: '#c4b5fd',
                                            display: 'flex',
                                            alignItems: 'center',
                                        }}
                                    >
                                        <ZoomOut size={16} />
                                    </button>
                                    {(brushStartIdx > 0 || (brushEndIdx !== null && brushEndIdx < csvData.length - 1)) && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setBrushStartIdx(0);
                                                setBrushEndIdx(null);
                                            }}
                                            title="Reset zoom"
                                            style={{
                                                padding: '6px 8px',
                                                borderRadius: 6,
                                                border: '1px solid #334155',
                                                cursor: 'pointer',
                                                background: 'transparent',
                                                color: '#94a3b8',
                                                display: 'flex',
                                                alignItems: 'center',
                                            }}
                                        >
                                            <RefreshCw size={14} />
                                        </button>
                                    )}
                                    <span style={{ fontSize: '0.72rem', color: '#64748b', marginLeft: 2 }}>
                                        {visibleData.length} / {csvData.length} pts
                                    </span>
                                </div>
                            )}

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
                        </MotionControlsPanel>
                        )}
                        </AnimatePresence>

                        {/* Chart Area */}
                        <div style={{ flex: 1, background: '#1e293b', borderRadius: '12px', border: '1px solid #334155', padding: '16px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                            {!isSidebarVisible && csvData.length > 0 && selectedColumns.length > 0 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 10, justifyContent: 'flex-end' }}>
                                    <button type="button" onClick={handleZoomInBtn} title="Zoom in" style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #334155', cursor: 'pointer', background: 'rgba(168,85,247,0.12)', color: '#c4b5fd', display: 'flex', alignItems: 'center' }}>
                                        <ZoomIn size={16} />
                                    </button>
                                    <button type="button" onClick={handleZoomOutBtn} title="Zoom out" style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #334155', cursor: 'pointer', background: 'rgba(168,85,247,0.12)', color: '#c4b5fd', display: 'flex', alignItems: 'center' }}>
                                        <ZoomOut size={16} />
                                    </button>
                                    {(brushStartIdx > 0 || (brushEndIdx !== null && brushEndIdx < csvData.length - 1)) && (
                                        <button type="button" onClick={() => { setBrushStartIdx(0); setBrushEndIdx(null); }} title="Reset zoom" style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #334155', cursor: 'pointer', background: 'transparent', color: '#94a3b8', display: 'flex', alignItems: 'center' }}>
                                            <RefreshCw size={14} />
                                        </button>
                                    )}
                                    <span style={{ fontSize: '0.72rem', color: '#64748b' }}>{visibleData.length} / {csvData.length} pts</span>
                                </div>
                            )}
                            {selectedColumns.length === 0 ? (
                                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                                    Select columns from the left sidebar to generate a plot
                                </div>
                            ) : (
                                <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
                                    {(brushStartIdx > 0 || (brushEndIdx !== null && brushEndIdx < csvData.length - 1)) && (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', marginBottom: 6, flexShrink: 0 }}>
                                            <span style={{ fontSize: '0.72rem', color: '#64748b', whiteSpace: 'nowrap' }}>Pan</span>
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
                                                aria-label="Pan visible window along series"
                                            />
                                        </div>
                                    )}
                                    <div style={{ flex: 1, minHeight: 0 }} ref={chartWrapperRef}>
                                        <ResponsiveContainer width="100%" height="100%">
                                            <ComposedChart data={plotDataForChart} margin={{ top: 8, right: 16, left: 4, bottom: 52 }}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                                                <XAxis
                                                    type={xAxisNumericForPlot ? 'number' : undefined}
                                                    dataKey={xAxisKey}
                                                    stroke="#94a3b8"
                                                    tick={{ fill: '#94a3b8', fontSize: 12 }}
                                                    tickLine={{ stroke: '#334155' }}
                                                    label={{ value: xAxisKey, position: 'insideBottom', offset: -12, fill: '#94a3b8', fontSize: 11 }}
                                                    {...(xAxisNumericForPlot
                                                        ? {
                                                              domain: chartXDomain ?? ['auto', 'auto'],
                                                              allowDataOverflow: hasChartXDom,
                                                          }
                                                        : {})}
                                                />
                                                <YAxis
                                                    stroke="#94a3b8"
                                                    tick={{ fill: '#94a3b8', fontSize: 12 }}
                                                    tickLine={{ stroke: '#334155' }}
                                                    {...(hasChartYDom
                                                        ? { domain: chartYDomain, allowDataOverflow: true }
                                                        : {})}
                                                />
                                                <Tooltip
                                                    content={<CustomTooltip />}
                                                    wrapperStyle={{ zIndex: 100 }}
                                                />
                                                {plotElements}
                                                <Legend
                                                    verticalAlign="bottom"
                                                    layout="horizontal"
                                                    align="center"
                                                    wrapperStyle={{ paddingTop: 10, fontSize: '11px' }}
                                                    iconSize={8}
                                                />
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
