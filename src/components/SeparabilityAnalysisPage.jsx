import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Activity, Play, BarChart2, Layers, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, Legend, ReferenceLine, ScatterChart, Scatter, Cell, ZAxis, ReferenceArea
} from 'recharts';

import './SeparabilityAnalysisPage.css';

// Pairwise S(t) Calculation (Raw Matrix fallback)
function calcSeparabilityWithEpsilon(valsA, valsB) {
    if (!valsA || !valsB || valsA.length === 0 || valsB.length === 0) return { S: 0, muA: 0, muB: 0, stdA: 0, stdB: 0 };
    const meanA = valsA.reduce((sum, v) => sum + v, 0) / valsA.length;
    const meanB = valsB.reduce((sum, v) => sum + v, 0) / valsB.length;
    
    const varA = valsA.length > 1 ? valsA.reduce((sum, v) => sum + Math.pow(v - meanA, 2), 0) / (valsA.length - 1) : 0;
    const varB = valsB.length > 1 ? valsB.reduce((sum, v) => sum + Math.pow(v - meanB, 2), 0) / (valsB.length - 1) : 0;
    const EPSILON = 1e-3; 
    let sValue = 0;
    if (varA > 0 || varB > 0) {
        const denominator = varA + varB + EPSILON;
        sValue = Math.abs(meanA - meanB) / denominator;
    }
    
    return { 
       S: isNaN(sValue) ? 0 : sValue, 
       muA: meanA, 
       muB: meanB, 
       stdA: Math.sqrt(varA), 
       stdB: Math.sqrt(varB) 
    };
}

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

const COLORS = [
  '#38bdf8', '#10b981', '#f43f5e', '#a855f7', '#fbbf24',
  '#2dd4bf', '#fb7185', '#6366f1', '#eab308', '#ec4899'
];

const CustomScatterTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
        const data = payload[0].payload;
        return (
            <div style={{
                backgroundColor: 'rgba(15, 23, 42, 0.9)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '12px',
                padding: '16px',
                color: '#f8fafc',
                fontSize: '12px',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.5)',
                minWidth: '200px'
            }}>
                <div style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px', marginBottom: '8px', fontWeight: 700, color: '#38bdf8', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>{data.element} Node</span>
                    <span style={{ fontSize: '10px', backgroundColor: 'rgba(56, 189, 248, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>Avg S: {data.avgPairScore.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: '#94a3b8' }}>Baseline R0</span>
                        <span style={{ fontWeight: 600, color: '#e2e8f0', fontFamily: 'monospace' }}>{Math.round(data.baselineR).toLocaleString()} Ω</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: '#94a3b8' }}>Stability</span>
                        <span style={{ fontWeight: 600, color: data.fracAbove2 > 0.8 ? '#10b981' : data.fracAbove2 < 0.2 ? '#f43f5e' : '#fbbf24' }}>{(data.fracAbove2 * 100).toFixed(1)}%</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px', paddingTop: '4px', borderTop: '1px dashed rgba(255,255,255,0.05)' }}>
                        <span style={{ color: '#64748b', fontSize: '10px' }}>Global Max S</span>
                        <span style={{ fontWeight: 500, color: '#94a3b8', fontSize: '10px' }}>{data.maxSepGlobal.toFixed(2)}</span>
                    </div>
                </div>
            </div>
        );
    }
    return null;
};

const ZoomableScatterPlot = ({ data }) => {
    // Pure data boundaries
    const { initMinX, initMaxX, initMinY, initMaxY } = useMemo(() => {
        const validX = data.map(d => d.baselineR).filter(v => typeof v === 'number' && !isNaN(v));
        const validY = data.map(d => d.fracAbove2).filter(v => typeof v === 'number' && !isNaN(v));
        
        let minX = validX.length ? Math.min(...validX) : 0;
        let maxX = validX.length ? Math.max(...validX) : 100;
        let minY = validY.length ? Math.min(...validY) : 0;
        let maxY = validY.length ? Math.max(...validY) : 1;
        
        if (minX === maxX) { minX -= 10; maxX += 10; }
        if (minY === maxY) { minY -= 0.1; maxY += 0.1; }
        
        const padX = (maxX - minX) * 0.05;
        const padY = (maxY - minY) * 0.05;
        return {
            initMinX: minX - padX,
            initMaxX: maxX + padX,
            initMinY: Math.max(0, minY - padY),
            initMaxY: Math.min(1.05, maxY + padY)
        };
    }, [data]);

    const [domainX, setDomainX] = useState([initMinX, initMaxX]);
    const [domainY, setDomainY] = useState([initMinY, initMaxY]);
    const [isDragging, setIsDragging] = useState(false);
    const [lastM, setLastM] = useState({ x: 0, y: 0 });

    const handleWheel = useCallback((e) => {
        e.preventDefault();
        const zoomIn = e.deltaY < 0;
        // Make zooming smooth and much less sensitive (capping at 8% per event)
        const factor = Math.min(Math.abs(e.deltaY) * 0.001, 0.08); 

        setDomainX(prev => {
            const span = prev[1] - prev[0];
            const newSpan = zoomIn ? span * (1 - factor) : span * (1 + factor);
            
            // Limit zoom out
            const limitMax = Math.max(1, (initMaxX - initMinX) * 3);
            // Limit zoom in (don't zoom further than 1% of total range)
            const limitMin = Math.max(0.01, (initMaxX - initMinX) * 0.01);
            
            if (newSpan > limitMax) return [prev[0] + span/2 - limitMax/2, prev[0] + span/2 + limitMax/2];
            if (newSpan < limitMin) return [prev[0] + span/2 - limitMin/2, prev[0] + span/2 + limitMin/2];
            
            const mx = prev[0] + span / 2;
            return [mx - newSpan / 2, mx + newSpan / 2];
        });

        setDomainY(prev => {
            const span = prev[1] - prev[0];
            const newSpan = zoomIn ? span * (1 - factor) : span * (1 + factor);
            
            const limitMax = Math.max(0.1, (initMaxY - initMinY) * 3);
            const limitMin = Math.max(0.001, (initMaxY - initMinY) * 0.01);
            
            if (newSpan > limitMax) return [prev[0] + span/2 - limitMax/2, prev[0] + span/2 + limitMax/2];
            if (newSpan < limitMin) return [prev[0] + span/2 - limitMin/2, prev[0] + span/2 + limitMin/2];
            
            const my = prev[0] + span / 2;
            return [my - newSpan / 2, my + newSpan / 2];
        });
    }, [initMinX, initMaxX, initMinY, initMaxY]);

    const handleMouseDown = (e) => {
        setIsDragging(true);
        setLastM({ x: e.clientX, y: e.clientY });
    };

    const handleMouseMove = (e) => {
        if (!isDragging) return;
        const dx = e.clientX - lastM.x;
        const dy = e.clientY - lastM.y;
        setLastM({ x: e.clientX, y: e.clientY });

        setDomainX(prev => {
            const span = prev[1] - prev[0];
            // roughly mapping dx pixels to domain span (assumes ~500px chart width)
            const shift = (dx / 500) * span;
            return [prev[0] - shift, prev[1] - shift];
        });
        setDomainY(prev => {
            const span = prev[1] - prev[0];
            // roughly mapping dy pixels to domain span (assumes ~200px chart height, inverted Y)
            const shift = (dy / 200) * span;
            return [prev[0] + shift, prev[1] + shift];
        });
    };

    const handleMouseUp = () => setIsDragging(false);

    const resetZoom = () => {
        setDomainX([initMinX, initMaxX]);
        setDomainY([initMinY, initMaxY]);
    };

    // Attach wheel cleanly
    const chartWrapperRef = React.useRef(null);
    const wheelRef = React.useRef(handleWheel);
    useEffect(() => { wheelRef.current = handleWheel; }, [handleWheel]);
    useEffect(() => {
        const el = chartWrapperRef.current;
        if (!el) return;
        const listener = (e) => wheelRef.current(e);
        el.addEventListener('wheel', listener, { passive: false });
        return () => el.removeEventListener('wheel', listener);
    }, []);

    const isZoomed = domainX[0] !== initMinX || domainX[1] !== initMaxX || domainY[0] !== initMinY || domainY[1] !== initMaxY;

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

    return (
        <div 
            ref={chartWrapperRef} 
            style={{ width: '100%', height: '100%', position: 'relative', cursor: isDragging ? 'grabbing' : 'grab', userSelect: 'none', display: 'flex', flexDirection: 'column' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
        >
            {isZoomed && (
                <button 
                    onClick={resetZoom}
                    style={{ position: 'absolute', top: 5, right: 10, background: '#1e293b', border: '1px solid rgba(255,255,255,0.2)', color: '#e2e8f0', borderRadius: '4px', padding: '4px 12px', fontSize: '0.7rem', cursor: 'pointer', zIndex: 50, transition: 'all 0.2s' }}
                    onMouseOver={e => e.currentTarget.style.background = '#334155'}
                    onMouseOut={e => e.currentTarget.style.background = '#1e293b'}
                >
                    Reset Zoom
                </button>
            )}
            
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '0 10px', marginBottom: '8px', zIndex: 10, pointerEvents: 'none' }}>
                {ELEMENT_GROUPS.map((g, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: '#cbd5e1' }}>
                        <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: g.color }}></div>
                        {g.name}
                    </div>
                ))}
            </div>

            <ResponsiveContainer width="100%" height="100%" style={{ flex: 1 }}>
                <ScatterChart 
                    margin={{ top: 20, right: 10, bottom: 25, left: -20 }} 
                >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis 
                        type="number" 
                        dataKey="baselineR" 
                        name="Base Reference" 
                        stroke="#64748b" 
                        domain={domainX}
                        allowDataOverflow={true}
                        fontSize={10} 
                        tickFormatter={(val) => Math.round(val).toLocaleString() + ' Ω'}
                        label={{ value: 'Element Base Reference (Ohms or Native)', position: 'bottom', offset: 5, fill: '#94a3b8', fontSize: 10 }} 
                    />
                    <YAxis 
                        type="number" 
                        dataKey="fracAbove2" 
                        name="Stability %" 
                        stroke="#64748b" 
                        domain={domainY}
                        allowDataOverflow={true}
                        fontSize={10} 
                        tickFormatter={(val) => `${(val * 100).toFixed(0)}%`} 
                        label={{ value: 'Stability (STAB. %)', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 10, offset: 10 }} 
                    />
                    <ZAxis type="number" dataKey="avgPairScore" range={[40, 200]} name="Avg S" />
                    
                    <RechartsTooltip 
                        cursor={{ strokeDasharray: '3 3' }} 
                        content={<CustomScatterTooltip />}
                        isAnimationActive={false}
                    />
                    
                    <Scatter data={data} shape="circle">
                        {data.map((entry, index) => {
                            // Border represents stability
                            let stabilityColor = '#fbbf24'; // Orange/Yellow
                            if (entry.fracAbove2 > 0.8) stabilityColor = '#10b981'; // Green
                            else if (entry.fracAbove2 < 0.2) stabilityColor = '#f43f5e'; // Red
                            // Fill represents Element Group
                            let groupColor = '#94a3b8'; // default slate grey
                            
                            const foundGroup = ELEMENT_GROUPS.find(g => g.elements.includes(entry.element));
                            if (foundGroup) groupColor = foundGroup.color;

                            return <Cell key={`cell-${index}`} fill={groupColor} fillOpacity={0.8} />;
                        })}
                    </Scatter>
                </ScatterChart>
            </ResponsiveContainer>
        </div>
    );
};

const SeparabilityAnalysisPage = ({ data: mainData, fileName: mainFileName, compareDataList }) => {
  const [targetColName, setTargetColName] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSidebarVisible, setIsSidebarVisible] = useState(() => localStorage.getItem('zenMode') !== 'true');

  useEffect(() => {
      const handleZenMode = (e) => setIsSidebarVisible(!e.detail.isZen);
      window.addEventListener('zen-mode-toggle', handleZenMode);
      return () => window.removeEventListener('zen-mode-toggle', handleZenMode);
  }, []);
  
  // Pipeline Results Array supporting multiple files
  const [multiFileResults, setMultiFileResults] = useState([]);
  const [availableClasses, setAvailableClasses] = useState([]);
  const [adjacentPairs, setAdjacentPairs] = useState([]);
  
  // Default Sort Config
  const [sortConfig, setSortConfig] = useState({ key: 'avgPairScore', direction: 'desc' });

  // Selected Element Map for detailed Plots: { fileId: elementObj }
  const [selectedElementsMap, setSelectedElementsMap] = useState({});

  const allDataSources = useMemo(() => {
    const list = [];
    if (mainData) list.push({ data: mainData, fileId: 'main', fileName: mainFileName });
    if (compareDataList && compareDataList.length > 0) {
      compareDataList.forEach(c => list.push({ data: c.data, fileId: c.id, fileName: c.fileName }));
    }
    return list;
  }, [mainData, mainFileName, compareDataList]);

  const [isAlaacMode, setIsAlaacMode] = useState(false);

  // Extract Classes and Form Adjacent Pairs
  useEffect(() => {
     if (!allDataSources.length) return;
     
     // --- ALAAC NATIVE SUMMARY DETECTION (Checks ALL sources) ---
     let alaacDetected = false;
     const classes = new Set();
     
     if (allDataSources.length > 0) {
         // It's ALAAC mode if AT LEAST ONE file has the _mean structure, OR we just check the first one.
         // Let's check if all files look like ALAAC.
         alaacDetected = allDataSources.every(source => {
             if (!source.data || source.data.length === 0) return false;
             return Object.keys(source.data[0]).some(k => k.match(/_(A[1-8]|B[1-8]|C[1-8]|D[1-8]|E[1-8]|F[1-8]|G[1-8]|H[1-8])_mean$/i));
         });

         if (alaacDetected) {
             // Extract classes from the first file (Assuming all uploaded ALAAC files tested the same classes)
             const sampleKeys = Object.keys(allDataSources[0].data[0]);
             sampleKeys.forEach(k => {
                 const match = k.match(/^(.*)_(A[1-8]|B[1-8]|C[1-8]|D[1-8]|E[1-8]|F[1-8]|G[1-8]|H[1-8])_mean$/i);
                 if (match) {
                     classes.add(match[1].trim());
                 }
             });
         }
     }
     
     setIsAlaacMode(alaacDetected);

     // --- STANDARD DETECTION OVERRIDE ---
     if (!alaacDetected) {
         allDataSources.forEach(source => {
              let targetVal;
              if (targetColName.trim()) {
                  targetVal = source.data[0]?.[targetColName.trim()];
              } else {
                  const match = String(source.fileName).match(/(\d+(?:\.\d+)?)\s*(?:ppb|ppm)/i);
                  if (match) targetVal = match[0].toLowerCase();
                  else {
                      const genericMatch = String(source.fileName).match(/(\d+(?:\.\d+)?)/);
                      targetVal = genericMatch ? genericMatch[0] : source.fileName;
                  }
              }
              if (targetVal !== undefined && targetVal !== null && targetVal !== '') {
                  classes.add(String(targetVal));
              }
         });
     }
     
     let parsedList = Array.from(classes).map(c => {
         const num = parseFloat(String(c).replace(/[^\d.]/g, ''));
         return { label: c, val: isNaN(num) ? 0 : num };
     });
     parsedList.sort((a,b) => a.val - b.val);
     
     let sortedLabels = parsedList.map(p => p.label);
     setAvailableClasses(sortedLabels);
     
     let pairs = [];
     for(let i = 0; i < sortedLabels.length - 1; i++) {
        pairs.push({ classA: sortedLabels[i], classB: sortedLabels[i+1], pairName: `${sortedLabels[i]} vs ${sortedLabels[i+1]}` });
     }
     setAdjacentPairs(pairs);
  }, [allDataSources, targetColName]);

  const handleCompute = () => {
    if (adjacentPairs.length === 0) {
        alert("At least 2 unique classes are needed to form an adjacent pair matrix!");
        return;
    }

    setIsProcessing(true);
    
    setTimeout(() => {
        try {
            let processedResults = [];

            if (isAlaacMode) {
                 // MULTI-FILE ALAAC SUMMARIES
                 // We calculate the entire element matrix independently for EACH loaded ALAAC file!
                 for (let source of allDataSources) {
                      const repFile = source.data || [];
                      if (repFile.length === 0) continue;
                      const sampleRow = repFile[0];
                      const sampleKeys = Object.keys(sampleRow);
                      
                      let existingElements = [];
                      for (let e of ALL_ELEMENTS) {
                          if (sampleKeys.some(k => k.endsWith(`_${e}_mean`))) {
                               existingElements.push(e);
                          }
                      }
                      if (existingElements.length === 0) continue;

                      // Extract Events
                      let refLines = [];
                      const evCol = sampleKeys.find(col => {
                          const l = col.toLowerCase();
                          return l === 'event_name' || l === 'phase' || l === 'mode' || l === 'state' || (l.includes('event') && !l.includes('reference'));
                      });
                      const xKeyStr = sampleKeys.find(k => k.toLowerCase() === 'index' || k.toLowerCase() === 'tick') || 'index fallback';
                      
                      if (evCol) {
                          const uniqueColors = ['#10b981', '#38bdf8', '#f43f5e', '#a855f7', '#f59e0b', '#8b5cf6'];
                          let colorIdx = 0;
                          const colorMap = {};
                          let curEv = null;
                          repFile.forEach((r, idx) => {
                              const eName = r[evCol];
                              if (eName && typeof eName === 'string') {
                                  if (curEv && curEv.name === eName) curEv.end = idx;
                                  else {
                                      if (curEv) {
                                          if (!colorMap[curEv.name]) colorMap[curEv.name] = uniqueColors[colorIdx++ % uniqueColors.length];
                                          refLines.push({ x: curEv.xVal, stroke: colorMap[curEv.name], label: curEv.name });
                                      }
                                      curEv = { name: eName, start: idx, end: idx, xVal: r[xKeyStr] !== undefined ? r[xKeyStr] : idx };
                                  }
                              }
                          });
                          if (curEv) {
                               if (!colorMap[curEv.name]) colorMap[curEv.name] = uniqueColors[colorIdx++ % uniqueColors.length];
                               refLines.push({ x: curEv.xVal, stroke: colorMap[curEv.name], label: curEv.name });
                          }
                      }

                      // Setup Stats
                      const BINS = Math.min(repFile.length, 250); 
                      const binSize = Math.max(1, Math.floor(repFile.length / BINS));

                      const statsMap = {};
                      existingElements.forEach(e => {
                          let pMap = {};
                          adjacentPairs.forEach(p => pMap[p.pairName] = { S_bins: [], xVals: [], maxS: 0, meanS: 0, countAbove2: 0, totalBins: 0 });
                          statsMap[e] = { element: e, pairs: pMap };
                      });

                      for (let bin = 0; bin < BINS; bin++) {
                          const startIndex = bin * binSize;
                          const realXVal = repFile[Math.min(startIndex, repFile.length-1)]?.[xKeyStr] !== undefined 
                                           ? repFile[Math.min(startIndex, repFile.length-1)][xKeyStr] 
                                           : (bin * binSize);
                          const repRowForBin = repFile[Math.min(startIndex, repFile.length - 1)] || {};
                          
                          let isFeno = false;
                          if (evCol) {
                              let evStr = String(repRowForBin[evCol] || '').toLowerCase().replace(/\s+/g, '');
                              if (evStr.includes('fenomeasurement') && !evStr.includes('recovery')) isFeno = true;
                          } else {
                              isFeno = true; 
                          }

                          for (let e of existingElements) {
                               let firstC = availableClasses[0];
                               let lastC = availableClasses[availableClasses.length - 1];
                               let firstMu = parseFloat(repRowForBin[`${firstC}_${e}_mean`]);
                               let lastMu = parseFloat(repRowForBin[`${lastC}_${e}_mean`]);
                               let globalDir = Math.sign(lastMu - firstMu);

                               adjacentPairs.forEach(pair => {
                                    let pData = statsMap[e].pairs[pair.pairName];
                                    let muI = parseFloat(repRowForBin[`${pair.classA}_${e}_mean`]);
                                    let muJ = parseFloat(repRowForBin[`${pair.classB}_${e}_mean`]);
                                    let stdI = 0; let stdJ = 0;
                                    let maxI = parseFloat(repRowForBin[`${pair.classA}_${e}_sigma_max`]);
                                    let minI = parseFloat(repRowForBin[`${pair.classA}_${e}_sigma_min`]);
                                    if (!isNaN(maxI) && !isNaN(minI)) stdI = Math.abs(maxI - minI) / 2.0;
                                    let maxJ = parseFloat(repRowForBin[`${pair.classB}_${e}_sigma_max`]);
                                    let minJ = parseFloat(repRowForBin[`${pair.classB}_${e}_sigma_min`]);
                                    if (!isNaN(maxJ) && !isNaN(minJ)) stdJ = Math.abs(maxJ - minJ) / 2.0;

                                    if (isNaN(muI) || isNaN(muJ)) return; 
                                    let varI = stdI * stdI; let varJ = stdJ * stdJ;
                                    let S = 0;
                                    if (varI > 0 || varJ > 0) {
                                        S = Math.abs(muI - muJ) / (varI + varJ + 1e-3);
                                    }
                                    
                                    let localDir = Math.sign(muJ - muI);
                                    if (localDir !== 0 && globalDir !== 0 && localDir !== globalDir) {
                                        S = 0; // Monotonicity enforcement
                                    }

                                     if (isFeno) {
                                         pData.S_bins.push(S);
                                         pData.xVals.push(realXVal);
                                         if (S > pData.maxS) pData.maxS = S;
                                         pData.meanS += S;
                                         if (S > 2.0) pData.countAbove2++;
                                         pData.totalBins++;
                                     }
                               });
                          }
                      }

                      let finalOutput = [];
                      Object.keys(statsMap).forEach(e => {
                          let elData = statsMap[e];
                          let pairMaxes = []; let pairMeans = []; let pairFracs = [];
                          let lowestConcPair = adjacentPairs[0]?.pairName;
                          Object.keys(elData.pairs).forEach(pName => {
                               let p = elData.pairs[pName];
                               if (p.totalBins > 0) {
                                   p.meanS = p.meanS / p.totalBins;
                                   p.fracAbove2 = p.countAbove2 / p.totalBins;
                               }
                               pairMaxes.push(p.maxS || 0); pairMeans.push(p.meanS || 0); pairFracs.push(p.fracAbove2 || 0);
                          });
                          elData.worstPairScore = pairMaxes.length > 0 ? Math.min(...pairMaxes) : 0;
                          elData.avgPairScore = pairMaxes.length > 0 ? (pairMaxes.reduce((sum, v) => sum + v, 0) / pairMaxes.length) : 0;
                          elData.lowConcScore = lowestConcPair && elData.pairs[lowestConcPair] ? elData.pairs[lowestConcPair].maxS : 0;
                          elData.maxSepGlobal = pairMaxes.length > 0 ? Math.max(...pairMaxes) : 0;
                          elData.fracAbove2 = pairFracs.length > 0 ? (pairFracs.reduce((sum, v) => sum + v, 0) / pairFracs.length) : 0;
                          
                          const sampleRow = repFile[0] || {};
                          let baseCol = Object.keys(sampleRow).find(k => 
                                k.toLowerCase() === `${e.toLowerCase()}_baseline` || 
                                k.toLowerCase() === `baseline_${e.toLowerCase()}` || 
                                k.toLowerCase().includes(`${e.toLowerCase()}_r0`)
                          );
                          
                          let directRawCol = Object.keys(sampleRow).find(k => k.toLowerCase().includes(e.toLowerCase()) && k.toLowerCase().includes('_raw') && !k.toLowerCase().startsWith('f'));

                          let r0 = 0;
                          if (directRawCol) {
                              r0 = parseFloat(sampleRow[directRawCol]) || 0;
                          } else if (baseCol) {
                              r0 = parseFloat(sampleRow[baseCol]) || 0;
                          } else {
                              // If no explicit baseline column exists, compute dynamic baseline from events
                              let firstC = availableClasses[0];
                              let baselineRows = repFile.filter(row => {
                                  if (!evCol || !row[evCol]) return false;
                                  const evName = String(row[evCol]).toLowerCase().replace(/\s+/g, '');
                                  return evName.includes('breath') || evName.includes('rfc') || evName.includes('ambient');
                              });
                              if (baselineRows.length > 0) {
                                  let rawKeys = Object.keys(sampleRow).filter(k => 
                                      k.trim().toLowerCase() === e.toLowerCase() || 
                                      k.toLowerCase() === `${firstC.toLowerCase()}_${e.toLowerCase()}_raw` ||
                                      (k.toLowerCase().includes(e.toLowerCase()) && !/(norm|mean|sigma|std|var|snr)/i.test(k) && !k.startsWith('f'))
                                  );
                                  let bestRawKey = rawKeys.find(k => k.trim() === e) || rawKeys.find(k => k.toLowerCase() === `${firstC.toLowerCase()}_${e.toLowerCase()}_raw`) || rawKeys[0];
                                  
                                  let sumR0 = 0; let countR0 = 0;
                                  baselineRows.forEach(row => {
                                      // Prefer exactly identified raw physical channel to secure literal Ohms
                                      let v = bestRawKey ? parseFloat(row[bestRawKey]) : NaN;
                                      if (isNaN(v)) v = parseFloat(row[`${firstC}_${e}_mean`]);
                                      if (!isNaN(v)) { sumR0 += v; countR0++; }
                                  });
                                  r0 = countR0 > 0 ? sumR0 / countR0 : 0;
                              } else {
                                  // Fallback to first row
                                  r0 = parseFloat(sampleRow[e]) || parseFloat(sampleRow[`${firstC}_${e}_mean`]) || 0;
                              }
                          }
                          elData.baselineR = r0;
                          finalOutput.push(elData);
                      });
                      
                      processedResults.push({ fileId: source.fileId, fileName: source.fileName, results: finalOutput, refLines });
                 }
            } else {
                 // RAW UNAGGREGATED TRIAL MODE (Single Combined Result from all sources)
                 const repFile = allDataSources[0]?.data || {};
                 const sampleRow = repFile[0] || {};
                 let existingElements = ALL_ELEMENTS.filter(e => (`normalized_${e}` in sampleRow) || (e in sampleRow));
                 if (existingElements.length === 0) throw new Error("No elements found in raw mode.");

                 const maxRows = Math.max(...allDataSources.map(s => s.data.length));
                 const BINS = Math.min(maxRows, 250); 
                 const binSize = Math.max(1, Math.floor(maxRows / BINS));

                 const statsMap = {};
                 existingElements.forEach(e => {
                     let pMap = {};
                     adjacentPairs.forEach(p => pMap[p.pairName] = { S_bins: [], xVals: [], maxS: 0, meanS: 0, countAbove2: 0, totalBins: 0 });
                     statsMap[e] = { element: e, pairs: pMap };
                 });

                 for (let bin = 0; bin < BINS; bin++) {
                      const startIndex = bin * binSize;
                      const endIndex = startIndex + binSize;
                      
                      for (let e of existingElements) {
                                 const finalKey = (`normalized_${e}` in sampleRow) ? `normalized_${e}` : e;
                                 const classVals = {};
                                 availableClasses.forEach(c => classVals[c] = []);
                                 
                                 let isFenoRaw = false;

                                 for (let source of allDataSources) {
                                      let targetVal;
                                      if (targetColName.trim()) targetVal = source.data[0]?.[targetColName.trim()];
                                      else {
                                          const match = String(source.fileName).match(/(\d+(?:\.\d+)?)\s*(?:ppb|ppm)/i);
                                          if (match) targetVal = match[0].toLowerCase();
                                          else targetVal = String(source.fileName).match(/(\d+(?:\.\d+)?)/)?.[0] || source.fileName;
                                      }
                                      if (targetVal === undefined || targetVal === null) continue;
                                      const groupName = String(targetVal);
                                      if (!(groupName in classVals)) continue;
                                      
                                      let sum = 0; let count = 0;
                                      for(let i = startIndex; i < endIndex && i < source.data.length; i++) {
                                          let row = source.data[i];
                                          // check feno measurement explicitly
                                          if (source.evCol) {
                                               let evStr = String(row[source.evCol] || '').toLowerCase().replace(/\s+/g, '');
                                               if (evStr.includes('fenomeasurement') && !evStr.includes('recovery')) isFenoRaw = true;
                                          } else {
                                               isFenoRaw = true;
                                          }

                                          let v = parseFloat(row[finalKey]);
                                          if (!isNaN(v)) { sum += v; count++; }
                                      }
                                      if (count > 0) classVals[groupName].push(sum/count);
                                 }

                           let firstCVals = classVals[availableClasses[0]];
                           let lastCVals = classVals[availableClasses[availableClasses.length - 1]];
                           let firstMuR = firstCVals.length ? firstCVals.reduce((a,b)=>a+b,0)/firstCVals.length : 0;
                           let lastMuR = lastCVals.length ? lastCVals.reduce((a,b)=>a+b,0)/lastCVals.length : 0;
                           let globalDir = Math.sign(lastMuR - firstMuR);

                           adjacentPairs.forEach(pair => {
                                const res = calcSeparabilityWithEpsilon(classVals[pair.classA], classVals[pair.classB]);
                                let finalS = res.S;
                                let localDir = Math.sign(res.muB - res.muA);
                                if (localDir !== 0 && globalDir !== 0 && localDir !== globalDir) finalS = 0; 
                                
                                let pData = statsMap[e].pairs[pair.pairName];
                                
                                if (isFenoRaw) {
                                    pData.S_bins.push(finalS);
                                    pData.xVals.push(bin * binSize); 
                                    
                                    if (finalS > pData.maxS) pData.maxS = finalS;
                                    pData.meanS += finalS;
                                    if (finalS > 2.0) pData.countAbove2++;
                                    pData.totalBins++;
                                }
                           });
                      }
                 }

                 let finalOutput = [];
                 Object.keys(statsMap).forEach(e => {
                      let elData = statsMap[e];
                      let pairMaxes = []; let pairMeans = []; let pairFracs = [];
                      Object.keys(elData.pairs).forEach(pName => {
                           let p = elData.pairs[pName];
                           if (p.totalBins > 0) {
                               p.meanS = p.meanS / p.totalBins;
                               p.fracAbove2 = p.countAbove2 / p.totalBins;
                           }
                           pairMaxes.push(p.maxS || 0); pairMeans.push(p.meanS || 0); pairFracs.push(p.fracAbove2 || 0);
                      });
                      elData.worstPairScore = pairMaxes.length > 0 ? Math.min(...pairMaxes) : 0;
                      elData.avgPairScore = pairMaxes.length > 0 ? (pairMaxes.reduce((sum, v) => sum + v, 0) / pairMaxes.length) : 0;
                      elData.maxSepGlobal = pairMaxes.length > 0 ? Math.max(...pairMaxes) : 0;
                      elData.fracAbove2 = pairFracs.length > 0 ? (pairFracs.reduce((sum, v) => sum + v, 0) / pairFracs.length) : 0;
                      let sampleRow = allDataSources[0]?.data?.[0] || {};
                      let finalKey = (`normalized_${e}` in sampleRow) ? `normalized_${e}` : e;
                      
                      let baseCol = Object.keys(sampleRow).find(k => 
                          k.toLowerCase() === `${e.toLowerCase()}_baseline` || 
                          k.toLowerCase() === `baseline_${e.toLowerCase()}` || 
                          k.toLowerCase().includes(`${e.toLowerCase()}_r0`)
                      );
                      
                      let r0 = 0;
                      let directRawCol = Object.keys(sampleRow).find(k => k.toLowerCase().includes(e.toLowerCase()) && k.toLowerCase().includes('_raw') && !k.toLowerCase().startsWith('f'));

                      if (directRawCol) {
                          r0 = parseFloat(sampleRow[directRawCol]) || 0;
                          console.log(`Found direct raw col for ${e}: ${directRawCol} -> ${r0}`);
                      } else if (baseCol) {
                          r0 = parseFloat(sampleRow[baseCol]) || 0;
                      } else {
                          // Compute dynamic baseline from 'breath', 'rfc', or 'ambient' events
                          let evColRaw = Object.keys(sampleRow).find(col => {
                               const l = col.toLowerCase();
                               return l === 'event_name' || l === 'phase' || l === 'mode' || l === 'state' || (l.includes('event') && !l.includes('reference'));
                          });
                          
                          let baselineRows = allDataSources[0]?.data?.filter(row => {
                              if (!evColRaw || !row[evColRaw]) return false;
                              const evName = String(row[evColRaw]).toLowerCase().replace(/\s+/g, '');
                              return evName.includes('breath') || evName.includes('rfc') || evName.includes('ambient');
                          }) || [];
                          
                          if (baselineRows.length > 0) {
                               let firstC = availableClasses[0] || '';
                               let rawKeys = Object.keys(sampleRow).filter(k => 
                                   k.trim().toLowerCase() === e.toLowerCase() || 
                                   k.toLowerCase() === `${firstC.toLowerCase()}_${e.toLowerCase()}_raw` ||
                                   (k.toLowerCase().includes(e.toLowerCase()) && !/(norm|mean|sigma|std|var|snr)/i.test(k) && !k.startsWith('f'))
                               );
                               let bestRawKey = rawKeys.find(k => k.trim() === e) || rawKeys.find(k => k.toLowerCase() === `${firstC.toLowerCase()}_${e.toLowerCase()}_raw`) || rawKeys[0];
                               
                               let sumR0 = 0; let countR0 = 0;
                               baselineRows.forEach(row => {
                                   let v = bestRawKey ? parseFloat(row[bestRawKey]) : NaN;
                                   if (isNaN(v)) v = parseFloat(row[finalKey]);
                                   if (isNaN(v)) v = parseFloat(row[e]);
                                   if (!isNaN(v)) { sumR0 += v; countR0++; }
                               });
                               r0 = countR0 > 0 ? sumR0 / countR0 : 0;
                          } else {
                               r0 = parseFloat(sampleRow[e]) || parseFloat(sampleRow[finalKey]) || 0;
                          }
                      }
                      
                      elData.baselineR = r0;
                      finalOutput.push(elData);
                 });
                 processedResults.push({ fileId: 'combined', fileName: 'Combined Separation Map', results: finalOutput, refLines: [] });
            }

            setMultiFileResults(processedResults);
            
            // Auto Select Top element for each generated file array
            const initialSelectionMap = {};
            processedResults.forEach(m => {
                 let sorted = [...m.results];
                 sorted.sort((a,b) => b[sortConfig.key] - a[sortConfig.key]);
                 if(sorted.length > 0) initialSelectionMap[m.fileId] = sorted[0];
            });
            setSelectedElementsMap(initialSelectionMap);
            
            if (processedResults.length > 0) setIsSidebarVisible(false); // Hide sidebar to maximize space for multiple plots

        } catch(err) {
            console.error(err);
            alert("Error computing adjacent separability: " + err.message);
        } finally {
            setIsProcessing(false);
        }
    }, 100);
  };

  const sortedMultiResults = useMemo(() => {
     return multiFileResults.map(mfr => {
          let sorted = [...mfr.results];
          sorted.sort((a, b) => {
              const getDeepVal = (obj, path) => path.split('.').reduce((o, p) => (o ? o[p] : undefined), obj);
              let valA = getDeepVal(a, sortConfig.key);
              let valB = getDeepVal(b, sortConfig.key);
              if (valA === undefined) valA = 0;
              if (valB === undefined) valB = 0;
              if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
              if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
              return 0;
          });
          return { ...mfr, sortedResults: sorted };
     });
  }, [multiFileResults, sortConfig]);

  const requestSort = (key) => {
      let direction = 'desc';
      if (sortConfig.key === key && sortConfig.direction === 'desc') direction = 'asc';
      setSortConfig({ key, direction });
  };
  
  const renderSortIndicator = (key) => {
      if (sortConfig.key !== key) return null;
      return sortConfig.direction === 'asc' ? ' ↑' : ' ↓';
  };

  const handleGlobalElementSelect = (targetElementId) => {
      let newMap = {};
      multiFileResults.forEach(mfr => {
          const match = mfr.results.find(r => r.element === targetElementId);
          if (match) {
              newMap[mfr.fileId] = match;
          } else {
              newMap[mfr.fileId] = selectedElementsMap[mfr.fileId] || null;
          }
      });
      setSelectedElementsMap(newMap);
  };

  const generateChartData = (mfr) => {
      const selected = selectedElementsMap[mfr.fileId];
      if (!selected) return [];
      let arr = [];
      const firstPair = adjacentPairs[0]?.pairName;
      if (!firstPair || !selected.pairs[firstPair]) return [];
      
      const binsLen = selected.pairs[firstPair].xVals.length;
      for(let i=0; i < binsLen; i++) {
          let row = { timeBin: selected.pairs[firstPair].xVals[i] };
          adjacentPairs.forEach(p => {
              if(selected.pairs[p.pairName].S_bins[i] !== undefined) {
                  row[`${p.pairName}_S`] = selected.pairs[p.pairName].S_bins[i];
              }
          });
          arr.push(row);
      }
      return arr;
  };

  return (
    <div className="separability-page-container fade-in" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="separability-header glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div className="icon-wrapper" style={{ background: 'rgba(56, 189, 248, 0.15)', padding: '10px', borderRadius: '10px' }}>
            <Layers size={24} color="#38bdf8" strokeWidth={2.5}/>
          </div>
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#f8fafc', marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '8px' }}>
               Automatic Separability Module
            </h2>
            <p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: 0 }}>
              Generates universal element robustness benchmarks. Seamlessly ingests either raw trials or pre-compiled ALAAC Summary matrices automatically.
            </p>
          </div>
        </div>
        <button 
             className="styled-button secondary-action" 
             onClick={() => setIsSidebarVisible(!isSidebarVisible)}
             style={{ padding: '6px 12px', opacity: 0.8 }}
        >
             {isSidebarVisible ? <><PanelLeftClose size={16}/> Hide Tools</> : <><PanelLeftOpen size={16}/> Show Tools</>}
        </button>
      </div>

      <div className="content-layout" style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <div 
            className="control-sidebar glass-panel" 
            style={{ 
                flex: isSidebarVisible ? '0 0 340px' : '0 0 0px', 
                opacity: isSidebarVisible ? 1 : 0,
                overflowY: isSidebarVisible ? 'auto' : 'hidden', 
                overflowX: 'hidden',
                transition: 'all 0.4s cubic-bezier(0.33, 1, 0.68, 1)',
                padding: isSidebarVisible ? '16px' : '16px 0',
                borderWidth: isSidebarVisible ? '1px' : '0'
            }}>
            <div style={{ width: 340 - 32, opacity: isSidebarVisible ? 1 : 0, transition: 'opacity 0.2s', visibility: isSidebarVisible ? 'visible' : 'hidden' }}>
              <div className="dataset-card" style={{ marginBottom: '16px' }}>
                 <h4 style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '8px', textTransform:'uppercase' }}>Matrix Import Mode</h4>
                 
                 {isAlaacMode ? (
                     <div style={{ fontSize: '0.75rem', color: '#f59e0b', fontWeight: 600, background: 'rgba(245,158,11,0.1)', padding: '8px', borderRadius: '4px', border: '1px solid rgba(245,158,11,0.2)' }}>
                         ⚡ {allDataSources.length} ALAAC Summaries Detected!<br/>
                         <span style={{ fontWeight: 400, color: '#fcd34d' }}>Computing {allDataSources.length > 1 ? 'side-by-side matrices' : 'composite limits'} across {availableClasses.length} targets.</span>
                     </div>
                 ) : (
                     <div style={{ fontSize: '0.75rem', color: '#38bdf8', fontWeight: 500, background: 'rgba(56,189,248,0.1)', padding: '8px', borderRadius: '4px' }}>
                         Raw Matrix Extraction<br /><span style={{ fontWeight: 400, color: '#bae6fd' }}>Computing distributions natively.</span>
                     </div>
                 )}

                 {availableClasses.length > 0 && (
                     <div style={{ fontSize: '0.75rem', color: '#cbd5e1', marginTop: '12px' }}>
                         Detected Sequence: <span style={{color: '#f8fafc', fontWeight: 600}}>{availableClasses.join(' ➔ ')}</span>
                     </div>
                 )}
              </div>
              
              {!isAlaacMode && (
                  <div className="control-group">
                    <label className="control-label text-sm uppercase text-slate-400 font-semibold tracking-wider">Target Matcher</label>
                    <p className="text-xs text-slate-500 mb-2 mt-1">Leave blank to auto-detect num bounds.</p>
                    <input 
                      type="text" 
                      className="styled-input" 
                      placeholder="Blank = Auto Detect"
                      value={targetColName}
                      onChange={(e) => setTargetColName(e.target.value)}
                    />
                  </div>
              )}

              <button 
                className="styled-button primary-action hover-glow" 
                style={{ marginTop: 'auto', background: 'var(--accent-primary)', width: '100%' }}
                onClick={handleCompute}
                disabled={isProcessing || adjacentPairs.length === 0}
              >
                {isProcessing ? 'Isolating Variables...' : (
                  <>
                    <Play size={16} /> Scan Element Matrix S(t)
                  </>
                )}
              </button>
            </div>
        </div>

        <div className="plot-main glass-panel" style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', padding: 0 }}>
            {sortedMultiResults.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b' }}>
                     <BarChart2 size={48} opacity={0.3} style={{ marginBottom: '16px' }} />
                     <p>Generate precise stability rankings across {adjacentPairs.length} adjacent configurations simultaneously.</p>
                     {allDataSources.length > 1 && isAlaacMode && <p style={{color: '#fcd34d'}}>Ready to spawn side-by-side matrices for {allDataSources.length} files!</p>}
                </div>
            ) : (
                <div style={{ display: 'flex', minHeight: '100%', gap: '20px', padding: '16px', boxSizing: 'border-box', overflowX: 'auto', overflowY: 'visible' }}>
                    {sortedMultiResults.map(mfr => (
                        <div key={mfr.fileId} style={{ flex: '1 1 500px', minWidth: '450px', background: 'rgba(0,0,0,0.1)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px', display: 'flex', flexDirection: 'column' }}>
                            
                            <div style={{ padding: '16px 16px 8px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                <h3 style={{ margin:'0 0 4px 0', fontSize: '1rem', color:'#38bdf8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {mfr.fileName}
                                </h3>
                                <p style={{ fontSize: '0.70rem', color: '#94a3b8', margin: 0 }}>
                                    Click headers to sort. Click a row to universally cross-select element.
                                </p>
                            </div>

                            <div style={{ flex: 1, minHeight: '350px', overflowY: 'auto', padding: '0 16px' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.75rem', marginTop: '12px' }}>
                                    <thead>
                                        <tr style={{ position: 'sticky', top: 0, background: '#1e293b', zIndex: 10, color: '#cbd5e1', textTransform: 'uppercase', fontSize: '0.65rem' }}>
                                             <th style={{ padding: '8px 10px' }}>Element</th>
                                             <th onClick={() => requestSort('avgPairScore')} style={{ padding: '8px 10px', cursor: 'pointer', transition: 'color 0.2s', color: sortConfig.key === 'avgPairScore' ? '#f8fafc' : '#cbd5e1' }}>Avg S{renderSortIndicator('avgPairScore')}</th>
                                             <th onClick={() => requestSort('worstPairScore')} style={{ padding: '8px 10px', cursor: 'pointer', transition: 'color 0.2s', color: sortConfig.key === 'worstPairScore' ? '#f8fafc' : '#cbd5e1' }}>Worst Pair{renderSortIndicator('worstPairScore')}</th>
                                             {adjacentPairs.map(p => {
                                                 const sortKey = `pairs.${p.pairName}.meanS`;
                                                 const shortName = p.pairName.replace(/(\s*pp[mb]\s*)/gi, '').replace(' vs ', 'v');
                                                 return (
                                                     <th 
                                                         key={p.pairName} 
                                                         onClick={() => requestSort(sortKey)} 
                                                         style={{ padding: '8px 8px', cursor: 'pointer', transition: 'color 0.2s', color: sortConfig.key === sortKey ? '#f8fafc' : '#64748b', whiteSpace: 'nowrap' }}
                                                         title={p.pairName}
                                                     >
                                                         {shortName}{renderSortIndicator(sortKey)}
                                                     </th>
                                                 );
                                             })}
                                             <th onClick={() => requestSort('fracAbove2')} style={{ padding: '8px 8px', cursor: 'pointer', transition: 'color 0.2s', color: sortConfig.key === 'fracAbove2' ? '#f8fafc' : '#cbd5e1', whiteSpace: 'nowrap' }}>Stab. %{renderSortIndicator('fracAbove2')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {mfr.sortedResults.map((el, i) => {
                                            const isSelected = selectedElementsMap[mfr.fileId]?.element === el.element;
                                            return (
                                              <tr 
                                                  key={el.element} 
                                                  style={{ borderTop: `1px solid rgba(255,255,255,0.05)`, cursor: 'pointer', background: isSelected ? 'rgba(56, 189, 248, 0.15)' : 'transparent', transition: 'background 0.2s' }}
                                                  onClick={() => handleGlobalElementSelect(el.element)}
                                              >
                                                  <td style={{ padding: '6px 10px', fontWeight: 600, color: i === 0 ? '#fbbf24' : '#38bdf8' }}>#{i+1} — {el.element}</td>
                                                  <td style={{ padding: '6px 10px', color: '#cbd5e1' }}>{el.avgPairScore.toFixed(2)}</td>
                                                  <td style={{ padding: '6px 10px', color: '#f8fafc' }}>{el.worstPairScore.toFixed(2)}</td>
                                                  {adjacentPairs.map(p => (
                                                      <td key={p.pairName} style={{ padding: '6px 10px', color: '#94a3b8' }}>{el.pairs[p.pairName]?.meanS != null ? el.pairs[p.pairName].meanS.toFixed(2) : '0.00'}</td>
                                                  ))}
                                                  <td style={{ padding: '6px 10px', color: '#10b981' }}>{(el.fracAbove2 * 100).toFixed(0)}%</td>
                                              </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>

                            {selectedElementsMap[mfr.fileId] && (
                                <div style={{ height: '320px', flex: 'none', borderTop: '1px solid rgba(255,255,255,0.05)', padding: '16px 16px 24px 16px', background: 'rgba(0,0,0,0.2)' }}>
                                    <h4 style={{ margin: '0 0 12px 0', fontSize: '0.8rem', color: '#e2e8f0' }}>{selectedElementsMap[mfr.fileId].element} Separability Trace</h4>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <ComposedChart data={generateChartData(mfr)} margin={{ top: 0, right: 10, left: -20, bottom: 20 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                                            <XAxis dataKey="timeBin" stroke="#64748b" fontSize={10} tickFormatter={(val) => Math.floor(val)} label={{ value: 'Time Index (ticks)', position: 'bottom', offset: 0, fill: '#94a3b8', fontSize: 10 }} />
                                            <YAxis stroke="#64748b" fontSize={10} domain={[0, 'auto']} label={{ value: 'Separability Score (S)', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 10, offset: 10 }} />
                                            <RechartsTooltip contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)' }} itemStyle={{ fontSize: '0.75rem' }} />
                                            <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '5px' }} />
                                            
                                            {mfr.refLines?.map((rl, rIdx) => (
                                                <ReferenceLine key={`ref-${rIdx}`} x={rl.x} stroke={rl.stroke} strokeDasharray="3 3" strokeOpacity={0.5} label={{ position: 'insideTopLeft', value: rl.label, fill: rl.stroke, fontSize: 8 }} />
                                            ))}
            
                                            {adjacentPairs.map((p, idx) => (
                                                <Line key={p.pairName} name={p.pairName} type="monotone" dataKey={`${p.pairName}_S`} stroke={COLORS[idx % COLORS.length]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                                            ))}
                                        </ComposedChart>
                                    </ResponsiveContainer>
                                </div>
                            )}

                            <div style={{ height: '400px', flex: 'none', borderTop: '1px solid rgba(255,255,255,0.05)', padding: '16px 16px 32px 16px', background: 'rgba(0,0,0,0.2)' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                                    <h4 style={{ margin: 0, fontSize: '0.8rem', color: '#e2e8f0' }}>Baseline Resistance (R0) vs Stability Correlation</h4>
                                    <span style={{ fontSize: '0.65rem', color: '#64748b', fontStyle: 'italic' }}>
                                        Scroll to zoom &middot; Drag to pan
                                    </span>
                                </div>
                                <ZoomableScatterPlot data={mfr.sortedResults} />
                            </div>

                        </div>
                    ))}
                </div>
            )}
        </div>
      </div>
    </div>
  );
};

export default SeparabilityAnalysisPage;
