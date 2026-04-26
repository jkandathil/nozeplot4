/**
 * Optional full-board GND copper pour (filled polygon), KiCad-style zone on one layer.
 */

import { activeCopperLayerIds } from './pcbDoc.js';

/** Stable id so we replace the same pour instead of stacking duplicates. */
export const NOZE_GND_PLANE_ID = 'noze_gnd_plane';

/**
 * Pick a sensible default layer for a ground pour from the active stack.
 * Prefer **F.Cu** so the pour matches “Top Cu” trace color (e.g. red) in the canvas;
 * inner pours (In1…) stay available in the dropdown for 4+ layer boards.
 * @param {object} doc
 * @returns {string} layer id e.g. F.Cu
 */
export function suggestGndPlaneLayer(doc) {
  const stack = activeCopperLayerIds(doc);
  if (stack.includes('F.Cu')) return 'F.Cu';
  return stack[0] || 'B.Cu';
}

/**
 * Axis-aligned board rectangle inset from the outline (mm, same coords as tracks).
 * @param {number} W board width mm
 * @param {number} H board height mm
 * @param {number} insetMm clearance from each edge (typically edgeClearance)
 */
export function buildBoardInsetRectangle(W, H, insetMm) {
  const inset = Math.max(0, Math.min(Number(insetMm) || 0, Math.min(W, H) / 2 - 0.02));
  return [
    [inset, inset],
    [W - inset, inset],
    [W - inset, H - inset],
    [inset, H - inset],
  ];
}

export function hasGndPlane(doc) {
  return (doc?.polygons || []).some((p) => p.id === NOZE_GND_PLANE_ID);
}

/**
 * @param {object} doc
 * @param {string} layerId must be in activeCopperLayerIds(doc)
 * @param {{ edgeInsetMm?: number }} [opts] defaults to designRules.edgeClearanceMm
 * @returns {object} next doc (immutable)
 */
export function addOrUpdateGndPlane(doc, layerId, opts = {}) {
  const stack = activeCopperLayerIds(doc);
  if (!stack.includes(layerId)) return doc;
  const W = Number(doc.meta?.boardWmm) || 80;
  const H = Number(doc.meta?.boardHmm) || 50;
  const dr = doc.meta?.designRules || {};
  const defInset = Number(dr.edgeClearanceMm) > 0 ? Number(dr.edgeClearanceMm) : 0.25;
  const inset = Number(opts.edgeInsetMm) > 0 ? Number(opts.edgeInsetMm) : defInset;
  const points = buildBoardInsetRectangle(W, H, inset);
  const poly = {
    id: NOZE_GND_PLANE_ID,
    layer: layerId,
    net: '0',
    points,
  };
  const rest = (doc.polygons || []).filter((p) => p.id !== NOZE_GND_PLANE_ID);
  return { ...doc, polygons: [...rest, poly] };
}

export function removeGndPlane(doc) {
  return { ...doc, polygons: (doc.polygons || []).filter((p) => p.id !== NOZE_GND_PLANE_ID) };
}
