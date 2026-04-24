/**
 * Shared SI-prefix helpers used by the schematic property popup,
 * the transient-analysis inputs, and the parametric-sweep editor.
 *
 * Keeping these in one module means "4.7k" parses identically
 * everywhere in the app — no surprises when copy-pasting a value
 * between the inspector and the sweep dialog.
 */

export const SI_MAP = {
    f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6,
    m: 1e-3, k: 1e3, K: 1e3,
    meg: 1e6, Meg: 1e6, MEG: 1e6,
    g: 1e9, G: 1e9,
};

/**
 * Parse a SPICE-flavoured SI value string — e.g. "4.7k" → 4700,
 * "220u" → 2.2e-4, "1meg" → 1e6, "100" → 100. Returns NaN for
 * unparseable input. A trailing unit symbol (Ω, Hz, F, etc.) is
 * tolerated and ignored.
 */
export function parseSiValue(txt) {
    if (txt == null) return NaN;
    const s = String(txt).trim();
    if (!s) return NaN;
    const m = s.match(/^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*([a-zA-Zµ]*)\s*[a-zA-ZΩ/]*$/);
    if (!m) return Number(s);
    const num = parseFloat(m[1]);
    const suffix = m[2] || '';
    if (!suffix) return num;
    if (SI_MAP[suffix] != null) return num * SI_MAP[suffix];
    const lower = suffix.toLowerCase();
    if (SI_MAP[lower] != null) return num * SI_MAP[lower];
    return num;
}

/**
 * Format a number with a compact SI suffix — 2200 → "2.2k",
 * 1e-6 → "1u", 0.015 → "15m". Used by the sweep UI to echo a
 * parsed value back so users can see "100ohm" was understood as
 * 100, or "1k" as 1000.
 *
 * We trim float-precision noise with toPrecision(sigFigs) so
 * 500.00000000000006 doesn't leak out as "500.00000000000006u".
 */
export function formatSi(v, sigFigs = 6) {
    if (v == null || !Number.isFinite(+v)) return '';
    const n = +v;
    if (n === 0) return '0';
    const abs = Math.abs(n);
    const fmt = (x) => Number(x.toPrecision(sigFigs)).toString();
    if (abs >= 1e9)  return `${fmt(n / 1e9)}G`;
    if (abs >= 1e6)  return `${fmt(n / 1e6)}Meg`;
    if (abs >= 1e3)  return `${fmt(n / 1e3)}k`;
    if (abs >= 1)    return fmt(n);
    if (abs >= 1e-3) return `${fmt(n * 1e3)}m`;
    if (abs >= 1e-6) return `${fmt(n * 1e6)}u`;
    if (abs >= 1e-9) return `${fmt(n * 1e9)}n`;
    if (abs >= 1e-12) return `${fmt(n * 1e12)}p`;
    return `${fmt(n * 1e15)}f`;
}

/**
 * Generate the list of parameter values for a linear sweep over
 * [start, stop] with the given increment. Tolerates floating-point
 * drift at the endpoints so "0 → 1 step 0.1" actually hits 1.0.
 *
 * Returns [] on invalid input (non-positive step, wrong sign, etc.).
 */
export function linspaceByStep(start, stop, step) {
    if (!Number.isFinite(start) || !Number.isFinite(stop) || !Number.isFinite(step)) return [];
    if (step === 0) return [];
    if (Math.sign(stop - start) !== Math.sign(step) && start !== stop) return [];
    const tol = Math.abs(step) * 1e-6;
    const out = [];
    if (start === stop) return [start];
    for (let v = start; step > 0 ? v <= stop + tol : v >= stop - tol; v += step) {
        out.push(v);
    }
    return out;
}
