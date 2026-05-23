import React, { useMemo } from 'react';
import { RotateCw, Trash2 } from 'lucide-react';
import { parseCommittedNumberInput } from '../../mems/memsInputParse.js';
import { SYMBOLS } from '../../circuit/symbols.js';
import { SymbolGlyph } from './SymbolGlyph.jsx';
import { getPart, modelChoicesForElement } from '../../circuit/library.js';

/**
 * Right-side property editor.
 *
 * Shows a contextual form for the currently-selected component:
 *   • Reference designator (R1 / Q2 / …)
 *   • Scalar value (with SI-prefix picker) for passives and
 *     dependent sources.
 *   • Source waveform editor (DC / AC / SIN / PULSE / PWL) for V/I.
 *   • Model picker (built-ins + doc userModels) for diodes, BJTs, MOSFETs.
 *   • Delete / Rotate buttons.
 *
 * When nothing is selected, the panel shows a hint + the list of
 * warnings from the most recent net resolution (floating pins,
 * unmodelled devices).
 */
export default function Inspector({
    selectedComp, onUpdate, onRotate, onDelete,
    bulkSelection, onBulkDelete,
    netWarnings, analysisPane,
    userModels = [],
}) {
    if (!selectedComp) {
        const nBulk = bulkSelection
            ? (bulkSelection.componentIds?.length || 0) + (bulkSelection.wireIds?.length || 0)
                + (bulkSelection.labelIds?.length || 0)
            : 0;
        return (
            <div className="cs-inspector">
                {bulkSelection && nBulk > 0 ? (
                    <div className="cs-inspector-empty cs-inspector-bulk">
                        <h3>Area selection</h3>
                        <p>
                            {bulkSelection.componentIds?.length || 0} part(s),{' '}
                            {bulkSelection.wireIds?.length || 0} wire segment(s),{' '}
                            {bulkSelection.labelIds?.length || 0} net label(s).
                        </p>
                        <button
                            type="button"
                            className="cs-inspector-btn cs-danger"
                            onClick={onBulkDelete}
                        >
                            <Trash2 size={14} /> Delete selected
                        </button>
                        <p className="cs-inspector-hint">
                            With the select tool, <b>right-drag</b> or <b>Shift+left-drag</b> on the canvas to box-select wires, net labels, and parts. Press <b>Del</b> or use Delete selected here.
                        </p>
                    </div>
                ) : (
                    <div className="cs-inspector-empty">
                        <h3>No selection</h3>
                        <p>Click a component on the canvas to edit its properties.</p>
                    </div>
                )}
                {netWarnings && netWarnings.length > 0 && (
                    <div className="cs-inspector-warnings">
                        <div className="cs-inspector-title">Net warnings</div>
                        <ul>
                            {netWarnings.map((w, i) => (
                                <li key={i}>{w}</li>
                            ))}
                        </ul>
                    </div>
                )}
                {analysisPane}
            </div>
        );
    }

    const sym = SYMBOLS[selectedComp.symbolKey] || SYMBOLS[selectedComp.elementType];
    const part = getPart(selectedComp.partId);
    const modelSelectOptions = useMemo(() => {
        const base = modelChoicesForElement(selectedComp.elementType, userModels);
        const cur = selectedComp.modelRef;
        if (cur && !base.some((x) => String(x).toLowerCase() === String(cur).toLowerCase())) {
            return [...base, cur];
        }
        return base;
    }, [selectedComp.elementType, selectedComp.modelRef, userModels]);

    return (
        <div className="cs-inspector">
            <div className="cs-inspector-header">
                <div className={`cs-inspector-preview cs-comp-${selectedComp.elementType}`}>
                    <SymbolGlyph symbol={sym} partType={selectedComp.elementType} partId={selectedComp.symbolKey} size={72} />
                </div>
                <div className="cs-inspector-heading">
                    <div className="cs-inspector-title">{part?.name || selectedComp.elementType}</div>
                    <div className="cs-inspector-sub">{part?.description || ''}</div>
                </div>
            </div>

            <div className="cs-inspector-actions">
                <button className="cs-inspector-btn" onClick={onRotate} title="Rotate 90° (R)">
                    <RotateCw size={14} /> Rotate
                </button>
                <button className="cs-inspector-btn cs-danger" onClick={onDelete} title="Delete (Del)">
                    <Trash2 size={14} /> Delete
                </button>
            </div>

            <Field label="Reference">
                <input
                    type="text"
                    value={selectedComp.ref}
                    readOnly={selectedComp.elementType === 'GND'}
                    title={selectedComp.elementType === 'GND' ? 'Ground is always node 0 in SPICE' : undefined}
                    onChange={(e) => onUpdate({ ref: e.target.value })}
                />
            </Field>

            {selectedComp.elementType === 'SCOPE' && (
                <Field label="Channels">
                    <select
                        value={selectedComp.scopeChannelMode === 'single' ? 'single' : 'dual'}
                        onChange={(e) => onUpdate({ scopeChannelMode: e.target.value })}
                    >
                        <option value="dual">Dual — two tips (CH1 + CH2)</option>
                        <option value="single">Single — one tip (CH1)</option>
                    </select>
                </Field>
            )}

            <PartNotes comp={selectedComp} />

            {/* Scalar-value editor for passives and dependent sources */}
            {['R', 'C', 'L', 'E', 'G', 'REG'].includes(selectedComp.elementType) && (
                <ValueEditor
                    value={selectedComp.value}
                    unit={selectedComp.valueUnit || inferUnit(selectedComp.elementType)}
                    onChange={(v) => onUpdate({ value: v })}
                />
            )}

            {/* Source-spec editor for V / I */}
            {['V', 'I'].includes(selectedComp.elementType) && (
                <SourceEditor
                    kind={selectedComp.elementType}
                    sources={selectedComp.sourceSpec || []}
                    onChange={(s) => onUpdate({ sourceSpec: s })}
                />
            )}

            {/* Model picker for semiconductors */}
            {['D', 'Q', 'M'].includes(selectedComp.elementType) && (
                <Field label="Model">
                    <select
                        value={selectedComp.modelRef || ''}
                        onChange={(e) => onUpdate({ modelRef: e.target.value })}
                    >
                        {modelSelectOptions.map((m) => (
                            <option key={m} value={m}>{m}</option>
                        ))}
                    </select>
                </Field>
            )}

            <div className="cs-inspector-meta">
                <div><span>Position</span><span className="cs-mono">({selectedComp.pos.x}, {selectedComp.pos.y})</span></div>
                <div><span>Rotation</span><span className="cs-mono">{selectedComp.rot}°</span></div>
            </div>
        </div>
    );
}

function Field({ label, children }) {
    return (
        <label className="cs-inspector-field">
            <span>{label}</span>
            {children}
        </label>
    );
}

/** Short context for parts with no extra scalar row (op-amp, probes, ground). */
function PartNotes({ comp }) {
    const t = comp.elementType;
    let text = '';
    if (t === 'O') {
        text = 'Ideal op-amp: enforces V(+) = V(−); output is a stiff voltage source. No gain, offset, or bandwidth parameters — use a VCVS (E) or the netlist drawer for a macromodel.';
    } else if (t === 'GND') {
        text = 'Ties the attached net to the simulator reference (node 0). Not emitted as a separate SPICE line.';
    } else if (t === 'VP') {
        text = 'Voltage probe — not in the netlist. After Run, its node is auto-selected for plotting.';
    } else if (t === 'SCOPE') {
        text = comp.scopeChannelMode === 'single'
            ? 'Single-channel mode: one probe terminal; CRT and Scope tab show CH1 only. Double-click to open properties and switch to dual for two tips.'
            : 'Dual-channel mode: two probe terminals (CH1 and CH2). Double-click for properties to switch to single. Not in the netlist.';
    } else if (t === 'IP') {
        text = 'Current probe — emitted as a 0 V source so branch current is solved. Plot I(<your reference>) after Run.';
    } else if (t === 'REG') {
        text = 'Ideal linear regulator: the netlist is a DC voltage source V(OUT)−V(GND) equal to the nominal output below. The IN pin is not in SPICE (no dropout, no input current) — use it on the schematic for wiring clarity only.';
    }
    if (!text) return null;
    return (
        <div className="cs-inspector-part-note">
            <p className="cs-inspector-hint">{text}</p>
        </div>
    );
}

/* ---------------- value editor with SI prefix ---------------- */

const SI_PREFIXES = [
    { label: 'p',   factor: 1e-12 },
    { label: 'n',   factor: 1e-9 },
    { label: 'u',   factor: 1e-6 },
    { label: 'm',   factor: 1e-3 },
    { label: '',    factor: 1 },
    { label: 'k',   factor: 1e3 },
    { label: 'Meg', factor: 1e6 },
    { label: 'G',   factor: 1e9 },
];

function pickPrefix(abs) {
    if (abs === 0 || !Number.isFinite(abs)) return SI_PREFIXES.find((p) => p.label === '');
    let best = SI_PREFIXES[0];
    for (const p of SI_PREFIXES) {
        if (abs / p.factor >= 1 && abs / p.factor < 1000) { best = p; break; }
        if (abs / p.factor >= 1) best = p;
    }
    return best;
}

function ValueEditor({ value, unit, onChange }) {
    const numeric = Number.isFinite(+value) ? +value : 0;
    const prefix = useMemo(() => pickPrefix(Math.abs(numeric)), [numeric]);
    const shown = numeric / prefix.factor;
    const handleNumber = (e) => {
        const raw = parseFloat(e.target.value);
        if (!Number.isFinite(raw)) return;
        onChange(raw * prefix.factor);
    };
    const handlePrefix = (e) => {
        const next = SI_PREFIXES.find((p) => p.label === e.target.value) || prefix;
        onChange(shown * next.factor);
    };
    return (
        <Field label={`Value (${unit})`}>
            <div className="cs-inspector-value-row">
                <input
                    type="number"
                    step="any"
                    value={Number.isFinite(shown) ? shown : ''}
                    onChange={handleNumber}
                />
                <select value={prefix.label} onChange={handlePrefix}>
                    {SI_PREFIXES.map((p) => (
                        <option key={p.label || 'base'} value={p.label}>
                            {p.label === '' ? '—' : p.label}
                        </option>
                    ))}
                </select>
            </div>
        </Field>
    );
}

function inferUnit(type) {
    return { R: 'Ω', C: 'F', L: 'H', E: 'V/V', G: 'A/V', REG: 'V' }[type] || '';
}

/* ---------------- source-spec editor ---------------- */

const SOURCE_KINDS = [
    { id: 'dc',    label: 'DC'    },
    { id: 'ac',    label: 'AC'    },
    { id: 'sin',   label: 'Sine'  },
    { id: 'pulse', label: 'Pulse' },
    { id: 'pwl',   label: 'PWL'   },
];

function SourceEditor({ kind, sources, onChange }) {
    const isI = kind === 'I';
    const suffix = isI ? 'A' : 'V';

    const addSpec = (k) => {
        const fresh = freshSpec(k, isI);
        onChange([...sources.filter((s) => s.kind !== k), fresh]);
    };
    const removeSpec = (k) => onChange(sources.filter((s) => s.kind !== k));
    const patchSpec = (k, patch) => onChange(sources.map((s) => s.kind === k ? { ...s, ...patch } : s));

    const active = new Set(sources.map((s) => s.kind));

    return (
        <div className="cs-inspector-source">
            <div className="cs-inspector-source-tabs">
                {SOURCE_KINDS.map((opt) => (
                    <label key={opt.id} className={`cs-inspector-source-tab${active.has(opt.id) ? ' is-active' : ''}`}>
                        <input
                            type="checkbox"
                            checked={active.has(opt.id)}
                            onChange={() => active.has(opt.id) ? removeSpec(opt.id) : addSpec(opt.id)}
                        /> {opt.label}
                    </label>
                ))}
            </div>

            {sources.map((s) => (
                <fieldset key={s.kind} className="cs-inspector-source-body">
                    <legend>{s.kind.toUpperCase()}</legend>
                    {s.kind === 'dc' && (
                        <Field label={`Level (${suffix})`}>
                            <input type="number" step="any" value={s.v}
                                onChange={(e) => {
                                    const v = parseCommittedNumberInput(e.target.value);
                                    if (v === null) return;
                                    patchSpec('dc', { v });
                                }} />
                        </Field>
                    )}
                    {s.kind === 'ac' && (
                        <>
                            <Field label={`Magnitude (${suffix})`}>
                                <input type="number" step="any" value={s.mag}
                                    onChange={(e) => {
                                        const v = parseCommittedNumberInput(e.target.value);
                                        if (v === null) return;
                                        patchSpec('ac', { mag: v });
                                    }} />
                            </Field>
                            <Field label="Phase (°)">
                                <input type="number" step="any" value={s.phase ?? 0}
                                    onChange={(e) => {
                                        const v = parseCommittedNumberInput(e.target.value);
                                        if (v === null) return;
                                        patchSpec('ac', { phase: v });
                                    }} />
                            </Field>
                        </>
                    )}
                    {s.kind === 'sin' && (
                        <div className="cs-inspector-grid">
                            {sinFields(suffix).map(([key, label, step]) => (
                                <Field key={key} label={label}>
                                    <input type="number" step={step} value={s[key] ?? 0}
                                        onChange={(e) => {
                                            const v = parseCommittedNumberInput(e.target.value);
                                            if (v === null) return;
                                            patchSpec('sin', { [key]: v });
                                        }} />
                                </Field>
                            ))}
                        </div>
                    )}
                    {s.kind === 'pulse' && (
                        <div className="cs-inspector-grid">
                            {pulseFields(suffix).map(([key, label, step]) => (
                                <Field key={key} label={label}>
                                    <input type="number" step={step} value={s[key] ?? 0}
                                        onChange={(e) => {
                                            const v = parseCommittedNumberInput(e.target.value);
                                            if (v === null) return;
                                            patchSpec('pulse', { [key]: v });
                                        }} />
                                </Field>
                            ))}
                        </div>
                    )}
                    {s.kind === 'pwl' && (
                        <Field label="Points (t,v,t,v,…)">
                            <textarea
                                rows={3}
                                value={(s.points || []).map((p) => p.join(' ')).join(', ')}
                                onChange={(e) => patchSpec('pwl', { points: parsePwl(e.target.value) })}
                                placeholder="0 0, 1m 5, 2m 0"
                            />
                        </Field>
                    )}
                </fieldset>
            ))}
            {sources.length === 0 && (
                <div className="cs-inspector-hint">Pick at least one waveform (DC is typical).</div>
            )}
        </div>
    );
}

function sinFields(suffix) {
    return [
        ['vo',    `Offset (${suffix})`, 'any'],
        ['va',    `Amplitude (${suffix})`, 'any'],
        ['f',     'Frequency (Hz)', 'any'],
        ['td',    'Delay (s)', 'any'],
        ['theta', 'Damping (1/s)', 'any'],
    ];
}

function pulseFields(suffix) {
    return [
        ['v1',  `Low (${suffix})`, 'any'],
        ['v2',  `High (${suffix})`, 'any'],
        ['td',  'Delay (s)', 'any'],
        ['tr',  'Rise (s)', 'any'],
        ['tf',  'Fall (s)', 'any'],
        ['pw',  'Width (s)', 'any'],
        ['per', 'Period (s)', 'any'],
    ];
}

function freshSpec(kind, isI) {
    switch (kind) {
        case 'dc':    return { kind: 'dc', v: isI ? 1e-3 : 5 };
        case 'ac':    return { kind: 'ac', mag: 1, phase: 0 };
        case 'sin':   return { kind: 'sin', vo: 0, va: isI ? 1e-3 : 1, f: 1e3, td: 0, theta: 0 };
        case 'pulse': return { kind: 'pulse', v1: 0, v2: isI ? 1e-3 : 5, td: 0, tr: 1e-6, tf: 1e-6, pw: 1e-3, per: 2e-3 };
        case 'pwl':   return { kind: 'pwl', points: [[0, 0], [1e-3, 1]] };
        default:      return { kind: 'dc', v: 0 };
    }
}

function parsePwl(txt) {
    const nums = txt.split(/[,\s]+/).filter(Boolean).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    return pts;
}

