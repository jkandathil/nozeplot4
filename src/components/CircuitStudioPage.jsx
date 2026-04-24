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
    Cpu, Play, Home, RefreshCw, ChevronRight, ChevronLeft, ChevronDown, ChevronUp,
    BookOpen, Copy, Plus, FileText, Activity,
    SlidersHorizontal, LayoutGrid, Terminal,
} from 'lucide-react';
import { parseNetlist } from '../circuit/netlist.js';
import { buildContext, solveDC, runWithStep } from '../circuit/solver.js';
import { DEMOS } from '../circuit/demos.js';
import {
    riseTime, fallTime, settlingTime, overshoot, peakToPeak, steadyStateEst,
    corner3dB, peakGain, unityGainFreq, phaseMargin, sampleAt,
} from '../circuit/measurements.js';
import { emptyDoc, resolveNets, addComponent, updateComponent, rotateComponent, removeComponent } from '../circuit/schematicDoc.js';
import { emitNetlist } from '../circuit/emitNetlist.js';
import { importNetlistToDoc } from '../circuit/importNetlist.js';
import Palette from './circuit/Palette.jsx';
import Canvas from './circuit/Canvas.jsx';
import Inspector from './circuit/Inspector.jsx';
import './CircuitStudioPage.css';

const ANALYSIS_TYPES = [
    { id: 'op', label: 'DC op-point' },
    { id: 'dc', label: 'DC sweep' },
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
    // Phase 3: the SchematicDoc is the source of truth. netlistText
    // is derived via emitNetlist(); we only store raw text for the
    // optional "source view" drawer and for home-page loads (demos).
    const [doc, setDoc] = useState(() => {
        try {
            const saved = localStorage.getItem('circuitStudio:doc');
            if (saved) return JSON.parse(saved);
        } catch { /* ignore */ }
        return emptyDoc();
    });
    const [selection, setSelection] = useState(null); // { kind: 'component'|'wire', id }
    const [showNetlistDrawer, setShowNetlistDrawer] = useState(false);
    const [showResults, setShowResults] = useState(true);
    const [netlistDraft, setNetlistDraft] = useState(''); // user-edited raw text when drawer open
    const [view, setView] = useState(() => {
        try {
            const saved = localStorage.getItem('circuitStudio:doc');
            return saved ? 'workspace' : 'home';
        } catch { return 'home'; }
    });
    const [analysis, setAnalysis] = useState('tran');
    const [runResult, setRunResult] = useState(null);
    const [runError, setRunError] = useState('');
    const [running, setRunning] = useState(false);
    const [tourOpen, setTourOpen] = useState(false);
    const [tourStep, setTourStep] = useState(0);
    const [activeTour, setActiveTour] = useState(null);
    const [loadedDemoId, setLoadedDemoId] = useState(null);
    const [selectedSignals, setSelectedSignals] = useState([]);
    // Phase-2 measurement cursors: two draggable verticals on tran / AC plots.
    // Values live in data space (seconds for tran, Hz for AC); null until a
    // simulation completes. Re-initialised whenever new results arrive.
    const [cursorA, setCursorA] = useState(null);
    const [cursorB, setCursorB] = useState(null);
    const [activeCursor, setActiveCursor] = useState(null); // 'A' | 'B' | null
    const [showMeasure, setShowMeasure] = useState(true);

    // Persist the schematic doc across sessions.
    useEffect(() => {
        if (doc && doc.components.length > 0) {
            try { localStorage.setItem('circuitStudio:doc', JSON.stringify(doc)); }
            catch { /* storage may be full; ignore */ }
        }
    }, [doc]);

    // Emit SPICE netlist from the doc. This is what the solver runs,
    // what "Copy" copies, and what the source drawer shows when closed.
    const netlistText = useMemo(() => {
        if (!doc || doc.components.length === 0) return '';
        try { return emitNetlist(doc); }
        catch (e) { return `* emit error: ${e?.message || e}`; }
    }, [doc]);

    // Sync netlist draft when drawer is shown (or doc changes).
    useEffect(() => {
        if (showNetlistDrawer) setNetlistDraft(netlistText);
    }, [showNetlistDrawer, netlistText]);

    const parsed = useMemo(() => {
        if (!netlistText || !netlistText.trim()) return null;
        try { return parseNetlist(netlistText); }
        catch (e) { return { errors: [String(e?.message || e)], elements: [], directives: [], models: {}, nNodes: 1, nodeNames: ['0'] }; }
    }, [netlistText]);

    // Run net resolution once per doc change — Canvas + Inspector share it.
    const resolvedNets = useMemo(() => {
        try { return resolveNets(doc); }
        catch { return null; }
    }, [doc]);

    // Imperative helper passed to Canvas/Inspector — takes a function
    // (mutator) and applies it to a clone of the current doc.
    const mutateDoc = useCallback((mutator) => {
        setDoc((d) => {
            const copy = JSON.parse(JSON.stringify(d));
            mutator(copy);
            return copy;
        });
    }, []);

    const handleCommand = useCallback((cmd) => {
        if (cmd.type === 'addPart') {
            mutateDoc((d) => { addComponent(d, cmd.partId, cmd.x, cmd.y, 0); });
        }
    }, [mutateDoc]);

    // Currently-selected component snapshot (for the inspector).
    const selectedComp = useMemo(() => {
        if (selection?.kind !== 'component') return null;
        return doc.components.find((c) => c.id === selection.id) || null;
    }, [selection, doc.components]);


    // Auto-detect default signals when results arrive. With .step
    // active, suggestions like "V(vout)" fan out into the family
    // "V(vout) @R1=1k", "V(vout) @R1=2k", … so we match by name prefix.
    useEffect(() => {
        if (!runResult || !runResult.signals) return;
        const allSignals = runResult.signals;
        const all = allSignals.map((s) => s.name);
        const demo = DEMOS.find((d) => d.id === loadedDemoId);
        const suggested = demo?.signals?.[analysis] || [];
        const preferred = [];
        for (const want of suggested) {
            const exact = all.filter((n) => n === want);
            if (exact.length > 0) {
                preferred.push(...exact);
                continue;
            }
            const family = all.filter((n) => n.startsWith(`${want} `) || n === want);
            preferred.push(...family);
        }
        if (preferred.length > 0) {
            setSelectedSignals(preferred);
        } else if (runResult.step) {
            // Pick the first node's whole family of curves so users see
            // the point of .step at a glance.
            const firstBase = allSignals[0]?.baseNode;
            const family = allSignals.filter((s) => s.baseNode === firstBase).map((s) => s.name);
            setSelectedSignals(family.slice(0, Math.min(8, family.length)));
        } else {
            setSelectedSignals(all.slice(0, Math.min(4, all.length)));
        }
    }, [runResult, loadedDemoId, analysis]);

    // Re-seed measurement cursors whenever a new result arrives. Placing
    // them at the 25th and 75th percentile of the x-axis puts them inside
    // the interesting part of most plots while being visually separated.
    useEffect(() => {
        if (!runResult) { setCursorA(null); setCursorB(null); return; }
        if (runResult.kind === 'tran' && runResult.t?.length > 1) {
            const t = runResult.t;
            setCursorA(t[Math.floor(t.length * 0.25)]);
            setCursorB(t[Math.floor(t.length * 0.75)]);
        } else if (runResult.kind === 'ac' && runResult.f?.length > 1) {
            const f = runResult.f;
            setCursorA(f[Math.floor(f.length * 0.25)]);
            setCursorB(f[Math.floor(f.length * 0.75)]);
        } else if (runResult.kind === 'dc' && runResult.x?.length > 1) {
            const x = runResult.x;
            setCursorA(x[Math.floor(x.length * 0.25)]);
            setCursorB(x[Math.floor(x.length * 0.75)]);
        } else {
            setCursorA(null); setCursorB(null);
        }
    }, [runResult]);

    const loadDemo = useCallback((demo) => {
        try {
            const { doc: imported } = importNetlistToDoc(demo.netlist);
            setDoc(imported);
        } catch (e) {
            setRunError(`Failed to import demo: ${e?.message || e}`);
            return;
        }
        setAnalysis(demo.defaultAnalysis || 'tran');
        setLoadedDemoId(demo.id);
        setRunResult(null);
        setRunError('');
        setSelection(null);
        setView('workspace');
        setActiveTour(demo.tour || null);
        setTourStep(0);
        setTourOpen((demo.tour || []).length > 0);
    }, []);

    const loadBlank = useCallback(() => {
        setDoc(emptyDoc());
        setLoadedDemoId(null);
        setRunResult(null);
        setRunError('');
        setSelection(null);
        setActiveTour(null);
        setTourOpen(false);
        setAnalysis('tran');
        setView('workspace');
    }, []);

    // When the user edits the raw netlist drawer and hits "Apply",
    // re-import the text into the doc. This is the one-way escape
    // hatch for power users who prefer typing SPICE.
    const applyNetlistDraft = useCallback(() => {
        try {
            const { doc: imported } = importNetlistToDoc(netlistDraft);
            setDoc(imported);
            setSelection(null);
            setRunError('');
        } catch (e) {
            setRunError(`Netlist parse failed: ${e?.message || e}`);
        }
    }, [netlistDraft]);

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
                const stepDir = parsed.directives.find((d) => d.kind === 'step') || null;

                if (analysis === 'op') {
                    // .step doesn't really make sense for a DC op-point
                    // "plot", so treat op as single-run regardless.
                    const dc = solveDC(ctx);
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
                    const runs = runWithStep(ctx, stepDir, { tran: dir });
                    setRunResult(buildStepResult('tran', runs, parsed, stepDir));
                } else if (analysis === 'ac') {
                    const dir = parsed.directives.find((d) => d.kind === 'ac') || {
                        mode: 'dec', n: 20, fStart: 1, fStop: 1e6,
                    };
                    const runs = runWithStep(ctx, stepDir, { ac: dir });
                    setRunResult(buildStepResult('ac', runs, parsed, stepDir));
                } else if (analysis === 'dc') {
                    const dir = parsed.directives.find((d) => d.kind === 'dc');
                    if (!dir) {
                        throw new Error('DC sweep needs a .dc directive — e.g. `.dc Vin 0 3.3 0.01`.');
                    }
                    const runs = runWithStep(ctx, stepDir, { dc: dir });
                    setRunResult(buildStepResult('dc', runs, parsed, stepDir));
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
                    {doc.components.length > 0 && (
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

            <div className="cs-body cs-body-phase3">
                <div className="cs-pane cs-pane-palette">
                    <div className="cs-pane-title">
                        <LayoutGrid size={13} /> Components
                    </div>
                    <Palette onPick={(partId) => {
                        // Click-to-place centres the new part near the
                        // middle of the current canvas.
                        mutateDoc((d) => { addComponent(d, partId, 200, 160, 0); });
                    }} />
                </div>

                <div className="cs-pane cs-pane-stage">
                    <Canvas
                        doc={doc}
                        selectedId={selection}
                        onSelect={setSelection}
                        onCommand={handleCommand}
                        onDocChange={mutateDoc}
                        resolvedNets={resolvedNets}
                    />

                    {/* Optional bottom drawer: results + netlist source */}
                    <div className={`cs-drawer${showResults ? ' is-open' : ''}`}>
                        <div className="cs-drawer-tabs">
                            <button
                                type="button"
                                className="cs-drawer-tab is-active"
                                onClick={() => setShowResults(!showResults)}
                            >
                                <Activity size={12} /> Results
                                {showResults ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                            </button>
                            <button
                                type="button"
                                className={`cs-drawer-tab${showNetlistDrawer ? ' is-on' : ''}`}
                                onClick={() => setShowNetlistDrawer((s) => !s)}
                                title="View / edit the raw SPICE netlist"
                            >
                                <Terminal size={12} /> Netlist source
                            </button>
                            {parsed?.errors?.length > 0 && (
                                <span className="cs-pane-err">· {parsed.errors.length} parse error{parsed.errors.length > 1 ? 's' : ''}</span>
                            )}
                        </div>
                        {showResults && (
                            <div className="cs-drawer-body">
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
                                        cursorA={cursorA}
                                        cursorB={cursorB}
                                        onCursorAChange={setCursorA}
                                        onCursorBChange={setCursorB}
                                        activeCursor={activeCursor}
                                        onActiveCursorChange={setActiveCursor}
                                        showMeasure={showMeasure}
                                        onShowMeasureChange={setShowMeasure}
                                    />
                                )}
                                {!runError && !runResult && (
                                    <div className="cs-empty">
                                        Hit <b>Run</b> to solve. DC gives node voltages; AC gives a Bode plot; Transient plots V(node) vs. time.
                                    </div>
                                )}
                            </div>
                        )}
                        {showNetlistDrawer && (
                            <div className="cs-source-drawer">
                                <div className="cs-source-drawer-top">
                                    <span>SPICE netlist (editable — hit Apply to re-import)</span>
                                    <button className="cs-topbtn" onClick={applyNetlistDraft}>
                                        <RefreshCw size={12} /> Apply
                                    </button>
                                </div>
                                <textarea
                                    className="cs-netlist-editor"
                                    spellCheck={false}
                                    value={netlistDraft}
                                    onChange={(e) => setNetlistDraft(e.target.value)}
                                />
                            </div>
                        )}
                    </div>
                </div>

                <div className="cs-pane cs-pane-inspector">
                    <div className="cs-pane-title">
                        <SlidersHorizontal size={13} /> Inspector
                    </div>
                    <Inspector
                        selectedComp={selectedComp}
                        onUpdate={(patch) => selectedComp && mutateDoc((d) => updateComponent(d, selectedComp.id, patch))}
                        onRotate={() => selectedComp && mutateDoc((d) => rotateComponent(d, selectedComp.id, 90))}
                        onDelete={() => {
                            if (!selectedComp) return;
                            mutateDoc((d) => removeComponent(d, selectedComp.id));
                            setSelection(null);
                        }}
                        netWarnings={buildNetWarnings(resolvedNets, doc)}
                        analysisPane={tourOpen && activeTour ? (
                            <div className="cs-inspector-tour">
                                <div className="cs-inspector-title">
                                    <BookOpen size={12} /> Guided tour · Step {tourStep + 1}/{activeTour.length}
                                </div>
                                <div className="cs-tour-step-title">{activeTour[tourStep]?.title}</div>
                                <div className="cs-tour-step-body">{activeTour[tourStep]?.body}</div>
                                <div className="cs-tour-nav">
                                    <button className="cs-topbtn" onClick={() => setTourStep((s) => Math.max(0, s - 1))} disabled={tourStep === 0}>
                                        <ChevronLeft size={12} /> Back
                                    </button>
                                    <button className="cs-topbtn cs-topbtn-primary"
                                        onClick={() => {
                                            if (tourStep + 1 < activeTour.length) setTourStep(tourStep + 1);
                                            else setTourOpen(false);
                                        }}>
                                        {tourStep + 1 >= activeTour.length ? 'Finish' : <>Next <ChevronRight size={12} /></>}
                                    </button>
                                </div>
                            </div>
                        ) : null}
                    />
                </div>
            </div>
        </div>
    );
}

function buildNetWarnings(nets, doc) {
    if (!nets) return [];
    const out = [];
    for (const fp of nets.floatingPins || []) {
        const comp = doc.components.find((c) => c.id === fp.comp.id);
        if (!comp) continue;
        out.push(`Pin ${fp.pinId} of ${comp.ref} is floating — connect it or it'll cause a singular matrix.`);
    }
    return out;
}

/* ============================================================ */
/* Sub-components                                               */
/* ============================================================ */

const SchematicSvg = React.memo(function SchematicSvg({ layout, zoom }) {
    const { width, height, offsetX, offsetY, components, wires, junctions, nodes, nodeColor } = layout;

    // Shared wire colour (monochrome = classic schematic look); nodes
    // still carry their tinted pips and labels so signals stay
    // visually distinguishable.
    const wireStroke = 'var(--sch-wire)';

    return (
        <div className="cs-schematic-scroller">
            <svg
                viewBox={`0 0 ${width} ${height}`}
                width={width * zoom}
                height={height * zoom}
                className="cs-schematic-svg"
                shapeRendering="geometricPrecision"
            >
                <g transform={`translate(${offsetX}, ${offsetY})`}>
                    {/* Wires — drawn first so components render on top */}
                    {wires.map((w, i) => (
                        <polyline
                            key={`w-${i}`}
                            points={w.points.map((p) => `${p[0]},${p[1]}`).join(' ')}
                            fill="none"
                            stroke={wireStroke}
                            strokeWidth={1.8}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    ))}

                    {/* Junction dots where three or more wires meet */}
                    {junctions.map((j, i) => (
                        <circle key={`j-${i}`} cx={j.x} cy={j.y} r={3.2} fill={wireStroke} />
                    ))}

                    {/* Node labels (the coloured signal names) */}
                    {nodes.map((n) => (
                        <NodeLabel key={`nl-${n.id}`} node={n} color={nodeColor.get(n.id) || '#64748b'} />
                    ))}

                    {/* Components */}
                    {components.map((c) => (
                        <ComponentSymbol key={`c-${c.index}`} comp={c} />
                    ))}
                </g>
            </svg>
        </div>
    );
});

function NodeLabel({ node, color }) {
    if (node.isGround) {
        return (
            <g transform={`translate(${node.x}, ${node.y})`}>
                <line x1={0} y1={-10} x2={0} y2={0} stroke="var(--sch-wire)" strokeWidth={1.8} />
                <line x1={-10} y1={0} x2={10} y2={0} stroke="var(--sch-wire)" strokeWidth={2.2} />
                <line x1={-7} y1={4} x2={7} y2={4} stroke="var(--sch-wire)" strokeWidth={1.8} />
                <line x1={-4} y1={8} x2={4} y2={8} stroke="var(--sch-wire)" strokeWidth={1.8} />
                <text x={0} y={22} fontSize={10} textAnchor="middle" fill="var(--sch-gnd-label)">GND</text>
            </g>
        );
    }
    return (
        <g transform={`translate(${node.x}, ${node.y})`}>
            <text x={8} y={-6} fontSize={10} fill={color} fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
                {node.label}
            </text>
        </g>
    );
}

function ComponentSymbol({ comp }) {
    const { x, y, rot, sym, labelRef, labelVal } = comp;
    const transform = `translate(${x}, ${y}) rotate(${rot})`;
    return (
        <g className={`cs-comp cs-comp-${comp.type}`}>
            <g transform={transform}>
                {sym.shapes.map((s, i) => renderShape(s, i))}
            </g>
            {labelRef ? (
                <text
                    x={labelRef.x}
                    y={labelRef.y}
                    textAnchor={labelRef.anchor}
                    fontSize={11}
                    fontWeight={600}
                    fill="var(--sch-label)"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                    {labelRef.text}
                </text>
            ) : null}
            {labelVal && labelVal.text ? (
                <text
                    x={labelVal.x}
                    y={labelVal.y}
                    textAnchor={labelVal.anchor}
                    fontSize={10}
                    fill="var(--sch-label-dim)"
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                    {labelVal.text}
                </text>
            ) : null}
        </g>
    );
}

function renderShape(s, key) {
    const strokeColor = 'var(--sch-stroke)';
    const strokeWidth = s.strokeWidth ?? 1.6;
    switch (s.kind) {
        case 'line':
            return (
                <line
                    key={key}
                    x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                    stroke={strokeColor}
                    strokeWidth={strokeWidth}
                    strokeDasharray={s.strokeDasharray}
                    strokeLinecap="round"
                />
            );
        case 'path':
            return (
                <path
                    key={key}
                    d={s.d}
                    fill={s.fill === 'var(--sch-stroke)' ? 'var(--sch-stroke)'
                         : s.fill === 'var(--sch-body)'  ? 'var(--sch-body)'
                         : s.fill || 'none'}
                    stroke={s.fill === 'var(--sch-stroke)' ? 'none' : strokeColor}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            );
        case 'circle':
            return (
                <circle
                    key={key}
                    cx={s.cx} cy={s.cy} r={s.r}
                    fill={s.fill || 'none'}
                    stroke={strokeColor}
                    strokeWidth={strokeWidth}
                />
            );
        case 'polarity':
            return (
                <text
                    key={key}
                    x={s.x} y={s.y}
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize={13} fontWeight={700}
                    fill={strokeColor}
                    fontFamily="serif"
                >
                    {s.sign}
                </text>
            );
        case 'text':
            return (
                <text
                    key={key}
                    x={s.x} y={s.y}
                    textAnchor={s.anchor || 'middle'}
                    dominantBaseline={s.baseline || 'middle'}
                    fontSize={s.fontSize || 11}
                    fontWeight={s.fontWeight || 500}
                    fill={strokeColor}
                    fontFamily={s.fontFamily || 'ui-sans-serif, system-ui, sans-serif'}
                >
                    {s.text}
                </text>
            );
        case 'arrow': {
            const size = s.size || 6;
            const dx = s.dir === 'R' ? size : s.dir === 'L' ? -size : 0;
            const dy = s.dir === 'D' ? size : s.dir === 'U' ? -size : 0;
            const perpX = -dy, perpY = dx;
            const points = [
                [s.x, s.y],
                [s.x - dx + perpX * 0.5, s.y - dy + perpY * 0.5],
                [s.x - dx - perpX * 0.5, s.y - dy - perpY * 0.5],
            ].map((p) => p.join(',')).join(' ');
            return (
                <polygon key={key} points={points} fill={strokeColor} />
            );
        }
        default:
            return null;
    }
}

function ResultsPanel({
    result, selectedSignals, onSignalsChange,
    cursorA, cursorB, onCursorAChange, onCursorBChange,
    activeCursor, onActiveCursorChange,
    showMeasure, onShowMeasureChange,
}) {
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

    // ---- Click-and-drag cursors: recharts' onMouseDown/Move give us
    // `activeLabel` in data-space directly, which dodges the pain of
    // computing plot-area pixel offsets for log-scale AC plots. ----

    const pickNearest = (x) => {
        if (cursorA == null) return 'A';
        if (cursorB == null) return 'B';
        const scale = (v) => (result.kind === 'ac' ? Math.log10(Math.max(v, 1e-18)) : v);
        return Math.abs(scale(x) - scale(cursorA)) <= Math.abs(scale(x) - scale(cursorB)) ? 'A' : 'B';
    };
    const handleMouseDown = (ev) => {
        if (!ev || typeof ev.activeLabel !== 'number') return;
        const x = ev.activeLabel;
        const which = pickNearest(x);
        if (which === 'A') onCursorAChange(x); else onCursorBChange(x);
        onActiveCursorChange(which);
    };
    const handleMouseMove = (ev) => {
        if (!activeCursor) return;
        if (!ev || typeof ev.activeLabel !== 'number') return;
        if (activeCursor === 'A') onCursorAChange(ev.activeLabel);
        else onCursorBChange(ev.activeLabel);
    };
    const handleMouseUp = () => onActiveCursorChange(null);

    const cursorStroke = { A: '#f59e0b', B: '#22d3ee' };

    if (result.kind === 'dc') {
        const x = result.x;
        const data = new Array(x.length);
        for (let i = 0; i < x.length; i++) {
            const row = { x: x[i] };
            for (const s of result.signals) row[s.name] = s.y[i];
            data[i] = row;
        }
        return (
            <div className="cs-plot-wrap">
                <div className="cs-plot-header">
                    <SignalChips result={result} selected={selectedSignals} onToggle={toggle} />
                    <button
                        className={`cs-topbtn${showMeasure ? ' is-active' : ''}`}
                        onClick={() => onShowMeasureChange(!showMeasure)}
                        title="Toggle cursor readouts"
                    >
                        <SlidersHorizontal size={12} /> Measure
                    </button>
                </div>
                <div
                    className={`cs-chart-outer${activeCursor ? ' is-dragging' : ''}`}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                >
                    <ResponsiveContainer width="100%" height={260}>
                        <LineChart
                            data={data}
                            margin={{ top: 10, right: 24, left: 6, bottom: 6 }}
                            onMouseDown={handleMouseDown}
                            onMouseMove={handleMouseMove}
                        >
                            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                            <XAxis
                                dataKey="x" type="number" scale="linear" domain={['auto', 'auto']}
                                tickFormatter={(v) => formatSIValue(v, 'V')}
                                label={{ value: result.xSource, position: 'insideBottom', dy: 12, fontSize: 11 }}
                            />
                            <YAxis
                                tickFormatter={(v) => formatSIValue(v, 'V')}
                                label={{ value: 'V(node)', angle: -90, position: 'insideLeft', fontSize: 11 }}
                            />
                            <Tooltip
                                formatter={(v) => formatSIValue(v, 'V')}
                                labelFormatter={(v) => `${result.xSource} = ${formatSIValue(v, 'V')}`}
                            />
                            <Legend />
                            {showMeasure && cursorA != null && (
                                <ReferenceLine x={cursorA} stroke={cursorStroke.A} strokeDasharray="4 4" strokeWidth={1.5}
                                    label={{ value: 'A', position: 'top', fill: cursorStroke.A, fontSize: 11, fontWeight: 700 }} />
                            )}
                            {showMeasure && cursorB != null && (
                                <ReferenceLine x={cursorB} stroke={cursorStroke.B} strokeDasharray="4 4" strokeWidth={1.5}
                                    label={{ value: 'B', position: 'top', fill: cursorStroke.B, fontSize: 11, fontWeight: 700 }} />
                            )}
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
                {showMeasure && (
                    <DcMeasurePanel
                        result={result}
                        selectedSignals={selectedSignals}
                        cursorA={cursorA}
                        cursorB={cursorB}
                    />
                )}
            </div>
        );
    }

    if (result.kind === 'tran') {
        const t = result.t;
        const data = new Array(t.length);
        for (let i = 0; i < t.length; i++) {
            const row = { t: t[i] };
            for (const s of result.signals) row[s.name] = s.y[i];
            data[i] = row;
        }
        return (
            <div className="cs-plot-wrap">
                <div className="cs-plot-header">
                    <SignalChips result={result} selected={selectedSignals} onToggle={toggle} />
                    <button
                        className={`cs-topbtn${showMeasure ? ' is-active' : ''}`}
                        onClick={() => onShowMeasureChange(!showMeasure)}
                        title="Toggle cursor & auto-measure panel"
                    >
                        <SlidersHorizontal size={12} /> Measure
                    </button>
                </div>
                <div
                    className={`cs-chart-outer${activeCursor ? ' is-dragging' : ''}`}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                >
                    <ResponsiveContainer width="100%" height={260}>
                        <LineChart
                            data={data}
                            margin={{ top: 10, right: 24, left: 6, bottom: 6 }}
                            onMouseDown={handleMouseDown}
                            onMouseMove={handleMouseMove}
                        >
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
                            {showMeasure && cursorA != null && (
                                <ReferenceLine x={cursorA} stroke={cursorStroke.A} strokeDasharray="4 4" strokeWidth={1.5}
                                    label={{ value: 'A', position: 'top', fill: cursorStroke.A, fontSize: 11, fontWeight: 700 }} />
                            )}
                            {showMeasure && cursorB != null && (
                                <ReferenceLine x={cursorB} stroke={cursorStroke.B} strokeDasharray="4 4" strokeWidth={1.5}
                                    label={{ value: 'B', position: 'top', fill: cursorStroke.B, fontSize: 11, fontWeight: 700 }} />
                            )}
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
                {showMeasure && (
                    <MeasurePanel
                        result={result}
                        selectedSignals={selectedSignals}
                        cursorA={cursorA}
                        cursorB={cursorB}
                    />
                )}
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
                <div className="cs-plot-header">
                    <SignalChips result={result} selected={selectedSignals} onToggle={toggle} />
                    <button
                        className={`cs-topbtn${showMeasure ? ' is-active' : ''}`}
                        onClick={() => onShowMeasureChange(!showMeasure)}
                        title="Toggle cursor & auto-measure panel"
                    >
                        <SlidersHorizontal size={12} /> Measure
                    </button>
                </div>
                <div
                    className={`cs-chart-outer cs-chart-bode${activeCursor ? ' is-dragging' : ''}`}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                >
                    <div className="cs-bode-wrap">
                        <ResponsiveContainer width="100%" height={160}>
                            <LineChart
                                data={mag}
                                margin={{ top: 10, right: 24, left: 6, bottom: 6 }}
                                onMouseDown={handleMouseDown}
                                onMouseMove={handleMouseMove}
                            >
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
                                {showMeasure && cursorA != null && (
                                    <ReferenceLine x={cursorA} stroke={cursorStroke.A} strokeDasharray="4 4" strokeWidth={1.5}
                                        label={{ value: 'A', position: 'top', fill: cursorStroke.A, fontSize: 11, fontWeight: 700 }} />
                                )}
                                {showMeasure && cursorB != null && (
                                    <ReferenceLine x={cursorB} stroke={cursorStroke.B} strokeDasharray="4 4" strokeWidth={1.5}
                                        label={{ value: 'B', position: 'top', fill: cursorStroke.B, fontSize: 11, fontWeight: 700 }} />
                                )}
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
                            <LineChart
                                data={phase}
                                margin={{ top: 6, right: 24, left: 6, bottom: 6 }}
                                onMouseDown={handleMouseDown}
                                onMouseMove={handleMouseMove}
                            >
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
                                {showMeasure && cursorA != null && (
                                    <ReferenceLine x={cursorA} stroke={cursorStroke.A} strokeDasharray="4 4" strokeWidth={1.5} />
                                )}
                                {showMeasure && cursorB != null && (
                                    <ReferenceLine x={cursorB} stroke={cursorStroke.B} strokeDasharray="4 4" strokeWidth={1.5} />
                                )}
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
                {showMeasure && (
                    <MeasurePanel
                        result={result}
                        selectedSignals={selectedSignals}
                        cursorA={cursorA}
                        cursorB={cursorB}
                    />
                )}
            </div>
        );
    }
    return null;
}

/** Δ-cursor readout + per-signal auto-measurements, shown below the
 *  main plot. Transient gets rise/fall/settling/overshoot; AC gets
 *  peak gain / −3 dB corner / unity-gain freq / phase margin. */
function MeasurePanel({ result, selectedSignals, cursorA, cursorB }) {
    const isAC = result.kind === 'ac';
    const xUnit = isAC ? 'Hz' : 's';
    const xOf = (sig) => (isAC ? sig.f : sig.t);
    const yOf = (sig) => (isAC ? sig.mag : sig.y);
    const yUnit = isAC ? '' : 'V';

    const sigs = result.signals.filter((s) => selectedSignals.includes(s.name));

    // ---- Cursor readouts ----
    const aRow = cursorA != null;
    const bRow = cursorB != null;
    const dx = (aRow && bRow) ? (cursorB - cursorA) : null;
    const absDx = dx != null ? Math.abs(dx) : null;

    return (
        <div className="cs-measure-panel">
            <div className="cs-measure-col">
                <div className="cs-measure-title">Cursors</div>
                <table className="cs-measure-table">
                    <thead>
                        <tr>
                            <th style={{ width: 42 }}></th>
                            <th>x</th>
                            {sigs.map((s, i) => (
                                <th key={s.name} style={{ color: SIGNAL_COLORS[i % SIGNAL_COLORS.length] }}>{s.name}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td className="cs-cursor-tag" style={{ color: '#f59e0b' }}>A</td>
                            <td className="cs-mono">{aRow ? formatSIValue(cursorA, xUnit) : '—'}</td>
                            {sigs.map((s) => (
                                <td key={s.name} className="cs-mono">
                                    {aRow ? formatYAtX(xOf(s), yOf(s), cursorA, yUnit, isAC) : '—'}
                                </td>
                            ))}
                        </tr>
                        <tr>
                            <td className="cs-cursor-tag" style={{ color: '#22d3ee' }}>B</td>
                            <td className="cs-mono">{bRow ? formatSIValue(cursorB, xUnit) : '—'}</td>
                            {sigs.map((s) => (
                                <td key={s.name} className="cs-mono">
                                    {bRow ? formatYAtX(xOf(s), yOf(s), cursorB, yUnit, isAC) : '—'}
                                </td>
                            ))}
                        </tr>
                        <tr className="cs-measure-delta">
                            <td>Δ</td>
                            <td className="cs-mono">{dx != null ? formatSIValue(dx, xUnit) : '—'}</td>
                            {sigs.map((s) => {
                                if (!aRow || !bRow) return <td key={s.name}>—</td>;
                                const yA = sampleAt(xOf(s), yOf(s), cursorA);
                                const yB = sampleAt(xOf(s), yOf(s), cursorB);
                                const dy = yB - yA;
                                return (
                                    <td key={s.name} className="cs-mono">
                                        {isAC ? formatDbDelta(yA, yB) : formatSIValue(dy, yUnit)}
                                    </td>
                                );
                            })}
                        </tr>
                        {!isAC && absDx && absDx > 0 && (
                            <tr className="cs-measure-delta">
                                <td>1/Δx</td>
                                <td className="cs-mono" colSpan={1 + sigs.length}>{formatSIValue(1 / absDx, 'Hz')}</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
            <div className="cs-measure-col">
                <div className="cs-measure-title">Auto-measure</div>
                <table className="cs-measure-table">
                    <thead>
                        {isAC ? (
                            <tr>
                                <th>Signal</th>
                                <th>Peak</th>
                                <th>−3 dB</th>
                                <th>Unity f</th>
                                <th>Phase margin</th>
                            </tr>
                        ) : (
                            <tr>
                                <th>Signal</th>
                                <th>Steady</th>
                                <th>Vpp</th>
                                <th>Rise</th>
                                <th>Settle 5%</th>
                                <th>Over%</th>
                            </tr>
                        )}
                    </thead>
                    <tbody>
                        {sigs.map((s, i) => (
                            <tr key={s.name}>
                                <td style={{ color: SIGNAL_COLORS[i % SIGNAL_COLORS.length] }}>{s.name}</td>
                                {isAC ? <AcMeasureCells sig={s} /> : <TranMeasureCells sig={s} />}
                            </tr>
                        ))}
                        {sigs.length === 0 && (
                            <tr><td colSpan={isAC ? 5 : 6} className="cs-empty-cell">Pick a signal above.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/** DC-sweep variant of the measurement panel — cursors read X (sweep
 *  voltage) and Y values for each signal; no auto-measurement yet
 *  because "interesting" DC metrics (switching threshold, gain at
 *  midpoint) are device-specific. */
function DcMeasurePanel({ result, selectedSignals, cursorA, cursorB }) {
    const sigs = result.signals.filter((s) => selectedSignals.includes(s.name));
    const aRow = cursorA != null;
    const bRow = cursorB != null;
    const dx = (aRow && bRow) ? (cursorB - cursorA) : null;

    return (
        <div className="cs-measure-panel">
            <div className="cs-measure-col">
                <div className="cs-measure-title">Cursors ({result.xSource})</div>
                <table className="cs-measure-table">
                    <thead>
                        <tr>
                            <th style={{ width: 42 }}></th>
                            <th>{result.xSource}</th>
                            {sigs.map((s, i) => (
                                <th key={s.name} style={{ color: SIGNAL_COLORS[i % SIGNAL_COLORS.length] }}>{s.name}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td className="cs-cursor-tag" style={{ color: '#f59e0b' }}>A</td>
                            <td className="cs-mono">{aRow ? formatSIValue(cursorA, 'V') : '—'}</td>
                            {sigs.map((s) => (
                                <td key={s.name} className="cs-mono">
                                    {aRow ? formatSIValue(sampleAt(s.x, s.y, cursorA), 'V') : '—'}
                                </td>
                            ))}
                        </tr>
                        <tr>
                            <td className="cs-cursor-tag" style={{ color: '#22d3ee' }}>B</td>
                            <td className="cs-mono">{bRow ? formatSIValue(cursorB, 'V') : '—'}</td>
                            {sigs.map((s) => (
                                <td key={s.name} className="cs-mono">
                                    {bRow ? formatSIValue(sampleAt(s.x, s.y, cursorB), 'V') : '—'}
                                </td>
                            ))}
                        </tr>
                        <tr className="cs-measure-delta">
                            <td>Δ</td>
                            <td className="cs-mono">{dx != null ? formatSIValue(dx, 'V') : '—'}</td>
                            {sigs.map((s) => {
                                if (!aRow || !bRow) return <td key={s.name}>—</td>;
                                const yA = sampleAt(s.x, s.y, cursorA);
                                const yB = sampleAt(s.x, s.y, cursorB);
                                const dy = yB - yA;
                                const gain = dx ? dy / dx : null;
                                return (
                                    <td key={s.name} className="cs-mono" title={gain != null ? `slope = ${gain.toFixed(3)} V/V` : ''}>
                                        {formatSIValue(dy, 'V')}{gain != null ? ` (${gain.toPrecision(3)} V/V)` : ''}
                                    </td>
                                );
                            })}
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function TranMeasureCells({ sig }) {
    const ss = steadyStateEst(sig.y);
    const pp = peakToPeak(sig.y);
    const rt = riseTime(sig.t, sig.y);
    const ft = fallTime(sig.t, sig.y);
    const st = settlingTime(sig.t, sig.y, 0.05);
    const os = overshoot(sig.y);
    return (
        <>
            <td className="cs-mono">{Number.isFinite(ss) ? formatSIValue(ss, 'V') : '—'}</td>
            <td className="cs-mono">{Number.isFinite(pp) ? formatSIValue(pp, 'V') : '—'}</td>
            <td className="cs-mono">
                {Number.isFinite(rt) ? formatSIValue(rt, 's')
                    : Number.isFinite(ft) ? `↓ ${formatSIValue(ft, 's')}` : '—'}
            </td>
            <td className="cs-mono">{Number.isFinite(st) ? formatSIValue(st, 's') : '—'}</td>
            <td className="cs-mono">{Number.isFinite(os) ? `${os.toFixed(1)}%` : '—'}</td>
        </>
    );
}

function AcMeasureCells({ sig }) {
    const pg = peakGain(sig.mag);
    const c3 = corner3dB(sig.f, sig.mag);
    const ug = unityGainFreq(sig.f, sig.mag);
    const pm = phaseMargin(sig.f, sig.mag, sig.phase);
    return (
        <>
            <td className="cs-mono">{Number.isFinite(pg) ? `${pg.toFixed(1)} dB` : '—'}</td>
            <td className="cs-mono">{Number.isFinite(c3) ? formatSIValue(c3, 'Hz') : '—'}</td>
            <td className="cs-mono">{Number.isFinite(ug) ? formatSIValue(ug, 'Hz') : '—'}</td>
            <td className="cs-mono">{Number.isFinite(pm) ? `${pm.toFixed(1)}°` : '—'}</td>
        </>
    );
}

function formatYAtX(xArr, yArr, x, unit, isAC) {
    if (xArr == null || yArr == null) return '—';
    const y = sampleAt(xArr, yArr, x);
    if (!Number.isFinite(y)) return '—';
    if (isAC) {
        const db = 20 * Math.log10(Math.max(Math.abs(y), 1e-18));
        return `${db.toFixed(2)} dB`;
    }
    return formatSIValue(y, unit);
}

function formatDbDelta(yA, yB) {
    if (!Number.isFinite(yA) || !Number.isFinite(yB)) return '—';
    const dbA = 20 * Math.log10(Math.max(Math.abs(yA), 1e-18));
    const dbB = 20 * Math.log10(Math.max(Math.abs(yB), 1e-18));
    return `${(dbB - dbA).toFixed(2)} dB`;
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

/** Merge the per-step run outputs from `runWithStep` into the single
 *  signal-array shape that the plot + measurement components expect.
 *
 *  Strategy:
 *    - Single run (no .step): behaves exactly like before, emits one
 *      signal per circuit node.
 *    - N-run .step sweep: emits N signals *per node*, each suffixed
 *      with the step value (e.g. "V(vout) @R1=1k", "V(vout) @R1=2k",
 *      …). Downstream code doesn't need to know about .step — it
 *      just sees more signals and renders a family of curves. The
 *      x-axis (t or f) uses the last run, which is always identical
 *      across runs for the same analysis directive. */
function buildStepResult(kind, runs, parsed, stepDir) {
    if (!runs || runs.length === 0) {
        throw new Error('Run returned no results.');
    }
    const isMulti = runs.length > 1;
    const signals = [];

    if (kind === 'tran') {
        const tRef = runs[0].tran.t;
        for (let r = 0; r < runs.length; r++) {
            const res = runs[r].tran;
            const suffix = isMulti
                ? ` @${stepDir.target}=${formatStepValue(runs[r].stepValue)}`
                : '';
            for (let i = 1; i < parsed.nNodes; i++) {
                signals.push({
                    name: `V(${parsed.nodeNames[i] || 'n' + i})${suffix}`,
                    kind: 'tran',
                    t: res.t,
                    y: res.nodeV[i - 1],
                    stepValue: runs[r].stepValue,
                    baseNode: parsed.nodeNames[i] || `n${i}`,
                });
            }
        }
        return {
            kind: 'tran',
            t: tRef,
            signals,
            step: isMulti ? { target: stepDir.target, values: runs.map((r) => r.stepValue) } : null,
        };
    }

    if (kind === 'ac') {
        const fRef = runs[0].ac.freqs;
        for (let r = 0; r < runs.length; r++) {
            const res = runs[r].ac;
            const suffix = isMulti
                ? ` @${stepDir.target}=${formatStepValue(runs[r].stepValue)}`
                : '';
            for (let i = 1; i < parsed.nNodes; i++) {
                const samples = res.V[i - 1];
                signals.push({
                    name: `V(${parsed.nodeNames[i] || 'n' + i})${suffix}`,
                    kind: 'ac',
                    f: res.freqs,
                    mag: samples.map((s) => Math.hypot(s.re, s.im)),
                    phase: samples.map((s) => Math.atan2(s.im, s.re) * 180 / Math.PI),
                    stepValue: runs[r].stepValue,
                    baseNode: parsed.nodeNames[i] || `n${i}`,
                });
            }
        }
        return {
            kind: 'ac',
            f: fRef,
            signals,
            step: isMulti ? { target: stepDir.target, values: runs.map((r) => r.stepValue) } : null,
        };
    }

    if (kind === 'dc') {
        const xRef = runs[0].dc.sweepValues;
        const src = runs[0].dc.src;
        for (let r = 0; r < runs.length; r++) {
            const res = runs[r].dc;
            const suffix = isMulti
                ? ` @${stepDir.target}=${formatStepValue(runs[r].stepValue)}`
                : '';
            for (let i = 1; i < parsed.nNodes; i++) {
                signals.push({
                    name: `V(${parsed.nodeNames[i] || 'n' + i})${suffix}`,
                    kind: 'dc',
                    x: res.sweepValues,
                    y: res.nodeV[i - 1],
                    stepValue: runs[r].stepValue,
                    baseNode: parsed.nodeNames[i] || `n${i}`,
                });
            }
        }
        return {
            kind: 'dc',
            x: xRef,
            xSource: src,
            signals,
            step: isMulti ? { target: stepDir.target, values: runs.map((r) => r.stepValue) } : null,
        };
    }

    throw new Error(`buildStepResult: unsupported kind ${kind}`);
}

function formatStepValue(v) {
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs === 0) return '0';
    if (abs >= 1e9) return `${(v / 1e9).toPrecision(3)}G`;
    if (abs >= 1e6) return `${(v / 1e6).toPrecision(3)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toPrecision(3)}k`;
    if (abs >= 1) return v.toPrecision(3);
    if (abs >= 1e-3) return `${(v / 1e-3).toPrecision(3)}m`;
    if (abs >= 1e-6) return `${(v / 1e-6).toPrecision(3)}u`;
    if (abs >= 1e-9) return `${(v / 1e-9).toPrecision(3)}n`;
    if (abs >= 1e-12) return `${(v / 1e-12).toPrecision(3)}p`;
    return v.toExponential(2);
}

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
