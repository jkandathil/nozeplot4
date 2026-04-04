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

/** Serial capture from AU page: siac32v2_*; legacy capture_*; AU_ID_YYYY-MM-DD_HHMMSS.csv */
export function isSiacSerialCaptureFileName(fileName) {
    const b = fileBasename(fileName);
    if (/^siac32v2_.+\.csv$/i.test(b)) return true;
    if (/^capture_\d{4}-\d{2}-\d{2}_\d{6}\.csv$/i.test(b)) return true;
    return /^.+_\d{4}-\d{2}-\d{2}_\d{6}\.csv$/i.test(b);
}

/** Heuristic: flattened SiAC32 JSON rows (CHR*, RRF*) or SiAC64 TELEMETRY rows (A1–H8 grid, ASELT, …). */
export function looksLikeSiacCaptureData(data) {
    if (!Array.isArray(data) || data.length === 0) return false;
    const row = data[0];
    if (!row || typeof row !== 'object') return false;
    const keys = Object.keys(row);
    const hasChr = keys.some((k) => /^chr\d+$/i.test(k));
    const hasRrf = keys.some((k) => /^rrf\d+$/i.test(k));
    const hasMuxGrid = keys.some((k) => /^[A-H][1-8]$/i.test(k));
    const hasAsuChrGrid = keys.some((k) => /^chr[a-h][1-8]$/i.test(String(k).replace(/\s/g, '')));
    return hasChr || hasRrf || hasMuxGrid || hasAsuChrGrid;
}

/**
 * Approximate byte size for sidebar when file has IndexedDB `data` but no `File` blob.
 */
export function estimateWorkspaceFileBytes(file) {
    if (!file || file.isFolder) return 0;
    if (file.file && typeof file.file.size === 'number' && file.file.size > 0) return file.file.size;
    if (typeof file.size === 'number' && file.size > 0) return file.size;
    const csvFallback =
        (typeof file.csvText === 'string' && file.csvText.trim().length > 0 && file.csvText) ||
        (typeof file.csvSnapshot === 'string' && file.csvSnapshot.trim().length > 0 && file.csvSnapshot) ||
        null;
    if (csvFallback) {
        try {
            return Math.max(1, new Blob([csvFallback]).size);
        } catch {
            /* fall through */
        }
    }
    if (Array.isArray(file.data) && file.data.length > 0) {
        try {
            const n = Math.min(file.data.length, 30);
            const blob = new Blob([JSON.stringify(file.data.slice(0, n))]);
            const bytes = blob.size;
            if (!Number.isFinite(bytes) || bytes <= 0) return 0;
            return Math.max(1, Math.round((bytes / n) * file.data.length));
        } catch {
            return 0;
        }
    }
    if (file.data != null && typeof file.data === 'object' && !Array.isArray(file.data)) {
        try {
            const blob = new Blob([JSON.stringify(file.data)]);
            const sz = blob.size;
            return Number.isFinite(sz) && sz > 0 ? Math.max(1, sz) : 0;
        } catch {
            return typeof file.size === 'number' && file.size > 0 ? file.size : 0;
        }
    }
    return 0;
}

/** Human-readable size for sidebar / workspace labels (approximate stored data). */
export function formatWorkspaceDataSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 2 : 1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Sum approximate bytes for non-folder workspace entries. */
export function sumWorkspaceDataBytes(fileList) {
    if (!Array.isArray(fileList)) return 0;
    let s = 0;
    for (const f of fileList) {
        if (!f || f.isFolder) continue;
        const b = estimateWorkspaceFileBytes(f);
        if (Number.isFinite(b) && b > 0) s += b;
    }
    return s;
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
