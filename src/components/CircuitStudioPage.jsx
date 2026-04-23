/**
 * Circuit Studio — Phase 1 UI.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Top bar: demo picker, home, analysis selector, Run, Save     │
 *   ├──────────────┬──────────────────────────┬────────────────────┤
 *   │ Netlist      │ Schematic preview (SVG)  │ Tour / legend      │
 *   │ editor       ├──────────────────────────┤ Results summary    │
 *   │ (textarea)   │ Plot (recharts)          │                    │
 *   └──────────────┴──────────────────────────┴────────────────────┘
 *
 * The page is designed to fit the Flow-Lab pattern: home screen with
 * demo cards on first visit, workspace view once a netlist is loaded,
 * and a guided tour for first-time demo runs.
 */

import React, {
    useCallback, useEffect, useMemo, useState,
} from 'react';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import {
    Cpu, Play, Home, RefreshCw, ChevronRight, ChevronLeft,
    BookOpen, Copy, Plus, FileText, Activity,
    SlidersHorizontal,
} from 'lucide-react';
import { parseNetlist } from '../circuit/netlist.js';
import { buildContext, solveDC, solveTran, solveAC } from '../circuit/solver.js';
import { layoutSchematic, componentLabel } from '../circuit/schematic.js';
import { DEMOS } from '../circuit/demos.js';
import './CircuitStudioPage.css';

const ANALYSIS_TYPES = [
    { id: 'op', label: 'DC op-point' },
    { id: 'ac', label: 'AC sweep' },
    { id: 'tran', label: 'Transient' },
];

const BLANK_NETLIST = `* New Circuit Studio project.
* Draw a circuit by typing a SPICE netlist here.
*
* Quick reference:
*   R<name> n+ n- value          resistor (value may use k/Meg/u/n/p/f)
*   C<name> n+ n- value          capacitor
*   L<name> n+ n- value          inductor
*   V<name> n+ n- [DC v] [AC m p] [SIN(...)] [PULSE(...)] [PWL(...)]
*   I<name> n+ n- <src-spec>     current source — same grammar as V
*   D<name> a c MODEL            diode (see .model below)
*   E<name> n+ n- c+ c- gain     voltage-controlled voltage source
*   G<name> n+ n- c+ c- gm       voltage-controlled current source
*   O<name> in+ in- out          ideal op-amp (virtual short)
*
*   .op                          DC operating point
*   .ac dec N f1 f2              AC sweep (dec | oct | lin)
*   .tran tstep tstop [UIC]      transient analysis
*   .model NAME D(Is=1e-14 N=1)  diode parameters
*   .end                         done

V1 vin 0 SIN(0 1 1k)
R1 vin vout 1k
C1 vout 0 100n

.ac dec 20 10 100k
.tran 10u 3m
.end`;

function CircuitStudioPage() {
    const [netlistText, setNetlistText] = useState(() => {
        const saved = localStorage.getItem('circuitStudio:netlist');
        return saved || '';
    });
    const [view, setView] = useState(() => (localStorage.getItem('circuitStudio:netlist') ? 'workspace' : 'home'));
    const [analysis, setAnalysis] = useState('tran');
    const [runResult, setRunResult] = useState(null);
    const [runError, setRunError] = useState('');
    const [running, setRunning] = useState(false);
    const [tourOpen, setTourOpen] = useState(false);
    const [tourStep, setTourStep] = useState(0);
    const [activeTour, setActiveTour] = useState(null);
    const [loadedDemoId, setLoadedDemoId] = useState(null);
    const [selectedSignals, setSelectedSignals] = useState([]);
    // Schematic zoom/pan (phase 1: zoom only — pan lands with the editor in phase 2)
    const [schematicZoom, setSchematicZoom] = useState(1);

    // Persist the netlist so the user doesn't lose their work across
    // tab navigations. (Multi-tasking: this page stays mounted in the
    // background like every other major page, but refresh should also
    // survive — hence the localStorage dance.)
    useEffect(() => {
        if (netlistText && netlistText.length > 0) {
            localStorage.setItem('circuitStudio:netlist', netlistText);
        }
    }, [netlistText]);

    const parsed = useMemo(() => {
        if (!netlistText || !netlistText.trim()) return null;
        try { return parseNetlist(netlistText); }
        catch (e) { return { errors: [String(e?.message || e)], elements: [], directives: [], models: {}, nNodes: 1, nodeNames: ['0'] }; }
    }, [netlistText]);

    const schematic = useMemo(() => {
        if (!parsed || parsed.elements.length === 0) return null;
        try { return layoutSchematic(parsed); } catch { return null; }
    }, [parsed]);

    // Auto-detect default signals when results arrive.
    useEffect(() => {
        if (!runResult || !runResult.signals) return;
        const all = runResult.signals.map((s) => s.name);
        // Prefer demo-recommended signals if they exist in the results.
        const demo = DEMOS.find((d) => d.id === loadedDemoId);
        const suggested = demo?.signals?.[analysis] || [];
        const preferred = suggested.filter((s) => all.includes(s));
        if (preferred.length > 0) setSelectedSignals(preferred);
        else setSelectedSignals(all.slice(0, Math.min(4, all.length)));
    }, [runResult, loadedDemoId, analysis]);

    const loadDemo = useCallback((demo) => {
        setNetlistText(demo.netlist);
        setAnalysis(demo.defaultAnalysis || 'tran');
        setLoadedDemoId(demo.id);
        setRunResult(null);
        setRunError('');
        setView('workspace');
        setActiveTour(demo.tour || null);
        setTourStep(0);
        setTourOpen((demo.tour || []).length > 0);
    }, []);

    const loadBlank = useCallback(() => {
        setNetlistText(BLANK_NETLIST);
        setLoadedDemoId(null);
        setRunResult(null);
        setRunError('');
        setActiveTour(null);
        setTourOpen(false);
        setAnalysis('tran');
        setView('workspace');
    }, []);

    const goHome = useCallback(() => {
        setView('home');
    }, []);

    const handleRun = useCallback(() => {
        if (!parsed || parsed.errors?.length > 0) {
            setRunError(parsed?.errors?.join('\n') || 'Netlist is empty or invalid.');
            return;
        }
        if (parsed.elements.length === 0) {
            setRunError('No components in the netlist — add at least one R / V / I before running.');
            return;
        }
        setRunning(true);
        setRunError('');
        // Defer to next tick so the UI can update to "Running…" state.
        setTimeout(() => {
            try {
                const ctx = buildContext(parsed);
                const signals = [];
                if (analysis === 'op') {
                    const dc = solveDC(ctx);
                    // Show a single-sample "bar-chart" of every node voltage.
                    const nodeVals = [];
                    for (let i = 1; i < parsed.nNodes; i++) {
                        nodeVals.push({
                            name: parsed.nodeNames[i] || `n${i}`,
                            value: dc.x[i - 1],
                        });
                    }
                    setRunResult({
                        kind: 'op',
                        nodeVals,
                        iters: dc.iters,
                        converged: dc.converged,
                        signals: nodeVals.map((n) => ({ name: `V(${n.name})`, kind: 'op', value: n.value })),
                    });
                } else if (analysis === 'tran') {
                    const dir = parsed.directives.find((d) => d.kind === 'tran') || {
                        tstep: 1e-6, tstop: 1e-3, tstart: 0,
                    };
                    const res = solveTran(ctx, dir);
                    for (let i = 1; i < parsed.nNodes; i++) {
                        signals.push({
                            name: `V(${parsed.nodeNames[i] || 'n' + i})`,
                            kind: 'tran',
                            t: res.t,
                            y: res.nodeV[i - 1],
                        });
                    }
                    setRunResult({
                        kind: 'tran',
                        t: res.t,
                        signals,
                    });
                } else if (analysis === 'ac') {
                    const dir = parsed.directives.find((d) => d.kind === 'ac') || {
                        mode: 'dec', n: 20, fStart: 1, fStop: 1e6,
                    };
                    const ac = solveAC(ctx, dir);
                    for (let i = 1; i < parsed.nNodes; i++) {
                        const samples = ac.V[i - 1];
                        signals.push({
                            name: `V(${parsed.nodeNames[i] || 'n' + i})`,
                            kind: 'ac',
                            f: ac.freqs,
                            mag: samples.map((s) => Math.hypot(s.re, s.im)),
                            phase: samples.map((s) => Math.atan2(s.im, s.re) * 180 / Math.PI),
                        });
                    }
                    setRunResult({
                        kind: 'ac',
                        f: ac.freqs,
                        signals,
                    });
                }
            } catch (e) {
                setRunError(e?.message || String(e));
                setRunResult(null);
            } finally {
                setRunning(false);
            }
        }, 30);
    }, [parsed, analysis]);

    const copyNetlist = useCallback(() => {
        if (!netlistText) return;
        navigator.clipboard?.writeText(netlistText).catch(() => {});
    }, [netlistText]);

    // ---------- Home view ----------
    if (view === 'home') {
        return (
            <div className="cs-root cs-home">
                <div className="cs-home-hero">
                    <Cpu size={48} />
                    <h1>Circuit Studio</h1>
                    <p className="cs-home-tagline">
                        Analog SPICE-style circuit simulator in your browser. DC operating
                        point, AC frequency sweep, and transient analysis — built for
                        sensor front-ends and teaching circuits.
                    </p>
                </div>

                <div className="cs-home-actions">
                    <button className="cs-home-action cs-home-action-primary" onClick={loadBlank}>
                        <Plus size={18} /> New blank circuit
                    </button>
                    {netlistText && netlistText.trim().length > 0 && (
                        <button className="cs-home-action" onClick={() => setView('workspace')}>
                            <FileText size={18} /> Continue last session
                        </button>
                    )}
                </div>

                <h2 className="cs-home-section-title">Demos</h2>
                <div className="cs-home-grid">
                    {DEMOS.map((d) => (
                        <button
                            key={d.id}
                            className="cs-demo-card"
                            onClick={() => loadDemo(d)}
                        >
                            <div className="cs-demo-card-cat">{d.category}</div>
                            <div className="cs-demo-card-title">{d.title}</div>
                            <div className="cs-demo-card-tagline">{d.tagline}</div>
                            <div className="cs-demo-card-cta">
                                <Play size={14} /> Load
                            </div>
                        </button>
                    ))}
                </div>

                <div className="cs-home-footer">
                    <strong>Phase 1 scope:</strong> analog-only, netlist-driven.
                    Drag-and-drop schematic editing, digital gates, and noise analysis
                    land in follow-up releases.
                </div>
            </div>
        );
    }

    // ---------- Workspace view ----------
    const directives = parsed?.directives || [];
    const hasTran = directives.some((d) => d.kind === 'tran');
    const hasAc = directives.some((d) => d.kind === 'ac');

    return (
        <div className="cs-root">
            <div className="cs-topbar">
                <button className="cs-topbtn" onClick={goHome} title="Back to Circuit Studio home">
                    <Home size={14} /> Home
                </button>
                <div className="cs-topbar-sep" />
                <div className="cs-analysis-group">
                    <SlidersHorizontal size={14} />
                    <span className="cs-analysis-label">Analysis</span>
                    {ANALYSIS_TYPES.map((t) => (
                        <button
                            key={t.id}
                            className={`cs-analysis-btn${analysis === t.id ? ' is-active' : ''}`}
                            onClick={() => setAnalysis(t.id)}
                            title={
                                t.id === 'ac' && !hasAc ? 'Netlist has no .ac directive — defaults to 1 Hz..1 MHz dec 20'
                                : t.id === 'tran' && !hasTran ? 'Netlist has no .tran directive — defaults to 1 µs / 1 ms'
                                : t.label
                            }
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
                <div className="cs-topbar-sep" />
                <button
                    className="cs-topbtn cs-topbtn-primary"
                    onClick={handleRun}
                    disabled={running}
                >
                    {running ? <><RefreshCw size={14} className="cs-spin" /> Running…</> : <><Play size={14} /> Run</>}
                </button>
                <div className="cs-topbar-spacer" />
                <button className="cs-topbtn" onClick={copyNetlist} title="Copy netlist to clipboard">
                    <Copy size={14} /> Copy
                </button>
                {activeTour && (
                    <button
                        className={`cs-topbtn${tourOpen ? ' is-active' : ''}`}
                        onClick={() => { setTourOpen(!tourOpen); setTourStep(0); }}
                        title="Toggle guided tour"
                    >
                        <BookOpen size={14} /> Tour
                    </button>
                )}
            </div>

            <div className="cs-body">
                <div className="cs-pane cs-pane-editor">
                    <div className="cs-pane-title">
                        <FileText size={13} /> Netlist
                        {parsed?.errors?.length > 0 && (
                            <span className="cs-pane-err">· {parsed.errors.length} error{parsed.errors.length > 1 ? 's' : ''}</span>
                        )}
                    </div>
                    <textarea
                        className="cs-netlist-editor"
                        spellCheck={false}
                        value={netlistText}
                        onChange={(e) => setNetlistText(e.target.value)}
                        placeholder="Type a SPICE netlist here…"
                    />
                    {parsed?.errors?.length > 0 && (
                        <div className="cs-err-block">
                            {parsed.errors.map((err, i) => <div key={i}>{err}</div>)}
                        </div>
                    )}
                </div>

                <div className="cs-pane cs-pane-viz">
                    <div className="cs-viz-top">
                        <div className="cs-pane-title">
                            <Cpu size={13} /> Schematic preview
                            <span className="cs-pane-subtle">(auto-laid out — drag editor in Phase 2)</span>
                            <div className="cs-zoom-group">
                                <button
                                    className="cs-zoom-btn"
                                    onClick={() => setSchematicZoom((z) => Math.max(0.4, z - 0.2))}
                                    title="Zoom out"
                                >−</button>
                                <span className="cs-zoom-val">{Math.round(schematicZoom * 100)}%</span>
                                <button
                                    className="cs-zoom-btn"
                                    onClick={() => setSchematicZoom((z) => Math.min(2.5, z + 0.2))}
                                    title="Zoom in"
                                >+</button>
                            </div>
                        </div>
                        <div className="cs-schematic-wrap">
                            {schematic ? (
                                <SchematicSvg layout={schematic} zoom={schematicZoom} />
                            ) : (
                                <div className="cs-empty">Type a netlist to preview the circuit.</div>
                            )}
                        </div>
                    </div>

                    <div className="cs-viz-bot">
                        <div className="cs-pane-title">
                            <Activity size={13} /> Results
                            {runResult?.kind === 'op' && <span className="cs-pane-subtle">DC operating point</span>}
                            {runResult?.kind === 'tran' && <span className="cs-pane-subtle">Transient · {runResult.t?.length || 0} samples</span>}
                            {runResult?.kind === 'ac' && <span className="cs-pane-subtle">AC sweep · {runResult.f?.length || 0} samples</span>}
                        </div>
                        {runError && (
                            <div className="cs-err-block">
                                {String(runError).split('\n').map((l, i) => <div key={i}>{l}</div>)}
                            </div>
                        )}
                        {!runError && runResult && (
                            <ResultsPanel
                                result={runResult}
                                selectedSignals={selectedSignals}
                                onSignalsChange={setSelectedSignals}
                            />
                        )}
                        {!runError && !runResult && (
                            <div className="cs-empty">
                                Hit <b>Run</b> to solve. DC gives node voltages; AC gives a Bode plot; Transient plots V(node) vs. time.
                            </div>
                        )}
                    </div>
                </div>

                {tourOpen && activeTour && (
                    <div className="cs-pane cs-pane-tour">
                        <div className="cs-pane-title">
                            <BookOpen size={13} /> Guided tour
                            <span className="cs-pane-subtle">Step {tourStep + 1} of {activeTour.length}</span>
                        </div>
                        <div className="cs-tour-body">
                            <div className="cs-tour-step-title">{activeTour[tourStep]?.title}</div>
                            <div className="cs-tour-step-body">{activeTour[tourStep]?.body}</div>
                        </div>
                        <div className="cs-tour-nav">
                            <button
                                className="cs-topbtn"
                                onClick={() => setTourStep((s) => Math.max(0, s - 1))}
                                disabled={tourStep === 0}
                            >
                                <ChevronLeft size={12} /> Back
                            </button>
                            <button
                                className="cs-topbtn cs-topbtn-primary"
                                onClick={() => {
                                    if (tourStep + 1 < activeTour.length) setTourStep(tourStep + 1);
                                    else setTourOpen(false);
                                }}
                            >
                                {tourStep + 1 >= activeTour.length ? 'Finish' : <>Next <ChevronRight size={12} /></>}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

/* ============================================================ */
/* Sub-components                                               */
/* ============================================================ */

const SchematicSvg = React.memo(function SchematicSvg({ layout, zoom }) {
    const { nodes, comps, nodeColor, width, height } = layout;
    const nodeById = useMemo(() => {
        const m = new Map();
        for (const n of nodes) m.set(n.id, n);
        return m;
    }, [nodes]);

    return (
        <div className="cs-schematic-scroller">
            <svg
                viewBox={`0 0 ${width} ${height}`}
                width={width * zoom}
                height={height * zoom}
                className="cs-schematic-svg"
            >
                {/* Wires */}
                {comps.flatMap((c) =>
                    c.pins.map((nId, pi) => {
                        const n = nodeById.get(nId);
                        if (!n) return null;
                        return (
                            <line
                                key={`${c.index}-${pi}`}
                                x1={c.x} y1={c.y} x2={n.x} y2={n.y}
                                stroke={nodeColor.get(nId)} strokeWidth={1.4}
                                strokeOpacity={0.7}
                            />
                        );
                    })
                )}
                {/* Node junctions */}
                {nodes.map((n) => (
                    <g key={`n-${n.id}`} transform={`translate(${n.x}, ${n.y})`}>
                        {n.isGround ? (
                            <g>
                                <line x1={0} y1={-6} x2={0} y2={0} stroke="#94a3b8" strokeWidth={1.5} />
                                <line x1={-9} y1={0} x2={9} y2={0} stroke="#94a3b8" strokeWidth={2} />
                                <line x1={-6} y1={3} x2={6} y2={3} stroke="#94a3b8" strokeWidth={1.5} />
                                <line x1={-3} y1={6} x2={3} y2={6} stroke="#94a3b8" strokeWidth={1.5} />
                                <text x={0} y={20} fontSize={10} textAnchor="middle" fill="#64748b">GND</text>
                            </g>
                        ) : (
                            <g>
                                <circle r={4} fill={nodeColor.get(n.id)} stroke="#111827" strokeWidth={0.8} />
                                <text x={6} y={-6} fontSize={10} fill={nodeColor.get(n.id)}>{n.label}</text>
                            </g>
                        )}
                    </g>
                ))}
                {/* Components */}
                {comps.map((c) => (
                    <ComponentGlyph key={`c-${c.index}`} comp={c} />
                ))}
            </svg>
        </div>
    );
});

function ComponentGlyph({ comp }) {
    const { x, y, element } = comp;
    const label = componentLabel(element);
    const sym = symbolFor(element.type);
    return (
        <g transform={`translate(${x}, ${y})`} className={`cs-comp cs-comp-${element.type}`}>
            <rect x={-26} y={-18} width={52} height={36} rx={6} ry={6}
                  fill="rgba(15, 23, 42, 0.94)" stroke="#334155" strokeWidth={1}/>
            <text x={0} y={-3} textAnchor="middle" fontSize={14} fontWeight={700} fill="#f1f5f9">
                {sym}
            </text>
            <text x={0} y={12} textAnchor="middle" fontSize={8} fill="#cbd5e1">
                {label.split('\n')[0]}
            </text>
            <text x={0} y={28} textAnchor="middle" fontSize={8.5} fill="#94a3b8">
                {label.split('\n')[1] || ''}
            </text>
        </g>
    );
}

function symbolFor(type) {
    switch (type) {
        case 'R': return 'R';
        case 'C': return '┤├';
        case 'L': return 'L';
        case 'V': return 'V';
        case 'I': return 'I';
        case 'D': return '▷|';
        case 'E': return 'E';
        case 'G': return 'G';
        case 'O': return '▷';
        default: return '?';
    }
}

function ResultsPanel({ result, selectedSignals, onSignalsChange }) {
    const toggle = (name) => {
        onSignalsChange(selectedSignals.includes(name)
            ? selectedSignals.filter((s) => s !== name)
            : [...selectedSignals, name]);
    };

    if (result.kind === 'op') {
        return (
            <div className="cs-op-results">
                <div className="cs-op-meta">
                    Converged in {result.iters} iteration{result.iters > 1 ? 's' : ''}.
                </div>
                <table className="cs-op-table">
                    <thead><tr><th>Node</th><th>Voltage</th></tr></thead>
                    <tbody>
                        {result.nodeVals.map((n) => (
                            <tr key={n.name}>
                                <td>{n.name}</td>
                                <td className="cs-mono">{formatSIValue(n.value, 'V')}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    }

    if (result.kind === 'tran') {
        // Rebuild recharts series.
        const t = result.t;
        const data = new Array(t.length);
        for (let i = 0; i < t.length; i++) {
            const row = { t: t[i] };
            for (const s of result.signals) row[s.name] = s.y[i];
            data[i] = row;
        }
        return (
            <div className="cs-plot-wrap">
                <SignalChips result={result} selected={selectedSignals} onToggle={toggle} />
                <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={data} margin={{ top: 6, right: 24, left: 6, bottom: 6 }}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                        <XAxis
                            dataKey="t" type="number" scale="linear" domain={['auto', 'auto']}
                            tickFormatter={(v) => formatSIValue(v, 's')}
                            label={{ value: 'time', position: 'insideBottom', dy: 12, fontSize: 11 }}
                        />
                        <YAxis
                            tickFormatter={(v) => formatSIValue(v, 'V')}
                            label={{ value: 'V(node)', angle: -90, position: 'insideLeft', fontSize: 11 }}
                        />
                        <Tooltip
                            formatter={(v) => formatSIValue(v, 'V')}
                            labelFormatter={(v) => `t = ${formatSIValue(v, 's')}`}
                        />
                        <Legend />
                        {selectedSignals.map((name, i) => (
                            <Line
                                key={name}
                                type="monotone"
                                dataKey={name}
                                stroke={SIGNAL_COLORS[i % SIGNAL_COLORS.length]}
                                dot={false}
                                strokeWidth={1.5}
                                isAnimationActive={false}
                            />
                        ))}
                    </LineChart>
                </ResponsiveContainer>
            </div>
        );
    }

    if (result.kind === 'ac') {
        const f = result.f;
        const mag = new Array(f.length);
        const phase = new Array(f.length);
        for (let i = 0; i < f.length; i++) {
            mag[i] = { f: f[i] };
            phase[i] = { f: f[i] };
            for (const s of result.signals) {
                mag[i][s.name] = 20 * Math.log10(Math.max(s.mag[i], 1e-18));
                phase[i][s.name] = s.phase[i];
            }
        }
        return (
            <div className="cs-plot-wrap">
                <SignalChips result={result} selected={selectedSignals} onToggle={toggle} />
                <div className="cs-bode-wrap">
                    <ResponsiveContainer width="100%" height={160}>
                        <LineChart data={mag} margin={{ top: 6, right: 24, left: 6, bottom: 6 }}>
                            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                            <XAxis
                                dataKey="f" type="number" scale="log" domain={['auto', 'auto']}
                                tickFormatter={(v) => formatSIValue(v, 'Hz')}
                            />
                            <YAxis
                                tickFormatter={(v) => `${v.toFixed(0)}`}
                                label={{ value: 'Mag (dB)', angle: -90, position: 'insideLeft', fontSize: 10 }}
                            />
                            <Tooltip
                                formatter={(v) => `${Number(v).toFixed(2)} dB`}
                                labelFormatter={(v) => `f = ${formatSIValue(v, 'Hz')}`}
                            />
                            <Legend />
                            <ReferenceLine y={-3} stroke="#f59e0b" strokeDasharray="3 3" opacity={0.4} />
                            {selectedSignals.map((name, i) => (
                                <Line
                                    key={name}
                                    type="monotone"
                                    dataKey={name}
                                    stroke={SIGNAL_COLORS[i % SIGNAL_COLORS.length]}
                                    dot={false} strokeWidth={1.5} isAnimationActive={false}
                                />
                            ))}
                        </LineChart>
                    </ResponsiveContainer>
                    <ResponsiveContainer width="100%" height={130}>
                        <LineChart data={phase} margin={{ top: 6, right: 24, left: 6, bottom: 6 }}>
                            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                            <XAxis
                                dataKey="f" type="number" scale="log" domain={['auto', 'auto']}
                                tickFormatter={(v) => formatSIValue(v, 'Hz')}
                            />
                            <YAxis
                                tickFormatter={(v) => `${v.toFixed(0)}°`}
                                label={{ value: 'Phase', angle: -90, position: 'insideLeft', fontSize: 10 }}
                            />
                            <Tooltip
                                formatter={(v) => `${Number(v).toFixed(1)}°`}
                                labelFormatter={(v) => `f = ${formatSIValue(v, 'Hz')}`}
                            />
                            {selectedSignals.map((name, i) => (
                                <Line
                                    key={`p-${name}`}
                                    type="monotone"
                                    dataKey={name}
                                    stroke={SIGNAL_COLORS[i % SIGNAL_COLORS.length]}
                                    dot={false} strokeWidth={1.2} isAnimationActive={false}
                                />
                            ))}
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            </div>
        );
    }
    return null;
}

function SignalChips({ result, selected, onToggle }) {
    const all = result.signals.map((s) => s.name);
    return (
        <div className="cs-signal-chips">
            {all.map((n, i) => (
                <button
                    key={n}
                    className={`cs-chip${selected.includes(n) ? ' is-on' : ''}`}
                    style={{ '--chip-color': SIGNAL_COLORS[i % SIGNAL_COLORS.length] }}
                    onClick={() => onToggle(n)}
                >
                    {n}
                </button>
            ))}
        </div>
    );
}

const SIGNAL_COLORS = [
    '#3b82f6', '#f59e0b', '#10b981', '#ef4444',
    '#a855f7', '#14b8a6', '#f97316', '#6366f1',
    '#ec4899', '#22d3ee', '#84cc16', '#eab308',
];

function formatSIValue(v, unit) {
    if (!Number.isFinite(v)) return '—';
    if (v === 0) return `0 ${unit}`;
    const av = Math.abs(v);
    const prefixes = [
        { m: 1e9, s: 'G' }, { m: 1e6, s: 'M' }, { m: 1e3, s: 'k' },
        { m: 1, s: '' }, { m: 1e-3, s: 'm' }, { m: 1e-6, s: 'µ' },
        { m: 1e-9, s: 'n' }, { m: 1e-12, s: 'p' }, { m: 1e-15, s: 'f' },
    ];
    for (const p of prefixes) {
        if (av >= p.m) {
            const scaled = v / p.m;
            return `${scaled.toPrecision(3)} ${p.s}${unit}`;
        }
    }
    return `${v.toExponential(2)} ${unit}`;
}

export default CircuitStudioPage;
