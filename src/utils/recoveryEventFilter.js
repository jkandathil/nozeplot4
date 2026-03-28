/**
 * ALAAC-style recovery trimming: if the file contains explicit RecoveryOff markers, those
 * rows/blocks are kept; other events whose name includes "recovery" are removed.
 *
 * Recognized marker names (after normalizeEventValue): recoveryOff, Recovery_Off, Recovery-Off,
 * "Recovery Off", etc. → normalized forms like recoveryoff, recovery_off, recovery-off.
 */

export function normalizeEventValue(row, eventCol) {
    if (!eventCol || !row) return '';
    return String(row[eventCol] ?? '')
        .toLowerCase()
        .replace(/\s+/g, '');
}

/** True if this normalized event string is a RecoveryOff-style end marker. */
export function isRecoveryOffEvent(eNorm) {
    if (!eNorm) return false;
    // recovery + optional _/- + off (covers recoveryOff → recoveryoff, recovery_off, recovery-off)
    return /recovery[_-]?off/.test(eNorm);
}

/** True if any row in the table uses a RecoveryOff marker (so we apply split logic). */
export function datasetHasRecoveryOffEvent(rows, eventCol) {
    if (!eventCol || !rows?.length) return false;
    return rows.some((r) => isRecoveryOffEvent(normalizeEventValue(r, eventCol)));
}

/**
 * Dashboard / row filter: keep row when stripping recovery?
 * - No "recovery" in name → keep
 * - Has RecoveryOff marker and file also has at least one RecoveryOff anywhere → keep
 * - Otherwise "recovery" in name → drop
 */
export function keepRowWhenStrippingRecovery(eNorm, fileHasRecoveryOff) {
    if (!eNorm.includes('recovery')) return true;
    if (fileHasRecoveryOff && isRecoveryOffEvent(eNorm)) return true;
    return false;
}

/**
 * Pipeline block removal: remove entire block if it's recovery-like but not RecoveryOff when file has RecoveryOff events.
 */
export function shouldRemoveRecoveryBlock(blockEventNorm, fileHasRecoveryOff) {
    if (!blockEventNorm.includes('recovery')) return false;
    if (fileHasRecoveryOff && isRecoveryOffEvent(blockEventNorm)) return false;
    return true;
}
