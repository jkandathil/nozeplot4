import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check } from 'lucide-react';
import { BUILTIN_MODELS, getPart } from '../../circuit/library.js';
// SI parsing is shared with the parametric-sweep editor — keep it
// in one place so "4.7k" parses identically everywhere.
import { SI_MAP, parseSiValue } from '../../circuit/siUnits.js';

/**
 * Floating property editor that appears when the user double-clicks a
 * component on the canvas. Kept intentionally minimal — the full
 * Inspector in the side panel is still the home for rarely-used
 * controls (source-waveform editor, rotation, delete). The popup
 * focuses on the two fields people actually change mid-design:
 * reference designator and scalar value (or model name).
 *
 * Positioning: anchored to the screen coordinates the canvas passed
 * us. We clamp to the viewport so opening near the bottom/right edge
 * flips the card to stay visible.
 *
 * Keyboard:
 *   Enter  commit edits and close
 *   Esc    discard edits and close
 *   Tab    moves between fields normally
 */
export default function PropertyPopup({ comp, anchor, onClose, onCommit }) {
    const [ref, setRef] = useState(comp?.ref || '');
    const [valueText, setValueText] = useState(() => formatForEdit(comp?.value));
    const [modelRef, setModelRef] = useState(comp?.modelRef || '');

    // Source editor: the spec is a list of sub-specs (dc / pulse / sin /
    // ac / pwl) that live in parallel. We let the user pick the
    // "waveform" (time-domain spec: dc | pulse | sin), then edit its
    // fields. The AC small-signal spec is shown separately because it's
    // orthogonal — analog designers routinely stack AC on top of DC.
    const initialSpecs = normaliseSpecs(comp?.sourceSpec);
    const [waveform, setWaveform] = useState(initialSpecs.waveKind);
    const [waveFields, setWaveFields] = useState(initialSpecs.waveFields);
    // Remember per-kind field values so toggling between kinds doesn't
    // wipe out whatever the user typed into the other one.
    const waveCacheRef = useRef({ [initialSpecs.waveKind]: initialSpecs.waveFields });
    const [acMag, setAcMag] = useState(initialSpecs.acMag);
    const [acPhase, setAcPhase] = useState(initialSpecs.acPhase);
    const cardRef = useRef(null);
    const refInputRef = useRef(null);

    useEffect(() => {
        refInputRef.current?.select();
    }, []);

    // Dismiss on outside click / Esc.
    useEffect(() => {
        const onKey = (ev) => {
            if (ev.key === 'Escape') { onClose(); }
            else if (ev.key === 'Enter' && ev.target.tagName !== 'TEXTAREA') {
                ev.preventDefault();
                commit();
            }
        };
        const onDown = (ev) => {
            if (cardRef.current && !cardRef.current.contains(ev.target)) onClose();
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onDown);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const part = comp ? getPart(comp.partId) : null;
    const unit = comp?.valueUnit || inferUnit(comp?.elementType);
    const isPassive = comp && ['R', 'C', 'L', 'E', 'G'].includes(comp.elementType);
    const isSource = comp && ['V', 'I'].includes(comp.elementType);
    const isSemi = comp && ['D', 'Q', 'M'].includes(comp.elementType);

    // Clamp the popup card so it stays inside the viewport. We do the
    // clamp in a useMemo against window dims (no resize listener —
    // this card is short-lived and a tiny mis-position on resize is
    // preferable to the extra complexity).
    const placement = useMemo(() => {
        const pad = 12;
        const cardW = 300;
        // The pulse editor has 7 time-domain fields so we pre-grow the
        // card a little when the active part is a source. The clamp
        // below makes sure it still fits when opened near a screen
        // edge.
        const cardH = isSource ? 460 : 220;
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
        let left = (anchor?.clientX ?? 100) + 16;
        let top = (anchor?.clientY ?? 100) + 12;
        if (left + cardW + pad > vw) left = vw - cardW - pad;
        if (top + cardH + pad > vh) top = vh - cardH - pad;
        if (left < pad) left = pad;
        if (top < pad) top = pad;
        return { left, top };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anchor?.clientX, anchor?.clientY, isSource]);

    function commit() {
        const patch = { ref };
        if (isPassive) {
            const v = parseSiValue(valueText);
            if (Number.isFinite(v)) patch.value = v;
        } else if (isSource) {
            // Build a fresh sourceSpec: preserve any non-time-domain
            // entries (currently only `ac` is independent), replace the
            // time-domain entry with whatever the user picked.
            const specs = [];
            const wave = buildWaveSpec(waveform, waveFields);
            if (wave) specs.push(wave);
            const ac = buildAcSpec(acMag, acPhase);
            if (ac) specs.push(ac);
            // Any exotic kinds we don't expose (pwl) survive untouched.
            for (const s of (comp.sourceSpec || [])) {
                if (s.kind === 'dc' || s.kind === 'pulse' || s.kind === 'sin' || s.kind === 'ac') continue;
                specs.push(s);
            }
            patch.sourceSpec = specs;
        } else if (isSemi && modelRef) {
            patch.modelRef = modelRef;
        }
        onCommit(patch);
        onClose();
    }

    function switchWaveform(next) {
        // Snapshot current field values into the cache so flipping back
        // doesn't clobber the user's work.
        waveCacheRef.current[waveform] = waveFields;
        const cached = waveCacheRef.current[next];
        setWaveform(next);
        setWaveFields(cached || defaultWaveFields(next, comp?.elementType === 'I'));
    }

    function updateWaveField(key, value) {
        setWaveFields((prev) => ({ ...prev, [key]: value }));
    }

    if (!comp) return null;
    if (typeof document === 'undefined') return null;

    // Portal to <body> to escape the `.main-content` stacking context
    // (see ScopeModal for the same rationale).
    return createPortal(
        <div
            className="cs-prop-popup"
            ref={cardRef}
            style={{ left: placement.left, top: placement.top }}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div className="cs-prop-popup-header">
                <div className="cs-prop-popup-title">
                    {part?.name || comp.elementType}
                </div>
                <button className="cs-prop-popup-close" onClick={onClose} title="Close (Esc)">
                    <X size={14} />
                </button>
            </div>

            <label className="cs-prop-popup-field">
                <span>Reference</span>
                <input
                    ref={refInputRef}
                    type="text"
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                    spellCheck={false}
                />
            </label>

            {isPassive && (
                <label className="cs-prop-popup-field">
                    <span>Value ({unit})</span>
                    <input
                        type="text"
                        value={valueText}
                        placeholder="e.g. 4.7k"
                        onChange={(e) => setValueText(e.target.value)}
                        spellCheck={false}
                    />
                </label>
            )}

            {isSource && (
                <>
                    <label className="cs-prop-popup-field">
                        <span>Waveform</span>
                        <select
                            value={waveform}
                            onChange={(e) => switchWaveform(e.target.value)}
                        >
                            <option value="dc">DC</option>
                            <option value="pulse">Pulse</option>
                            <option value="sin">Sine</option>
                        </select>
                    </label>
                    <div className="cs-prop-popup-group">
                        {waveFieldDefs(waveform, comp.elementType).map(([key, label, hint]) => (
                            <label key={key} className="cs-prop-popup-field cs-prop-popup-field-compact">
                                <span>{label}</span>
                                <input
                                    type="text"
                                    value={waveFields[key] ?? ''}
                                    placeholder={hint}
                                    onChange={(e) => updateWaveField(key, e.target.value)}
                                    spellCheck={false}
                                />
                            </label>
                        ))}
                    </div>
                    <details className="cs-prop-popup-details">
                        <summary>AC small-signal (optional)</summary>
                        <div className="cs-prop-popup-group">
                            <label className="cs-prop-popup-field cs-prop-popup-field-compact">
                                <span>Magnitude</span>
                                <input
                                    type="text"
                                    value={acMag}
                                    placeholder="1"
                                    onChange={(e) => setAcMag(e.target.value)}
                                    spellCheck={false}
                                />
                            </label>
                            <label className="cs-prop-popup-field cs-prop-popup-field-compact">
                                <span>Phase (°)</span>
                                <input
                                    type="text"
                                    value={acPhase}
                                    placeholder="0"
                                    onChange={(e) => setAcPhase(e.target.value)}
                                    spellCheck={false}
                                />
                            </label>
                        </div>
                        <div className="cs-prop-popup-hint">
                            Only matters for .ac analysis. Leave blank to skip.
                        </div>
                    </details>
                </>
            )}

            {isSemi && (
                <label className="cs-prop-popup-field">
                    <span>Model</span>
                    <select value={modelRef} onChange={(e) => setModelRef(e.target.value)}>
                        {modelChoicesFor(comp.elementType).map((m) => (
                            <option key={m} value={m}>{m}</option>
                        ))}
                    </select>
                </label>
            )}

            {!isPassive && !isSource && !isSemi && (
                <div className="cs-prop-popup-hint">
                    Use the side inspector for full editing of this part.
                </div>
            )}

            <div className="cs-prop-popup-actions">
                <button className="cs-prop-popup-btn cs-prop-popup-cancel" onClick={onClose}>
                    Cancel
                </button>
                <button className="cs-prop-popup-btn cs-prop-popup-ok" onClick={commit}>
                    <Check size={14} /> Apply
                </button>
            </div>
        </div>,
        document.body,
    );
}

/* ---------------- helpers ---------------- */

function inferUnit(type) {
    return { R: 'Ω', C: 'F', L: 'H', E: 'V/V', G: 'A/V' }[type] || '';
}

function formatForEdit(v) {
    if (v == null || !Number.isFinite(+v)) return '';
    const n = +v;
    const abs = Math.abs(n);
    if (abs === 0) return '0';
    // Trim float-precision noise (e.g. 500.00000000000006 → "500")
    // before attaching the SI suffix. 12 significant digits is enough
    // for anything a schematic author types by hand.
    const fmt = (x) => {
        const s = Number(x.toPrecision(12)).toString();
        return s;
    };
    if (abs >= 1e9)   return `${fmt(n / 1e9)}G`;
    if (abs >= 1e6)   return `${fmt(n / 1e6)}Meg`;
    if (abs >= 1e3)   return `${fmt(n / 1e3)}k`;
    if (abs >= 1)     return fmt(n);
    if (abs >= 1e-3)  return `${fmt(n / 1e-3)}m`;
    if (abs >= 1e-6)  return `${fmt(n / 1e-6)}u`;
    if (abs >= 1e-9)  return `${fmt(n / 1e-9)}n`;
    if (abs >= 1e-12) return `${fmt(n / 1e-12)}p`;
    return fmt(n);
}

/* ---------------- source-spec helpers ---------------- */

/**
 * Turn an existing sourceSpec array into the primitive state the popup
 * needs: which time-domain waveform is active, its field values (as
 * SI-friendly strings), and the AC small-signal pair.
 */
function normaliseSpecs(list) {
    const arr = Array.isArray(list) ? list : [];
    const pulse = arr.find((s) => s.kind === 'pulse');
    const sin   = arr.find((s) => s.kind === 'sin');
    const dc    = arr.find((s) => s.kind === 'dc');
    const ac    = arr.find((s) => s.kind === 'ac');
    let waveKind = 'dc';
    let waveFields = { v: dc ? formatForEdit(dc.v) : '' };
    if (pulse) {
        waveKind = 'pulse';
        waveFields = {
            v1: formatForEdit(pulse.v1),
            v2: formatForEdit(pulse.v2),
            td: formatForEdit(pulse.td ?? 0),
            tr: formatForEdit(pulse.tr ?? 1e-9),
            tf: formatForEdit(pulse.tf ?? 1e-9),
            pw: formatForEdit(pulse.pw),
            per: formatForEdit(pulse.per),
        };
    } else if (sin) {
        waveKind = 'sin';
        waveFields = {
            vo: formatForEdit(sin.vo ?? 0),
            va: formatForEdit(sin.va ?? 1),
            f:  formatForEdit(sin.f  ?? 1e3),
            td: formatForEdit(sin.td ?? 0),
            theta: formatForEdit(sin.theta ?? 0),
        };
    } else if (dc) {
        waveKind = 'dc';
        waveFields = { v: formatForEdit(dc.v) };
    }
    return {
        waveKind,
        waveFields,
        acMag:   ac ? formatForEdit(ac.mag ?? 1) : '',
        acPhase: ac ? formatForEdit(ac.phase ?? 0) : '',
    };
}

function defaultWaveFields(kind, isI) {
    if (kind === 'pulse') {
        return {
            v1: '0',
            v2: isI ? '1m' : '5',
            td: '0',
            tr: '1u',
            tf: '1u',
            pw: '1m',
            per: '2m',
        };
    }
    if (kind === 'sin') {
        return {
            vo: '0',
            va: isI ? '1m' : '1',
            f:  '1k',
            td: '0',
            theta: '0',
        };
    }
    return { v: isI ? '1m' : '5' };
}

/**
 * Field definitions per waveform, shaped [[key, label, placeholder]...].
 * Labels include units and are sized to fit two-column layout in the
 * popup.
 */
function waveFieldDefs(kind, elementType) {
    const U = elementType === 'I' ? 'A' : 'V';
    if (kind === 'pulse') {
        return [
            ['v1',  `Low (${U})`,   'e.g. 0'],
            ['v2',  `High (${U})`,  'e.g. 5 (use −5 to invert)'],
            ['td',  'Delay (s)',    'e.g. 100u'],
            ['tr',  'Rise (s)',     'e.g. 1u'],
            ['tf',  'Fall (s)',     'e.g. 1u'],
            ['pw',  'Width (s)',    'e.g. 500u'],
            ['per', 'Period (s)',   'e.g. 2m'],
        ];
    }
    if (kind === 'sin') {
        return [
            ['vo',    `Offset (${U})`,    'e.g. 0'],
            ['va',    `Amplitude (${U})`, 'e.g. 1'],
            ['f',     'Frequency (Hz)',   'e.g. 1k'],
            ['td',    'Delay (s)',        'e.g. 0'],
            ['theta', 'Damping (1/s)',    'e.g. 0'],
        ];
    }
    return [
        ['v', `Level (${U})`, 'e.g. 5 or −3.3'],
    ];
}

function buildWaveSpec(kind, fields) {
    if (kind === 'pulse') {
        const v1  = parseSiValue(fields.v1);
        const v2  = parseSiValue(fields.v2);
        const td  = parseSiValue(fields.td);
        const tr  = parseSiValue(fields.tr);
        const tf  = parseSiValue(fields.tf);
        const pw  = parseSiValue(fields.pw);
        const per = parseSiValue(fields.per);
        if (![v1, v2, pw, per].every(Number.isFinite)) return null;
        return {
            kind: 'pulse',
            v1, v2,
            td:  Number.isFinite(td)  ? td  : 0,
            tr:  Number.isFinite(tr)  ? tr  : 1e-9,
            tf:  Number.isFinite(tf)  ? tf  : 1e-9,
            pw,
            per,
        };
    }
    if (kind === 'sin') {
        const vo    = parseSiValue(fields.vo);
        const va    = parseSiValue(fields.va);
        const f     = parseSiValue(fields.f);
        const td    = parseSiValue(fields.td);
        const theta = parseSiValue(fields.theta);
        if (![va, f].every(Number.isFinite)) return null;
        return {
            kind: 'sin',
            vo: Number.isFinite(vo) ? vo : 0,
            va,
            f,
            td: Number.isFinite(td) ? td : 0,
            theta: Number.isFinite(theta) ? theta : 0,
        };
    }
    const v = parseSiValue(fields.v);
    if (!Number.isFinite(v)) return null;
    return { kind: 'dc', v };
}

function buildAcSpec(magText, phaseText) {
    const mag = parseSiValue(magText);
    if (!Number.isFinite(mag)) return null;
    const phase = parseSiValue(phaseText);
    return { kind: 'ac', mag, phase: Number.isFinite(phase) ? phase : 0 };
}

function modelChoicesFor(elementType) {
    const all = Object.keys(BUILTIN_MODELS);
    switch (elementType) {
        case 'D': return all.filter((k) => /^D/i.test(k) && !/^Q/.test(k));
        case 'Q': return all.filter((k) => /^Q/i.test(k));
        case 'M': return all.filter((k) => /^M/i.test(k));
        default:  return all;
    }
}
