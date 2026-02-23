import React, { useState, useMemo } from 'react';
import Papa from 'papaparse';
import { ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { UploadCloud, Search, Trash2 } from 'lucide-react';
import './AromaAnalysisPage.css'; // Reuse existing styles

const COLORS = [
    '#38bdf8', '#fbbf24', '#10b981', '#f43f5e', '#a855f7',
    '#f97316', '#0ea5e9', '#ec4899', '#84cc16', '#14b8a6'
];

const CSVPlotterPage = () => {
    const [fileName, setFileName] = useState('');
    const [csvData, setCsvData] = useState([]);
    const [columns, setColumns] = useState([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedColumns, setSelectedColumns] = useState([]);
    const [xAxisKey, setXAxisKey] = useState('');

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
        let colorIdx = 0;

        selectedColumns.forEach(id => {
            const group = groupedColumns.find(g => g.id === id);
            if (!group) return;

            const color = COLORS[colorIdx % COLORS.length];
            colorIdx++;

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
                    <div className="empty-state" style={{ padding: '40px', textAlign: 'center', background: '#1e293b', borderRadius: '12px', border: '1px dashed #334155' }}>
                        <UploadCloud size={48} color="#94a3b8" style={{ marginBottom: '16px' }} />
                        <h2 style={{ color: '#f8fafc', marginBottom: '8px' }}>Upload a CSV File</h2>
                        <p style={{ color: '#94a3b8', marginBottom: '20px' }}>Upload your SE Analysis CSV or any other data file to plot custom columns.</p>

                        <label
                            className="btn-primary"
                            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '10px 20px', borderRadius: '8px', background: '#38bdf8', color: '#fff' }}
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
                            <h2 style={{ fontSize: '1.2rem', color: '#f8fafc', marginBottom: '20px', margin: 0 }}>Plot View</h2>

                            {selectedColumns.length === 0 ? (
                                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                                    Select columns from the left sidebar to generate a plot
                                </div>
                            ) : (
                                <div style={{ flex: 1, minHeight: 0 }}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <ComposedChart data={csvData} margin={{ top: 10, right: 30, left: 10, bottom: 20 }}>
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
                                                contentStyle={{ background: 'rgba(15, 23, 42, 0.9)', border: '1px solid #334155', borderRadius: '8px', color: '#f8fafc' }}
                                                itemStyle={{ color: '#f8fafc' }}
                                            />
                                            <Legend verticalAlign="top" height={36} wrapperStyle={{ paddingBottom: '20px' }} />

                                            {plotElements}
                                        </ComposedChart>
                                    </ResponsiveContainer>
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
