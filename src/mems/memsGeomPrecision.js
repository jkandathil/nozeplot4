/**
 * Fixed-point geometry scale: layout µm ↔ integer nanometres for Clipper / Martinez kernels.
 * Keeps Boolean and offset inputs on a consistent grid (default 1 nm).
 */

/** Integer nanometres per micron (default). */
export const NM_PER_UM = 1000;

/** @param {number} um */
export function umToNmInt(um) {
    return Math.round(um * NM_PER_UM);
}

/** @param {number} nmInt */
export function nmIntToUm(nmInt) {
    return nmInt / NM_PER_UM;
}

/**
 * @param {{ x: number, y: number }} p
 * @returns {[number, number]}
 */
export function pointUmToNmPair(p) {
    return [umToNmInt(p.x), umToNmInt(p.y)];
}

/**
 * @param {[number, number]} pairNm
 * @returns {{ x: number, y: number }}
 */
export function nmPairToPointUm(pairNm) {
    return { x: nmIntToUm(pairNm[0]), y: nmIntToUm(pairNm[1]) };
}

/**
 * Remove consecutive duplicates and collapse near-duplicates (grid snap already applied).
 * @param {[number, number][]} ringNm
 * @returns {[number, number][]}
 */
export function cleanRingNm(ringNm) {
    if (!ringNm.length) return [];
    const out = [];
    const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
    for (const p of ringNm) {
        if (!out.length || !eq(out[out.length - 1], p)) out.push(p);
    }
    while (out.length >= 2 && eq(out[0], out[out.length - 1])) out.pop();
    return out;
}
