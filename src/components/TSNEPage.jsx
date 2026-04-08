/**
 * TSNEPage.jsx  –  Concentration-dependent t-SNE Explorer
 *
 * Features
 * ────────
 *  • 2-D  **and** 3-D t-SNE (user toggle)
 *  • Per-AU individual plots + combined "All AUs" plot
 *  • Synthetic data generation → saved to workspace FeNOse_synthetic/ folder
 *  • Progressive AU builder: start with one AU, add more one-by-one,
 *    watch the embedding evolve dynamically
 *  • Interactive SVG scatter (2-D): zoom / pan / hover / concentration filter
 *  • Interactive WebGL-free 3-D scatter: trackball rotation, hover, filter
 */

/* eslint-disable react-hooks/set-state-in-effect */
import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import tsnejs from 'tsne';
import { motion, AnimatePresence } from 'framer-motion'; // eslint-disable-line no-unused-vars
import {
  Play, Settings2, AlertTriangle, Sparkles,
  Loader2, CheckCircle, Info, ZoomIn, ZoomOut,
  Maximize2, Eye, EyeOff, GitBranch, X,
  Atom, Box, Square, RotateCcw, ChevronRight, ChevronLeft, ChevronsRight
} from 'lucide-react';
import {
  extractFenoseFeaturesFromRows,
  parseFenoseDeviceIdFromFilename,
  parseFenosePpbFromFilename,
} from '../utils/fenoseModel';
import { parseFile } from '../utils/fileParser';
import { FENOSE_SYNTHETIC_FOLDER_NAME } from '../utils/fenoseWorkspace';
import {
  generateSyntheticFenoseRows,
  computeCalibrationFromFiles,
  resolvePooledSyntheticPhaseCountsForDeviceKey,
  groupFenoseCalibrationFilesByDevice,
  resolveSyntheticCalibration,
  resolveSyntheticPhaseCounts,
  deviceSuffixForSyntheticFile,
  FENOSE_SYNTH_UNKNOWN_KEY,
  SYNTH_DEFAULT_PHASE_COUNTS,
  buildSyntheticFenoseFileName,
} from '../utils/fenoseSyntheticDataset';

/** Must match App.jsx handleAddSyntheticFenoseToWorkspace seed progression for identical synth rows. */
const SYNTH_SEED_MULT = 9973;

// ═══════════════════════════════════════════════════════════════════════════════
// Constants & Pure Helpers
// ═══════════════════════════════════════════════════════════════════════════════

const MIN_TSNE_SAMPLES = 4;
const WARN_REAL_SAMPLES = 8;

const CONC_RAMP = [
  { ppb: 0,   hex: '#64748b' },
  { ppb: 5,   hex: '#06b6d4' },
  { ppb: 10,  hex: '#10b981' },
  { ppb: 25,  hex: '#f59e0b' },
  { ppb: 50,  hex: '#ef4444' },
  { ppb: 100, hex: '#a855f7' },
  { ppb: 200, hex: '#f472b6' },
  { ppb: 500, hex: '#fb923c' },
];

function hexToRgb(h) {
  return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
}
function lerpHex(h1, h2, t) {
  const [r1,g1,b1] = hexToRgb(h1), [r2,g2,b2] = hexToRgb(h2);
  return `rgb(${Math.round(r1+(r2-r1)*t)},${Math.round(g1+(g2-g1)*t)},${Math.round(b1+(b2-b1)*t)})`;
}
function ppbToColor(ppb) {
  if (ppb == null || !Number.isFinite(ppb)) return '#94a3b8';
  for (let i = 0; i < CONC_RAMP.length - 1; i++) {
    if (ppb <= CONC_RAMP[i].ppb) return CONC_RAMP[i].hex;
    if (ppb < CONC_RAMP[i+1].ppb) {
      const t = (ppb - CONC_RAMP[i].ppb) / (CONC_RAMP[i+1].ppb - CONC_RAMP[i].ppb);
      return lerpHex(CONC_RAMP[i].hex, CONC_RAMP[i+1].hex, t);
    }
  }
  return CONC_RAMP[CONC_RAMP.length - 1].hex;
}

function hsl(h, s, l) {
  return `hsl(${h % 360}, ${s}%, ${l}%)`;
}

/** Stable key for coloring: one hue per physical AU; synthetic is distinct. */
function auKeyForPoint(p) {
  if (!p) return 'UNKNOWN';
  if (p.isSynthetic) return 'SYNTHETIC';
  return p.deviceId || 'UNKNOWN';
}

/**
 * Deterministic distinct colors per device id (sorted for stability across runs).
 * Synthetic = purple; UNKNOWN = slate.
 */
function buildAuColorMapFromPoints(points) {
  const ids = new Set();
  for (const p of points || []) {
    ids.add(auKeyForPoint(p));
  }
  const map = { UNKNOWN: '#64748b', SYNTHETIC: '#c084fc' };
  const sorted = [...ids].filter((id) => id && id !== 'UNKNOWN' && id !== 'SYNTHETIC').sort();
  sorted.forEach((id, i) => {
    map[id] = hsl(37.5 * i + (id.charCodeAt(0) || 0) * 3, 72, 58);
  });
  return map;
}

/** Radius scale: larger ppb → larger dot (sqrt for readable spread). */
function concRadiusFactor(ppb, minP, maxP) {
  if (!Number.isFinite(ppb)) return 0.75;
  if (!Number.isFinite(minP) || !Number.isFinite(maxP) || maxP <= minP) return 1.15;
  const t = Math.max(0, Math.min(1, (ppb - minP) / (maxP - minP)));
  return 0.5 + Math.sqrt(t) * 1.05;
}
function shortAuLabel(deviceId) {
  if (!deviceId || deviceId === 'UNKNOWN') return 'Unknown AU';
  if (deviceId === 'SYNTHETIC') return 'Synthetic';
  const m = deviceId.match(/^(\d+)-/);
  return m ? `AU·${m[1].replace(/^0+/, '') || '0'}` : deviceId.slice(0, 14);
}

function normalizeMatrix(mat) {
  if (!mat.length) return mat;
  const D = mat[0].length;
  const mu = new Array(D).fill(0);
  const sd = new Array(D).fill(0);
  for (const v of mat) for (let d = 0; d < D; d++) mu[d] += v[d] / mat.length;
  for (const v of mat) for (let d = 0; d < D; d++) sd[d] += (v[d] - mu[d]) ** 2 / mat.length;
  for (let d = 0; d < D; d++) sd[d] = Math.sqrt(sd[d]) || 1;
  return mat.map(v => v.map((x, d) => (x - mu[d]) / sd[d]));
}

/** Sorted keys + parallel vector; NaN → 0 so dimensions stay aligned across samples. */
function featureKeysAndVectorFromFeats(feats) {
  const featKeys = Object.keys(feats || {}).sort();
  const featVec = featKeys.map((k) => {
    const v = feats[k];
    return Number.isFinite(v) ? v : 0;
  });
  return { featKeys, featVec };
}

/**
 * Union of all feature keys across points, fixed column order — required for t-SNE when keys differ slightly.
 */
function buildNormalizedFeatureMatrix(pts) {
  const keySet = new Set();
  for (const p of pts) {
    if (Array.isArray(p.featKeys)) p.featKeys.forEach((k) => keySet.add(k));
  }
  const canonical = [...keySet].sort();
  if (!canonical.length) return { matrix: [], canonical: [] };
  const raw = pts.map((p) => {
    const map = {};
    if (p.featKeys && p.feats && p.featKeys.length === p.feats.length) {
      p.featKeys.forEach((k, i) => {
        map[k] = p.feats[i];
      });
    }
    return canonical.map((k) => {
      const v = map[k];
      return Number.isFinite(v) ? v : 0;
    });
  });
  return { matrix: normalizeMatrix(raw), canonical };
}

/* ── t-SNE runner (supports dim = 2 or 3) ─────────────────────────────────── */
async function runTSNEAsync(featureMatrix, { perplexity = 30, epsilon = 10, nIter = 500, dim = 2 }, onProgress) {
  const safePerp = Math.min(perplexity, Math.max(2, featureMatrix.length - 2));
  const model = new tsnejs.tSNE({ perplexity: safePerp, dim, epsilon });
  model.initDataRaw(featureMatrix);
  const BATCH = 30;
  for (let i = 0; i < nIter; i += BATCH) {
    const end = Math.min(i + BATCH, nIter);
    for (let j = i; j < end; j++) model.step();
    onProgress?.(end / nIter);
    await new Promise(r => setTimeout(r, 0));
  }
  return model.getSolution();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2-D Interactive SVG Scatter Plot
// ═══════════════════════════════════════════════════════════════════════════════

function TSNEPlot2D({ points = [], width = 560, height = 460, hiddenConcs, auColorMap = {} }) {
  const svgRef = useRef(null);
  const [transform, setTransform] = useState({ tx: 0, ty: 0, s: 1 });
  const [tooltip, setTooltip] = useState(null);
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  const MARGIN = { top: 20, right: 20, bottom: 20, left: 20 };
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const visible = useMemo(() => points.filter(p => !(hiddenConcs?.has(p.ppb))), [points, hiddenConcs]);

  const { concMin, concMax } = useMemo(() => {
    let mn = Infinity;
    let mx = -Infinity;
    for (const p of visible) {
      const v = p.ppb;
      if (!Number.isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!Number.isFinite(mn)) return { concMin: 0, concMax: 1 };
    return { concMin: mn, concMax: mx };
  }, [visible]);

  const { xMin, xMax, yMin, yMax } = useMemo(() => {
    if (!visible.length) return { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };
    let xMn = Infinity, xMx = -Infinity, yMn = Infinity, yMx = -Infinity;
    for (const p of visible) {
      if (p.x < xMn) xMn = p.x; if (p.x > xMx) xMx = p.x;
      if (p.y < yMn) yMn = p.y; if (p.y > yMx) yMx = p.y;
    }
    const xP = (xMx - xMn) * 0.08 || 1;
    const yP = (yMx - yMn) * 0.08 || 1;
    return { xMin: xMn - xP, xMax: xMx + xP, yMin: yMn - yP, yMax: yMx + yP };
  }, [visible]);

  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const resetTransform = useCallback(() => {
    setTransform({ tx: MARGIN.left, ty: MARGIN.top, s: 1 });
  }, [MARGIN.left, MARGIN.top]);

  useEffect(() => { resetTransform(); }, [points, resetTransform]);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.15 : 0.87;
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (!svgRect) return;
    const mx = e.clientX - svgRect.left;
    const my = e.clientY - svgRect.top;
    setTransform(prev => {
      const newS = Math.max(0.2, Math.min(20, prev.s * delta));
      return { tx: mx - (mx - prev.tx) * (newS / prev.s), ty: my - (my - prev.ty) * (newS / prev.s), s: newS };
    });
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    isPanning.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.style.cursor = 'grabbing';
  }, []);
  const onMouseMove = useCallback((e) => {
    if (isPanning.current) {
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      setTransform(prev => ({ ...prev, tx: prev.tx + dx, ty: prev.ty + dy }));
    }
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (!svgRect || !visible.length) return;
    const mx = e.clientX - svgRect.left;
    const my = e.clientY - svgRect.top;
    const { tx, ty, s } = transform;
    const dataX = xMin + ((mx - tx) / (s * plotW)) * xRange;
    const dataY = yMin + ((my - ty) / (s * plotH)) * yRange;
    let nearest = null, minDist2 = Infinity;
    for (const p of visible) {
      const d2 = (p.x - dataX) ** 2 + (p.y - dataY) ** 2;
      if (d2 < minDist2) { minDist2 = d2; nearest = p; }
    }
    const pixelThresh = (18 / s) ** 2 * ((xRange / plotW) ** 2);
    if (nearest && minDist2 < pixelThresh * xRange ** 2) {
      setTooltip({ point: nearest, sx: e.clientX - svgRect.left, sy: e.clientY - svgRect.top });
    } else {
      setTooltip(null);
    }
  }, [visible, transform, xMin, yMin, xRange, yRange, plotW, plotH]);
  const onMouseUp = useCallback((e) => { isPanning.current = false; if (e.currentTarget) e.currentTarget.style.cursor = 'grab'; }, []);
  const onMouseLeave = useCallback(() => { isPanning.current = false; setTooltip(null); }, []);

  if (!points.length) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15,23,42,0.6)', borderRadius: 12, border: '1px solid #334155', color: '#64748b', fontSize: '0.85rem' }}>
        No t-SNE data — click Run to compute.
      </div>
    );
  }

  const { tx, ty, s } = transform;
  const ptX = (p) => ((p.x - xMin) / xRange) * plotW;
  const ptY = (p) => ((p.y - yMin) / yRange) * plotH;
  const baseR = Math.max(2.2, 4.2 / s);

  return (
    <div style={{ position: 'relative', userSelect: 'none' }}>
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[
          { icon: <ZoomIn size={13} />, action: () => setTransform(p => ({ ...p, s: Math.min(20, p.s * 1.3), tx: p.tx - (plotW / 2) * 0.3, ty: p.ty - (plotH / 2) * 0.3 })), title: 'Zoom in' },
          { icon: <ZoomOut size={13} />, action: () => setTransform(p => ({ ...p, s: Math.max(0.2, p.s / 1.3), tx: p.tx + (plotW / 2) * 0.23, ty: p.ty + (plotH / 2) * 0.23 })), title: 'Zoom out' },
          { icon: <Maximize2 size={13} />, action: resetTransform, title: 'Reset view' },
        ].map(({ icon, action, title }) => (
          <button key={title} onClick={action} title={title}
            style={{ background: 'rgba(15,23,42,0.85)', border: '1px solid #334155', borderRadius: 6,
              width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: '#94a3b8', transition: 'color 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.color = '#00DE93'}
            onMouseLeave={e => e.currentTarget.style.color = '#94a3b8'}
          >{icon}</button>
        ))}
      </div>
      <svg ref={svgRef} width={width} height={height}
        style={{ display: 'block', cursor: 'grab', borderRadius: 10,
          background: 'linear-gradient(135deg, rgba(15,23,42,0.95), rgba(30,41,59,0.95))' }}
        onMouseDown={onMouseDown} onMouseMove={onMouseMove}
        onMouseUp={onMouseUp} onMouseLeave={onMouseLeave}
        onDoubleClick={resetTransform}>
        <defs>
          <pattern id="tsne-grid-2d" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(51,65,85,0.4)" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#tsne-grid-2d)" />
        <g transform={`translate(${tx},${ty}) scale(${s})`}>
          {visible.map((p, i) => {
            const cx = ptX(p);
            const cy = ptY(p);
            const col = auColorMap[auKeyForPoint(p)] || '#94a3b8';
            const rf = concRadiusFactor(p.ppb, concMin, concMax);
            const r = baseR * rf;
            return (
              <g key={i}>
                {!p.isSynthetic && (
                  <circle cx={cx} cy={cy} r={r * 2.1} fill={col} opacity={0.1} />
                )}
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill={col}
                  stroke={p.isSynthetic ? 'rgba(255,255,255,0.35)' : 'rgba(15,23,42,0.35)'}
                  strokeWidth={p.isSynthetic ? 1.1 / s : 0.45 / s}
                  strokeDasharray={p.isSynthetic ? `${4 / s} ${2.5 / s}` : undefined}
                  opacity={p.isSynthetic ? 0.72 : 0.9}
                />
              </g>
            );
          })}
        </g>
        <text x={width / 2} y={height - 4} textAnchor="middle" fill="#475569" fontSize={10} fontFamily="Inter,sans-serif">t-SNE 1</text>
        <text x={8} y={height / 2} textAnchor="middle" fill="#475569" fontSize={10} fontFamily="Inter,sans-serif"
          transform={`rotate(-90,8,${height / 2})`}>t-SNE 2</text>
      </svg>
      <AnimatePresence>
        {tooltip && <PointTooltip tooltip={tooltip} width={width} auColorMap={auColorMap} />}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  3-D Trackball Scatter Plot (pure SVG projected)
// ═══════════════════════════════════════════════════════════════════════════════

function mat3RotY(a) {
  const c = Math.cos(a), sn = Math.sin(a);
  return [c, 0, sn, 0, 1, 0, -sn, 0, c];
}
function mat3RotX(a) {
  const c = Math.cos(a), sn = Math.sin(a);
  return [1, 0, 0, 0, c, -sn, 0, sn, c];
}
function mat3Mul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return o;
}
function applyMat3(m, x, y, z) {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}

function TSNEPlot3D({ points = [], width = 560, height = 460, hiddenConcs, auColorMap = {} }) {
  const svgRef = useRef(null);
  const [rotation, setRotation] = useState({ rx: -0.4, ry: 0.6 });
  const [zoom, setZoom] = useState(1);
  const [tooltip, setTooltip] = useState(null);
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const autoRotRef = useRef(null);
  const [autoRotate, setAutoRotate] = useState(true);

  const visible = useMemo(() => points.filter(p => !(hiddenConcs?.has(p.ppb))), [points, hiddenConcs]);

  const { concMin, concMax } = useMemo(() => {
    let mn = Infinity;
    let mx = -Infinity;
    for (const p of visible) {
      const v = p.ppb;
      if (!Number.isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!Number.isFinite(mn)) return { concMin: 0, concMax: 1 };
    return { concMin: mn, concMax: mx };
  }, [visible]);

  // Normalise to [-1, 1]³
  const normPts = useMemo(() => {
    if (!visible.length) return [];
    let mx = -Infinity, my = -Infinity, mz = -Infinity, nx = Infinity, ny = Infinity, nz = Infinity;
    for (const p of visible) {
      if (p.x > mx) mx = p.x; if (p.x < nx) nx = p.x;
      if (p.y > my) my = p.y; if (p.y < ny) ny = p.y;
      if (p.z > mz) mz = p.z; if (p.z < nz) nz = p.z;
    }
    const rx = mx - nx || 1, ry = my - ny || 1, rz = mz - nz || 1;
    const sc = Math.max(rx, ry, rz) / 2;
    const cx = (mx + nx) / 2, cy = (my + ny) / 2, cz = (mz + nz) / 2;
    return visible.map(p => ({
      ...p,
      nx: (p.x - cx) / sc, ny: (p.y - cy) / sc, nz: (p.z - cz) / sc,
    }));
  }, [visible]);

  // Auto-rotation
  useEffect(() => {
    if (!autoRotate) { if (autoRotRef.current) cancelAnimationFrame(autoRotRef.current); return; }
    let frame;
    const spin = () => {
      setRotation(prev => ({ ...prev, ry: prev.ry + 0.005 }));
      frame = requestAnimationFrame(spin);
      autoRotRef.current = frame;
    };
    frame = requestAnimationFrame(spin);
    autoRotRef.current = frame;
    return () => cancelAnimationFrame(frame);
  }, [autoRotate]);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    setZoom(z => Math.max(0.3, Math.min(5, z * (e.deltaY < 0 ? 1.1 : 0.9))));
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    isDragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setAutoRotate(false);
  }, []);
  const onMouseMove = useCallback((e) => {
    if (isDragging.current) {
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      setRotation(prev => ({ rx: prev.rx + dy * 0.008, ry: prev.ry + dx * 0.008 }));
    }
    // hover
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (!svgRect || !normPts.length) return;
    const mx = e.clientX - svgRect.left;
    const my = e.clientY - svgRect.top;
    const rot = mat3Mul(mat3RotX(rotation.rx), mat3RotY(rotation.ry));
    const sc = Math.min(width, height) * 0.38 * zoom;
    const cx = width / 2, cy = height / 2;
    let nearest = null, minD2 = Infinity;
    for (const p of normPts) {
      const [px, py] = applyMat3(rot, p.nx, p.ny, p.nz);
      const sx = cx + px * sc, sy = cy + py * sc;
      const d2 = (sx - mx) ** 2 + (sy - my) ** 2;
      if (d2 < minD2) { minD2 = d2; nearest = p; }
    }
    if (nearest && minD2 < 400) {
      setTooltip({ point: nearest, sx: mx, sy: my });
    } else {
      setTooltip(null);
    }
  }, [normPts, rotation, zoom, width, height]);
  const onMouseUp = useCallback(() => { isDragging.current = false; }, []);
  const onMouseLeave = useCallback(() => { isDragging.current = false; setTooltip(null); }, []);

  if (!points.length) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15,23,42,0.6)', borderRadius: 12, border: '1px solid #334155', color: '#64748b', fontSize: '0.85rem' }}>
        No 3-D t-SNE data — click Run to compute.
      </div>
    );
  }

  const rot = mat3Mul(mat3RotX(rotation.rx), mat3RotY(rotation.ry));
  const sc = Math.min(width, height) * 0.38 * zoom;
  const cx = width / 2, cy = height / 2;

  // Sort by depth (far first) for painter's algorithm
  const projected = normPts.map(p => {
    const [px, py, pz] = applyMat3(rot, p.nx, p.ny, p.nz);
    return { ...p, sx: cx + px * sc, sy: cy + py * sc, depth: pz };
  }).sort((a, b) => a.depth - b.depth);

  // Draw axes
  const axisLen = 0.6;
  const axes = [
    { label: 'X', vec: [axisLen, 0, 0], col: '#ef4444' },
    { label: 'Y', vec: [0, axisLen, 0], col: '#22c55e' },
    { label: 'Z', vec: [0, 0, axisLen], col: '#3b82f6' },
  ].map(a => {
    const [ex, ey] = applyMat3(rot, ...a.vec);
    return { ...a, ex: cx + ex * sc, ey: cy + ey * sc };
  });

  return (
    <div style={{ position: 'relative', userSelect: 'none' }}>
      {/* Controls */}
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[
          { icon: <ZoomIn size={13} />, action: () => setZoom(z => Math.min(5, z * 1.3)), title: 'Zoom in' },
          { icon: <ZoomOut size={13} />, action: () => setZoom(z => Math.max(0.3, z / 1.3)), title: 'Zoom out' },
          { icon: <RotateCcw size={13} />, action: () => { setRotation({ rx: -0.4, ry: 0.6 }); setZoom(1); setAutoRotate(true); }, title: 'Reset view' },
        ].map(({ icon, action, title }) => (
          <button key={title} onClick={action} title={title}
            style={{ background: 'rgba(15,23,42,0.85)', border: '1px solid #334155', borderRadius: 6,
              width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: '#94a3b8', transition: 'color 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.color = '#00DE93'}
            onMouseLeave={e => e.currentTarget.style.color = '#94a3b8'}
          >{icon}</button>
        ))}
        <button onClick={() => setAutoRotate(a => !a)} title={autoRotate ? 'Stop auto-rotate' : 'Auto-rotate'}
          style={{ background: autoRotate ? 'rgba(0,222,147,0.15)' : 'rgba(15,23,42,0.85)',
            border: '1px solid #334155', borderRadius: 6, width: 26, height: 26,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: autoRotate ? '#00DE93' : '#64748b', fontSize: '0.7rem', fontWeight: 700 }}>
          3D
        </button>
      </div>

      <svg ref={svgRef} width={width} height={height}
        style={{ display: 'block', cursor: 'grab', borderRadius: 10,
          background: 'linear-gradient(135deg, rgba(8,15,30,0.98), rgba(20,30,48,0.98))' }}
        onMouseDown={onMouseDown} onMouseMove={onMouseMove}
        onMouseUp={onMouseUp} onMouseLeave={onMouseLeave}>
        {/* Axes */}
        {axes.map(a => (
          <g key={a.label}>
            <line x1={cx} y1={cy} x2={a.ex} y2={a.ey} stroke={a.col} strokeWidth={1} opacity={0.35} />
            <text x={a.ex + 4} y={a.ey - 4} fill={a.col} fontSize={9} opacity={0.5} fontFamily="Inter,sans-serif">{a.label}</text>
          </g>
        ))}
        {/* Points */}
        {projected.map((p, i) => {
          const col = auColorMap[auKeyForPoint(p)] || '#94a3b8';
          const depthFade = 0.4 + 0.6 * ((p.depth + 1) / 2);
          const concF = concRadiusFactor(p.ppb, concMin, concMax);
          const rr = Math.max(2, (3.2 + p.depth * 1.4) * zoom * concF);
          return (
            <g key={i}>
              {!p.isSynthetic && (
                <circle cx={p.sx} cy={p.sy} r={rr * 2} fill={col} opacity={0.07 * depthFade} />
              )}
              <circle
                cx={p.sx}
                cy={p.sy}
                r={rr}
                fill={col}
                stroke={p.isSynthetic ? 'rgba(255,255,255,0.32)' : 'rgba(15,23,42,0.3)'}
                strokeWidth={p.isSynthetic ? 0.75 : 0.35}
                strokeDasharray={p.isSynthetic ? '4 2.5' : undefined}
                opacity={(p.isSynthetic ? 0.55 : 0.82) * depthFade}
              />
            </g>
          );
        })}
      </svg>

      <AnimatePresence>
        {tooltip && <PointTooltip tooltip={tooltip} width={width} auColorMap={auColorMap} />}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared Tooltip
// ═══════════════════════════════════════════════════════════════════════════════

function PointTooltip({ tooltip, width, auColorMap = {} }) {
  const auCol = auColorMap[auKeyForPoint(tooltip.point)] || '#94a3b8';
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.1 }}
      style={{
        position: 'absolute',
        left: Math.min(tooltip.sx + 14, width - 210),
        top: Math.max(4, tooltip.sy - 60),
        background: 'rgba(15,23,42,0.97)',
        border: `1px solid ${auCol}88`,
        borderRadius: 8, padding: '8px 12px',
        pointerEvents: 'none', zIndex: 20,
        boxShadow: `0 4px 20px rgba(0,0,0,0.5), 0 0 0 1px ${auCol}44`,
        minWidth: 140,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: auCol, display: 'inline-block', flexShrink: 0 }} />
        <span style={{ color: '#f8fafc', fontSize: '0.8rem', fontWeight: 600 }}>
          {shortAuLabel(auKeyForPoint(tooltip.point))}
        </span>
        <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>{tooltip.point.ppb} ppb</span>
        {tooltip.point.isSynthetic && (
          <span style={{ fontSize: '0.65rem', color: '#c084fc', background: 'rgba(168,85,247,0.15)', borderRadius: 4, padding: '1px 5px' }}>synthetic</span>
        )}
      </div>
      <div style={{ color: '#64748b', fontSize: '0.7rem', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {tooltip.point.fileName?.split('/').pop()?.slice(0, 40) || 'unknown'}
      </div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Concentration Legend + Filter
// ═══════════════════════════════════════════════════════════════════════════════

function ConcLegend({ concentrations, hiddenConcs, onToggle }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600, letterSpacing: '0.06em',
        textTransform: 'uppercase', marginBottom: 4 }}>Hide by concentration</div>
      <div style={{ fontSize: '0.65rem', color: '#475569', marginBottom: 2 }}>Dot size ∝ ppb · colors = AU</div>
      {concentrations.map(ppb => {
        const hidden = hiddenConcs.has(ppb);
        return (
          <button key={ppb} onClick={() => onToggle(ppb)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none',
              cursor: 'pointer', padding: '3px 0', borderRadius: 6, transition: 'opacity 0.15s', opacity: hidden ? 0.35 : 1 }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#475569',
              display: 'inline-block', flexShrink: 0, border: '1px solid #64748b' }} />
            <span style={{ color: hidden ? '#475569' : '#cbd5e1', fontSize: '0.78rem', fontWeight: 500 }}>{ppb} ppb</span>
            <span style={{ marginLeft: 'auto', color: '#475569' }}>{hidden ? <EyeOff size={11} /> : <Eye size={11} />}</span>
          </button>
        );
      })}
    </div>
  );
}

function AuColorLegend({ auIdsOrdered, auColorMap }) {
  if (!auIdsOrdered?.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600, letterSpacing: '0.06em',
        textTransform: 'uppercase', marginBottom: 4 }}>AU color</div>
      {auIdsOrdered.map((id) => (
        <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
          <span style={{
            width: 12, height: 12, borderRadius: '50%', background: auColorMap[id] || '#94a3b8',
            flexShrink: 0, boxShadow: `0 0 6px ${(auColorMap[id] || '#94a3b8')}55`,
          }} />
          <span style={{ color: '#cbd5e1', fontSize: '0.78rem', fontWeight: 500 }}>{shortAuLabel(id)}</span>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main TSNEPage
// ═══════════════════════════════════════════════════════════════════════════════

export default function TSNEPage({ workspaceFiles = [], onAddSyntheticFenoseToWorkspace }) {
  /* ── Core state ────────────────────────────────────────────────────────── */
  const [stage, setStage] = useState('idle');
  const [loadProg, setLoadProg] = useState(0);
  const [computeProg, setComputeProg] = useState({});
  const [dataPoints, setDataPoints] = useState([]);
  const [tsneResults, setTsneResults] = useState({});
  const [selectedTab, setSelectedTab] = useState('combined');
  const [hiddenConcs, setHiddenConcs] = useState(new Set());
  const [errorMsg, setErrorMsg] = useState(null);

  /* ── View mode ─────────────────────────────────────────────────────────── */
  const [dim, setDim] = useState(2); // 2 | 3

  /* ── Settings ──────────────────────────────────────────────────────────── */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [perplexity, setPerplexity] = useState(25);
  const [nIter, setNIter] = useState(500);
  const [epsilon, setEpsilon] = useState(10);

  /* ── Synthetic ─────────────────────────────────────────────────────────── */
  const [synthOpen, setSynthOpen] = useState(false);
  const [synthNPerConc, setSynthNPerConc] = useState(15);
  const [synthConcs, setSynthConcs] = useState([0, 5, 10, 25, 50, 100]);
  const [synthConcInput, setSynthConcInput] = useState('0,5,10,25,50,100');
  const [synthAdded, setSynthAdded] = useState(false);
  const [synthSaving, setSynthSaving] = useState(false);

  /* ── Progressive AU builder (first N AUs in sorted order + synthetic) ───── */
  const [progressiveMode, setProgressiveMode] = useState(false);
  const [selectedAUs, setSelectedAUs] = useState(new Set());
  /** How many real AUs (sorted id order) are included in progressive combined embedding. */
  const [progressiveAuCount, setProgressiveAuCount] = useState(1);

  const cancelRef = useRef(false);

  /* ── Derived ───────────────────────────────────────────────────────────── */
  const eligibleFiles = useMemo(() =>
    workspaceFiles.filter(f => !f.isFolder && parseFenosePpbFromFilename(f.name) !== null),
    [workspaceFiles]
  );

  const realCount = useMemo(() => dataPoints.filter(p => !p.isSynthetic).length, [dataPoints]);
  const synthInMemoryCount = useMemo(() => dataPoints.filter((p) => p.isSynthetic).length, [dataPoints]);
  const allConcs = useMemo(
    () => [...new Set(dataPoints.map(p => p.ppb))].filter(Number.isFinite).sort((a, b) => a - b),
    [dataPoints]
  );

  // AU groups from REAL + SYNTHETIC data (synthetic included in combined and accessible per-AU)
  const auGroups = useMemo(() => {
    const g = {};
    for (const p of dataPoints) {
      const key = p.isSynthetic ? 'SYNTHETIC' : p.deviceId;
      (g[key] = g[key] || []).push(p);
    }
    return g;
  }, [dataPoints]);

  const allAUKeys = useMemo(() =>
    Object.keys(auGroups).filter(k => k !== 'SYNTHETIC').sort(),
    [auGroups]
  );

  const auColorMapGlobal = useMemo(() => buildAuColorMapFromPoints(dataPoints), [dataPoints]);

  const tabs = useMemo(() => {
    const list = [{ key: 'combined', label: 'All AUs', count: dataPoints.length }];
    for (const [did, pts] of Object.entries(auGroups)) {
      list.push({ key: did, label: shortAuLabel(did), count: pts.length });
    }
    return list;
  }, [auGroups, dataPoints.length]);

  /* ── Feature extraction ────────────────────────────────────────────────── */
  const loadAndExtract = useCallback(async () => {
    const results = [];
    setLoadProg(0);
    for (let i = 0; i < eligibleFiles.length; i++) {
      if (cancelRef.current) break;
      const f = eligibleFiles[i];
      setLoadProg((i + 1) / eligibleFiles.length);
      try {
        const parsed = await parseFile(f);
        if (!parsed?.data?.length) continue;
        const feats = extractFenoseFeaturesFromRows(parsed.data);
        const { featKeys, featVec } = featureKeysAndVectorFromFeats(feats);
        if (!featVec.length) continue;
        results.push({
          feats: featVec, featKeys,
          ppb: parseFenosePpbFromFilename(f.name),
          deviceId: parseFenoseDeviceIdFromFilename(f.name),
          fileName: f.name,
          isSynthetic: false,
        });
      } catch (e) {
        console.warn('t-SNE skip:', f.name, e.message);
      }
      await new Promise(r => setTimeout(r, 0));
    }
    return results;
  }, [eligibleFiles]);

  /* ── Synthetic generation + persist to workspace (same pipeline as ML Studio / App) ─ */
  const buildAndSaveSynthetics = useCallback(async (nPerConc, concs) => {
    const looksLabelled = (name) => /(\d+(?:\.\d+)?)\s*ppb\b/i.test(String(name || ''));
    const isTabular = (name) => /\.(csv|xlsx?)/i.test(String(name || ''));

    const synthFolder = workspaceFiles.find(
      (f) => f.isFolder && String(f.name).toLowerCase() === FENOSE_SYNTHETIC_FOLDER_NAME.toLowerCase()
    );
    const synthFolderId = synthFolder ? String(synthFolder.id) : null;

    const realCandidates = workspaceFiles.filter((f) => {
      if (f.isFolder) return false;
      if (synthFolderId && String(f.folderId) === synthFolderId) return false;
      return looksLabelled(f.name) && isTabular(f.name);
    });

    let parsedForCal = [];
    let pooledCalibration = null;
    try {
      parsedForCal = (
        await Promise.all(
          realCandidates.map(async (f) => {
            try {
              if (Array.isArray(f.data) && f.data.length > 0) {
                return { fileName: f.name, data: f.data };
              }
              const r = await parseFile(f);
              if (r?.data?.length) return { fileName: f.name, data: r.data };
            } catch {
              /* skip unparseable */
            }
            return null;
          })
        )
      ).filter(Boolean);
      pooledCalibration = computeCalibrationFromFiles(parsedForCal);
    } catch (calErr) {
      console.warn('[t-SNE synthetic] calibration error, using fallback:', calErr);
    }

    const byDevice = groupFenoseCalibrationFilesByDevice(parsedForCal);
    let deviceJobs;
    if (byDevice.size === 0) {
      deviceJobs = [{ key: FENOSE_SYNTH_UNKNOWN_KEY, files: [] }];
    } else {
      deviceJobs = [...byDevice.entries()]
        .map(([key, files]) => ({ key, files }))
        .sort((a, b) => a.key.localeCompare(b.key));
    }

    const totalPlanned = deviceJobs.length * concs.length * nPerConc;
    const MAX_SYNTHETIC_BATCH = 10000;
    if (totalPlanned > MAX_SYNTHETIC_BATCH) {
      throw new Error(
        `Too many synthetic files at once (${totalPlanned}). Maximum is ${MAX_SYNTHETIC_BATCH} per run — lower replicates, devices, or concentrations, or run multiple times.`
      );
    }

    const synthPts = [];
    const prebuiltRuns = [];
    const baseSeed = (Date.now() & 0xffffff) >>> 0;
    let k = 0;
    for (const { key: deviceKey, files: devFiles } of deviceJobs) {
      if (cancelRef.current) break;
      const phasePool = resolvePooledSyntheticPhaseCountsForDeviceKey(deviceKey, parsedForCal);
      const calibration = resolveSyntheticCalibration(devFiles, pooledCalibration);
      const phases = resolveSyntheticPhaseCounts(devFiles, phasePool, {});
      const deviceSuffix = deviceSuffixForSyntheticFile(deviceKey);
      for (const ppb of concs) {
        for (let r = 0; r < nPerConc; r++) {
          if (cancelRef.current) break;
          try {
            const rows = generateSyntheticFenoseRows({
              ppb,
              seed: (baseSeed + k * SYNTH_SEED_MULT) >>> 0,
              nAmbient: phases.nAmbient,
              nBsc: phases.nBsc,
              nFeno: phases.nFeno,
              nWindow: phases.nWindow,
              windowBeforeMeasurement:
                phases.windowBeforeMeasurement ?? SYNTH_DEFAULT_PHASE_COUNTS.windowBeforeMeasurement,
              calibration,
            });
            const feats = extractFenoseFeaturesFromRows(rows);
            const { featKeys, featVec } = featureKeysAndVectorFromFeats(feats);
            if (featVec.length) {
              const fileName = buildSyntheticFenoseFileName({ ppb, replicateIndex: r, deviceSuffix });
              synthPts.push({
                feats: featVec,
                featKeys,
                ppb,
                deviceId: parseFenoseDeviceIdFromFilename(fileName),
                fileName,
                isSynthetic: true,
              });
              prebuiltRuns.push({
                data: rows,
                ppb,
                replicateIndex: r,
                deviceSuffix,
              });
            }
          } catch (e) {
            console.warn('Synthetic sample failed:', e?.message || e);
          }
          k++;
          if (k % 20 === 0) await new Promise((r2) => setTimeout(r2, 0));
        }
      }
    }

    if (onAddSyntheticFenoseToWorkspace && prebuiltRuns.length > 0) {
      setSynthSaving(true);
      try {
        await onAddSyntheticFenoseToWorkspace({ prebuiltRuns });
      } catch (e) {
        console.warn('Could not save synthetics to workspace:', e?.message || e);
      }
      setSynthSaving(false);
    }

    return synthPts;
  }, [workspaceFiles, onAddSyntheticFenoseToWorkspace]);

  /* ── t-SNE computation ─────────────────────────────────────────────────── */
  const computeTSNE = useCallback(async (allPoints, activeDim) => {
    setStage('computing');
    setTsneResults({});
    setComputeProg({});
    const results = {};

    // Build groups: combined (all), per-real-AU (real for that AU + all synthetic), per-SYNTHETIC
    const auMap = {};
    for (const p of allPoints) {
      const key = p.isSynthetic ? 'SYNTHETIC' : p.deviceId;
      (auMap[key] = auMap[key] || []).push(p);
    }
    const syntheticPts = auMap['SYNTHETIC'] || [];

    // Per-AU group: real for that AU + all synthetics
    const groupMap = { combined: allPoints };
    for (const [did, pts] of Object.entries(auMap)) {
      if (did === 'SYNTHETIC') {
        if (pts.length >= MIN_TSNE_SAMPLES) groupMap[did] = pts;
        else groupMap[did] = pts;
      } else {
        // Include synthetics with each AU for richer embedding
        const merged = [...pts, ...syntheticPts];
        groupMap[did] = merged;
      }
    }

    for (const [key, pts] of Object.entries(groupMap)) {
      if (cancelRef.current) break;
      if (pts.length < MIN_TSNE_SAMPLES) {
        results[key] = { status: 'skipped', reason: `Only ${pts.length} samples`, points: [] };
        setTsneResults(prev => ({ ...prev, ...results }));
        continue;
      }
      results[key] = { status: 'running', points: [] };
      setTsneResults(prev => ({ ...prev, ...results }));
      try {
        const { matrix: featureMatrix } = buildNormalizedFeatureMatrix(pts);
        if (!featureMatrix.length || !featureMatrix[0]?.length) {
          results[key] = { status: 'skipped', reason: 'No usable features', points: [] };
          setTsneResults((prev) => ({ ...prev, ...results }));
          continue;
        }
        const solution = await runTSNEAsync(
          featureMatrix,
          { perplexity, epsilon, nIter, dim: activeDim },
          (prog) => setComputeProg(prev => ({ ...prev, [key]: prog }))
        );
        results[key] = {
          status: 'done',
          points: pts.map((p, i) => ({
            x: solution[i][0],
            y: solution[i][1],
            z: activeDim === 3 ? solution[i][2] : 0,
            ppb: p.ppb,
            deviceId: p.deviceId,
            fileName: p.fileName,
            isSynthetic: p.isSynthetic,
          })),
        };
      } catch (err) {
        results[key] = { status: 'error', error: err.message, points: [] };
      }
      setTsneResults(prev => ({ ...prev, ...results }));
    }
    setStage('done');
  }, [perplexity, epsilon, nIter]);

  const getWorkingPoints = useCallback(() => {
    const realDevices = [
      ...new Set(dataPoints.filter((p) => !p.isSynthetic).map((p) => p.deviceId).filter(Boolean)),
    ].sort();
    if (progressiveMode && realDevices.length > 1) {
      return dataPoints.filter((p) => p.isSynthetic || selectedAUs.has(p.deviceId));
    }
    return dataPoints;
  }, [dataPoints, progressiveMode, selectedAUs]);

  /* ── Handle Run ────────────────────────────────────────────────────────── */
  const handleRun = useCallback(async () => {
    cancelRef.current = false;
    setStage('loading');
    setErrorMsg(null);
    setComputeProg({});
    setTsneResults({});
    try {
      const real = await loadAndExtract();
      const existingSynth = dataPoints.filter((p) => p.isSynthetic);
      const allPts = [...real, ...existingSynth];
      setDataPoints(allPts);

      const deviceKeys = [...new Set(real.map((p) => p.deviceId).filter(Boolean))].sort();
      let nextSel = selectedAUs;
      if (progressiveMode && deviceKeys.length > 1) {
        setProgressiveAuCount(1);
        nextSel = new Set([deviceKeys[0]]);
        setSelectedAUs(nextSel);
      }
      const working =
        progressiveMode && deviceKeys.length > 1
          ? allPts.filter((p) => p.isSynthetic || nextSel.has(p.deviceId))
          : allPts;

      if (working.length < MIN_TSNE_SAMPLES) {
        setStage('idle');
        setSynthOpen(true);
        return;
      }
      await computeTSNE(working, dim);
    } catch (e) {
      setErrorMsg(e.message);
      setStage('error');
    }
  }, [loadAndExtract, computeTSNE, dim, dataPoints, progressiveMode, selectedAUs]);

  /* ── Handle Add Synthetics ─────────────────────────────────────────────── */
  const handleAddSynthAndRun = useCallback(async () => {
    cancelRef.current = false;
    const parsedConcs = synthConcs.filter(c => Number.isFinite(c));
    if (!parsedConcs.length) return;
    setStage('loading');
    setErrorMsg(null);
    setComputeProg({});
    setTsneResults({});
    try {
      let real = dataPoints.filter(p => !p.isSynthetic);
      if (real.length === 0) {
        real = await loadAndExtract();
      }
      const synths = await buildAndSaveSynthetics(synthNPerConc, parsedConcs);
      const allPts = [...real, ...synths];
      setDataPoints(allPts);
      setSynthAdded(true);
      setSynthOpen(false);
      if (allPts.length < MIN_TSNE_SAMPLES) {
        setStage('idle');
        return;
      }
      const deviceKeys = [...new Set(real.map((p) => p.deviceId).filter(Boolean))].sort();
      let nextSel = selectedAUs;
      if (progressiveMode && deviceKeys.length > 1) {
        setProgressiveAuCount(1);
        nextSel = new Set([deviceKeys[0]]);
        setSelectedAUs(nextSel);
      }
      const working =
        progressiveMode && deviceKeys.length > 1
          ? allPts.filter((p) => p.isSynthetic || nextSel.has(p.deviceId))
          : allPts;
      await computeTSNE(working, dim);
    } catch (e) {
      setErrorMsg(e.message);
      setStage('error');
    }
  }, [
    dataPoints,
    synthConcs,
    synthNPerConc,
    loadAndExtract,
    buildAndSaveSynthetics,
    computeTSNE,
    dim,
    progressiveMode,
    selectedAUs,
  ]);

  /** First `n` real AUs (sorted order) + synthetic; recompute all t-SNE groups. Does not read `progressiveMode` so it works the same tick as turning the feature on. */
  const runProgressiveEmbedding = useCallback(
    async (n) => {
      if (allAUKeys.length <= 1) return;
      const capped = Math.min(Math.max(1, Math.floor(n)), allAUKeys.length);
      setProgressiveAuCount(capped);
      const sel = new Set(allAUKeys.slice(0, capped));
      setSelectedAUs(sel);
      const subset = dataPoints.filter((p) => p.isSynthetic || sel.has(p.deviceId));
      if (subset.length < MIN_TSNE_SAMPLES) return;
      setSelectedTab('combined');
      await computeTSNE(subset, dim);
    },
    [allAUKeys, dataPoints, computeTSNE, dim]
  );

  const applyProgressiveAuCount = useCallback(
    async (n) => {
      if (!progressiveMode) return;
      await runProgressiveEmbedding(n);
    },
    [progressiveMode, runProgressiveEmbedding]
  );

  useEffect(() => {
    if (allAUKeys.length < 1) return;
    if (progressiveAuCount > allAUKeys.length) {
      setProgressiveAuCount(allAUKeys.length);
    }
  }, [allAUKeys.length, progressiveAuCount]);

  /** After a successful run, switch 2D ↔ 3D without reloading files. */
  const handleDimChange = useCallback(
    async (d) => {
      if (d === dim) return;
      setDim(d);
      const pts = getWorkingPoints();
      if (pts.length < MIN_TSNE_SAMPLES) return;
      const hasDone =
        stage === 'done' || Object.values(tsneResults).some((r) => r?.status === 'done');
      if (!hasDone) return;
      await computeTSNE(pts, d);
    },
    [dim, getWorkingPoints, stage, tsneResults, computeTSNE]
  );

  const toggleConc = useCallback((ppb) => {
    setHiddenConcs(prev => {
      const next = new Set(prev);
      if (next.has(ppb)) next.delete(ppb); else next.add(ppb);
      return next;
    });
  }, []);

  const parseSynthConcsStr = (raw) => raw.split(/[\s,;]+/).map(Number).filter(v => Number.isFinite(v) && v >= 0);

  /* ── Current tab result ────────────────────────────────────────────────── */
  const curResult = tsneResults[selectedTab] || null;
  const curProg = computeProg[selectedTab] || 0;
  const isComputing = stage === 'computing' || stage === 'loading';

  const auIdsInCurrentPlot = useMemo(() => {
    const keys = new Set();
    for (const p of curResult?.points || []) {
      keys.add(auKeyForPoint(p));
    }
    return [...keys].filter((k) => k && k !== 'UNKNOWN').sort();
  }, [curResult?.points]);

  /* ── Render ────────────────────────────────────────────────────────────── */
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -16 }}
      transition={{ duration: 0.3 }}
      style={{ minHeight: '100%', background: 'var(--bg-secondary)', color: 'var(--text-primary)',
        display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-family)' }}>

      {/* ═══ Header ═══════════════════════════════════════════════════════════ */}
      <div style={{ padding: '20px 28px 16px', borderBottom: '1px solid #334155', background: 'rgba(15,23,42,0.5)',
        display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8,
              background: 'linear-gradient(135deg,rgba(0,222,147,0.2),rgba(6,182,212,0.2))',
              border: '1px solid rgba(0,222,147,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Atom size={16} color="#00DE93" />
            </div>
            <h1 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: '#f8fafc', letterSpacing: '-0.02em' }}>t-SNE Explorer</h1>
            <span style={{ fontSize: '0.7rem', color: '#00DE93', background: 'rgba(0,222,147,0.1)',
              border: '1px solid rgba(0,222,147,0.2)', borderRadius: 20, padding: '2px 8px', fontWeight: 600 }}>BETA</span>
          </div>
          <p style={{ margin: 0, fontSize: '0.8rem', color: '#64748b', lineHeight: 1.5 }}>
            Concentration-dependent dimensionality reduction for sensor array data.&nbsp;
            {eligibleFiles.length > 0
              ? <span style={{ color: '#94a3b8' }}>{eligibleFiles.length} file{eligibleFiles.length !== 1 ? 's' : ''} with PPB labels.</span>
              : <span style={{ color: '#ef4444' }}>No PPB-labelled files. Upload files with <code style={{ fontSize: '0.75rem', color: '#f59e0b' }}>Xppb</code> in the name.</span>}
          </p>
        </div>

        {/* Controls row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* 2D / 3D toggle */}
          <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid #334155' }}>
            {[2, 3].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => handleDimChange(d)}
                disabled={isComputing}
                title={isComputing ? 'Wait for current run' : `Use ${d}D embedding (recomputes after first run)`}
                style={{
                  padding: '6px 12px',
                  border: 'none',
                  cursor: isComputing ? 'not-allowed' : 'pointer',
                  fontSize: '0.78rem',
                  fontWeight: 700,
                  background: dim === d ? 'rgba(0,222,147,0.15)' : 'transparent',
                  color: dim === d ? '#00DE93' : '#64748b',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  transition: 'all 0.15s',
                  opacity: isComputing ? 0.55 : 1,
                }}
              >
                {d === 2 ? <Square size={12} /> : <Box size={12} />} {d}D
              </button>
            ))}
          </div>

          <button onClick={() => setSettingsOpen(o => !o)}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 8,
              border: '1px solid #334155', background: settingsOpen ? 'rgba(100,116,139,0.2)' : 'transparent',
              cursor: 'pointer', color: settingsOpen ? '#cbd5e1' : '#64748b', fontSize: '0.78rem', fontWeight: 600,
              transition: 'all 0.15s' }}>
            <Settings2 size={13} /> Settings
          </button>

          <button onClick={() => setSynthOpen(o => !o)}
            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 8,
              border: synthAdded ? '1px solid rgba(168,85,247,0.4)' : '1px solid #334155',
              background: synthAdded ? 'rgba(168,85,247,0.1)' : (synthOpen ? 'rgba(168,85,247,0.08)' : 'transparent'),
              cursor: 'pointer', color: synthAdded ? '#c084fc' : (synthOpen ? '#a855f7' : '#64748b'),
              fontSize: '0.78rem', fontWeight: 600, transition: 'all 0.15s' }}>
            <Sparkles size={13} /> Synthetic
            {synthAdded && <CheckCircle size={11} style={{ marginLeft: 2, color: '#a855f7' }} />}
          </button>

          <button onClick={handleRun} disabled={isComputing || eligibleFiles.length === 0}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 18px', borderRadius: 8, border: 'none',
              background: isComputing ? 'rgba(0,222,147,0.1)' :
                (eligibleFiles.length === 0 ? 'rgba(51,65,85,0.5)' : 'linear-gradient(135deg, #00DE93, #06b6d4)'),
              cursor: (isComputing || eligibleFiles.length === 0) ? 'not-allowed' : 'pointer',
              color: isComputing ? '#00DE93' : (eligibleFiles.length === 0 ? '#475569' : '#0f172a'),
              fontSize: '0.82rem', fontWeight: 700,
              boxShadow: (!isComputing && eligibleFiles.length > 0) ? '0 0 20px rgba(0,222,147,0.3)' : 'none',
              transition: 'all 0.2s' }}>
            {isComputing ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Running…</> : <><Play size={13} /> Run t-SNE</>}
          </button>
        </div>
      </div>

      {/* ═══ Settings Panel ═══════════════════════════════════════════════════ */}
      <AnimatePresence>
        {settingsOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} style={{ overflow: 'hidden', borderBottom: '1px solid #334155' }}>
            <div style={{ padding: '14px 28px', background: 'rgba(15,23,42,0.4)', display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              {[
                { label: 'Perplexity', value: perplexity, set: setPerplexity, min: 5, max: 100, step: 5, hint: 'Neighbourhood size (5–50)' },
                { label: 'Iterations', value: nIter, set: setNIter, min: 100, max: 2000, step: 100, hint: 'More = better quality, slower' },
                { label: 'Learning rate ε', value: epsilon, set: setEpsilon, min: 1, max: 200, step: 5, hint: 'Step size for gradient descent' },
              ].map(({ label, value, set, min, max, step, hint }) => (
                <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600 }}>{label}</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="range" min={min} max={max} step={step} value={value}
                      onChange={e => set(Number(e.target.value))} style={{ width: 120, accentColor: '#00DE93' }} />
                    <span style={{ fontSize: '0.82rem', color: '#00DE93', fontWeight: 700, minWidth: 36 }}>{value}</span>
                  </div>
                  <span style={{ fontSize: '0.68rem', color: '#475569' }}>{hint}</span>
                </div>
              ))}
              <div style={{ fontSize: '0.72rem', color: '#475569', maxWidth: 220, lineHeight: 1.6 }}>
                <Info size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                Settings apply on next run. Dimension: {dim}D.
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══ Synthetic Data Panel ═════════════════════════════════════════════ */}
      <AnimatePresence>
        {synthOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} style={{ overflow: 'hidden', borderBottom: '1px solid #334155' }}>
            <div style={{ padding: '16px 28px', background: 'linear-gradient(135deg, rgba(168,85,247,0.05), rgba(15,23,42,0.3))',
              borderBottom: '1px solid rgba(168,85,247,0.15)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <Sparkles size={14} color="#a855f7" />
                <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#c084fc' }}>Synthetic Data Generator</span>
                <span style={{ fontSize: '0.72rem', color: '#64748b', marginLeft: 4 }}>
                  — same row data as t-SNE points; CSVs go to <code style={{ color: '#a78bfa' }}>FeNOse_synthetic/</code>
                </span>
              </div>

              {eligibleFiles.length < WARN_REAL_SAMPLES && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 12px',
                  background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
                  borderRadius: 8, marginBottom: 12, fontSize: '0.78rem', color: '#d97706' }}>
                  <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                  <span>Only <b>{eligibleFiles.length}</b> PPB-labelled files. t-SNE needs {MIN_TSNE_SAMPLES}+ samples and works best with 15+. Add synthetic data below.</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600 }}>Samples per concentration</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="number" min={1} max={200} value={synthNPerConc}
                      onChange={e => setSynthNPerConc(Math.max(1, Math.min(200, Number(e.target.value))))}
                      style={{ width: 80, padding: '5px 10px', background: '#1e293b', border: '1px solid #475569',
                        borderRadius: 6, color: '#f8fafc', fontSize: '0.82rem', outline: 'none' }} />
                    <span style={{ fontSize: '0.72rem', color: '#64748b' }}>samples</span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 200 }}>
                  <label style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600 }}>Concentrations (ppb, comma-separated)</label>
                  <input type="text" value={synthConcInput}
                    onChange={e => { setSynthConcInput(e.target.value); setSynthConcs(parseSynthConcsStr(e.target.value)); }}
                    placeholder="0,5,10,25,50,100"
                    style={{ width: '100%', padding: '5px 10px', background: '#1e293b', border: '1px solid #475569',
                      borderRadius: 6, color: '#f8fafc', fontSize: '0.82rem', outline: 'none' }} />
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                    {synthConcs.map(c => (
                      <span key={c} style={{ fontSize: '0.68rem', padding: '2px 6px', borderRadius: 20,
                        background: `${ppbToColor(c)}22`, color: ppbToColor(c), border: `1px solid ${ppbToColor(c)}44` }}>
                        {c} ppb
                      </span>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                    Total: <b style={{ color: '#c084fc' }}>{synthNPerConc * synthConcs.length}</b> synthetic samples
                  </div>
                  <button onClick={handleAddSynthAndRun} disabled={isComputing || synthConcs.length === 0 || synthSaving}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8,
                      border: '1px solid rgba(168,85,247,0.4)',
                      background: isComputing ? 'rgba(168,85,247,0.05)' : 'rgba(168,85,247,0.15)',
                      cursor: (isComputing || !synthConcs.length) ? 'not-allowed' : 'pointer',
                      color: '#c084fc', fontSize: '0.8rem', fontWeight: 700, transition: 'all 0.15s' }}>
                    {isComputing || synthSaving
                      ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> {synthSaving ? 'Saving…' : 'Generating…'}</>
                      : <><Sparkles size={13} /> Generate & Run</>}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══ Error ════════════════════════════════════════════════════════════ */}
      {errorMsg && (
        <div style={{ margin: '12px 28px 0', padding: '10px 14px', background: 'rgba(239,68,68,0.1)',
          border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, display: 'flex', gap: 8,
          alignItems: 'flex-start', fontSize: '0.8rem', color: '#fca5a5' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} style={{ marginLeft: 'auto', background: 'transparent',
            border: 'none', cursor: 'pointer', color: '#f87171', padding: 0 }}><X size={13} /></button>
        </div>
      )}

      {/* ═══ Loading Progress ═════════════════════════════════════════════════ */}
      <AnimatePresence>
        {stage === 'loading' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ padding: '10px 28px', display: 'flex', alignItems: 'center', gap: 10,
              fontSize: '0.78rem', color: '#94a3b8', borderBottom: '1px solid #334155', background: 'rgba(0,222,147,0.04)' }}>
            <Loader2 size={13} style={{ animation: 'spin 1s linear infinite', color: '#00DE93' }} />
            <span>Loading & extracting features…</span>
            <div style={{ flex: 1, height: 3, borderRadius: 3, background: '#1e293b', overflow: 'hidden' }}>
              <motion.div style={{ height: '100%', background: 'linear-gradient(90deg,#00DE93,#06b6d4)', borderRadius: 3 }}
                animate={{ width: `${Math.round(loadProg * 100)}%` }} transition={{ duration: 0.2 }} />
            </div>
            <span style={{ color: '#00DE93', fontWeight: 600 }}>{Math.round(loadProg * 100)}%</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══ Tab bar ══════════════════════════════════════════════════════════ */}
      {(stage === 'computing' || stage === 'done') && tabs.length > 0 && (
        <div style={{ padding: '0 28px', borderBottom: '1px solid #334155', display: 'flex', gap: 0,
          overflowX: 'auto', background: 'rgba(15,23,42,0.3)', flexShrink: 0 }}>
          {tabs.map(tab => {
            const res = tsneResults[tab.key];
            const active = selectedTab === tab.key;
            const isRunning = res?.status === 'running';
            return (
              <button key={tab.key} onClick={() => setSelectedTab(tab.key)}
                style={{ padding: '10px 16px', border: 'none',
                  borderBottom: active ? '2px solid #00DE93' : '2px solid transparent',
                  background: 'transparent', cursor: 'pointer',
                  color: active ? '#00DE93' : '#64748b',
                  fontSize: '0.78rem', fontWeight: active ? 700 : 500,
                  display: 'flex', alignItems: 'center', gap: 6, transition: 'all 0.15s', whiteSpace: 'nowrap' }}>
                {isRunning && <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />}
                {res?.status === 'done' && <CheckCircle size={11} style={{ color: '#00DE93' }} />}
                {res?.status === 'error' && <AlertTriangle size={11} style={{ color: '#ef4444' }} />}
                {res?.status === 'skipped' && <Info size={11} style={{ color: '#f59e0b' }} />}
                {tab.label}
                <span style={{ fontSize: '0.68rem', color: active ? '#00DE93' : '#475569',
                  background: active ? 'rgba(0,222,147,0.1)' : 'rgba(51,65,85,0.5)',
                  borderRadius: 20, padding: '1px 6px', fontWeight: 700 }}>{tab.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ═══ Main content ═════════════════════════════════════════════════════ */}
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 28px', display: 'flex', gap: 20, flexWrap: 'wrap', minHeight: 0 }}>

        {/* ── Idle states ────────────────────────────────────────────────────── */}
        {stage === 'idle' && eligibleFiles.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 16, padding: 40, color: '#475569' }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, border: '1px solid #334155',
              display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.6)' }}>
              <Atom size={26} color="#334155" />
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '1rem', fontWeight: 600, color: '#64748b', marginBottom: 6 }}>No PPB-labelled data</div>
              <div style={{ fontSize: '0.8rem', color: '#475569', maxWidth: 340, lineHeight: 1.6 }}>
                Upload CSV files with <code style={{ color: '#f59e0b' }}>Xppb</code> in the filename,
                or use Synthetic Data to generate example data.
              </div>
            </div>
            <button onClick={() => setSynthOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8,
                border: '1px solid rgba(168,85,247,0.3)', background: 'rgba(168,85,247,0.08)',
                cursor: 'pointer', color: '#c084fc', fontSize: '0.8rem', fontWeight: 600 }}>
              <Sparkles size={13} /> Generate synthetic data to explore
            </button>
          </div>
        )}

        {stage === 'idle' && eligibleFiles.length > 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 12, color: '#475569', padding: 40 }}>
            <GitBranch size={32} color="#334155" />
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '1rem', fontWeight: 600, color: '#64748b', marginBottom: 6 }}>Ready to compute</div>
              <div style={{ fontSize: '0.8rem', color: '#475569', maxWidth: 320, lineHeight: 1.6 }}>
                {eligibleFiles.length} file{eligibleFiles.length !== 1 ? 's' : ''} available.
                {eligibleFiles.length < WARN_REAL_SAMPLES
                  ? ` Consider adding synthetic data (${WARN_REAL_SAMPLES}+ recommended).`
                  : ' Click Run t-SNE to start.'}
              </div>
            </div>
            {eligibleFiles.length < WARN_REAL_SAMPLES && (
              <button onClick={() => setSynthOpen(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8,
                  border: '1px solid rgba(168,85,247,0.3)', background: 'rgba(168,85,247,0.08)',
                  cursor: 'pointer', color: '#c084fc', fontSize: '0.78rem', fontWeight: 600 }}>
                <Sparkles size={12} /> Add synthetic data
              </button>
            )}
          </div>
        )}

        {/* ── Computing progress ──────────────────────────────────────────── */}
        {stage === 'computing' && curResult?.status === 'running' && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 16, padding: 40 }}>
            <div style={{ position: 'relative', width: 80, height: 80 }}>
              <svg width={80} height={80}>
                <circle cx={40} cy={40} r={34} fill="none" stroke="#1e293b" strokeWidth={5} />
                <circle cx={40} cy={40} r={34} fill="none" stroke="#00DE93" strokeWidth={5}
                  strokeLinecap="round" strokeDasharray={`${2 * Math.PI * 34}`}
                  strokeDashoffset={`${2 * Math.PI * 34 * (1 - curProg)}`}
                  transform="rotate(-90 40 40)" style={{ transition: 'stroke-dashoffset 0.3s ease' }} />
              </svg>
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: '0.9rem', fontWeight: 700, color: '#00DE93' }}>
                {Math.round(curProg * 100)}%
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#94a3b8', marginBottom: 4 }}>
                Computing {dim}D t-SNE — {selectedTab === 'combined' ? 'All AUs' : shortAuLabel(selectedTab)}
              </div>
              <div style={{ fontSize: '0.78rem', color: '#475569' }}>Iteration {Math.round(curProg * nIter)} / {nIter}</div>
            </div>
          </div>
        )}

        {/* ── Done — plot ─────────────────────────────────────────────────── */}
        {(stage === 'done' || (stage === 'computing' && curResult?.status === 'done')) && curResult && (
          <div style={{ flex: 1, display: 'flex', gap: 20, flexWrap: 'wrap', minWidth: 0 }}>
            <div style={{ flex: 1, minWidth: 320, minHeight: 400 }}>
              {curResult.status === 'done' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {/* Stats bar */}
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {[
                      { label: 'Points', value: curResult.points.length },
                      { label: 'Real', value: curResult.points.filter(p => !p.isSynthetic).length, color: '#00DE93' },
                      { label: 'Synthetic', value: curResult.points.filter(p => p.isSynthetic).length, color: '#c084fc' },
                      { label: 'Concentrations', value: [...new Set(curResult.points.map(p => p.ppb))].length, color: '#f59e0b' },
                      { label: 'Dimension', value: `${dim}D`, color: '#3b82f6' },
                    ].map(s => (
                      <div key={s.label} style={{ padding: '5px 12px', borderRadius: 8,
                        background: 'rgba(15,23,42,0.6)', border: '1px solid #334155',
                        display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <span style={{ fontSize: '1rem', fontWeight: 700, color: s.color || '#f8fafc' }}>{s.value}</span>
                        <span style={{ fontSize: '0.68rem', color: '#64748b' }}>{s.label}</span>
                      </div>
                    ))}
                  </div>

                  {dim === 2
                    ? <TSNEPlot2D points={curResult.points}
                        width={Math.min(640, window.innerWidth - 380)} height={460}
                        hiddenConcs={hiddenConcs} auColorMap={auColorMapGlobal} />
                    : <TSNEPlot3D points={curResult.points}
                        width={Math.min(640, window.innerWidth - 380)} height={460}
                        hiddenConcs={hiddenConcs} auColorMap={auColorMapGlobal} />}

                  <div style={{ fontSize: '0.7rem', color: '#475569', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    {dim === 2
                      ? <span>Scroll to zoom · Drag to pan · Double-click to reset</span>
                      : <span>Drag to rotate · Scroll to zoom · Auto-rotate toggleable</span>}
                    <span>Color = AU · Larger dot = higher ppb · dashed ring = synthetic</span>
                    <span>Perp {perplexity} · {nIter} iter · ε={epsilon}</span>
                  </div>
                </div>
              ) : curResult.status === 'skipped' ? (
                <div style={{ padding: 20, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)',
                  borderRadius: 10, fontSize: '0.82rem', color: '#d97706', display: 'flex', gap: 8 }}>
                  <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
                  <span>{curResult.reason} — need {MIN_TSNE_SAMPLES}+ samples for t-SNE.</span>
                </div>
              ) : curResult.status === 'error' ? (
                <div style={{ padding: 20, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 10, fontSize: '0.82rem', color: '#fca5a5', display: 'flex', gap: 8 }}>
                  <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
                  <span>Error: {curResult.error}</span>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300,
                  color: '#475569', fontSize: '0.85rem', gap: 8 }}>
                  <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Computing…
                </div>
              )}
            </div>

            {/* ── Right panel: Legend, Progressive AU builder, Data info ─── */}
            <div style={{ width: 210, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Concentration filter */}
              {allConcs.length > 0 && (
                <div style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid #334155', borderRadius: 10, padding: '12px 14px' }}>
                  <ConcLegend concentrations={allConcs} hiddenConcs={hiddenConcs} onToggle={toggleConc} />
                </div>
              )}

              {auIdsInCurrentPlot.length > 0 && (
                <div style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid #334155', borderRadius: 10, padding: '12px 14px' }}>
                  <AuColorLegend auIdsOrdered={auIdsInCurrentPlot} auColorMap={auColorMapGlobal} />
                </div>
              )}

              {/* Progressive: add AUs one-by-one (sorted order) */}
              {allAUKeys.length >= 1 && (
                <div style={{ background: 'rgba(15,23,42,0.6)', border: progressiveMode ? '1px solid rgba(6,182,212,0.4)' : '1px solid #334155',
                  borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      Add AUs one-by-one
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (progressiveMode) {
                          setProgressiveMode(false);
                          return;
                        }
                        setProgressiveMode(true);
                        if (allAUKeys.length > 1) {
                          const sel = new Set([allAUKeys[0]]);
                          const subset = dataPoints.filter((p) => p.isSynthetic || sel.has(p.deviceId));
                          if (
                            subset.length >= MIN_TSNE_SAMPLES &&
                            (stage === 'done' || tsneResults.combined?.status === 'done')
                          ) {
                            void runProgressiveEmbedding(1);
                          }
                        }
                      }}
                      disabled={allAUKeys.length <= 1}
                      style={{ fontSize: '0.68rem', padding: '2px 8px', borderRadius: 4, border: '1px solid #334155',
                        background: progressiveMode ? 'rgba(6,182,212,0.15)' : 'transparent',
                        color: progressiveMode ? '#22d3ee' : '#475569', cursor: allAUKeys.length <= 1 ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
                      {progressiveMode ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  {allAUKeys.length <= 1 && (
                    <div style={{ fontSize: '0.7rem', color: '#475569', lineHeight: 1.5 }}>
                      Upload PPB-labelled files from <strong>more than one</strong> aroma unit to build the combined embedding stepwise (order: sorted AU id).
                    </div>
                  )}
                  {progressiveMode && allAUKeys.length > 1 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: '0.72rem', color: '#94a3b8', lineHeight: 1.45 }}>
                        <strong>{progressiveAuCount}</strong> of <strong>{allAUKeys.length}</strong> real AUs in combined view
                        {synthInMemoryCount > 0 ? ` · +${synthInMemoryCount} synthetic` : ''}.
                        Order: {allAUKeys.slice(0, progressiveAuCount).map((k) => shortAuLabel(k)).join(' → ')}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        <button
                          type="button"
                          disabled={isComputing || progressiveAuCount <= 1}
                          onClick={() => void applyProgressiveAuCount(progressiveAuCount - 1)}
                          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderRadius: 6,
                            border: '1px solid #334155', background: 'rgba(15,23,42,0.8)', color: '#cbd5e1',
                            cursor: isComputing || progressiveAuCount <= 1 ? 'not-allowed' : 'pointer', fontSize: '0.72rem', fontWeight: 600 }}>
                          <ChevronLeft size={14} /> Remove last AU
                        </button>
                        <button
                          type="button"
                          disabled={isComputing || progressiveAuCount >= allAUKeys.length}
                          onClick={() => void applyProgressiveAuCount(progressiveAuCount + 1)}
                          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderRadius: 6,
                            border: '1px solid #334155', background: 'rgba(15,23,42,0.8)', color: '#00DE93',
                            cursor: isComputing || progressiveAuCount >= allAUKeys.length ? 'not-allowed' : 'pointer', fontSize: '0.72rem', fontWeight: 600 }}>
                          Add next AU <ChevronRight size={14} />
                        </button>
                        <button
                          type="button"
                          disabled={isComputing || progressiveAuCount >= allAUKeys.length}
                          onClick={() => void applyProgressiveAuCount(allAUKeys.length)}
                          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderRadius: 6,
                            border: '1px solid #334155', background: 'rgba(0,222,147,0.08)', color: '#94a3b8',
                            cursor: isComputing || progressiveAuCount >= allAUKeys.length ? 'not-allowed' : 'pointer', fontSize: '0.72rem', fontWeight: 600 }}>
                          <ChevronsRight size={14} /> All AUs
                        </button>
                      </div>
                      <div style={{ fontSize: '0.65rem', color: '#475569' }}>
                        Each step recomputes combined + per-AU tabs in {dim}D. Run t-SNE starts at 1 AU when this mode is on.
                      </div>
                    </div>
                  )}
                  {!progressiveMode && allAUKeys.length > 1 && (
                    <div style={{ fontSize: '0.7rem', color: '#475569', lineHeight: 1.5 }}>
                      Turn on to embed <strong>one AU at a time</strong> (plus synthetic), then add the next unit and watch the layout update.
                    </div>
                  )}
                </div>
              )}

              {/* AU overview (non-progressive) */}
              {!progressiveMode && Object.keys(auGroups).length > 1 && (
                <div style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid #334155', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600, letterSpacing: '0.06em',
                    textTransform: 'uppercase', marginBottom: 8 }}>AU Breakdown</div>
                  {Object.entries(auGroups).map(([did, pts]) => {
                    const res = tsneResults[did];
                    return (
                      <button key={did} onClick={() => setSelectedTab(did)}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '5px 6px', borderRadius: 6, border: 'none', background: 'transparent',
                          cursor: 'pointer', marginBottom: 2, color: selectedTab === did ? '#00DE93' : '#94a3b8',
                          transition: 'all 0.15s', fontSize: '0.78rem' }}>
                        <span style={{ fontWeight: selectedTab === did ? 700 : 400 }}>{shortAuLabel(did)}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ fontSize: '0.68rem', color: '#475569' }}>{pts.length}</span>
                          {res?.status === 'done' && <CheckCircle size={10} style={{ color: '#00DE93' }} />}
                          {res?.status === 'skipped' && <AlertTriangle size={10} style={{ color: '#f59e0b' }} />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Data info card */}
              <div style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid #334155', borderRadius: 10, padding: '12px 14px', fontSize: '0.75rem' }}>
                <div style={{ color: '#64748b', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>Dataset</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#475569' }}>Real files</span>
                    <span style={{ color: '#f8fafc', fontWeight: 600 }}>{realCount}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#475569' }}>Synthetic</span>
                    <span style={{ color: synthInMemoryCount ? '#c084fc' : '#475569', fontWeight: 600 }}>{synthInMemoryCount}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#475569' }}>AU units</span>
                    <span style={{ color: '#f8fafc', fontWeight: 600 }}>{allAUKeys.length}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#475569' }}>Dimension</span>
                    <span style={{ color: '#3b82f6', fontWeight: 600 }}>{dim}D</span>
                  </div>
                </div>
                {(synthAdded || synthInMemoryCount > 0) && (
                  <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(168,85,247,0.08)',
                    border: '1px solid rgba(168,85,247,0.2)', borderRadius: 6, fontSize: '0.7rem', color: '#a78bfa', lineHeight: 1.5 }}>
                    {synthAdded
                      ? <>Synthetic rows saved under <code>FeNOse_synthetic/</code> (delete that folder anytime).</>
                      : <>Synthetic points are in this session only — use Generate &amp; Run to save CSVs to the workspace.</>}
                  </div>
                )}
                {synthInMemoryCount === 0 && realCount < WARN_REAL_SAMPLES && (
                  <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(168,85,247,0.08)',
                    border: '1px solid rgba(168,85,247,0.2)', borderRadius: 6, fontSize: '0.7rem', color: '#a78bfa', lineHeight: 1.5 }}>
                    Tip: add synthetic data for richer clusters.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </motion.div>
  );
}
