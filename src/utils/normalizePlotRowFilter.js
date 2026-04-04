import {
    normalizeEventValue,
    keepRowWhenStrippingRecovery,
    datasetHasRecoveryOffEvent,
} from './recoveryEventFilter.js';

/** Event / phase / stage column — aligned with Dashboard + Normalize (stage matches FeNO-style exports). */
export function findPlotEventColumn(sampleRow) {
    if (!sampleRow || typeof sampleRow !== 'object') return null;
    const keys = Object.keys(sampleRow);
    const ranked = keys
        .map((col) => {
            const l = col.toLowerCase();
            let score = 0;
            if (
                l === 'event_name' ||
                l === 'phase' ||
                l === 'stage' ||
                l === 'mode' ||
                l === 'state'
            ) {
                score = 100;
            } else if (
                l === 'event' ||
                l === 'events' ||
                l.endsWith('_phase') ||
                l.endsWith('_event') ||
                l.endsWith('_stage')
            ) {
                score = 85;
            } else if (l.includes('event') && !l.includes('reference')) score = 70;
            else if ((l.includes('phase') || l.includes('stage')) && !l.includes('reference')) score = 55;
            return { col, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
    return ranked[0]?.col ?? null;
}

function shouldStripNonMeasurementRow(eNorm) {
    if (!eNorm) return false;
    if (eNorm.includes('unknown')) return true;
    if (
        eNorm.includes('cleaning') ||
        eNorm.includes('systemclean') ||
        eNorm.includes('purge') ||
        eNorm.includes('purging')
    ) {
        return true;
    }
    return false;
}

const MEANINGFUL_SUBSTRINGS = [
    'fenomeasurement',
    'fenowindow',
    'breathsample',
    'breathsamplecollection',
    'ambientsampling',
    'ambient',
    'baseline',
    'reference',
    'measurement',
    'flush',
    'rfc',
    'feno',
];

function rowHasMeaningfulPhase(eNorm) {
    if (!eNorm) return false;
    return MEANINGFUL_SUBSTRINGS.some((h) => eNorm.includes(h));
}

/** True if every non-empty event looks like junk (unknown / cleaning / idle / calibration / recovery only). */
function rowIsJunkOnlyPhase(eNorm) {
    if (!eNorm) return false;
    const junk = ['unknown', 'clean', 'purge', 'idle', 'calibrat', 'recovery'];
    return junk.some((h) => eNorm.includes(h));
}

/**
 * Exclude captures that are only cleaning / unknown / purge style phases (no breath or ambient window).
 * Also catches obvious cleaning-only filenames when the name does not encode a concentration label.
 */
export function isCleaningOnlyOrUnknownPhaseFile(fileName, data) {
    if (!Array.isArray(data) || data.length === 0) return false;
    const bn = String(fileName || '').toLowerCase();
    if (
        /\b(cleaning|clean_only|clean-only|system[_-]?clean)\b/i.test(fileName || '') &&
        !/\d+\s*ppb/.test(bn)
    ) {
        return true;
    }

    const eventCol = findPlotEventColumn(data[0]);
    if (!eventCol) return false;

    let sawNonEmpty = false;
    let sawMeaningful = false;
    let sawNonJunk = false;

    for (const row of data) {
        const e = normalizeEventValue(row, eventCol);
        if (!e) continue;
        sawNonEmpty = true;
        if (rowHasMeaningfulPhase(e)) sawMeaningful = true;
        if (!rowIsJunkOnlyPhase(e)) sawNonJunk = true;
    }

    if (sawMeaningful || !sawNonEmpty) return false;
    return !sawNonJunk;
}

/**
 * Row filter for Normalize / Dashboard line charts.
 * @param {{ removeRecovery?: boolean, stripNonMeasurementStages?: boolean }} options
 */
export function filterRowsForNormalizeChart(rows, options = {}) {
    const { removeRecovery = true, stripNonMeasurementStages = false } = options;
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    const eventCol = findPlotEventColumn(rows[0]);
    if (!eventCol) return rows;

    const fileHasRecoveryOff = datasetHasRecoveryOffEvent(rows, eventCol);

    return rows.filter((row) => {
        const eNorm = normalizeEventValue(row, eventCol);
        if (removeRecovery && !keepRowWhenStrippingRecovery(eNorm, fileHasRecoveryOff)) return false;
        if (stripNonMeasurementStages && shouldStripNonMeasurementRow(eNorm)) return false;
        return true;
    });
}
