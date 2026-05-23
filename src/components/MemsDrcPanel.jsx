import React, { useCallback, useRef } from 'react';
import { ShieldAlert, Play, Radio, Download, Upload } from 'lucide-react';

/**
 * @param {object} props
 * @param {import('../mems/memsDrcEngine.js').DrcViolation[]} props.violations
 * @param {{ checksRun?: number, durationMs?: number }} props.stats
 * @param {boolean} props.realtime
 * @param {(v: boolean) => void} props.onRealtimeChange
 * @param {() => void} props.onRun
 * @param {boolean} props.running
 * @param {(id: string | null) => void} props.onPickViolation
 * @param {string | null} props.highlightId
 * @param {() => void} props.onExportRules
 * @param {(file: File) => void} props.onImportRules
 */
export default function MemsDrcPanel({
    violations,
    stats,
    realtime,
    onRealtimeChange,
    onRun,
    running,
    onPickViolation,
    highlightId,
    onExportRules,
    onImportRules,
}) {
    const importRef = useRef(null);
    const errCount = violations.filter((v) => v.severity === 'error').length;
    const warnCount = violations.filter((v) => v.severity === 'warning').length;

    const onImportClick = useCallback(() => importRef.current?.click(), []);

    return (
        <div className="mems-drc-panel">
            <div className="mems-drc-panel__head">
                <ShieldAlert size={14} aria-hidden />
                <span>Design rule check</span>
            </div>
            <div className="mems-drc-panel__actions">
                <button type="button" className="mems-mini-btn mems-mini-btn--wide" disabled={running} onClick={onRun}>
                    <Play size={13} /> Run DRC
                </button>
                <label className="mems-drc-realtime">
                    <input type="checkbox" checked={realtime} onChange={(e) => onRealtimeChange(e.target.checked)} />{' '}
                    <Radio size={12} aria-hidden /> Live
                </label>
            </div>
            <div className="mems-drc-panel__io">
                <button type="button" className="mems-mini-btn" onClick={onExportRules}>
                    <Download size={12} /> Export rules
                </button>
                <button type="button" className="mems-mini-btn" onClick={onImportClick}>
                    <Upload size={12} /> Import rules
                </button>
                <input
                    ref={importRef}
                    type="file"
                    accept=".json,application/json"
                    className="mems-file-input-hidden"
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) onImportRules(f);
                    }}
                />
            </div>
            {stats && (
                <p className="mems-drc-stats">
                    Last run: {stats.durationMs != null ? `${stats.durationMs.toFixed(0)} ms` : '—'} · checks{' '}
                    {stats.checksRun ?? '—'}
                </p>
            )}
            <p className="mems-drc-summary">
                <strong>{errCount}</strong> error(s) · <strong>{warnCount}</strong> warning(s)
            </p>
            <ul className="mems-drc-list">
                {violations.length === 0 ? (
                    <li className="mems-drc-list__empty">No violations (or DRC not run yet).</li>
                ) : (
                    violations.map((v) => (
                        <li key={v.id}>
                            <button
                                type="button"
                                className={`mems-drc-item${highlightId === v.id ? ' is-active' : ''}${
                                    v.severity === 'error' ? ' mems-drc-item--err' : ' mems-drc-item--warn'
                                }`}
                                onClick={() => onPickViolation(v.id)}
                            >
                                <span className="mems-drc-item__rule">{v.rule}</span>
                                <span className="mems-drc-item__msg">{v.message}</span>
                                <span className="mems-drc-item__loc">
                                    {(v.xUm || v.yUm) && (
                                        <>
                                            {v.xUm.toFixed(2)}, {v.yUm.toFixed(2)} µm
                                        </>
                                    )}
                                </span>
                            </button>
                        </li>
                    ))
                )}
            </ul>
            <p className="mems-drc-foot">
                Rule files are JSON: <code>minWidth</code>, <code>minSpacing</code>, <code>clearance</code>,{' '}
                <code>viaTsv</code>, …
            </p>
        </div>
    );
}
