/**
 * Workspace / plot filtering by filename and optional in-file concentration columns.
 */
import { lookupConcentrationMetaFromCatalogPath } from './concentrationCatalog.js';

export function fileBasename(fileName) {
    if (!fileName) return '';
    return String(fileName).split(/[/\\]/).pop() || '';
}

export function hasConcentrationInFilename(fileName) {
    return /(\d+(?:\.\d+)?)\s*(ppb|ppm)\b/i.test(fileBasename(fileName));
}

/**
 * Raw time-series CSVs from device/folder pipelines, e.g. 0000000063-0926-asu-nz.csv
 */
export function isRawDeviceTimeSeriesName(fileName) {
    return /-(asu|mfc|val|flw|oms)-nz\.csv$/i.test(fileBasename(fileName));
}

export function rawDeviceRoleFromFilename(fileName) {
    const m = fileBasename(fileName).match(/-(asu|mfc|val|flw|oms)-nz\.csv$/i);
    return m ? m[1].toUpperCase() : null;
}

/** Serial capture from AU page: siac32v2_<sn>_<stamp>.csv */
export function isSiacSerialCaptureFileName(fileName) {
    const b = fileBasename(fileName);
    return /^siac32v2_.+\.csv$/i.test(b);
}

/** Heuristic: flattened SiAC JSON rows (CHR*, RRF*, sn, timestamp). */
export function looksLikeSiacCaptureData(data) {
    if (!Array.isArray(data) || data.length === 0) return false;
    const row = data[0];
    if (!row || typeof row !== 'object') return false;
    const keys = Object.keys(row);
    const hasChr = keys.some((k) => /^chr\d+$/i.test(k));
    const hasRrf = keys.some((k) => /^rrf\d+$/i.test(k));
    return hasChr || hasRrf;
}

/**
 * Approximate byte size for sidebar when file has IndexedDB `data` but no `File` blob.
 */
export function estimateWorkspaceFileBytes(file) {
    if (!file || file.isFolder) return 0;
    if (file.file && typeof file.file.size === 'number') return file.file.size;
    if (typeof file.size === 'number' && file.size > 0) return file.size;
    if (Array.isArray(file.data) && file.data.length > 0) {
        try {
            const n = Math.min(file.data.length, 30);
            const bytes = new Blob([JSON.stringify(file.data.slice(0, n))]).length;
            return Math.max(1, Math.round((bytes / n) * file.data.length));
        } catch {
            return 0;
        }
    }
    return 0;
}

/**
 * Passes "No Unknowns" / filterUnknown when the name has a concentration unit OR a known raw CSV pattern.
 */
export function isKnownPlotFileName(fileName) {
    return (
        hasConcentrationInFilename(fileName) ||
        isRawDeviceTimeSeriesName(fileName) ||
        isSiacSerialCaptureFileName(fileName)
    );
}

/* ── Concentration from CSV columns (first row sample) ───────────────── */

function columnLooksLikeConcentration(key) {
    const k = String(key).toLowerCase().trim();
    if (k === 'concentration' || k === 'target_conc' || k === 'targetconc' || k === 'gas_conc' || k === 'nominal_conc') return true;
    if (/^(target|nominal|gas|cal|challenge|spike|dose)_(ppb|ppm|conc)/.test(k)) return true;
    if (/(target|nominal|gas|cal|challenge).*(ppb|ppm)/.test(k) && (k.includes('conc') || k.includes('level') || k.includes('target'))) return true;
    if ((k.includes('concentration') || k.includes('conc_level')) && (k.includes('ppb') || k.includes('ppm'))) return true;
    if (/^conc_(ppb|ppm)/.test(k) || /_(ppb|ppm)_conc$/.test(k)) return true;
    return false;
}

function inferUnitFromColumnKey(colKey) {
    const k = String(colKey).toLowerCase();
    if (k.includes('ppm') && !k.includes('ppb')) return 'ppm';
    if (k.includes('ppb')) return 'ppb';
    return null;
}

function parseConcCell(val, colKey) {
    const k = String(colKey).toLowerCase();
    const unitHint = inferUnitFromColumnKey(colKey);

    if (val == null || val === '') return null;
    if (typeof val === 'string') {
        const t = val.trim();
        const m = t.match(/^(\d+(?:\.\d+)?)\s*(ppb|ppm)\b/i);
        if (m) return { numeric: parseFloat(m[1]), unit: m[2].toLowerCase() };
        const n = parseFloat(t.replace(/,/g, ''));
        if (!Number.isFinite(n)) return null;
        if (unitHint) return { numeric: n, unit: unitHint };
        if (k === 'concentration' || k === 'target_conc' || k === 'targetconc' || k === 'gas_conc' || k === 'nominal_conc') {
            return { numeric: n, unit: 'ppb' };
        }
        return null;
    }
    if (typeof val === 'number' && Number.isFinite(val)) {
        if (unitHint) return { numeric: val, unit: unitHint };
        if (k === 'concentration' || k === 'target_conc' || k === 'targetconc' || k === 'gas_conc' || k === 'nominal_conc') {
            return { numeric: val, unit: 'ppb' };
        }
        return null;
    }
    return null;
}

/**
 * Reads concentration from the first row using columns whose names look like concentration fields.
 * Returns same shape as parseConcentrationMetaFromFile filename branch, plus optional sourceColumn.
 */
export function getConcentrationMetaFromData(data) {
    if (!Array.isArray(data) || data.length === 0) return null;
    const row = data[0];
    if (!row || typeof row !== 'object') return null;
    const keys = Object.keys(row);
    const candidates = keys.filter(columnLooksLikeConcentration);
    for (const key of candidates) {
        const parsed = parseConcCell(row[key], key);
        if (parsed && parsed.numeric >= 0 && Number.isFinite(parsed.numeric)) {
            const { numeric, unit } = parsed;
            return {
                key: `${numeric}|${unit}`,
                label: `${numeric} ${unit}`,
                numericValue: numeric,
                unit,
                sourceColumn: key,
            };
        }
    }
    return null;
}

/**
 * Filename ppb/ppm first; else first data row concentration column.
 */
export function parseConcentrationMetaFromFile(fileName, data = null) {
    if (fileName) {
        const basename = fileBasename(fileName);
        const m = basename.match(/(\d+(?:\.\d+)?)\s*(ppb|ppm)\b/i);
        if (m) {
            const numericValue = parseFloat(m[1]);
            const unit = m[2].toLowerCase();
            return {
                key: `${numericValue}|${unit}`,
                label: `${numericValue} ${unit}`,
                numericValue,
                unit,
            };
        }
        const fromCatalog = lookupConcentrationMetaFromCatalogPath(fileName);
        if (fromCatalog) return fromCatalog;
    }
    return getConcentrationMetaFromData(data);
}

export function hasConcentrationInData(data) {
    return getConcentrationMetaFromData(data) != null;
}

/** True if relative path (e.g. folder upload) matches bundled concentration catalog. */
export function hasConcentrationInCatalogPath(fileName) {
    return fileName ? lookupConcentrationMetaFromCatalogPath(fileName) != null : false;
}

/**
 * Known for plotting with "No Unknowns": filename rules, or in-file concentration, or raw device CSV name.
 */
export function isKnownPlotFile(fileName, data = null) {
    if (isKnownPlotFileName(fileName)) return true;
    if (hasConcentrationInCatalogPath(fileName)) return true;
    if (data && hasConcentrationInData(data)) return true;
    if (data && looksLikeSiacCaptureData(data)) return true;
    return false;
}
