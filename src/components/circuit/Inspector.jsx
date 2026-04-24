import React, { useMemo } from 'react';
import { RotateCw, Trash2 } from 'lucide-react';
import { SYMBOLS } from '../../circuit/symbols.js';
import { SymbolGlyph } from './SymbolGlyph.jsx';
import { BUILTIN_MODELS, getPart } from '../../circuit/library.js';

/**
 * Right-side property editor.
 *
 * Shows a contextual form for the currently-selected component:
 *   • Reference designator (R1 / Q2 / …)
 *   • Scalar value (with SI-prefix picker) for passives and
 *     dependent sources.
 *   • Source waveform editor (DC / AC / SIN / PULSE / PWL) for V/I.
 *   • Model picker (from BUILTIN_MODELS) for diodes, BJTs, MOSFETs.
 *   • Delete / Rotate buttons.
 *
 * When nothing is selected, the panel shows a hint + the list of
 * warnings from the most recent net resolution (floating pins,
 * unmodelled devices).
 */
export default function Inspector({
    selectedComp, onUpdate, onRotate, onDelete,
    netWarnings, analysisPane,
}) {
    if (!selectedComp) {
        return (
            <div className="cs-inspector">
                <div className="cs-inspector-empty">
                    <h3>No selection</h3>
                    <p>Click a component on the canvas to edit its properties.</p>
                </div>
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

    return (
        <div className="cs-inspector">
            <div className="cs-inspector-header">
                <div className="cs-inspector-preview">
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
                    onChange={(e) => onUpdate({ ref: e.target.value })}
                />
            </Field>

            {/* Scalar-value editor for passives and dependent sources */}
            {['R', 'C', 'L', 'E', 'G'].includes(selectedComp.elementType) && (
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
                        {modelChoicesFor(selectedComp.elementType).map((m) => (
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
    return { R: 'Ω', C: 'F', L: 'H', E: 'V/V', G: 'A/V' }[type] || '';
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
                                onChange={(e) => patchSpec('dc', { v: +e.target.value })} />
                        </Field>
                    )}
                    {s.kind === 'ac' && (
                        <>
                            <Field label={`Magnitude (${suffix})`}>
                                <input type="number" step="any" value={s.mag}
                                    onChange={(e) => patchSpec('ac', { mag: +e.target.value })} />
                            </Field>
                            <Field label="Phase (°)">
                                <input type="number" step="any" value={s.phase ?? 0}
                                    onChange={(e) => patchSpec('ac', { phase: +e.target.value })} />
                            </Field>
                        </>
                    )}
                    {s.kind === 'sin' && (
                        <div className="cs-inspector-grid">
                            {sinFields(suffix).map(([key, label, step]) => (
                                <Field key={key} label={label}>
                                    <input type="number" step={step} value={s[key] ?? 0}
                                        onChange={(e) => patchSpec('sin', { [key]: +e.target.value })} />
                                </Field>
                            ))}
                        </div>
                    )}
                    {s.kind === 'pulse' && (
                        <div className="cs-inspector-grid">
                            {pulseFields(suffix).map(([key, label, step]) => (
                                <Field key={key} label={label}>
                                    <input type="number" step={step} value={s[key] ?? 0}
                                        onChange={(e) => patchSpec('pulse', { [key]: +e.target.value })} />
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

/* ---------------- model choices ---------------- */

function modelChoicesFor(elementType) {
    const all = Object.keys(BUILTIN_MODELS);
    switch (elementType) {
        case 'D': return all.filter((k) => /^D/i.test(k) && !/^Q/.test(k));
        case 'Q': return all.filter((k) => /^Q/i.test(k));
        case 'M': return all.filter((k) => /^M/i.test(k));
        default:  return all;
    }
}
