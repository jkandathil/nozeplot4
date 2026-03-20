import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Loader, Layers, Download, ArrowLeft } from 'lucide-react';
import { ResponsiveContainer, ComposedChart, Area, Line, LineChart, XAxis, YAxis, Tooltip as RechartsTooltip, CartesianGrid, ReferenceLine, Legend } from 'recharts';
import { parseFile } from '../utils/fileParser';
import { motion } from 'framer-motion';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { processAromaBatchCore } from '../utils/aromaAnalysisPipeline';
import './AromaAnalysisPage.css';

const COLORS = [
    '#2E91E5', '#E15F99', '#1CA71C', '#FB0D0D', '#DA16FF', '#B68100', '#750D86', '#EB663B', '#511CFB', '#00A08B',
    '#10b981', '#38bdf8', '#fbbf24', '#f43f5e', '#a855f7', '#64748b', '#ef4444', '#f97316', '#84cc16', '#14b8a6', '#4f46e5', '#db2777'
];

const CustomAromaLegend = (props) => {
    const { payload, targetPlot } = props;
    return (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: '12px', rowGap: '4px' }}>
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
            background: 'rgba(15,23,42,0.85)',
            backdropFilter: 'blur(16px)',
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

const FolderCompareAromaPage = ({ files, selectedFileId, compareFileIds = [], onClose }) => {
    const [isProcessing, setIsProcessing] = useState(true);
    const [processedGrid, setProcessedGrid] = useState(null);
    const [renderLimit, setRenderLimit] = useState(0);
    const pdfRef = useRef(null);
    const [isDownloading, setIsDownloading] = useState(false);

    const activeFolders = useMemo(() => {
        const rootFiles = files.filter(f => !f.folderId && !f.isFolder);
        const folders = files.filter(f => f.isFolder);
        if (rootFiles.length > 0) {
            folders.push({ id: 'root-data-files', name: 'DataFiles', isFolder: true });
        }
        return folders;
    }, [files]);

    const handleDownloadPdf = async () => {
        if (!pdfRef.current || !processedGrid) return;
        setIsDownloading(true);
        try {
            await new Promise(resolve => setTimeout(resolve, 300));
            const targetElement = pdfRef.current;
            const originalBackground = targetElement.style.background;
            targetElement.style.background = '#0f172a';

            const imgData = await toPng(targetElement, {
                backgroundColor: '#0f172a',
                pixelRatio: 2,
                style: { margin: '0' }
            });
            targetElement.style.background = originalBackground;

            const pdf = new jsPDF({
                orientation: 'portrait',
                unit: 'px',
                format: [targetElement.offsetWidth + 40, targetElement.offsetHeight + 80]
            });

            pdf.setFillColor('#0f172a');
            pdf.rect(0, 0, pdf.internal.pageSize.getWidth(), pdf.internal.pageSize.getHeight(), 'F');

            pdf.setFontSize(24);
            pdf.setTextColor('#f8fafc');
            pdf.text('AU Batch Comparative Plots', 20, 40);
            pdf.setFontSize(14);
            pdf.setTextColor('#94a3b8');
            pdf.text(`Generated: ${new Date().toLocaleString()}`, 20, 60);

            pdf.addImage(imgData, 'PNG', 20, 70, targetElement.offsetWidth, targetElement.offsetHeight);
            pdf.save(`batch_plots_${new Date().toISOString().split('T')[0]}.pdf`);
        } catch (error) {
            console.error('Failed to generate PDF:', error);
            alert('Failed to generate PDF. Check console for details.');
        } finally {
            setIsDownloading(false);
        }
    };

    useEffect(() => {
        if (!isProcessing && processedGrid && renderLimit < processedGrid.channels.length) {
            const t = setTimeout(() => {
                setRenderLimit(prev => Math.min(prev + 4, processedGrid.channels.length));
            }, 100);
            return () => clearTimeout(t);
        }
    }, [isProcessing, processedGrid, renderLimit]);

    useEffect(() => {
        let isMounted = true;

        const processAllFolders = async () => {
            setIsProcessing(true);
            try {
                const defaultSensing = 'A1, A2, A3, A4, A5, A6, A7, A8, B1, B2, B3, B4, B5, B6, B7, B8, C1, C2, C3, C4, C5, C6, C7, C8, D1, D2, D3, D4, D5, D6, D7, D8, E1, E2, E3, E4, E5, E6, E7, E8, F1, F2, F3, F4, F5, F6, F7, F8, G1, G2, G3, G4, G5, G6, G7, G8, H1, H2, H3, H4, H5, H6, H7, H8';
                const sElements = localStorage.getItem('aroma_sensingElements') || defaultSensing;
                const tempCols = localStorage.getItem('aroma_tempCols') || 'BT1, AQT0';
                const humCols = localStorage.getItem('aroma_humCols') || 'AQH0, TRHH0';
                const filterWindow = parseInt(localStorage.getItem('aroma_filterWindow') || '5', 10);
                const baselinePts = parseInt(localStorage.getItem('aroma_baselinePts') || '50', 10);
                const removeRecoveryEvents = localStorage.getItem('aroma_removeRecoveryEvents') !== 'false';
                const fenoTruncateSeconds = parseInt(localStorage.getItem('aroma_fenoTruncateSeconds') || '0', 10);
                const filterUnknown = localStorage.getItem('aroma_filterUnknown') !== 'false';

                const config = {
                    sensingElements: sElements,
                    tempCols,
                    humCols,
                    filterWindow,
                    baselinePts,
                    removeRecoveryEvents,
                    fenoTruncateSeconds,
                    filterUnknown,
                    gapStart: null,
                    gapEnd: null,
                    separateByUnit: false,
                    COLORS
                };

                const gridData = {};
                let allUniqueChannelsMap = new Map();
                const allSelectedIds = [selectedFileId, ...compareFileIds].filter(Boolean);

                for (const folder of activeFolders) {
                    let folderFiles = [];
                    if (folder.id === 'root-data-files') {
                        folderFiles = files.filter(f => !f.folderId && !f.isFolder && allSelectedIds.includes(f.id));
                    } else {
                        folderFiles = files.filter(f => f.folderId === folder.id && allSelectedIds.includes(f.id));
                    }
                    if (folderFiles.length === 0) continue;

                    const parsedFiles = [];
                    for (const f of folderFiles) {
                        try {
                            if (f.data) {
                                parsedFiles.push({ fileName: f.name, data: f.data });
                            } else {
                                const p = await parseFile(f);
                                parsedFiles.push({ fileName: f.name, data: p.data });
                            }
                        } catch (e) { console.error('Parse file err', f.name, e); }
                    }

                    if (parsedFiles.length === 0) continue;

                    // Execute exactly the same pipeline algorithm dynamically 
                    const folderPlotsArray = await processAromaBatchCore(parsedFiles, config);
                    if (!folderPlotsArray) continue;

                    gridData[folder.id] = {
                        name: folder.name,
                        plotsArray: folderPlotsArray
                    };

                    folderPlotsArray.forEach(p => {
                        allUniqueChannelsMap.set(p.shortTitle, {
                            fullTitle: p.title
                        });
                    });
                }

                if (isMounted) {
                    setProcessedGrid({
                        gridData,
                        channels: Array.from(allUniqueChannelsMap.entries()).map(arr => ({ shortTitle: arr[0], fullTitle: arr[1].fullTitle }))
                    });
                    setRenderLimit(4);
                    setIsProcessing(false);
                }
            } catch (err) {
                console.error("Multi-folder pipeline error:", err);
                if (isMounted) setIsProcessing(`Error: ${err.message || err.toString()}`);
            }
        };

        const t = setTimeout(() => {
            processAllFolders();
        }, 150);

        return () => {
            isMounted = false;
            clearTimeout(t);
        };
    }, [files, selectedFileId, compareFileIds, activeFolders]);

    const successfullyProcessedFolders = (processedGrid && processedGrid.gridData)
        ? activeFolders.filter(f => processedGrid.gridData[f.id])
        : [];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', overflow: 'hidden' }}>
            <motion.div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-primary)', overflow: 'hidden' }} initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center', justifyContent: 'space-between', padding: '12px 24px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-secondary)', flexShrink: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                        <button onClick={onClose} style={{ display: 'flex', alignItems: 'center', background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '4px' }} title="Back to Single Plot">
                            <ArrowLeft size={20} />
                        </button>
                        <Layers size={20} color="#38bdf8" style={{ marginLeft: '12px', marginRight: '8px' }} />
                        <h1 style={{ margin: 0, fontSize: '1.2rem', color: '#f8fafc', fontWeight: 600 }}>Multi AU Trials comparison</h1>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '16px' }}>
                        <button
                            onClick={handleDownloadPdf}
                            disabled={isDownloading || !processedGrid}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '6px',
                                background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8',
                                border: '1px solid rgba(56, 189, 248, 0.3)', borderRadius: '6px',
                                padding: '6px 12px', fontSize: '0.8rem', cursor: (isDownloading || !processedGrid) ? 'wait' : 'pointer',
                                opacity: (isDownloading || !processedGrid) ? 0.5 : 1
                            }}
                            title="Download Plot Area as PDF"
                        >
                            {isDownloading ? <Loader className="spin" size={14} /> : <Download size={14} />}
                            Save PDF
                        </button>
                    </div>
                </div>

                <div style={{ flex: 1, overflow: 'auto', padding: '8px 24px 24px' }}>
                    {typeof isProcessing === 'string' ? (
                        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#f8fafc' }}>
                            <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239,68,68,0.5)', padding: '16px', borderRadius: '8px' }}>
                                <h3 style={{ margin: '0 0 8px 0', color: '#ef4444' }}>Pipeline Crash</h3>
                                <pre style={{ color: '#f8fafc', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxWidth: '600px' }}>{isProcessing}</pre>
                            </div>
                        </div>
                    ) : isProcessing || !processedGrid ? (
                        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                            <Loader className="spin" size={32} color="#38bdf8" style={{ marginBottom: 16 }} />
                            <h3 style={{ margin: 0, color: '#f8fafc' }}>Executing Pipeline Across Folders...</h3>
                            <p style={{ marginTop: 8, fontSize: '0.85rem' }}>Comparing {activeFolders.length} folders.</p>
                        </div>
                    ) : (
                        <>
                            <div ref={pdfRef} style={{
                                display: 'grid',
                                gridTemplateColumns: `80px repeat(${successfullyProcessedFolders.length}, minmax(450px, 1fr))`,
                                gap: '16px',
                                width: '100%',
                                minWidth: `${successfullyProcessedFolders.length * 450 + 80}px`,
                                paddingBottom: '24px'
                            }}>
                                {/* Header Row */}
                                <div style={{ position: 'sticky', top: 0, zIndex: 20, padding: '8px', fontWeight: 'bold', color: '#94a3b8', textAlign: 'center', borderBottom: '2px solid #334155', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15, 23, 42, 0.85)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>Channel</div>
                                {successfullyProcessedFolders.map(folder => (
                                    <div key={folder.id} style={{ position: 'sticky', top: 0, zIndex: 15, padding: '10px', fontWeight: 'bold', color: '#f8fafc', textAlign: 'center', borderBottom: '2px solid #38bdf8', background: 'rgba(15, 23, 42, 0.85)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', borderRadius: '6px 6px 0 0', display: 'flex', flexDirection: 'column' }}>
                                        {folder.name}
                                    </div>
                                ))}

                                {/* Channel Rows - Progressively Rendered */}
                                {processedGrid.channels.slice(0, renderLimit).map((channelObj) => {
                                    let folderBaselines = [];
                                    let hasBaselines = false;
                                    
                                    successfullyProcessedFolders.forEach(folder => {
                                        const folderGridData = processedGrid.gridData[folder.id];
                                        const targetPlot = folderGridData ? folderGridData.plotsArray.find(p => p.shortTitle === channelObj.shortTitle) : null;
                                        if (targetPlot && targetPlot.data) {
                                            let foundBaselines = [];
                                            for (let r = 0; r < Math.min(targetPlot.data.length, 100); r++) {
                                                const row = targetPlot.data[r];
                                                if (!row) continue;
                                                Object.keys(row).forEach(k => {
                                                    if (k.endsWith(`_${channelObj.shortTitle}_raw_baseline`)) {
                                                        const gName = k.substring(0, k.indexOf(`_${channelObj.shortTitle}_raw_baseline`));
                                                        if (!foundBaselines.some(b => b.name === gName)) {
                                                            foundBaselines.push({ name: gName, val: row[k] });
                                                        }
                                                    }
                                                });
                                                if (foundBaselines.length > 0) break;
                                            }
                                            if (foundBaselines.length > 0) {
                                                const avgBaseline = foundBaselines.reduce((sum, b) => sum + b.val, 0) / foundBaselines.length;
                                                folderBaselines.push({ name: folder.name, val: avgBaseline });
                                                hasBaselines = true;
                                            }
                                        }
                                    });

                                    return (
                                        <React.Fragment key={channelObj.shortTitle}>
                                            <div 
                                                className={hasBaselines ? "baseline-tooltip-container" : ""}
                                                style={!hasBaselines ? { display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', color: '#fbbf24', background: 'rgba(251,191,36,0.1)', borderRadius: '6px', padding: '8px' } : {}}
                                            >
                                                {channelObj.shortTitle}
                                                {hasBaselines && (
                                                    <div className="baseline-tooltip-content">
                                                        <div className="baseline-tooltip-header">Baselines for {channelObj.shortTitle}</div>
                                                        {folderBaselines.map((fb, idx) => (
                                                            <div key={idx} className="baseline-tooltip-row">
                                                                <span className="baseline-tooltip-bullet">•</span>
                                                                <span style={{ opacity: 0.9 }}>{fb.name}:</span>
                                                                <strong style={{ color: '#10b981' }}>{fb.val.toFixed(1)} Ω</strong>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>

                                            {successfullyProcessedFolders.map(folder => {
                                            const folderGridData = processedGrid.gridData[folder.id];
                                            const targetPlot = folderGridData ? folderGridData.plotsArray.find(p => p.shortTitle === channelObj.shortTitle) : null;

                                            return (
                                                <div key={`${folder.id}-${channelObj.shortTitle}`} className="plot-card glass-panel">
                                                    {targetPlot && targetPlot.data && targetPlot.data.length > 0 ? (
                                                        <>
                                                            <h4 className="plot-title" style={{ fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                                                {targetPlot.title}
                                                            </h4>
                                                            <div style={{ height: 320, width: '100%' }}>
                                                                <ResponsiveContainer width="100%" height="100%">
                                                                    {targetPlot.isComposed ? (
                                                                        <ComposedChart data={targetPlot.data} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
                                                                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                                                            <XAxis dataKey={targetPlot.xAxisKey || "index"} minTickGap={50} tick={{ fill: '#64748b', fontSize: 9 }} stroke="#334155" />
                                                                            <YAxis domain={['auto', 'auto']} tick={{ fill: '#64748b', fontSize: 9 }} width={45} stroke="#334155" tickFormatter={(val) => {
                                                                                const suffix = (targetPlot.yAxisLabel && targetPlot.yAxisLabel.includes('%')) ? '%' : '';
                                                                                return `${parseFloat(val.toFixed(3))}${suffix}`;
                                                                            }} />
                                                                            <RechartsTooltip content={<CustomAromaTooltip yAxisLabel={targetPlot.yAxisLabel} referenceLines={targetPlot.referenceLines} />} cursor={false} wrapperStyle={{ pointerEvents: 'auto' }} />
                                                                            {((targetPlot.lines?.length || 0) + (targetPlot.areas?.length || 0)) <= 20 && (
                                                                                <Legend content={<CustomAromaLegend targetPlot={targetPlot} />} wrapperStyle={{ paddingTop: '0px', marginTop: '-10px', paddingBottom: '0px' }} />
                                                                            )}
                                                                            {targetPlot.referenceLines && targetPlot.referenceLines.map((rl, rIdx) => (
                                                                                <ReferenceLine key={`ref-${rIdx}`} x={rl.x} stroke={rl.stroke} strokeDasharray="3 3" strokeOpacity={0.7} />
                                                                            ))}
                                                                            {targetPlot.areas && targetPlot.areas.map((area, aIdx) => <Area key={`area-${aIdx}`} type="monotone" dataKey={area.dataKey} name={area.name} fill={area.color} fillOpacity={0.15} stroke="none" isAnimationActive={false} connectNulls={false} legendType="none" />)}
                                                                            {targetPlot.lines && targetPlot.lines.map((line, lIdx) => <Line key={`line-${lIdx}`} type="monotone" dataKey={line.dataKey} name={line.name} stroke={line.color} strokeWidth={2} dot={targetPlot.xAxisKey ? true : false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} />)}
                                                                        </ComposedChart>
                                                                    ) : (
                                                                        <LineChart data={targetPlot.data} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
                                                                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.3} />
                                                                            <XAxis dataKey="index" minTickGap={50} tick={{ fill: '#64748b', fontSize: 9 }} stroke="#334155" />
                                                                            <YAxis domain={['auto', 'auto']} tick={{ fill: '#64748b', fontSize: 9 }} width={45} stroke="#334155" tickFormatter={(val) => {
                                                                                const suffix = (targetPlot.yAxisLabel && targetPlot.yAxisLabel.includes('%')) ? '%' : '';
                                                                                return `${parseFloat(val.toFixed(3))}${suffix}`;
                                                                            }} />
                                                                            <RechartsTooltip content={<CustomAromaTooltip yAxisLabel={targetPlot.yAxisLabel} referenceLines={targetPlot.referenceLines} />} cursor={false} wrapperStyle={{ pointerEvents: 'auto' }} />
                                                                            {((targetPlot.lines?.length || 0) + (targetPlot.areas?.length || 0)) <= 20 && (
                                                                                <Legend content={<CustomAromaLegend targetPlot={targetPlot} />} wrapperStyle={{ paddingTop: '0px', marginTop: '-10px', paddingBottom: '0px' }} />
                                                                            )}
                                                                            {targetPlot.lines && targetPlot.lines.map((line, lIdx) => <Line key={`line-${lIdx}`} type="monotone" dataKey={line.dataKey} name={line.name} stroke={line.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} />)}
                                                                        </LineChart>
                                                                    )}
                                                                </ResponsiveContainer>
                                                            </div>
                                                        </>
                                                    ) : (
                                                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '0.8rem' }}>No Data</div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </React.Fragment>
                                );
                            })}
                        </div>

                        {renderLimit < processedGrid.channels.length && (
                                <div style={{ width: '100%', padding: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', color: '#64748b' }}>
                                    <Loader className="spin" size={24} color="#38bdf8" />
                                    <span style={{ fontSize: '0.9rem' }}>Plotting remaining channels... ({renderLimit} / {processedGrid.channels.length})</span>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </motion.div>
        </div>
    );
};

export default FolderCompareAromaPage;
