/**
 * Professional Canvas 2D Renderer for PCB Studio.
 * Replaces SVG rendering with high-performance hardware-accelerated Canvas 2D.
 * Handles: grid, layers, tracks, vias, pads, polygons, silkscreen, board frame,
 * selection highlights, DRC markers, ratsnest, measure tool, and draft previews.
 */

import { getFootprint } from './footprintLib.js';
import { activeCopperLayerIds, isCopperLayerVisible } from './pcbDoc.js';

/* ─── Layer colors (matches KiCad-style scheme) ─── */
export const PCB_LAYER_COLORS = {
  'F.Cu':   '#ef4444',
  'In1.Cu': '#f59e0b',
  'In2.Cu': '#eab308',
  'In3.Cu': '#22c55e',
  'In4.Cu': '#06b6d4',
  'In5.Cu': '#3b82f6',
  'In6.Cu': '#6366f1',
  'B.Cu':   '#a855f7',
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
    padCentersByNet = new Map(),
    schCrossRefs = new Set(),
    schCrossNets = new Set(),
    measureStart = null,
    measureEnd = null,
    boardCursorMm = null,
    lockedLayers = new Set(),
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

      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = hexToRgba(layerColor, polyFill);
      ctx.fill();
      ctx.strokeStyle = isSel ? '#f472b6' : schLink ? '#c084fc' : layerColor;
      ctx.lineWidth = (isSel ? 0.14 : schLink ? 0.11 : 0.08);
      ctx.stroke();
    }

    ctx.restore();

    // Tracks: keep layer hue readable even when layer is not active (F.Cu vs B.Cu etc.)
    const trackAlpha = isActive ? 1 : Math.min(1, inactiveCopperOpacity + 0.42);
    ctx.save();
    ctx.globalAlpha = trackAlpha;
    for (const tr of (doc.tracks || [])) {
      if (tr.layer !== ly) continue;
      const pts = tr.points || [];
      if (pts.length < 2) continue;
      const isSel = isSelected('track', tr.id);
      const schLink = tr.net && schCrossNets.has(String(tr.net).toLowerCase());
      const stroke = isSel ? '#f472b6' : schLink ? '#c084fc' : layerColor;
      const tw = (tr.widthMm || 0.35) * (schLink && !isSel ? 1.35 : 1);

      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = tw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
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
  drawBoardFrame(ctx, W, H, doc.meta?.name || 'Untitled board', scale);

  // ─── Ratsnest ───
  drawRatsnest(ctx, padCentersByNet, schCrossNets);

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

  // ─── Route draft ───
  if (routeDraft?.length) {
    const trackW = doc.meta?.defaultTrackMm || 0.35;
    // Solid committed segments
    ctx.beginPath();
    ctx.moveTo(routeDraft[0][0], routeDraft[0][1]);
    for (let i = 1; i < routeDraft.length; i++) ctx.lineTo(routeDraft[i][0], routeDraft[i][1]);
    ctx.strokeStyle = PCB_LAYER_COLORS[activeLayer] || '#a855f7';
    ctx.lineWidth = trackW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
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
    // Rubber-band line to cursor
    if (boardCursorMm) {
      const last = routeDraft[routeDraft.length - 1];
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(boardCursorMm[0], boardCursorMm[1]);
      ctx.strokeStyle = PCB_LAYER_COLORS[activeLayer] || '#a855f7';
      ctx.lineWidth = trackW;
      ctx.setLineDash([0.3, 0.2]);
      ctx.lineCap = 'round';
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
  // Adaptive grid: skip lines that would be too dense
  const minPixelSpacing = 8; // min pixels between grid lines
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
  ctx.fillStyle = `rgba(201,162,39,${isSel ? 0.5 : schLink ? 0.42 : 0.38})`;
  ctx.fill();
  ctx.strokeStyle = '#8b6914';
  ctx.lineWidth = 0.05;
  ctx.stroke();

  // Layer rings
  const visStack = copperStack.filter(ly => isCopperLayerVisible(doc, ly)).reverse();
  for (let idx = 0; idx < visStack.length; idx++) {
    const rr = ro - 0.04 - idx * 0.055;
    if (rr < holeR + 0.02) break;
    ctx.beginPath();
    ctx.arc(v.x, v.y, rr, 0, Math.PI * 2);
    ctx.strokeStyle = PCB_LAYER_COLORS[visStack[idx]] || '#94a3b8';
    ctx.lineWidth = 0.07;
    ctx.globalAlpha = isSel ? 0.95 : schLink ? 0.85 : 0.78;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Outer ring
  ctx.beginPath();
  ctx.arc(v.x, v.y, ro, 0, Math.PI * 2);
  ctx.strokeStyle = isSel ? '#f472b6' : schLink ? '#c084fc' : '#e8c48a';
  ctx.lineWidth = 0.09;
  ctx.stroke();

  // Drill hole
  ctx.beginPath();
  ctx.arc(v.x, v.y, holeR, 0, Math.PI * 2);
  ctx.fillStyle = '#050806';
  ctx.fill();
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 0.03;
  ctx.stroke();
}

/* ─── Solder mask (drawn as semi-transparent overlay with holes) ─── */
function drawSolderMask(ctx, doc, W, H) {
  const expand = 0.12;
  const maskColor = 'rgba(13,79,45,0.68)';

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

/* ─── Board frame + title block ─── */
function drawBoardFrame(ctx, W, H, name, scale) {
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

  // Dimension labels
  const fmt = n => (Math.round(n * 100) / 100).toFixed(2);
  if (scale > 3) {
    // Width dimension
    ctx.fillStyle = '#fef9c3';
    ctx.font = `bold 2.15px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${fmt(W)} mm`, W / 2, H - 0.28);

    // Height dimension (rotated)
    ctx.save();
    ctx.translate(W - 0.88 - 0.55, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${fmt(H)} mm`, 0, 0);
    ctx.restore();
  }

  // Title block
  if (scale > 2) {
    const tbW = 21.5, tbH = 13;
    const tbX = Math.max(0, W - 22);
    const tbY = Math.max(0, H - 13.5);
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = 'rgba(15,23,42,0.72)';
    ctx.strokeStyle = 'rgba(148,163,184,0.4)';
    ctx.lineWidth = 0.1;
    roundRect(ctx, tbX, tbY, tbW, tbH, 0.35);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 1.25px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText((name || 'Board').slice(0, 22), tbX + 1.1, tbY + 2.35);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '0.95px ui-monospace, monospace';
    ctx.fillText('Sheet 1 / 1', tbX + 1.1, tbY + 4.35);

    ctx.fillStyle = '#64748b';
    ctx.font = '0.82px ui-monospace, monospace';
    ctx.fillText(`${fmt(W)}×${fmt(H)} mm`, tbX + 1.1, tbY + 6.15);
    ctx.globalAlpha = 1;
  }
}

/* ─── Ratsnest ─── */
function drawRatsnest(ctx, padCentersByNet, schCrossNets) {
  for (const [net, pts] of padCentersByNet) {
    if (pts.length < 2) continue;
    const hub = pts[0];
    const linkNet = schCrossNets.has(String(net).toLowerCase());
    ctx.strokeStyle = linkNet ? 'rgba(192,132,252,0.55)' : 'rgba(168,85,247,0.22)';
    ctx.lineWidth = linkNet ? 0.14 : 0.08;
    ctx.setLineDash([0.4, 0.25]);
    for (let i = 1; i < pts.length; i++) {
      ctx.beginPath();
      ctx.moveTo(hub[0], hub[1]);
      ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
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

/* ─── Rounded rect helper ─── */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
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
