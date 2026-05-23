/**
 * Canonical layout coordinates are stored in micrometres (µm).
 * displayUnit controls UI labels and numeric inputs only.
 */

export const UM_PER_MM = 1000;

/** @param {'um'|'mm'} unit */
export function umToDisplay(um, unit) {
    if (unit === 'mm') return um / UM_PER_MM;
    return um;
}

/** @param {'um'|'mm'} unit */
export function displayToUm(val, unit) {
    if (unit === 'mm') return val * UM_PER_MM;
    return val;
}

/** @param {'um'|'mm'} unit */
export function formatLengthUm(um, unit, fractionDigits = 4) {
    const v = umToDisplay(um, unit);
    const u = unit === 'mm' ? 'mm' : 'µm';
    return `${v.toFixed(fractionDigits)} ${u}`;
}

/** Short label for rulers / footer */
export function unitSuffix(unit) {
    return unit === 'mm' ? 'mm' : 'µm';
}
