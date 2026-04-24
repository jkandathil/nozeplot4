import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Activity, Maximize2, Minimize2 } from 'lucide-react';

/**
 * Oscilloscope modal — double-clicking a SCOPE component on the canvas
 * opens this overlay, which shows the waveform at the scope's attached
 * node. When the simulation is running live, it ticks in real time.
 *
 * Inputs:
 *   comp          — the SCOPE component (so we can read its ref)
 *   signalName    — 'V(<node>)' that the scope is probing
 *   result        — the current run result (transient/ac/dc); we grab
 *                   the named series out of `result.signals`
 *   livePartial   — optional { t: [], v: [] } preview while a live run
 *                   is still producing samples (see handleRunLive)
 *   onClose       — dismiss the modal
 *
 * Rendering is a plain <canvas>; no external deps. For a real-ish CRT
 * feel we draw on a dark grid with a bright trace.
 */
export default function ScopeModal({ comp, signalName, nodeLabel, result, livePartial, onClose }) {
    const [fullscreen, setFullscreen] = useState(false);
    const canvasRef = useRef(null);

    // ESC closes; F toggles fullscreen.
    useEffect(() => {
        const onKey = (ev) => {
            if (ev.key === 'Escape') onClose?.();
            if (ev.key === 'f' || ev.key === 'F') setFullscreen((v) => !v);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    // Pick the series out of the result. For transient runs, the x
    // axis is time; for AC, frequency; for DC sweeps, the swept
    // source. We render whatever we're given.
    const series = useMemo(() => {
        if (livePartial && livePartial.t?.length) {
            return {
                xs: livePartial.t,
                ys: livePartial.y,
                xUnit: 's', yUnit: 'V',
                kind: 'tran', live: true,
                xLabel: 'Time', yLabel: signalName || 'Signal',
            };
        }
        if (!result || !signalName) return null;
        const sig = (result.signals || []).find((s) => s.name === signalName
            || s.name?.startsWith(`${signalName} @`));
        if (!sig) return null;
        if (result.kind === 'tran') {
            return {
                xs: sig.t || result.t, ys: sig.y,
                xUnit: 's', yUnit: 'V',
                kind: 'tran', live: false,
                xLabel: 'Time', yLabel: signalName,
            };
        }
        if (result.kind === 'ac') {
            return {
                xs: sig.f || result.f, ys: sig.mag,
                xUnit: 'Hz', yUnit: '',
                kind: 'ac', live: false, logX: true,
                xLabel: 'Frequency', yLabel: `|${signalName}|`,
            };
        }
        if (result.kind === 'dc') {
            return {
                xs: sig.x || result.x, ys: sig.y,
                xUnit: '', yUnit: 'V',
                kind: 'dc', live: false,
                xLabel: result.xSource ? `Sweep ${result.xSource}` : 'Sweep', yLabel: signalName,
            };
        }
        return null;
    }, [result, signalName, livePartial]);

    // Draw on the canvas. Imperative because re-computing thousands of
    // SVG path ops for 10k-sample traces at 60 fps is a non-starter.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const W = rect.width, H = rect.height;
        ctx.clearRect(0, 0, W, H);
        // CRT backdrop
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#061018');
        bg.addColorStop(1, '#0b1a24');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        const pad = { l: 56, r: 16, t: 18, b: 30 };
        const plotW = Math.max(10, W - pad.l - pad.r);
        const plotH = Math.max(10, H - pad.t - pad.b);

        // Grid
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.18)';
        ctx.lineWidth = 1;
        const divX = 10, divY = 8;
        ctx.beginPath();
        for (let i = 0; i <= divX; i++) {
            const x = pad.l + (plotW * i) / divX;
            ctx.moveTo(x, pad.t);
            ctx.lineTo(x, pad.t + plotH);
        }
        for (let i = 0; i <= divY; i++) {
            const y = pad.t + (plotH * i) / divY;
            ctx.moveTo(pad.l, y);
            ctx.lineTo(pad.l + plotW, y);
        }
        ctx.stroke();

        // Border
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(pad.l, pad.t, plotW, plotH);

        if (!series || !series.xs || series.xs.length === 0) {
            ctx.fillStyle = '#94a3b8';
            ctx.font = '13px ui-monospace, Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const cx = pad.l + plotW / 2;
            const cy = pad.t + plotH / 2;
            if (!signalName) {
                ctx.fillStyle = '#fbbf24';
                ctx.fillText('Scope tip is not on a node.', cx, cy - 10);
                ctx.fillStyle = '#94a3b8';
                ctx.font = '11px ui-monospace, Menlo, monospace';
                ctx.fillText('Drag the scope so its tip lands on a wire or pin.', cx, cy + 10);
            } else if (!result) {
                ctx.fillText('No waveform yet — hit Run.', cx, cy - 8);
                ctx.font = '11px ui-monospace, Menlo, monospace';
                ctx.fillStyle = '#64748b';
                ctx.fillText(`Probe: ${signalName}`, cx, cy + 12);
            } else {
                ctx.fillStyle = '#f87171';
                ctx.fillText(`Signal "${signalName}" not found in results.`, cx, cy - 8);
                ctx.font = '11px ui-monospace, Menlo, monospace';
                ctx.fillStyle = '#94a3b8';
                ctx.fillText('Re-run after connecting the scope to a different node.', cx, cy + 12);
            }
            return;
        }

        // Data ranges
        const xs = series.xs, ys = series.ys;
        let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
        for (let i = 0; i < xs.length; i++) {
            const x = xs[i]; if (x < xmin) xmin = x; if (x > xmax) xmax = x;
            const y = ys[i]; if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        }
        if (!isFinite(xmin) || xmin === xmax) { xmin = 0; xmax = 1; }
        if (!isFinite(ymin) || ymin === ymax) { ymin -= 0.5; ymax += 0.5; }
        // Pad y a little so the trace doesn't kiss the box.
        const yPad = (ymax - ymin) * 0.08;
        ymin -= yPad; ymax += yPad;

        const xToPx = (x) => {
            if (series.logX) {
                const lx = Math.log10(Math.max(x, 1e-30));
                const lmin = Math.log10(Math.max(xmin, 1e-30));
                const lmax = Math.log10(Math.max(xmax, 1e-30));
                return pad.l + ((lx - lmin) / (lmax - lmin)) * plotW;
            }
            return pad.l + ((x - xmin) / (xmax - xmin)) * plotW;
        };
        const yToPx = (y) => pad.t + plotH - ((y - ymin) / (ymax - ymin)) * plotH;

        // Trace (bright cyan-green, like a phosphor CRT)
        ctx.strokeStyle = '#34d399';
        ctx.lineWidth = 1.6;
        ctx.shadowColor = 'rgba(52, 211, 153, 0.55)';
        ctx.shadowBlur = 3;
        ctx.beginPath();
        for (let i = 0; i < xs.length; i++) {
            const px = xToPx(xs[i]);
            const py = yToPx(ys[i]);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Axis labels
        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let i = 0; i <= divY; i++) {
            const y = pad.t + (plotH * i) / divY;
            const val = ymax - ((ymax - ymin) * i) / divY;
            ctx.fillText(fmtEng(val) + series.yUnit, pad.l - 6, y);
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i <= divX; i++) {
            const x = pad.l + (plotW * i) / divX;
            let v;
            if (series.logX) {
                const lmin = Math.log10(Math.max(xmin, 1e-30));
                const lmax = Math.log10(Math.max(xmax, 1e-30));
                v = Math.pow(10, lmin + ((lmax - lmin) * i) / divX);
            } else {
                v = xmin + ((xmax - xmin) * i) / divX;
            }
            ctx.fillText(fmtEng(v) + series.xUnit, x, pad.t + plotH + 6);
        }

        // Axis titles
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(series.yLabel, pad.l + 4, pad.t + 4);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(series.xLabel, pad.l + plotW - 4, pad.t + plotH - 4);

        // LIVE badge
        if (series.live) {
            ctx.fillStyle = '#ef4444';
            ctx.beginPath();
            ctx.arc(pad.l + plotW - 10, pad.t + 12, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fca5a5';
            ctx.font = 'bold 10px ui-sans-serif, system-ui';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText('LIVE', pad.l + plotW - 20, pad.t + 12);
        }
    }, [series, fullscreen, signalName, result]);

    // Re-draw on resize
    useEffect(() => {
        const onResize = () => {
            // Nudge the canvas to re-run the draw effect.
            if (canvasRef.current) {
                canvasRef.current.dispatchEvent(new Event('resize'));
            }
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // Portal the modal straight into <body> so it escapes the
    // CircuitStudio's stacking context. `.main-content` uses
    // `position: relative; z-index: 1`, which creates a new stacking
    // context — without a portal the modal's z-index:1200 is trapped
    // inside that context and the app sidebar (z-index:50 in the
    // parent context) paints on top.
    if (typeof document === 'undefined') return null;
    return createPortal(
        <div className={`cs-scope-modal${fullscreen ? ' is-fullscreen' : ''}`} role="dialog" aria-modal="true">
            <div
                className="cs-scope-backdrop"
                onClick={onClose}
                aria-hidden="true"
            />
            <div className="cs-scope-card">
                <div className="cs-scope-head">
                    <Activity size={14} />
                    <div className="cs-scope-title">
                        {comp?.ref || 'Scope'}
                        <span className="cs-scope-sub">
                            {nodeLabel ? `probing ${nodeLabel}` : (signalName || 'no connection')}
                        </span>
                    </div>
                    <button
                        type="button"
                        className="cs-scope-iconbtn"
                        onClick={() => setFullscreen((v) => !v)}
                        title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
                    >
                        {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    </button>
                    <button
                        type="button"
                        className="cs-scope-iconbtn"
                        onClick={onClose}
                        title="Close (Esc)"
                    >
                        <X size={14} />
                    </button>
                </div>
                <div className="cs-scope-body">
                    <canvas ref={canvasRef} className="cs-scope-canvas" />
                </div>
                <div className="cs-scope-foot">
                    {series ? (
                        <>
                            <span>{series.kind.toUpperCase()}</span>
                            <span>·</span>
                            <span>{series.xs?.length ?? 0} samples</span>
                            {series.live && <><span>·</span><span className="cs-scope-live">LIVE</span></>}
                        </>
                    ) : (
                        <span>Hit <b>Run</b> to capture a waveform, or enable Live to stream.</span>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}

function fmtEng(v) {
    if (!isFinite(v)) return 'NaN';
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e9)  return (v / 1e9 ).toPrecision(3) + 'G';
    if (a >= 1e6)  return (v / 1e6 ).toPrecision(3) + 'M';
    if (a >= 1e3)  return (v / 1e3 ).toPrecision(3) + 'k';
    if (a >= 1)    return  v.toPrecision(3);
    if (a >= 1e-3) return (v / 1e-3).toPrecision(3) + 'm';
    if (a >= 1e-6) return (v / 1e-6).toPrecision(3) + 'u';
    if (a >= 1e-9) return (v / 1e-9).toPrecision(3) + 'n';
    if (a >= 1e-12)return (v / 1e-12).toPrecision(3) + 'p';
    return v.toExponential(2);
}
