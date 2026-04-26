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
    BookOpen, Copy, Plus, FileText, Activity, Monitor,
    SlidersHorizontal, LayoutGrid, Terminal, Undo, Redo,
    Save, FolderOpen, FilePlus, Download, Image as ImageIcon, FileJson, Trash2,
    Maximize2, Minimize2, Layers, CircuitBoard,
} from 'lucide-react';
import { parseNetlist } from '../circuit/netlist.js';
import { buildContext, solveDC, runWithStep } from '../circuit/solver.js';
import {
    buildMonteAcResult, runMonteAcSamples, buildMonteMetaFromRuns,
} from '../circuit/monteCarlo.js';
import { goalSeekAcStabilityTarget } from '../circuit/goalSeek.js';
import {
    mergeDerivedSignals, voltageProbeNetFromSignalName, findVoltageSignalForNet,
} from '../circuit/signalMath.js';
import { DEMOS } from '../circuit/demos.js';
import {
    riseTime, fallTime, settlingTime, overshoot, peakToPeak, steadyStateEst,
    corner3dB, peakGain, unityGainFreq, phaseMargin, gainMargin, sampleAt,
} from '../circuit/measurements.js';
import {
    emptyDoc, resolveNets, addComponent, updateComponent, rotateComponent,
    removeComponent, removeWire, removeLabel, componentPins,
} from '../circuit/schematicDoc.js';
import { emitNetlist } from '../circuit/emitNetlist.js';
import { importNetlistToDoc } from '../circuit/importNetlist.js';
import Palette from './circuit/Palette.jsx';
import Canvas from './circuit/Canvas.jsx';
import PropertyPopup from './circuit/PropertyPopup.jsx';
import ScopeModal from './circuit/ScopeModal.jsx';
import ProjectManager from './circuit/ProjectManager.jsx';
import ModelLibraryModal from './circuit/ModelLibraryModal.jsx';
import { validateSchematic } from '../circuit/validate.js';
import {
    mergeDcConnectivityIssues,
    mergeSolverDiagnostic,
    diagnoseSolverRunFailure,
} from '../circuit/dcDiagnostics.js';
import Inspector from './circuit/Inspector.jsx';
import {
    loadInitialProject, saveProject, uniqueName,
    setCurrentProjectId, importProjectJson,
} from '../circuit/projects.js';
import { parseSiValue, formatSi, linspaceByStep } from '../circuit/siUnits.js';
import {
    exportProjectJson, exportSpiceNetlist, exportResultsCsv,
    exportCanvasSvg, exportCanvasPng,
} from '../circuit/exporters.js';
import { buildPcbBridgePayload, PCB_BRIDGE_KEY } from '../pcb/schematicBridge.js';
import {
    CROSS_SELECT_EVENT,
    broadcastCrossSelect,
    readCrossSelectPayload,
    collectSchematicCrossPayload,
} from '../pcb/crossSelectBridge.js';
import { buildUserLibraryPartsFromSpiceLibs } from '../circuit/userLibraryParts.js';
import { setUserLibrarySessionParts } from '../circuit/library.js';
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

function newSpiceLibRow() {
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `lib_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    return { id, name: '', content: '' };
}

function CircuitStudioPage({ onOpenPcbLayout }) {
    // Phase 3: the SchematicDoc is the source of truth. netlistText
    // is derived via emitNetlist(); we only store raw text for the
    // optional "source view" drawer and for home-page loads (demos).
    //
    // Projects layer (see src/circuit/projects.js): instead of a
    // single autosave slot we now track a list of named projects.
    // On boot we load the most-recently-updated project (migrating
    // the legacy single-slot blob if present), or start empty.
    const bootProject = (() => {
        try { return loadInitialProject(); } catch { return null; }
    })();

    const [currentProjectId, setCurrentProjectIdState] = useState(bootProject?.id || null);
    const [projectName, setProjectName] = useState(bootProject?.name || 'Untitled');
    // Manager modal (File → Open project…).
    const [projectManagerOpen, setProjectManagerOpen] = useState(false);
    // File-menu dropdown visibility.
    const [fileMenuOpen, setFileMenuOpen] = useState(false);

    const [docState, setDocState] = useState(() => {
        const initial = bootProject?.doc || emptyDoc();
        return { past: [], present: initial, future: [] };
    });
    const doc = docState.present;
    // { kind:'component'|'wire', id } | { kind:'multi', componentIds, wireIds, labelIds? }
    const [selection, setSelection] = useState(null);
    // Inline property popup state: target component + screen-space anchor
    // where the card renders. `null` when the popup is closed.
    const [editPopup, setEditPopup] = useState(null); // { compId, clientX, clientY }
    // Oscilloscope modal: double-clicking a SCOPE part opens this.
    // Also drives the live-streaming state below.
    const [scopeModal, setScopeModal] = useState(null); // { compId }
    // Partial results appended by the live transient runner. Cleared on
    // each Run. Shape: { t: number[], ySignals: Map<name, number[]> }.
    const [liveStream, setLiveStream] = useState(null);
    // Live transient toggle — when true, Run streams samples in as the
    // solver produces them so open scopes tick in real time.
    const [liveMode, setLiveMode] = useState(false);
    // Collapsible side panels — remembered per-user via localStorage so
    // the canvas-centric layout persists across reloads.
    const [paletteCollapsed, setPaletteCollapsed] = useState(
        () => {
            try { return localStorage.getItem('circuitStudio:paletteCollapsed') === 'true'; }
            catch { return false; }
        }
    );
    const [inspectorCollapsed, setInspectorCollapsed] = useState(
        () => {
            try { return localStorage.getItem('circuitStudio:inspectorCollapsed') === 'true'; }
            catch { return false; }
        }
    );
    useEffect(() => {
        try { localStorage.setItem('circuitStudio:paletteCollapsed', String(paletteCollapsed)); }
        catch { /* storage may be full; ignore */ }
    }, [paletteCollapsed]);
    useEffect(() => {
        try { localStorage.setItem('circuitStudio:inspectorCollapsed', String(inspectorCollapsed)); }
        catch { /* storage may be full; ignore */ }
    }, [inspectorCollapsed]);
    useEffect(() => {
        const onKey = (ev) => {
            // Ignore when the user is typing in an input / textarea.
            const t = ev.target;
            const tag = t && t.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
            if (!(ev.metaKey || ev.ctrlKey)) return;
            if (ev.key === '[') { setPaletteCollapsed((v) => !v); ev.preventDefault(); }
            else if (ev.key === ']') { setInspectorCollapsed((v) => !v); ev.preventDefault(); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

    const [showNetlistDrawer, setShowNetlistDrawer] = useState(false);
    const [showResults, setShowResults] = useState(true);
    /** Expand the Results plot strip to use most of the centre column (schematic shrinks). */
    const [resultsPlotMaximized, setResultsPlotMaximized] = useState(false);
    /** Bottom drawer main panel: standard plots vs. embedded oscilloscope. */
    const [drawerTab, setDrawerTab] = useState('results');

    useEffect(() => {
        if (!showResults || drawerTab !== 'results') setResultsPlotMaximized(false);
    }, [showResults, drawerTab]);

    useEffect(() => {
        if (!resultsPlotMaximized) return undefined;
        const onKey = (ev) => {
            if (ev.key !== 'Escape') return;
            const t = ev.target;
            const tag = t && t.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
            setResultsPlotMaximized(false);
            ev.preventDefault();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [resultsPlotMaximized]);

    /** Which SCOPE part the drawer "Scope" tab displays (when several exist). */
    const [scopeDrawerCompId, setScopeDrawerCompId] = useState(null);
    const [netlistDraft, setNetlistDraft] = useState(''); // user-edited raw text when drawer open
    // Bump this to ask the Canvas to fit-to-content. Only do this on
    // external load events (demo / blank / apply-netlist); incremental
    // editing keeps the viewport stable.
    const [fitNonce, setFitNonce] = useState(0);
    const [ampCoachDismissed, setAmpCoachDismissed] = useState(() => (
        typeof sessionStorage !== 'undefined' && sessionStorage.getItem('cs-amp-coach-dismiss') === '1'
    ));
    const dismissAmpCoach = useCallback(() => {
        try { sessionStorage.setItem('cs-amp-coach-dismiss', '1'); } catch { /* ignore */ }
        setAmpCoachDismissed(true);
    }, []);
    const [view, setView] = useState(() => (bootProject ? 'workspace' : 'home'));
    const [analysis, setAnalysis] = useState('tran');
    // User-editable transient settings — when non-null, these override
    // the parsed .tran directive from the netlist at run time. Stored
    // as strings (with SI prefixes allowed) so the input fields stay
    // exactly what the user typed; parseSiTime below converts to
    // seconds when handing off to the solver.
    const [tranOverride, setTranOverride] = useState(() => bootProject?.tranOverride || {
        tstop: '1m',
        tstep: '1u',
    });
    /** AC sweep: scale / point count / Hz range. Non-empty fields override parsed `.ac` at Run time. */
    const [acOverride, setAcOverride] = useState(() => bootProject?.acOverride || {
        mode: '',
        n: '',
        fStart: '',
        fStop: '',
    });
    // Parametric sweep (`.step PARAM` in SPICE-speak). When enabled,
    // the Run pipeline walks `target` from start → stop in step-sized
    // increments, collects per-iteration results, and hands them to
    // `buildStepResult` which names each trace "V(vout) @R1=1.2k" so
    // they land as a family of overlaid curves on the plot.
    //
    // Fields are kept as strings (with SI prefixes tolerated) to match
    // the transient-override pattern and avoid floating-point noise in
    // the inputs. An empty `target` means "use first sweepable
    // component at run time".
    const [sweep, setSweep] = useState({
        enabled: false,
        target: '',
        start: '100',
        stop: '1k',
        step: '100',
    });
    /** AC Monte Carlo: uniform ±tol% on each R/C/L, independent samples. Incompatible with parametric / `.step`. */
    const [monte, setMonte] = useState(() => bootProject?.monte || {
        enabled: false,
        runs: '30',
        tolPercent: '5',
        pmNode: 'vout',
    });
    /** AC thermal (Johnson) noise at a node — same frequency grid as the AC sweep; R only, 300 K. */
    const [acNoise, setAcNoise] = useState(() => bootProject?.acNoise || {
        enabled: false,
        outputNode: 'vout',
    });
    /** Bisection goal seek for AC phase or gain margin vs one sweepable element. */
    const [goalSeek, setGoalSeek] = useState(() => {
        const g = bootProject?.goalSeek;
        return {
            element: g?.element ?? '',
            lo: g?.lo ?? '',
            hi: g?.hi ?? '',
            target: g?.target ?? g?.targetPm ?? '45',
            observeNode: g?.observeNode ?? 'vout',
            metric: g?.metric === 'gm' ? 'gm' : 'pm',
        };
    });
    /** Last successful goal seek — enables Apply to schematic + copy. */
    const [goalSeekLast, setGoalSeekLast] = useState(null);
    /** Derived trace: combine two existing signals (tran / ac / dc). */
    const [traceMath, setTraceMath] = useState(() => bootProject?.traceMath || {
        enabled: false,
        op: 'minus',
        sigA: '',
        sigB: '',
    });
    /** SPICE fragments for `.include` / `.lib` — keyed by filename (basename match ok). */
    const [spiceLibs, setSpiceLibs] = useState(() => bootProject?.spiceLibs || []);
    const userLibraryPaletteParts = useMemo(
        () => buildUserLibraryPartsFromSpiceLibs(spiceLibs),
        [spiceLibs],
    );
    useEffect(() => {
        setUserLibrarySessionParts(userLibraryPaletteParts);
        return () => setUserLibrarySessionParts([]);
    }, [userLibraryPaletteParts]);
    const [modelLibOpen, setModelLibOpen] = useState(false);
    /** Net name (from `V(net)`) to highlight on the schematic while hovering signal chips. */
    const [plotHighlightNet, setPlotHighlightNet] = useState(null);
    /** Non-error AC helper message (e.g. goal seek result). */
    const [acStudioMessage, setAcStudioMessage] = useState('');
    const [runResult, setRunResult] = useState(null);
    const [runError, setRunError] = useState('');
    /** Pins / issues merged into Canvas after a failed Run (singular matrix, etc.). */
    const [solverRunDiagnostic, setSolverRunDiagnostic] = useState(null);
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

    // Autosave into the active project slot whenever the doc, name,
    // or run-time knobs change. We intentionally skip the empty doc
    // to avoid clobbering a good slot with a blank sheet that may
    // appear briefly during load / migration.
    useEffect(() => {
        if (!doc) return;
        // Only create a slot once the user has something to save —
        // this stops a bare boot from littering the manager with
        // "Untitled" cards.
        if ((doc.components?.length || 0) === 0 && !currentProjectId) return;
        try {
            const saved = saveProject({
                id: currentProjectId,
                name: projectName,
                doc,
                analysis,
                tranOverride,
                acOverride,
                sweep,
                monte,
                acNoise,
                goalSeek,
                traceMath,
                spiceLibs,
                selectedSignals,
            });
            if (!currentProjectId) {
                setCurrentProjectIdState(saved.id);
                setCurrentProjectId(saved.id);
            }
        } catch (e) {
            console.warn('autosave failed:', e);
        }
    // We deliberately leave selectedSignals / analysis / tranOverride
    // / sweep out of the dep array to avoid write storms during idle
    // UI tweaks; the next doc edit will flush them into the slot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [doc, projectName, currentProjectId]);

    // Emit SPICE netlist from the doc. This is what the solver runs,
    // what "Copy" copies, and what the source drawer shows when closed.
    // emitNetlist returns { text, nets, warnings } — we only surface the
    // rendered SPICE text here; warnings feed the inspector separately.
    const emitResult = useMemo(() => {
        if (!doc || doc.components.length === 0) {
            return { text: '', nets: null, warnings: [] };
        }
        try { return emitNetlist(doc); }
        catch (e) {
            return {
                text: `* emit error: ${e?.message || e}`,
                nets: null,
                warnings: [String(e?.message || e)],
            };
        }
    }, [doc]);
    const netlistText = typeof emitResult?.text === 'string' ? emitResult.text : '';

    // Sync netlist draft when drawer is shown (or doc changes).
    useEffect(() => {
        if (showNetlistDrawer) setNetlistDraft(netlistText);
    }, [showNetlistDrawer, netlistText]);

    const spiceIncludeFileMap = useMemo(() => {
        const m = {};
        for (const row of spiceLibs) {
            const k = String(row?.name || '').trim();
            if (k) m[k] = String(row?.content ?? '');
        }
        return m;
    }, [spiceLibs]);

    const handleQueueIncludeFromModelLib = useCallback((filename) => {
        setShowNetlistDrawer(true);
        setTimeout(() => {
            setNetlistDraft((d) => {
                const base = (typeof d === 'string' && d.trim()) ? d : netlistText;
                const needle = `.include "${filename}"`;
                if (base.includes(needle)) return typeof d === 'string' ? d : base;
                return `${String(base).trimEnd()}\n.include "${filename}"\n`;
            });
        }, 0);
    }, [netlistText]);

    const parsed = useMemo(() => {
        if (!netlistText || !netlistText.trim()) return null;
        try {
            return parseNetlist(netlistText, { includeFiles: spiceIncludeFileMap });
        }
        catch (e) { return { errors: [String(e?.message || e)], elements: [], directives: [], models: {}, nNodes: 1, nodeNames: ['0'] }; }
    }, [netlistText, spiceIncludeFileMap]);

    // Run net resolution once per doc change — Canvas + Inspector share it.
    const resolvedNets = useMemo(() => {
        try { return resolveNets(doc); }
        catch { return null; }
    }, [doc]);

    /** Highlights driven by PCB Studio selection (ref + net names). */
    const [pcbCrossHighlight, setPcbCrossHighlight] = useState({ refs: [], nets: [] });

    useEffect(() => {
        const apply = () => {
            const raw = readCrossSelectPayload();
            if (!raw || raw.from !== 'pcb') {
                setPcbCrossHighlight({ refs: [], nets: [] });
                return;
            }
            setPcbCrossHighlight({ refs: raw.refs || [], nets: raw.nets || [] });
        };
        apply();
        window.addEventListener(CROSS_SELECT_EVENT, apply);
        return () => window.removeEventListener(CROSS_SELECT_EVENT, apply);
    }, []);

    useEffect(() => {
        const { refs, nets } = collectSchematicCrossPayload(doc, resolvedNets, selection);
        broadcastCrossSelect({ from: 'schematic', refs, nets });
    }, [doc, resolvedNets, selection]);

    const boardCrossRefs = useMemo(
        () => new Set(pcbCrossHighlight.refs.map((r) => String(r).toUpperCase())),
        [pcbCrossHighlight.refs],
    );
    const boardCrossNets = useMemo(
        () => new Set(pcbCrossHighlight.nets.map((n) => String(n).toLowerCase())),
        [pcbCrossHighlight.nets],
    );

    // Design-rule check layered on top of resolvedNets. Feeds the canvas
    // (visual markers) and the results drawer (textual summary).
    const validation = useMemo(() => {
        try {
            const base = validateSchematic(doc, resolvedNets);
            if (parsed?.errors?.length === 0 && parsed?.elements?.length && resolvedNets) {
                return mergeDcConnectivityIssues(base, parsed, doc, resolvedNets);
            }
            return base;
        }
        catch { return null; }
    }, [doc, resolvedNets, parsed]);

    const canvasValidation = useMemo(
        () => mergeSolverDiagnostic(validation, solverRunDiagnostic),
        [validation, solverRunDiagnostic],
    );

    const scopeComponentsInDoc = useMemo(
        () => (doc?.components ?? []).filter((c) => c.elementType === 'SCOPE'),
        [doc?.components],
    );

    useEffect(() => {
        if (!scopeComponentsInDoc.length) {
            setScopeDrawerCompId(null);
            return;
        }
        setScopeDrawerCompId((prev) => {
            if (prev && scopeComponentsInDoc.some((c) => c.id === prev)) return prev;
            return scopeComponentsInDoc[0].id;
        });
    }, [scopeComponentsInDoc]);

    useEffect(() => {
        setSolverRunDiagnostic(null);
    }, [doc]);

    // Imperative helper passed to Canvas/Inspector — takes a function
    // (mutator) and applies it to a clone of the current doc.
    const mutateDoc = useCallback((mutator) => {
        setDocState((state) => {
            const copy = JSON.parse(JSON.stringify(state.present));
            mutator(copy);
            return {
                past: [...state.past, state.present].slice(-50),
                present: copy,
                future: []
            };
        });
    }, []);

    const handleUndo = useCallback(() => {
        setDocState((state) => {
            if (state.past.length === 0) return state;
            const previous = state.past[state.past.length - 1];
            const newPast = state.past.slice(0, -1);
            return {
                past: newPast,
                present: previous,
                future: [state.present, ...state.future]
            };
        });
    }, []);

    const handleRedo = useCallback(() => {
        setDocState((state) => {
            if (state.future.length === 0) return state;
            const next = state.future[0];
            const newFuture = state.future.slice(1);
            return {
                past: [...state.past, state.present],
                present: next,
                future: newFuture
            };
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
    //
    // Probes on the schematic take priority over demo defaults: if the
    // user placed a VP / IP, we auto-tick its signal (and its whole
    // .step family) so there's always something on the plot after Run.
    useEffect(() => {
        if (!runResult || !runResult.signals) return;
        const allSignals = runResult.signals;
        const all = allSignals.map((s) => s.name);

        // 1) Probe-driven preferences — derived from the schematic, not
        //    the demo catalog.
        //    VP / SCOPE → V(<tip node label>); IP → I(<ref>).
        //
        // We prefer the run-time pinSignalMap (stashed on runResult by
        // handleRun) over the live resolvedNets: the probe's
        // electrical attachment is what matters, and that snapshot is
        // guaranteed to match whatever `signals` actually contains.
        const probeWanted = [];
        if (doc) {
            const pinMap = runResult.pinSignalMap;
            for (const c of doc.components) {
                if (c.elementType === 'VP') {
                    const fromSnap = pinMap?.get(`${c.id}|tip`);
                    if (fromSnap) {
                        probeWanted.push(fromSnap);
                        continue;
                    }
                    if (resolvedNets) {
                        const nodeId = resolvedNets.pinNode(c, 'tip');
                        if (nodeId != null && nodeId !== 0) {
                            const lab = resolvedNets.nodeLabels?.get(nodeId);
                            const label = (lab && !/^n\d+$/i.test(lab) && lab !== 'gnd')
                                ? lab
                                : `n${nodeId}`;
                            probeWanted.push(`V(${label})`);
                        }
                    }
                } else if (c.elementType === 'SCOPE') {
                    const scopePins = c.scopeChannelMode === 'single' ? ['tip'] : ['tip', 'tip2'];
                    for (const pid of scopePins) {
                        const fromSnap = pinMap?.get(`${c.id}|${pid}`);
                        if (fromSnap) {
                            probeWanted.push(fromSnap);
                            continue;
                        }
                        if (resolvedNets) {
                            const nodeId = resolvedNets.pinNode(c, pid);
                            if (nodeId != null && nodeId !== 0) {
                                const lab = resolvedNets.nodeLabels?.get(nodeId);
                                const label = (lab && !/^n\d+$/i.test(lab) && lab !== 'gnd')
                                    ? lab
                                    : `n${nodeId}`;
                                probeWanted.push(`V(${label})`);
                            }
                        }
                    }
                } else if (c.elementType === 'IP') {
                    probeWanted.push(`I(${c.ref})`);
                }
            }
        }

        // 2) Demo suggestions (fallback when there are no probes).
        const demo = DEMOS.find((d) => d.id === loadedDemoId);
        const suggested = demo?.signals?.[analysis] || [];

        const preferred = [];
        for (const want of [...probeWanted, ...suggested]) {
            const exact = all.filter((n) => n === want);
            if (exact.length > 0) {
                preferred.push(...exact);
                continue;
            }
            // Match the .step family for a given base signal name.
            const family = all.filter((n) => n.startsWith(`${want} @`));
            preferred.push(...family);
        }

        if (preferred.length > 0) {
            // De-dupe while preserving order.
            setSelectedSignals(Array.from(new Set(preferred)));
        } else if (runResult.step) {
            const firstBase = allSignals[0]?.baseNode;
            const family = allSignals.filter((s) => s.baseNode === firstBase).map((s) => s.name);
            setSelectedSignals(family.slice(0, Math.min(8, family.length)));
        } else {
            setSelectedSignals(all.slice(0, Math.min(4, all.length)));
        }
    }, [runResult, loadedDemoId, analysis, doc, resolvedNets]);

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

    // Common reset applied whenever the user swaps to a different
    // doc — opening a project, loading a demo, starting a blank
    // sheet. Keeps the UI state coherent (no stale results, no stale
    // selection, no stale tour).
    const _switchToDoc = useCallback((nextDoc, {
        projectId = null,
        name = 'Untitled',
        analysisId = 'tran',
        tranOv = null,
        acOv = null,
        signals = null,
        sweepOv = null,
        monteOv = undefined,
        acNoiseOv = undefined,
        goalSeekOv = undefined,
        traceMathOv = undefined,
        spiceLibsOv = undefined,
        demoId = null,
        tour = null,
    } = {}) => {
        setDocState({ past: [], present: nextDoc, future: [] });
        setFitNonce((n) => n + 1);
        setCurrentProjectIdState(projectId);
        setCurrentProjectId(projectId); // persist pointer
        setProjectName(name);
        setAnalysis(analysisId || 'tran');
        if (tranOv) setTranOverride(tranOv);
        if (acOv) setAcOverride(acOv);
        else setAcOverride({ mode: '', n: '', fStart: '', fStop: '' });
        if (signals) setSelectedSignals(signals);
        if (sweepOv) setSweep(sweepOv);
        else setSweep({ enabled: false, target: '', start: '100', stop: '1k', step: '100' });
        if (monteOv !== undefined) setMonte(monteOv);
        else setMonte({ enabled: false, runs: '30', tolPercent: '5', pmNode: 'vout' });
        if (acNoiseOv !== undefined) setAcNoise(acNoiseOv);
        else setAcNoise({ enabled: false, outputNode: 'vout' });
        if (goalSeekOv !== undefined) {
            setGoalSeek({
                element: goalSeekOv.element ?? '',
                lo: goalSeekOv.lo ?? '',
                hi: goalSeekOv.hi ?? '',
                target: goalSeekOv.target ?? goalSeekOv.targetPm ?? '45',
                observeNode: goalSeekOv.observeNode ?? 'vout',
                metric: goalSeekOv.metric === 'gm' ? 'gm' : 'pm',
            });
        } else {
            setGoalSeek({
                element: '', lo: '', hi: '', target: '45', observeNode: 'vout', metric: 'pm',
            });
        }
        setGoalSeekLast(null);
        if (traceMathOv !== undefined) setTraceMath(traceMathOv);
        else setTraceMath({ enabled: false, op: 'minus', sigA: '', sigB: '' });
        if (spiceLibsOv !== undefined) setSpiceLibs(spiceLibsOv);
        else setSpiceLibs([]);
        setPlotHighlightNet(null);
        setAcStudioMessage('');
        setLoadedDemoId(demoId);
        setRunResult(null);
        setRunError('');
        setSelection(null);
        setActiveTour(tour || null);
        setTourStep(0);
        setTourOpen((tour || []).length > 0);
        setView('workspace');
    }, []);

    const loadDemo = useCallback((demo) => {
        let imported;
        try {
            imported = importNetlistToDoc(demo.netlist).doc;
            // Optional post-import hook lets a demo sprinkle UI-only
            // parts (SCOPE / VP / IP) onto the imported schematic,
            // since those don't survive a netlist round-trip. Keeps
            // the netlist authoring experience clean while still
            // giving us scope-on-by-default demos.
            if (typeof demo.postImport === 'function') {
                try { demo.postImport(imported); }
                catch (err) { console.warn('demo.postImport failed:', err); }
            }
        } catch (e) {
            setRunError(`Failed to import demo: ${e?.message || e}`);
            return;
        }
        // Loading a demo mints a fresh project slot so the user's
        // previous in-progress design isn't clobbered.
        _switchToDoc(imported, {
            projectId: null,
            name: uniqueName(demo.title || 'Demo'),
            analysisId: demo.defaultAnalysis || 'tran',
            demoId: demo.id,
            tour: demo.tour || null,
        });
    }, [_switchToDoc]);

    const loadBlank = useCallback(() => {
        _switchToDoc(emptyDoc(), {
            projectId: null,
            name: uniqueName('Untitled'),
            analysisId: 'tran',
        });
    }, [_switchToDoc]);

    /* ---------------- File-menu command bindings ---------------- */

    const openProjectFromManager = useCallback((full) => {
        const libs = Array.isArray(full.spiceLibs)
            ? full.spiceLibs.map((r, i) => ({
                id: r.id || `lib_${i}_${String(r.name || 'f').replace(/\W/g, '_')}`,
                name: r.name != null ? String(r.name) : '',
                content: r.content != null ? String(r.content) : '',
            }))
            : undefined;
        _switchToDoc(full.doc || emptyDoc(), {
            projectId: full.id,
            name: full.name || 'Untitled',
            analysisId: full.analysis || 'tran',
            tranOv: full.tranOverride || null,
            acOv: full.acOverride || null,
            signals: full.selectedSignals || null,
            sweepOv: full.sweep || null,
            monteOv: full.monte,
            acNoiseOv: full.acNoise,
            goalSeekOv: full.goalSeek,
            traceMathOv: full.traceMath,
            spiceLibsOv: libs,
        });
        setProjectManagerOpen(false);
    }, [_switchToDoc]);

    const handleSaveAs = useCallback(() => {
        const suggested = `${projectName} copy`;
        const name = window.prompt('Save a copy as…', suggested);
        if (!name) return;
        try {
            const saved = saveProject({
                id: null,
                name: uniqueName(name.trim()),
                doc,
                analysis,
                tranOverride,
                acOverride,
                sweep,
                monte,
                acNoise,
                goalSeek,
                traceMath,
                spiceLibs,
                selectedSignals,
            });
            setCurrentProjectIdState(saved.id);
            setCurrentProjectId(saved.id);
            setProjectName(saved.name);
        } catch (e) {
            setRunError(`Save as failed: ${e?.message || e}`);
        }
    }, [projectName, doc, analysis, tranOverride, acOverride, sweep, monte, acNoise, goalSeek, traceMath, spiceLibs, selectedSignals]);

    const handleRename = useCallback(() => {
        const name = window.prompt('Rename project', projectName);
        if (!name) return;
        setProjectName(name.trim() || 'Untitled');
    }, [projectName]);

    const plotResult = useMemo(
        () => mergeDerivedSignals(runResult, traceMath),
        [runResult, traceMath],
    );

    /** Net label highlight: hover chip wins; else first selected `V(net)` trace. */
    const canvasNetHighlight = useMemo(() => {
        if (plotHighlightNet) return plotHighlightNet;
        for (const name of selectedSignals) {
            const n = voltageProbeNetFromSignalName(name);
            if (n) return n;
        }
        return null;
    }, [plotHighlightNet, selectedSignals]);

    const handleNetLabelProbe = useCallback((netName) => {
        if (!netName || !plotResult?.signals?.length) return;
        const hit = findVoltageSignalForNet(plotResult.signals, netName);
        if (!hit) return;
        setSelectedSignals((prev) => (prev.includes(hit.name) ? prev : [...prev, hit.name]));
    }, [plotResult]);

    useEffect(() => {
        setGoalSeekLast(null);
    }, [doc]);

    const handleExportResultsCsv = useCallback(() => {
        try {
            exportResultsCsv(plotResult, selectedSignals, projectName);
        } catch (e) {
            setRunError(String(e?.message || e));
        }
    }, [plotResult, selectedSignals, projectName]);

    const importProjectFile = useCallback(async (file) => {
        try {
            const text = await file.text();
            const json = JSON.parse(text);
            const imported = importProjectJson(json);
            openProjectFromManager(imported);
        } catch (e) {
            setRunError(`Import failed: ${e?.message || e}`);
        }
    }, [openProjectFromManager]);

    // When the user edits the raw netlist drawer and hits "Apply",
    // re-import the text into the doc. This is the one-way escape
    // hatch for power users who prefer typing SPICE.
    const applyNetlistDraft = useCallback(() => {
        try {
            const { doc: imported } = importNetlistToDoc(netlistDraft, { includeFiles: spiceIncludeFileMap });
            setDocState({ past: [], present: imported, future: [] });
            setFitNonce((n) => n + 1);
            setSelection(null);
            setRunError('');
        } catch (e) {
            setRunError(`Netlist parse failed: ${e?.message || e}`);
        }
    }, [netlistDraft, spiceIncludeFileMap]);

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
        setAcStudioMessage('');
        setSolverRunDiagnostic(null);
        setLiveStream(null);
        // Probe auto-select lives in the runResult useEffect so it
        // composes cleanly with the demo-suggested-signal logic there.
        // Defer to next tick so the UI can update to "Running…" state.
        setTimeout(() => {
            try {
                const ctx = buildContext(parsed);
                // Sweep priority:
                //   1. UI parametric sweep (if enabled + fully specified)
                //   2. parsed `.step` directive from the netlist drawer
                //   3. null → single run
                const parsedStepDir = parsed.directives.find((d) => d.kind === 'step') || null;
                let stepDir = parsedStepDir;
                if (sweep?.enabled) {
                    const synth = buildSweepDirective(sweep, doc, ctx);
                    if (synth.error) throw new Error(synth.error);
                    stepDir = synth.stepDir;
                }

                // Snapshot the pin → signal mapping that the run was
                // actually computed against. We stash this on the
                // result so scope / probe modals keep working after
                // the user drags components (which otherwise changes
                // geometric net numbering and breaks V(n3) lookups).
                const pinSignalMap = buildPinSignalMap(doc, resolvedNets);

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
                        pinSignalMap,
                    });
                } else if (analysis === 'tran') {
                    const parsedDir = parsed.directives.find((d) => d.kind === 'tran');
                    const userTstop = parseSiTime(tranOverride?.tstop);
                    const userTstep = parseSiTime(tranOverride?.tstep);
                    // UI settings take precedence when the user typed
                    // a valid number; otherwise fall back to the
                    // parsed .tran directive, then to the defaults.
                    const dir = {
                        kind: 'tran',
                        tstop:  userTstop  ?? parsedDir?.tstop  ?? 1e-3,
                        tstep:  userTstep  ?? parsedDir?.tstep  ?? 1e-6,
                        tstart: parsedDir?.tstart ?? 0,
                        uic:    parsedDir?.uic ?? false,
                    };
                    const runs = runWithStep(ctx, stepDir, { tran: dir });
                    const finalResult = buildStepResult('tran', runs, parsed, stepDir, ctx);
                    finalResult.pinSignalMap = pinSignalMap;
                    if (liveMode) {
                        // Animate the plot: stream samples into
                        // `liveStream` in chunks, firing rAF between
                        // batches. When the last batch lands, commit
                        // the full result so the static plot takes
                        // over and cursors / export work normally.
                        streamTranResult(finalResult, setLiveStream, () => {
                            setRunResult(finalResult);
                            setLiveStream(null);
                        });
                    } else {
                        setRunResult(finalResult);
                    }
                } else if (analysis === 'ac') {
                    const dir = buildAcDirective(parsed, acOverride);
                    if (dir.fStop <= dir.fStart) {
                        throw new Error('AC sweep: stop frequency must be greater than start (check the AC bar or .ac in the netlist).');
                    }
                    if (monte?.enabled) {
                        if (acNoise?.enabled) {
                            throw new Error('Turn off thermal noise before running Monte Carlo (not supported together yet).');
                        }
                        if (sweep?.enabled) {
                            throw new Error('Turn off parametric sweep before running Monte Carlo.');
                        }
                        if (stepDir) {
                            throw new Error('Monte Carlo cannot combine with .step — remove .step from the netlist or disable Monte Carlo.');
                        }
                        const nRuns = Math.max(1, Math.min(200, Math.floor(parseSiValue(monte.runs) || 30)));
                        const tolNum = Math.max(0, parseSiValue(monte.tolPercent));
                        const pmNodeStr = String(monte.pmNode || 'vout').trim() || 'vout';
                        const mcRuns = runMonteAcSamples(parsed, dir, nRuns, tolNum);
                        const ctxNominal = buildContext(parsed);
                        const meta = { ...buildMonteMetaFromRuns(mcRuns, parsed, pmNodeStr), tolPercent: tolNum };
                        const acResult = buildMonteAcResult(mcRuns, parsed, ctxNominal, meta);
                        acResult.pinSignalMap = pinSignalMap;
                        setRunResult(acResult);
                    } else {
                        const noiseNode = String(acNoise?.outputNode || '').trim();
                        const analyses = { ac: dir };
                        if (acNoise?.enabled) {
                            if (!noiseNode) throw new Error('Thermal noise: enter an output node name (e.g. vout).');
                            analyses.acNoise = { outputNode: noiseNode, tempK: 300 };
                        }
                        const runs = runWithStep(ctx, stepDir, analyses);
                        const acResult = buildStepResult('ac', runs, parsed, stepDir, ctx);
                        acResult.pinSignalMap = pinSignalMap;
                        setRunResult(acResult);
                    }
                } else if (analysis === 'dc') {
                    const dir = parsed.directives.find((d) => d.kind === 'dc');
                    if (!dir) {
                        throw new Error('DC sweep needs a .dc directive — e.g. `.dc Vin 0 3.3 0.01`.');
                    }
                    const runs = runWithStep(ctx, stepDir, { dc: dir });
                    const dcResult = buildStepResult('dc', runs, parsed, stepDir, ctx);
                    dcResult.pinSignalMap = pinSignalMap;
                    setRunResult(dcResult);
                }
            } catch (e) {
                const raw = e?.message || String(e);
                setRunError(raw);
                setRunResult(null);
                try {
                    if (parsed && resolvedNets && doc) {
                        const ctxDiag = buildContext(parsed);
                        const d = diagnoseSolverRunFailure(e, ctxDiag, parsed, doc, resolvedNets);
                        if ((d.pinKeys?.size || 0) > 0 || (d.issues?.length || 0) > 0) {
                            setSolverRunDiagnostic(d);
                        } else {
                            setSolverRunDiagnostic(null);
                        }
                    } else {
                        setSolverRunDiagnostic(null);
                    }
                } catch {
                    setSolverRunDiagnostic(null);
                }
            } finally {
                setRunning(false);
            }
        }, 30);
    }, [parsed, analysis, tranOverride, acOverride, sweep, monte, acNoise, liveMode, doc, resolvedNets]);

    const handleGoalSeek = useCallback(() => {
        if (!parsed || parsed.errors?.length > 0) {
            setRunError(parsed?.errors?.join('\n') || 'Fix the netlist before goal seek.');
            return;
        }
        setRunning(true);
        setRunError('');
        setAcStudioMessage('');
        setGoalSeekLast(null);
        setTimeout(() => {
            try {
                const dir = buildAcDirective(parsed, acOverride);
                if (dir.fStop <= dir.fStart) {
                    throw new Error('AC sweep: stop frequency must be greater than start (check the AC bar).');
                }
                const lo = parseSiValue(goalSeek.lo);
                const hi = parseSiValue(goalSeek.hi);
                const target = parseFloat(goalSeek.target);
                const el = String(goalSeek.element || '').trim();
                const obs = String(goalSeek.observeNode || 'vout').trim() || 'vout';
                const metric = goalSeek.metric === 'gm' ? 'gm' : 'pm';
                if (!el) throw new Error('Goal seek: enter a component ref (e.g. Cf or R1).');
                if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
                    throw new Error('Goal seek: low and high values must be valid numbers (SI prefixes ok).');
                }
                const { value: val, achieved } = goalSeekAcStabilityTarget({
                    parsed,
                    acDir: dir,
                    elementRef: el,
                    lo,
                    hi,
                    observeNode: obs,
                    metric,
                    target,
                });
                setGoalSeekLast({
                    value: val,
                    achieved,
                    metric,
                    elementRef: el,
                });
                const tgtStr = metric === 'gm'
                    ? (Number.isFinite(target) ? `${target} dB GM` : String(goalSeek.target))
                    : (Number.isFinite(target) ? `${target}° PM` : String(goalSeek.target));
                const achStr = metric === 'gm'
                    ? (Number.isFinite(achieved) ? `${achieved.toFixed(2)} dB GM` : '—')
                    : (Number.isFinite(achieved) ? `${achieved.toFixed(2)}° PM` : '—');
                setAcStudioMessage(
                    `Goal seek: ${el} ≈ ${formatSi(val)} for ${tgtStr} on V(${obs}) (achieved ${achStr}). `
                    + 'Use Copy or Apply to schematic, then Run to verify.',
                );
            } catch (e) {
                setRunError(e?.message || String(e));
            } finally {
                setRunning(false);
            }
        }, 30);
    }, [parsed, acOverride, goalSeek]);

    const handleApplyGoalSeekValue = useCallback(() => {
        const last = goalSeekLast;
        if (!last || !Number.isFinite(last.value)) return;
        const ref = String(last.elementRef || '').trim();
        if (!ref) return;
        const comp = doc?.components?.find((c) => String(c.ref).toLowerCase() === ref.toLowerCase());
        if (!comp) {
            setRunError(`Apply: no schematic part "${ref}".`);
            return;
        }
        if (!isSweepableType(comp.elementType)) {
            setRunError(`Apply: ${ref} is not R/C/L/V/I — cannot set a scalar value.`);
            return;
        }
        const val = last.value;
        mutateDoc((d) => {
            const c = d.components.find((x) => String(x.ref).toLowerCase() === ref.toLowerCase());
            if (c) c.value = val;
        });
        setAcStudioMessage((m) => (m ? `${m} ` : '') + `Applied ${formatSi(val)} to ${ref} on the schematic.`);
        setGoalSeekLast(null);
    }, [goalSeekLast, doc, mutateDoc]);

    const handleCopyGoalSeekValue = useCallback(() => {
        const v = goalSeekLast?.value;
        if (!Number.isFinite(v)) return;
        const t = formatSi(v);
        navigator.clipboard?.writeText(t).catch(() => {});
        setAcStudioMessage((m) => ((m ? `${m} ` : '') + `Copied ${t} to clipboard.`).trim());
    }, [goalSeekLast]);

    const copyNetlist = useCallback(() => {
        if (!netlistText) return;
        navigator.clipboard?.writeText(netlistText).catch(() => {});
    }, [netlistText]);

    const handleSendToPcbLayout = useCallback(() => {
        if (!resolvedNets) {
            setRunError('Fix schematic connectivity so nets resolve, then try again.');
            return;
        }
        if (typeof onOpenPcbLayout !== 'function') {
            setRunError('PCB Studio navigation is not available.');
            return;
        }
        try {
            const payload = buildPcbBridgePayload(doc, resolvedNets, netlistText);
            sessionStorage.setItem(PCB_BRIDGE_KEY, JSON.stringify(payload));
            onOpenPcbLayout();
        } catch (e) {
            setRunError(e?.message || String(e));
        }
    }, [doc, resolvedNets, netlistText, onOpenPcbLayout]);

    // Drag-drop import must be declared *before* the home/workspace early
    // return — otherwise React sees fewer hooks on the home branch and
    // throws invariant #300 ("Rendered fewer hooks than expected").
    const onRootDragOver = useCallback((ev) => {
        const items = ev.dataTransfer?.items;
        if (items && [...items].some((it) => it.kind === 'file')) {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'copy';
        }
    }, []);
    const onRootDrop = useCallback((ev) => {
        const file = ev.dataTransfer?.files?.[0];
        if (!file) return;
        if (!/\.(json|noze)$/i.test(file.name)) return;
        ev.preventDefault();
        importProjectFile(file);
    }, [importProjectFile]);

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
                    Drag-and-drop schematic editing and digital gates land in follow-up releases.
                    AC thermal (resistor) noise is available from the workspace AC bar.
                </div>
            </div>
        );
    }

    // ---------- Workspace view ----------
    const directives = parsed?.directives || [];
    const hasTran = directives.some((d) => d.kind === 'tran');
    const hasAc = directives.some((d) => d.kind === 'ac');

    return (
        <div className="cs-root" onDragOver={onRootDragOver} onDrop={onRootDrop}>
            <div className="cs-topbar">
                <button className="cs-topbtn" onClick={goHome} title="Back to Circuit Studio home">
                    <Home size={14} /> Home
                </button>
                <div className="cs-topbar-sep" />

                {/* ------------ File menu ------------ */}
                <div className="cs-file-menu-wrap">
                    <button
                        className={`cs-topbtn${fileMenuOpen ? ' is-active' : ''}`}
                        onClick={() => setFileMenuOpen((v) => !v)}
                        onBlur={() => { setTimeout(() => setFileMenuOpen(false), 120); }}
                        title="File menu"
                    >
                        <FolderOpen size={14} /> File
                        <ChevronDown size={12} style={{ marginLeft: 2 }} />
                    </button>
                    {fileMenuOpen && (
                        <div className="cs-file-menu" onMouseDown={(e) => e.preventDefault()}>
                            <button className="cs-file-menu-item"
                                onClick={() => { setFileMenuOpen(false); loadBlank(); }}>
                                <FilePlus size={14} /> New project
                            </button>
                            <button className="cs-file-menu-item"
                                onClick={() => { setFileMenuOpen(false); setProjectManagerOpen(true); }}>
                                <FolderOpen size={14} /> Open project…
                            </button>
                            <div className="cs-file-menu-sep" />
                            <button className="cs-file-menu-item"
                                onClick={() => { setFileMenuOpen(false); handleRename(); }}>
                                Rename…
                            </button>
                            <button className="cs-file-menu-item"
                                onClick={() => { setFileMenuOpen(false); handleSaveAs(); }}>
                                <Save size={14} /> Save as copy…
                            </button>
                            <div className="cs-file-menu-sep" />
                            <button className="cs-file-menu-item"
                                onClick={() => { setFileMenuOpen(false); exportProjectJson({
                                    name: projectName,
                                    doc,
                                    analysis,
                                    tranOverride,
                                    acOverride,
                                    sweep,
                                    monte,
                                    acNoise,
                                    goalSeek,
                                    traceMath,
                                    spiceLibs,
                                    selectedSignals,
                                }); }}>
                                <FileJson size={14} /> Export project (.noze.json)
                            </button>
                            <button className="cs-file-menu-item"
                                onClick={() => { setFileMenuOpen(false); exportSpiceNetlist(netlistText, projectName); }}>
                                <FileText size={14} /> Export SPICE netlist (.cir)
                            </button>
                            <button className="cs-file-menu-item"
                                disabled={!plotResult}
                                onClick={() => { setFileMenuOpen(false); exportResultsCsv(plotResult, selectedSignals, projectName); }}>
                                <Download size={14} /> Export results (.csv)
                            </button>
                            <button className="cs-file-menu-item"
                                onClick={() => {
                                    setFileMenuOpen(false);
                                    try { exportCanvasSvg(projectName); }
                                    catch (e) { setRunError(e?.message || String(e)); }
                                }}>
                                <ImageIcon size={14} /> Export canvas (.svg)
                            </button>
                            <button className="cs-file-menu-item"
                                onClick={() => {
                                    setFileMenuOpen(false);
                                    Promise.resolve(exportCanvasPng(projectName))
                                        .catch((e) => setRunError(e?.message || String(e)));
                                }}>
                                <ImageIcon size={14} /> Export canvas (.png)
                            </button>
                            <button
                                type="button"
                                className="cs-file-menu-item"
                                onClick={() => {
                                    setFileMenuOpen(false);
                                    handleSendToPcbLayout();
                                }}
                            >
                                <Layers size={14} /> Send to PCB Studio…
                            </button>
                            <div className="cs-file-menu-sep" />
                            <label className="cs-file-menu-item">
                                <Plus size={14} /> Import project…
                                <input
                                    type="file"
                                    accept=".json,.noze,application/json"
                                    style={{ display: 'none' }}
                                    onChange={(ev) => {
                                        const f = ev.target.files?.[0];
                                        setFileMenuOpen(false);
                                        if (f) importProjectFile(f);
                                        ev.target.value = '';
                                    }}
                                />
                            </label>
                        </div>
                    )}
                </div>

                {/* Active project name (click to rename) */}
                <button
                    className="cs-project-name"
                    onClick={handleRename}
                    title="Click to rename this project"
                >
                    {projectName || 'Untitled'}
                </button>

                <div className="cs-view-switch" role="group" aria-label="Schematic or board">
                    <span className="cs-view-switch-btn is-active" aria-current="page">
                        Schematic
                    </span>
                    <button
                        type="button"
                        className="cs-view-switch-btn"
                        onClick={() => (typeof onOpenPcbLayout === 'function' ? onOpenPcbLayout() : undefined)}
                        title="Open PCB layout (same session — selection cross-highlights)"
                    >
                        <CircuitBoard size={13} /> Board
                    </button>
                </div>

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
                                t.id === 'ac' && !hasAc ? 'No .ac in netlist — use the AC sweep bar (start/stop in Hz) or add e.g. `.ac dec 50 1 1meg`. Voltage sources need an AC spec (new parts default to AC 1).'
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
                <button className="cs-topbtn" onClick={handleUndo} disabled={docState.past.length === 0} title="Undo (Ctrl+Z)">
                    <Undo size={14} />
                </button>
                <button className="cs-topbtn" onClick={handleRedo} disabled={docState.future.length === 0} title="Redo (Ctrl+Y)">
                    <Redo size={14} />
                </button>
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

            <div className="cs-workspace-scroll-chrome" role="region" aria-label="Run settings">
            {analysis === 'tran' && (
                <div className="cs-subbar cs-tran-bar">
                    <span className="cs-tran-label">Transient</span>
                    <label className="cs-tran-field">
                        <span>Duration</span>
                        <input
                            type="text"
                            value={tranOverride.tstop}
                            onChange={(e) => setTranOverride((s) => ({ ...s, tstop: e.target.value }))}
                            spellCheck={false}
                            placeholder="1m"
                        />
                        <span className="cs-tran-unit">s</span>
                    </label>
                    <label className="cs-tran-field">
                        <span>Step</span>
                        <input
                            type="text"
                            value={tranOverride.tstep}
                            onChange={(e) => setTranOverride((s) => ({ ...s, tstep: e.target.value }))}
                            spellCheck={false}
                            placeholder="1u"
                        />
                        <span className="cs-tran-unit">s</span>
                    </label>
                    <label className={`cs-tran-live${liveMode ? ' is-on' : ''}`}>
                        <input
                            type="checkbox"
                            checked={liveMode}
                            onChange={(e) => setLiveMode(e.target.checked)}
                        />
                        <Activity size={12} /> Live stream
                    </label>
                    <span className="cs-tran-hint">SI prefixes ok: <code>1m</code>, <code>500u</code>, <code>2n</code></span>
                </div>
            )}

            {analysis === 'ac' && (
                <div className="cs-subbar cs-tran-bar">
                    <span className="cs-tran-label">AC sweep</span>
                    <label className="cs-tran-field">
                        <span>Scale</span>
                        <select
                            className="cs-sweep-target"
                            value={acOverride.mode}
                            onChange={(e) => setAcOverride((s) => ({ ...s, mode: e.target.value }))}
                        >
                            <option value="">(from netlist)</option>
                            <option value="dec">dec (per decade)</option>
                            <option value="oct">oct (per octave)</option>
                            <option value="lin">lin (evenly spaced)</option>
                        </select>
                    </label>
                    <label className="cs-tran-field">
                        <span>Points</span>
                        <input
                            type="text"
                            value={acOverride.n}
                            onChange={(e) => setAcOverride((s) => ({ ...s, n: e.target.value }))}
                            spellCheck={false}
                            placeholder="20"
                        />
                    </label>
                    <label className="cs-tran-field">
                        <span>Start f</span>
                        <input
                            type="text"
                            value={acOverride.fStart}
                            onChange={(e) => setAcOverride((s) => ({ ...s, fStart: e.target.value }))}
                            spellCheck={false}
                            placeholder="10"
                        />
                        <span className="cs-tran-unit">Hz</span>
                    </label>
                    <label className="cs-tran-field">
                        <span>Stop f</span>
                        <input
                            type="text"
                            value={acOverride.fStop}
                            onChange={(e) => setAcOverride((s) => ({ ...s, fStop: e.target.value }))}
                            spellCheck={false}
                            placeholder="1Meg"
                        />
                        <span className="cs-tran-unit">Hz</span>
                    </label>
                    <span className="cs-tran-hint">
                        Leave fields blank to use the netlist <code>.ac</code> line (or 1 Hz–1 MHz dec 20 if none). Filled fields override for this Run. Use <code>k</code>/<code>Meg</code> for Hz. At least one <code>V</code>/<code>I</code> needs an <code>AC</code> spec — palette sine/DC/pulse now include <code>AC 1</code> by default.
                    </span>
                </div>
            )}

            {analysis === 'ac' && !ampCoachDismissed && (
                <AcAmplifierCoach
                    onDismiss={dismissAmpCoach}
                    onLoadStabilityDemo={() => {
                        const d = DEMOS.find((x) => x.id === 'amp-stability');
                        if (d) loadDemo(d);
                    }}
                />
            )}

            {/* ---- Parametric sweep subbar (always visible) ---- */}
            {analysis !== 'op' && (
                <div className={`cs-subbar cs-sweep-bar${sweep.enabled ? ' is-on' : ''}`}>
                    <label className={`cs-tran-live${sweep.enabled ? ' is-on' : ''}`}>
                        <input
                            type="checkbox"
                            checked={sweep.enabled}
                            onChange={(e) => {
                                const on = e.target.checked;
                                setSweep((s) => ({ ...s, enabled: on }));
                                if (on) setMonte((m) => ({ ...m, enabled: false }));
                            }}
                        />
                        <SlidersHorizontal size={12} /> Parametric sweep
                    </label>
                    <label className="cs-tran-field">
                        <span>Target</span>
                        <select
                            className="cs-sweep-target"
                            value={sweep.target}
                            onChange={(e) => setSweep((s) => ({ ...s, target: e.target.value }))}
                            disabled={!sweep.enabled}
                        >
                            <option value="">(first R/C/L/V/I)</option>
                            {(doc?.components || [])
                                .filter((c) => isSweepableType(c.elementType))
                                .map((c) => (
                                    <option key={c.id} value={c.ref}>
                                        {c.ref}{c.value != null ? ` = ${formatSi(c.value)}` : ''}
                                    </option>
                                ))}
                        </select>
                    </label>
                    <label className="cs-tran-field">
                        <span>From</span>
                        <input
                            type="text"
                            value={sweep.start}
                            onChange={(e) => setSweep((s) => ({ ...s, start: e.target.value }))}
                            disabled={!sweep.enabled}
                            spellCheck={false}
                            placeholder="100"
                        />
                    </label>
                    <label className="cs-tran-field">
                        <span>To</span>
                        <input
                            type="text"
                            value={sweep.stop}
                            onChange={(e) => setSweep((s) => ({ ...s, stop: e.target.value }))}
                            disabled={!sweep.enabled}
                            spellCheck={false}
                            placeholder="1k"
                        />
                    </label>
                    <label className="cs-tran-field">
                        <span>Step</span>
                        <input
                            type="text"
                            value={sweep.step}
                            onChange={(e) => setSweep((s) => ({ ...s, step: e.target.value }))}
                            disabled={!sweep.enabled}
                            spellCheck={false}
                            placeholder="100"
                        />
                    </label>
                    {sweep.enabled && (() => {
                        const start = parseSiValue(sweep.start);
                        const stop  = parseSiValue(sweep.stop);
                        const step  = parseSiValue(sweep.step);
                        const vals  = linspaceByStep(start, stop, step);
                        if (vals.length === 0) {
                            return <span className="cs-tran-hint cs-sweep-err">invalid range</span>;
                        }
                        const tooMany = vals.length > 200;
                        return (
                            <span className={`cs-tran-hint${tooMany ? ' cs-sweep-err' : ''}`}>
                                {vals.length} runs{tooMany ? ' (> 200 cap)' : ''}
                                {!tooMany && vals.length <= 6
                                    ? `: ${vals.map((v) => formatSi(v)).join(', ')}`
                                    : !tooMany
                                    ? `: ${formatSi(vals[0])} … ${formatSi(vals[vals.length - 1])}`
                                    : ''}
                            </span>
                        );
                    })()}
                    {!sweep.enabled && (
                        <span className="cs-tran-hint">
                            Sweep <code>R</code>/<code>C</code>/<code>L</code> value, or <code>V</code>/<code>I</code>{' '}
                            <strong>DC bias</strong> (same as the DC field in the property editor). Example:{' '}
                            <code>Vin</code> from <code>0</code> to <code>3.3</code> by <code>0.33</code>.
                        </span>
                    )}
                </div>
            )}

            {analysis === 'ac' && (
                <>
                    <div className={`cs-subbar cs-monte-bar${monte.enabled ? ' is-on' : ''}`}>
                        <label className={`cs-tran-live${monte.enabled ? ' is-on' : ''}`}>
                            <input
                                type="checkbox"
                                checked={monte.enabled}
                                onChange={(e) => {
                                    const on = e.target.checked;
                                    setMonte((m) => ({ ...m, enabled: on }));
                                    if (on) {
                                        setSweep((s) => ({ ...s, enabled: false }));
                                        setAcNoise((n) => ({ ...n, enabled: false }));
                                    }
                                }}
                            />
                            Monte Carlo
                        </label>
                        <label className="cs-tran-field">
                            <span>Runs</span>
                            <input
                                type="text"
                                value={monte.runs}
                                onChange={(e) => setMonte((m) => ({ ...m, runs: e.target.value }))}
                                disabled={!monte.enabled}
                                spellCheck={false}
                                title="Number of random samples (max 200)"
                            />
                        </label>
                        <label className="cs-tran-field">
                            <span>R/C/L ±%</span>
                            <input
                                type="text"
                                value={monte.tolPercent}
                                onChange={(e) => setMonte((m) => ({ ...m, tolPercent: e.target.value }))}
                                disabled={!monte.enabled}
                                spellCheck={false}
                                title="Uniform tolerance band per sample (each R, C, L scaled independently)"
                            />
                        </label>
                        <label className="cs-tran-field">
                            <span>PM node</span>
                            <input
                                type="text"
                                className="cs-sweep-target"
                                value={monte.pmNode}
                                onChange={(e) => setMonte((m) => ({ ...m, pmNode: e.target.value }))}
                                disabled={!monte.enabled}
                                spellCheck={false}
                                placeholder="vout"
                            />
                        </label>
                        <span className="cs-tran-hint">
                            Each run perturbs every <code>R</code>/<code>C</code>/<code>L</code> within ±%. Not compatible with sweep or <code>.step</code>. Plot = <strong>mean</strong> Bode; table lists PM per run.
                        </span>
                    </div>
                    <div className={`cs-subbar cs-noise-bar${acNoise.enabled ? ' is-on' : ''}`}>
                        <label className={`cs-tran-live${acNoise.enabled ? ' is-on' : ''}`}>
                            <input
                                type="checkbox"
                                checked={acNoise.enabled}
                                onChange={(e) => {
                                    const on = e.target.checked;
                                    setAcNoise((n) => ({ ...n, enabled: on }));
                                    if (on) setMonte((m) => ({ ...m, enabled: false }));
                                }}
                            />
                            Thermal noise
                        </label>
                        <label className="cs-tran-field">
                            <span>Output node</span>
                            <input
                                type="text"
                                className="cs-sweep-target"
                                value={acNoise.outputNode}
                                onChange={(e) => setAcNoise((n) => ({ ...n, outputNode: e.target.value }))}
                                disabled={!acNoise.enabled}
                                spellCheck={false}
                                placeholder="vout"
                                title="Small-signal output noise PSD at this node"
                            />
                        </label>
                        <span className="cs-tran-hint">
                            Johnson–Nyquist noise from linearised <code>R</code> only (4kT/R), 300 K, as trace <code>onoise V(node)</code> — stored as V²/Hz; magnitude plot is 10·log₁₀ (dB re 1 V²/Hz). Excludes shot/flicker. Not with Monte Carlo yet.
                        </span>
                    </div>
                    <div className="cs-subbar cs-goal-bar">
                        <span className="cs-tran-label">Goal seek</span>
                        <label className="cs-tran-field">
                            <span>Metric</span>
                            <select
                                className="cs-sweep-target"
                                value={goalSeek.metric}
                                onChange={(e) => setGoalSeek((g) => ({ ...g, metric: e.target.value }))}
                                title="Stability metric to match"
                            >
                                <option value="pm">Phase margin</option>
                                <option value="gm">Gain margin</option>
                            </select>
                        </label>
                        <label className="cs-tran-field">
                            <span>Part</span>
                            <input
                                type="text"
                                className="cs-sweep-target"
                                value={goalSeek.element}
                                onChange={(e) => setGoalSeek((g) => ({ ...g, element: e.target.value }))}
                                spellCheck={false}
                                placeholder="Cf"
                            />
                        </label>
                        <label className="cs-tran-field">
                            <span>Lo</span>
                            <input
                                type="text"
                                value={goalSeek.lo}
                                onChange={(e) => setGoalSeek((g) => ({ ...g, lo: e.target.value }))}
                                spellCheck={false}
                                placeholder="1p"
                            />
                        </label>
                        <label className="cs-tran-field">
                            <span>Hi</span>
                            <input
                                type="text"
                                value={goalSeek.hi}
                                onChange={(e) => setGoalSeek((g) => ({ ...g, hi: e.target.value }))}
                                spellCheck={false}
                                placeholder="50p"
                            />
                        </label>
                        <label className="cs-tran-field">
                            <span>Target</span>
                            <input
                                type="text"
                                value={goalSeek.target}
                                onChange={(e) => setGoalSeek((g) => ({ ...g, target: e.target.value }))}
                                spellCheck={false}
                                title={goalSeek.metric === 'gm' ? 'Target gain margin (dB)' : 'Target phase margin (°)'}
                                placeholder={goalSeek.metric === 'gm' ? '10' : '45'}
                            />
                            <span className="cs-tran-unit">{goalSeek.metric === 'gm' ? 'dB' : '°'}</span>
                        </label>
                        <label className="cs-tran-field">
                            <span>Observe</span>
                            <input
                                type="text"
                                className="cs-sweep-target"
                                value={goalSeek.observeNode}
                                onChange={(e) => setGoalSeek((g) => ({ ...g, observeNode: e.target.value }))}
                                spellCheck={false}
                                placeholder="vout"
                                title="Node name inside V(...)"
                            />
                        </label>
                        <button
                            type="button"
                            className="cs-topbtn cs-topbtn-primary"
                            onClick={handleGoalSeek}
                            disabled={running}
                        >
                            Seek
                        </button>
                        <button
                            type="button"
                            className="cs-topbtn"
                            onClick={handleApplyGoalSeekValue}
                            disabled={!goalSeekLast || running}
                            title="Write the solved value to the matching schematic part (R/C/L/V/I)"
                        >
                            Apply
                        </button>
                        <button
                            type="button"
                            className="cs-topbtn"
                            onClick={handleCopyGoalSeekValue}
                            disabled={!goalSeekLast || running}
                            title="Copy solved SI value to clipboard"
                        >
                            <Copy size={12} /> Copy
                        </button>
                        <span className="cs-tran-hint">
                            Bisection on <code>V(observe)</code>: bracket <code>Lo</code>…<code>Hi</code> so metric−target changes sign.
                            Click a <strong>net name</strong> on the canvas to add its <code>V(net)</code> trace.
                        </span>
                    </div>
                </>
            )}
            </div>

            <div className={`cs-body cs-body-phase3${paletteCollapsed ? ' is-palette-collapsed' : ''}${inspectorCollapsed ? ' is-inspector-collapsed' : ''}`}>
                <div className={`cs-pane cs-pane-palette${paletteCollapsed ? ' is-collapsed' : ''}`}>
                    {paletteCollapsed ? (
                        <button
                            type="button"
                            className="cs-pane-expand"
                            onClick={() => setPaletteCollapsed(false)}
                            title="Show components (⌘/Ctrl+[)"
                        >
                            <LayoutGrid size={14} />
                            <span className="cs-pane-expand-label">Components</span>
                            <ChevronRight size={12} />
                        </button>
                    ) : (
                        <>
                            <div className="cs-pane-title">
                                <LayoutGrid size={13} /> Components
                                <button
                                    type="button"
                                    className="cs-pane-collapse"
                                    onClick={() => setPaletteCollapsed(true)}
                                    title="Hide components panel"
                                    aria-label="Collapse components panel"
                                >
                                    <ChevronLeft size={12} />
                                </button>
                            </div>
                            <Palette
                                userLibraryParts={userLibraryPaletteParts}
                                onPick={(partId) => {
                                    // Click-to-place centres the new part near the
                                    // middle of the current canvas.
                                    mutateDoc((d) => { addComponent(d, partId, 200, 160, 0); });
                                }}
                            />
                        </>
                    )}
                </div>

                <div className={`cs-pane cs-pane-stage${resultsPlotMaximized ? ' is-plot-max' : ''}`}>
                    <Canvas
                        doc={doc}
                        selectedId={selection}
                        onSelect={setSelection}
                        onCommand={handleCommand}
                        onDocChange={mutateDoc}
                        resolvedNets={resolvedNets}
                        validation={canvasValidation}
                        onUndo={handleUndo}
                        onRedo={handleRedo}
                        onEditComponent={setEditPopup}
                        onOpenScope={setScopeModal}
                        fitNonce={fitNonce}
                        highlightNetLabel={canvasNetHighlight}
                        onNetLabelClick={handleNetLabelProbe}
                        crossHighlightRefSet={boardCrossRefs}
                        crossHighlightNetSet={boardCrossNets}
                    />

                    {editPopup && (
                        <PropertyPopup
                            comp={doc?.components?.find((c) => c.id === editPopup.compId) || null}
                            userModelsForPicker={doc?.userModels || []}
                            anchor={{ clientX: editPopup.clientX, clientY: editPopup.clientY }}
                            onClose={() => setEditPopup(null)}
                            onCommit={(patch) => {
                                const id = editPopup.compId;
                                mutateDoc((d) => { updateComponent(d, id, patch); });
                            }}
                        />
                    )}

                    {projectManagerOpen && (
                        <ProjectManager
                            currentId={currentProjectId}
                            onOpen={openProjectFromManager}
                            onNew={() => { setProjectManagerOpen(false); loadBlank(); }}
                            onClose={() => setProjectManagerOpen(false)}
                        />
                    )}

                    {modelLibOpen && (
                        <ModelLibraryModal
                            onClose={() => setModelLibOpen(false)}
                            onAddLibrary={(row) => setSpiceLibs((p) => [...p, row])}
                            onQueueIncludeLine={handleQueueIncludeFromModelLib}
                            netlistTextForInclude={netlistText}
                        />
                    )}

                    {scopeModal && (() => {
                        const comp = doc?.components?.find((c) => c.id === scopeModal.compId) || null;
                        const { channels } = scopeSignalsFor(comp, resolvedNets, runResult);
                        return (
                            <ScopeModal
                                comp={comp}
                                channels={channels}
                                result={runResult}
                                livePartial={livePartialForChannels(liveStream, channels)}
                                onClose={() => setScopeModal(null)}
                            />
                        );
                    })()}

                    {/* Optional bottom drawer: results + netlist source */}
                    <div className={`cs-drawer${showResults ? ' is-open' : ''}`}>
                        <div className="cs-drawer-tabs">
                            <button
                                type="button"
                                className={`cs-drawer-tab${showResults && drawerTab === 'results' ? ' is-active' : ''}`}
                                onClick={() => {
                                    if (showResults && drawerTab === 'results') setShowResults(false);
                                    else {
                                        setShowResults(true);
                                        setDrawerTab('results');
                                    }
                                }}
                            >
                                <Activity size={12} /> Results
                                {showResults ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
                            </button>
                            <button
                                type="button"
                                className={`cs-drawer-tab${showResults && drawerTab === 'scope' ? ' is-active' : ''}`}
                                onClick={() => {
                                    if (showResults && drawerTab === 'scope') setShowResults(false);
                                    else {
                                        setShowResults(true);
                                        setDrawerTab('scope');
                                    }
                                }}
                                title="Oscilloscope traces (SCOPE parts on the canvas)"
                            >
                                <Monitor size={12} /> Scope
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
                            {drawerTab === 'results' && (
                                <button
                                    type="button"
                                    className={`cs-drawer-maximize${resultsPlotMaximized ? ' is-on' : ''}`}
                                    onClick={() => setResultsPlotMaximized((v) => !v)}
                                    disabled={!showResults}
                                    title={resultsPlotMaximized
                                        ? 'Show schematic larger again'
                                        : 'Maximize results plot (use most of the window — Esc to exit)'}
                                >
                                    {resultsPlotMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                                    <span className="cs-drawer-maximize-label">
                                        {resultsPlotMaximized ? 'Restore' : 'Max plot'}
                                    </span>
                                </button>
                            )}
                        </div>
                        {showResults && drawerTab === 'results' && (
                            <div className="cs-drawer-body">
                                {runError && (
                                    <div className="cs-err-block">
                                        {String(runError).split('\n').map((l, i) => <div key={i}>{l}</div>)}
                                    </div>
                                )}
                                {!runError && acStudioMessage && (
                                    <div className="cs-studio-msg" role="status">{acStudioMessage}</div>
                                )}
                                {!runError && plotResult && (
                                    <ResultsPanel
                                        result={plotResult}
                                        expandedChart={resultsPlotMaximized}
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
                                        onExportCsv={handleExportResultsCsv}
                                        traceMath={traceMath}
                                        onTraceMathChange={setTraceMath}
                                        onSignalProbeHover={setPlotHighlightNet}
                                    />
                                )}
                                {!runError && !plotResult && (
                                    <div className="cs-empty">
                                        Hit <b>Run</b> to solve. DC gives node voltages; AC gives a Bode plot; Transient plots V(node) vs. time.
                                    </div>
                                )}
                            </div>
                        )}
                        {showResults && drawerTab === 'scope' && (() => {
                            const scopeComp = scopeDrawerCompId
                                ? doc?.components?.find((c) => c.id === scopeDrawerCompId) || null
                                : null;
                            const { channels: scopeDrawerChannels } = scopeSignalsFor(
                                scopeComp, resolvedNets, runResult,
                            );
                            return (
                                <div className="cs-drawer-body cs-drawer-scope">
                                    <div className="cs-scope-drawer-bar">
                                        <label htmlFor="cs-scope-drawer-select">
                                            SCOPE
                                            <select
                                                id="cs-scope-drawer-select"
                                                className="cs-scope-drawer-select"
                                                value={scopeDrawerCompId ?? ''}
                                                onChange={(e) => setScopeDrawerCompId(e.target.value || null)}
                                            >
                                                {!scopeComponentsInDoc.length && (
                                                    <option value="">(none on schematic)</option>
                                                )}
                                                {scopeComponentsInDoc.map((c) => (
                                                    <option key={c.id} value={c.id}>
                                                        {c.ref || c.id}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        {scopeDrawerCompId && (
                                            <button
                                                type="button"
                                                className="cs-topbtn"
                                                onClick={() => setScopeModal({ compId: scopeDrawerCompId })}
                                                title="Open scope in full window (same as double-click on canvas)"
                                            >
                                                Pop out
                                            </button>
                                        )}
                                        <span className="cs-scope-drawer-spacer" />
                                        <span className="cs-scope-drawer-hint">
                                            Double-click a scope on the canvas for the same view.
                                        </span>
                                    </div>
                                    {scopeComp ? (
                                        <ScopeModal
                                            key={scopeDrawerCompId}
                                            embedded
                                            comp={scopeComp}
                                            channels={scopeDrawerChannels}
                                            result={runResult}
                                            livePartial={livePartialForChannels(liveStream, scopeDrawerChannels)}
                                        />
                                    ) : (
                                        <div className="cs-empty" style={{ padding: 16 }}>
                                            Add a <b>SCOPE</b> from the palette and clip its probe tip(s) to nets, then run a simulation.
                                        </div>
                                    )}
                                </div>
                            );
                        })()}
                        {showNetlistDrawer && (
                            <div className="cs-source-drawer">
                                <div className="cs-source-drawer-top">
                                    <span>SPICE netlist (editable — hit Apply to re-import)</span>
                                    <button className="cs-topbtn" onClick={applyNetlistDraft}>
                                        <RefreshCw size={12} /> Apply
                                    </button>
                                </div>
                                <div className="cs-spice-lib-panel">
                                    <div className="cs-spice-lib-head">
                                        <span className="cs-spice-lib-title">Library files for <code>.include</code> / <code>.lib</code></span>
                                        <span className="cs-spice-lib-actions">
                                            <button
                                                type="button"
                                                className="cs-topbtn"
                                                onClick={() => setModelLibOpen(true)}
                                                title="Search curated free model packs and try HTTPS downloads"
                                            >
                                                <BookOpen size={12} /> Model library…
                                            </button>
                                            <button
                                                type="button"
                                                className="cs-topbtn"
                                                onClick={() => setSpiceLibs((rows) => [...rows, newSpiceLibRow()])}
                                            >
                                                <Plus size={12} /> Add file
                                            </button>
                                        </span>
                                    </div>
                                    <p className="cs-spice-lib-hint">
                                        Paste vendor fragments here; the <strong>filename</strong> must match the path in{' '}
                                        <code>.include &quot;…&quot;</code> (basename match is enough).{' '}
                                        <code>.subckt</code> / <code>X</code> are flattened before simulation — nested subcircuits are not supported yet.
                                    </p>
                                    {spiceLibs.length === 0 && (
                                        <p className="cs-spice-lib-empty">No library entries — netlist is used as-is.</p>
                                    )}
                                    {spiceLibs.map((row, ri) => (
                                        <div key={row.id || ri} className="cs-spice-lib-row">
                                            <label className="cs-spice-lib-file">
                                                <span>Filename</span>
                                                <input
                                                    type="text"
                                                    value={row.name}
                                                    onChange={(e) => {
                                                        const v = e.target.value;
                                                        setSpiceLibs((rows) => rows.map((r) => (r.id === row.id ? { ...r, name: v } : r)));
                                                    }}
                                                    spellCheck={false}
                                                    placeholder="e.g. models.inc"
                                                />
                                            </label>
                                            <label className="cs-spice-lib-body">
                                                <span>SPICE text</span>
                                                <textarea
                                                    value={row.content}
                                                    onChange={(e) => {
                                                        const v = e.target.value;
                                                        setSpiceLibs((rows) => rows.map((r) => (r.id === row.id ? { ...r, content: v } : r)));
                                                    }}
                                                    spellCheck={false}
                                                    rows={5}
                                                    placeholder=".model … / .subckt …"
                                                />
                                            </label>
                                            <button
                                                type="button"
                                                className="cs-topbtn cs-spice-lib-remove"
                                                title="Remove this library entry"
                                                onClick={() => setSpiceLibs((rows) => rows.filter((r) => r.id !== row.id))}
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    ))}
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

                <div className={`cs-pane cs-pane-inspector${inspectorCollapsed ? ' is-collapsed' : ''}`}>
                    {inspectorCollapsed ? (
                        <button
                            type="button"
                            className="cs-pane-expand"
                            onClick={() => setInspectorCollapsed(false)}
                            title="Show inspector (⌘/Ctrl+])"
                        >
                            <ChevronLeft size={12} />
                            <span className="cs-pane-expand-label">Inspector</span>
                            <SlidersHorizontal size={14} />
                        </button>
                    ) : (
                        <>
                            <div className="cs-pane-title">
                                <button
                                    type="button"
                                    className="cs-pane-collapse cs-pane-collapse-right"
                                    onClick={() => setInspectorCollapsed(true)}
                                    title="Hide inspector panel"
                                    aria-label="Collapse inspector panel"
                                >
                                    <ChevronRight size={12} />
                                </button>
                                <SlidersHorizontal size={13} /> Inspector
                            </div>
                            <Inspector
                                selectedComp={selectedComp}
                                userModels={doc?.userModels || []}
                                bulkSelection={selection?.kind === 'multi' ? selection : null}
                                onBulkDelete={() => {
                                    if (selection?.kind !== 'multi') return;
                                    mutateDoc((d) => {
                                        for (const wid of selection.wireIds || []) removeWire(d, wid);
                                        for (const cid of selection.componentIds || []) removeComponent(d, cid);
                                        for (const lid of selection.labelIds || []) removeLabel(d, lid);
                                    });
                                    setSelection(null);
                                }}
                                onUpdate={(patch) => selectedComp && mutateDoc((d) => updateComponent(d, selectedComp.id, patch))}
                                onRotate={() => selectedComp && mutateDoc((d) => rotateComponent(d, selectedComp.id, 90))}
                                onDelete={() => {
                                    if (!selectedComp) return;
                                    mutateDoc((d) => removeComponent(d, selectedComp.id));
                                    setSelection(null);
                                }}
                                netWarnings={buildNetWarnings(resolvedNets, doc, canvasValidation)}
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
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

/** Build the AC directive object used at Run time (shared by normal AC, Monte Carlo, and goal seek). */
function buildAcDirective(parsed, acOverride) {
    const parsedAc = parsed.directives.find((d) => d.kind === 'ac') || {
        mode: 'dec', n: 20, fStart: 1, fStop: 1e6,
    };
    const pickF = (str, fallback) => {
        const t = String(str ?? '').trim();
        if (!t) return fallback;
        const v = parseSiValue(t);
        return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    const pickN = (str, fallback) => {
        const t = String(str ?? '').trim();
        if (!t) return fallback;
        const v = parseSiValue(t);
        if (!Number.isFinite(v) || v < 1) return fallback;
        return Math.max(1, Math.floor(v));
    };
    const modeStr = String(acOverride?.mode || '').trim();
    const modeRaw = (modeStr || parsedAc.mode || 'dec').toLowerCase();
    const mode = modeRaw === 'oct' ? 'oct' : (modeRaw === 'lin' ? 'lin' : 'dec');
    return {
        kind: 'ac',
        mode,
        n: pickN(acOverride?.n, parsedAc.n ?? 20),
        fStart: pickF(acOverride?.fStart, parsedAc.fStart ?? 1),
        fStop: pickF(acOverride?.fStop, parsedAc.fStop ?? 1e6),
    };
}

/**
 * Build a synthetic `.step` directive from the UI parametric-sweep
 * spec. Returns `{ stepDir }` on success, or `{ error }` with a
 * user-facing message on any validation failure.
 *
 * The solver accepts { target, start, stop, step } where `target` is
 * the component ref (e.g. "R1" or "V1"). We cross-check that the
 * component exists and is sweepable (R / C / L / V / I) before
 * handing anything to runWithStep so the user gets a helpful
 * message instead of a solver stack trace.
 */
function buildSweepDirective(sweep, doc, ctx) {
    const start = parseSiValue(sweep.start);
    const stop  = parseSiValue(sweep.stop);
    const step  = parseSiValue(sweep.step);

    if (!Number.isFinite(start) || !Number.isFinite(stop) || !Number.isFinite(step)) {
        return { error: 'Parametric sweep: start / stop / step must all be valid numbers.' };
    }
    if (step === 0) return { error: 'Parametric sweep: step cannot be zero.' };
    if (Math.sign(stop - start) !== Math.sign(step) && start !== stop) {
        return { error: `Parametric sweep: step sign doesn't match the ${start} → ${stop} direction.` };
    }

    // Target resolution: explicit UI choice wins; otherwise fall back
    // to the first sweepable element in the schematic (handy for
    // quick "just sweep something" runs).
    let target = String(sweep.target || '').trim();
    if (!target) {
        const first = doc?.components?.find((c) => isSweepableType(c.elementType));
        if (!first) return { error: 'Parametric sweep: no R / C / L / V / I in the schematic to sweep.' };
        target = first.ref;
    }

    // Confirm the element actually landed in the compiled context —
    // otherwise runWithStep would throw with a less friendly message.
    const lower = target.toLowerCase();
    const hit = ctx.elems.find((el) => String(el.name).toLowerCase() === lower);
    if (!hit) {
        return { error: `Parametric sweep: element "${target}" not found in the compiled circuit.` };
    }
    if (!['R', 'C', 'L', 'V', 'I'].includes(hit.type)) {
        return { error: `Parametric sweep: ${hit.type}-type element "${target}" has no sweepable value.` };
    }

    // Guard against accidental 10 000-iteration runs from a typo.
    const values = linspaceByStep(start, stop, step);
    if (values.length === 0) {
        return { error: 'Parametric sweep: range produced no points. Check start / stop / step.' };
    }
    if (values.length > 200) {
        return { error: `Parametric sweep: ${values.length} steps is too many — cap at 200.` };
    }

    return {
        stepDir: { kind: 'step', target, start, stop, step },
        values,
    };
}

/** Is this element type sweepable via setElementValue? */
function isSweepableType(elementType) {
    if (!elementType) return false;
    // Schematic element types include R, C, L, V_dc, V_pulse, V_sin,
    // V_ac, I_dc, etc. Reduce to the solver primitive.
    const first = String(elementType).charAt(0).toUpperCase();
    return ['R', 'C', 'L', 'V', 'I'].includes(first);
}

/**
 * Parse a time string like "1m", "500u", "2n", or "1e-3" into seconds.
 * Returns null if the string is empty, malformed, or non-positive.
 * Accepts both SPICE-ish SI prefixes (k M G m u n p f) and the plain
 * engineering suffix "ms" / "us" / "ns".
 */
function parseSiTime(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (s === '') return null;
    // Strip a trailing "s" unit so "1ms" reads as "1m".
    const body = s.replace(/s\b$/i, '');
    // Regex: optional sign, mantissa (required), optional exponent,
    // optional SI suffix. "Meg" is called out separately so "M" alone
    // means mega.
    const m = body.match(/^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*([a-zA-Zµ]+)?$/);
    if (!m) return null;
    const num = parseFloat(m[1]);
    if (!isFinite(num) || num <= 0) return null;
    const suffixRaw = (m[2] || '').toLowerCase();
    let scale = 1;
    if (suffixRaw === '' || suffixRaw === 's') scale = 1;
    else if (suffixRaw === 'meg') scale = 1e6;
    else if (suffixRaw === 'k')   scale = 1e3;
    else if (suffixRaw === 'g')   scale = 1e9;
    else if (suffixRaw === 'm')   scale = 1e-3;
    else if (suffixRaw === 'ms')  scale = 1e-3;
    else if (suffixRaw === 'u' || suffixRaw === 'µ') scale = 1e-6;
    else if (suffixRaw === 'us')  scale = 1e-6;
    else if (suffixRaw === 'n')   scale = 1e-9;
    else if (suffixRaw === 'ns')  scale = 1e-9;
    else if (suffixRaw === 'p')   scale = 1e-12;
    else if (suffixRaw === 'ps')  scale = 1e-12;
    else if (suffixRaw === 'f')   scale = 1e-15;
    else return null;
    return num * scale;
}

/**
 * Animate a completed transient result into `liveStream` in chunks,
 * so any open scope modals replay the waveform as if it were being
 * produced in real time. Chunks are sized to target ~60fps; we cap
 * at a sensible total duration so long sweeps don't feel glacial.
 *
 * `onDone` is invoked with no arguments once the last chunk ships.
 * Callers typically use it to commit the full `runResult` and clear
 * `liveStream` back to null.
 */
function streamTranResult(result, setLiveStream, onDone) {
    if (!result || result.kind !== 'tran' || !result.t?.length) {
        onDone?.();
        return;
    }
    const total = result.t.length;
    // Play it back in ~30 frames, or fewer if the data is short.
    const frames = Math.min(30, Math.max(4, Math.ceil(total / 32)));
    const perFrame = Math.max(1, Math.ceil(total / frames));

    // Pre-index signals by name for fast slicing.
    const byName = {};
    for (const sig of result.signals) byName[sig.name] = sig;

    let cursor = 0;
    const step = () => {
        cursor = Math.min(total, cursor + perFrame);
        const tSlice = result.t.slice(0, cursor);
        const ySignals = {};
        for (const name of Object.keys(byName)) {
            const arr = byName[name].y;
            if (!arr) continue;
            ySignals[name] = arr.slice(0, cursor);
        }
        setLiveStream({ t: tSlice, ySignals });
        if (cursor < total) {
            requestAnimationFrame(step);
        } else {
            onDone?.();
        }
    };
    requestAnimationFrame(step);
}

/** Slice `liveStream` to the channel names wired on a SCOPE (modal + drawer). */
function livePartialForChannels(liveStream, channels) {
    if (!liveStream?.t?.length || !channels?.length) return null;
    const yBySignal = {};
    for (const ch of channels) {
        if (!ch.signalName) continue;
        const y = liveStream.ySignals?.[ch.signalName];
        if (y && y.length) yBySignal[ch.signalName] = y;
    }
    return Object.keys(yBySignal).length
        ? { t: liveStream.t, yBySignal }
        : null;
}

/**
 * Build a snapshot mapping of `"<compId>|<pinId>"` → `V(<nodeLabel>)`
 * for every pin in the doc, using whatever net resolution was in force
 * when the simulation ran. We stash this on the run result so that
 * subsequent edits (drag, rotate, net re-number) don't break the scope
 * / probe modal's ability to find its signal — a pin that was attached
 * to net "n3" at sim time is still attached to the same electrical net,
 * even if the doc now calls it "n5" after a renumber.
 */
function buildPinSignalMap(doc, nets) {
    const map = new Map();
    if (!doc || !nets) return map;
    const labelFor = (nodeId) => {
        if (nodeId == null || nodeId === 0) return null;
        const lab = nets.nodeLabels?.get(nodeId);
        return (lab && !/^n\d+$/i.test(lab) && lab !== 'gnd') ? lab : `n${nodeId}`;
    };
    for (const c of doc.components) {
        // Skip pure-UI-only parts that don't own any pins we care
        // about in the signal namespace (SCOPE still goes through —
        // its `tip` pin is exactly what we look up later).
        if (c.elementType === 'GND') continue;
        try {
            const pins = componentPins(c) || [];
            for (const p of pins) {
                const nid = nets.pinNode(c, p.id);
                const lab = labelFor(nid);
                if (lab) map.set(`${c.id}|${p.id}`, `V(${lab})`);
            }
        } catch { /* tolerate malformed / unregistered parts */ }
    }
    return map;
}

/**
 * Resolve CH1 (`tip`) and optionally CH2 (`tip2`) for a SCOPE — same
 * naming rules as the probe auto-selector and `buildPinSignalMap`.
 * `scopeChannelMode === 'single'` limits the UI to CH1 only.
 */
function scopeSignalsFor(comp, nets, runResult) {
    if (!comp || !nets) {
        return { channels: [] };
    }
    const dual = comp.scopeChannelMode !== 'single';
    const slots = dual
        ? [{ pin: 'tip', label: 'CH1' }, { pin: 'tip2', label: 'CH2' }]
        : [{ pin: 'tip', label: 'CH1' }];
    const channels = slots.map(({ pin, label }) => {
        const pinKey = `${comp.id}|${pin}`;
        const snap = runResult?.pinSignalMap?.get(pinKey);
        if (snap) {
            const lab = snap.replace(/^V\((.*)\)$/, '$1');
            return { pin, label, signalName: snap, nodeLabel: lab };
        }
        const nodeId = nets.pinNode(comp, pin);
        if (nodeId == null || nodeId === 0) {
            return { pin, label, signalName: null, nodeLabel: null };
        }
        const lab = nets.nodeLabels?.get(nodeId);
        const nodeLabel = (lab && !/^n\d+$/i.test(lab) && lab !== 'gnd') ? lab : `n${nodeId}`;
        return { pin, label, signalName: `V(${nodeLabel})`, nodeLabel };
    });
    return { channels };
}

function buildNetWarnings(nets, doc, validation) {
    // Prefer the full design-rule output when available — it catches
    // dangling wire ends, missing ground, and orphan parts on top of
    // floating pins. Fall back to the pin-only summary if validation
    // isn't wired in yet (e.g. during an early render).
    if (validation && Array.isArray(validation.issues)) {
        return validation.issues.map((i) => i.message);
    }
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
                            strokeWidth={1.25}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    ))}

                    {/* Junction dots where three or more wires meet */}
                    {junctions.map((j, i) => (
                        <circle key={`j-${i}`} cx={j.x} cy={j.y} r={2.6} fill={wireStroke} />
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
                <line x1={0} y1={-10} x2={0} y2={0} stroke="var(--sch-wire)" strokeWidth={1.25} />
                <line x1={-10} y1={0} x2={10} y2={0} stroke="var(--sch-wire)" strokeWidth={1.55} />
                <line x1={-7} y1={4} x2={7} y2={4} stroke="var(--sch-wire)" strokeWidth={1.25} />
                <line x1={-4} y1={8} x2={4} y2={8} stroke="var(--sch-wire)" strokeWidth={1.25} />
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

/** Recharts `ResponsiveContainer` needs numeric heights; scale with viewport when maximized. */
function useResultChartHeights(expanded) {
    const [dims, setDims] = useState(() => ({
        main: 260,
        mag: 160,
        ph: 130,
    }));
    useEffect(() => {
        if (!expanded) {
            const id = requestAnimationFrame(() => {
                setDims({ main: 260, mag: 160, ph: 130 });
            });
            return () => cancelAnimationFrame(id);
        }
        const measure = () => {
            const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
            const main = Math.max(280, Math.floor(vh * 0.56));
            const bodeBlock = Math.max(340, Math.floor(vh * 0.5));
            const mag = Math.round(bodeBlock * 0.56);
            const ph = Math.max(110, bodeBlock - mag);
            setDims({ main, mag, ph });
        };
        const id = requestAnimationFrame(() => measure());
        window.addEventListener('resize', measure);
        return () => {
            cancelAnimationFrame(id);
            window.removeEventListener('resize', measure);
        };
    }, [expanded]);
    return dims;
}

/** Optional row: combine two non-derived traces (same analysis kind). */
function TraceMathBar({ result, traceMath, onTraceMathChange }) {
    const base = (result.signals || []).filter((s) => !s.derived);
    const opts = base.map((s) => (
        <option key={s.name} value={s.name}>{s.name}</option>
    ));
    return (
        <div className="cs-trace-math-bar">
            <label className={`cs-trace-math-toggle${traceMath.enabled ? ' is-on' : ''}`}>
                <input
                    type="checkbox"
                    checked={!!traceMath.enabled}
                    onChange={(e) => {
                        const on = e.target.checked;
                        if (!on) {
                            onTraceMathChange((t) => ({ ...t, enabled: false }));
                            return;
                        }
                        const list = (result.signals || []).filter((s) => !s.derived);
                        if (list.length < 2) {
                            onTraceMathChange((t) => ({ ...t, enabled: true }));
                            return;
                        }
                        let sigA = traceMath.sigA;
                        let sigB = traceMath.sigB;
                        if (!sigA || !list.some((s) => s.name === sigA)) sigA = list[0].name;
                        if (!sigB || !list.some((s) => s.name === sigB)) sigB = list[1].name;
                        if (sigA === sigB) {
                            const alt = list.find((s) => s.name !== sigA);
                            if (alt) sigB = alt.name;
                        }
                        onTraceMathChange((t) => ({
                            ...t, enabled: true, sigA, sigB,
                        }));
                    }}
                />
                Trace math
            </label>
            {traceMath.enabled && base.length >= 2 && (
                <>
                    <select
                        className="cs-trace-math-op"
                        value={traceMath.op}
                        onChange={(e) => onTraceMathChange((t) => ({ ...t, op: e.target.value }))}
                        title="Operation"
                    >
                        <option value="minus">A − B</option>
                        <option value="plus">A + B</option>
                        <option value="times">A × B</option>
                    </select>
                    <select
                        className="cs-trace-math-sig"
                        value={traceMath.sigA}
                        onChange={(e) => onTraceMathChange((t) => ({ ...t, sigA: e.target.value }))}
                        title="Trace A"
                    >{opts}</select>
                    <select
                        className="cs-trace-math-sig"
                        value={traceMath.sigB}
                        onChange={(e) => onTraceMathChange((t) => ({ ...t, sigB: e.target.value }))}
                        title="Trace B"
                    >{opts}</select>
                </>
            )}
            {traceMath.enabled && base.length < 2 && (
                <span className="cs-trace-math-hint">Need at least two traces.</span>
            )}
        </div>
    );
}

function MonteCarloSummary({ monte }) {
    if (!monte?.runs) return null;
    const { min, max, mean, std } = monte.pmStats || {};
    const fmt = (x) => (Number.isFinite(x) ? `${x.toFixed(1)}°` : '—');
    const showTable = Array.isArray(monte.phaseMargins) && monte.phaseMargins.length > 0
        && monte.phaseMargins.length <= 48;
    return (
        <div className="cs-monte-summary">
            <div className="cs-monte-summary-line">
                <strong>Monte Carlo</strong>
                {' — '}
                {monte.runs} runs, each R/C/L scaled independently within ±{monte.tolPercent ?? '—'}%.
                Mean magnitude/phase is plotted.
                {monte.pmNode && (
                    <>
                        {' '}Phase margin on <code>V({monte.pmNode})</code>
                        {': min '}{fmt(min)}{', max '}{fmt(max)}{', mean '}{fmt(mean)}{', σ '}{fmt(std)}.
                    </>
                )}
            </div>
            {showTable && (
                <table className="cs-monte-table">
                    <thead><tr><th>Run</th><th>PM @ V({monte.pmNode})</th></tr></thead>
                    <tbody>
                        {monte.phaseMargins.map((pm, i) => (
                            <tr key={i}>
                                <td>{i + 1}</td>
                                <td className="cs-mono">{Number.isFinite(pm) ? `${pm.toFixed(2)}°` : '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

function ResultsPanel({
    result,
    expandedChart = false,
    selectedSignals, onSignalsChange,
    cursorA, cursorB, onCursorAChange, onCursorBChange,
    activeCursor, onActiveCursorChange,
    showMeasure, onShowMeasureChange,
    onExportCsv,
    traceMath,
    onTraceMathChange,
    onSignalProbeHover,
}) {
    const { main: chartH, mag: bodeMagH, ph: bodePhH } = useResultChartHeights(expandedChart);
    const toggle = (name) => {
        onSignalsChange(selectedSignals.includes(name)
            ? selectedSignals.filter((s) => s !== name)
            : [...selectedSignals, name]);
    };

    if (result.kind === 'op') {
        return (
            <div className="cs-op-results">
                <div className="cs-op-meta cs-op-meta-row">
                    <span>
                        Converged in {result.iters} iteration{result.iters > 1 ? 's' : ''}.
                    </span>
                    <button
                        type="button"
                        className="cs-topbtn"
                        onClick={onExportCsv}
                        title="Download node voltages as CSV (node, value)"
                    >
                        <Download size={12} /> Save CSV
                    </button>
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
                    <div className="cs-plot-header-col">
                        <SignalChips
                            result={result}
                            selected={selectedSignals}
                            onToggle={toggle}
                            onSignalProbeHover={onSignalProbeHover}
                        />
                        <TraceMathBar result={result} traceMath={traceMath} onTraceMathChange={onTraceMathChange} />
                    </div>
                    <div className="cs-plot-toolbar-right">
                        <button
                            type="button"
                            className="cs-topbtn"
                            onClick={onExportCsv}
                            title="Download sweep data as CSV (first column = sweep variable; ticked traces as columns)"
                        >
                            <Download size={12} /> Save CSV
                        </button>
                        <button
                            type="button"
                            className={`cs-topbtn${showMeasure ? ' is-active' : ''}`}
                            onClick={() => onShowMeasureChange(!showMeasure)}
                            title="Toggle cursor readouts"
                        >
                            <SlidersHorizontal size={12} /> Measure
                        </button>
                    </div>
                </div>
                <div
                    className={`cs-chart-outer${activeCursor ? ' is-dragging' : ''}`}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                >
                    <ResponsiveContainer width="100%" height={chartH}>
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
                    <div className="cs-plot-header-col">
                        <SignalChips
                            result={result}
                            selected={selectedSignals}
                            onToggle={toggle}
                            onSignalProbeHover={onSignalProbeHover}
                        />
                        <TraceMathBar result={result} traceMath={traceMath} onTraceMathChange={onTraceMathChange} />
                    </div>
                    <div className="cs-plot-toolbar-right">
                        <button
                            type="button"
                            className="cs-topbtn"
                            onClick={onExportCsv}
                            title="Download transient waveforms as CSV (time in seconds, first column)"
                        >
                            <Download size={12} /> Save CSV
                        </button>
                        <button
                            type="button"
                            className={`cs-topbtn${showMeasure ? ' is-active' : ''}`}
                            onClick={() => onShowMeasureChange(!showMeasure)}
                            title="Toggle cursor & auto-measure panel"
                        >
                            <SlidersHorizontal size={12} /> Measure
                        </button>
                    </div>
                </div>
                <div
                    className={`cs-chart-outer${activeCursor ? ' is-dragging' : ''}`}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                >
                    <ResponsiveContainer width="100%" height={chartH}>
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
                if (s.yMode === 'noiseV2') {
                    mag[i][s.name] = 10 * Math.log10(Math.max(s.mag[i], 1e-99));
                } else {
                    mag[i][s.name] = 20 * Math.log10(Math.max(s.mag[i], 1e-18));
                }
                phase[i][s.name] = s.phase[i];
            }
        }
        const phaseSignalNames = selectedSignals.filter((name) => {
            const s = result.signals.find((x) => x.name === name);
            return s && s.yMode !== 'noiseV2';
        });
        return (
            <div className="cs-plot-wrap">
                <div className="cs-plot-header">
                    <div className="cs-plot-header-col">
                        <SignalChips
                            result={result}
                            selected={selectedSignals}
                            onToggle={toggle}
                            onSignalProbeHover={onSignalProbeHover}
                        />
                        <TraceMathBar result={result} traceMath={traceMath} onTraceMathChange={onTraceMathChange} />
                    </div>
                    <div className="cs-plot-toolbar-right">
                        <button
                            type="button"
                            className="cs-topbtn"
                            onClick={onExportCsv}
                            title="Download AC data as CSV (Hz; linear |V| and *_phase_deg per trace — plot uses dB)"
                        >
                            <Download size={12} /> Save CSV
                        </button>
                        <button
                            type="button"
                            className={`cs-topbtn${showMeasure ? ' is-active' : ''}`}
                            onClick={() => onShowMeasureChange(!showMeasure)}
                            title="Toggle cursor & auto-measure panel"
                        >
                            <SlidersHorizontal size={12} /> Measure
                        </button>
                    </div>
                </div>
                <div
                    className={`cs-chart-outer cs-chart-bode${activeCursor ? ' is-dragging' : ''}`}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                >
                    <div className="cs-bode-wrap">
                        <ResponsiveContainer width="100%" height={bodeMagH}>
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
                                    label={{
                                        value: 'Mag (dB); noise trace uses 10*log10(V^2/Hz)',
                                        angle: -90,
                                        position: 'insideLeft',
                                        fontSize: 10,
                                    }}
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
                        <ResponsiveContainer width="100%" height={bodePhH}>
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
                                {phaseSignalNames.map((name) => {
                                    const ci = selectedSignals.indexOf(name);
                                    const i = ci >= 0 ? ci : 0;
                                    return (
                                        <Line
                                            key={`p-${name}`}
                                            type="monotone"
                                            dataKey={name}
                                            stroke={SIGNAL_COLORS[i % SIGNAL_COLORS.length]}
                                            dot={false} strokeWidth={1.2} isAnimationActive={false}
                                        />
                                    );
                                })}
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
                {result.monte && <MonteCarloSummary monte={result.monte} />}
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
                                    {aRow ? formatYAtX(xOf(s), yOf(s), cursorA, yUnit, isAC, s.yMode) : '—'}
                                </td>
                            ))}
                        </tr>
                        <tr>
                            <td className="cs-cursor-tag" style={{ color: '#22d3ee' }}>B</td>
                            <td className="cs-mono">{bRow ? formatSIValue(cursorB, xUnit) : '—'}</td>
                            {sigs.map((s) => (
                                <td key={s.name} className="cs-mono">
                                    {bRow ? formatYAtX(xOf(s), yOf(s), cursorB, yUnit, isAC, s.yMode) : '—'}
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
                                        {isAC && s.yMode === 'noiseV2'
                                            ? formatDbDelta(Math.sqrt(Math.max(yA, 0)), Math.sqrt(Math.max(yB, 0)))
                                            : (isAC ? formatDbDelta(yA, yB) : formatSIValue(dy, yUnit))}
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
                                <th title="First frequency where |H| = 1 (0 dB)">Unity f</th>
                                <th title="180° + phase at unity-gain frequency (when a 0 dB crossing exists)">PM</th>
                                <th title="Negative of gain (dB) at first −180° phase crossing">GM</th>
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
                                {isAC
                                    ? (s.yMode === 'noiseV2' ? <NoiseAcMeasureCells /> : <AcMeasureCells sig={s} />)
                                    : <TranMeasureCells sig={s} />}
                            </tr>
                        ))}
                        {sigs.length === 0 && (
                            <tr><td colSpan={isAC ? 6 : 6} className="cs-empty-cell">Pick a signal above.</td></tr>
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
    const gm = gainMargin(sig.f, sig.mag, sig.phase);
    return (
        <>
            <td className="cs-mono">{Number.isFinite(pg) ? `${pg.toFixed(1)} dB` : '—'}</td>
            <td className="cs-mono">{Number.isFinite(c3) ? formatSIValue(c3, 'Hz') : '—'}</td>
            <td className="cs-mono">{Number.isFinite(ug) ? formatSIValue(ug, 'Hz') : '—'}</td>
            <td className="cs-mono">{Number.isFinite(pm) ? `${pm.toFixed(1)}°` : '—'}</td>
            <td className="cs-mono">{Number.isFinite(gm) ? `${gm.toFixed(1)} dB` : '—'}</td>
        </>
    );
}

function NoiseAcMeasureCells() {
    const dash = <td className="cs-mono">—</td>;
    return <>{dash}{dash}{dash}{dash}{dash}</>;
}

/** Short coach strip when AC analysis is selected — links to the stability demo. */
function AcAmplifierCoach({ onDismiss, onLoadStabilityDemo }) {
    return (
        <div className="cs-ac-amp-coach" role="region" aria-label="Amplifier AC design tips">
            <div className="cs-ac-amp-coach-text">
                <strong>Amplifier design</strong>
                {' — '}
                Use the Bode plot (magnitude + phase) to judge bandwidth and stability. With <strong>Measure</strong> enabled,
                Auto-measure lists peak gain, −3 dB corner, unity-gain frequency, <strong>phase margin (PM)</strong>, and{' '}
                <strong>gain margin (GM)</strong>. For compensation trades, enable <strong>Parametric sweep</strong> on a capacitor
                (e.g. Cf) and compare overlaid curves after each Run.
            </div>
            <div className="cs-ac-amp-coach-actions">
                <button type="button" className="cs-topbtn cs-topbtn-primary" onClick={onLoadStabilityDemo}>
                    Load stability demo
                </button>
                <button type="button" className="cs-topbtn" onClick={onDismiss}>Dismiss tips</button>
            </div>
            <button type="button" className="cs-ac-amp-coach-x" onClick={onDismiss} aria-label="Dismiss">×</button>
        </div>
    );
}

function formatYAtX(xArr, yArr, x, unit, isAC, yMode) {
    if (xArr == null || yArr == null) return '—';
    const y = sampleAt(xArr, yArr, x);
    if (!Number.isFinite(y)) return '—';
    if (isAC && yMode === 'noiseV2') {
        const vn = Math.sqrt(Math.max(y, 0));
        const db = 20 * Math.log10(Math.max(vn, 1e-18));
        return `${formatSIValue(vn, 'V/√Hz')} (${db.toFixed(1)} dB)`;
    }
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

function SignalChips({ result, selected, onToggle, onSignalProbeHover }) {
    const all = result.signals.map((s) => s.name);
    return (
        <div className="cs-signal-chips">
            {all.map((n, i) => (
                <button
                    key={n}
                    type="button"
                    className={`cs-chip${selected.includes(n) ? ' is-on' : ''}`}
                    style={{ '--chip-color': SIGNAL_COLORS[i % SIGNAL_COLORS.length] }}
                    onClick={() => onToggle(n)}
                    onMouseEnter={() => {
                        const net = voltageProbeNetFromSignalName(n);
                        onSignalProbeHover?.(net || null);
                    }}
                    onMouseLeave={() => onSignalProbeHover?.(null)}
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
function buildStepResult(kind, runs, parsed, stepDir, ctx) {
    if (!runs || runs.length === 0) {
        throw new Error('Run returned no results.');
    }
    const isMulti = runs.length > 1;
    const signals = [];
    // Branch-unknown elements in the same order the solver indexed
    // them, so branchI[b] corresponds to branchElems[b]. Used to emit
    // I(<ref>) signals for every V, L, E, O element — which naturally
    // covers current probes (they're emitted as 0 V sources).
    const branchElems = ctx?.branchElems || [];
    const branchName = (el) => {
        // Current probes are emitted as "V<ref>" (prefix enforced in
        // emitNetlist). Strip the leading V so the plot just shows
        // I(<user ref>), which matches the palette.
        if (/^VIP\d+/i.test(el.name)) return el.name.slice(1);
        return el.name;
    };

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
            if (res.branchI) {
                for (let b = 0; b < branchElems.length && b < res.branchI.length; b++) {
                    signals.push({
                        name: `I(${branchName(branchElems[b])})${suffix}`,
                        kind: 'tran',
                        t: res.t,
                        y: res.branchI[b],
                        stepValue: runs[r].stepValue,
                        baseBranch: branchName(branchElems[b]),
                    });
                }
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
            if (res.branchI) {
                for (let b = 0; b < branchElems.length && b < res.branchI.length; b++) {
                    const samples = res.branchI[b];
                    signals.push({
                        name: `I(${branchName(branchElems[b])})${suffix}`,
                        kind: 'ac',
                        f: res.freqs,
                        mag: samples.map((s) => Math.hypot(s.re, s.im)),
                        phase: samples.map((s) => Math.atan2(s.im, s.re) * 180 / Math.PI),
                        stepValue: runs[r].stepValue,
                        baseBranch: branchName(branchElems[b]),
                    });
                }
            }
            const nse = runs[r].acNoise;
            if (nse?.noiseV2PerHz?.length === res.freqs.length) {
                const onBase = nse.outputNode || 'out';
                const arr = nse.noiseV2PerHz;
                signals.push({
                    name: `onoise V(${onBase})${suffix}`,
                    kind: 'ac',
                    yMode: 'noiseV2',
                    f: res.freqs,
                    mag: Array.from(arr),
                    phase: res.freqs.map(() => 0),
                    stepValue: runs[r].stepValue,
                    baseNode: onBase,
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
            if (res.branchI) {
                for (let b = 0; b < branchElems.length && b < res.branchI.length; b++) {
                    signals.push({
                        name: `I(${branchName(branchElems[b])})${suffix}`,
                        kind: 'dc',
                        x: res.sweepValues,
                        y: res.branchI[b],
                        stepValue: runs[r].stepValue,
                        baseBranch: branchName(branchElems[b]),
                    });
                }
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
