/**
 * Unit handling for Flow Lab.
 *
 * Internal representation: ALL coordinates and dimensions are stored in
 * millimetres. The UI can display in mm or µm — conversion happens only
 * at the presentation layer (labels, dimension text, BC form inputs).
 *
 * Never mutate stored geometry on unit toggle; just relabel.
 */

export const UNIT_LABEL = { mm: 'mm', um: 'µm' };

/** Internal mm → display number in chosen unit. */
export function mmToUnit(mm, unit) {
    if (unit === 'um') return mm * 1000;
    return mm;
}

/** Display number → internal mm. */
export function unitToMm(v, unit) {
    if (unit === 'um') return v / 1000;
    return v;
}

/** Format a mm value for display with sensible precision in either unit. */
export function formatLength(mm, unit, opts = {}) {
    const decimals = opts.decimals ?? (unit === 'um' ? 0 : 3);
    const v = mmToUnit(mm, unit);
    return `${v.toFixed(decimals)} ${UNIT_LABEL[unit] || ''}`.trim();
}

/** Pick a reasonable major grid spacing (in mm) for the current zoom level
    so that grid lines stay visually ~40–80 px apart. We snap to a 1/2/5
    decade series — same approach engineering software uses for smooth zoom. */
export function pickGridStepMm(pxPerMm) {
    if (!Number.isFinite(pxPerMm) || pxPerMm <= 0) return 1;
    // Target ~60 px per major tick.
    const targetPx = 60;
    const roughMm = targetPx / pxPerMm;
    // Round to 1 / 2 / 5 × 10^n.
    const mag = Math.pow(10, Math.floor(Math.log10(roughMm)));
    const norm = roughMm / mag;
    let step;
    if (norm < 1.5) step = 1 * mag;
    else if (norm < 3.5) step = 2 * mag;
    else if (norm < 7.5) step = 5 * mag;
    else step = 10 * mag;
    return step;
}
