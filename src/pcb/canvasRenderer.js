/**
 * Professional Canvas 2D Renderer for PCB Studio.
 * Replaces SVG rendering with high-performance hardware-accelerated Canvas 2D.
 * Handles: grid, layers, tracks, vias, pads, polygons, silkscreen, board frame,
 * selection highlights, DRC markers, ratsnest (unconnected pad islands), measure tool, and draft previews.
 */

import { getFootprint } from './footprintLib.js';
import { activeCopperLayerIds, getCopperLayerDisplayName, isCopperLayerVisible } from './pcbDoc.js';
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

function drawGndPlaneWithClearanceCarve(ctx, poly, ly, layerColor, polyFill, doc, isSel, schLink) {
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
  for (const pl of doc.placements || []) {
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
  ctx.strokeStyle = isSel ? '#f472b6' : layerColor;
  ctx.lineWidth = isSel ? 0.14 : 0.08;
  ctx.setLineDash([]);
  ctx.stroke();

  // Cross-select highlight
  if (schLink && !isSel) {
    ctx.strokeStyle = 'rgba(192,132,252,0.88)';
    ctx.lineWidth = 0.1;
    ctx.setLineDash([0.35, 0.22]);
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

  // Selection helpers
  const selSet = new Set(selected.map(s => `${s.kind}:${s.id}`));
  const isSelected = (kind, id) => selSet.has(`${kind}:${id}`);

  // Clear canvas
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvasWidth * dpr, canvasHeight * dpr);
  ctx.restore();

  // Set up viewport transform: board mm → canvas pixels
  ctx.save();
  const scaleX = (canvasWidth * dpr) / (W / viewport.zoom);
  const scaleY = (canvasHeight * dpr) / (H / viewport.zoom);
  const scale = Math.min(scaleX, scaleY);
  ctx.setTransform(scale, 0, 0, scale, -viewport.panX * scale, -viewport.panY * scale);

  // ─── Board background ───
  ctx.fillStyle = '#0b1a12';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(15,41,25,0.55)';
  ctx.fillRect(0, 0, W, H);

  // ─── Grid ───
  if (showBoardGrid) {
    drawGrid(ctx, W, H, doc.meta?.gridMm || 0.5, viewport.zoom, scale);
  }

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
        drawGndPlaneWithClearanceCarve(ctx, poly, ly, layerColor, polyFill, doc, isSel, schLink);
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = hexToRgba(layerColor, polyFill);
      ctx.fill();
      // Zone outline: always this layer’s copper hue (not net-based).
      ctx.strokeStyle = isSel ? '#f472b6' : layerColor;
      ctx.lineWidth = isSel ? 0.14 : 0.08;
      ctx.stroke();
      if (schLink && !isSel) {
        ctx.strokeStyle = 'rgba(192,132,252,0.88)';
        ctx.lineWidth = 0.1;
        ctx.setLineDash([0.35, 0.22]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.restore();

    // Tracks: keep layer hue readable even when layer is not active (F.Cu vs B.Cu etc.)
    const trackAlpha = isActive ? 1 : Math.min(1, inactiveCopperOpacity + 0.5);
    ctx.save();
    ctx.globalAlpha = trackAlpha;
    for (const tr of (doc.tracks || [])) {
      if (tr.layer !== ly) continue;
      const pts = dedupeConsecutiveTrackPoints(tr.points || []);
      if (pts.length < 2) continue;
      const isSel = isSelected('track', tr.id);
      const schLink = tr.net && schCrossNets.has(String(tr.net).toLowerCase());
      const traceCol = PCB_TRACE_LAYER_COLORS[ly] || layerColor;
      const stroke = isSel ? '#f472b6' : traceCol;
      const tw = tr.widthMm || 0.35;

      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (isSel) {
        // Selected: bright glow halo + highlighted trace
        ctx.strokeStyle = 'rgba(244,114,182,0.35)';
        ctx.lineWidth = tw + Math.max(0.4, tw * 1.2);
        ctx.stroke();
        ctx.strokeStyle = '#f472b6';
        ctx.lineWidth = tw + 0.08;
        ctx.stroke();
      } else {
        // Normal: dark border + layer-colored trace
        ctx.strokeStyle = shadeHex(traceCol, 0.52);
        ctx.lineWidth = tw + Math.max(0.05, tw * 0.28);
        ctx.stroke();
        ctx.strokeStyle = traceCol;
        ctx.lineWidth = tw;
        ctx.stroke();
      }
      // Schematic cross-highlight: overlay only — hue stays the active copper layer.
      if (schLink && !isSel) {
        ctx.strokeStyle = 'rgba(192,132,252,0.92)';
        ctx.lineWidth = Math.max(0.07, tw * 0.22);
        ctx.setLineDash([0.45, 0.28]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.restore();
  }

  // ─── Vias ───
  const anyCopperVisible = copperStack.some(ly => isCopperLayerVisible(doc, ly));
  if (anyCopperVisible) {
    for (const v of (doc.vias || [])) {
      drawVia(ctx, v, doc, copperStack, isSelected('via', v.id),
        v.net && schCrossNets.has(String(v.net).toLowerCase()));
    }
  }

  // ─── Pads ───
  for (const pl of (doc.placements || [])) {
    const fp = getFootprint(pl.footprintId);
    if (!fp?.pads) continue;
    for (const pad of fp.pads) {
      const [px, py] = padWorld(pl, pad);
      const rot = (Number(pl.rot) || 0) % 360;
      ctx.save();
      ctx.translate(px, py);
      if (rot && Math.abs(pad.w - pad.h) > 0.001) {
        ctx.rotate(rot * Math.PI / 180);
      }
      // Pad copper
      ctx.fillStyle = '#b87333';
      ctx.fillRect(-pad.w / 2, -pad.h / 2, pad.w, pad.h);
      ctx.strokeStyle = '#7c4b12';
      ctx.lineWidth = 0.05;
      ctx.strokeRect(-pad.w / 2, -pad.h / 2, pad.w, pad.h);
      // Pad number
      if (pad.num && scale > 15) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.min(pad.w, pad.h) * 0.5}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pad.num, 0, 0);
      }
      ctx.restore();
    }
  }

  // ─── Solder mask ───
  if (boardPreview.solderMask) {
    drawSolderMask(ctx, doc, W, H);
  }

  // ─── Silkscreen ───
  drawSilkscreen(ctx, doc, boardPreview);

  // ─── Board frame + dimensions ───
  drawBoardFrame(ctx, W, H);

  // ─── Ratsnest (unrouted pad islands) ───
  drawRatsnest(ctx, padCentersByNet, schCrossNets, {
    emphasize: Boolean(boardPreview.highlightUnrouted),
    selectedNets: selectedRatsnestNets,
  });

  // ─── Selection overlay ───
  for (const pl of (doc.placements || [])) {
    const isSel = isSelected('placement', pl.id);
    const schRef = pl.ref && schCrossRefs.has(String(pl.ref).toUpperCase());
    if (!isSel && !schRef) continue;
    const b = footprintBBox(pl);
    const pad = isSel ? 0.3 : 0.35;
    ctx.strokeStyle = isSel ? '#f472b6' : '#a855f7';
    ctx.lineWidth = isSel ? 0.1 : 0.12;
    ctx.setLineDash([0.2, 0.15]);
    ctx.strokeRect(b.minX - pad, b.minY - pad, b.maxX - b.minX + 2 * pad, b.maxY - b.minY + 2 * pad);
    ctx.setLineDash([]);
  }

  // ─── Route draft (color = active copper layer; changes after Via / V) ───
  if (routeDraft?.length) {
    const trackW = doc.meta?.defaultTrackMm || 0.35;
    const draftColor = PCB_TRACE_LAYER_COLORS[activeLayer] || PCB_LAYER_COLORS[activeLayer] || '#a855f7';
    // Solid in-progress polyline
    ctx.beginPath();
    ctx.moveTo(routeDraft[0][0], routeDraft[0][1]);
    for (let i = 1; i < routeDraft.length; i++) ctx.lineTo(routeDraft[i][0], routeDraft[i][1]);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = trackW + Math.max(0.06, trackW * 0.22);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.strokeStyle = draftColor;
    ctx.lineWidth = trackW;
    ctx.stroke();
    // Draw vertex dots
    for (const pt of routeDraft) {
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], trackW * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = 0.5;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // Layer label (board mm space): shows which layer this draft segment will commit to
    if (scale > 4) {
      const p0 = routeDraft[0];
      const lab = getCopperLayerDisplayName(activeLayer || 'F.Cu', copperStack.length);
      ctx.font = '600 1.05px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const tx = p0[0] + trackW * 1.1 + 0.25;
      const ty = p0[1];
      ctx.lineWidth = 0.2;
      ctx.strokeStyle = 'rgba(0,0,0,0.82)';
      ctx.strokeText(lab, tx, ty);
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(lab, tx, ty);
    }
    // Rubber-band to cursor (free-angle routing)
    if (boardCursorMm) {
      const last = routeDraft[routeDraft.length - 1];
      const prev = routeDraft.length >= 2 ? routeDraft[routeDraft.length - 2] : null;
      let [ex, ey] = snapInteractiveRoutePoint(prev, last, boardCursorMm[0], boardCursorMm[1]);
      const g = Number(doc.meta?.gridMm) > 0 ? Number(doc.meta.gridMm) : 0.5;
      const sn = doc.meta?.snapToGrid !== false;
      ex = snapBoard(ex, g, sn);
      ey = snapBoard(ey, g, sn);
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = trackW + Math.max(0.05, trackW * 0.2);
      ctx.setLineDash([0.3, 0.2]);
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.strokeStyle = draftColor;
      ctx.lineWidth = trackW;
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
    ctx.lineWidth = 0.15;
    ctx.setLineDash([0.25, 0.2]);
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
      ctx.lineWidth = 0.1;
      ctx.setLineDash([0.15, 0.15]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ─── DRC violations ───
  for (const v of drcViolations) {
    ctx.beginPath();
    ctx.arc(v.x, v.y, 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 0.3;
    ctx.setLineDash([0.5, 0.5]);
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
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    ctx.moveTo(boardCursorMm[0], 0);
    ctx.lineTo(boardCursorMm[0], H);
    ctx.moveTo(0, boardCursorMm[1]);
    ctx.lineTo(W, boardCursorMm[1]);
    ctx.stroke();
  }

  ctx.restore();
}

/* ─── Grid drawing ─── */
function drawGrid(ctx, W, H, gridMm, zoom, scale) {
  // Adaptive grid: coarsen with step *= 5 until each line is ≥ minPixelSpacing apart on screen.
  // 0.5px ≈ 10× finer than the old 5px floor so zoomed layouts show much denser guides.
  const minPixelSpacing = 0.5;
  let step = gridMm;
  while (step * scale < minPixelSpacing) step *= 5;

  const majorEvery = 5;
  let ix = 0;
  for (let gx = 0; gx <= W + 1e-9; gx += step, ix++) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, H);
    ctx.strokeStyle = ix % majorEvery === 0 ? 'rgba(148,163,184,0.16)' : 'rgba(148,163,184,0.06)';
    ctx.lineWidth = 0.05;
    ctx.stroke();
  }
  let iy = 0;
  for (let gy = 0; gy <= H + 1e-9; gy += step, iy++) {
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(W, gy);
    ctx.strokeStyle = iy % majorEvery === 0 ? 'rgba(148,163,184,0.16)' : 'rgba(148,163,184,0.06)';
    ctx.lineWidth = 0.05;
    ctx.stroke();
  }
}

/* ─── Via drawing ─── */
function drawVia(ctx, v, doc, copperStack, isSel, schLink) {
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
  ctx.lineWidth = 0.05;
  ctx.stroke();

  // Layer rings: stack is top → bottom (F.Cu … B.Cu); draw outer ring = top copper color
  const visStack = copperStack.filter(ly => isCopperLayerVisible(doc, ly));
  for (let idx = 0; idx < visStack.length; idx++) {
    const rr = ro - 0.04 - idx * 0.055;
    if (rr < holeR + 0.02) break;
    ctx.beginPath();
    ctx.arc(v.x, v.y, rr, 0, Math.PI * 2);
    ctx.strokeStyle = PCB_TRACE_LAYER_COLORS[visStack[idx]] || PCB_LAYER_COLORS[visStack[idx]] || '#94a3b8';
    ctx.lineWidth = 0.07;
    ctx.globalAlpha = isSel ? 0.95 : 0.78;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Outer ring (neutral barrel edge — not net-colored)
  ctx.beginPath();
  ctx.arc(v.x, v.y, ro, 0, Math.PI * 2);
  ctx.strokeStyle = isSel ? '#f472b6' : '#e8c48a';
  ctx.lineWidth = 0.09;
  ctx.stroke();
  if (schLink && !isSel) {
    ctx.beginPath();
    ctx.arc(v.x, v.y, ro + 0.05, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(192,132,252,0.9)';
    ctx.lineWidth = 0.06;
    ctx.setLineDash([0.22, 0.16]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Drill hole
  ctx.beginPath();
  ctx.arc(v.x, v.y, holeR, 0, Math.PI * 2);
  ctx.fillStyle = '#050806';
  ctx.fill();
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 0.03;
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
function drawSilkscreen(ctx, doc, boardPreview) {
  const silkW = boardPreview.boldSilk ? 0.11 : 0.075;
  const silkCol = boardPreview.boldSilk ? '#f8fafc' : '#cbd5e1';

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
    // Reference designator text
    const refCol = boardPreview.boldSilk ? '#ffffff' : '#e2e8f0';
    const refSize = boardPreview.boldSilk ? 1 : 0.9;
    ctx.fillStyle = refCol;
    ctx.font = `${boardPreview.boldSilk ? 'bold' : 'normal'} ${refSize}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(pl.ref || '', pl.x, pl.y - 2);
  }
}

/* ─── Board outline (Edge.Cuts preview) — no schematic-style title block ─── */
function drawBoardFrame(ctx, W, H) {
  // Edge.Cuts outline
  ctx.strokeStyle = '#fde047';
  ctx.lineWidth = 0.32;
  ctx.strokeRect(0, 0, W, H);

  // Inner dashed outline
  ctx.strokeStyle = '#b45309';
  ctx.lineWidth = 0.1;
  ctx.setLineDash([0.35, 0.25]);
  ctx.globalAlpha = 0.85;
  ctx.strokeRect(0.22, 0.22, W - 0.44, H - 0.44);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Corner ticks
  const tick = 1.1;
  ctx.strokeStyle = '#fde047';
  ctx.lineWidth = 0.14;
  ctx.lineCap = 'square';
  ctx.beginPath();
  ctx.moveTo(0, tick); ctx.lineTo(0, 0); ctx.lineTo(tick, 0);
  ctx.moveTo(W - tick, 0); ctx.lineTo(W, 0); ctx.lineTo(W, tick);
  ctx.moveTo(W, H - tick); ctx.lineTo(W, H); ctx.lineTo(W - tick, H);
  ctx.moveTo(tick, H); ctx.lineTo(0, H); ctx.lineTo(0, H - tick);
  ctx.stroke();

  // Origin crosshair
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 0.1;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(-0.35, 0); ctx.lineTo(1.15, 0);
  ctx.moveTo(0, -0.35); ctx.lineTo(0, 1.15);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/* ─── Ratsnest ─── */
function drawRatsnest(ctx, padCentersByNet, schCrossNets, options = {}) {
  const emphasize = Boolean(options.emphasize);
  const selectedNets = options.selectedNets || new Set();
  for (const [net, pts] of padCentersByNet) {
    if (pts.length < 2) continue;
    const hub = pts[0];
    const linkNet = schCrossNets.has(String(net).toLowerCase());
    const isSel = selectedNets.has(String(net));
    if (isSel) {
      // Selected airwire: same dash rhythm as idle, slightly wider + brighter (no solid “halo” line)
      ctx.strokeStyle = linkNet ? 'rgba(237, 222, 255, 0.98)' : 'rgba(214, 178, 255, 0.95)';
      ctx.lineWidth = linkNet ? 0.14 : 0.1;
      ctx.setLineDash([0.4, 0.25]);
    } else if (emphasize) {
      ctx.strokeStyle = linkNet ? 'rgba(216,180,254,0.95)' : 'rgba(192,132,252,0.88)';
      ctx.lineWidth = linkNet ? 0.24 : 0.18;
      ctx.setLineDash([0.45, 0.22]);
    } else {
      ctx.strokeStyle = linkNet ? 'rgba(192,132,252,0.55)' : 'rgba(168,85,247,0.22)';
      ctx.lineWidth = linkNet ? 0.14 : 0.08;
      ctx.setLineDash([0.4, 0.25]);
    }
    for (let i = 1; i < pts.length; i++) {
      ctx.beginPath();
      ctx.moveTo(hub[0], hub[1]);
      ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  // Yellow pad dots help “unrouted” mode, but clash with a selected airwire (reads as a thick yellow trace).
  if (emphasize && selectedNets.size === 0) {
    const r = 0.22;
    for (const [, pts] of padCentersByNet) {
      if (pts.length < 2) continue;
      for (const [x, y] of pts) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(250, 204, 21, 0.4)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.65)';
        ctx.lineWidth = 0.05;
        ctx.stroke();
      }
    }
  }
}

/* ─── Measure tool ─── */
function drawMeasureTool(ctx, start, end, cursor, scale) {
  if (start && end) {
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    ctx.lineTo(end[0], end[1]);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 0.12;
    ctx.stroke();

    // Endpoints
    for (const p of [start, end]) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], 0.35, 0, Math.PI * 2);
      ctx.fillStyle = '#fef08a';
      ctx.fill();
      ctx.strokeStyle = '#b45309';
      ctx.lineWidth = 0.05;
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
    ctx.lineWidth = 0.1;
    ctx.setLineDash([0.35, 0.22]);
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(start[0], start[1], 0.35, 0, Math.PI * 2);
    ctx.fillStyle = '#fef08a';
    ctx.fill();
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 0.05;
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
