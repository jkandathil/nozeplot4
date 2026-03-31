import React, { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
    ResponsiveContainer,
    ComposedChart,
    Bar,
    Cell,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    Label,
} from 'recharts';
import { X, BarChart3 } from 'lucide-react';
import './DashboardBaselineBarModal.css';

/** Mean resistance ≥ this (Ω) → red bars and summary. */
export const BASELINE_BAR_OHMS_OUT_OF_RANGE_ABOVE = 2_000_000;
/** Mean resistance &gt; this (Ω) and &lt; 2 MΩ → yellow bars and summary. */
export const BASELINE_BAR_OHMS_YELLOW_ABOVE = 1_000_000;

const BAR_FILL_DEFAULT = '#38bdf8';
const BAR_FILL_RED = '#ef4444';
const BAR_FILL_YELLOW = '#eab308';
const TEXT_RED = '#f87171';
const TEXT_YELLOW = '#fbbf24';

function barFillForMean(mean) {
    if (typeof mean !== 'number' || Number.isNaN(mean)) return BAR_FILL_DEFAULT;
    if (mean >= BASELINE_BAR_OHMS_OUT_OF_RANGE_ABOVE) return BAR_FILL_RED;
    if (mean > BASELINE_BAR_OHMS_YELLOW_ABOVE) return BAR_FILL_YELLOW;
    return BAR_FILL_DEFAULT;
}

/** Compare bar slot when that file has no value for a channel */
function barFillForCompareMean(meanCompare) {
    if (meanCompare == null || typeof meanCompare !== 'number' || Number.isNaN(meanCompare)) {
        return 'rgba(15, 23, 42, 0)';
    }
    return barFillForMean(meanCompare);
}

function formatColoredNameSpans(rows, color, maxList = 18) {
    if (!rows?.length) return null;
    const slice = rows.slice(0, maxList);
    const rest = rows.length - maxList;
    const parts = [];
    slice.forEach((r, i) => {
        const label = r.nameFull || r.name;
        parts.push(
            <span key={`${label}-${i}`} style={{ color, fontWeight: 600 }}>
                {label}
            </span>
        );
        if (i < slice.length - 1) parts.push(<span key={`sep-${label}-${i}`}>, </span>);
    });
    if (rest > 0) {
        parts.push(
            <span key="more" style={{ color: 'var(--text-muted)' }}>
                , and {rest} more
            </span>
        );
    }
    return parts;
}

/** Red (≥ 2 MΩ) and yellow (&gt; 1 MΩ, &lt; 2 MΩ) element lists for summaries */
function ResistanceTierSummary({ chartRows, paragraphClassName = 'dashboard-baseline-sub' }) {
    if (!chartRows?.length) return null;
    const redRows = chartRows.filter(
        (r) => typeof r.mean === 'number' && !Number.isNaN(r.mean) && r.mean >= BASELINE_BAR_OHMS_OUT_OF_RANGE_ABOVE
    );
    const yellowRows = chartRows.filter(
        (r) =>
            typeof r.mean === 'number' &&
            !Number.isNaN(r.mean) &&
            r.mean > BASELINE_BAR_OHMS_YELLOW_ABOVE &&
            r.mean < BASELINE_BAR_OHMS_OUT_OF_RANGE_ABOVE
    );
    if (!redRows.length && !yellowRows.length) return null;
    return (
        <div className="dashboard-baseline-tier-block">
            {redRows.length > 0 && (
                <p className={paragraphClassName}>
                    <strong style={{ color: TEXT_RED }}>Out of range (≥ 2 MΩ): </strong>
                    {formatColoredNameSpans(redRows, TEXT_RED)}
                    .
                </p>
            )}
            {yellowRows.length > 0 && (
                <p className={paragraphClassName}>
                    <strong style={{ color: TEXT_YELLOW }}>Elevated (&gt; 1 MΩ, &lt; 2 MΩ): </strong>
                    {formatColoredNameSpans(yellowRows, TEXT_YELLOW)}
                    .
                </p>
            )}
        </div>
    );
}

function tickFillForMean(mean) {
    if (typeof mean !== 'number' || Number.isNaN(mean)) return '#94a3b8';
    if (mean >= BASELINE_BAR_OHMS_OUT_OF_RANGE_ABOVE) return TEXT_RED;
    if (mean > BASELINE_BAR_OHMS_YELLOW_ABOVE) return TEXT_YELLOW;
    return '#94a3b8';
}

/** Category labels on X (channel names), colored by resistance tier */
function XCategoryTickColored({ x, y, payload, chartRows }) {
    const value = payload?.value;
    const row = chartRows?.find((r) => String(r.name) === String(value));
    const fill = tickFillForMean(row?.mean);
    const tilt = (chartRows?.length ?? 0) > 8;
    if (tilt) {
        return (
            <g transform={`translate(${x},${y})`}>
                <text
                    x={0}
                    y={0}
                    dy={12}
                    fill={fill}
                    fontSize={11}
                    textAnchor="end"
                    transform="rotate(-32)"
                >
                    {value}
                </text>
            </g>
        );
    }
    return (
        <text x={x} y={y} dy={14} fill={fill} fontSize={11} textAnchor="middle">
            {value}
        </text>
    );
}

function computeEnvAxisDomain(chartRows) {
    if (!chartRows?.length) return [0, 1];
    const t = chartRows[0]?.tempLine;
    const h = chartRows[0]?.rhLine;
    const vals = [t, h].filter((v) => v != null && !Number.isNaN(v));
    if (!vals.length) return [0, 1];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = hi - lo;
    const pad = span > 0 ? span * 0.12 : Math.max(Math.abs(lo), Math.abs(hi), 1) * 0.05 || 1;
    return [lo - pad, hi + pad];
}

/** First row in dashboard grid: opens full baseline chart on click */
export function DashboardBaselineGridCard({ payload, onClick }) {
    if (!payload?.chartRows?.length) return null;
    const rows = payload.chartRows;
    const hasCompareOverlay = Boolean(payload.hasCompareOverlay);
    const hasTemp = payload.tempCol != null && rows.some((r) => r.tempLine != null);
    const hasHum = payload.humCol != null && rows.some((r) => r.rhLine != null);
    const envDomain = computeEnvAxisDomain(rows);

    return (
        <div
            className="chart-grid-item glass-panel dashboard-baseline-card"
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick();
                }
            }}
            aria-label="Open baseline bar chart"
        >
            <div className="dashboard-baseline-card-inner">
                <div className="dashboard-baseline-card-copy">
                    <h3>
                        <BarChart3 size={18} aria-hidden />
                        Baseline bar chart
                    </h3>
                    <p>
                        Mean of <strong>CHR channels</strong> and grid elements <strong>A1–H8</strong> only (same naming as Aroma). Auxiliary columns
                        such as GASR0, FAN, and other non-sensor fields are omitted. Values are averaged over baseline-tagged rows in your event column
                        (RFC, AMBIENT, BL, BASELINE), or all rows if none match. The full chart uses the <strong>Y-axis for resistance (Ω)</strong> and
                        plots <strong>temperature and humidity</strong> as lines on the right-hand scale.{' '}
                        <strong>Compare with…</strong> adds a second bar per channel (first selected compare file).
                    </p>
                    <ResistanceTierSummary chartRows={payload.chartRows} paragraphClassName="dashboard-baseline-oor" />
                    <div className="dashboard-baseline-card-cta">Click to open interactive chart →</div>
                </div>
                <div className="dashboard-baseline-mini">
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart
                            data={rows}
                            margin={{ top: 6, right: hasTemp || hasHum ? 32 : 8, left: 2, bottom: 2 }}
                        >
                            <XAxis dataKey="name" hide />
                            <YAxis yAxisId="left" type="number" hide domain={['auto', 'auto']} />
                            {(hasTemp || hasHum) && (
                                <YAxis yAxisId="right" type="number" orientation="right" hide domain={envDomain} width={0} />
                            )}
                            <Bar yAxisId="left" dataKey="mean" radius={[4, 4, 0, 0]} maxBarSize={hasCompareOverlay ? 10 : 14} isAnimationActive={false}>
                                {rows.map((entry, i) => (
                                    <Cell key={`m-${entry.nameFull || entry.name}-${i}`} fill={barFillForMean(entry.mean)} />
                                ))}
                            </Bar>
                            {hasCompareOverlay && (
                                <Bar
                                    yAxisId="left"
                                    dataKey="meanCompare"
                                    radius={[4, 4, 0, 0]}
                                    maxBarSize={10}
                                    isAnimationActive={false}
                                >
                                    {rows.map((entry, i) => (
                                        <Cell
                                            key={`c-${entry.nameFull || entry.name}-${i}`}
                                            fill={barFillForCompareMean(entry.meanCompare)}
                                        />
                                    ))}
                                </Bar>
                            )}
                            {hasTemp && rows[0]?.tempLine != null && (
                                <Line
                                    yAxisId="right"
                                    type="monotone"
                                    dataKey="tempLine"
                                    stroke="#f472b6"
                                    strokeWidth={1.5}
                                    dot={false}
                                    connectNulls
                                    isAnimationActive={false}
                                />
                            )}
                            {hasHum && rows[0]?.rhLine != null && (
                                <Line
                                    yAxisId="right"
                                    type="monotone"
                                    dataKey="rhLine"
                                    stroke="#34d399"
                                    strokeWidth={1.5}
                                    dot={false}
                                    connectNulls
                                    isAnimationActive={false}
                                />
                            )}
                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
            </div>
        </div>
    );
}

function formatCompact(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e6 || (abs > 0 && abs < 1e-3)) return n.toExponential(2);
    if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return Number(n.toFixed(4)).toString();
}

function BaselineTooltip({ active, payload, label, tempCol, humCol, compareShortLabel, hasCompareOverlay }) {
    if (!active || !payload?.length) return null;
    const row = payload[0]?.payload;
    if (!row) return null;
    return (
        <div className="dashboard-baseline-tooltip glass-panel">
            <div className="dashboard-baseline-tooltip-title">{row.nameFull || label}</div>
            <div className="dashboard-baseline-tooltip-row">
                <span>Resistance (main)</span>
                <strong>
                    {formatCompact(row.mean)} Ω
                </strong>
            </div>
            {typeof row.mean === 'number' && row.mean >= BASELINE_BAR_OHMS_OUT_OF_RANGE_ABOVE && (
                <div className="dashboard-baseline-tooltip-row dashboard-baseline-tooltip-red">
                    <span>Status (main)</span>
                    <strong>Out of range (≥ 2 MΩ)</strong>
                </div>
            )}
            {typeof row.mean === 'number' &&
                row.mean > BASELINE_BAR_OHMS_YELLOW_ABOVE &&
                row.mean < BASELINE_BAR_OHMS_OUT_OF_RANGE_ABOVE && (
                    <div className="dashboard-baseline-tooltip-row dashboard-baseline-tooltip-yellow">
                        <span>Status (main)</span>
                        <strong>Elevated (&gt; 1 MΩ, &lt; 2 MΩ)</strong>
                    </div>
                )}
            {hasCompareOverlay && compareShortLabel && (
                <>
                    <div className="dashboard-baseline-tooltip-row" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                        <span>Resistance (compare)</span>
                        <strong>
                            {row.meanCompare != null && typeof row.meanCompare === 'number'
                                ? `${formatCompact(row.meanCompare)} Ω`
                                : '—'}
                        </strong>
                    </div>
                    {typeof row.meanCompare === 'number' && row.meanCompare >= BASELINE_BAR_OHMS_OUT_OF_RANGE_ABOVE && (
                        <div className="dashboard-baseline-tooltip-row dashboard-baseline-tooltip-red">
                            <span>Status (compare)</span>
                            <strong>Out of range (≥ 2 MΩ)</strong>
                        </div>
                    )}
                    {typeof row.meanCompare === 'number' &&
                        row.meanCompare > BASELINE_BAR_OHMS_YELLOW_ABOVE &&
                        row.meanCompare < BASELINE_BAR_OHMS_OUT_OF_RANGE_ABOVE && (
                            <div className="dashboard-baseline-tooltip-row dashboard-baseline-tooltip-yellow">
                                <span>Status (compare)</span>
                                <strong>Elevated (&gt; 1 MΩ, &lt; 2 MΩ)</strong>
                            </div>
                        )}
                </>
            )}
            {tempCol != null && row.tempLine != null && (
                <div className="dashboard-baseline-tooltip-row muted">
                    <span>{tempCol} (avg)</span>
                    <strong>{formatCompact(row.tempLine)} °C</strong>
                </div>
            )}
            {humCol != null && row.rhLine != null && (
                <div className="dashboard-baseline-tooltip-row muted">
                    <span>{humCol} (avg)</span>
                    <strong>{formatCompact(row.rhLine)}</strong>
                </div>
            )}
        </div>
    );
}

/**
 * Fullscreen-style modal: bar = mean per numeric series over baseline-tagged rows (or all rows);
 * lines on right axis = mean temperature & humidity over the same rows.
 */
export default function DashboardBaselineBarModal({ open, onClose, payload, fileName }) {
    useEffect(() => {
        if (!open) return;
        const onKey = (e) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    useEffect(() => {
        if (!open) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = prev;
        };
    }, [open]);

    const chartRows = payload?.chartRows;
    const hasCompareOverlay = Boolean(payload?.hasCompareOverlay);
    const compareShortLabel = payload?.compareShortLabel ?? null;
    const compareCount = payload?.compareCount ?? 0;
    const hasTemp = payload?.tempCol != null && chartRows?.some((r) => r.tempLine != null);
    const hasHum = payload?.humCol != null && chartRows?.some((r) => r.rhLine != null);

    const envAxisDomain = useMemo(() => computeEnvAxisDomain(chartRows), [chartRows]);

    const subtitleBase = useMemo(() => {
        if (!payload) return '';
        const { usedEventBaseline, rowCount, totalRows, eventCol } = payload;
        let s = '';
        if (usedEventBaseline && eventCol) {
            s = `Means over ${rowCount} row${rowCount === 1 ? '' : 's'} tagged in “${eventCol}” (RFC / AMBIENT / BL / BASELINE). Total after filters: ${totalRows}.`;
        } else if (eventCol) {
            s = `No baseline-tagged rows in “${eventCol}”; using all ${rowCount} row${rowCount === 1 ? '' : 's'} in view.`;
        } else {
            s = `No event column detected; means over all ${rowCount} row${rowCount === 1 ? '' : 's'} in view.`;
        }
        if (hasTemp || hasHum) {
            s +=
                ' Y-axis: resistance (Ohm). X-axis: channel. Pink/green lines (right axis): baseline-mean temperature and humidity. Bar colors: default (≤ 1 MΩ), yellow (&gt; 1 MΩ, &lt; 2 MΩ), red (≥ 2 MΩ).';
        } else {
            s +=
                ' Y-axis: resistance (Ohm). X-axis: channel. Bar colors: default (≤ 1 MΩ), yellow (&gt; 1 MΩ, &lt; 2 MΩ), red (≥ 2 MΩ). Add temperature/humidity columns to show env lines.';
        }
        if (payload.hasCompareOverlay && payload.compareShortLabel) {
            s += ` Grouped bars: main file and compare “${payload.compareShortLabel}” (same baseline row window).`;
        }
        if (compareCount > 1) {
            s += ' Several compare files are selected — only the first is overlaid on this chart.';
        }
        return s;
    }, [payload, hasTemp, hasHum, compareCount]);

    if (!open || !chartRows?.length) return null;

    const el = (
        <div
            className="dashboard-baseline-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-baseline-title"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="dashboard-baseline-panel glass-panel" onMouseDown={(e) => e.stopPropagation()}>
                <header className="dashboard-baseline-header">
                    <div className="dashboard-baseline-heading">
                        <BarChart3 size={22} className="dashboard-baseline-heading-icon" aria-hidden />
                        <div>
                            <h2 id="dashboard-baseline-title">Baseline bar summary</h2>
                            <p className="dashboard-baseline-file">{fileName || 'Dataset'}</p>
                            <p className="dashboard-baseline-sub">{subtitleBase}</p>
                            <ResistanceTierSummary chartRows={chartRows} />
                        </div>
                    </div>
                    <button type="button" className="dashboard-baseline-close" onClick={onClose} aria-label="Close">
                        <X size={22} />
                    </button>
                </header>

                <div className="dashboard-baseline-chart-wrap">
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart
                            data={chartRows}
                            margin={{
                                top: 16,
                                right: hasTemp || hasHum ? 52 : 16,
                                left: 8,
                                bottom: chartRows.length > 8 ? 88 : 56,
                            }}
                        >
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.45} />
                            <XAxis
                                dataKey="name"
                                stroke="#94a3b8"
                                tick={(props) => <XCategoryTickColored {...props} chartRows={chartRows} />}
                                interval={0}
                                tickLine={{ fill: '#64748b' }}
                                height={chartRows.length > 8 ? 68 : 40}
                            />
                            <YAxis
                                yAxisId="left"
                                stroke="#7dd3fc"
                                tick={{ fill: '#7dd3fc', fontSize: 11 }}
                                tickFormatter={(v) => formatCompact(v)}
                                width={56}
                            >
                                <Label
                                    value="Resistance (Ohm)"
                                    angle={-90}
                                    position="insideLeft"
                                    style={{ fill: '#7dd3fc', fontSize: 12 }}
                                />
                            </YAxis>
                            {(hasTemp || hasHum) && (
                                <YAxis
                                    yAxisId="right"
                                    orientation="right"
                                    stroke="#c4b5fd"
                                    tick={{ fill: '#c4b5fd', fontSize: 11 }}
                                    tickFormatter={(v) => formatCompact(v)}
                                    width={48}
                                    domain={envAxisDomain}
                                    allowDataOverflow
                                >
                                    <Label
                                        value="Temperature / RH"
                                        angle={90}
                                        position="insideRight"
                                        style={{ fill: '#c4b5fd', fontSize: 11 }}
                                    />
                                </YAxis>
                            )}
                            <Tooltip
                                content={
                                    <BaselineTooltip
                                        tempCol={payload.tempCol}
                                        humCol={payload.humCol}
                                        compareShortLabel={compareShortLabel}
                                        hasCompareOverlay={hasCompareOverlay}
                                    />
                                }
                                cursor={{ fill: 'rgba(56, 189, 248, 0.08)' }}
                            />
                            <Legend
                                wrapperStyle={{ paddingTop: 8 }}
                                formatter={(value) => <span style={{ color: '#e2e8f0', fontSize: '0.8rem' }}>{value}</span>}
                            />
                            <Bar
                                yAxisId="left"
                                dataKey="mean"
                                name="Main (baseline)"
                                fill={BAR_FILL_DEFAULT}
                                radius={[8, 8, 0, 0]}
                                maxBarSize={hasCompareOverlay ? 34 : 48}
                                isAnimationActive={false}
                            >
                                {chartRows.map((entry, i) => (
                                    <Cell key={`m-${entry.nameFull || entry.name}-${i}`} fill={barFillForMean(entry.mean)} />
                                ))}
                            </Bar>
                            {hasCompareOverlay && compareShortLabel && (
                                <Bar
                                    yAxisId="left"
                                    dataKey="meanCompare"
                                    name={`Compare · ${compareShortLabel}`}
                                    fill={BAR_FILL_DEFAULT}
                                    radius={[8, 8, 0, 0]}
                                    maxBarSize={34}
                                    isAnimationActive={false}
                                >
                                    {chartRows.map((entry, i) => (
                                        <Cell
                                            key={`c-${entry.nameFull || entry.name}-${i}`}
                                            fill={barFillForCompareMean(entry.meanCompare)}
                                        />
                                    ))}
                                </Bar>
                            )}
                            {hasTemp && chartRows[0]?.tempLine != null && (
                                <Line
                                    yAxisId="right"
                                    type="monotone"
                                    dataKey="tempLine"
                                    name={payload.tempCol ? `Avg ${payload.tempCol}` : 'Avg temperature'}
                                    stroke="#f472b6"
                                    strokeWidth={2.5}
                                    dot={false}
                                    connectNulls
                                    isAnimationActive={false}
                                />
                            )}
                            {hasHum && chartRows[0]?.rhLine != null && (
                                <Line
                                    yAxisId="right"
                                    type="monotone"
                                    dataKey="rhLine"
                                    name={payload.humCol ? `Avg ${payload.humCol}` : 'Avg RH'}
                                    stroke="#34d399"
                                    strokeWidth={2.5}
                                    dot={false}
                                    connectNulls
                                    isAnimationActive={false}
                                />
                            )}
                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
            </div>
        </div>
    );

    return createPortal(el, document.body);
}
