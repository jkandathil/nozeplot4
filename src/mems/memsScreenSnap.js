/**
 * Screen-pixel snapping: compare snap targets in client / pixel space for predictable UX.
 */

import { snapPoint } from './memsGeometry.js';
import { layoutLayers } from './memsMaskDoc.js';

/** Client-space pixel position of a world (µm) point on the SVG viewport. */
export function worldToClientPixel(svgEl, wx, wy, vb) {
    if (!svgEl || !vb) return { px: 0, py: 0 };
    try {
        const ctm = svgEl.getScreenCTM();
        if (ctm) {
            const pt = svgEl.createSVGPoint();
            pt.x = wx;
            pt.y = wy;
            const p = pt.matrixTransform(ctm);
            return { px: p.x, py: p.y };
        }
    } catch {
        /* fall through */
    }
    const rect = svgEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { px: rect.left, py: rect.top };
    const rx = (wx - vb.x) / vb.w;
    const ry = (wy - vb.y) / vb.h;
    return {
        px: rect.left + rx * rect.width,
        py: rect.top + ry * rect.height,
    };
}

function pixelDist(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
}

/**
 * @typedef {{ wx: number, wy: number, label?: string, kind?: string }} SnapCandidate
 */

/**
 * Pick nearest candidate within tolPx (screen pixels).
 * @param {number} mouseClientX
 * @param {number} mouseClientY
 * @param {SnapCandidate[]} candidates
 * @returns {{ wx: number, wy: number, label: string, kind?: string, distPx: number } | null}
 */
export function pickNearestSnapPx(mouseClientX, mouseClientY, svgEl, vb, candidates, tolPx) {
    if (!svgEl || !vb || !candidates?.length || !(tolPx > 0)) return null;
    let best = null;
    let bestD = tolPx + 1;
    for (const c of candidates) {
        if (!Number.isFinite(c.wx) || !Number.isFinite(c.wy)) continue;
        const { px, py } = worldToClientPixel(svgEl, c.wx, c.wy, vb);
        const d = pixelDist(mouseClientX, mouseClientY, px, py);
        if (d <= tolPx && d < bestD - 1e-9) {
            bestD = d;
            best = {
                wx: c.wx,
                wy: c.wy,
                label: c.label || 'Snap',
                kind: c.kind,
                distPx: d,
            };
        }
    }
    return best;
}

/**
 * Build snap targets for polygon draft: draft vertices, geometry on layer, grid & guides.
 * @param {object} doc
 * @param {{ x: number, y: number }[]} draftVerts
 * @param {string} layerId
 * @param {{ gridUm?: number, gridOn?: boolean, guidesV?: number[], guidesH?: number[] }} [opts]
 */
export function collectPolygonSnapCandidates(doc, draftVerts, layerId, opts = {}) {
    /** @type {SnapCandidate[]} */
    const out = [];
    const dv = Array.isArray(draftVerts) ? draftVerts : [];
    dv.forEach((p, i) => {
        out.push({
            wx: p.x,
            wy: p.y,
            label: i === 0 ? 'First vertex' : `Draft vertex ${i + 1}`,
            kind: i === 0 ? 'first' : 'draft',
        });
    });

    const layer = layoutLayers(doc).find((l) => l.id === layerId);
    if (layer) {
        for (const e of layer.entities || []) {
            if (e.type === 'line') {
                out.push({ wx: e.x1, wy: e.y1, label: 'Endpoint', kind: 'line' });
                out.push({ wx: e.x2, wy: e.y2, label: 'Endpoint', kind: 'line' });
            } else if (e.type === 'polygon') {
                for (const p of e.points || []) {
                    out.push({ wx: p.x, wy: p.y, label: 'Vertex', kind: 'poly' });
                }
                for (const hole of e.holes || []) {
                    for (const p of hole || []) {
                        out.push({ wx: p.x, wy: p.y, label: 'Hole vertex', kind: 'hole' });
                    }
                }
            } else if (e.type === 'path') {
                for (const p of e.points || []) {
                    out.push({ wx: p.x, wy: p.y, label: 'Path point', kind: 'path' });
                }
            }
        }
    }

    const gridUm = opts.gridUm > 0 ? opts.gridUm : 0;
    const gridOn = !!opts.gridOn;
    const guidesV = Array.isArray(opts.guidesV) ? opts.guidesV : [];
    const guidesH = Array.isArray(opts.guidesH) ? opts.guidesH : [];

    if (opts.mouseWorld && gridOn && gridUm > 0) {
        const g = snapPoint({ x: opts.mouseWorld.x, y: opts.mouseWorld.y }, gridUm);
        out.push({ wx: g.x, wy: g.y, label: 'Grid', kind: 'grid' });
    }

    if (opts.mouseWorld && (guidesV.length || guidesH.length)) {
        const mx = opts.mouseWorld.x;
        const my = opts.mouseWorld.y;
        for (const gx of guidesV) {
            if (Number.isFinite(gx)) {
                out.push({ wx: gx, wy: my, label: 'Guide', kind: 'guide' });
            }
        }
        for (const gy of guidesH) {
            if (Number.isFinite(gy)) {
                out.push({ wx: mx, wy: gy, label: 'Guide', kind: 'guide' });
            }
        }
    }

    return out;
}
