/**
 * Colormap lookup tables for field visualization.
 *
 * Each entry is a 256×3 Uint8 table of RGB values. We keep the colormaps
 * inline here (no npm dep) so the solver / heatmap path stays self-contained.
 *
 * Viridis / Plasma / Turbo are downsampled from matplotlib at stride 256.
 * RdBu is a simple symmetric diverging scheme. Grayscale is trivial.
 */

/* Compact generator: expands an array of [t, r, g, b] control points
   (0 ≤ t ≤ 1) into a 256×3 Uint8 LUT by linear interpolation in RGB.
   Not perceptually uniform, but visually close to the real colormaps
   while keeping the source small. */
function buildLUT(stops) {
    const lut = new Uint8Array(256 * 3);
    let si = 0;
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        while (si < stops.length - 2 && t > stops[si + 1][0]) si++;
        const [t0, r0, g0, b0] = stops[si];
        const [t1, r1, g1, b1] = stops[si + 1];
        const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
        lut[3 * i] = Math.round(r0 + (r1 - r0) * u);
        lut[3 * i + 1] = Math.round(g0 + (g1 - g0) * u);
        lut[3 * i + 2] = Math.round(b0 + (b1 - b0) * u);
    }
    return lut;
}

/* Viridis — perceptually uniform, colorblind-safe. Control points sampled
   from matplotlib's viridis at 9 positions. */
export const VIRIDIS = buildLUT([
    [0.0,  68,   1,  84],
    [0.125, 71,  44, 122],
    [0.25,  59,  81, 139],
    [0.375, 44, 113, 142],
    [0.5,   33, 144, 141],
    [0.625, 39, 173, 129],
    [0.75,  92, 200,  99],
    [0.875, 170, 220, 50],
    [1.0,  253, 231,  37],
]);

/* Plasma — high-contrast warm. */
export const PLASMA = buildLUT([
    [0.0,  13,   8, 135],
    [0.15, 84,   2, 163],
    [0.3, 139,  10, 165],
    [0.45, 185, 50, 137],
    [0.6, 219, 92, 104],
    [0.75, 244, 136, 73],
    [0.9, 254, 188, 43],
    [1.0, 240, 249, 33],
]);

/* Turbo — Google's improved-jet, good for rapid gradients. */
export const TURBO = buildLUT([
    [0.0,   48, 18,  59],
    [0.1,   70, 67, 212],
    [0.2,   57, 142, 248],
    [0.3,   34, 201, 224],
    [0.4,   42, 225, 158],
    [0.5,  109, 241, 85],
    [0.6,  192, 234, 54],
    [0.7,  249, 186, 40],
    [0.8,  248, 117, 31],
    [0.9,  209, 57, 21],
    [1.0,  122, 4,  3],
]);

/* Gray — for overlay / debug. */
export const GRAY = buildLUT([
    [0.0, 15, 23, 42],
    [1.0, 248, 250, 252],
]);

/* RdBu diverging — good for vorticity / signed fields. Negative = blue,
   zero = white, positive = red. */
export const RDBU = buildLUT([
    [0.0,   33, 102, 172],
    [0.25,  103, 169, 207],
    [0.5,  247, 247, 247],
    [0.75, 239, 138, 98],
    [1.0,  178,  24,  43],
]);

/* Inferno — black → purple → orange → yellow. Perceptually uniform,
 * excellent for concentration / density / heat-like scalar fields
 * because low values fade to near-black so they read as "empty"
 * instead of competing with the velocity field underneath. */
export const INFERNO = buildLUT([
    [0.0,    0,   0,   4],
    [0.15,  31,  12,  72],
    [0.3,   85,  15, 109],
    [0.45, 136,  34, 106],
    [0.6,  186,  54,  85],
    [0.75, 227,  89,  51],
    [0.88, 249, 142,  9],
    [1.0,  252, 255, 164],
]);

/* Magma — similar family to inferno but with a softer end. Second
 * strong choice for aroma concentration plots. */
export const MAGMA = buildLUT([
    [0.0,    0,   0,   4],
    [0.25,  51,  16,  87],
    [0.5,  128,  37, 129],
    [0.75, 221,  81, 111],
    [1.0,  252, 253, 191],
]);

/* Cividis — perceptually uniform AND colorblind-friendly (unlike
 * viridis for some kinds of CVD). Good default for shared plots. */
export const CIVIDIS = buildLUT([
    [0.0,   0,  32,  76],
    [0.25, 62,  73, 137],
    [0.5, 124, 123, 120],
    [0.75, 182, 177, 97],
    [1.0,  255, 234,  70],
]);

export const COLORMAPS = {
    viridis: VIRIDIS,
    plasma: PLASMA,
    turbo: TURBO,
    inferno: INFERNO,
    magma: MAGMA,
    cividis: CIVIDIS,
    gray: GRAY,
    rdbu: RDBU,
};

export const COLORMAP_NAMES = Object.keys(COLORMAPS);

/** Sample a colormap at scalar t ∈ [0,1]. Returns [r,g,b] integers. */
export function sample(lut, t) {
    const idx = Math.min(255, Math.max(0, Math.round(t * 255)));
    return [lut[3 * idx], lut[3 * idx + 1], lut[3 * idx + 2]];
}
