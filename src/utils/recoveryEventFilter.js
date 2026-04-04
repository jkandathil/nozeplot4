/**
 * Phase / event strings are normalized (lower + strip whitespace) for substring checks.
 * RecoveryOff, Recovery, hardware recovery, etc. all normalize to strings containing "recovery".
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

/** Keep row when "No recovery" is on: drop every recovery-tagged phase, including RecoveryOff. */
export function keepRowWhenStrippingRecovery(eNorm) {
    return !eNorm.includes('recovery');
}

/** Remove contiguous block when it is any recovery-related phase (including RecoveryOff). */
export function shouldRemoveRecoveryBlock(blockEventNorm) {
    return Boolean(blockEventNorm && blockEventNorm.includes('recovery'));
}
