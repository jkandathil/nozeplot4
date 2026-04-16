import React, { useMemo } from 'react';

const MiniGridChart = ({ data, mainKey, compareNodes, colors, compareColors, index }) => {
    // Virtual coordinates for the SVG
    // By using viewBox and preserveAspectRatio="none", the browser stretches the SVG using the GPU natively,
    // completely eliminating the need for ResizeObserver or React-based width/height calculations.
    const V_WIDTH = 1000;
    const V_HEIGHT = 500;
    
    // Calculate global bounds for this specific chart
    const { min, max } = useMemo(() => {
        let minVal = Infinity;
        let maxVal = -Infinity;

        if (!data || data.length === 0) return { min: 0, max: 100 };

        data.forEach(row => {
            const vals = [row[mainKey]];
            if (compareNodes && compareNodes.length > 0) {
                compareNodes.forEach(c => vals.push(row[c.key]));
            }

            vals.forEach(val => {
                if (val !== undefined && val !== null && !isNaN(val)) {
                    if (val < minVal) minVal = val;
                    if (val > maxVal) maxVal = val;
                }
            });
        });

        if (minVal === Infinity) return { min: 0, max: 100 };
        
        const range = maxVal - minVal;
        const pad = range > 0 ? range * 0.1 : (Math.abs(maxVal) * 0.1 || 1);
        return { min: minVal - pad, max: maxVal + pad };
    }, [data, mainKey, compareNodes]);

    // Build SVG paths for Main Series + Comparisons
    const { mainPath, comparePaths } = useMemo(() => {
        if (!data || data.length === 0) return { mainPath: "", comparePaths: [] };

        const rangeY = max - min;
        const numPoints = data.length;

        // Function to map a data index/value to SVG coordinates
        const mapPoint = (val, i) => {
            const x = (i / Math.max(1, numPoints - 1)) * V_WIDTH;
            const y = V_HEIGHT - (((val - min) / rangeY) * V_HEIGHT);
            return { x, y };
        };

        // Build main line
        let mainD = "";
        let isFirst = true;
        data.forEach((row, i) => {
            const val = row[mainKey];
            if (val !== undefined && val !== null && !isNaN(val)) {
                const { x, y } = mapPoint(val, i);
                if (isFirst) {
                    mainD += `M ${x.toFixed(1)} ${y.toFixed(1)} `;
                    isFirst = false;
                } else {
                    mainD += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
                }
            }
        });

        // Build compare lines
        const cPaths = (compareNodes || []).map(comp => {
            let d = "";
            let cIsFirst = true;
            data.forEach((row, i) => {
                const val = row[comp.key];
                if (val !== undefined && val !== null && !isNaN(val)) {
                    const { x, y } = mapPoint(val, i);
                    if (cIsFirst) {
                        d += `M ${x.toFixed(1)} ${y.toFixed(1)} `;
                        cIsFirst = false;
                    } else {
                        d += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
                    }
                }
            });
            return d;
        });

        return { mainPath: mainD, comparePaths: cPaths };
    }, [data, mainKey, compareNodes, min, max]);

    const mainColor = colors[index % colors.length];

    return (
        <svg 
            width="100%" 
            height="100%" 
            viewBox={`0 0 ${V_WIDTH} ${V_HEIGHT}`} 
            preserveAspectRatio="none"
            style={{ display: 'block' }}
        >
            {/* Draw Compare Lines first so Main sits on top */}
            {comparePaths.map((d, i) => {
                const comp = compareNodes[i];
                const color = compareColors[comp.colorIndex % compareColors.length];
                return (
                    <path 
                        key={comp.key} 
                        d={d} 
                        fill="none" 
                        stroke={color} 
                        strokeWidth="10" 
                        strokeOpacity="0.8" 
                        vectorEffect="non-scaling-stroke"
                        strokeLinejoin="round"
                    />
                );
            })}

            {/* Draw Main Line */}
            {mainPath && (
                <path 
                    d={mainPath} 
                    fill="none" 
                    stroke={mainColor} 
                    strokeWidth="14" 
                    vectorEffect="non-scaling-stroke"
                    strokeLinejoin="round"
                />
            )}
            
            {/* Minimal Y-axis / X-axis reference lines */}
            <line x1="0" y1={V_HEIGHT} x2={V_WIDTH} y2={V_HEIGHT} stroke="#64748b" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            <line x1="0" y1="0" x2="0" y2={V_HEIGHT} stroke="#94a3b8" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
    );
};

export default MiniGridChart;
