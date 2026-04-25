import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Activity, Maximize2, Minimize2 } from 'lucide-react';

const CH_COLORS = ['#34d399', '#fbbf24'];

/**
 * Oscilloscope modal — double-clicking a SCOPE component opens this
 * overlay. Dual-channel: each entry in `channels` is one trace (CH1 /
 * CH2 tips). Transient, AC, and DC results are supported; live replay
 * streams the same `yBySignal` shape the parent builds from
 * `liveStream.ySignals`.
 *
 * When `embedded` is true, renders inline (no portal/backdrop) for the
 * bottom drawer "Scope" tab; Escape does not close the parent page.
 */
export default function ScopeModal({
    comp, channels = [], result, livePartial, onClose,
    embedded = false,
}) {
    const [fullscreen, setFullscreen] = useState(false);
    const canvasRef = useRef(null);
    const embedWrapRef = useRef(null);

    useEffect(() => {
        const onKey = (ev) => {
            if (!embedded && ev.key === 'Escape') onClose?.();
            if (!embedded && (ev.key === 'f' || ev.key === 'F')) setFullscreen((v) => !v);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, embedded]);

    useEffect(() => {
        if (!embedded || typeof ResizeObserver === 'undefined') return undefined;
        const el = embedWrapRef.current;
        if (!el) return undefined;
        const ro = new ResizeObserver(() => {
            canvasRef.current?.dispatchEvent(new Event('resize'));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [embedded]);

    const plotModel = useMemo(() => {
        const chList = channels;
        const findSig = (name) => {
            if (!name || !result?.signals) return null;
            return result.signals.find((s) => s.name === name
                || s.name?.startsWith(`${name} @`)) || null;
        };

        if (livePartial?.t?.length && livePartial.yBySignal && chList.length) {
            const traces = [];
            for (let i = 0; i < chList.length; i++) {
                const ch = chList[i];
                if (!ch.signalName) continue;
                const ys = livePartial.yBySignal[ch.signalName];
                if (!ys?.length) continue;
                traces.push({
                    xs: livePartial.t,
                    ys,
                    color: CH_COLORS[i % CH_COLORS.length],
                    legend: `${ch.label}: ${ch.signalName}`,
                    yLabel: ch.signalName,
                });
            }
            if (traces.length === 0) return null;
            return {
                kind: 'tran',
                xUnit: 's',
                yUnit: 'V',
                xLabel: 'Time',
                traces,
                live: true,
                logX: false,
            };
        }

        if (!result || !chList.length) return null;

        const traces = [];
        for (let i = 0; i < chList.length; i++) {
            const ch = chList[i];
            if (!ch.signalName) continue;
            const sig = findSig(ch.signalName);
            if (!sig) continue;
            const color = CH_COLORS[i % CH_COLORS.length];
            if (result.kind === 'tran') {
                traces.push({
                    xs: sig.t || result.t,
                    ys: sig.y,
                    color,
                    legend: `${ch.label}: ${ch.signalName}`,
                    yLabel: ch.signalName,
                });
            } else if (result.kind === 'ac') {
                traces.push({
                    xs: sig.f || result.f,
                    ys: sig.mag,
                    color,
                    legend: `${ch.label}: |${ch.signalName}|`,
                    yLabel: `|${ch.signalName}|`,
                    logX: true,
                });
            } else if (result.kind === 'dc') {
                traces.push({
                    xs: sig.x || result.x,
                    ys: sig.y,
                    color,
                    legend: `${ch.label}: ${ch.signalName}`,
                    yLabel: ch.signalName,
                });
            }
        }
        if (traces.length === 0) return null;

        if (result.kind === 'tran') {
            return {
                kind: 'tran',
                xUnit: 's',
                yUnit: 'V',
                xLabel: 'Time',
                traces,
                live: false,
                logX: false,
            };
        }
        if (result.kind === 'ac') {
            return {
                kind: 'ac',
                xUnit: 'Hz',
                yUnit: '',
                xLabel: 'Frequency',
                traces,
                live: false,
                logX: true,
            };
        }
        if (result.kind === 'dc') {
            return {
                kind: 'dc',
                xUnit: '',
                yUnit: 'V',
                xLabel: result.xSource ? `Sweep ${result.xSource}` : 'Sweep',
                traces,
                live: false,
                logX: false,
            };
        }
        return null;
    }, [result, channels, livePartial]);

    const subtitle = useMemo(() => {
        if (!channels.length) return 'no probes';
        return channels
            .map((c) => (c.nodeLabel ? `${c.label} ${c.nodeLabel}` : `${c.label} —`))
            .join(' · ');
    }, [channels]);

    const anySignalName = channels.some((c) => c.signalName);
    const firstMissing = useMemo(() => {
        if (!result?.signals || !channels.length) return null;
        for (const ch of channels) {
            if (!ch.signalName) continue;
            const hit = (result.signals || []).some((s) => s.name === ch.signalName
                || s.name?.startsWith(`${ch.signalName} @`));
            if (!hit) return ch.signalName;
        }
        return null;
    }, [result, channels]);

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
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#061018');
        bg.addColorStop(1, '#0b1a24');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        const pad = { l: 56, r: 16, t: 18, b: 30 };
        const plotW = Math.max(10, W - pad.l - pad.r);
        const plotH = Math.max(10, H - pad.t - pad.b);

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

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(pad.l, pad.t, plotW, plotH);

        if (!plotModel || !plotModel.traces?.length) {
            ctx.fillStyle = '#94a3b8';
            ctx.font = '13px ui-monospace, Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const cx = pad.l + plotW / 2;
            const cy = pad.t + plotH / 2;
            if (!anySignalName) {
                ctx.fillStyle = '#fbbf24';
                ctx.fillText('Clip CH1 (left tip) and/or CH2 (right tip) onto a net.', cx, cy - 14);
                ctx.fillStyle = '#94a3b8';
                ctx.font = '11px ui-monospace, Menlo, monospace';
                ctx.fillText('Ground or floating tips are ignored. Then hit Run.', cx, cy + 10);
            } else if (!result) {
                ctx.fillText('No waveform yet — hit Run.', cx, cy - 8);
                ctx.font = '11px ui-monospace, Menlo, monospace';
                ctx.fillStyle = '#64748b';
                ctx.fillText('Dual trace when both tips are on nodes.', cx, cy + 12);
            } else {
                ctx.fillStyle = '#f87171';
                ctx.fillText(`Signal "${firstMissing || '?'}" not found in results.`, cx, cy - 8);
                ctx.font = '11px ui-monospace, Menlo, monospace';
                ctx.fillStyle = '#94a3b8';
                ctx.fillText('Re-run after wiring both scope tips.', cx, cy + 12);
            }
            return;
        }

        const logX = !!plotModel.logX;
        let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
        for (const tr of plotModel.traces) {
            const xs = tr.xs, ys = tr.ys;
            for (let i = 0; i < xs.length; i++) {
                const x = xs[i]; if (x < xmin) xmin = x; if (x > xmax) xmax = x;
                const y = ys[i]; if (y < ymin) ymin = y; if (y > ymax) ymax = y;
            }
        }
        if (!isFinite(xmin) || xmin === xmax) { xmin = 0; xmax = 1; }
        if (!isFinite(ymin) || ymin === ymax) { ymin -= 0.5; ymax += 0.5; }
        const yPad = (ymax - ymin) * 0.08;
        ymin -= yPad; ymax += yPad;

        const xToPx = (x) => {
            if (logX) {
                const lx = Math.log10(Math.max(x, 1e-30));
                const lmin = Math.log10(Math.max(xmin, 1e-30));
                const lmax = Math.log10(Math.max(xmax, 1e-30));
                return pad.l + ((lx - lmin) / (lmax - lmin)) * plotW;
            }
            return pad.l + ((x - xmin) / (xmax - xmin)) * plotW;
        };
        const yToPx = (y) => pad.t + plotH - ((y - ymin) / (ymax - ymin)) * plotH;

        for (const tr of plotModel.traces) {
            const xs = tr.xs, ys = tr.ys;
            ctx.strokeStyle = tr.color;
            ctx.lineWidth = 1.6;
            ctx.shadowColor = `${tr.color}88`;
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
        }

        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let i = 0; i <= divY; i++) {
            const y = pad.t + (plotH * i) / divY;
            const val = ymax - ((ymax - ymin) * i) / divY;
            ctx.fillText(fmtEng(val) + plotModel.yUnit, pad.l - 6, y);
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i <= divX; i++) {
            const x = pad.l + (plotW * i) / divX;
            let v;
            if (logX) {
                const lmin = Math.log10(Math.max(xmin, 1e-30));
                const lmax = Math.log10(Math.max(xmax, 1e-30));
                v = Math.pow(10, lmin + ((lmax - lmin) * i) / divX);
            } else {
                v = xmin + ((xmax - xmin) * i) / divX;
            }
            ctx.fillText(fmtEng(v) + plotModel.xUnit, x, pad.t + plotH + 6);
        }

        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.font = '10px ui-monospace, Menlo, monospace';
        let ly = pad.t + 4;
        for (const tr of plotModel.traces) {
            ctx.fillStyle = tr.color;
            ctx.fillText(tr.legend, pad.l + 4, ly);
            ly += 12;
        }
        ctx.fillStyle = '#94a3b8';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(plotModel.xLabel, pad.l + plotW - 4, pad.t + plotH - 4);

        if (plotModel.live) {
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
    }, [plotModel, fullscreen, anySignalName, result, firstMissing]);

    useEffect(() => {
        const onResize = () => {
            if (canvasRef.current) {
                canvasRef.current.dispatchEvent(new Event('resize'));
            }
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const card = (
        <div className={`cs-scope-card${embedded ? ' is-embedded' : ''}`}>
            <div className="cs-scope-head">
                <Activity size={14} />
                <div className="cs-scope-title">
                    {comp?.ref || 'Scope'}
                    <span className="cs-scope-sub">{subtitle}</span>
                </div>
                {!embedded && (
                    <>
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
                    </>
                )}
            </div>
            <div className="cs-scope-body">
                <canvas ref={canvasRef} className="cs-scope-canvas" />
            </div>
            <div className="cs-scope-foot">
                {plotModel ? (
                    <>
                        <span>{plotModel.kind.toUpperCase()}</span>
                        <span>·</span>
                        <span>{plotModel.traces[0]?.xs?.length ?? 0} samples</span>
                        {plotModel.live && <><span>·</span><span className="cs-scope-live">LIVE</span></>}
                    </>
                ) : (
                    <span>Hit <b>Run</b> to capture waveforms, or enable Live to stream.</span>
                )}
            </div>
        </div>
    );

    if (embedded) {
        return (
            <div className="cs-scope-embed-wrap" ref={embedWrapRef}>
                {card}
            </div>
        );
    }

    if (typeof document === 'undefined') return null;
    return createPortal(
        <div className={`cs-scope-modal${fullscreen ? ' is-fullscreen' : ''}`} role="dialog" aria-modal="true">
            <div
                className="cs-scope-backdrop"
                onClick={onClose}
                aria-hidden="true"
            />
            {card}
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
