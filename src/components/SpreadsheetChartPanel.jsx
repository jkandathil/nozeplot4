import { useMemo, useState } from 'react';
import {
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Label,
    Line,
    LineChart,
    ResponsiveContainer,
    Scatter,
    ScatterChart,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import { BarChart3 } from 'lucide-react';
import './SpreadsheetChartPanel.css';

const MAX_POINTS = 4000;

function toNumber(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v === null || v === undefined) return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

function parseAxisBound(raw) {
    const t = String(raw ?? '').trim();
    if (t === '') return undefined;
    const n = Number(t.replace(/,/g, ''));
    return Number.isFinite(n) ? n : undefined;
}

/** Recharts domain: undefined = fully automatic */
function rechartsDomain(minStr, maxStr) {
    const lo = parseAxisBound(minStr);
    const hi = parseAxisBound(maxStr);
    if (lo === undefined && hi === undefined) return undefined;
    if (lo !== undefined && hi !== undefined) return [lo, hi];
    if (lo !== undefined) return [lo, 'auto'];
    return ['auto', hi];
}

function histogramBins(values, binCount) {
    const nums = values.filter((x) => x !== null);
    if (nums.length === 0) return [];
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (min === max) return [{ bin: String(min.toFixed(4)), count: nums.length }];
    const bins = Array.from({ length: binCount }, (_, i) => ({
        lo: min + ((max - min) * i) / binCount,
        hi: min + ((max - min) * (i + 1)) / binCount,
        count: 0,
    }));
    for (const x of nums) {
        let i = Math.floor(((x - min) / (max - min)) * binCount);
        if (i >= binCount) i = binCount - 1;
        if (i < 0) i = 0;
        bins[i].count += 1;
    }
    return bins.map((b, i) => ({
        x: `${b.lo.toPrecision(4)}–${b.hi.toPrecision(4)}`,
        y: b.count,
        bin: i,
    }));
}

export default function SpreadsheetChartPanel({
    fields,
    computedRows,
    /** When set (non-empty), plot these {x,y,label} points instead of whole-column series (line / scatter / bar). */
    rangeChartPoints = null,
    rangeChartSummary = '',
    open,
    maximized = false,
    onToggle,
    chartKind,
    xField,
    yField,
    onChartKindChange,
    onXFieldChange,
    onYFieldChange,
    xAxisMin,
    xAxisMax,
    yAxisMin,
    yAxisMax,
    onXAxisMinChange,
    onXAxisMaxChange,
    onYAxisMinChange,
    onYAxisMaxChange,
}) {
    const [editorTab, setEditorTab] = useState('setup');

    const sample = useMemo(() => {
        if (!computedRows?.length) return [];
        const n = Math.min(computedRows.length, MAX_POINTS);
        return computedRows.slice(0, n);
    }, [computedRows]);

    const chartData = useMemo(() => {
        if (chartKind === 'histogram') {
            if (!sample.length || !yField) return [];
            const vals = sample.map((r) => toNumber(r[yField]));
            return histogramBins(vals, Math.min(24, Math.max(8, Math.ceil(Math.sqrt(sample.length)))));
        }
        if (rangeChartPoints && rangeChartPoints.length > 0) {
            return rangeChartPoints
                .map((p, i) => ({
                    x: p.x,
                    y: p.y,
                    label: chartKind === 'bar' ? String(i + 1) : String(p.x ?? i + 1),
                }))
                .filter((d) => toNumber(d.y) !== null && (chartKind !== 'scatter' || toNumber(d.x) !== null));
        }
        if (!sample.length || !yField) return [];
        const xf = xField || '__index';
        return sample.map((row, i) => {
            const xv = xf === '__index' ? i + 1 : row[xf];
            const yv = toNumber(row[yField]);
            return {
                x: xf === '__index' ? i + 1 : xv,
                y: yv,
                label: String(xv ?? i + 1),
            };
        });
    }, [sample, xField, yField, chartKind, rangeChartPoints]);

    const xScaleIsNumeric = useMemo(() => {
        if (!chartData.length) return false;
        if (chartKind === 'scatter') return true;
        if (chartKind === 'histogram' || chartKind === 'bar') return false;
        if (chartKind === 'line') {
            if (!xField || xField === '__index') return true;
            return chartData.every((d) => toNumber(d.x) !== null);
        }
        return false;
    }, [chartData, chartKind, xField]);

    const xDomain = useMemo(() => {
        if (!xScaleIsNumeric) return undefined;
        return rechartsDomain(xAxisMin, xAxisMax);
    }, [xScaleIsNumeric, xAxisMin, xAxisMax]);

    const yDomain = useMemo(() => rechartsDomain(yAxisMin, yAxisMax), [yAxisMin, yAxisMax]);
    const hasXDom = xDomain != null;
    const hasYDom = yDomain != null;

    /** Shown under the chart so X vs Y bounds are not confused (e.g. Y max does not cap row # on X). */
    const xAxisCaption = useMemo(() => {
        if (rangeChartPoints?.length) return 'Bottom axis (X): cell selection';
        if (!xField || xField === '__index') return 'Bottom axis (X): row number';
        return `Bottom axis (X): ${xField}`;
    }, [xField, rangeChartPoints]);
    const yAxisCaption = useMemo(() => {
        if (rangeChartPoints?.length) return 'Left axis (Y): cell selection';
        if (!yField) return 'Left axis (Y)';
        return `Left axis (Y): ${yField}`;
    }, [yField, rangeChartPoints]);

    const scatterMode = chartKind === 'scatter';

    const xColumnChoices = useMemo(() => {
        if (scatterMode && yField) return fields.filter((f) => f !== yField);
        return fields;
    }, [scatterMode, fields, yField]);

    const yColumnChoices = useMemo(() => {
        if (scatterMode && xField && xField !== '__index') return fields.filter((f) => f !== xField);
        return fields;
    }, [scatterMode, fields, xField]);

    const xSelectValue = !xField || xField === '' ? '__index' : xField;

    const handleXSelectChange = (v) => {
        const next = v === '__index' ? '__index' : v;
        onXFieldChange(next);
        if (scatterMode && yField === next && next !== '__index') {
            const alt = fields.find((f) => f !== next);
            onYFieldChange(alt ?? fields[0] ?? '');
        }
    };

    const handleYSelectChange = (v) => {
        onYFieldChange(v);
        if (scatterMode && xField && xField !== '__index' && xField === v) {
            onXFieldChange('__index');
        }
    };

    if (!open) {
        return (
            <button
                type="button"
                className="spreadsheet-chart-fab"
                onClick={onToggle}
                title="Show chart panel on the right"
            >
                <BarChart3 size={20} />
            </button>
        );
    }

    return (
        <aside
            className={['spreadsheet-chart-panel', maximized ? 'spreadsheet-chart-panel--maximized' : '']
                .filter(Boolean)
                .join(' ')}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div className="spreadsheet-chart-panel-head">
                <div className="spreadsheet-chart-panel-head-title">
                    <span className="spreadsheet-chart-panel-head-accent" aria-hidden />
                    <h2>Chart tools</h2>
                </div>
                <button type="button" className="spreadsheet-chart-close" onClick={onToggle} aria-label="Close chart panel">
                    ×
                </button>
            </div>
            <div
                className={['spreadsheet-chart-eca-split', maximized ? 'spreadsheet-chart-eca-split--max' : '']
                    .filter(Boolean)
                    .join(' ')}
            >
                <div className="spreadsheet-chart-eca-tools">
                    <div className="spreadsheet-chart-editor-tabs" role="tablist" aria-label="Chart tool tabs">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={editorTab === 'setup'}
                            className={`spreadsheet-chart-tab ${editorTab === 'setup' ? 'is-active' : ''}`}
                            onClick={() => setEditorTab('setup')}
                        >
                            Design
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={editorTab === 'customize'}
                            className={`spreadsheet-chart-tab ${editorTab === 'customize' ? 'is-active' : ''}`}
                            onClick={() => setEditorTab('customize')}
                        >
                            Format
                        </button>
                    </div>
                    {editorTab === 'setup' ? (
                        <div className="spreadsheet-chart-design-docked">
                            <div className="spreadsheet-chart-editor-row">
                                <label htmlFor="spreadsheet-chart-type">Chart type</label>
                                <select
                                    id="spreadsheet-chart-type"
                                    className="spreadsheet-chart-editor-select"
                                    value={chartKind}
                                    onChange={(e) => onChartKindChange(e.target.value)}
                                    onMouseDown={(e) => e.stopPropagation()}
                                >
                                    <option value="line">Line chart</option>
                                    <option value="bar">Column chart</option>
                                    <option value="scatter">Scatter (X vs Y)</option>
                                    <option value="histogram">Histogram</option>
                                </select>
                            </div>
                            {rangeChartSummary && chartKind !== 'histogram' ? (
                                <p className="spreadsheet-chart-editor-tip spreadsheet-chart-range-summary">{rangeChartSummary}</p>
                            ) : null}
                            <div className="spreadsheet-chart-editor-row">
                                <label htmlFor="spreadsheet-chart-y">
                                    {scatterMode ? 'Y data column' : 'Series (Y)'}
                                </label>
                                <select
                                    id="spreadsheet-chart-y"
                                    className="spreadsheet-chart-editor-select"
                                    value={yField}
                                    onChange={(e) => handleYSelectChange(e.target.value)}
                                    onMouseDown={(e) => e.stopPropagation()}
                                >
                                    <option value="">— Select column —</option>
                                    {yColumnChoices.map((f, i) => (
                                        <option key={`y-${i}-${f}`} value={f}>
                                            {f}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            {chartKind !== 'histogram' ? (
                                <div className="spreadsheet-chart-editor-row">
                                    <label htmlFor="spreadsheet-chart-x">
                                        {scatterMode ? 'X data column' : 'X axis'}
                                    </label>
                                    <select
                                        id="spreadsheet-chart-x"
                                        className="spreadsheet-chart-editor-select"
                                        value={xSelectValue}
                                        onChange={(e) => handleXSelectChange(e.target.value)}
                                        onMouseDown={(e) => e.stopPropagation()}
                                    >
                                        <option value="__index">Row number</option>
                                        {xColumnChoices.map((f, i) => (
                                            <option key={`x-${i}-${f}`} value={f}>
                                                {f}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                    <div className="spreadsheet-chart-panel-scroll">
                    {editorTab === 'setup' ? (
                        <div className="spreadsheet-chart-setup">
                            <p className="spreadsheet-chart-editor-tip">
                                {scatterMode ? (
                                    <>
                                        <strong>Scatter:</strong> pick <strong>Y</strong> then <strong>X</strong> (two
                                        different columns), or set X to <strong>Row number</strong> to plot Y against
                                        row index. Grid headers: click = Y, Shift+click = X.
                                    </>
                                ) : (
                                    <>
                                        <strong>Cell ranges:</strong> drag down a column for a vertical strip;{' '}
                                        <strong>Shift+click</strong> two corners for a full rectangle. Toolbar{' '}
                                        <strong>Set X</strong> / <strong>+ X</strong> / <strong>Set Y</strong> /{' '}
                                        <strong>+ Y</strong> (multiple areas concatenate). If you only set <strong>X</strong>{' '}
                                        from cells, pick a <strong>Series (Y)</strong> column too — Y values are read
                                        from the same rows. Headers: click = chart Y, Shift+click = chart X.
                                    </>
                                )}
                                {maximized ? (
                                    <>
                                        {' '}
                                        <strong>Sheet hidden</strong> — use toolbar <strong>Show sheet</strong> to
                                        edit cells.
                                    </>
                                ) : null}
                            </p>
                        </div>
                    ) : (
                        <div className="spreadsheet-chart-customize">
                            <p className="spreadsheet-chart-editor-tip">
                                <strong>Y min / Y max</strong> control the <strong>vertical</strong> scale (left).
                                <strong> X min / X max</strong> control the <strong>horizontal</strong> scale (bottom)
                                when X is numeric (row #, scatter, numeric column). Blank = automatic. Bar / histogram
                                X stays categorical.
                            </p>
                            <div className="spreadsheet-chart-editor-row">
                                <label htmlFor="spreadsheet-xmin">X min</label>
                                <input
                                    id="spreadsheet-xmin"
                                    className="spreadsheet-chart-editor-input"
                                    type="text"
                                    inputMode="decimal"
                                    value={xAxisMin}
                                    onChange={(e) => onXAxisMinChange(e.target.value)}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    placeholder="Auto"
                                    aria-label="X axis minimum"
                                />
                            </div>
                            <div className="spreadsheet-chart-editor-row">
                                <label htmlFor="spreadsheet-xmax">X max</label>
                                <input
                                    id="spreadsheet-xmax"
                                    className="spreadsheet-chart-editor-input"
                                    type="text"
                                    inputMode="decimal"
                                    value={xAxisMax}
                                    onChange={(e) => onXAxisMaxChange(e.target.value)}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    placeholder="Auto"
                                    aria-label="X axis maximum"
                                />
                            </div>
                            <div className="spreadsheet-chart-editor-row">
                                <label htmlFor="spreadsheet-ymin">Y min</label>
                                <input
                                    id="spreadsheet-ymin"
                                    className="spreadsheet-chart-editor-input"
                                    type="text"
                                    inputMode="decimal"
                                    value={yAxisMin}
                                    onChange={(e) => onYAxisMinChange(e.target.value)}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    placeholder="Auto"
                                    aria-label="Y axis minimum"
                                />
                            </div>
                            <div className="spreadsheet-chart-editor-row">
                                <label htmlFor="spreadsheet-ymax">Y max</label>
                                <input
                                    id="spreadsheet-ymax"
                                    className="spreadsheet-chart-editor-input"
                                    type="text"
                                    inputMode="decimal"
                                    value={yAxisMax}
                                    onChange={(e) => onYAxisMaxChange(e.target.value)}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    placeholder="Auto"
                                    aria-label="Y axis maximum"
                                />
                            </div>
                        </div>
                    )}
                    </div>
                </div>
                <div className="spreadsheet-chart-eca-preview">
                    <div className="spreadsheet-chart-canvas" aria-label="Chart preview">
                    {chartData.length === 0 ? (
                        <div className="spreadsheet-chart-empty">
                            {rangeChartSummary
                                ? 'No plottable numeric points from the current cell ranges and column picks. Check values or clear ranges.'
                                : 'Select a Y column, or define cell ranges and use the toolbar Set X / Set Y buttons.'}
                        </div>
                    ) : chartKind === 'line' ? (
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={chartData} margin={{ top: 10, right: 10, left: 6, bottom: 28 }}>
                                <CartesianGrid stroke="#e8eaed" strokeDasharray="3 3" />
                                {xScaleIsNumeric ? (
                                    <XAxis
                                        type="number"
                                        dataKey="x"
                                        tick={{ fontSize: 10 }}
                                        stroke="#5f6368"
                                        domain={xDomain ?? ['auto', 'auto']}
                                        allowDataOverflow={hasXDom}
                                    >
                                        <Label
                                            value={xAxisCaption}
                                            position="insideBottom"
                                            offset={-18}
                                            fill="#605e5c"
                                            fontSize={10}
                                        />
                                    </XAxis>
                                ) : (
                                    <XAxis dataKey="x" tick={{ fontSize: 10 }} stroke="#5f6368">
                                        <Label
                                            value={xAxisCaption}
                                            position="insideBottom"
                                            offset={-18}
                                            fill="#605e5c"
                                            fontSize={10}
                                        />
                                    </XAxis>
                                )}
                                <YAxis
                                    tick={{ fontSize: 10 }}
                                    stroke="#5f6368"
                                    width={48}
                                    domain={yDomain ?? ['auto', 'auto']}
                                    allowDataOverflow={hasYDom}
                                >
                                    <Label
                                        value={yAxisCaption}
                                        angle={-90}
                                        position="insideLeft"
                                        style={{ textAnchor: 'middle' }}
                                        fill="#605e5c"
                                        fontSize={10}
                                    />
                                </YAxis>
                                <Tooltip
                                    contentStyle={{
                                        background: '#fff',
                                        border: '1px solid #dadce0',
                                        borderRadius: 8,
                                        fontSize: 12,
                                    }}
                                />
                                <Line type="monotone" dataKey="y" stroke="#188038" strokeWidth={2} dot={false} />
                            </LineChart>
                        </ResponsiveContainer>
                    ) : chartKind === 'bar' ? (
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 48 }}>
                                <CartesianGrid stroke="#e8eaed" strokeDasharray="3 3" />
                                <XAxis
                                    dataKey="label"
                                    angle={-35}
                                    textAnchor="end"
                                    height={60}
                                    tick={{ fontSize: 9 }}
                                    stroke="#5f6368"
                                />
                                <YAxis
                                    tick={{ fontSize: 10 }}
                                    stroke="#5f6368"
                                    width={44}
                                    domain={yDomain ?? ['auto', 'auto']}
                                    allowDataOverflow={hasYDom}
                                />
                                <Tooltip
                                    contentStyle={{
                                        background: '#fff',
                                        border: '1px solid #dadce0',
                                        borderRadius: 8,
                                        fontSize: 12,
                                    }}
                                />
                                <Bar dataKey="y" fill="#1a73e8" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    ) : chartKind === 'scatter' ? (
                        <ResponsiveContainer width="100%" height="100%">
                            <ScatterChart margin={{ top: 10, right: 10, left: 6, bottom: 28 }}>
                                <CartesianGrid stroke="#e8eaed" strokeDasharray="3 3" />
                                <XAxis
                                    type="number"
                                    dataKey="x"
                                    name="X"
                                    tick={{ fontSize: 10 }}
                                    stroke="#5f6368"
                                    domain={xDomain ?? ['auto', 'auto']}
                                    allowDataOverflow={hasXDom}
                                >
                                    <Label
                                        value={xAxisCaption}
                                        position="insideBottom"
                                        offset={-18}
                                        fill="#605e5c"
                                        fontSize={10}
                                    />
                                </XAxis>
                                <YAxis
                                    type="number"
                                    dataKey="y"
                                    name="Y"
                                    tick={{ fontSize: 10 }}
                                    stroke="#5f6368"
                                    width={48}
                                    domain={yDomain ?? ['auto', 'auto']}
                                    allowDataOverflow={hasYDom}
                                >
                                    <Label
                                        value={yAxisCaption}
                                        angle={-90}
                                        position="insideLeft"
                                        style={{ textAnchor: 'middle' }}
                                        fill="#605e5c"
                                        fontSize={10}
                                    />
                                </YAxis>
                                <Tooltip cursor={{ strokeDasharray: '3 3' }} />
                                <Scatter name="Data" data={chartData} fill="#ea8600" />
                            </ScatterChart>
                        </ResponsiveContainer>
                    ) : (
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 64 }}>
                                <CartesianGrid stroke="#e8eaed" strokeDasharray="3 3" />
                                <XAxis
                                    dataKey="x"
                                    tick={{ fontSize: 8 }}
                                    stroke="#5f6368"
                                    interval={0}
                                    angle={-45}
                                    textAnchor="end"
                                    height={80}
                                />
                                <YAxis
                                    tick={{ fontSize: 10 }}
                                    stroke="#5f6368"
                                    width={36}
                                    domain={yDomain ?? ['auto', 'auto']}
                                    allowDataOverflow={hasYDom}
                                />
                                <Tooltip
                                    contentStyle={{
                                        background: '#fff',
                                        border: '1px solid #dadce0',
                                        borderRadius: 8,
                                        fontSize: 12,
                                    }}
                                />
                                <Bar dataKey="y" fill="#9334e6" radius={[4, 4, 0, 0]}>
                                    {chartData.map((_, i) => (
                                        <Cell key={i} fill={`hsl(${220 + ((i * 5) % 80)}, 55%, 52%)`} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    )}
                    </div>
                </div>
            </div>
        </aside>
    );
}
