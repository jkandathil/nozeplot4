import { formatHFCellValue } from './spreadsheetHyperformula';

/** @typedef {{ cols: string[]; r0: number; r1: number }} SheetRect */

export function toNumberLike(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v === null || v === undefined) return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

export function hfCellNumeric(hf, row, colIdx) {
    try {
        const v = hf.getCellValue({ sheet: 0, row, col: colIdx });
        return toNumberLike(formatHFCellValue(v));
    } catch {
        return null;
    }
}

/**
 * Normalize two corner cells into a rectangle (inclusive row indices, contiguous cols in field order).
 * @param {string} colKeyA
 * @param {number} rowA
 * @param {string} colKeyB
 * @param {number} rowB
 * @param {string[]} fields
 * @returns {SheetRect | null}
 */
export function normalizeSheetRect(colKeyA, rowA, colKeyB, rowB, fields) {
    const i0 = fields.indexOf(colKeyA);
    const i1 = fields.indexOf(colKeyB);
    if (i0 < 0 || i1 < 0) return null;
    const ciLo = Math.min(i0, i1);
    const ciHi = Math.max(i0, i1);
    const rLo = Math.min(rowA, rowB);
    const rHi = Math.max(rowA, rowB);
    return {
        cols: fields.slice(ciLo, ciHi + 1),
        r0: rLo,
        r1: rHi,
    };
}

export function cellInRect(colKey, rowIdx, rect) {
    if (!rect?.cols?.length) return false;
    const lo = Math.min(rect.r0, rect.r1);
    const hi = Math.max(rect.r0, rect.r1);
    return rect.cols.includes(colKey) && rowIdx >= lo && rowIdx <= hi;
}

/**
 * Row-major flatten: for each row from r0..r1, left-to-right through cols.
 * @param {*} hf HyperFormula instance
 * @param {string[]} fields
 * @param {number} rowCount
 * @param {SheetRect} rect
 * @returns {number[]}
 */
export function numbersFromRect(hf, fields, rowCount, rect) {
    return extractAxisFromRects(hf, fields, rowCount, [rect]).values;
}

/**
 * Row-major values plus the sheet row index for each value (for pairing with another column).
 */
export function extractAxisFromRects(hf, fields, rowCount, rects) {
    const values = [];
    const rows = [];
    for (const rect of rects || []) {
        if (!rect?.cols?.length) continue;
        const lo = Math.min(rect.r0, rect.r1);
        const hi = Math.max(rect.r0, rect.r1);
        const cols = [...rect.cols].sort((a, b) => fields.indexOf(a) - fields.indexOf(b));
        for (let r = lo; r <= hi; r++) {
            if (r < 0 || r >= rowCount) continue;
            for (const colKey of cols) {
                const c = fields.indexOf(colKey);
                if (c < 0) continue;
                values.push(hfCellNumeric(hf, r, c));
                rows.push(r);
            }
        }
    }
    return { values, rows };
}

/**
 * Concatenate row-major values from several rectangles (e.g. multiple X groups).
 * @param {*} hf HyperFormula instance
 * @param {string[]} fields
 * @param {number} rowCount
 * @param {SheetRect[]} rects
 */
export function numbersFromRects(hf, fields, rowCount, rects) {
    return extractAxisFromRects(hf, fields, rowCount, rects).values;
}

/**
 * Pair X and Y number arrays into chart points (min length).
 * @param {number[]} xs
 * @param {number[]} ys
 */
export function pairScatterPoints(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    const pts = [];
    for (let i = 0; i < n; i++) {
        const x = xs[i];
        const y = ys[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        pts.push({
            x,
            y,
            label: String(i + 1),
        });
    }
    return pts;
}

/**
 * Pair X/Y by sheet row when both axes come from cell rects (handles multiple disjoint ranges).
 * Falls back to {@link pairScatterPoints} if row metadata is missing or mismatched length.
 * @param {number[]} xs
 * @param {number[]} xRows
 * @param {number[]} ys
 * @param {number[]} yRows
 */
export function pairScatterPointsByRow(xs, xRows, ys, yRows) {
    if (
        !Array.isArray(xs) ||
        !Array.isArray(ys) ||
        !Array.isArray(xRows) ||
        !Array.isArray(yRows) ||
        xRows.length !== xs.length ||
        yRows.length !== ys.length
    ) {
        return pairScatterPoints(xs, ys);
    }
    const xByRow = new Map();
    for (let i = 0; i < xs.length; i++) {
        const x = xs[i];
        if (!Number.isFinite(x)) continue;
        xByRow.set(xRows[i], x);
    }
    const yByRow = new Map();
    for (let i = 0; i < ys.length; i++) {
        const y = ys[i];
        if (!Number.isFinite(y)) continue;
        yByRow.set(yRows[i], y);
    }
    const rows = [...new Set([...xByRow.keys()].filter((r) => yByRow.has(r)))].sort((a, b) => a - b);
    const pts = [];
    for (const r of rows) {
        const x = xByRow.get(r);
        const y = yByRow.get(r);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        pts.push({ x, y, label: String(r + 1) });
    }
    return pts;
}
