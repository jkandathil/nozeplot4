import { shouldRemoveRecoveryBlock } from './recoveryEventFilter.js';
import {
    findPlotEventColumn,
    FENO_MEASUREMENT_BLOCK_SUBSTRINGS,
    isUnknownOrCleaningPhaseNorm,
} from './normalizePlotRowFilter.js';

/**
 * Default trim flags aligned with Multi AU / Folder comparison when checkboxes match.
 */
export const FENOSE_AROMA_TRIM_DEFAULTS = {
    removeRecoveryEvents: true,
    fenoTruncateSeconds: 0,
    filterUnknown: true,
};

/**
 * Same row filtering as {@link processAromaBatchCore} §1.5 (ALAAC truncation), without moving average
 * or normalization. Used so synthetic phase lengths match vertical reference lines on batch plots.
 *
 * @param {object[]} fileData
 * @param {{ removeRecoveryEvents?: boolean, fenoTruncateSeconds?: number, filterUnknown?: boolean }} [options]
 * @returns {object[]} trimmed rows (new array; does not mutate input)
 */
export function trimFeNOseRowsForAromaPlot(fileData, options = {}) {
    if (!Array.isArray(fileData) || fileData.length === 0 || !fileData[0]) {
        return fileData ? [...fileData] : [];
    }

    const removeRecoveryEvents = Boolean(options.removeRecoveryEvents);
    const fenoTruncateSeconds = Math.max(0, Number(options.fenoTruncateSeconds) || 0);
    const filterUnknown = Boolean(options.filterUnknown);

    if (!removeRecoveryEvents && fenoTruncateSeconds <= 0 && !filterUnknown) {
        return fileData.map((r) => ({ ...r }));
    }

    let out = fileData.map((r) => ({ ...r }));
    const sampleKeys = Object.keys(out[0]);
    const eventCol =
        findPlotEventColumn(out[0]) ||
        sampleKeys.find((col) => {
            const l = col.toLowerCase();
            return (
                l === 'event_name' ||
                l === 'phase' ||
                l === 'mode' ||
                l === 'state' ||
                (l.includes('event') && !l.includes('reference'))
            );
        });
    if (!eventCol) return out;

    const blocks = [];
    let currentBlock = null;
    out.forEach((r, idx) => {
        const ev = String(r[eventCol] || '').toLowerCase().replace(/\s+/g, '');
        if (currentBlock && currentBlock.event === ev) {
            currentBlock.endIdx = idx;
            currentBlock.endRow = r;
        } else {
            if (currentBlock) blocks.push(currentBlock);
            currentBlock = { event: ev, startIdx: idx, endIdx: idx, startRow: r, endRow: r };
        }
    });
    if (currentBlock) blocks.push(currentBlock);

    const rowsToRemove = new Set();
    const allowedPlots = FENO_MEASUREMENT_BLOCK_SUBSTRINGS;
    const hasBreathEvents = blocks.some((b) => allowedPlots.some((p) => b.event.includes(p)));

    blocks.forEach((b) => {
        if (hasBreathEvents) {
            const isAllowedPLOT = allowedPlots.some((p) => b.event.includes(p));
            if (!isAllowedPLOT && b.event !== '') {
                for (let i = b.startIdx; i <= b.endIdx; i++) rowsToRemove.add(i);
            } else if (
                fenoTruncateSeconds > 0 &&
                (b.event.includes('feno') || b.event.includes('breath'))
            ) {
                const allowedRows = fenoTruncateSeconds * 3;
                for (let i = b.startIdx + allowedRows; i <= b.endIdx; i++) rowsToRemove.add(i);
            }
        } else {
            if (removeRecoveryEvents && shouldRemoveRecoveryBlock(b.event)) {
                for (let i = b.startIdx; i <= b.endIdx; i++) rowsToRemove.add(i);
            }
            if (filterUnknown && isUnknownOrCleaningPhaseNorm(b.event)) {
                for (let i = b.startIdx; i <= b.endIdx; i++) rowsToRemove.add(i);
            }
            if (
                fenoTruncateSeconds > 0 &&
                (b.event.includes('feno') || b.event.includes('breath'))
            ) {
                const allowedRows = fenoTruncateSeconds * 3;
                for (let i = b.startIdx + allowedRows; i <= b.endIdx; i++) rowsToRemove.add(i);
            }
        }
    });

    return out.filter((_, idx) => !rowsToRemove.has(idx));
}

function _normEventName(name) {
    return String(name ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');
}

function _classifyPreFenoBlock(raw) {
    if (raw.includes('fenomeasurement') || raw.includes('fenowindow')) return null;
    if (raw === 'ambientsamplingrfc' || (raw.includes('ambient') && raw.includes('rfc'))) return 'rfc';
    if (raw.includes('ambientsampling')) return 'rfc';
    if (raw.includes('breathsamplecollection')) return 'bsc';
    return 'bsc';
}

/** Row-level match — tolerant of spacing/casing; avoids missing runs when contiguous-event parsing differs. */
function _isFeNOMeasurementNorm(raw) {
    if (!raw) return false;
    if (raw.includes('fenowindow')) return false;
    if (raw.includes('fenomeasurement')) return true;
    return raw.includes('feno') && raw.includes('measurement');
}

function _isFeNOWindowNorm(raw) {
    if (!raw) return false;
    if (raw.includes('fenomeasurement')) return false;
    if (raw.includes('fenowindow')) return true;
    return raw.includes('feno') && raw.includes('window');
}

function _cellEventNorm(row, evCol) {
    const v = row?.[evCol];
    return _normEventName(typeof v === 'string' ? v : v != null ? String(v) : '');
}

/**
 * Phase layout in **trimmed** row indices (matches Multi AU reference lines).
 *
 * @returns {{
 *   nAmbient: number,
 *   nBsc: number,
 *   feNoStart: number,
 *   windowStart: number,
 *   nFeno: number,
 *   nWindow: number,
 *   windowBeforeMeasurement?: boolean
 * } | null}
 */
export function getFeNOseAromaTrimPhaseLayout(fileData, options = {}) {
    if (!Array.isArray(fileData) || fileData.length < 5 || !fileData[0]) return null;

    const trimmed = trimFeNOseRowsForAromaPlot(fileData, options);
    if (!trimmed.length) return null;

    const sampleKeys = Object.keys(trimmed[0]);
    const evCol =
        findPlotEventColumn(trimmed[0]) ||
        sampleKeys.find((col) => {
            const l = col.toLowerCase();
            return (
                l === 'event_name' ||
                l === 'phase' ||
                l === 'mode' ||
                l === 'state' ||
                (l.includes('event') && !l.includes('reference'))
            );
        });
    if (!evCol) return null;

    let firstM = null;
    let firstW = null;
    for (let i = 0; i < trimmed.length; i++) {
        const raw = _cellEventNorm(trimmed[i], evCol);
        if (firstM === null && _isFeNOMeasurementNorm(raw)) firstM = i;
        if (firstW === null && _isFeNOWindowNorm(raw)) firstW = i;
    }

    if (firstM === null || firstW === null) return null;

    const windowBeforeMeasurement = firstW < firstM;
    let feNoStart;
    let windowStart;
    let nFenoBlock;
    let nWindowBlock;

    if (!windowBeforeMeasurement) {
        /* Alternate: FeNOMeasurement → FeNOWindow */
        feNoStart = firstM;
        windowStart = firstW;
        nFenoBlock = firstW - firstM;
        if (nFenoBlock < 3) return null;
        nWindowBlock = 0;
        for (let i = windowStart; i < trimmed.length; i++) {
            const raw = _cellEventNorm(trimmed[i], evCol);
            if (!_isFeNOWindowNorm(raw)) break;
            nWindowBlock++;
        }
    } else {
        /* Real captures: FeNOWindow → FeNOMeasurement */
        windowStart = firstW;
        feNoStart = firstM;
        nWindowBlock = firstM - firstW;
        if (nWindowBlock < 1) return null;
        nFenoBlock = 0;
        for (let i = feNoStart; i < trimmed.length; i++) {
            const raw = _cellEventNorm(trimmed[i], evCol);
            if (!_isFeNOMeasurementNorm(raw)) break;
            nFenoBlock++;
        }
        if (nFenoBlock < 3) return null;
    }

    if (nWindowBlock < 1) return null;

    const prefixEnd = Math.min(firstM, firstW);
    let nAmbient = 0;
    let nBsc = 0;
    for (let i = 0; i < prefixEnd; i++) {
        const raw = _cellEventNorm(trimmed[i], evCol);
        const role = _classifyPreFenoBlock(raw);
        if (role === 'rfc') nAmbient++;
        else if (role === 'bsc') nBsc++;
        else nBsc++;
    }

    return {
        nAmbient,
        nBsc,
        feNoStart,
        windowStart,
        nFeno: nFenoBlock,
        nWindow: nWindowBlock,
        windowBeforeMeasurement,
    };
}
