import { DetailedCellError, HyperFormula } from 'hyperformula';

/** GPL v3 license key for open-source use — see https://hyperformula.handsontable.com/ */
export const HF_LICENSE = { licenseKey: 'gpl-v3' };

export function columnIndexToLetter(index) {
    let s = '';
    let n = index;
    while (n >= 0) {
        s = String.fromCharCode((n % 26) + 65) + s;
        n = Math.floor(n / 26) - 1;
    }
    return s || 'A';
}

export function cellAddressLabel(rowIdx, colIdx) {
    return `${columnIndexToLetter(colIdx)}${rowIdx + 1}`;
}

/** Convert stored string / value to HyperFormula cell input */
export function cellToHFInput(raw) {
    if (raw === '' || raw === null || raw === undefined) return null;
    const s = String(raw);
    if (s.startsWith('=')) return s;
    const n = Number(s);
    if (Number.isFinite(n) && s.trim() !== '' && !Number.isNaN(n)) return n;
    return s;
}

export function formatHFCellValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return '#NUM!';
        if (Number.isInteger(v)) return String(v);
        const t = Number(v.toPrecision(12));
        if (Number.isInteger(t)) return String(t);
        return String(t);
    }
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'string') return v;
    if (v instanceof DetailedCellError) return v.value || `#${v.type}!`;
    if (typeof v === 'object' && v !== null && 'type' in v) return `#${v.type}!`;
    return String(v);
}

/** Serialize computed cell for CSV export */
export function exportCellToCsv(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof DetailedCellError) return '';
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return v;
    return String(v);
}

export function buildMatrixFromRawRows(fields, rawRows) {
    return rawRows.map((row) => fields.map((f) => cellToHFInput(row[f])));
}

export function rebuildHyperFormula(fields, rawRows) {
    const matrix = buildMatrixFromRawRows(fields, rawRows);
    return HyperFormula.buildFromArray(matrix, HF_LICENSE);
}

export function exportComputedRows(hf, fields, rowCount) {
    const out = [];
    for (let r = 0; r < rowCount; r++) {
        const o = {};
        for (let c = 0; c < fields.length; c++) {
            const v = hf.getCellValue({ sheet: 0, row: r, col: c });
            o[fields[c]] = exportCellToCsv(v);
        }
        out.push(o);
    }
    return out;
}
