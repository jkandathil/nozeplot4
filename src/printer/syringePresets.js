/**
 * Syringe-pump presets and volume ↔ step conversion helpers.
 *
 * Kloehn V6/V15C pumps come in two main step granularities:
 *   • 24,000 step plungers
 *   • 48,000 step plungers
 *
 * The volume per step is `syringeUl / stroke` µL/step, so a 250 µL syringe on
 * a 24,000-step pump dispenses ~10.42 nL per step. The smallest meaningful
 * drop on that combo is therefore ~10 nL — well below the user's 100 nL
 * minimum requirement, which gives plenty of resolution.
 */

/** @typedef {{
 *   id: string,
 *   label: string,
 *   syringeUl: number,   total syringe volume
 *   stroke: number,      plunger step count (24000 or 48000)
 *   nlPerStep: number,   derived = syringeUl × 1000 / stroke
 *   defaultFastSps: number,   recommended top speed for aspirate
 *   defaultSlowSps: number,   recommended top speed for slow dispense
 * }} SyringePreset
 */

const make = (id, label, syringeUl, stroke, fast, slow) => ({
    id,
    label,
    syringeUl,
    stroke,
    nlPerStep: (syringeUl * 1000) / stroke,
    defaultFastSps: fast,
    defaultSlowSps: slow,
});

/**
 * Common Kloehn-family syringe + stroke combinations.
 *
 * 48 000-step presets are listed first because the Kloehn V15C variant
 * shipped to most analytical instruments uses the high-resolution 48k
 * plunger. A V6/V15C with a 250 µL syringe + 48 k stroke ⇒ 5.2 nL/step,
 * which is the default that loads on Connect.
 */
export const SYRINGE_PRESETS = [
    make('250ul-48k', '250 µL · 48 000 steps  (5.2 nL/step)', 250, 48000, 4000, 400),
    make('500ul-48k', '500 µL · 48 000 steps  (10.4 nL/step)', 500, 48000, 4000, 400),
    make('100ul-48k', '100 µL · 48 000 steps  (2.1 nL/step)', 100, 48000, 3000, 300),
    make('1000ul-48k', '1 mL · 48 000 steps  (20.8 nL/step)', 1000, 48000, 5000, 500),
    make('250ul-24k', '250 µL · 24 000 steps  (10.4 nL/step)', 250, 24000, 2000, 200),
    make('500ul-24k', '500 µL · 24 000 steps  (20.8 nL/step)', 500, 24000, 2000, 200),
    make('100ul-24k', '100 µL · 24 000 steps  (4.2 nL/step)', 100, 24000, 1500, 150),
    make('1000ul-24k', '1 mL · 24 000 steps  (41.7 nL/step)', 1000, 24000, 3000, 300),
];

/** Default preset = the configuration of your actual hardware:
 *  Kloehn VersaPump V15C-005 with a 250 µL syringe + 48 000 step plunger. */
export const DEFAULT_PRESET_ID = '250ul-48k';

/** Default user-configurable drop volume range (nL). */
export const DROP_VOLUME_MIN_NL = 100;
export const DROP_VOLUME_MAX_NL = 500;

/** Look up a preset by id; returns the default if missing. */
export function getSyringePreset(id) {
    return SYRINGE_PRESETS.find((p) => p.id === id) ?? SYRINGE_PRESETS[0];
}

/** Format a volume in the natural unit (nL / µL / mL). */
export function formatVolume(uL) {
    if (!Number.isFinite(uL)) return '—';
    const nL = uL * 1000;
    if (Math.abs(nL) < 1000) return `${nL.toFixed(0)} nL`;
    if (Math.abs(uL) < 1000) return `${uL.toFixed(uL < 10 ? 2 : 1)} µL`;
    return `${(uL / 1000).toFixed(2)} mL`;
}

/** Convert "current syringe position in steps" → fill % (0..100). */
export function stepsToFillPercent(steps, stroke) {
    if (!(stroke > 0)) return 0;
    return Math.max(0, Math.min(100, (100 * steps) / stroke));
}
