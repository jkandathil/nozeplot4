import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Papa from 'papaparse';
import { ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { UploadCloud, Search, Trash2, ZoomIn, ZoomOut, RefreshCw, FolderOpen, ChevronRight, ChevronDown } from 'lucide-react';
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

const CSVPlotterPage = ({ workspaceFiles = [] }) => {
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
    const preferLocalUploadRef = useRef(false);
    const [checkedWorkspaceFileId, setCheckedWorkspaceFileId] = useState(null);
    const [expandedFolderIds, setExpandedFolderIds] = useState(() => new Set());
    const [workspaceParsing, setWorkspaceParsing] = useState(false);

    const folders = useMemo(
        () => [...workspaceFiles].filter((f) => f?.isFolder && f?.id).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        [workspaceFiles]
    );

    const dataFiles = useMemo(
        () => [...workspaceFiles].filter((f) => f && !f.isFolder && f.id && f.name).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        [workspaceFiles]
    );

    const rootDataFiles = useMemo(
        () => dataFiles.filter((f) => f.folderId == null || String(f.folderId).trim() === ''),
        [dataFiles]
    );

    const filesInFolder = useCallback(
        (folderId) => dataFiles.filter((f) => String(f.folderId) === String(folderId)),
        [dataFiles]
    );

    const folderIdsSig = useMemo(() => folders.map((f) => f.id).sort().join(','), [folders]);

    /**
     * Auto-expand new folders only. Depends on folderIdsSig only — not `folders` (new array each parent
     * render would retrigger forever) and returns `prev` when unchanged to avoid React #185 update depth.
     */
    useEffect(() => {
        if (!folderIdsSig) return;
        const ids = folderIdsSig.split(',').filter(Boolean);
        if (!ids.length) return;
        setExpandedFolderIds((prev) => {
            let changed = false;
            const next = new Set(prev);
            ids.forEach((id) => {
                if (!prev.has(id)) {
                    next.add(id);
                    changed = true;
                }
            });
            return changed ? next : prev;
        });
    }, [folderIdsSig]);

    const expandAllFolders = useCallback(() => {
        setExpandedFolderIds(new Set(folders.map((f) => f.id)));
    }, [folders]);

    const collapseAllFolders = useCallback(() => {
        setExpandedFolderIds(new Set());
    }, []);

    const toggleFolderExpanded = useCallback((folderId) => {
        setExpandedFolderIds((prev) => {
            const next = new Set(prev);
            if (next.has(folderId)) next.delete(folderId);
            else next.add(folderId);
            return next;
        });
    }, []);

    const ingestParsedRows = useCallback((data, name, source = 'workspace') => {
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
        preferLocalUploadRef.current = false;
        setCheckedWorkspaceFileId(null);
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
    }, []);

    const handleWorkspaceFileCheck = useCallback(
        async (fileObj, checked) => {
            if (!checked) {
                if (checkedWorkspaceFileId === fileObj.id) {
                    preferLocalUploadRef.current = false;
                    handleClear();
                }
                return;
            }
            setCheckedWorkspaceFileId(fileObj.id);
            preferLocalUploadRef.current = false;
            setWorkspaceParsing(true);
            try {
                const parsed = await parseFile(fileObj);
                if (parsed?.data?.length) {
                    ingestParsedRows(parsed.data, parsed.fileName, 'workspace');
                } else {
                    alert('No rows in this file.');
                    setCheckedWorkspaceFileId(null);
                }
            } catch (err) {
                console.error(err);
                alert(err?.message || 'Could not load file.');
                setCheckedWorkspaceFileId(null);
            } finally {
                setWorkspaceParsing(false);
            }
        },
        [checkedWorkspaceFileId, handleClear, ingestParsedRows]
    );

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

        preferLocalUploadRef.current = true;
        Papa.parse(file, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,
            complete: (results) => {
                const data = results.data;
                if (data.length > 0) {
                    setCheckedWorkspaceFileId(null);
                    ingestParsedRows(data, file.name, 'upload');
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

    const renderWorkspaceTree = (compact) => {
        if (!dataFiles.length) {
            return (
                <p style={{ margin: 0, fontSize: '0.85rem', color: '#64748b', textAlign: compact ? 'left' : 'center', maxWidth: 400 }}>
                    No files in the workspace yet. Add files or folders from the sidebar, then check one file below.
                </p>
            );
        }

        const fileRow = (f) => (
            <label
                key={f.id}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '5px 8px',
                    cursor: workspaceParsing ? 'wait' : 'pointer',
                    borderRadius: 4,
                }}
            >
                <input
                    type="checkbox"
                    checked={checkedWorkspaceFileId === f.id}
                    disabled={workspaceParsing}
                    onChange={(e) => handleWorkspaceFileCheck(f, e.target.checked)}
                    style={{ accentColor: '#a855f7', flexShrink: 0 }}
                />
                <span
                    style={{
                        fontSize: compact ? '0.76rem' : '0.82rem',
                        color: '#e2e8f0',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                    title={f.name}
                >
                    {f.name}
                </span>
            </label>
        );

        return (
            <div
                style={{
                    width: '100%',
                    maxWidth: compact ? '100%' : 440,
                    maxHeight: compact ? 220 : 380,
                    overflowY: 'auto',
                    padding: 10,
                    background: '#0f172a',
                    borderRadius: 8,
                    border: '1px solid #334155',
                    textAlign: 'left',
                }}
            >
                <div
                    style={{
                        fontSize: '0.72rem',
                        fontWeight: 600,
                        color: '#64748b',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        marginBottom: 8,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                    }}
                >
                    <FolderOpen size={14} />
                    Workspace{compact ? ' — switch file' : ''}
                </div>
                <p style={{ margin: '0 0 10px 0', fontSize: '0.72rem', color: '#475569', lineHeight: 1.4 }}>
                    Same folders as the sidebar. Check <strong style={{ color: '#94a3b8' }}>one</strong> file to plot; another check replaces it. Uncheck to clear.
                </p>
                {folders.length > 0 && (
                    <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                        <button
                            type="button"
                            onClick={expandAllFolders}
                            style={{ fontSize: '0.7rem', padding: '4px 8px', borderRadius: 4, border: '1px solid #334155', background: 'rgba(168,85,247,0.12)', color: '#c4b5fd', cursor: 'pointer' }}
                        >
                            Expand all folders
                        </button>
                        <button
                            type="button"
                            onClick={collapseAllFolders}
                            style={{ fontSize: '0.7rem', padding: '4px 8px', borderRadius: 4, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer' }}
                        >
                            Collapse all
                        </button>
                    </div>
                )}
                {folders.map((folder) => {
                    const kids = filesInFolder(folder.id);
                    const expanded = expandedFolderIds.has(folder.id);
                    return (
                        <div key={folder.id} style={{ marginBottom: 4 }}>
                            <button
                                type="button"
                                onClick={() => toggleFolderExpanded(folder.id)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    width: '100%',
                                    textAlign: 'left',
                                    background: 'transparent',
                                    border: 'none',
                                    color: '#cbd5e1',
                                    cursor: 'pointer',
                                    padding: '6px 8px',
                                    fontSize: '0.82rem',
                                    borderRadius: 6,
                                }}
                            >
                                {expanded ? <ChevronDown size={14} color="#94a3b8" /> : <ChevronRight size={14} color="#94a3b8" />}
                                <FolderOpen size={14} color="#a855f7" />
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder.name}</span>
                                <span style={{ color: '#64748b', fontSize: '0.72rem' }}>{kids.length}</span>
                            </button>
                            {expanded && <div style={{ paddingLeft: 12, borderLeft: '1px solid rgba(51,65,85,0.6)', marginLeft: 10 }}>{kids.map(fileRow)}</div>}
                        </div>
                    );
                })}
                {rootDataFiles.length > 0 && (
                    <div style={{ marginTop: folders.length ? 10 : 0 }}>
                        {folders.length > 0 && (
                            <div style={{ fontSize: '0.7rem', color: '#64748b', fontWeight: 600, marginBottom: 6, paddingLeft: 4 }}>
                                Library root
                            </div>
                        )}
                        {rootDataFiles.map(fileRow)}
                    </div>
                )}
                {workspaceParsing && (
                    <p style={{ margin: '10px 0 0', fontSize: '0.75rem', color: '#a855f7' }}>Loading file…</p>
                )}
            </div>
        );
    };

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
                    <div className="empty-state" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', textAlign: 'center', background: '#1e293b', borderRadius: '12px', border: '1px dashed #334155', gap: 20 }}>
                        <UploadCloud size={48} color="#94a3b8" style={{ marginBottom: '4px' }} />
                        <h2 style={{ color: '#f8fafc', marginBottom: '4px' }}>Load data for SE Analysis</h2>
                        <p style={{ color: '#94a3b8', marginBottom: '4px', maxWidth: 520 }}>
                            Browse your workspace (folders and root files), check one file to plot, or upload a CSV from disk.
                        </p>

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, justifyContent: 'center', alignItems: 'flex-start', width: '100%', maxWidth: 900 }}>
                            {renderWorkspaceTree(false)}
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, paddingTop: 24 }}>
                                <span style={{ color: '#475569', fontSize: '0.75rem' }}>or</span>
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
                        </div>
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
                        <motion.div 
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

                            <div style={{ marginBottom: 14 }}>{renderWorkspaceTree(true)}</div>

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
                        </motion.div>
                        )}
                        </AnimatePresence>

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
                                {csvData.length > 0 && selectedColumns.length > 0 && (
                                    <div
                                        style={{
                                            display: 'flex',
                                            flexWrap: 'wrap',
                                            gap: '8px',
                                            alignItems: 'flex-end',
                                            marginTop: 10,
                                            paddingTop: 10,
                                            borderTop: '1px solid rgba(51,65,85,0.6)',
                                        }}
                                    >
                                        <span style={{ fontSize: '0.72rem', color: '#94a3b8', width: '100%' }}>
                                            Axis min / max (optional). Leave blank for auto. X range applies only when the X
                                            column values are numeric.
                                        </span>
                                        {['X min', 'X max', 'Y min', 'Y max'].map((label, i) => {
                                            const vals = [plotXMin, plotXMax, plotYMin, plotYMax];
                                            const setters = [setPlotXMin, setPlotXMax, setPlotYMin, setPlotYMax];
                                            return (
                                                <label
                                                    key={label}
                                                    style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.7rem', color: '#94a3b8' }}
                                                >
                                                    {label}
                                                    <input
                                                        type="text"
                                                        inputMode="decimal"
                                                        value={vals[i]}
                                                        onChange={(e) => setters[i](e.target.value)}
                                                        placeholder="auto"
                                                        style={{
                                                            width: 72,
                                                            padding: '4px 8px',
                                                            fontSize: '0.75rem',
                                                            background: '#1e293b',
                                                            border: '1px solid #334155',
                                                            color: '#f8fafc',
                                                            borderRadius: 4,
                                                        }}
                                                    />
                                                </label>
                                            );
                                        })}
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
                                            <ComposedChart data={plotDataForChart} margin={{ top: 10, right: 30, left: 10, bottom: 20 }}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                                                <XAxis
                                                    type={xAxisNumericForPlot ? 'number' : undefined}
                                                    dataKey={xAxisKey}
                                                    stroke="#94a3b8"
                                                    tick={{ fill: '#94a3b8', fontSize: 12 }}
                                                    tickLine={{ stroke: '#334155' }}
                                                    label={{ value: xAxisKey, position: 'insideBottom', offset: -15, fill: '#94a3b8' }}
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
