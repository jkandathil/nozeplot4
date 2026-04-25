import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Home, MousePointer2, MapPin, GitBranch, CircleDot, Download, Trash2,
    Layers, AlertTriangle
} from 'lucide-react';
import { emptyPcbDoc, newId, applyBridgePayload, COPPER_LAYERS } from '../pcb/pcbDoc.js';
import { PCB_BRIDGE_KEY } from '../pcb/schematicBridge.js';
import { getFootprint, listFootprintSummaries } from '../pcb/footprintLib.js';
import { buildPcbFabricationZip, triggerBlobDownload } from '../pcb/gerberZip.js';
import { runDRC } from '../pcb/pcbDrc.js';
import './PcbStudioPage.css';

const PCB_STORAGE_KEY = 'nozePcbDoc:v1';
const GRID_MM = 0.5;

function snapMm(v) {
    return Math.round(v / GRID_MM) * GRID_MM;
}

function rotLocal(x, y, deg) {
    const r = ((Number(deg) || 0) * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [x * c - y * s, x * s + y * c];
}

function padWorld(pl, pad) {
    const [lx, ly] = rotLocal(pad.x, pad.y, pl.rot || 0);
    return [lx + pl.x, ly + pl.y];
}

function clientToSvgMm(svgEl, clientX, clientY) {
    if (!svgEl) return [0, 0];
    const pt = svgEl.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return [0, 0];
    const p = pt.matrixTransform(ctm.inverse());
    return [p.x, p.y];
}

function footprintBBox(pl) {
    const fp = getFootprint(pl.footprintId);
    if (!fp?.pads?.length) {
        return { minX: pl.x - 2, maxX: pl.x + 2, minY: pl.y - 2, maxY: pl.y + 2 };
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const pad of fp.pads) {
        const [x, y] = padWorld(pl, pad);
        minX = Math.min(minX, x - pad.w / 2);
        maxX = Math.max(maxX, x + pad.w / 2);
        minY = Math.min(minY, y - pad.h / 2);
        maxY = Math.max(maxY, y + pad.h / 2);
    }
    return { minX, maxX, minY, maxY };
}

function PcbStudioPage({ onBackToSchematic }) {
    const [doc, setDoc] = useState(() => emptyPcbDoc());
    const [tool, setTool] = useState('select');
    const [activeLayer, setActiveLayer] = useState('F.Cu');
    const [placeFootprintId, setPlaceFootprintId] = useState('R_0805');
    const [selection, setSelection] = useState(null);
    const [routeDraft, setRouteDraft] = useState(null);
    const [drag, setDrag] = useState(null);
    const [exportBusy, setExportBusy] = useState(false);
    const [drcViolations, setDrcViolations] = useState([]);
    const svgRef = useRef(null);
    const fpSummaries = useMemo(() => listFootprintSummaries(), []);

    const handleRunDRC = useCallback(() => {
        const v = runDRC(doc, getFootprint);
        setDrcViolations(v);
        if (v.length === 0) {
            window.alert('DRC Passed! No clearance violations found.');
        }
    }, [doc]);

    useEffect(() => {
        let base = emptyPcbDoc();
        let hadBridge = false;
        try {
            const raw = sessionStorage.getItem(PCB_BRIDGE_KEY);
            if (raw) {
                const bridge = JSON.parse(raw);
                base = applyBridgePayload(emptyPcbDoc(), bridge);
                hadBridge = true;
                sessionStorage.removeItem(PCB_BRIDGE_KEY);
            }
        } catch {
            /* ignore */
        }
        if (!hadBridge) {
            try {
                const saved = localStorage.getItem(PCB_STORAGE_KEY);
                if (saved) base = JSON.parse(saved);
            } catch {
                /* ignore */
            }
        }
        setDoc(base);
    }, []);

    useEffect(() => {
        setDrcViolations([]);
        const t = setTimeout(() => {
            try {
                localStorage.setItem(PCB_STORAGE_KEY, JSON.stringify(doc));
            } catch {
                /* quota */
            }
        }, 400);
        return () => clearTimeout(t);
    }, [doc]);

    const W = Number(doc.meta?.boardWmm) || 80;
    const H = Number(doc.meta?.boardHmm) || 50;

    const padCentersByNet = useMemo(() => {
        const map = new Map();
        for (const pl of doc.placements || []) {
            const fp = getFootprint(pl.footprintId);
            if (!fp) continue;
            const nets = pl.padNets || {};
            for (const pad of fp.pads || []) {
                const net = nets[pad.num] || nets[pad.id];
                if (!net || net === '0') continue;
                const [x, y] = padWorld(pl, pad);
                if (!map.has(net)) map.set(net, []);
                map.get(net).push([x, y]);
            }
        }
        return map;
    }, [doc.placements]);

    const handleExportZip = useCallback(async () => {
        setExportBusy(true);
        try {
            const blob = await buildPcbFabricationZip(doc, doc.meta?.name || 'pcb');
            triggerBlobDownload(blob, `${(doc.meta?.name || 'pcb').replace(/[^\w\-]+/g, '_')}_gerber.zip`);
        } catch (e) {
            window.alert(e?.message || String(e));
        } finally {
            setExportBusy(false);
        }
    }, [doc]);

    const pickPlacementAt = useCallback(
        (x, y) => {
            for (let i = (doc.placements || []).length - 1; i >= 0; i--) {
                const pl = doc.placements[i];
                const b = footprintBBox(pl);
                if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return pl;
            }
            return null;
        },
        [doc.placements],
    );

    const onSvgDown = useCallback(
        (ev) => {
            const [mx, my] = clientToSvgMm(svgRef.current, ev.clientX, ev.clientY);
            const x = snapMm(mx);
            const y = snapMm(my);
            if (tool === 'place') {
                setDoc((d) => ({
                    ...d,
                    placements: [
                        ...d.placements,
                        {
                            id: newId('fp'),
                            footprintId: placeFootprintId,
                            ref: `FP${d.placements.length + 1}`,
                            x,
                            y,
                            rot: 0,
                            padNets: {},
                        },
                    ],
                }));
                return;
            }
            if (tool === 'via') {
                setDoc((d) => ({
                    ...d,
                    vias: [
                        ...d.vias,
                        {
                            id: newId('via'),
                            x,
                            y,
                            drillMm: d.meta.defaultViaDrillMm,
                            diamMm: d.meta.defaultViaDiamMm,
                            net: '',
                        },
                    ],
                }));
                return;
            }
            if (tool === 'route') {
                setRouteDraft((prev) => {
                    const next = prev ? [...prev, [x, y]] : [[x, y]];
                    return next;
                });
                return;
            }
            const pl = pickPlacementAt(mx, my);
            if (pl) {
                setSelection({ kind: 'placement', id: pl.id });
                setDrag({
                    id: pl.id,
                    ox: pl.x,
                    oy: pl.y,
                    sx: mx,
                    sy: my,
                });
            } else {
                setSelection(null);
            }
        },
        [tool, placeFootprintId, pickPlacementAt],
    );

    useEffect(() => {
        if (!drag) return;
        const onMove = (ev) => {
            const [mx, my] = clientToSvgMm(svgRef.current, ev.clientX, ev.clientY);
            setDoc((d) => ({
                ...d,
                placements: d.placements.map((p) => {
                    if (p.id !== drag.id) return p;
                    const dx = snapMm(mx - drag.sx);
                    const dy = snapMm(my - drag.sy);
                    return { ...p, x: snapMm(drag.ox + dx), y: snapMm(drag.oy + dy) };
                }),
            }));
        };
        const onUp = () => setDrag(null);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [drag]);

    useEffect(() => {
        const onKey = (ev) => {
            if (ev.key === 'Escape') {
                setRouteDraft(null);
                return;
            }
            if (ev.key === 'Enter' && tool === 'route' && routeDraft?.length >= 2) {
                setDoc((d) => ({
                    ...d,
                    tracks: [
                        ...d.tracks,
                        {
                            id: newId('tr'),
                            layer: activeLayer,
                            widthMm: d.meta.defaultTrackMm,
                            net: '',
                            points: routeDraft.map(([px, py]) => [snapMm(px), snapMm(py)]),
                        },
                    ],
                }));
                setRouteDraft(null);
            }
            if ((ev.key === 'Delete' || ev.key === 'Backspace') && selection) {
                const t = ev.target;
                if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
                ev.preventDefault();
                if (selection.kind === 'placement') {
                    setDoc((d) => ({
                        ...d,
                        placements: d.placements.filter((p) => p.id !== selection.id),
                    }));
                }
                if (selection.kind === 'track') {
                    setDoc((d) => ({
                        ...d,
                        tracks: d.tracks.filter((tr) => tr.id !== selection.id),
                    }));
                }
                if (selection.kind === 'via') {
                    setDoc((d) => ({
                        ...d,
                        vias: d.vias.filter((v) => v.id !== selection.id),
                    }));
                }
                setSelection(null);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [tool, routeDraft, activeLayer, selection]);

    const gridLines = useMemo(() => {
        const els = [];
        const step = 1;
        for (let gx = 0; gx <= W; gx += step) {
            els.push(
                <line
                    key={`gv${gx}`}
                    x1={gx}
                    y1={0}
                    x2={gx}
                    y2={H}
                    stroke={gx % 5 === 0 ? 'rgba(148,163,184,0.14)' : 'rgba(148,163,184,0.06)'}
                    strokeWidth={0.05}
                />,
            );
        }
        for (let gy = 0; gy <= H; gy += step) {
            els.push(
                <line
                    key={`gh${gy}`}
                    x1={0}
                    y1={gy}
                    x2={W}
                    y2={gy}
                    stroke={gy % 5 === 0 ? 'rgba(148,163,184,0.14)' : 'rgba(148,163,184,0.06)'}
                    strokeWidth={0.05}
                />,
            );
        }
        return els;
    }, [W, H]);

    const ratsnest = useMemo(() => {
        const out = [];
        for (const [net, pts] of padCentersByNet) {
            if (pts.length < 2) continue;
            const hub = pts[0];
            for (let i = 1; i < pts.length; i++) {
                out.push(
                    <line
                        key={`rn-${net}-${i}`}
                        x1={hub[0]}
                        y1={hub[1]}
                        x2={pts[i][0]}
                        y2={pts[i][1]}
                        stroke="rgba(168,85,247,0.22)"
                        strokeWidth={0.08}
                        strokeDasharray="0.4 0.25"
                    />,
                );
            }
        }
        return out;
    }, [padCentersByNet]);

    const cursorClass =
        tool === 'select' ? (drag ? 'pcb-cursor-move' : 'pcb-cursor-select') : '';

    return (
        <div className="pcb-root">
            <header className="pcb-topbar">
                <h1>PCB Studio</h1>
                {onBackToSchematic ? (
                    <button type="button" className="pcb-topbtn" onClick={() => onBackToSchematic()}>
                        <Home size={14} /> Schematic
                    </button>
                ) : null}
                <span className="pcb-sep" />
                <button
                    type="button"
                    className={`pcb-topbtn${tool === 'select' ? ' is-active' : ''}`}
                    onClick={() => {
                        setTool('select');
                        setRouteDraft(null);
                    }}
                >
                    <MousePointer2 size={14} /> Select
                </button>
                <button
                    type="button"
                    className={`pcb-topbtn${tool === 'place' ? ' is-active' : ''}`}
                    onClick={() => setTool('place')}
                >
                    <MapPin size={14} /> Place
                </button>
                <button
                    type="button"
                    className={`pcb-topbtn${tool === 'route' ? ' is-active' : ''}`}
                    onClick={() => {
                        setTool('route');
                        setRouteDraft(null);
                    }}
                >
                    <GitBranch size={14} /> Route
                </button>
                <button type="button" className={`pcb-topbtn${tool === 'via' ? ' is-active' : ''}`} onClick={() => setTool('via')}>
                    <CircleDot size={14} /> Via
                </button>
                <span className="pcb-sep" />
                {COPPER_LAYERS.map((ly) => (
                    <button
                        key={ly}
                        type="button"
                        className={`pcb-topbtn${activeLayer === ly ? ' is-active' : ''}`}
                        onClick={() => setActiveLayer(ly)}
                        title="Active copper for routing"
                    >
                        <Layers size={14} /> {ly.replace('.Cu', '')}
                    </button>
                ))}
                <span className="pcb-sep" />
                <label className="pcb-field">
                    W mm
                    <input
                        type="number"
                        min={20}
                        max={500}
                        value={doc.meta.boardWmm}
                        onChange={(e) => {
                            const v = Number(e.target.value);
                            setDoc((d) => ({ ...d, meta: { ...d.meta, boardWmm: Number.isFinite(v) ? v : d.meta.boardWmm } }));
                        }}
                    />
                </label>
                <label className="pcb-field">
                    H mm
                    <input
                        type="number"
                        min={20}
                        max={500}
                        value={doc.meta.boardHmm}
                        onChange={(e) => {
                            const v = Number(e.target.value);
                            setDoc((d) => ({ ...d, meta: { ...d.meta, boardHmm: Number.isFinite(v) ? v : d.meta.boardHmm } }));
                        }}
                    />
                </label>
                <span className="pcb-sep" />
                <button type="button" className="pcb-topbtn" onClick={handleRunDRC}>
                    <AlertTriangle size={14} color={drcViolations.length > 0 ? "#ef4444" : "currentColor"} /> DRC {drcViolations.length > 0 ? `(${drcViolations.length})` : ''}
                </button>
                <button type="button" className="pcb-topbtn" disabled={exportBusy} onClick={() => void handleExportZip()}>
                    <Download size={14} /> {exportBusy ? '…' : 'Gerber ZIP'}
                </button>
                <button
                    type="button"
                    className="pcb-topbtn"
                    onClick={() => {
                        if (!window.confirm('Clear saved board and reset?')) return;
                        const fresh = emptyPcbDoc();
                        setDoc(fresh);
                        try {
                            localStorage.removeItem(PCB_STORAGE_KEY);
                        } catch {
                            /* */
                        }
                    }}
                >
                    <Trash2 size={14} /> New board
                </button>
            </header>

            <div className="pcb-main">
                <aside className="pcb-sidebar">
                    <h2>Footprints</h2>
                    <ul className="pcb-fp-list">
                        {fpSummaries.map((f) => (
                            <li key={f.id}>
                                <button
                                    type="button"
                                    className={placeFootprintId === f.id ? 'is-picked' : ''}
                                    onClick={() => setPlaceFootprintId(f.id)}
                                >
                                    <strong>{f.id}</strong>
                                    <div style={{ opacity: 0.75, fontSize: '0.65rem' }}>{f.name}</div>
                                </button>
                            </li>
                        ))}
                    </ul>
                </aside>
                <div className="pcb-canvas-wrap">
                    <svg
                        ref={svgRef}
                        className={`pcb-board-svg ${cursorClass}`}
                        width={Math.min(920, Math.max(320, W * 8))}
                        height={Math.min(640, Math.max(240, H * 8))}
                        viewBox={`0 0 ${W} ${H}`}
                        onMouseDown={onSvgDown}
                    >
                        <rect x={0} y={0} width={W} height={H} fill="#1a1520" stroke="#4c1d95" strokeWidth={0.12} />
                        {gridLines}
                        <g className="pcb-ratsnest">{ratsnest}</g>
                        {(doc.tracks || []).map((tr) => {
                            const pts = tr.points || [];
                            if (pts.length < 2) return null;
                            const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ');
                            const isSel = selection?.kind === 'track' && selection.id === tr.id;
                            const layerColors = {
                                'F.Cu': '#ef4444',
                                'In1.Cu': '#f59e0b',
                                'In2.Cu': '#eab308',
                                'In3.Cu': '#22c55e',
                                'In4.Cu': '#06b6d4',
                                'In5.Cu': '#3b82f6',
                                'In6.Cu': '#6366f1',
                                'B.Cu': '#a855f7',
                            };
                            const baseCol = layerColors[tr.layer] || '#94a3b8';
                            const stroke = isSel ? '#f472b6' : baseCol;
                            return (
                                <path
                                    key={tr.id}
                                    d={d}
                                    fill="none"
                                    stroke={stroke}
                                    strokeWidth={tr.widthMm || 0.35}
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    opacity={tr.layer === activeLayer ? 1 : 0.35}
                                    onMouseDown={(e) => {
                                        e.stopPropagation();
                                        setSelection({ kind: 'track', id: tr.id });
                                    }}
                                    style={{ cursor: 'pointer' }}
                                />
                            );
                        })}
                        {(doc.vias || []).map((v) => {
                            const isSel = selection?.kind === 'via' && selection.id === v.id;
                            return (
                                <g key={v.id} onMouseDown={(e) => e.stopPropagation()} style={{ cursor: 'pointer' }}>
                                    <circle
                                        cx={v.x}
                                        cy={v.y}
                                        r={(v.diamMm || 0.8) / 2}
                                        fill={isSel ? 'rgba(244,114,182,0.5)' : 'rgba(250,204,21,0.35)'}
                                        stroke="#facc15"
                                        strokeWidth={0.06}
                                        onMouseDown={(e) => {
                                            e.stopPropagation();
                                            setSelection({ kind: 'via', id: v.id });
                                        }}
                                    />
                                </g>
                            );
                        })}
                        {(doc.placements || []).map((pl) => {
                            const fp = getFootprint(pl.footprintId);
                            const isSel = selection?.kind === 'placement' && selection.id === pl.id;
                            const b = footprintBBox(pl);
                            return (
                                <g key={pl.id}>
                                    {isSel ? (
                                        <rect
                                            x={b.minX - 0.3}
                                            y={b.minY - 0.3}
                                            width={b.maxX - b.minX + 0.6}
                                            height={b.maxY - b.minY + 0.6}
                                            fill="none"
                                            stroke="#f472b6"
                                            strokeWidth={0.08}
                                            strokeDasharray="0.2 0.15"
                                        />
                                    ) : null}
                                    {fp?.pads?.map((pad) => {
                                        const [px, py] = padWorld(pl, pad);
                                        return (
                                            <rect
                                                key={pad.id}
                                                x={px - pad.w / 2}
                                                y={py - pad.h / 2}
                                                width={pad.w}
                                                height={pad.h}
                                                fill="#334155"
                                                stroke="#94a3b8"
                                                strokeWidth={0.04}
                                            />
                                        );
                                    })}
                                    <text
                                        x={pl.x}
                                        y={pl.y - 2}
                                        textAnchor="middle"
                                        fill="#e2e8f0"
                                        fontSize="0.9px"
                                        style={{ fontFamily: 'system-ui, sans-serif' }}
                                    >
                                        {pl.ref}
                                    </text>
                                </g>
                            );
                        })}
                        {routeDraft?.length ? (
                            <path
                                d={routeDraft.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ')}
                                fill="none"
                                stroke="#a855f7"
                                strokeWidth={doc.meta.defaultTrackMm}
                                strokeDasharray="0.3 0.2"
                                strokeLinecap="round"
                            />
                        ) : null}
                        {drcViolations.map((v, i) => (
                            <g key={`drc-${i}`}>
                                <circle cx={v.x} cy={v.y} r={1.5} fill="none" stroke="#ef4444" strokeWidth={0.3} strokeDasharray="0.5 0.5" />
                                <text x={v.x} y={v.y - 2} fill="#ef4444" fontSize="1px" textAnchor="middle">{v.type}</text>
                            </g>
                        ))}
                    </svg>
                </div>
                <p className="pcb-hint">
                    Grid {GRID_MM} mm. Route: click corners, Enter to commit, Esc cancel. Delete removes selection. Send to PCB from Circuit Studio opens a
                    fresh merge here (your saved board is not auto-merged with that transfer).
                </p>
            </div>
        </div>
    );
}

export default PcbStudioPage;
