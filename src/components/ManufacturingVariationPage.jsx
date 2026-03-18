import React, { useState, useMemo } from 'react';
import { Settings, Play, RefreshCw, Maximize2, Download, BarChart2, Hash, Layers, AlertTriangle } from 'lucide-react';
import { motion } from 'framer-motion';
import {
    BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine,
    Tooltip as RechartsTooltip, Legend, ResponsiveContainer, Cell, ScatterChart, Scatter
} from 'recharts';

const COLORS = [
    '#38bdf8', '#818cf8', '#c084fc', '#f472b6',
    '#fb923c', '#facc15', '#a3e635', '#4ade80',
    '#2dd4bf', '#22d3ee', '#60a5fa', '#a78bfa'
];

const getMedian = (arr) => {
    if (!arr || arr.length === 0) return 1.0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2.0;
};

const ManufacturingVariationPage = ({ availableFiles = [], data, fileName, compareDataList = [] }) => {
    const [sensingElements, setSensingElements] = useState('A1, A2, A3, A4, A5, A6, A7, A8, B1, B2, B3, B4, B5, B6, B7, B8, C1, C2, C3, C4, C5, C6, C7, C8, D1, D2, D3, D4, D5, D6, D7, D8, E1, E2, E3, E4, E5, E6, E7, E8, F1, F2, F3, F4, F5, F6, F7, F8, G1, G2, G3, G4, G5, G6, G7, G8, H1, H2, H3, H4, H5, H6, H7, H8');
    const [baselinePts, setBaselinePts] = useState(50);
    const [targetConcFilter, setTargetConcFilter] = useState(''); // e.g. "50ppb"
    const [isProcessing, setIsProcessing] = useState(false);
    const [sidebarWidth, setSidebarWidth] = useState(340);
    const [selectedPlot, setSelectedPlot] = useState(null);

    const [variationResults, setVariationResults] = useState(null);

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

    const handleProcessBatch = () => {
        setIsProcessing(true);
        setTimeout(() => {
            try {
                // 1. Gather all files to analyze (Active Main File + All Comparison Files)
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

                const sElementsArr = sensingElements.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

                const getAsauId = (fName) => {
                    const baseName = String(fName).split(/[/\\]/).pop();
                    const fileParts = baseName.split('_');
                    const asauPart = fileParts.find(p => p.toLowerCase().includes('asu') || p.toLowerCase().includes('asau'));
                    return asauPart ? asauPart.toUpperCase() : 'UNKNOWN_AU';
                };

                const extractConc = (fName) => {
                    const basename = fName.split(/[/\\]/).pop();
                    const match = basename.match(/(\d+p[pb]b)/i);
                    return match ? match[1].toLowerCase() : 'Unknown';
                };

                const groupedFiles = {}; // By AU ID -> By Concentration -> File Object
                let auCount = 0;

                allFiles.forEach(fileObj => {
                    if (!fileObj.data || fileObj.data.length === 0) return;
                    const auId = getAsauId(fileObj.fileName || fileObj.name || '');

                    // Filter unknown AUs if needed, but for manufacturing variation we usually want to know the AU
                    if (auId === 'UNKNOWN_AU') return;

                    const conc = extractConc(fileObj.fileName || fileObj.name || '');

                    // Filter by target concentration if user specified one (e.g. they only want to analyze 50ppb variations)
                    if (targetConcFilter && targetConcFilter.trim() !== '') {
                        if (!conc.includes(targetConcFilter.trim().toLowerCase())) return;
                    }

                    if (!groupedFiles[auId]) {
                        groupedFiles[auId] = {};
                        auCount++;
                    }
                    if (!groupedFiles[auId][conc]) groupedFiles[auId][conc] = [];
                    groupedFiles[auId][conc].push(fileObj);
                });

                if (auCount < 2) {
                    alert("Manufacturing variation requires at least 2 different AU devices (ASAU IDs) to compare.");
                    setIsProcessing(false);
                    return;
                }

                // 2. Extract metrics (Baseline R0 and Max Peak Response) for each AU/Conc/Channel
                const metrics = [];

                Object.keys(groupedFiles).forEach(auId => {
                    Object.keys(groupedFiles[auId]).forEach(conc => {
                        const files = groupedFiles[auId][conc];

                        files.forEach(f => {
                            const data = f.data;
                            const sampleKeys = Object.keys(data[0]);
                            const eventCol = sampleKeys.find(col => col.toLowerCase() === 'event_name' || (col.toLowerCase().includes('event') && !col.toLowerCase().includes('reference')));

                            const auMetrics = { auId, conc, fileName: f.fileName || f.name };

                            sElementsArr.forEach(ch => {
                                // Find actual column key matching this channel
                                const matchingKeys = sampleKeys.filter(k => k.toLowerCase().includes(ch.toLowerCase()));
                                if (matchingKeys.length === 0) return;

                                // Prefer raw columns to get actual R0 Baseline
                                let rawKey = matchingKeys.find(k => !k.toLowerCase().includes('norm'));
                                if (!rawKey) rawKey = matchingKeys[0];

                                // 1. Baseline Extraction
                                let baselineVals = [];

                                // Primary ALAAC Logic: Look for AmbientSampleRFC event
                                const ambientRows = eventCol ? data.filter(row => {
                                    const ev = String(row[eventCol] || '').toLowerCase();
                                    return ev.includes('ambientsamplingrfc') || ev.includes('ambient');
                                }) : [];

                                if (ambientRows.length > 0) {
                                    // Take the last 10 seconds (approx ~3 rows/sec = 30 rows) of the ambient event for perfectly stable R0 calculation
                                    const last10Rows = ambientRows.slice(-30);
                                    last10Rows.forEach(row => {
                                        if (typeof row[rawKey] === 'number' && !isNaN(row[rawKey]) && isFinite(row[rawKey])) {
                                            baselineVals.push(row[rawKey]);
                                        }
                                    });
                                } else {
                                    // Fallback: Use first N points of the file if no Ambient found
                                    const pts = Math.min(baselinePts, data.length);
                                    for (let i = 0; i < pts; i++) {
                                        if (typeof data[i][rawKey] === 'number' && !isNaN(data[i][rawKey]) && isFinite(data[i][rawKey])) {
                                            baselineVals.push(data[i][rawKey]);
                                        }
                                    }
                                }

                                const r0 = getMedian(baselineVals) / 4096.0; // Convert native ALAAC integers back to OHMS
                                auMetrics[`${ch}_R0`] = r0;

                                // 2. Max Response Extraction
                                // If normalized column exists, use it. Otherwise compute pseudo-norm.
                                let normKey = matchingKeys.find(k => k.toLowerCase().includes('norm'));
                                let peakVal = 0;

                                if (normKey) {
                                    data.forEach(row => {
                                        const ev = eventCol ? String(row[eventCol] || '').toLowerCase() : '';
                                        if (ev.includes('recovery')) return; // Explicitly exclude recovery phase

                                        if (typeof row[normKey] === 'number' && !isNaN(row[normKey]) && isFinite(row[normKey])) {
                                            if (Math.abs(row[normKey]) > Math.abs(peakVal)) {
                                                peakVal = row[normKey];
                                            }
                                        }
                                    });
                                    peakVal = peakVal * 100.0; // Scale to percentage AFTER finding max
                                } else {
                                    // Calculate ALAAC max deviation from R0 natively
                                    data.forEach(row => {
                                        const ev = eventCol ? String(row[eventCol] || '').toLowerCase() : '';
                                        if (ev.includes('recovery')) return; // Explicitly exclude recovery phase

                                        if (typeof row[rawKey] === 'number' && !isNaN(row[rawKey]) && isFinite(row[rawKey]) && r0 !== 0) {
                                            const dev = ((row[rawKey] / 4096.0) / r0) - 1.0;
                                            if (Math.abs(dev) > Math.abs(peakVal)) {
                                                peakVal = dev;
                                            }
                                        }
                                    });
                                    peakVal = peakVal * 100.0; // Scale to percentage AFTER finding max
                                }
                                auMetrics[`${ch}_Max`] = peakVal;
                            });

                            metrics.push(auMetrics);
                        });
                    });
                });

                // 3. Compute Manufacturing Statistical Summaries
                const cvDataPoints = []; // Bar chart
                const r0BoxPoints = []; // Scatter/Box spread
                const sensitivitySpreadPoints = []; // Scatter

                sElementsArr.forEach(ch => {
                    const r0Vals = [];
                    const maxVals = [];

                    metrics.forEach(m => {
                        if (m[`${ch}_R0`] !== undefined) {
                            r0Vals.push({ auId: m.auId, val: m[`${ch}_R0`] });
                            r0BoxPoints.push({ channel: ch, auId: m.auId, value: m[`${ch}_R0`] });
                        }
                        if (m[`${ch}_Max`] !== undefined && !isNaN(m[`${ch}_Max`])) {
                            maxVals.push(m[`${ch}_Max`]);
                            sensitivitySpreadPoints.push({ channel: ch, auId: m.auId, value: m[`${ch}_Max`], conc: m.conc });
                        }
                    });

                    // Calc CV % for Max Response (Sensitivity CV)
                    let cv = 0;
                    let mean = 0;
                    let stdDev = 0;

                    if (maxVals.length > 1) {
                        mean = maxVals.reduce((a, b) => a + b, 0) / maxVals.length;
                        const variance = maxVals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (maxVals.length - 1);
                        stdDev = Math.sqrt(variance);
                        cv = mean !== 0 ? Math.abs((stdDev / mean) * 100.0) : 0;
                    }

                    cvDataPoints.push({
                        channel: ch,
                        cv: (!isNaN(cv) && isFinite(cv)) ? cv : 0,
                        mean: (!isNaN(mean) && isFinite(mean)) ? mean : 0,
                        std: (!isNaN(stdDev) && isFinite(stdDev)) ? stdDev : 0,
                        devices: maxVals.length
                    });
                });

                setVariationResults({
                    auMap: groupedFiles,
                    metrics,
                    cvDataPoints, // Ordered sequentially (A1...H8) mapping instead of sorting by value
                    r0BoxPoints,
                    sensitivitySpreadPoints
                });

            } catch (err) {
                console.error("Variation analysis error:", err);
            } finally {
                setIsProcessing(false);
            }
        }, 300);
    };

    // Custom Tooltips
    const CVTooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            const data = payload[0].payload;
            return (
                <div style={{ background: 'rgba(15,23,42,0.85)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '10px', fontSize: '12px' }}>
                    <div style={{ color: '#10b981', fontWeight: 'bold', marginBottom: 4 }}>Channel {label}</div>
                    <div style={{ color: '#e2e8f0' }}>Coefficient of Variation: <strong style={{ color: '#f43f5e' }}>{data.cv.toFixed(2)}%</strong></div>
                    <div style={{ color: '#94a3b8' }}>Mean Peak Response: {data.mean.toFixed(2)}%</div>
                    <div style={{ color: '#94a3b8' }}>Standard Dev: ±{data.std.toFixed(2)}%</div>
                    <div style={{ color: '#94a3b8' }}>Analyzed Devices: {data.devices} units</div>
                </div>
            );
        }
        return null;
    };

    const ScatterTooltip = ({ active, payload }) => {
        if (active && payload && payload.length) {
            const data = payload[0].payload;
            return (
                <div style={{ background: 'rgba(15,23,42,0.85)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '10px', fontSize: '12px', zIndex: 1000 }}>
                    <div style={{ color: '#38bdf8', fontWeight: 'bold', marginBottom: 4 }}>{data.auId}</div>
                    <div style={{ color: '#e2e8f0' }}>Channel: <strong>{data.channel}</strong></div>
                    <div style={{ color: '#e2e8f0' }}>Resistance: <strong style={{ color: '#34d399' }}>{data.value && Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(data.value)} Ω</strong></div>
                    {data.conc && <div style={{ color: '#94a3b8' }}>Conc: {data.conc}</div>}
                </div>
            );
        }
        return null;
    };


    return (
        <motion.div className="aroma-analysis-container" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
            <div className="aroma-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div className="icon-wrapper">
                        <Layers size={18} color="#f43f5e" />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <h1 className="page-title" style={{ marginBottom: 0 }}>Manufacturing Variation Analysis</h1>
                        <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Inter-device variability, Baseline (R0) drift, and Sensor Yield mapping</span>
                    </div>
                </div>
            </div>

            <div className="aroma-content">
                <div className="config-panel glass-panel" style={{ width: sidebarWidth, position: 'relative' }}>
                    <div onMouseDown={handleMouseDown} style={{ position: 'absolute', top: 0, right: -5, width: '10px', height: '100%', cursor: 'col-resize', zIndex: 10 }} />
                    <h3 className="panel-title"><Settings size={16} /> Batch Parameters</h3>

                    <div className="form-group">
                        <label>Target Sensor Columns</label>
                        <textarea className="text-input" style={{ width: '100%', minHeight: '80px', fontSize: '0.8rem' }} value={sensingElements} onChange={e => setSensingElements(e.target.value)} spellCheck={false} />
                    </div>

                    <div className="form-group">
                        <label>Filter by Target Concentration (Optional)</label>
                        <input type="text" className="text-input" value={targetConcFilter} onChange={e => setTargetConcFilter(e.target.value)} placeholder="e.g. 50ppb (leave empty for all)" />
                        <small style={{ display: 'block', marginTop: 4, color: '#94a3b8' }}>Variation calculations are most accurate when restricted to identical concentration exposures across all AU devices.</small>
                    </div>

                    <div className="form-group">
                        <label>Baseline Sampling Window (pts)</label>
                        <div className="slider-wrapper">
                            <input type="range" min="10" max="200" value={baselinePts} onChange={e => setBaselinePts(parseInt(e.target.value))} className="range-slider" />
                            <span className="slider-value">{baselinePts} pt</span>
                        </div>
                    </div>

                    <div className="active-files-info" style={{ marginTop: '20px' }}>
                        <strong>Available Pool:</strong> {availableFiles.length} files detected in workspace. Algorithm will automatically group them by ASAU ID prefixes.
                    </div>

                    <button className="btn-primary process-btn" onClick={handleProcessBatch} disabled={isProcessing || availableFiles.length === 0} style={{ backgroundColor: '#f43f5e', color: 'white' }}>
                        {isProcessing ? <RefreshCw className="spinner" size={16} /> : <Play size={16} />}
                        {isProcessing ? 'Analyzing Batch...' : 'Calculate Variation Metrics'}
                    </button>

                    {variationResults && (
                        <div style={{ marginTop: 24, padding: 12, background: 'rgba(0,0,0,0.2)', borderRadius: 8, fontSize: '0.85rem' }}>
                            <h4 style={{ margin: '0 0 8px 0', color: '#f43f5e' }}><Hash size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Yield Report</h4>
                            <p style={{ margin: '4px 0', color: '#e2e8f0' }}>Devices Analyzed: <strong>{Object.keys(variationResults.auMap).length}</strong></p>
                            <p style={{ margin: '4px 0', color: '#e2e8f0' }}>Files Processed: <strong>{variationResults.metrics.length}</strong></p>
                            <div style={{ marginTop: 8, color: '#94a3b8', fontSize: '0.75rem' }}>
                                AUs: {Object.keys(variationResults.auMap).join(', ')}
                            </div>
                        </div>
                    )}

                    {variationResults && variationResults.cvDataPoints.some(d => d.cv > 20) && (
                        <div style={{ marginTop: 16, padding: 12, border: '1px solid rgba(244,63,94,0.4)', background: 'rgba(244,63,94,0.1)', borderRadius: 8, fontSize: '0.85rem' }}>
                            <h4 style={{ margin: '0 0 8px 0', color: '#f43f5e', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <AlertTriangle size={14} /> Automated QA Alert
                            </h4>
                            <p style={{ margin: 0, color: '#e2e8f0' }}>
                                <strong>Out of Spec (OOS) Outliers Detected!</strong>
                            </p>
                            <p style={{ margin: '4px 0 0 0', color: '#fb7185', fontSize: '0.8rem' }}>
                                The following channels failed manufacturing tolerance (CV {'>'} 20%):<br />
                                {variationResults.cvDataPoints.filter(d => d.cv > 20).map(d => `${d.channel} (${d.cv.toFixed(1)}%)`).join(', ')}
                            </p>
                        </div>
                    )}
                </div>

                <div className="results-panel">
                    {variationResults ? (
                        <div className="plots-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
                            {/* Plot 1: Coefficient of Variation (CV) Bar Chart */}
                            <div className="plot-card glass-panel" style={{ width: '100%', marginBottom: 16 }}>
                                <h4 className="plot-title">Sensitivity Coefficient of Variation (CV%) per Channel</h4>
                                <div style={{ height: 320, width: '100%' }}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={variationResults.cvDataPoints} margin={{ top: 20, right: 30, left: 10, bottom: 25 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} vertical={false} />
                                            <XAxis dataKey="channel" tick={{ fontSize: 10, fill: '#94a3b8' }} angle={-45} textAnchor="end" stroke="#334155" />
                                            <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} stroke="#334155" label={{ value: 'CV (%)', angle: -90, position: 'insideLeft', fill: '#94a3b8' }} />
                                            <RechartsTooltip content={<CVTooltip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                                            {/* Reference line for highly variable logic > 20% */}
                                            <ReferenceLine y={20} stroke="#f43f5e" strokeDasharray="3 3" label={{ position: 'insideTopLeft', value: 'High Variability Threshold (20%)', fill: '#f43f5e', fontSize: 10 }} />
                                            {variationResults.cvDataPoints && variationResults.cvDataPoints.length > 0 && (
                                                <Bar dataKey="cv" radius={[4, 4, 0, 0]}>
                                                    {variationResults.cvDataPoints.map((entry, index) => (
                                                        <Cell key={`cell-${index}`} fill={entry.cv > 20 ? '#f43f5e' : (entry.cv > 10 ? '#fbbf24' : '#10b981')} />
                                                    ))}
                                                </Bar>
                                            )}
                                        </BarChart>
                                    </ResponsiveContainer>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', fontSize: '0.75rem', marginTop: 8, color: '#94a3b8' }}>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><div style={{ width: 10, height: 10, background: '#10b981', borderRadius: 2 }} /> Consistent (&lt;10%)</span>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><div style={{ width: 10, height: 10, background: '#fbbf24', borderRadius: 2 }} /> Moderate (10-20%)</span>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><div style={{ width: 10, height: 10, background: '#f43f5e', borderRadius: 2 }} /> High Variability (&gt;20%)</span>
                                </div>
                            </div>

                            {/* Plot 2: Peak Response Spread (Scatter) */}
                            <div className="plot-card glass-panel" style={{ width: '100%', marginBottom: 16 }}>
                                <h4 className="plot-title">Peak Response (Sensitivity) Inter-Device Spread</h4>
                                <div style={{ height: 320, width: '100%' }}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <ScatterChart margin={{ top: 20, right: 30, left: 20, bottom: 25 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                            <XAxis type="category" dataKey="channel" name="Channel" tick={{ fontSize: 10, fill: '#94a3b8' }} angle={-45} textAnchor="end" stroke="#334155" allowDuplicatedCategory={false} />
                                            <YAxis type="number" dataKey="value" name="Peak Response" tick={{ fontSize: 10, fill: '#94a3b8' }} stroke="#334155" label={{ value: 'Max Response (%)', angle: -90, position: 'insideLeft', fill: '#94a3b8' }} />
                                            <RechartsTooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: '3 3' }} />

                                            {/* Map a scatter grouping per AU ID for legend color differentiation */}
                                            {Object.keys(variationResults.auMap).map((auId, idx) => {
                                                const auData = variationResults.sensitivitySpreadPoints.filter(p => p.auId === auId);
                                                if (!auData || auData.length === 0) return null;
                                                return (
                                                    <Scatter key={auId} name={auId} data={auData} fill={COLORS[idx % COLORS.length]} shape="circle" fillOpacity={0.7} />
                                                )
                                            })}
                                            <Legend wrapperStyle={{ fontSize: '0.8rem', color: '#94a3b8', paddingTop: 10 }} />
                                        </ScatterChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>

                            {/* Plot 3: Baseline Spread (Scatter) */}
                            <div className="plot-card glass-panel" style={{ width: '100%' }}>
                                <h4 className="plot-title">Un-Normalized Baseline (R0) Variance</h4>
                                <div style={{ height: 320, width: '100%' }}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <ScatterChart margin={{ top: 20, right: 30, left: 20, bottom: 25 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                            <XAxis type="category" dataKey="channel" name="Channel" tick={{ fontSize: 10, fill: '#94a3b8' }} angle={-45} textAnchor="end" stroke="#334155" allowDuplicatedCategory={false} />
                                            <YAxis type="number" scale="log" dataKey="value" name="Baseline (Ohms)" tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={(tick) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(tick)} stroke="#334155" domain={['auto', 'auto']} allowDataOverflow />
                                            <RechartsTooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: '3 3' }} />

                                            {Object.keys(variationResults.auMap).map((auId, idx) => {
                                                const auData = variationResults.r0BoxPoints.filter(p => p.auId === auId);
                                                if (!auData || auData.length === 0) return null;
                                                return (
                                                    <Scatter key={auId} name={auId} data={auData} fill={COLORS[idx % COLORS.length]} shape="square" fillOpacity={0.7} />
                                                )
                                            })}
                                            <Legend wrapperStyle={{ fontSize: '0.8rem', color: '#94a3b8', paddingTop: 10 }} />
                                        </ScatterChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>

                        </div>
                    ) : (
                        <div className="empty-state-wrapper" style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                            <Layers size={48} opacity={0.3} style={{ marginBottom: 16 }} />
                            <p style={{ fontSize: '1.1rem', marginBottom: 8 }}>Variation Metrics Uncalculated</p>
                            <p style={{ fontSize: '0.9rem', maxWidth: 400, textAlign: 'center' }}>Upload multiple dataset files from different AU devices (with corresponding ASAU naming) into your Workspace to compute fabrication variance matrices.</p>
                        </div>
                    )}
                </div>
            </div>
        </motion.div>
    );
};

export default ManufacturingVariationPage;
