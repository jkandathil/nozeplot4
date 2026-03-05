import React, { useState } from 'react';
import { Handle, Position } from '@xyflow/react';

const Tooltip = ({ show, children, x, y }) => {
    if (!show) return null;
    return (
        <div style={{
            position: 'absolute',
            top: y,
            left: x,
            transform: 'translate(-50%, -100%)',
            marginTop: '-10px',
            background: 'rgba(15, 23, 42, 0.85)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '8px',
            padding: '12px',
            color: '#fff',
            zIndex: 1000,
            pointerEvents: 'none',
            minWidth: '150px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
            fontSize: '0.8rem',
            textAlign: 'left'
        }}>
            {children}
        </div>
    );
};

const IconNodeWrapper = ({ title, imgSrc, selected, color, tooltipContent }) => {
    const [hover, setHover] = useState(false);
    return (
        <div
            className={`custom-node icon-only ${selected ? 'selected' : ''}`}
            style={{
                borderColor: color,
                width: '64px',
                height: '64px',
                boxSizing: 'border-box',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(15, 23, 42, 0.5)',
                border: `0.5px solid ${color}88`,
                boxShadow: selected ? `0 0 0 1px ${color}` : `0 4px 12px rgba(0,0,0,0.3)`,
                backdropFilter: 'blur(4px)',
                cursor: 'pointer',
                position: 'relative',
                overflow: 'visible'
            }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
        >
            <img src={imgSrc} alt={title} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            <div style={{ position: 'absolute', bottom: '-24px', fontSize: '0.7rem', color: '#f8fafc', fontWeight: 600, whiteSpace: 'nowrap', textShadow: '0 1px 3px rgba(0,0,0,0.8)', background: 'rgba(15, 23, 42, 0.6)', padding: '2px 6px', borderRadius: '4px', border: `1px solid ${color}44` }}>
                {title}
            </div>
            <Tooltip show={hover} x={32} y={-5}>
                <div style={{ borderBottom: `1px solid ${color}44`, paddingBottom: 4, marginBottom: 8, fontWeight: 700, color }}>{title}</div>
                {tooltipContent}
            </Tooltip>
        </div>
    );
};

export const CylinderNode = ({ data, selected }) => {
    const conc = data.concValue ? `${data.concValue} ${data.concUnit}` : 'N/A';
    const tooltip = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div><span style={{ color: '#94a3b8' }}>Gas:</span> {data.gasName || 'None'}</div>
            <div><span style={{ color: '#94a3b8' }}>Carrier:</span> {data.carrier || 'Air'}</div>
            <div><span style={{ color: '#94a3b8' }}>Conc:</span> {conc}</div>
            <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 4 }}>Double-click to edit</div>
        </div>
    );
    return (
        <>
            <IconNodeWrapper title="Gas Cylinder" imgSrc={`${import.meta.env.BASE_URL}gas_icons/cylinder.svg?v=2`} selected={selected} color="#3b82f6" tooltipContent={tooltip} />
            <Handle type="source" position={Position.Right} />
        </>
    );
};

export const MFCNode = ({ data, selected }) => {
    const max = data.maxFlow || 1000;
    const set = data.setpoint || 0;
    const isUnderRange = set > 0 && set < (max * 0.02);
    const isOverRange = set > max;

    const tooltip = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div><span style={{ color: '#94a3b8' }}>Max Flow:</span> {max} sccm</div>
            <div><span style={{ color: '#94a3b8' }}>Set Flow:</span> {set} sccm</div>

            {isUnderRange && <div style={{ color: '#ef4444', marginTop: 4 }}>Error: Below 2% of Max Flow</div>}
            {isOverRange && <div style={{ color: '#ef4444', marginTop: 4 }}>Error: Exceeds Max Flow</div>}

            {data.flowOut && data.flowOut.flow !== null && (
                <div style={{ color: '#10b981', marginTop: 4 }}>Output: {data.flowOut.flow.toFixed(2)} sccm</div>
            )}
            <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 4 }}>Double-click to edit</div>
        </div>
    );
    return (
        <>
            <Handle type="target" position={Position.Left} />
            <IconNodeWrapper
                title="MFC Controller"
                imgSrc={`${import.meta.env.BASE_URL}gas_icons/mfc.svg?v=2`}
                selected={selected}
                color={isUnderRange || isOverRange ? '#ef4444' : '#10b981'}
                tooltipContent={tooltip}
            />
            <Handle type="source" position={Position.Right} />
        </>
    );
};

export const MixerNode = ({ data, selected }) => {
    const tooltip = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {data.flowOut && data.flowOut.flow > 0 ? (
                <div style={{ color: '#f59e0b' }}>Mix Flow: {data.flowOut.flow.toFixed(2)} sccm</div>
            ) : (
                <div style={{ color: '#94a3b8' }}>No Flow</div>
            )}
        </div>
    );
    return (
        <>
            <Handle type="target" position={Position.Left} id="in" />
            <IconNodeWrapper title="Gas Mixer" imgSrc={`${import.meta.env.BASE_URL}gas_icons/mixer.svg?v=2`} selected={selected} color="#f59e0b" tooltipContent={tooltip} />
            <Handle type="source" position={Position.Right} id="out" />
        </>
    );
};

export const HumidifierNode = ({ data, selected }) => {
    const tooltip = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div><span style={{ color: '#94a3b8' }}>Water Temp:</span> {data.temperature !== undefined ? `${data.temperature} °C` : '25 °C'}</div>
            {data.flowOut && data.flowOut.flow > 0 ? (
                <div style={{ color: '#0ea5e9', marginTop: 4 }}>Wet Flow: {data.flowOut.flow.toFixed(2)} sccm</div>
            ) : (
                <div style={{ color: '#94a3b8' }}>No Flow</div>
            )}
            <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 4 }}>Double-click to edit</div>
        </div>
    );
    return (
        <>
            <Handle type="target" position={Position.Left} />
            <IconNodeWrapper title="Humidifier" imgSrc={`${import.meta.env.BASE_URL}gas_icons/humidifier.svg?v=2`} selected={selected} color="#0ea5e9" tooltipContent={tooltip} />
            <Handle type="source" position={Position.Right} />
        </>
    );
};

export const VOCBubblerNode = ({ data, selected }) => {
    const chemical = data.chemical || 'Ethanol';
    const tooltip = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div><span style={{ color: '#94a3b8' }}>Chemical:</span> {chemical}</div>
            <div><span style={{ color: '#94a3b8' }}>Liquid Temp:</span> {data.temperature !== undefined ? `${data.temperature} °C` : '25 °C'}</div>
            {data.flowOut && data.flowOut.flow > 0 ? (
                <div style={{ color: '#f43f5e', marginTop: 4 }}>Vapor Flow: {data.flowOut.flow.toFixed(2)} sccm</div>
            ) : (
                <div style={{ color: '#94a3b8' }}>No Flow</div>
            )}
            <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 4 }}>Double-click to edit</div>
        </div>
    );
    return (
        <>
            <Handle type="target" position={Position.Left} />
            <IconNodeWrapper title="VOC Bubbler" imgSrc={`${import.meta.env.BASE_URL}gas_icons/humidifier.svg?v=2`} selected={selected} color="#f43f5e" tooltipContent={tooltip} />
            <Handle type="source" position={Position.Right} />
        </>
    );
};

export const PermeationOvenNode = ({ data, selected }) => {
    const chemical = data.chemical || 'H2S';
    const emissionRate = data.emissionRate || 1000;
    const tooltip = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div><span style={{ color: '#94a3b8' }}>Chemical:</span> {chemical}</div>
            <div><span style={{ color: '#94a3b8' }}>Emission:</span> {emissionRate} ng/min</div>
            {data.flowOut && data.flowOut.flow > 0 && data.flowOut.components[chemical] ? (
                <div style={{ color: '#d946ef', marginTop: 4 }}>Conc Output: {(data.flowOut.components[chemical] * 1e6).toFixed(2)} ppm</div>
            ) : (
                <div style={{ color: '#94a3b8' }}>No Flow</div>
            )}
            <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 4 }}>Double-click to edit</div>
        </div>
    );
    return (
        <>
            <Handle type="target" position={Position.Left} />
            <IconNodeWrapper title="Permeation Oven" imgSrc={`${import.meta.env.BASE_URL}gas_icons/combiner.svg?v=2`} selected={selected} color="#d946ef" tooltipContent={tooltip} />
            <Handle type="source" position={Position.Right} />
        </>
    );
};

export const YSplitterNode = ({ data, selected }) => {
    const tooltip = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: 4 }}>Splits input flow 50/50</div>
            {data.flowOut && data.flowOut.flow > 0 ? (
                <div style={{ color: '#a855f7' }}>Output (Each): {(data.flowOut.flow).toFixed(2)} sccm</div>
            ) : (
                <div style={{ color: '#94a3b8' }}>No Flow</div>
            )}
        </div>
    );
    return (
        <>
            <Handle type="target" position={Position.Left} />
            <IconNodeWrapper title="Y-Splitter" imgSrc={`${import.meta.env.BASE_URL}gas_icons/y_splitter.svg?v=2`} selected={selected} color="#a855f7" tooltipContent={tooltip} />
            <Handle type="source" position={Position.Top} id="out1" />
            <Handle type="source" position={Position.Bottom} id="out2" />
        </>
    );
};

export const OutputNode = ({ data, selected }) => {
    let rh = 0;
    let comps = [];
    let totalFlow = 0;

    if (data.flowOut && data.flowOut.flow > 0) {
        totalFlow = data.flowOut.flow;
        for (let g in data.flowOut.components) {
            let frac = data.flowOut.components[g];
            if (g === 'H2O') {
                const temp = 25;
                const vaporPressure = Math.pow(10, 8.07131 - (1730.63 / (233.426 + temp)));
                const satPartial = Math.max(0.0001, vaporPressure / 760);
                rh = (frac / satPartial) * 100;
            } else if (g && g.toUpperCase() !== 'AIR' && g.toUpperCase() !== 'N2') {
                if (data.targetConcUnit === 'ppb') {
                    comps.push(`${g}: ${(frac * 1e9).toFixed(2)} ppb`);
                } else if (data.targetConcUnit === 'ppm') {
                    comps.push(`${g}: ${(frac * 1e6).toFixed(2)} ppm`);
                } else if (data.targetConcUnit === '%') {
                    comps.push(`${g}: ${(frac * 100).toFixed(2)} %`);
                } else {
                    if (frac < 1e-4) {
                        comps.push(`${g}: ${(frac * 1e9).toFixed(2)} ppb`);
                    } else if (frac < 1e-1) {
                        comps.push(`${g}: ${(frac * 1e6).toFixed(2)} ppm`);
                    } else {
                        comps.push(`${g}: ${(frac * 100).toFixed(2)} %`);
                    }
                }
            }
        }
    }

    return (
        <div
            className={`custom-node ${selected ? 'selected' : ''}`}
            style={{
                width: 200,
                minHeight: 80,
                background: 'rgba(15, 23, 42, 0.9)',
                border: `1px solid ${selected ? '#ec4899' : 'rgba(236, 72, 153, 0.4)'}`,
                borderRadius: '8px',
                boxShadow: selected ? '0 0 0 1px #ec4899' : '0 4px 12px rgba(0,0,0,0.5)',
                backdropFilter: 'blur(12px)',
                display: 'flex',
                flexDirection: 'column',
                color: '#f8fafc',
                fontSize: '0.8rem',
                fontFamily: 'Inter, sans-serif'
            }}
        >
            <Handle type="target" position={Position.Left} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderBottom: '1px solid rgba(236, 72, 153, 0.2)', backgroundColor: 'rgba(236, 72, 153, 0.05)', borderTopLeftRadius: '8px', borderTopRightRadius: '8px' }}>
                <img src={`${import.meta.env.BASE_URL}gas_icons/output.svg?v=4`} style={{ width: 22, height: 22 }} alt="" />
                <span style={{ fontWeight: 600, color: '#ec4899' }}>Output</span>
            </div>
            <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>Total Flow</span>
                    <strong style={{ color: '#f8fafc', fontWeight: 600 }}>{totalFlow.toFixed(2)} sccm</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>Humidity (25°C)</span>
                    <strong style={{ color: '#38bdf8', fontWeight: 600 }}>{Math.min(rh, 100).toFixed(1)}% RH</strong>
                </div>
                {comps.length > 0 ? comps.map((c, i) => {
                    const [n, v] = c.split(':');
                    return (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>{n}</span>
                            <strong style={{ color: '#fcd34d', fontWeight: 600 }}>{v}</strong>
                        </div>
                    );
                }) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>Dopant</span>
                        <strong style={{ color: '#64748b', fontWeight: 600 }}>None</strong>
                    </div>
                )}
                <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 4, textAlign: 'center', fontWeight: 500 }}>Double-click to Auto-Configure</div>
            </div>
        </div>
    );
};

export const CombinerNode = ({ id, data, selected }) => {
    const ports = data.ports || 2;
    const tooltip = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ color: '#94a3b8', fontSize: '0.75rem', marginBottom: 4 }}>Combines {ports} inputs</div>
            {data.flowOut && data.flowOut.flow > 0 ? (
                <div style={{ color: '#f59e0b' }}>Mix Flow: {data.flowOut.flow.toFixed(2)} sccm</div>
            ) : (
                <div style={{ color: '#94a3b8' }}>No Flow</div>
            )}
            <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 4 }}>Double-click to set ports</div>
        </div>
    );
    return (
        <>
            {Array.from({ length: ports }).map((_, i) => (
                <Handle
                    key={i}
                    type="target"
                    id={`in-${i}`}
                    position={Position.Left}
                    // Calculate percentage along the left edge. We inset it slightly so first and last aren't exactly on the corner.
                    style={{ top: `${((i + 1) * 100) / (ports + 1)}%` }}
                />
            ))}
            <IconNodeWrapper title="Gas Combiner" imgSrc={`${import.meta.env.BASE_URL}gas_icons/combiner.svg?v=2`} selected={selected} color="#f59e0b" tooltipContent={tooltip} />
            <Handle type="source" position={Position.Right} id="out" />
        </>
    );
};
