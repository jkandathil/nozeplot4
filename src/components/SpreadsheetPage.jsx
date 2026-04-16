import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import DataGrid, { textEditor } from 'react-data-grid';
import 'react-data-grid/lib/styles.css';
import './SpreadsheetPage.css';
import { ArrowLeft, ChevronsLeft, ChevronsRight, Maximize2, Save, Sigma, Table2 } from 'lucide-react';
import { parseFile } from '../utils/fileParser';
import { fileBasename } from '../utils/workspaceFilename';
import {
    cellAddressLabel,
    columnIndexToLetter,
    exportComputedRows,
    formatHFCellValue,
    rebuildHyperFormula,
} from '../utils/spreadsheetHyperformula';
import {
    cellInRect,
    extractAxisFromRects,
    hfCellNumeric,
    normalizeSheetRect,
    pairScatterPoints,
    pairScatterPointsByRow,
} from '../utils/spreadsheetChartRanges';
import SpreadsheetChartPanel from './SpreadsheetChartPanel';

function collectFields(metaFields, rows) {
    if (Array.isArray(metaFields) && metaFields.length > 0) {
        return [...metaFields];
    }
    const seen = new Set();
    const ordered = [];
    for (const row of rows || []) {
        if (!row || typeof row !== 'object') continue;
        for (const k of Object.keys(row)) {
            if (!seen.has(k)) {
                seen.add(k);
                ordered.push(k);
            }
        }
    }
    return ordered;
}

function normalizeRow(fields, row) {
    const o = {};
    for (const f of fields) {
        const v = row?.[f];
        if (v === undefined || v === null) o[f] = '';
        else if (typeof v === 'object') o[f] = JSON.stringify(v);
        else o[f] = String(v);
    }
    return o;
}

function stablePayloadJson(fields, rows) {
    return JSON.stringify({
        fields,
        rows: rows.map((r) => fields.map((f) => r[f])),
    });
}

const ROW_NUM_KEY = '__rn';
const RID_KEY = '__rid';
/** Per header tier height (react-data-grid uses two tiers when columns are grouped: letters, then names). */
const HEADER_ROW_HEIGHT = 26;

export default function SpreadsheetPage({ fileId, workspaceFiles, onSave, onClose }) {
    const [loadError, setLoadError] = useState(null);
    const [loading, setLoading] = useState(true);
    const [fileLabel, setFileLabel] = useState('');
    const [fields, setFields] = useState([]);
    const [rows, setRows] = useState([]);
    const [saveError, setSaveError] = useState(null);
    const [saving, setSaving] = useState(false);
    const baselineRef = useRef('');
    const hfRef = useRef(null);
    const [hfEpoch, setHfEpoch] = useState(0);
    const [selected, setSelected] = useState(null);
    const [selectedColumnKey, setSelectedColumnKey] = useState(null);
    const [formulaDraft, setFormulaDraft] = useState('');
    const [chartOpen, setChartOpen] = useState(true);
    /** Hide grid; chart uses full width of the sheet workspace */
    const [chartMaximized, setChartMaximized] = useState(false);
    const [chartKind, setChartKind] = useState('line');
    /** Use `'__index'` (never `''`) so the X-axis select always matches an option value. */
    const [chartXField, setChartXField] = useState('__index');
    const [chartYField, setChartYField] = useState('');
    const [chartXMin, setChartXMin] = useState('');
    const [chartXMax, setChartXMax] = useState('');
    const [chartYMin, setChartYMin] = useState('');
    const [chartYMax, setChartYMax] = useState('');
    /** Inclusive rectangle in data columns for chart range UI (drag or Shift+click). */
    const [sheetRangeSelection, setSheetRangeSelection] = useState(null);
    /** Multiple rectangles → values concatenated row-major per rectangle, then next rectangle. */
    const [chartXRanges, setChartXRanges] = useState([]);
    const [chartYRanges, setChartYRanges] = useState([]);
    const rangeAnchorRef = useRef(null);
    const dragSelectingRef = useRef(false);
    /** Last pointer position during a drag — used to refresh range after grid scroll (wheel) without moving the mouse. */
    const lastPointerClientRef = useRef({ x: 0, y: 0 });
    const dataGridRef = useRef(null);

    const fileStub = useMemo(
        () => workspaceFiles?.find((f) => f.id === fileId && !f.isFolder),
        [workspaceFiles, fileId]
    );

    const disposeHf = useCallback(() => {
        if (hfRef.current) {
            try {
                hfRef.current.destroy();
            } catch {
                /* ignore */
            }
            hfRef.current = null;
        }
    }, []);

    useEffect(() => () => disposeHf(), [disposeHf]);

    const syncHf = useCallback(
        (rawRows) => {
            disposeHf();
            if (!fields.length || !rawRows.length) {
                setHfEpoch((n) => n + 1);
                return;
            }
            hfRef.current = rebuildHyperFormula(fields, rawRows);
            setHfEpoch((n) => n + 1);
        },
        [fields, disposeHf]
    );

    useEffect(() => {
        let cancelled = false;
        async function load() {
            setLoadError(null);
            setLoading(true);
            setSaveError(null);
            baselineRef.current = '';
            disposeHf();
            setRows([]);
            setFields([]);
            setSelected(null);
            setSelectedColumnKey(null);
            setFormulaDraft('');
            if (!fileId) {
                setLoading(false);
                setLoadError('No file selected.');
                return;
            }
            if (!fileStub) {
                setLoading(false);
                setLoadError('That file is not in the workspace (it may have been removed).');
                return;
            }
            try {
                const parsed = await parseFile(fileStub);
                const dataRows = Array.isArray(parsed.data) ? parsed.data : [];
                const f = collectFields(parsed.meta?.fields, dataRows);
                let normalized = dataRows.map((r) => normalizeRow(f, r));
                if (f.length > 0 && normalized.length === 0) {
                    normalized = [normalizeRow(f, {})];
                }
                if (cancelled) return;
                setFileLabel(parsed.fileName || fileStub.name || '');
                setFields(f);
                setRows(normalized);
                setChartKind('line');
                setChartXField('__index');
                setChartYField('');
                setChartXMin('');
                setChartXMax('');
                setChartYMin('');
                setChartYMax('');
                setChartMaximized(false);
                setSheetRangeSelection(null);
                setChartXRanges([]);
                setChartYRanges([]);
                baselineRef.current = stablePayloadJson(f, normalized);
                if (f.length && normalized.length) {
                    hfRef.current = rebuildHyperFormula(f, normalized);
                    setHfEpoch((n) => n + 1);
                }
            } catch (e) {
                if (!cancelled) {
                    setLoadError(e?.message || 'Could not load this file.');
                    setFields([]);
                    setRows([]);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, [fileId, fileStub, disposeHf]);

    const displayRows = useMemo(
        () => rows.map((r, i) => ({ ...r, [RID_KEY]: i, [ROW_NUM_KEY]: i + 1 })),
        [rows]
    );

    const dirty = useMemo(() => {
        if (!fields.length && !rows.length) return false;
        return stablePayloadJson(fields, rows) !== baselineRef.current;
    }, [fields, rows]);

    useEffect(() => {
        if (!dirty) return;
        const onBeforeUnload = (e) => {
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [dirty]);

    const computedRowsForChart = useMemo(() => {
        const hf = hfRef.current;
        if (!hf || !fields.length || !rows.length) return [];
        try {
            return exportComputedRows(hf, fields, rows.length);
        } catch {
            return [];
        }
    }, [fields, rows, hfEpoch]);

    const { rangeChartPoints, rangeChartSummary } = useMemo(() => {
        const baseParts = [];
        if (chartXRanges.length) baseParts.push(`Chart X: ${chartXRanges.length} cell area(s)`);
        if (chartYRanges.length) baseParts.push(`Chart Y: ${chartYRanges.length} cell area(s)`);
        const hf = hfRef.current;
        if (!hf || !fields.length || !rows.length) {
            return { rangeChartPoints: null, rangeChartSummary: baseParts.join(' · ') };
        }
        if (!chartXRanges.length && !chartYRanges.length) {
            return { rangeChartPoints: null, rangeChartSummary: baseParts.join(' · ') };
        }
        if (chartKind === 'histogram') {
            return { rangeChartPoints: null, rangeChartSummary: baseParts.join(' · ') };
        }
        const rowCount = rows.length;
        let xs = null;
        let ys = null;
        let xRows = null;
        let yRows = null;
        if (chartXRanges.length) {
            const ex = extractAxisFromRects(hf, fields, rowCount, chartXRanges);
            xs = ex.values;
            xRows = ex.rows;
        }
        if (chartYRanges.length) {
            const ey = extractAxisFromRects(hf, fields, rowCount, chartYRanges);
            ys = ey.values;
            yRows = ey.rows;
        }
        if (!xs && ys) {
            xs = yRows?.length ? yRows.map((r) => r + 1) : ys.map((_, i) => i + 1);
        } else if (xs && !ys && chartYField && fields.includes(chartYField) && xRows?.length) {
            const c = fields.indexOf(chartYField);
            ys = xRows.map((r) => hfCellNumeric(hf, r, c));
        } else if (!xs || !ys) {
            return { rangeChartPoints: null, rangeChartSummary: baseParts.join(' · ') };
        }
        const useRowPair =
            chartXRanges.length > 0 &&
            chartYRanges.length > 0 &&
            xRows?.length === xs.length &&
            yRows?.length === ys.length;
        const pts = useRowPair ? pairScatterPointsByRow(xs, xRows, ys, yRows) : pairScatterPoints(xs, ys);
        let summary = baseParts.join(' · ');
        if (useRowPair && pts.length) {
            const finiteX = xs.filter((v) => Number.isFinite(v)).length;
            const finiteY = ys.filter((v) => Number.isFinite(v)).length;
            summary += ` · ${pts.length} point(s) (X and Y matched by sheet row; finite values: ${finiteX} X, ${finiteY} Y)`;
            if (pts.length < Math.min(finiteX, finiteY)) {
                summary += ' — some rows have only X or only Y.';
            }
        }
        return { rangeChartPoints: pts.length ? pts : null, rangeChartSummary: summary };
    }, [chartXRanges, chartYRanges, fields, rows.length, chartKind, chartYField, hfEpoch]);

    const dragMovedRef = useRef(false);

    const extendRangeFromClientXY = useCallback((clientX, clientY) => {
        lastPointerClientRef.current = { x: clientX, y: clientY };
        const el = document.elementFromPoint(clientX, clientY)?.closest?.('[data-sheet-cell]');
        if (!el?.dataset?.sheetCol) return;
        const nc = el.dataset.sheetCol;
        const nr = Number.parseInt(el.dataset.sheetRow, 10);
        if (Number.isNaN(nr)) return;
        const a = rangeAnchorRef.current;
        if (!a) return;
        const r2 = normalizeSheetRect(a.colKey, a.rowIdx, nc, nr, fields);
        if (r2) {
            setSheetRangeSelection(r2);
            if (r2.cols.length > 1 || r2.r0 !== r2.r1) {
                dragMovedRef.current = true;
            }
        }
    }, [fields]);

    const onDataGridScrollDuringRangeDrag = useCallback(() => {
        if (!dragSelectingRef.current) return;
        const p = lastPointerClientRef.current;
        extendRangeFromClientXY(p.x, p.y);
    }, [extendRangeFromClientXY]);

    const onRangePointerDown = useCallback(
        (e, rowIdx, colKey) => {
            if (e.button !== 0) return;
            const captureEl = e.currentTarget;
            dragMovedRef.current = false;
            dragSelectingRef.current = true;
            rangeAnchorRef.current = { colKey, rowIdx };
            lastPointerClientRef.current = { x: e.clientX, y: e.clientY };
            const rect = normalizeSheetRect(colKey, rowIdx, colKey, rowIdx, fields);
            if (rect) setSheetRangeSelection(rect);
            const pid = e.pointerId;
            try {
                captureEl.setPointerCapture(pid);
            } catch {
                /* ignore */
            }

            const gridRoot = dataGridRef.current?.element ?? null;
            let cleaned = false;
            const cleanup = () => {
                if (cleaned) return;
                cleaned = true;
                gridRoot?.removeEventListener('scroll', onScrollDuringDrag);
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
                window.removeEventListener('pointercancel', onPointerUp);
                try {
                    captureEl.releasePointerCapture(pid);
                } catch {
                    /* ignore */
                }
            };

            const onScrollDuringDrag = () => {
                if (!dragSelectingRef.current) return;
                const p = lastPointerClientRef.current;
                extendRangeFromClientXY(p.x, p.y);
            };

            const onPointerMove = (ev) => {
                if (ev.pointerId !== pid) return;
                extendRangeFromClientXY(ev.clientX, ev.clientY);
            };

            const onPointerUp = (ev) => {
                if (ev.pointerId !== pid) return;
                dragSelectingRef.current = false;
                cleanup();
            };

            gridRoot?.addEventListener('scroll', onScrollDuringDrag, { passive: true });
            window.addEventListener('pointermove', onPointerMove, { passive: true });
            window.addEventListener('pointerup', onPointerUp);
            window.addEventListener('pointercancel', onPointerUp);
        },
        [extendRangeFromClientXY]
    );

    const onRangeMouseEnterWhileDown = useCallback(
        (e, rowIdx, colKey) => {
            if ((e.buttons & 1) === 0) return;
            if (!dragSelectingRef.current || !rangeAnchorRef.current) return;
            const a = rangeAnchorRef.current;
            const r2 = normalizeSheetRect(a.colKey, a.rowIdx, colKey, rowIdx, fields);
            if (r2) {
                setSheetRangeSelection(r2);
                if (r2.cols.length > 1 || r2.r0 !== r2.r1) {
                    dragMovedRef.current = true;
                }
            }
        },
        [fields]
    );

    const onRangeClick = useCallback(
        (e, rowIdx, colKey) => {
            if (dragMovedRef.current) {
                dragMovedRef.current = false;
                return;
            }
            if (e.shiftKey && rangeAnchorRef.current) {
                const a = rangeAnchorRef.current;
                const rect = normalizeSheetRect(a.colKey, a.rowIdx, colKey, rowIdx, fields);
                if (rect) setSheetRangeSelection(rect);
                return;
            }
            rangeAnchorRef.current = { colKey, rowIdx };
            const rect = normalizeSheetRect(colKey, rowIdx, colKey, rowIdx, fields);
            if (rect) setSheetRangeSelection(rect);
        },
        [fields]
    );

    const replaceChartXFromSelection = useCallback(() => {
        if (!sheetRangeSelection) return;
        setChartXRanges([sheetRangeSelection]);
    }, [sheetRangeSelection]);

    const appendChartXFromSelection = useCallback(() => {
        if (!sheetRangeSelection) return;
        setChartXRanges((prev) => [...prev, sheetRangeSelection]);
    }, [sheetRangeSelection]);

    const replaceChartYFromSelection = useCallback(() => {
        if (!sheetRangeSelection) return;
        setChartYRanges([sheetRangeSelection]);
    }, [sheetRangeSelection]);

    const appendChartYFromSelection = useCallback(() => {
        if (!sheetRangeSelection) return;
        setChartYRanges((prev) => [...prev, sheetRangeSelection]);
    }, [sheetRangeSelection]);

    const clearChartCellRanges = useCallback(() => {
        setChartXRanges([]);
        setChartYRanges([]);
    }, []);

    const plotXYFromSelection = useCallback(() => {
        if (!sheetRangeSelection || sheetRangeSelection.cols.length < 2) return;
        setChartKind('scatter');
        const xRect = { ...sheetRangeSelection, cols: [sheetRangeSelection.cols[0]] };
        const yRect = { ...sheetRangeSelection, cols: [sheetRangeSelection.cols[1]] };
        setChartXRanges([xRect]);
        setChartYRanges([yRect]);
        setChartOpen(true);
    }, [sheetRangeSelection]);

    const applyRawRows = useCallback(
        (nextRows) => {
            setRows(nextRows);
            syncHf(nextRows);
        },
        [syncHf]
    );

    const onRowsChange = useCallback(
        (newRows) => {
            const cleaned = newRows.map((r) => {
                const { [RID_KEY]: _rid, [ROW_NUM_KEY]: _rn, ...rest } = r;
                return rest;
            });
            applyRawRows(cleaned);
        },
        [applyRawRows]
    );

    const onSelectedCellChange = useCallback(
        ({ rowIdx, column }) => {
            if (column.key === ROW_NUM_KEY) {
                setSelected(null);
                setSelectedColumnKey(null);
                setFormulaDraft('');
                return;
            }
            const colIdx = fields.indexOf(column.key);
            if (colIdx < 0) return;
            if (rowIdx < 0) {
                setSelected(null);
                setSelectedColumnKey(column.key);
                const raw = rows[0]?.[column.key] ?? '';
                setFormulaDraft(String(raw));
                return;
            }
            setSelectedColumnKey(null);
            setSelected({ rowIdx, colIdx, key: column.key });
            const raw = rows[rowIdx]?.[column.key] ?? '';
            setFormulaDraft(String(raw));
            /* While dragging a range, RDG moves the active cell each row — do not reset our multi-cell highlight. */
            if (!dragSelectingRef.current) {
                const r = normalizeSheetRect(column.key, rowIdx, column.key, rowIdx, fields);
                if (r) {
                    setSheetRangeSelection(r);
                    rangeAnchorRef.current = { colKey: column.key, rowIdx };
                }
            }
        },
        [fields, rows]
    );

    useEffect(() => {
        if (selected) {
            const raw = rows[selected.rowIdx]?.[selected.key];
            setFormulaDraft(String(raw ?? ''));
            return;
        }
        if (selectedColumnKey) {
            const raw = rows[0]?.[selectedColumnKey];
            setFormulaDraft(String(raw ?? ''));
        }
    }, [selected, selectedColumnKey, selected?.rowIdx, selected?.key, rows]);

    const commitFormulaBar = useCallback(() => {
        if (selected) {
            const { rowIdx, key } = selected;
            const next = rows.map((r, i) => (i === rowIdx ? { ...r, [key]: formulaDraft } : r));
            applyRawRows(next);
            return;
        }
        if (selectedColumnKey) {
            const next = rows.map((r, i) => (i === 0 ? { ...r, [selectedColumnKey]: formulaDraft } : r));
            applyRawRows(next);
        }
    }, [selected, selectedColumnKey, formulaDraft, rows, applyRawRows]);

    const formulaAddress = useMemo(() => {
        if (selected) return cellAddressLabel(selected.rowIdx, selected.colIdx);
        if (selectedColumnKey) {
            const ci = fields.indexOf(selectedColumnKey);
            if (ci < 0) return '—';
            const L = columnIndexToLetter(ci);
            if (rows.length <= 0) return `${L}:${L}`;
            return `${L}1:${L}${rows.length}`;
        }
        return '—';
    }, [selected, selectedColumnKey, fields, rows.length]);

    const pickColumnForChart = useCallback(
        (fieldKey, e) => {
            if (chartKind === 'histogram') {
                setChartYField(fieldKey);
                return;
            }
            if (e.shiftKey) {
                setChartXField(fieldKey);
            } else {
                setChartYField(fieldKey);
            }
        },
        [chartKind]
    );

    /** Scatter: avoid X and Y mapping to the same column; drop stale column names if fields change. */
    useEffect(() => {
        if (chartKind !== 'scatter' || fields.length === 0) return;
        let x =
            chartXField === '__index' || chartXField === '' || !fields.includes(chartXField)
                ? '__index'
                : chartXField;
        const y = chartYField && fields.includes(chartYField) ? chartYField : null;
        if (y && x !== '__index' && x === y) {
            x = fields.find((f) => f !== y) ?? '__index';
        }
        if (x !== chartXField) setChartXField(x);
        if (chartYField && !fields.includes(chartYField)) setChartYField('');
    }, [chartKind, fields, chartYField, chartXField]);

    const scrollGridToFirstDataColumn = useCallback(() => {
        /* rowIdx omitted so horizontal scroll works even with 0 data rows */
        dataGridRef.current?.scrollToCell?.({ idx: 1 });
    }, []);

    const scrollGridToLastColumn = useCallback(() => {
        if (!fields.length) return;
        dataGridRef.current?.scrollToCell?.({ idx: fields.length });
    }, [fields.length]);

    const toggleChartPanelOpen = useCallback(() => {
        setChartOpen((prev) => {
            if (prev) setChartMaximized(false);
            return !prev;
        });
    }, []);

    const toggleChartMaximized = useCallback(() => {
        setChartMaximized((prev) => {
            if (!prev) setChartOpen(true);
            return !prev;
        });
    }, []);

    const handleChartKindChange = useCallback((k) => {
        setChartKind(k);
        if (k === 'histogram') {
            setChartXRanges([]);
            setChartYRanges([]);
        }
    }, []);

    const columns = useMemo(() => {
        const letterHint = (colIdx, fieldKey) =>
            chartKind === 'histogram'
                ? `${columnIndexToLetter(colIdx)} — ${fieldKey} (click: chart Y)`
                : `${columnIndexToLetter(colIdx)} — ${fieldKey} (click: chart Y, Shift+click: chart X)`;

        const frozenColGroup = {
            name: <span className="sheet-corner-letter-tier" aria-hidden />,
            headerCellClass: 'sheet-header-group-letter sheet-header-group-corner',
            children: [
                {
                    key: ROW_NUM_KEY,
                    name: '',
                    width: 48,
                    minWidth: 48,
                    maxWidth: 52,
                    frozen: true,
                    resizable: false,
                    sortable: false,
                    draggable: false,
                    editable: false,
                    headerCellClass: 'sheet-header-name-cell sheet-header-frozen-name',
                    renderHeaderCell: () => <div className="sheet-corner-cell-tier2" />,
                    renderCell: ({ row }) => <div className="sheet-row-num">{row[ROW_NUM_KEY]}</div>,
                },
            ],
        };

        const dataColGroups = fields.map((fieldKey, colIdx) => ({
            name: (
                <span
                    className="sheet-col-letter-tier1"
                    title={letterHint(colIdx, fieldKey)}
                    onClick={(e) => pickColumnForChart(fieldKey, e)}
                >
                    {columnIndexToLetter(colIdx)}
                </span>
            ),
            headerCellClass: 'sheet-header-group-letter',
            children: [
                {
                    key: fieldKey,
                    name: fieldKey,
                    width: Math.min(200, 92 + fieldKey.length * 7),
                    minWidth: 72,
                    resizable: true,
                    editable: true,
                    renderEditCell: textEditor,
                    sortable: false,
                    draggable: false,
                    cellClass: (_row, rowIdx) => {
                        const cl = [];
                        if (sheetRangeSelection && cellInRect(fieldKey, rowIdx, sheetRangeSelection)) {
                            cl.push('sheet-range-sel');
                            const rMin = Math.min(sheetRangeSelection.r0, sheetRangeSelection.r1);
                            const rMax = Math.max(sheetRangeSelection.r0, sheetRangeSelection.r1);
                            if (rowIdx === rMin) cl.push('sheet-range-top');
                            if (rowIdx === rMax) cl.push('sheet-range-bottom');
                            if (fieldKey === sheetRangeSelection.cols[0]) cl.push('sheet-range-left');
                            if (fieldKey === sheetRangeSelection.cols[sheetRangeSelection.cols.length - 1]) cl.push('sheet-range-right');
                        }
                        if (chartXRanges.some((r) => cellInRect(fieldKey, rowIdx, r))) {
                            cl.push('sheet-range-chart-x');
                        }
                        if (chartYRanges.some((r) => cellInRect(fieldKey, rowIdx, r))) {
                            cl.push('sheet-range-chart-y');
                        }
                        return cl.length ? cl.join(' ') : undefined;
                    },
                    headerCellClass: 'sheet-header-name-cell',
                    renderHeaderCell: () => {
                        const ySel = chartYField === fieldKey;
                        const xSel = chartKind !== 'histogram' && chartXField === fieldKey;
                        const titleHint =
                            chartKind === 'histogram'
                                ? `${fieldKey} — click to set Y`
                                : `${fieldKey} — click: Y, Shift+click: X`;
                        return (
                            <button
                                type="button"
                                className={[
                                    'sheet-col-header-tier2',
                                    'sheet-col-head-btn',
                                    ySel ? 'sheet-col-header--y' : '',
                                    xSel ? 'sheet-col-header--x' : '',
                                ]
                                    .filter(Boolean)
                                    .join(' ')}
                                title={titleHint}
                                aria-label={titleHint}
                                onClick={(e) => pickColumnForChart(fieldKey, e)}
                            >
                                <span className="sheet-col-title" title={fieldKey}>
                                    {fieldKey}
                                </span>
                            </button>
                        );
                    },
                    renderCell: ({ rowIdx, column }) => {
                        const c = fields.indexOf(column.key);
                        if (c < 0) return <div className="sheet-cell-inner" />;
                        const colHighlight = selectedColumnKey === column.key;
                        const hf = hfRef.current;
                        let inner;
                        if (!hf) {
                            inner = (
                                <div className={`sheet-cell-inner${colHighlight ? ' sheet-cell-col-selected' : ''}`}>
                                    —
                                </div>
                            );
                        } else {
                            try {
                                const v = hf.getCellValue({ sheet: 0, row: rowIdx, col: c });
                                inner = (
                                    <div className={`sheet-cell-inner${colHighlight ? ' sheet-cell-col-selected' : ''}`}>
                                        {formatHFCellValue(v)}
                                    </div>
                                );
                            } catch {
                                inner = (
                                    <div className={`sheet-cell-inner${colHighlight ? ' sheet-cell-col-selected' : ''}`}>
                                        #ERR
                                    </div>
                                );
                            }
                        }
                return (
                            <div
                                className="sheet-cell-surface"
                                data-sheet-cell
                                data-sheet-col={fieldKey}
                                data-sheet-row={String(rowIdx)}
                                onPointerDown={(e) => onRangePointerDown(e, rowIdx, fieldKey)}
                                onMouseEnter={(e) => onRangeMouseEnterWhileDown(e, rowIdx, fieldKey)}
                                onClick={(e) => onRangeClick(e, rowIdx, fieldKey)}
                            >
                                {inner}
                                {sheetRangeSelection && cellInRect(fieldKey, rowIdx, sheetRangeSelection) && (
                                    <>
                                        {rowIdx === Math.max(sheetRangeSelection.r0, sheetRangeSelection.r1) && fieldKey === sheetRangeSelection.cols[sheetRangeSelection.cols.length - 1] && (
                                            <div className="sheet-range-handle"></div>
                                        )}
                                    </>
                                )}
                            </div>
                        );
                    },
                },
            ],
        }));

        return [frozenColGroup, ...dataColGroups];
    }, [
        fields,
        hfEpoch,
        chartKind,
        chartXField,
        chartYField,
        pickColumnForChart,
        selectedColumnKey,
        sheetRangeSelection,
        chartXRanges,
        chartYRanges,
        onRangePointerDown,
        onRangeMouseEnterWhileDown,
        onRangeClick,
    ]);

    const handleSave = async () => {
        if (!fileId || !fields.length) return;
        let hf = hfRef.current;
        if (!hf && rows.length) {
            try {
                hf = rebuildHyperFormula(fields, rows);
                hfRef.current = hf;
                setHfEpoch((n) => n + 1);
            } catch {
                setSaveError('Could not compute formulas for save.');
                return;
            }
        }
        if (!hf) return;
        setSaveError(null);
        setSaving(true);
        try {
            const computed = exportComputedRows(hf, fields, rows.length);
            await onSave({ fileId, rows: computed, columns: fields });
            baselineRef.current = stablePayloadJson(fields, rows);
        } catch (e) {
            setSaveError(e?.message || 'Save failed.');
        } finally {
            setSaving(false);
        }
    };

    const shortName = fileBasename(fileLabel);

    const onFormulaKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commitFormulaBar();
        }
    };

    return (
        <div className="spreadsheet-page spreadsheet-page--gs">
            <div className="sheet-topbar">
                <div className="sheet-topbar-strip" />
                <div className="sheet-topbar-inner">
                    <button type="button" className="sheet-btn-back" onClick={onClose} title="Back to dashboard">
                        <ArrowLeft size={18} />
                        <span>Back</span>
                    </button>
                    <div className="sheet-doc-chip">
                        <span className="sheet-doc-icon">📊</span>
                        <div className="sheet-doc-text">
                            <span className="sheet-doc-name">{shortName || 'Spreadsheet'}</span>
                            <span className="sheet-doc-meta">
                                {rows.length.toLocaleString()} rows · {fields.length} cols
                                {dirty ? ' · Unsaved' : ' · Saved'}
                            </span>
                        </div>
                    </div>
                    <div className="sheet-topbar-actions">
                        <button
                            type="button"
                            className="sheet-btn-scroll-cols"
                            onClick={scrollGridToFirstDataColumn}
                            disabled={!fields.length || !!loadError || loading}
                            title="Scroll grid to first data column (after row numbers)"
                        >
                            <ChevronsLeft size={16} />
                            <span>First col</span>
                        </button>
                        <button
                            type="button"
                            className="sheet-btn-scroll-cols"
                            onClick={scrollGridToLastColumn}
                            disabled={!fields.length || !!loadError || loading}
                            title="Scroll grid to last column"
                        >
                            <span>Last col</span>
                            <ChevronsRight size={16} />
                        </button>
                        <div className="sheet-range-actions" role="group" aria-label="Chart from cell selection">
                            <button
                                type="button"
                                className="sheet-btn-range"
                                onClick={replaceChartXFromSelection}
                                disabled={!sheetRangeSelection || !fields.length || loading}
                                title="Use highlighted cells as chart X (replaces previous X cell areas)"
                            >
                                Set X
                            </button>
                            <button
                                type="button"
                                className="sheet-btn-range"
                                onClick={appendChartXFromSelection}
                                disabled={!sheetRangeSelection || !fields.length || loading}
                                title="Append highlighted cells to chart X (multiple areas are concatenated)"
                            >
                                + X
                            </button>
                            <button
                                type="button"
                                className="sheet-btn-range"
                                onClick={replaceChartYFromSelection}
                                disabled={!sheetRangeSelection || !fields.length || loading}
                                title="Use highlighted cells as chart Y (replaces previous Y cell areas)"
                            >
                                Set Y
                            </button>
                            <button
                                type="button"
                                className="sheet-btn-range"
                                onClick={plotXYFromSelection}
                                disabled={!sheetRangeSelection || sheetRangeSelection.cols.length < 2 || loading}
                                title="Plot Selection as XY (first col X, second col Y)"
                                style={{ backgroundColor: '#e8f0fe', borderColor: '#aecbfa', color: '#1a73e8' }}
                            >
                                Plot XY
                            </button>
                            <button
                                type="button"
                                className="sheet-btn-range"
                                onClick={appendChartYFromSelection}
                                disabled={!sheetRangeSelection || !fields.length || loading}
                                title="Append highlighted cells to chart Y"
                            >
                                + Y
                            </button>
                            <button
                                type="button"
                                className="sheet-btn-range sheet-btn-range--clear"
                                onClick={clearChartCellRanges}
                                disabled={(!chartXRanges.length && !chartYRanges.length) || loading}
                                title="Clear chart X/Y cell areas and use column dropdowns only"
                            >
                                Clear ranges
                            </button>
                        </div>
                        <button
                            type="button"
                            className={`sheet-btn-chart-toggle ${chartOpen ? 'on' : ''}`}
                            onClick={toggleChartPanelOpen}
                            title={
                                chartOpen
                                    ? 'Hide chart panel (right side)'
                                    : 'Show chart panel on the right'
                            }
                        >
                            Chart
                        </button>
                        <button
                            type="button"
                            className={`sheet-btn-chart-maximize ${chartMaximized ? 'on' : ''}`}
                            onClick={toggleChartMaximized}
                            disabled={!fields.length || !!loadError || loading || !chartOpen}
                            title={
                                chartMaximized
                                    ? 'Show spreadsheet grid again (chart stays open)'
                                    : 'Maximize chart — hide grid so the plot fills the sheet area'
                            }
                        >
                            {chartMaximized ? <Table2 size={16} /> : <Maximize2 size={16} />}
                            <span>{chartMaximized ? 'Show sheet' : 'Max plot'}</span>
                        </button>
                        <button
                            type="button"
                            className="sheet-btn-save"
                            onClick={handleSave}
                            disabled={saving || loading || !!loadError || !dirty || !fields.length}
                        >
                            <Save size={16} />
                            {saving ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                </div>
            </div>

            <div className="sheet-formula-bar">
                <div className="sheet-fx">
                    <Sigma size={16} strokeWidth={2.2} />
                </div>
                <div className="sheet-f-addr">{formulaAddress || '—'}</div>
                <input
                    type="text"
                    className="sheet-f-input"
                    value={formulaDraft}
                    onChange={(e) => setFormulaDraft(e.target.value)}
                    onBlur={commitFormulaBar}
                    onKeyDown={onFormulaKeyDown}
                    placeholder="Value or formula (e.g. =SUM(A1:A10), =A1+B1)"
                    spellCheck={false}
                    disabled={!selected && !selectedColumnKey}
                    aria-label="Formula bar"
                />
            </div>

            {loadError ? <div className="sheet-banner sheet-banner--error">{loadError}</div> : null}
            {saveError ? <div className="sheet-banner sheet-banner--error">{saveError}</div> : null}
            {!loadError && !loading && rows.length > 20000 ? (
                <div className="sheet-banner sheet-banner--warn">
                    Large sheet — each edit recalculates formulas; very heavy sheets may feel slower.
                </div>
            ) : null}

            {loading ? (
                <div className="sheet-banner">Loading…</div>
            ) : !loadError && fields.length === 0 ? (
                <div className="sheet-banner">No columns found (empty CSV?).</div>
            ) : !loadError ? (
                <div className="sheet-workspace">
                    <div
                        className={[
                            'sheet-grid-panel',
                            chartOpen ? 'sheet-grid-panel--chart-open' : 'sheet-grid-panel--chart-collapsed',
                            chartMaximized && chartOpen ? 'sheet-grid-panel--chart-maximized' : '',
                        ]
                            .filter(Boolean)
                            .join(' ')}
                    >
                        <div className="sheet-grid-wrap">
                            <DataGrid
                                ref={dataGridRef}
                                className="rdg-light sheet-rdg"
                                columns={columns}
                                rows={displayRows}
                                rowKeyGetter={(row) => row[RID_KEY]}
                                onRowsChange={onRowsChange}
                                onSelectedCellChange={onSelectedCellChange}
                                onScroll={onDataGridScrollDuringRangeDrag}
                                headerRowHeight={HEADER_ROW_HEIGHT}
                                style={{ height: '100%', width: '100%', minWidth: 0, maxWidth: '100%' }}
                                defaultColumnOptions={{ minWidth: 64, resizable: true }}
                            />
                        </div>
                        <SpreadsheetChartPanel
                            fields={fields}
                            computedRows={computedRowsForChart}
                            rangeChartPoints={rangeChartPoints}
                            rangeChartSummary={rangeChartSummary}
                            open={chartOpen}
                            maximized={chartMaximized}
                            onToggle={toggleChartPanelOpen}
                            chartKind={chartKind}
                            xField={chartXField}
                            yField={chartYField}
                            onChartKindChange={handleChartKindChange}
                            onXFieldChange={setChartXField}
                            onYFieldChange={setChartYField}
                            xAxisMin={chartXMin}
                            xAxisMax={chartXMax}
                            yAxisMin={chartYMin}
                            yAxisMax={chartYMax}
                            onXAxisMinChange={setChartXMin}
                            onXAxisMaxChange={setChartXMax}
                            onYAxisMinChange={setChartYMin}
                            onYAxisMaxChange={setChartYMax}
                        />
                    </div>
                </div>
            ) : null}
        </div>
    );
}
