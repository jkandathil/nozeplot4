/**
 * Professional Canvas 2D Renderer for PCB Studio.
 * Replaces SVG rendering with high-performance hardware-accelerated Canvas 2D.
 * Handles: grid, layers, tracks, vias, pads, polygons, silkscreen, board frame,
 * selection highlights, DRC markers, ratsnest (unconnected pad islands), measure tool, and draft previews.
 *
 * Stroke policy: geometry is in board mm and scales with zoom. **UI strokes** (grid, frame,
 * selection, silk, ratsnest, etc.) use `lineWidthScreenPx(px, scale)` so line thickness stays
 * ~constant in device pixels. **Copper** (trace half-width, pad fill, via barrel) stays in mm.
 */

import { getFootprint } from './footprintLib.js';
import { activeCopperLayerIds, isCopperLayerVisible } from './pcbDoc.js';
import { snapBoard, snapInteractiveRoutePoint } from './pcbEditorUtils.js';
import { NOZE_GND_PLANE_ID } from './gndPlane.js';

/* ─── Layer colors (zones / polygons / UI chrome) ─── */
export const PCB_LAYER_COLORS = {
  'F.Cu':   '#ef4444',
  'In1.Cu': '#22c55e',
  'In2.Cu': '#3b82f6',
  'In3.Cu': '#eab308',
  'In4.Cu': '#06b6d4',
  'In5.Cu': '#f97316',
  'In6.Cu': '#6366f1',
  'B.Cu':   '#a855f7',
};

/** Saturated per-layer colors for tracks (max hue separation vs other layers). */
export const PCB_TRACE_LAYER_COLORS = {
  'F.Cu':   '#ff4d4d',
  'In1.Cu': '#00e676',
  'In2.Cu': '#2196ff',
  'In3.Cu': '#ffd600',
  'In4.Cu': '#00e5ff',
  'In5.Cu': '#ff9100',
  'In6.Cu': '#b388ff',
  'B.Cu':   '#e040fb',
};

/* ─── Helpers ─── */
function rotLocal(x, y, deg) {
  const r = ((Number(deg) || 0) * Math.PI) / 180;
  const c = Math.cos(r); const s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

function padWorld(pl, pad) {
  const [lx, ly] = rotLocal(pad.x, pad.y, pl.rot || 0);
  return [lx + pl.x, ly + pl.y];
}

function fpLocalToWorld(pl, lx, ly) {
  const [x, y] = rotLocal(lx, ly, pl.rot || 0);
  return [x + pl.x, y + pl.y];
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Darken hex toward black for track outline (t=1 → black). */
function shadeHex(hex, tDark) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const f = 1 - Math.min(1, Math.max(0, tDark));
  const rr = Math.round(r * f);
  const gg = Math.round(g * f);
  const bb = Math.round(b * f);
  return `rgb(${rr},${gg},${bb})`;
}

/**
 * Line width in board user space (mm) so stroke is ~`screenPx` device pixels.
 * `scale` = canvas pixels per board mm (from viewport transform).
 */
function lineWidthScreenPx(screenPx, scale) {
  const s = Math.max(1e-9, scale);
  return Math.max(0.35 / s, screenPx / s);
}

/** Dash/gap lengths in user space (mm) for ~`patternPx` pixel rhythm on screen. */
function dashScreenPx(patternPx, scale) {
  const s = Math.max(1e-9, scale);
  return patternPx.map((p) => Math.max(0.2 / s, p / s));
}

/** ~`minDevPx` screen pixels (alias for grid / hairlines). */
function hairlineMm(scale, minDevPx = 0.9) {
  return lineWidthScreenPx(minDevPx, scale);
}

/**
 * CAD workbench look (default on). Set `boardPreview.cadWorkbench` false for the softer legacy chrome.
 */
function paletteForBoardPreview(boardPreview = {}) {
  const cad = boardPreview.cadWorkbench !== false;
  return {
    cad,
    voidFill: cad ? '#070a0f' : '#06090e',
    /* Slightly tighter than before so fine snap grids (e.g. 0.05 mm) show real lines sooner when zoomed in. */
    gridMinSpacing: cad ? 4 : 3,
    selStroke: cad ? '#38bdf8' : '#f472b6',
    selGlow: cad ? 'rgba(56, 189, 248, 0.4)' : 'rgba(244,114,182,0.42)',
    selTrack: cad ? '#22d3ee' : '#f472b6',
    schRef: '#a855f7',
    boxSelect: cad ? 'rgba(56, 189, 248, 0.75)' : 'rgba(96,165,250,0.7)',
    boxFill: cad ? 'rgba(56, 189, 248, 0.1)' : 'rgba(96,165,250,0.12)',
  };
}

function footprintBBox(pl) {
  const fp = getFootprint(pl.footprintId);
  if (!fp?.pads?.length) {
    return { minX: pl.x - 2, maxX: pl.x + 2, minY: pl.y - 2, maxY: pl.y + 2 };
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const pad of fp.pads) {
    const [x, y] = padWorld(pl, pad);
    minX = Math.min(minX, x - pad.w / 2);
    maxX = Math.max(maxX, x + pad.w / 2);
    minY = Math.min(minY, y - pad.h / 2);
    maxY = Math.max(maxY, y + pad.h / 2);
  }
  return { minX, maxX, minY, maxY };
}

/**
 * KiCad-style GND pour: filled copper zone on one layer with isolation clearance
 * cutouts around non-GND copper (tracks / vias / pads).
 *
 * Uses even-odd fill rule: outer polygon is clockwise, clearance cutouts are
 * counter-clockwise circles/rects. This avoids the `destination-out` compositing
 * bug that destroyed underlying canvas content.
 *
 * Important: with `evenodd`, overlapping cutouts **cancel** where they cross —
 * that looks like tiny copper slivers near pads/traces (not grid-related). Avoid
 * redundant overlapping holes (e.g. courtyard already covers per-pad rects).
 *
 * The pour is rasterized offscreen then scaled to mm space: target ~2× screen px/mm
 * (capped by board size / ~12M pixel budget / 8192 edge). Manhattan carve uses
 * inflated axis-aligned rects; drawImage is bilinear so NN stair-steps do not read
 * as hairline copper. Tracks are drawn as one continuous stroke path (not per-segment
 * rects) so copper reads as a single polyline.
 */
/** CCW rounded rect in **world mm** (even-odd hole). `rad` capped by half-sides. */
function addCcwRoundRectAabbHole(ctx, minX, minY, maxX, maxY, rad) {
  const w = maxX - minX;
  const h = maxY - minY;
  const r = Math.min(Math.max(0, rad), w / 2, h / 2);
  if (r <= 0) {
    ctx.moveTo(minX, minY);
    ctx.lineTo(minX, maxY);
    ctx.lineTo(maxX, maxY);
    ctx.lineTo(maxX, minY);
    ctx.closePath();
    return;
  }
  ctx.moveTo(minX + r, minY);
  ctx.lineTo(maxX - r, minY);
  ctx.arc(maxX - r, minY + r, r, -Math.PI / 2, 0, true);
  ctx.lineTo(maxX, maxY - r);
  ctx.arc(maxX - r, maxY - r, r, 0, Math.PI / 2, true);
  ctx.lineTo(minX + r, maxY);
  ctx.arc(minX + r, maxY - r, r, Math.PI / 2, Math.PI, true);
  ctx.lineTo(minX, minY + r);
  ctx.arc(minX + r, minY + r, r, Math.PI, (3 * Math.PI) / 2, true);
  ctx.closePath();
}

const _MANHATTAN_EPS = 1e-3;

function trackPolylineIsManhattan(tpts) {
  if (!tpts || tpts.length < 2) return false;
  for (let i = 1; i < tpts.length; i++) {
    const ax = tpts[i - 1][0];
    const ay = tpts[i - 1][1];
    const bx = tpts[i][0];
    const by = tpts[i][1];
    const horiz = Math.abs(by - ay) < _MANHATTAN_EPS;
    const vert = Math.abs(bx - ax) < _MANHATTAN_EPS;
    if (!horiz && !vert) return false;
  }
  return true;
}

/** Axis-aligned bounds for one Manhattan segment expanded by `halfW` perpendicular to the segment. */
function manhattanSegmentBounds(ax, ay, bx, by, halfW) {
  if (Math.hypot(bx - ax, by - ay) < _MANHATTAN_EPS) return null;
  if (Math.abs(by - ay) < _MANHATTAN_EPS) {
    return {
      minX: Math.min(ax, bx) - halfW,
      maxX: Math.max(ax, bx) + halfW,
      minY: ay - halfW,
      maxY: ay + halfW,
    };
  }
  return {
    minX: ax - halfW,
    maxX: ax + halfW,
    minY: Math.min(ay, by) - halfW,
    maxY: Math.max(ay, by) + halfW,
  };
}

function inflateBounds(b, pad) {
  return {
    minX: b.minX - pad,
    maxX: b.maxX + pad,
    minY: b.minY - pad,
    maxY: b.maxY + pad,
  };
}

/** Drop consecutive duplicate vertices (prevents zero-length “spur” segments in stroke paths). */
function dedupeConsecutiveTrackPoints(pts, eps = 1e-3) {
  if (!pts?.length) return [];
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const q = out[out.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= eps) out.push(p);
  }
  return out;
}

/** Endpoint tolerance (mm) for merging separate `doc.tracks` into one drawn polyline. */
const TRACK_MERGE_EPS_MM = 0.06;

function endpointsEqualTrack(p, q, eps = TRACK_MERGE_EPS_MM) {
  return Math.hypot(p[0] - q[0], p[1] - q[1]) <= eps;
}

/**
 * If two open polylines meet at an endpoint pair, return merged vertices; else null.
 * Used so canvas draws one continuous stroke (no stacked round-caps at the joint).
 */
function tryMergeTrackPolylinePoints(aPts, bPts, eps = TRACK_MERGE_EPS_MM) {
  if (!aPts?.length || !bPts?.length || aPts.length < 2 || bPts.length < 2) return null;
  const a0 = aPts[0];
  const a1 = aPts[aPts.length - 1];
  const b0 = bPts[0];
  const b1 = bPts[bPts.length - 1];
  if (endpointsEqualTrack(a1, b0, eps)) return [...aPts, ...bPts.slice(1)];
  if (endpointsEqualTrack(a1, b1, eps)) return [...aPts, ...bPts.slice(0, -1).reverse()];
  if (endpointsEqualTrack(a0, b0, eps)) return [...[...aPts].reverse(), ...bPts.slice(1)];
  if (endpointsEqualTrack(a0, b1, eps)) return [...bPts, ...aPts.slice(1)];
  return null;
}

/**
 * Greedy-merge track polylines that share endpoints (same render bucket: net/width/selection).
 */
function mergeTrackPolylinesForDraw(trackRefs, eps = TRACK_MERGE_EPS_MM) {
  let items = trackRefs
    .map((tr) => ({ tr, pts: dedupeConsecutiveTrackPoints(tr.points || []) }))
    .filter((x) => x.pts.length >= 2);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const merged = tryMergeTrackPolylinePoints(items[i].pts, items[j].pts, eps);
        if (merged) {
          items[i] = { tr: items[i].tr, pts: dedupeConsecutiveTrackPoints(merged) };
          items.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return items;
}

/** Filled stadium shape (mm space): trace segment as solid copper — no stroke seams at T-junctions. */
function fillRoundCopperSegment(ctx, ax, ay, bx, by, halfW) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9 || halfW <= 0) return;
  const ang = Math.atan2(dy, dx);
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(0, -halfW);
  ctx.lineTo(len, -halfW);
  ctx.arc(len, 0, halfW, -Math.PI / 2, Math.PI / 2, false);
  ctx.lineTo(0, halfW);
  ctx.arc(0, 0, halfW, Math.PI / 2, -Math.PI / 2, false);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Draw all segments in a bucket as opaque fills (same conductor), then weld discs where
 * ≥2 segment ends coincide — removes the “inner outline” at T-junctions from double-stroke.
 */
function drawTrackGroupCopperFill(ctx, mergedItems, fillStyle, halfW) {
  const segments = [];
  for (const { pts } of mergedItems) {
    const pp = dedupeConsecutiveTrackPoints(pts || []);
    for (let i = 0; i < pp.length - 1; i++) {
      segments.push({ ax: pp[i][0], ay: pp[i][1], bx: pp[i + 1][0], by: pp[i + 1][1] });
    }
  }
  if (!segments.length) return;

  ctx.fillStyle = fillStyle;
  for (const s of segments) {
    fillRoundCopperSegment(ctx, s.ax, s.ay, s.bx, s.by, halfW);
  }

  const WELD = Math.max(TRACK_MERGE_EPS_MM * 1.5, halfW * 0.4);
  const clusters = [];
  for (const s of segments) {
    for (const p of [[s.ax, s.ay], [s.bx, s.by]]) {
      let hit = -1;
      for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        if (Math.hypot(p[0] - c.x, p[1] - c.y) <= WELD) {
          hit = i;
          break;
        }
      }
      if (hit >= 0) {
        const c = clusters[hit];
        c.n += 1;
        c.x += (p[0] - c.x) / c.n;
        c.y += (p[1] - c.y) / c.n;
      } else {
        clusters.push({ x: p[0], y: p[1], n: 1 });
      }
    }
  }
  const weldR = halfW * 1.08;
  for (const c of clusters) {
    if (c.n >= 2) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, weldR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawTrackGroupSchDashOverlay(ctx, mergedItems, scale) {
  ctx.save();
  ctx.strokeStyle = 'rgba(192,132,252,0.92)';
  ctx.lineWidth = lineWidthScreenPx(1.45, scale);
  ctx.setLineDash(dashScreenPx([5.5, 3.2], scale));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const { pts } of mergedItems) {
    const pp = dedupeConsecutiveTrackPoints(pts || []);
    if (pp.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(pp[0][0], pp[0][1]);
    for (let i = 1; i < pp.length; i++) ctx.lineTo(pp[i][0], pp[i][1]);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Erase pour under trace+clearance using only axis-aligned rects (no stroke joins).
 * `overlapMm` closes sub-pixel gaps vs the bitmap grid and vertex seams.
 */
function carveManhattanTrackClearanceRects(ox, tpts, halfW, overlapMm) {
  const pad = Math.max(0, overlapMm);
  for (let i = 1; i < tpts.length; i++) {
    const ax = tpts[i - 1][0];
    const ay = tpts[i - 1][1];
    const bx = tpts[i][0];
    const by = tpts[i][1];
    const raw = manhattanSegmentBounds(ax, ay, bx, by, halfW);
    if (!raw) continue;
    const b = pad > 0 ? inflateBounds(raw, pad) : raw;
    if (b.maxX <= b.minX || b.maxY <= b.minY) continue;
    ox.fillRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  }
}

function drawGndPlaneWithClearanceCarve(ctx, poly, ly, layerColor, polyFill, doc, isSel, schLink, selStroke = '#f472b6', scale) {
  const pts = poly.points || [];
  if (pts.length < 3) return;

  // Use generous clearance — 0.5 mm default to prevent shorts around pads
  const clearMm = Number(doc.meta?.designRules?.minCopperClearanceMm) > 0
    ? Math.max(Number(doc.meta.designRules.minCopperClearanceMm), 0.35)
    : 0.5;

  // Extra courtyard margin beyond individual pad clearance (mm)
  const courtyardExtra = 0.3;

  const isNonGndNet = (net) => {
    const s = net != null ? String(net).trim() : '';
    return s !== '' && s !== '0';
  };

  ctx.save();

  const boardW = Number(doc.meta?.boardWmm) || 80;
  const boardH = Number(doc.meta?.boardHmm) || 50;
  const trf = ctx.getTransform();
  const pxPerMm = Math.hypot(trf.a, trf.c) || 1;
  // Raster pour at ~2× on-screen px/mm (min 8) so clearance cutouts stay smooth; cap
  // each axis to MAX_OSC_DIM so huge boards still fit GPU canvas limits.
  const MAX_OSC_DIM = 8192;
  /** ~48 MiB RGBA budget so typical boards can use high px/mm without OOM on large panels */
  const MAX_OSC_PIXELS = 12 * 1024 * 1024;
  let density = Math.min(
    96,
    MAX_OSC_DIM / Math.max(1e-6, boardW),
    MAX_OSC_DIM / Math.max(1e-6, boardH),
    Math.max(8, pxPerMm * 2),
  );
  let pw = Math.max(1, Math.ceil(boardW * density));
  let ph = Math.max(1, Math.ceil(boardH * density));
  if (pw * ph > MAX_OSC_PIXELS) {
    density *= Math.sqrt(MAX_OSC_PIXELS / (pw * ph));
    pw = Math.max(1, Math.ceil(boardW * density));
    ph = Math.max(1, Math.ceil(boardH * density));
  }

  let osc;
  try {
    osc = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(pw, ph)
      : Object.assign(document.createElement('canvas'), { width: pw, height: ph });
  } catch {
    osc = Object.assign(document.createElement('canvas'), { width: pw, height: ph });
  }
  const ox = osc.getContext('2d', { alpha: true });
  ox.setTransform(density, 0, 0, density, 0, 0);
  // Crisp geometry on the pour bitmap (carve is AA-free); upscale uses bilinear on main ctx.
  ox.imageSmoothingEnabled = false;
  ox.clearRect(0, 0, boardW, boardH);

  // ── Step 1: fill the outer polygon with the layer color (source-over) ──
  ox.beginPath();
  ox.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ox.lineTo(pts[i][0], pts[i][1]);
  ox.closePath();
  ox.fillStyle = layerColor.startsWith('#') && layerColor.length >= 7 ? layerColor : '#ef4444';
  ox.fill();

  // ── Step 2: carve ALL clearances with destination-out (overlap-safe) ──
  // Using destination-out for everything: overlapping shapes just keep removing
  // pixels — no even-odd “re-fill” artifacts.
  ox.globalCompositeOperation = 'destination-out';
  ox.fillStyle = '#000';
  ox.strokeStyle = '#000';

  // 2a. Component courtyard cutouts — bounding box around ALL pads + clearance
  //     for any component that has at least one non-GND pad.
  //     Skip components on a different layer (SMD pads don't block other layers).
  for (const pl of doc.placements || []) {
    const plLayer = pl.layer || 'F.Cu';
    if (plLayer !== ly) continue; // Only carve pads on this copper layer
    const fp = getFootprint(pl.footprintId);
    if (!fp?.pads?.length) continue;
    const nets = pl.padNets || {};

    // Check if component has any non-GND pad
    const hasNonGnd = fp.pads.some((pad) => {
      const net = nets[pad.num] || nets[pad.id];
      return isNonGndNet(net);
    });
    if (!hasNonGnd) continue;

    // Compute courtyard AABB from ALL pads (not just non-GND) to prevent
    // copper flowing between any pads of the same component
    let minLx = Infinity, minLy = Infinity, maxLx = -Infinity, maxLy = -Infinity;
    for (const pad of fp.pads) {
      const hw = pad.w / 2;
      const hh = pad.h / 2;
      minLx = Math.min(minLx, pad.x - hw);
      minLy = Math.min(minLy, pad.y - hh);
      maxLx = Math.max(maxLx, pad.x + hw);
      maxLy = Math.max(maxLy, pad.y + hh);
    }
    const totalClear = clearMm + courtyardExtra;

    // Transform local courtyard corners to world, then take world AABB
    const corners = [
      [minLx - totalClear, minLy - totalClear],
      [maxLx + totalClear, minLy - totalClear],
      [maxLx + totalClear, maxLy + totalClear],
      [minLx - totalClear, maxLy + totalClear],
    ];
    let minWX = Infinity, maxWX = -Infinity, minWY = Infinity, maxWY = -Infinity;
    for (const [lx, ly2] of corners) {
      const [wx, wy] = fpLocalToWorld(pl, lx, ly2);
      minWX = Math.min(minWX, wx);
      maxWX = Math.max(maxWX, wx);
      minWY = Math.min(minWY, wy);
      maxWY = Math.max(maxWY, wy);
    }
    ox.fillRect(minWX, minWY, maxWX - minWX, maxWY - minWY);
  }

  // 2b. Individual non-GND pad cutouts (handles pads outside any component courtyard,
  //     e.g. test points, and provides conformal clearance for rotated pads)
  for (const pl of doc.placements || []) {
    const plLayer = pl.layer || 'F.Cu';
    if (plLayer !== ly) continue; // Only carve pads on this copper layer
    const fp = getFootprint(pl.footprintId);
    if (!fp?.pads?.length) continue;
    const nets = pl.padNets || {};
    const compRot = Number(pl.rot) || 0;
    for (const pad of fp.pads) {
      const net = nets[pad.num] || nets[pad.id];
      if (!isNonGndNet(net)) continue;
      const [px, py] = padWorld(pl, pad);
      const hw = pad.w / 2 + clearMm;
      const hh = pad.h / 2 + clearMm;
      // For rotated components, draw a rotated rectangle
      ox.save();
      ox.translate(px, py);
      if (compRot) ox.rotate(compRot * Math.PI / 180);
      ox.fillRect(-hw, -hh, hw * 2, hh * 2);
      ox.restore();
    }
  }

  // 2c. Non-GND vias (circular clearance)
  for (const v of doc.vias || []) {
    if (!isNonGndNet(v.net)) continue;
    const ro = (Number(v.diamMm) || 0.8) / 2 + clearMm;
    ox.beginPath();
    ox.arc(v.x, v.y, ro, 0, Math.PI * 2);
    ox.fill();
  }

  // 2d. Non-GND tracks — Manhattan: axis-aligned rects; diagonal: thick stroke
  for (const tr of doc.tracks || []) {
    if (tr.layer !== ly) continue;
    if (!isNonGndNet(tr.net)) continue;
    const tpts = dedupeConsecutiveTrackPoints(tr.points || []);
    if (tpts.length < 2) continue;
    const tw = Number(tr.widthMm) || 0.35;
    const halfW = tw / 2 + clearMm;
    const carveOverlap = Math.max(0.002, 1 / density);
    if (trackPolylineIsManhattan(tpts)) {
      carveManhattanTrackClearanceRects(ox, tpts, halfW, carveOverlap);
    } else {
      ox.lineCap = 'round';
      ox.lineJoin = 'round';
      ox.lineWidth = 2 * halfW;
      ox.beginPath();
      ox.moveTo(tpts[0][0], tpts[0][1]);
      for (let i = 1; i < tpts.length; i++) ox.lineTo(tpts[i][0], tpts[i][1]);
      ox.stroke();
    }
  }

  // 2e. Thermal relief for GND pads — four diagonal carve wedges around each
  //     GND pad so the pour connects via narrow spokes, not a solid flood.
  //     This is the standard Eagle/KiCad thermal relief pattern.
  const thermalGap = clearMm * 0.6;    // gap width between spokes
  const thermalOuter = clearMm * 1.2;  // outer carve radius beyond pad
  for (const pl of doc.placements || []) {
    const plLayer = pl.layer || 'F.Cu';
    if (plLayer !== ly) continue; // Thermal relief only for pads on this layer
    const fp = getFootprint(pl.footprintId);
    if (!fp?.pads?.length) continue;
    const nets = pl.padNets || {};
    for (const pad of fp.pads) {
      const net = nets[pad.num] || nets[pad.id];
      // Only draw thermal relief for GND pads (net '0')
      if (isNonGndNet(net)) continue;
      if (net == null || net === '') continue; // skip unassigned
      const [px, py] = padWorld(pl, pad);
      const pr = Math.max(pad.w, pad.h) / 2;
      const outerR = pr + thermalOuter;
      const gapHalf = thermalGap / 2;
      // Carve four wedge strips (vertical + horizontal gaps between spokes)
      // Vertical gap (top-bottom)
      ox.fillRect(px - gapHalf, py - outerR, gapHalf * 2, outerR * 2);
      // Horizontal gap (left-right)
      ox.fillRect(px - outerR, py - gapHalf, outerR * 2, gapHalf * 2);
    }
  }

  ox.globalCompositeOperation = 'source-over';

  const fillAlpha = isSel ? 0.7 : Math.max(0.5, polyFill * 2.0);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.clip();
  const prevSmooth = ctx.imageSmoothingEnabled;
  const prevQuality = ctx.imageSmoothingQuality;
  // Bilinear: Manhattan carve is all orthogonal — avoids stair-step “hairlines” vs NN upscale.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = fillAlpha;
  ctx.drawImage(osc, 0, 0, pw, ph, 0, 0, boardW, boardH);
  ctx.imageSmoothingEnabled = prevSmooth;
  ctx.imageSmoothingQuality = prevQuality;
  ctx.globalAlpha = 1;
  ctx.restore();

  // Outline stroke
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.strokeStyle = isSel ? selStroke : layerColor;
  ctx.lineWidth = isSel ? lineWidthScreenPx(2, scale) : lineWidthScreenPx(1.25, scale);
  ctx.setLineDash([]);
  ctx.stroke();

  // Cross-select highlight
  if (schLink && !isSel) {
    ctx.strokeStyle = 'rgba(192,132,252,0.88)';
    ctx.lineWidth = lineWidthScreenPx(1.35, scale);
    ctx.setLineDash(dashScreenPx([5.5, 3.5], scale));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

/* ─── Main render function ─── */
/**
 * Render the entire PCB board onto a Canvas 2D context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} params
 */
export function renderPcbCanvas(ctx, params) {
  const {
    doc,
    viewport,       // { zoom, panX, panY }
    canvasWidth,     // pixel width of canvas element
    canvasHeight,    // pixel height of canvas element
    activeLayer,
    selected = [],
    routeDraft = null,
    polygonDraft = null,
    boardPreview = {},
    showBoardGrid = true,
    drcViolations = [],
    /** @type {Map<string, number[][]>} net → hub [x,y] per island (connectivity-filtered before draw). */
    padCentersByNet = new Map(),
    schCrossRefs = new Set(),
    schCrossNets = new Set(),
    measureStart = null,
    measureEnd = null,
    boardCursorMm = null,
    lockedLayers = new Set(),
    selectedRatsnestNets = new Set(),
    boxSelectRect = null,
    dpr = window.devicePixelRatio || 1,
  } = params;

  if (!doc?.meta || !viewport || !(viewport.zoom > 0) || canvasWidth <= 0 || canvasHeight <= 0) {
    return;
  }

  const W = Number(doc.meta.boardWmm) || 80;
  const H = Number(doc.meta.boardHmm) || 50;
  const copperStack = activeCopperLayerIds(doc);
  const layerDrawOrder = [...copperStack].reverse();
  const inactiveCopperOpacity = boardPreview.brightInactiveLayers ? 0.9 : 0.4;
  const ui = paletteForBoardPreview(boardPreview);

  // Selection helpers
  const selSet = new Set(selected.map(s => `${s.kind}:${s.id}`));
  const isSelected = (kind, id) => selSet.has(`${kind}:${id}`);

  // Viewport background (fills letterbox outside board — avoids muddy transparent edges)
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const bufW = canvasWidth * dpr;
  const bufH = canvasHeight * dpr;
  ctx.fillStyle = ui.voidFill;
  ctx.fillRect(0, 0, bufW, bufH);
  ctx.restore();

  // Set up viewport transform: board mm → canvas pixels
  ctx.save();
  const scaleX = (canvasWidth * dpr) / (W / viewport.zoom);
  const scaleY = (canvasHeight * dpr) / (H / viewport.zoom);
  const scale = Math.min(scaleX, scaleY);
  ctx.setTransform(scale, 0, 0, scale, -viewport.panX * scale, -viewport.panY * scale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // ─── Board background (working copper area) ───
  if (ui.cad) {
    // Smooth diagonal only — avoid partial fillRects (they caused hard horizontal bands at ~42% H).
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#181c26');
    g.addColorStop(1, '#11141c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.045)';
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = '#071210';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(12, 38, 24, 0.72)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.fillRect(0, 0, W, H);
  }

  // ─── Grid + datum axes (CAD) ───
  if (showBoardGrid) {
    drawGrid(ctx, W, H, doc.meta?.gridMm || 0.5, viewport.zoom, scale, ui);
  }
  drawCadDatumDecoration(ctx, W, H, scale, ui);

  // ─── Copper layers (bottom to top) ───
  for (const ly of layerDrawOrder) {
    if (!isCopperLayerVisible(doc, ly)) continue;
    const isActive = ly === activeLayer;
    const opacity = isActive ? 1 : inactiveCopperOpacity;
    const layerColor = PCB_LAYER_COLORS[ly] || '#94a3b8';

    ctx.save();
    ctx.globalAlpha = opacity;

    // Polygons / zones (stay dimmer on inactive layers)
    for (const poly of (doc.polygons || [])) {
      if (poly.layer !== ly) continue;
      const pts = poly.points || [];
      if (pts.length < 3) continue;
      const isSel = isSelected('polygon', poly.id);
      const schLink = poly.net && schCrossNets.has(String(poly.net).toLowerCase());
      const polyFill = isActive ? 0.34 : boardPreview.brightInactiveLayers ? 0.22 : 0.12;

      if (poly.id === NOZE_GND_PLANE_ID && String(poly.net || '') === '0') {
        drawGndPlaneWithClearanceCarve(ctx, poly, ly, layerColor, polyFill, doc, isSel, schLink, ui.selStroke, scale);
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = hexToRgba(layerColor, polyFill);
      ctx.fill();
      // Zone outline: always this layer’s copper hue (not net-based).
      ctx.strokeStyle = isSel ? ui.selStroke : layerColor;
      ctx.lineWidth = isSel ? lineWidthScreenPx(2, scale) : lineWidthScreenPx(1.25, scale);
      ctx.stroke();
      if (schLink && !isSel) {
        ctx.strokeStyle = 'rgba(192,132,252,0.88)';
        ctx.lineWidth = lineWidthScreenPx(1.35, scale);
        ctx.setLineDash(dashScreenPx([5.5, 3.5], scale));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.restore();

    // Tracks: keep layer hue readable even when layer is not active (F.Cu vs B.Cu etc.)
    const trackAlpha = isActive ? 1 : Math.min(1, inactiveCopperOpacity + 0.5);
    ctx.save();
    ctx.globalAlpha = trackAlpha;
    const tracksThisLayer = (doc.tracks || []).filter((tr) => tr.layer === ly);
    const trackBuckets = new Map();
    for (const tr of tracksThisLayer) {
      const isSel = isSelected('track', tr.id);
      const schLink = !!(tr.net && schCrossNets.has(String(tr.net).toLowerCase()));
      const net = String(tr.net || '');
      const twKey = Number(tr.widthMm) || 0.35;
      const key = `${net}\0${twKey}\0${isSel ? 1 : 0}\0${schLink ? 1 : 0}`;
      if (!trackBuckets.has(key)) trackBuckets.set(key, []);
      trackBuckets.get(key).push(tr);
    }
    for (const group of trackBuckets.values()) {
      const mergedItems = mergeTrackPolylinesForDraw(group).filter((x) => x.pts.length >= 2);
      if (!mergedItems.length) continue;
      const tr0 = mergedItems[0].tr;
      const isSel = isSelected('track', tr0.id);
      const schLink = tr0.net && schCrossNets.has(String(tr0.net).toLowerCase());
      const traceCol = PCB_TRACE_LAYER_COLORS[ly] || layerColor;
      const tw = tr0.widthMm || 0.35;
      const halfW = tw / 2;

      if (isSel) {
        drawTrackGroupCopperFill(ctx, mergedItems, ui.selGlow, halfW + Math.max(0.2, tw * 0.55));
        drawTrackGroupCopperFill(ctx, mergedItems, ui.selTrack, halfW + 0.04);
      } else {
        drawTrackGroupCopperFill(ctx, mergedItems, traceCol, halfW);
      }
      if (schLink && !isSel) {
        drawTrackGroupSchDashOverlay(ctx, mergedItems, scale);
      }
    }

    ctx.restore();
  }

  // ─── Vias ───
  const anyCopperVisible = copperStack.some(ly => isCopperLayerVisible(doc, ly));
  if (anyCopperVisible) {
    for (const v of (doc.vias || [])) {
      drawVia(ctx, v, doc, copperStack, isSelected('via', v.id),
        v.net && schCrossNets.has(String(v.net).toLowerCase()), ui.selStroke, scale);
    }
  }

  // ─── Pads (draw per-layer: bottom first, then top, so top overlaps) ───
  for (const drawSide of ['B.Cu', 'F.Cu']) {
    for (const pl of (doc.placements || [])) {
      const plLayer = pl.layer || 'F.Cu';
      if (plLayer !== drawSide) continue;
      const fp = getFootprint(pl.footprintId);
      if (!fp?.pads) continue;
      const isPlOnActive = plLayer === activeLayer;
      const padAlpha = isPlOnActive ? 1 : inactiveCopperOpacity;
      // SMD pads use the placement's layer color; through-hole pads always show
      const padFill = plLayer === 'B.Cu' ? '#9b59b6' : '#b87333';
      const padStroke = plLayer === 'B.Cu' ? '#6c3483' : '#7c4b12';
      ctx.save();
      ctx.globalAlpha = padAlpha;
      for (const pad of fp.pads) {
        const [px, py] = padWorld(pl, pad);
        const rot = (Number(pl.rot) || 0) % 360;
        ctx.save();
        ctx.translate(px, py);
        if (rot && Math.abs(pad.w - pad.h) > 0.001) {
          ctx.rotate(rot * Math.PI / 180);
        }
        ctx.fillStyle = padFill;
        ctx.fillRect(-pad.w / 2, -pad.h / 2, pad.w, pad.h);
        ctx.strokeStyle = padStroke;
        ctx.lineWidth = hairlineMm(scale, 0.85);
        ctx.strokeRect(-pad.w / 2, -pad.h / 2, pad.w, pad.h);
        if (pad.num && scale > 15) {
          ctx.fillStyle = '#fff';
          ctx.font = `bold ${Math.min(pad.w, pad.h) * 0.5}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(pad.num, 0, 0);
        }
        ctx.restore();
      }
      ctx.restore();
    }
  }

  // ─── Solder mask ───
  if (boardPreview.solderMask) {
    drawSolderMask(ctx, doc, W, H);
  }

  // ─── Silkscreen ───
  drawSilkscreen(ctx, doc, boardPreview, scale, viewport);

  // ─── Board frame + dimensions ───
  drawBoardFrame(ctx, W, H, scale, ui);

  // ─── Ratsnest (unrouted pad islands) ───
  drawRatsnest(ctx, padCentersByNet, schCrossNets, {
    emphasize: Boolean(boardPreview.highlightUnrouted),
    selectedNets: selectedRatsnestNets,
    scale,
  });

  // ─── Selection overlay ───
  for (const pl of (doc.placements || [])) {
    const isSel = isSelected('placement', pl.id);
    const schRef = pl.ref && schCrossRefs.has(String(pl.ref).toUpperCase());
    if (!isSel && !schRef) continue;
    const b = footprintBBox(pl);
    const pad = isSel ? 0.3 : 0.35;
    ctx.strokeStyle = isSel ? ui.selStroke : ui.schRef;
    ctx.lineWidth = isSel ? lineWidthScreenPx(1.5, scale) : lineWidthScreenPx(1.75, scale);
    ctx.setLineDash(dashScreenPx([5, 3.5], scale));
    ctx.strokeRect(b.minX - pad, b.minY - pad, b.maxX - b.minX + 2 * pad, b.maxY - b.minY + 2 * pad);
    ctx.setLineDash([]);
  }

  // ─── Box-select rubber band ───
  if (boxSelectRect) {
    const bx = Math.min(boxSelectRect.x1, boxSelectRect.x2);
    const by = Math.min(boxSelectRect.y1, boxSelectRect.y2);
    const bw = Math.abs(boxSelectRect.x2 - boxSelectRect.x1);
    const bh = Math.abs(boxSelectRect.y2 - boxSelectRect.y1);
    ctx.fillStyle = ui.boxFill;
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = ui.boxSelect;
    ctx.lineWidth = lineWidthScreenPx(1.65, scale);
    ctx.setLineDash(dashScreenPx([6, 4], scale));
    ctx.strokeRect(bx, by, bw, bh);
    ctx.setLineDash([]);
  }

  // ─── Route draft (color = active copper layer; changes after Via / V) ───
  if (routeDraft?.length) {
    const trackW = doc.meta?.defaultTrackMm || 0.35;
    const draftColor = PCB_TRACE_LAYER_COLORS[activeLayer] || PCB_LAYER_COLORS[activeLayer] || '#a855f7';
    const draftAsItems = [{ tr: {}, pts: routeDraft }];
    const hw = trackW / 2;
    drawTrackGroupCopperFill(ctx, draftAsItems, 'rgba(0,0,0,0.32)', hw + Math.max(0.04, trackW * 0.14));
    drawTrackGroupCopperFill(ctx, draftAsItems, draftColor, hw);
    // Draw vertex dots
    for (const pt of routeDraft) {
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], trackW * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = 0.5;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // Rubber-band to cursor (free-angle routing)
    if (boardCursorMm) {
      const last = routeDraft[routeDraft.length - 1];
      const prev = routeDraft.length >= 2 ? routeDraft[routeDraft.length - 2] : null;
      let [ex, ey] = snapInteractiveRoutePoint(prev, last, boardCursorMm[0], boardCursorMm[1], {
        gridMm: doc.meta?.gridMm ?? 0.5,
        snapToGrid: doc.meta?.snapToGrid !== false,
        routeFreeAngle: doc.meta?.routeFreeAngle === true,
      });
      const g = Number(doc.meta?.gridMm) > 0 ? Number(doc.meta.gridMm) : 0.5;
      const sn = doc.meta?.snapToGrid !== false;
      ex = snapBoard(ex, g, sn);
      ey = snapBoard(ey, g, sn);
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = hexToRgba(draftColor, 0.6);
      ctx.lineWidth = trackW;
      ctx.lineCap = 'round';
      ctx.setLineDash(dashScreenPx([5, 3.5], scale));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ─── Polygon draft ───
  if (polygonDraft?.length) {
    ctx.beginPath();
    ctx.moveTo(polygonDraft[0][0], polygonDraft[0][1]);
    for (let i = 1; i < polygonDraft.length; i++) ctx.lineTo(polygonDraft[i][0], polygonDraft[i][1]);
    // Rubber-band to cursor
    if (boardCursorMm) ctx.lineTo(boardCursorMm[0], boardCursorMm[1]);
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = lineWidthScreenPx(2, scale);
    ctx.setLineDash(dashScreenPx([5, 3.5], scale));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.setLineDash([]);
    // Close preview
    if (polygonDraft.length >= 3 && boardCursorMm) {
      ctx.beginPath();
      ctx.moveTo(boardCursorMm[0], boardCursorMm[1]);
      ctx.lineTo(polygonDraft[0][0], polygonDraft[0][1]);
      ctx.strokeStyle = 'rgba(52,211,153,0.3)';
      ctx.lineWidth = lineWidthScreenPx(1.35, scale);
      ctx.setLineDash(dashScreenPx([4, 3], scale));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ─── DRC violations ───
  for (const v of drcViolations) {
    ctx.beginPath();
    ctx.arc(v.x, v.y, 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = lineWidthScreenPx(3, scale);
    ctx.setLineDash(dashScreenPx([6, 5], scale));
    ctx.stroke();
    ctx.setLineDash([]);
    if (scale > 5) {
      ctx.fillStyle = '#ef4444';
      ctx.font = `bold 1px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(v.type || 'DRC', v.x, v.y - 2);
    }
  }

  // ─── Measure tool ───
  drawMeasureTool(ctx, measureStart, measureEnd, boardCursorMm, scale);

  // ─── Crosshair cursor ───
  if (boardCursorMm) {
    ctx.save();
    ctx.strokeStyle = 'rgba(226,232,240,0.22)';
    ctx.lineWidth = hairlineMm(scale, 0.65);
    ctx.setLineDash(dashScreenPx([6, 5], scale));
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(boardCursorMm[0], 0);
    ctx.lineTo(boardCursorMm[0], H);
    ctx.moveTo(0, boardCursorMm[1]);
    ctx.lineTo(W, boardCursorMm[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  ctx.restore();
}

/* ─── Grid drawing ─── */
function drawGrid(ctx, W, H, gridMm, zoom, scale, ui) {
  const minPixelSpacing = ui.gridMinSpacing;
  let step = gridMm;
  while (step * scale < minPixelSpacing) step *= 5;

  const minorW = hairlineMm(scale, ui.cad ? 0.68 : 0.72);
  const majorW = hairlineMm(scale, ui.cad ? 1.22 : 1.15);
  const superW = hairlineMm(scale, ui.cad ? 1.45 : 1.15);

  const minorCol = ui.cad ? 'rgba(255,255,255,0.045)' : 'rgba(148,163,184,0.1)';
  const majorCol = ui.cad ? 'rgba(226,232,240,0.12)' : 'rgba(203,213,225,0.22)';
  const superCol = ui.cad ? 'rgba(248, 250, 252, 0.2)' : majorCol;

  ctx.save();
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';

  const majorEvery = 5;
  const superEvery = 10;

  let ix = 0;
  for (let gx = 0; gx <= W + 1e-9; gx += step, ix++) {
    const sup = ui.cad && ix > 0 && ix % superEvery === 0;
    const major = ix % majorEvery === 0;
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, H);
    ctx.strokeStyle = sup ? superCol : (major ? majorCol : minorCol);
    ctx.lineWidth = sup ? superW : (major ? majorW : minorW);
    ctx.stroke();
  }
  let iy = 0;
  for (let gy = 0; gy <= H + 1e-9; gy += step, iy++) {
    const sup = ui.cad && iy > 0 && iy % superEvery === 0;
    const major = iy % majorEvery === 0;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(W, gy);
    ctx.strokeStyle = sup ? superCol : (major ? majorCol : minorCol);
    ctx.lineWidth = sup ? superW : (major ? majorW : minorW);
    ctx.stroke();
  }
  ctx.restore();
}

/** Datum axes along bottom-left (0,0) — full board extents, CAD-style. */
function drawCadDatumDecoration(ctx, W, H, scale, ui) {
  if (!ui.cad) return;
  const w = hairlineMm(scale, 0.52);
  ctx.save();
  ctx.lineCap = 'square';
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.16)';
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(W, 0);
  ctx.moveTo(0, 0);
  ctx.lineTo(0, H);
  ctx.stroke();
  ctx.fillStyle = 'rgba(251, 191, 36, 0.82)';
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(0.2, 1.35 / scale), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ─── Via drawing ─── */
function drawVia(ctx, v, doc, copperStack, isSel, schLink, selStroke = '#f472b6', scale = 12) {
  const diam = Number(v.diamMm) || Number(doc.meta?.defaultViaDiamMm) || 0.8;
  const drill = Number(v.drillMm) || Number(doc.meta?.defaultViaDrillMm) || 0.4;
  const ro = diam / 2;
  const holeR = Math.max(0.05, drill / 2);
  const barrelR = Math.max(holeR + 0.04, ro - 0.06);

  // Barrel fill
  ctx.beginPath();
  ctx.arc(v.x, v.y, barrelR, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(201,162,39,${isSel ? 0.5 : 0.38})`;
  ctx.fill();
  ctx.strokeStyle = '#8b6914';
  ctx.lineWidth = hairlineMm(scale, 0.5);
  ctx.stroke();

  // Layer rings: stack is top → bottom (F.Cu … B.Cu); draw outer ring = top copper color
  const visStack = copperStack.filter(ly => isCopperLayerVisible(doc, ly));
  for (let idx = 0; idx < visStack.length; idx++) {
    const rr = ro - 0.04 - idx * 0.055;
    if (rr < holeR + 0.02) break;
    ctx.beginPath();
    ctx.arc(v.x, v.y, rr, 0, Math.PI * 2);
    ctx.strokeStyle = PCB_TRACE_LAYER_COLORS[visStack[idx]] || PCB_LAYER_COLORS[visStack[idx]] || '#94a3b8';
    ctx.lineWidth = lineWidthScreenPx(1.15, scale);
    ctx.globalAlpha = isSel ? 0.95 : 0.78;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Outer ring (neutral barrel edge — not net-colored)
  ctx.beginPath();
  ctx.arc(v.x, v.y, ro, 0, Math.PI * 2);
  ctx.strokeStyle = isSel ? selStroke : '#e8c48a';
  ctx.lineWidth = lineWidthScreenPx(1.5, scale);
  ctx.stroke();
  if (schLink && !isSel) {
    ctx.beginPath();
    ctx.arc(v.x, v.y, ro + 0.05, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(192,132,252,0.9)';
    ctx.lineWidth = lineWidthScreenPx(1.05, scale);
    ctx.setLineDash(dashScreenPx([4, 3], scale));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Drill hole
  ctx.beginPath();
  ctx.arc(v.x, v.y, holeR, 0, Math.PI * 2);
  ctx.fillStyle = '#050806';
  ctx.fill();
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = hairlineMm(scale, 0.55);
  ctx.stroke();
}

/**
 * Solder mask sits above outer copper: covered traces/pour read as mask green;
 * only pad and via openings expose copper (typical fab stack).
 */
function drawSolderMask(ctx, doc, W, H) {
  const expand = 0.12;
  const maskColor = 'rgba(13,79,45,0.9)';

  // Draw mask as a path with cutouts using even-odd fill rule
  ctx.save();
  ctx.beginPath();
  // Outer rectangle (clockwise)
  ctx.moveTo(0, 0);
  ctx.lineTo(W, 0);
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();

  // Cut out pad openings (counter-clockwise for even-odd)
  for (const pl of (doc.placements || [])) {
    const fp = getFootprint(pl.footprintId);
    if (!fp?.pads?.length) continue;
    for (const pad of fp.pads) {
      const [px, py] = padWorld(pl, pad);
      const hw = pad.w / 2 + expand;
      const hh = pad.h / 2 + expand;
      // Counter-clockwise rect cutout
      ctx.moveTo(px - hw, py - hh);
      ctx.lineTo(px - hw, py + hh);
      ctx.lineTo(px + hw, py + hh);
      ctx.lineTo(px + hw, py - hh);
      ctx.closePath();
    }
  }

  // Cut out via openings
  for (const v of (doc.vias || [])) {
    const diam = Number(v.diamMm) || Number(doc.meta?.defaultViaDiamMm) || 0.8;
    const r = diam / 2 + expand;
    // Counter-clockwise arc for cutout
    ctx.moveTo(v.x + r, v.y);
    ctx.arc(v.x, v.y, r, 0, Math.PI * 2, true);
    ctx.closePath();
  }

  ctx.fillStyle = maskColor;
  ctx.fill('evenodd');
  ctx.restore();
}

/* ─── Silkscreen ─── */
function drawSilkscreen(ctx, doc, boardPreview, scale, viewport = {}) {
  const cad = boardPreview.cadWorkbench !== false;
  const silkW = lineWidthScreenPx(
    boardPreview.boldSilk ? (cad ? 1.25 : 1.35) : (cad ? 1.0 : 1.05),
    scale,
  );
  const silkCol = boardPreview.boldSilk
    ? (cad ? '#f1f5f9' : '#f8fafc')
    : (cad ? '#d8dee9' : '#cbd5e1');

  const panX = Number(viewport.panX) || 0;
  const panY = Number(viewport.panY) || 0;
  /**
   * Refdes: scale ~with board (mm → px via `scale`) but clamp so it stays readable zoomed in
   * and does not dominate the view zoomed out.
   */
  const refMm = boardPreview.boldSilk ? 0.62 : 0.58;

  for (const pl of (doc.placements || [])) {
    const fp = getFootprint(pl.footprintId);
    // Silk lines
    if (fp?.silk?.length) {
      ctx.strokeStyle = silkCol;
      ctx.lineWidth = silkW;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.95;
      for (const ln of fp.silk) {
        if (ln?.kind !== 'line') continue;
        const [x1, y1] = fpLocalToWorld(pl, ln.x1, ln.y1);
        const [x2, y2] = fpLocalToWorld(pl, ln.x2, ln.y2);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // Reference designator: draw in device space so zoom does not inflate glyphs
    const isBot = (pl.layer || 'F.Cu') === 'B.Cu';
    const refCol = isBot ? '#d8b4fe' : (boardPreview.boldSilk ? '#ffffff' : '#e2e8f0');
    const bx = pl.x;
    const by = pl.y - 2;
    const sx = (bx - panX) * scale;
    const sy = (by - panY) * scale;
    const label = (pl.ref || '') + (isBot ? ' [B]' : '');
    let refFontPx = Math.round(refMm * scale);
    refFontPx = Math.max(10, Math.min(18, refFontPx));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = refCol;
    ctx.font = `${boardPreview.boldSilk ? 'bold ' : ''}${refFontPx}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, sx, sy);
    ctx.restore();
  }
}

/* ─── Board outline (Edge.Cuts preview) — no schematic-style title block ─── */
function drawBoardFrame(ctx, W, H, scale, ui) {
  const edgeW = lineWidthScreenPx(ui.cad ? 2.5 : 2.2, scale);
  const innerW = lineWidthScreenPx(1.5, scale);
  const tickW = lineWidthScreenPx(1.75, scale);
  const originW = lineWidthScreenPx(1.45, scale);

  ctx.save();
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';

  // Edge.Cuts outline
  ctx.strokeStyle = ui.cad ? '#e8d35c' : '#facc15';
  ctx.lineWidth = edgeW;
  ctx.strokeRect(0, 0, W, H);

  // Inner dashed outline (keep-out / fab)
  ctx.strokeStyle = ui.cad ? 'rgba(245, 158, 11, 0.55)' : 'rgba(217, 119, 6, 0.92)';
  ctx.lineWidth = innerW;
  ctx.setLineDash(dashScreenPx([9, 5.5], scale));
  ctx.globalAlpha = ui.cad ? 0.72 : 0.88;
  ctx.strokeRect(0.22, 0.22, W - 0.44, H - 0.44);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Corner ticks
  const tick = 1.1;
  ctx.strokeStyle = ui.cad ? '#fef3c7' : '#fde68a';
  ctx.lineWidth = tickW;
  ctx.beginPath();
  ctx.moveTo(0, tick); ctx.lineTo(0, 0); ctx.lineTo(tick, 0);
  ctx.moveTo(W - tick, 0); ctx.lineTo(W, 0); ctx.lineTo(W, tick);
  ctx.moveTo(W, H - tick); ctx.lineTo(W, H); ctx.lineTo(W - tick, H);
  ctx.moveTo(tick, H); ctx.lineTo(0, H); ctx.lineTo(0, H - tick);
  ctx.stroke();

  // Micro origin crosshair (legacy); CAD mode uses drawCadDatumDecoration instead
  if (!ui.cad) {
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.85)';
    ctx.lineWidth = originW;
    ctx.globalAlpha = 0.92;
    ctx.beginPath();
    ctx.moveTo(-0.35, 0); ctx.lineTo(1.15, 0);
    ctx.moveTo(0, -0.35); ctx.lineTo(0, 1.15);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/* ─── Ratsnest (airwires): neon green idle; yellow when selected or “highlight unrouted”. ─── */
function drawRatsnest(ctx, padCentersByNet, schCrossNets, options = {}) {
  const emphasize = Boolean(options.emphasize);
  const selectedNets = options.selectedNets || new Set();
  const scale = Number(options.scale) > 0 ? options.scale : 8;
  const glowBlur = 14 / Math.max(1e-9, scale);
  for (const [net, pts] of padCentersByNet) {
    if (pts.length < 2) continue;
    const hub = pts[0];
    const linkNet = schCrossNets.has(String(net).toLowerCase());
    const isSel = selectedNets.has(String(net));
    if (isSel) {
      ctx.strokeStyle = linkNet ? 'rgba(255, 255, 80, 0.98)' : 'rgba(255, 255, 0, 0.96)';
      ctx.lineWidth = linkNet ? lineWidthScreenPx(2.35, scale) : lineWidthScreenPx(1.95, scale);
      ctx.setLineDash(dashScreenPx([5.5, 3], scale));
    } else if (emphasize) {
      ctx.strokeStyle = linkNet ? 'rgba(255, 255, 100, 0.97)' : 'rgba(255, 255, 0, 0.94)';
      ctx.lineWidth = linkNet ? lineWidthScreenPx(3.1, scale) : lineWidthScreenPx(2.55, scale);
      ctx.setLineDash(dashScreenPx([6, 3], scale));
    } else {
      ctx.strokeStyle = linkNet ? 'rgba(57, 255, 20, 0.92)' : 'rgba(0, 255, 170, 0.88)';
      ctx.lineWidth = linkNet ? lineWidthScreenPx(2.1, scale) : lineWidthScreenPx(1.65, scale);
      ctx.setLineDash(dashScreenPx([5.5, 2.8], scale));
    }
    const hotGlow = isSel || emphasize;
    ctx.shadowBlur = hotGlow ? glowBlur * 1.15 : glowBlur;
    ctx.shadowColor = hotGlow ? 'rgba(255, 255, 0, 0.75)' : 'rgba(0, 255, 140, 0.65)';
    for (let i = 1; i < pts.length; i++) {
      ctx.beginPath();
      ctx.moveTo(hub[0], hub[1]);
      ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }
  if (emphasize && selectedNets.size === 0) {
    const r = 0.28;
    ctx.shadowBlur = glowBlur * 1.1;
    ctx.shadowColor = 'rgba(255, 255, 0, 0.7)';
    for (const [, pts] of padCentersByNet) {
      if (pts.length < 2) continue;
      for (const [x, y] of pts) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 0, 0.62)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 120, 0.95)';
        ctx.lineWidth = lineWidthScreenPx(1.2, scale);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }
}

/* ─── Measure tool ─── */
function drawMeasureTool(ctx, start, end, cursor, scale) {
  if (start && end) {
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    ctx.lineTo(end[0], end[1]);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = lineWidthScreenPx(1.65, scale);
    ctx.stroke();

    // Endpoints
    for (const p of [start, end]) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], 0.35, 0, Math.PI * 2);
      ctx.fillStyle = '#fef08a';
      ctx.fill();
      ctx.strokeStyle = '#b45309';
      ctx.lineWidth = lineWidthScreenPx(1, scale);
      ctx.stroke();
    }

    // Distance label
    const dist = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (scale > 3) {
      ctx.fillStyle = '#fef9c3';
      ctx.font = 'bold 2px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${dist.toFixed(3)} mm`, (start[0] + end[0]) / 2, (start[1] + end[1]) / 2 - 0.45);
    }
  } else if (start && cursor) {
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    ctx.lineTo(cursor[0], cursor[1]);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = lineWidthScreenPx(1.45, scale);
    ctx.setLineDash(dashScreenPx([5.5, 3.5], scale));
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(start[0], start[1], 0.35, 0, Math.PI * 2);
    ctx.fillStyle = '#fef08a';
    ctx.fill();
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = lineWidthScreenPx(1, scale);
    ctx.stroke();
  }
}

/* ─── Hit testing for canvas (replaces SVG DOM events) ─── */
/**
 * Convert canvas pixel coordinates to board mm coordinates.
 */
export function canvasToBoard(canvasX, canvasY, viewport, canvasWidth, canvasHeight, boardW, boardH, dpr = 1) {
  const scaleX = (canvasWidth * dpr) / (boardW / viewport.zoom);
  const scaleY = (canvasHeight * dpr) / (boardH / viewport.zoom);
  const scale = Math.min(scaleX, scaleY);
  const boardX = (canvasX * dpr) / scale + viewport.panX;
  const boardY = (canvasY * dpr) / scale + viewport.panY;
  return [boardX, boardY];
}

/**
 * Convert board mm to canvas pixel coordinates.
 */
export function boardToCanvas(boardX, boardY, viewport, canvasWidth, canvasHeight, boardW, boardH, dpr = 1) {
  const scaleX = (canvasWidth * dpr) / (boardW / viewport.zoom);
  const scaleY = (canvasHeight * dpr) / (boardH / viewport.zoom);
  const scale = Math.min(scaleX, scaleY);
  const cx = (boardX - viewport.panX) * scale / dpr;
  const cy = (boardY - viewport.panY) * scale / dpr;
  return [cx, cy];
}
