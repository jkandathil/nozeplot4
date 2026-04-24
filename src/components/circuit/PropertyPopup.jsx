import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Check } from 'lucide-react';
import { BUILTIN_MODELS, getPart } from '../../circuit/library.js';

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
    const [dcLevel, setDcLevel] = useState(() => {
        const dc = (comp?.sourceSpec || []).find((s) => s.kind === 'dc');
        return dc ? String(dc.v) : '';
    });
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
        const cardW = 280;
        const cardH = 220;
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
        let left = (anchor?.clientX ?? 100) + 16;
        let top = (anchor?.clientY ?? 100) + 12;
        if (left + cardW + pad > vw) left = vw - cardW - pad;
        if (top + cardH + pad > vh) top = vh - cardH - pad;
        if (left < pad) left = pad;
        if (top < pad) top = pad;
        return { left, top };
    }, [anchor?.clientX, anchor?.clientY]);

    function commit() {
        const patch = { ref };
        if (isPassive) {
            const v = parseSiValue(valueText);
            if (Number.isFinite(v)) patch.value = v;
        } else if (isSource) {
            const v = parseSiValue(dcLevel);
            if (Number.isFinite(v)) {
                const rest = (comp.sourceSpec || []).filter((s) => s.kind !== 'dc');
                patch.sourceSpec = [...rest, { kind: 'dc', v }];
            }
        } else if (isSemi && modelRef) {
            patch.modelRef = modelRef;
        }
        onCommit(patch);
        onClose();
    }

    if (!comp) return null;

    return (
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
                <label className="cs-prop-popup-field">
                    <span>DC level ({comp.elementType === 'I' ? 'A' : 'V'})</span>
                    <input
                        type="text"
                        value={dcLevel}
                        placeholder="e.g. 5 or 3.3"
                        onChange={(e) => setDcLevel(e.target.value)}
                        spellCheck={false}
                    />
                </label>
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
        </div>
    );
}

/* ---------------- helpers ---------------- */

function inferUnit(type) {
    return { R: 'Ω', C: 'F', L: 'H', E: 'V/V', G: 'A/V' }[type] || '';
}

const SI_MAP = {
    f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6,
    m: 1e-3, k: 1e3, K: 1e3,
    meg: 1e6, Meg: 1e6, MEG: 1e6,
    g: 1e9, G: 1e9,
};

function parseSiValue(txt) {
    if (txt == null) return NaN;
    const s = String(txt).trim();
    if (!s) return NaN;
    // Match "4.7k", "1meg", "220u", "10", etc.
    const m = s.match(/^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*([a-zA-Zµ]*)\s*[a-zA-ZΩ/]*$/);
    if (!m) return Number(s);
    const num = parseFloat(m[1]);
    const suffix = m[2] || '';
    if (!suffix) return num;
    if (SI_MAP[suffix] != null) return num * SI_MAP[suffix];
    // Case-insensitive fallback for "meg"/"Meg"/"MEG".
    const lower = suffix.toLowerCase();
    if (SI_MAP[lower] != null) return num * SI_MAP[lower];
    return num;
}

function formatForEdit(v) {
    if (v == null || !Number.isFinite(+v)) return '';
    const n = +v;
    const abs = Math.abs(n);
    if (abs === 0) return '0';
    if (abs >= 1e9)  return `${n / 1e9}G`;
    if (abs >= 1e6)  return `${n / 1e6}Meg`;
    if (abs >= 1e3)  return `${n / 1e3}k`;
    if (abs >= 1)    return `${n}`;
    if (abs >= 1e-3) return `${n / 1e-3}m`;
    if (abs >= 1e-6) return `${n / 1e-6}u`;
    if (abs >= 1e-9) return `${n / 1e-9}n`;
    if (abs >= 1e-12) return `${n / 1e-12}p`;
    return String(n);
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
