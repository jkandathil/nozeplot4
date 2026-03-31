import React, { useMemo, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Target, Info, ZoomIn } from 'lucide-react';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, ZAxis, ResponsiveContainer, Cell, Tooltip as RechartsTooltip, Legend, ReferenceLine
} from 'recharts';
import './SensitivityAnalysisPage.css';

const ELEMENT_GROUPS = [
    { name: 'Set 1', elements: ['A1', 'A2', 'C3', 'C4', 'D7', 'D8', 'F1', 'F2'], color: '#3b82f6' },
    { name: 'Set 2', elements: ['C1', 'C2', 'D1', 'D2', 'G5', 'G6', 'G7', 'G8'], color: '#a855f7' },
    { name: 'Set 3', elements: ['B1', 'B2', 'D3', 'D4', 'F5', 'F6', 'F7', 'F8'], color: '#ec4899' },
    { name: 'Set 4', elements: ['B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'D5', 'D6'], color: '#f97316' },
    { name: 'Set 5', elements: ['C5', 'C6', 'E5', 'E6', 'G1', 'G2', 'G3', 'G4'], color: '#eab308' },
    { name: 'Set 6', elements: ['C7', 'C8', 'E7', 'E8', 'H1', 'H2', 'H3', 'H4'], color: '#84cc16' },
    { name: 'Set 7', elements: ['A7', 'A8', 'E1', 'E2', 'H5', 'H6', 'H7', 'H8'], color: '#14b8a6' },
    { name: 'Set 8', elements: ['A3', 'A4', 'A5', 'A6', 'E3', 'E4', 'F3', 'F4'], color: '#6366f1' }
];

const ALL_ELEMENTS = [
    'A1','A2','A3','A4','A5','A6','A7','A8',
    'B1','B2','B3','B4','B5','B6','B7','B8',
    'C1','C2','C3','C4','C5','C6','C7','C8',
    'D1','D2','D3','D4','D5','D6','D7','D8',
    'E1','E2','E3','E4','E5','E6','E7','E8',
    'F1','F2','F3','F4','F5','F6','F7','F8',
    'G1','G2','G3','G4','G5','G6','G7','G8',
    'H1','H2','H3','H4','H5','H6','H7','H8'
];

const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'star', 'cross', 'wye'];

const CustomScatterTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
        const data = payload[0].payload;
        return (
            <div style={{
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '12px',
                padding: '16px',
                color: '#f8fafc',
                fontSize: '12px',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5)',
                minWidth: '220px'
            }}>
                <div style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px', marginBottom: '12px', fontWeight: 700, fontSize: '15px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: data.color }}>{data.element} Node</span>
                    <span style={{ fontSize: '10px', backgroundColor: 'rgba(255, 255, 255, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>{data.setName}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: '#94a3b8' }}>Sensitivity</span>
                        <span style={{ fontWeight: 600, color: '#38bdf8' }}>{data.sensitivityMag.toFixed(2)}% dR/R</span>
                    </div>
                    {data.concAtMax && data.concAtMax !== 'N/A' && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '-4px' }}>
                            <span style={{ color: '#64748b', fontSize: '10px' }}>  ↳ at Conc:</span>
                            <span style={{ fontWeight: 500, color: '#fbbf24', fontSize: '11px' }}>{data.concAtMax}</span>
                        </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: '#94a3b8' }}>Separability (S)</span>
                        <span style={{ fontWeight: 600, color: '#10b981' }}>{data.avgSep.toFixed(2)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: '#94a3b8' }}>Baseline Resist.</span>
                        <span style={{ fontWeight: 600, color: '#f8fafc', fontFamily: 'monospace' }}>{Math.round(data.baselineR).toLocaleString()} Ω</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: '#94a3b8' }}>Signal Spread</span>
                        <span style={{ fontWeight: 600, color: '#fba11b', fontFamily: 'monospace' }}>{data.spread.toFixed(3)} dR/R</span>
                    </div>
                </div>
            </div>
        );
    }
    return null;
};

const CustomLegend = ({ payload }) => {
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '16px', marginTop: '16px' }}>
            {payload.map((entry, index) => (
                <div key={`item-${index}`} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#cbd5e1' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: entry.color }}></div>
                    {entry.value}
                </div>
            ))}
        </div>
    );
};

const getPearson = (data, kx, ky) => {
    let n = data.length;
    if (n < 2) return 0;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    data.forEach(d => {
        let x = d[kx] || 0;
        let y = d[ky] || 0;
        sumX += x; sumY += y; sumXY += x*y; sumX2 += x*x; sumY2 += y*y;
    });
    let num = n * sumXY - sumX * sumY;
    let den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return den === 0 ? 0 : num / den;
};

const SensitivityAnalysisPage = ({ data, fileName }) => {
    const [selectedConcs, setSelectedConcs] = useState([]);
    const [selectedSets, setSelectedSets] = useState(['All Sets']);
    const [sensitivityMetric, setSensitivityMetric] = useState('max');
    const [showTrajectories, setShowTrajectories] = useState(true);
    const [viewMode, setViewMode] = useState('performance'); // 'performance' or 'baseline'

    const { concs, elementsMap } = useMemo(() => {
        if (!data || data.length === 0) return { concs: [], elementsMap: {} };
        
        const sampleObj = data[0] || {};
        const cols = Object.keys(sampleObj);
        const concSet = new Set();
        cols.forEach(col => {
            const match = col.match(/(\d+(?:\.\d+)?)\s*(?:ppb|ppm)/i);
            if(match) concSet.add(match[0].toLowerCase());
        });

        const sortedConcs = Array.from(concSet).sort((a,b) => parseFloat(a) - parseFloat(b));
        const activeConcs = sortedConcs.filter(c => parseFloat(c) > 0);
        
        const hasFeno = data.some(r => String(r.event_name || r.phase || r.mode || r.state || '').toLowerCase().includes('fenomeasurement'));

        const targetEventRows = data.filter(r => String(r.event_name || r.phase || r.mode || r.state || '').toLowerCase().includes('fenomeasurement'));
        let windowRows = targetEventRows;
        if (sensitivityMetric === 'avg_20_80' && targetEventRows.length > 0) {
            const startIdx = Math.floor(targetEventRows.length * 0.20);
            const endIdx = Math.ceil(targetEventRows.length * 0.80);
            windowRows = targetEventRows.slice(startIdx, endIdx);
        }

        // Baseline does not depend on concentration — compute once per element, not per conc × full data scan.
        const baselineColByEl = {};
        ALL_ELEMENTS.forEach((e) => {
            let rawCol = cols.find(
                (c) =>
                    c.toLowerCase().includes(`0 ppb_${e.toLowerCase()}_raw`) ||
                    c.toLowerCase().includes(`${e.toLowerCase()}_raw`)
            );
            if (!rawCol) rawCol = cols.find((c) => c.toLowerCase().includes(`_${e.toLowerCase()}_mean`) && c.includes('0 ppb'));
            baselineColByEl[e] = rawCol || null;
        });
        const baselineSumByEl = Object.fromEntries(ALL_ELEMENTS.map((e) => [e, 0]));
        const baselineCountByEl = Object.fromEntries(ALL_ELEMENTS.map((e) => [e, 0]));
        data.forEach((row) => {
            const ev = String(row.event_name || row.phase || row.mode || row.state || '').toLowerCase();
            if (
                !(
                    ev.includes('breathsaplingrfc') ||
                    ev.includes('breath') ||
                    ev.includes('rfc') ||
                    ev.includes('ambient')
                )
            )
                return;
            ALL_ELEMENTS.forEach((e) => {
                const col = baselineColByEl[e];
                if (!col) return;
                const val = parseFloat(row[col]);
                if (!isNaN(val)) {
                    baselineSumByEl[e] += val;
                    baselineCountByEl[e] += 1;
                }
            });
        });
        ALL_ELEMENTS.forEach((e) => {
            if (baselineCountByEl[e] === 0 && baselineColByEl[e]) {
                const val = parseFloat(data[0][baselineColByEl[e]]);
                if (!isNaN(val)) {
                    baselineSumByEl[e] = val;
                    baselineCountByEl[e] = 1;
                }
            }
        });

        const elMap = {};
        const activeProcRows = hasFeno ? windowRows : data;

        activeConcs.forEach((concLayer) => {
            elMap[concLayer] = ALL_ELEMENTS.map((e) => {
                const baselineR =
                    baselineCountByEl[e] > 0 ? baselineSumByEl[e] / baselineCountByEl[e] : 0;

                let maxNegativeResponse = 0;
                let spreadTotal = 0;
                let sepSum = 0;
                let sepCount = 0;
                let avgResponseSum = 0;
                let avgResponseCount = 0;

                activeProcRows.forEach((row) => {
                    let vMean = parseFloat(row[`${concLayer}_${e}_mean`]);
                    let vMin = parseFloat(row[`${concLayer}_${e}_min`]);
                    let v = !isNaN(vMin) ? vMin : vMean;
                    
                    if (!isNaN(v) && v < maxNegativeResponse) {
                        maxNegativeResponse = v;
                    }
                    if (!isNaN(vMean)) {
                        avgResponseSum += vMean;
                        avgResponseCount++;
                    }

                    let sMax = parseFloat(row[`${concLayer}_${e}_sigma_max`]);
                    let sMin = parseFloat(row[`${concLayer}_${e}_sigma_min`]);
                    if (!isNaN(sMax) && !isNaN(sMin)) {
                        spreadTotal += Math.abs(sMax - sMin);
                    }

                    let mu1 = parseFloat(row[`0 ppb_${e}_mean`]);
                    let mu2 = parseFloat(row[`${concLayer}_${e}_mean`]);
                    let std1 = (parseFloat(row[`0 ppb_${e}_sigma_max`]) - parseFloat(row[`0 ppb_${e}_sigma_min`])) / 2;
                    let std2 = (parseFloat(row[`${concLayer}_${e}_sigma_max`]) - parseFloat(row[`${concLayer}_${e}_sigma_min`])) / 2;
                    
                    if (!isNaN(mu1) && !isNaN(mu2)) {
                        let var1 = isNaN(std1) ? 0 : std1*std1;
                        let var2 = isNaN(std2) ? 0 : std2*std2;
                        let S = 0;
                        if (var1 > 0 || var2 > 0) {
                            S = Math.abs(mu1 - mu2) / (var1 + var2 + 1e-3);
                        }
                        sepSum += S;
                        sepCount++;
                    }
                });

                const sensitivityMag = sensitivityMetric === 'avg_20_80' 
                    ? (avgResponseCount > 0 ? Math.abs(avgResponseSum / avgResponseCount) : 0)
                    : Math.abs(maxNegativeResponse);
                    
                const avgSep = sepCount > 0 ? (sepSum / sepCount) : 0;
                const spreadAvg = sepCount > 0 ? (spreadTotal / sepCount) : spreadTotal;
                
                let group = ELEMENT_GROUPS.find(g => g.elements.includes(e));
                return {
                    element: e,
                    baselineR: isNaN(baselineR) ? 0 : baselineR,
                    sensitivityMag: isNaN(sensitivityMag) ? 0 : sensitivityMag,
                    avgSep: isNaN(avgSep) ? 0 : avgSep,
                    spread: isNaN(spreadAvg) ? 0 : spreadAvg,
                    concAtMax: concLayer,
                    color: group ? group.color : '#94a3b8',
                    setName: group ? group.name : 'Unknown'
                };
            }).filter(item => item.sensitivityMag > 0 || item.avgSep > 0 || item.spread > 0);
        });

        return { concs: activeConcs, elementsMap: elMap };
    }, [data, sensitivityMetric]);

    useEffect(() => {
        setSelectedConcs((prev) => {
            if (!concs?.length) return prev;
            if (prev.length > 0) return prev;
            return [concs[concs.length - 1]];
        });
    }, [concs]);

    const elementLinesData = useMemo(() => {
        if (!showTrajectories || selectedConcs.length < 2) return [];
        const lines = [];
        const selectedSetsSet = new Set(selectedSets);
        
        ALL_ELEMENTS.forEach(e => {
            const points = [];
            let isValidSet = false;
            
            selectedConcs.forEach(c => {
                if (!elementsMap[c]) return;
                const point = elementsMap[c].find(item => item.element === e);
                if (point) {
                    if (selectedSetsSet.has('All Sets') || selectedSetsSet.has(point.setName)) {
                        isValidSet = true;
                        points.push({ ...point });
                    }
                }
            });
            if (isValidSet && points.length > 1) {
                points.sort((a,b) => parseFloat(a.concAtMax) - parseFloat(b.concAtMax));
                lines.push({ element: e, data: points, color: points[0].color });
            }
        });
        return lines;
    }, [showTrajectories, selectedConcs, selectedSets, elementsMap]);

    const combinedActiveData = useMemo(() => {
        let combined = [];
        selectedConcs.forEach(c => {
            if (!elementsMap[c]) return;
            let layerData = elementsMap[c];
            if (!selectedSets.includes('All Sets')) {
                layerData = layerData.filter(item => selectedSets.includes(item.setName));
            }
            combined = combined.concat(layerData);
        });
        return combined;
    }, [selectedConcs, selectedSets, elementsMap]);

    const baselineCorrelations = useMemo(() => {
        return {
            rSens: getPearson(combinedActiveData, 'baselineR', 'sensitivityMag'),
            rSep: getPearson(combinedActiveData, 'baselineR', 'avgSep')
        };
    }, [combinedActiveData]);

    // Handlers
    const handleConcClick = (c) => {
        if (!selectedConcs.includes(c)) {
            setSelectedConcs([...selectedConcs, c]);
        }
    };

    const handleConcDoubleClick = (c) => {
        if (selectedConcs.length > 1) {
            setSelectedConcs(selectedConcs.filter(x => x !== c));
        }
    };

    const handleSetClick = (s) => {
        if (s === 'All Sets') {
            setSelectedSets(['All Sets']);
        } else {
            const newSets = selectedSets.filter(x => x !== 'All Sets');
            if (!newSets.includes(s)) {
                setSelectedSets([...newSets, s]);
            }
        }
    };

    const handleSetDoubleClick = (s) => {
        if (s === 'All Sets') return;
        const newSets = selectedSets.filter(x => x !== s);
        if (newSets.length === 0) setSelectedSets(['All Sets']);
        else setSelectedSets(newSets);
    };

    // Data for Legends
    const legendPayload = ELEMENT_GROUPS.map(g => ({
        value: g.name,
        type: 'circle',
        id: g.name,
        color: g.color
    }));

    if (!data || data.length === 0) {
        return (
            <div className="sensitivity-analysis-page">
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8' }}>
                    <Info size={24} style={{ marginRight: '8px' }} />
                    Select a wide aroma summary file in the sidebar (e.g. aroma_analysis_*.csv), or use SE Analysis to plot custom CSVs from disk or workspace.
                </div>
            </div>
        );
    }

    return (
        <div className="sensitivity-analysis-page">
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                    <h1 className="page-title">
                        <Target size={24} color="#38bdf8" />
                        Sensitivity & Separability
                    </h1>
                    <p style={{ margin: '8px 0 0 32px', color: '#94a3b8', fontSize: '0.9rem' }}>Analyzed Configuration Mapping</p>
                </div>
                
                <div style={{ display: 'flex', background: 'rgba(15, 23, 42, 0.4)', borderRadius: '8px', padding: '4px', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <button
                        onClick={() => setViewMode('performance')}
                        style={{
                            padding: '6px 16px', background: viewMode === 'performance' ? 'rgba(56, 189, 248, 0.2)' : 'transparent',
                            color: viewMode === 'performance' ? '#38bdf8' : '#64748b', border: 'none', borderRadius: '4px',
                            cursor: 'pointer', fontSize: '0.85rem', fontWeight: viewMode === 'performance' ? 600 : 400, transition: 'all 0.2s'
                        }}
                    >
                        3D Performance Map
                    </button>
                    <button
                        onClick={() => setViewMode('baseline')}
                        style={{
                            padding: '6px 16px', background: viewMode === 'baseline' ? 'rgba(168, 85, 247, 0.2)' : 'transparent',
                            color: viewMode === 'baseline' ? '#c084fc' : '#64748b', border: 'none', borderRadius: '4px',
                            cursor: 'pointer', fontSize: '0.85rem', fontWeight: viewMode === 'baseline' ? 600 : 400, transition: 'all 0.2s'
                        }}
                    >
                        Baseline Insights
                    </button>
                </div>
            </div>
            
            <div className="main-content-scroll" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                <div style={{ display: 'block', width: '100%', minHeight: '100%', flexShrink: 0 }}>
                <div className="chart-container-glass">
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '16px' }}>
                        <div style={{ marginRight: 'auto' }}>
                            <h2 style={{ margin: '0 0 4px 0', fontSize: '1.2rem', color: '#38bdf8', fontWeight: 600 }}>
                                Configuration Select
                            </h2>
                            <p style={{ margin: 0, fontSize: '0.85rem', color: '#94a3b8' }}>
                                (Single-click to Add. Double-click to Remove)
                            </p>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'flex-start' }}>
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                                <span style={{fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', minWidth: '40px'}}>Concs:</span>
                                {concs.map((c, i) => (
                                    <button
                                        key={c}
                                        onClick={() => handleConcClick(c)}
                                        onDoubleClick={() => handleConcDoubleClick(c)}
                                        style={{
                                            padding: '4px 12px',
                                            background: selectedConcs.includes(c) ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255,255,255,0.05)',
                                            border: `1px solid ${selectedConcs.includes(c) ? 'rgba(56, 189, 248, 0.5)' : 'rgba(255,255,255,0.1)'}`,
                                            color: selectedConcs.includes(c) ? '#38bdf8' : '#cbd5e1',
                                            borderRadius: '6px',
                                            cursor: 'pointer',
                                            fontSize: '0.8rem',
                                            fontWeight: selectedConcs.includes(c) ? 600 : 400,
                                            transition: 'all 0.2s ease',
                                            outline: 'none',
                                            userSelect: 'none'
                                        }}
                                        title={`Added as ${SHAPES[i % SHAPES.length]} shape`}
                                    >
                                        {c}
                                    </button>
                                ))}
                            </div>
                            
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                                <span style={{fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', minWidth: '40px'}}>Sets:</span>
                                {['All Sets', ...ELEMENT_GROUPS.map(g => g.name)].map(s => (
                                    <button
                                        key={s}
                                        onClick={() => handleSetClick(s)}
                                        onDoubleClick={() => handleSetDoubleClick(s)}
                                        style={{
                                            padding: '4px 12px',
                                            background: selectedSets.includes(s) ? 'rgba(168, 85, 247, 0.2)' : 'rgba(255,255,255,0.05)',
                                            border: `1px solid ${selectedSets.includes(s) ? 'rgba(168, 85, 247, 0.5)' : 'rgba(255,255,255,0.1)'}`,
                                            color: selectedSets.includes(s) ? '#c084fc' : '#cbd5e1',
                                            borderRadius: '6px',
                                            cursor: 'pointer',
                                            fontSize: '0.8rem',
                                            fontWeight: selectedSets.includes(s) ? 600 : 400,
                                            transition: 'all 0.2s ease',
                                            outline: 'none',
                                            userSelect: 'none'
                                        }}
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>

                            {/* Sensitivity Metric Radio */}
                            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', marginTop: '4px', background: 'rgba(15, 23, 42, 0.4)', padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                                <span style={{fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px'}}>Metric:</span>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.85rem', color: sensitivityMetric === 'max' ? '#f8fafc' : '#94a3b8' }}>
                                    <input 
                                        type="radio" 
                                        name="sensitivityMetric" 
                                        value="max" 
                                        checked={sensitivityMetric === 'max'} 
                                        onChange={(e) => setSensitivityMetric(e.target.value)}
                                        style={{ accentColor: '#38bdf8' }}
                                    />
                                    Max Sensitivity
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.85rem', color: sensitivityMetric === 'avg_20_80' ? '#f8fafc' : '#94a3b8' }} title="Average of 20%-80% middle window of FeNOMeasurement event">
                                    <input 
                                        type="radio" 
                                        name="sensitivityMetric" 
                                        value="avg_20_80" 
                                        checked={sensitivityMetric === 'avg_20_80'} 
                                        onChange={(e) => setSensitivityMetric(e.target.value)}
                                        style={{ accentColor: '#38bdf8' }}
                                    />
                                    Avg Sensitivity (20-80% Window)
                                </label>

                                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.85rem', color: showTrajectories ? '#38bdf8' : '#94a3b8', borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '12px', marginLeft: '6px' }} title="Show tracking lines mapping how the exact element evolves across multiple concentrations.">
                                    <input 
                                        type="checkbox" 
                                        checked={showTrajectories} 
                                        onChange={(e) => setShowTrajectories(e.target.checked)}
                                        style={{ accentColor: '#38bdf8' }}
                                    />
                                    Show Trajectories
                                </label>
                            </div>
                        </div>
                    </div>
                    
                    <div style={{ display: 'block', width: '100%', paddingBottom: '20px' }}>
                            {viewMode === 'baseline' ? (
                                <div style={{ display: 'block', animation: 'fadeIn 0.3s ease-in' }}>
                                    <div style={{ background: 'rgba(15, 23, 42, 0.4)', padding: '20px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)', marginBottom: '20px' }}>
                                        <h3 style={{ margin: '0 0 16px 0', color: '#f8fafc', fontSize: '1.1rem' }}>Overall Baseline Correlation Summary</h3>
                                        <p style={{ margin: '0 0 16px 0', color: '#cbd5e1', fontSize: '0.9rem' }}>
                                            Computing algorithmic Pearson Correlation Coefficients (r) traversing {combinedActiveData.length} valid active data points matching your configurations.
                                        </p>
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
                                            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px' }}>
                                                <div style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '4px' }}>Baseline R vs Sensitivity (r)</div>
                                                <div style={{ fontSize: '1.4rem', fontWeight: 600, color: Math.abs(baselineCorrelations.rSens) > 0.4 ? '#38bdf8' : '#e2e8f0' }}>
                                                    {baselineCorrelations.rSens > 0 ? '+' : ''}{baselineCorrelations.rSens.toFixed(4)}
                                                </div>
                                            </div>
                                            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px' }}>
                                                <div style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '4px' }}>Baseline R vs Separability (r)</div>
                                                <div style={{ fontSize: '1.4rem', fontWeight: 600, color: Math.abs(baselineCorrelations.rSep) > 0.4 ? '#10b981' : '#e2e8f0' }}>
                                                    {baselineCorrelations.rSep > 0 ? '+' : ''}{baselineCorrelations.rSep.toFixed(4)}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', paddingBottom: '20px' }}>
                                        <div style={{ background: 'rgba(15, 23, 42, 0.3)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)', padding: '16px' }}>
                                            <h4 style={{ margin: '0 0 16px 0', fontSize: '0.95rem', color: '#cbd5e1', textAlign: 'center' }}>Baseline vs Sensitivity</h4>
                                            <ResponsiveContainer width="100%" height={320}>
                                                <ScatterChart isAnimationActive={false} margin={{ top: 10, right: 20, bottom: 40, left: 40 }}>
                                                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                                                    <XAxis type="number" dataKey="baselineR" name="Baseline (Ω)" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 10 }} label={{ value: 'Baseline Resistance (Ω)', position: 'bottom', offset: 20, fill: '#cbd5e1', fontSize: 11 }} />
                                                    <YAxis type="number" dataKey="sensitivityMag" name="Sensitivity" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 10 }} label={{ value: 'Sensitivity (%)', angle: -90, position: 'left', offset: 10, fill: '#cbd5e1', fontSize: 11 }} />
                                                    <ZAxis type="number" dataKey="spread" range={[40, 300]} />
                                                    <RechartsTooltip cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.2)' }} content={<CustomScatterTooltip />} />
                                                    
                                                    {showTrajectories && elementLinesData.flatMap(lineData => {
                                                        const segments = [];
                                                        for (let i = 0; i < lineData.data.length - 1; i++) {
                                                            segments.push(
                                                                <ReferenceLine
                                                                    key={`traj1-${lineData.element}-${i}`}
                                                                    segment={[
                                                                        { x: lineData.data[i].baselineR, y: lineData.data[i].sensitivityMag },
                                                                        { x: lineData.data[i+1].baselineR, y: lineData.data[i+1].sensitivityMag }
                                                                    ]}
                                                                    stroke={lineData.color}
                                                                    strokeWidth={1.5}
                                                                    strokeDasharray="4 4"
                                                                    isFront={false}
                                                                />
                                                            );
                                                        }
                                                        return segments;
                                                    })}

                                                    {selectedConcs.map((concKey, idx) => {
                                                        if (!elementsMap[concKey]) return null;
                                                        const activeData = selectedSets.includes('All Sets') 
                                                            ? elementsMap[concKey] 
                                                            : elementsMap[concKey].filter(item => selectedSets.includes(item.setName));
                                                        return (
                                                            <Scatter key={`cb1-${concKey}`} name={concKey} data={activeData} shape={SHAPES[idx % SHAPES.length]}>
                                                                {activeData.map((entry, index) => (
                                                                    <Cell key={`cell-cb1-${entry.element}-${index}`} fill={entry.color} stroke="rgba(255,255,255,0.4)" strokeWidth={1} fillOpacity={0.7} />
                                                                ))}
                                                            </Scatter>
                                                        );
                                                    })}
                                                </ScatterChart>
                                            </ResponsiveContainer>
                                        </div>

                                        <div style={{ background: 'rgba(15, 23, 42, 0.3)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)', padding: '16px' }}>
                                            <h4 style={{ margin: '0 0 16px 0', fontSize: '0.95rem', color: '#cbd5e1', textAlign: 'center' }}>Baseline vs Separability</h4>
                                            <ResponsiveContainer width="100%" height={320}>
                                                <ScatterChart isAnimationActive={false} margin={{ top: 10, right: 20, bottom: 40, left: 40 }}>
                                                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                                                    <XAxis type="number" dataKey="baselineR" name="Baseline (Ω)" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 10 }} label={{ value: 'Baseline Resistance (Ω)', position: 'bottom', offset: 20, fill: '#cbd5e1', fontSize: 11 }} />
                                                    <YAxis type="number" dataKey="avgSep" name="Separability" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 10 }} label={{ value: 'Separability (S)', angle: -90, position: 'left', offset: 10, fill: '#cbd5e1', fontSize: 11 }} />
                                                    <ZAxis type="number" dataKey="spread" range={[40, 300]} />
                                                    <RechartsTooltip cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.2)' }} content={<CustomScatterTooltip />} />
                                                    
                                                    {showTrajectories && elementLinesData.flatMap(lineData => {
                                                        const segments = [];
                                                        for (let i = 0; i < lineData.data.length - 1; i++) {
                                                            segments.push(
                                                                <ReferenceLine
                                                                    key={`traj2-${lineData.element}-${i}`}
                                                                    segment={[
                                                                        { x: lineData.data[i].baselineR, y: lineData.data[i].avgSep },
                                                                        { x: lineData.data[i+1].baselineR, y: lineData.data[i+1].avgSep }
                                                                    ]}
                                                                    stroke={lineData.color}
                                                                    strokeWidth={1.5}
                                                                    strokeDasharray="4 4"
                                                                    isFront={false}
                                                                />
                                                            );
                                                        }
                                                        return segments;
                                                    })}

                                                    {selectedConcs.map((concKey, idx) => {
                                                        if (!elementsMap[concKey]) return null;
                                                        const activeData = selectedSets.includes('All Sets') 
                                                            ? elementsMap[concKey] 
                                                            : elementsMap[concKey].filter(item => selectedSets.includes(item.setName));
                                                        return (
                                                            <Scatter key={`cb2-${concKey}`} name={concKey} data={activeData} shape={SHAPES[idx % SHAPES.length]}>
                                                                {activeData.map((entry, index) => (
                                                                    <Cell key={`cell-cb2-${entry.element}-${index}`} fill={entry.color} stroke="rgba(255,255,255,0.4)" strokeWidth={1} fillOpacity={0.7} />
                                                                ))}
                                                            </Scatter>
                                                        );
                                                    })}
                                                </ScatterChart>
                                            </ResponsiveContainer>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div style={{ width: '100%', height: '400px', position: 'relative', animation: 'fadeIn 0.3s ease-in' }}>
                                    <div style={{ position: 'absolute', top: '-25px', left: '0px', fontSize: '10px', color: '#64748b', display: 'flex', alignItems: 'center', gap: '4px', zIndex: 10 }}>
                                        <ZoomIn size={12} /> Hover bubbles for element details
                                    </div>
                                    
                                    <AnimatePresence mode="wait">
                                    {selectedConcs.length > 0 && (
                                    <motion.div
                                        key={`perf-${selectedConcs.join('-')}-${selectedSets.join('-')}-${sensitivityMetric}-${showTrajectories}`}
                                        initial={{ opacity: 0, scale: 0.98, filter: 'blur(2px)' }}
                                        animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                                        exit={{ opacity: 0, scale: 0.98, filter: 'blur(2px)' }}
                                        transition={{ duration: 0.4, ease: "easeInOut" }}
                                        style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }}
                                    >
                                        <ResponsiveContainer width="100%" height="100%">
                                        <ScatterChart isAnimationActive={false} margin={{ top: 20, right: 30, bottom: 50, left: 25 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                                            
                                            <XAxis 
                                                type="number" 
                                                dataKey="sensitivityMag" 
                                                name="Sensitivity" 
                                                stroke="#64748b"
                                                tick={{ fill: '#94a3b8', fontSize: 11 }}
                                                tickFormatter={(val) => `${val.toFixed(1)}%`}
                                                label={{ value: `Response Magnitude (% dR/R)`, position: 'bottom', offset: 20, fill: '#cbd5e1', fontSize: 12, fontWeight: 500 }} 
                                            />
                                            
                                            <YAxis 
                                                type="number" 
                                                dataKey="avgSep" 
                                                name="Separability Score" 
                                                stroke="#64748b"
                                                tick={{ fill: '#94a3b8', fontSize: 11 }}
                                                tickFormatter={(val) => val.toFixed(2)}
                                                label={{ value: 'Separability (vs 0 ppb)', angle: -90, position: 'left', offset: 5, fill: '#cbd5e1', fontSize: 12, fontWeight: 500 }} 
                                            />
                                            
                                            <ZAxis 
                                                type="number" 
                                                dataKey="spread" 
                                                range={[30, 500]} 
                                                name="Signal Spread" 
                                            />
                                            
                                            <RechartsTooltip 
                                                cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.2)' }} 
                                                content={<CustomScatterTooltip />}
                                            />
                                            
                                            {/* Trajectories via explicit SVG native ReferenceLine segment geometries */}
                                            {showTrajectories && elementLinesData.flatMap(lineData => {
                                                const segments = [];
                                                for (let i = 0; i < lineData.data.length - 1; i++) {
                                                    segments.push(
                                                        <ReferenceLine
                                                            key={`traj-${lineData.element}-${i}`}
                                                            segment={[
                                                                { x: lineData.data[i].sensitivityMag, y: lineData.data[i].avgSep },
                                                                { x: lineData.data[i+1].sensitivityMag, y: lineData.data[i+1].avgSep }
                                                            ]}
                                                            stroke={lineData.color}
                                                            strokeWidth={1.5}
                                                            strokeDasharray="4 4"
                                                            isFront={false}
                                                        />
                                                    );
                                                }
                                                return segments;
                                            })}
                                            
                                            {selectedConcs.map((concKey, idx) => {
                                                if (!elementsMap[concKey]) return null;
                                                const activeData = selectedSets.includes('All Sets') 
                                                    ? elementsMap[concKey] 
                                                    : elementsMap[concKey].filter(item => selectedSets.includes(item.setName));
                                                
                                                return (
                                                    <Scatter 
                                                        key={`scatter-${concKey}`} 
                                                        name={concKey} 
                                                        data={activeData} 
                                                        shape={SHAPES[idx % SHAPES.length]}
                                                    >
                                                        {activeData.map((entry, index) => (
                                                            <Cell 
                                                                key={`cell-${entry.element}-${index}`} 
                                                                fill={entry.color} 
                                                                stroke="rgba(255,255,255,0.4)"
                                                                strokeWidth={1}
                                                                fillOpacity={0.7} 
                                                            />
                                                        ))}
                                                    </Scatter>
                                                );
                                            })}
                                            
                                        </ScatterChart>
                                        </ResponsiveContainer>
                                    </motion.div>
                                    )}
                                    </AnimatePresence>
                                </div>
                            )}
                    </div>
                </div>

                {/* Shared Legend at the very bottom */}
                <div style={{ display: 'flex', justifyContent: 'center', padding: '30px 0 50px 0', marginTop: '20px', zIndex: 100, position: 'relative' }}>
                    <CustomLegend payload={legendPayload} />
                </div>
                </div>
            </div>
        </div>
    );
};

export default SensitivityAnalysisPage;
