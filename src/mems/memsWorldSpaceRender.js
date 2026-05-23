/**
 * MEMS mask canvas: world-space (µm) rendering helpers.
 * SVG `vectorEffect="non-scaling-stroke"` keeps stroke width in **screen pixels**, so geometry
 * looks wrong when zooming; all layout strokes should use user-unit widths only.
 */

/** Hairline / debug outline (µm) — still world-space, scales with zoom. */
export const MEMS_HAIRLINE_OUTLINE_UM = 0.06;

/** Default polygon / rect / ellipse outline stroke (µm). */
export const MEMS_DEFAULT_OUTLINE_UM = 0.28;

/** Selected primitive outline (µm). */
export const MEMS_SELECTED_OUTLINE_UM = 0.42;

/**
 * Half-width for zero-width **line** entities in the doc (µm display-only).
 * Real mask width should come from path.widthUm or polygon edges.
 */
export const MEMS_DEFAULT_LINE_BAND_UM = 0.38;

/**
 * Build a closed rectangular strip around segment (x1,y1)-(x2,y2), perpendicular extent ±halfW.
 * @returns {string} SVG path `d` fragment (may be concatenated).
 */
export function segmentToQuadPathD(x1, y1, x2, y2, halfW) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-18 || !(halfW > 0)) return '';
    const nx = ((-dy / len) * halfW);
    const ny = ((dx / len) * halfW);
    const ax = x1 + nx;
    const ay = y1 + ny;
    const bx = x2 + nx;
    const by = y2 + ny;
    const cx = x2 - nx;
    const cy = y2 - ny;
    const ex = x1 - nx;
    const ey = y1 - ny;
    return `M ${ax} ${ay} L ${bx} ${by} L ${cx} ${cy} L ${ex} ${ey} Z`;
}

/** Draft / tool overlay stroke width (µm) — scales with zoom, not pixels. */
export const MEMS_UI_OVERLAY_STROKE_UM = 0.55;

/** Snap marker ring radius floor (µm). */
export const MEMS_SNAP_RING_R_MIN_UM = 10;

/**
 * Open polyline as union of segment quads (filled band). Joints may overlap slightly.
 * @param {{x:number,y:number}[]} pts
 * @param {number} halfW half-width in µm
 */
export function openPolylineToStrokeBandPathD(pts, halfW) {
    if (!pts || pts.length < 2 || !(halfW > 0)) return '';
    let d = '';
    for (let i = 0; i < pts.length - 1; i++) {
        d += segmentToQuadPathD(
            pts[i].x,
            pts[i].y,
            pts[i + 1].x,
            pts[i + 1].y,
            halfW
        );
    }
    return d;
}
