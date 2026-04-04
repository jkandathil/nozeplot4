/**
 * TSNEPage.jsx
 * Concentration-dependent t-SNE visualization for each AU unit individually
 * and a combined t-SNE plot using data from all AU units.
 */

/* eslint-disable react-hooks/set-state-in-effect */
import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import tsnejs from 'tsne';
import { motion, AnimatePresence } from 'framer-motion'; // eslint-disable-line no-unused-vars
import {
  Play, Settings2, AlertTriangle, Sparkles,
  Loader2, CheckCircle, Info, ZoomIn, ZoomOut,
  Maximize2, Eye, EyeOff, GitBranch, X,
  Atom
} from 'lucide-react';
import {
  extractFenoseFeaturesFromRows,
  parseFenoseDeviceIdFromFilename,
  parseFenosePpbFromFilename,
} from '../utils/fenoseModel';
import { parseFile } from '../utils/fileParser';
import {
  generateSyntheticFenoseRows,
  computeCalibrationFromFiles,
  resolveSyntheticCalibration,
} from '../utils/fenoseSyntheticDataset';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants & Pure Helpers
// ═══════════════════════════════════════════════════════════════════════════════

const MIN_TSNE_SAMPLES = 4;    // absolute minimum for t-SNE
const WARN_REAL_SAMPLES = 8;   // below this → show synthetic option

// Concentration colour ramp (ppb → colour)
const CONC_RAMP = [
  { ppb: 0,   hex: '#64748b' }, // slate
  { ppb: 5,   hex: '#06b6d4' }, // cyan
  { ppb: 10,  hex: '#10b981' }, // emerald
  { ppb: 25,  hex: '#f59e0b' }, // amber
  { ppb: 50,  hex: '#ef4444' }, // red
  { ppb: 100, hex: '#a855f7' }, // purple
  { ppb: 200, hex: '#f472b6' }, // pink
  { ppb: 500, hex: '#fb923c' }, // orange
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
  for (const v of mat) for (let d=0;d<D;d++) mu[d] += v[d] / mat.length;
  for (const v of mat) for (let d=0;d<D;d++) sd[d] += (v[d]-mu[d])**2 / mat.length;
  for (let d=0;d<D;d++) sd[d] = Math.sqrt(sd[d]) || 1;
  return mat.map(v => v.map((x,d) => (x - mu[d]) / sd[d]));
}

async function runTSNEAsync(featureMatrix, { perplexity=30, epsilon=10, nIter=500 }, onProgress) {
  const safePerp = Math.min(perplexity, Math.max(2, featureMatrix.length - 2));
  const model = new tsnejs.tSNE({ perplexity: safePerp, dim: 2, epsilon });
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
// Interactive SVG Scatter Plot
// ═══════════════════════════════════════════════════════════════════════════════

function TSNEPlot({ points = [], width = 560, height = 460, hiddenConcs }) {
  const svgRef = useRef(null);
  const [transform, setTransform] = useState({ tx: 0, ty: 0, s: 1 });
  const [tooltip, setTooltip] = useState(null);
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  const MARGIN = { top: 20, right: 20, bottom: 20, left: 20 };
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const visible = useMemo(
    () => points.filter(p => !(hiddenConcs?.has(p.ppb))),
    [points, hiddenConcs]
  );

  const { xMin, xMax, yMin, yMax } = useMemo(() => {
    if (!visible.length) return { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const p of visible) {
      if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y;
    }
    const xPad = (xMax - xMin) * 0.08 || 1;
    const yPad = (yMax - yMin) * 0.08 || 1;
    return { xMin: xMin-xPad, xMax: xMax+xPad, yMin: yMin-yPad, yMax: yMax+yPad };
  }, [visible]);

  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  // Reset transform to fit-to-view
  const resetTransform = useCallback(() => {
    setTransform({ tx: MARGIN.left, ty: MARGIN.top, s: 1 });
  }, [MARGIN.left, MARGIN.top]);

  useEffect(() => { resetTransform(); }, [points, resetTransform]);

  // Zoom
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.15 : 0.87;
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (!svgRect) return;
    const mx = e.clientX - svgRect.left;
    const my = e.clientY - svgRect.top;
    setTransform(prev => {
      const newS = Math.max(0.2, Math.min(20, prev.s * delta));
      const newTx = mx - (mx - prev.tx) * (newS / prev.s);
      const newTy = my - (my - prev.ty) * (newS / prev.s);
      return { tx: newTx, ty: newTy, s: newS };
    });
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Pan
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
    // Tooltip: find nearest visible point
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (!svgRect || !visible.length) return;
    const mx = e.clientX - svgRect.left;
    const my = e.clientY - svgRect.top;
    // convert mouse to data coords
    const { tx, ty, s } = transform;
    const dataX = xMin + ((mx - tx) / (s * plotW)) * xRange;
    const dataY = yMin + ((my - ty) / (s * plotH)) * yRange;
    let nearest = null, minDist2 = Infinity;
    for (const p of visible) {
      const d2 = (p.x - dataX)**2 + (p.y - dataY)**2;
      if (d2 < minDist2) { minDist2 = d2; nearest = p; }
    }
    const pixelThresh = (15 / s) ** 2 * (xRange / plotW) ** 2;
    if (nearest && minDist2 < pixelThresh * xRange ** 2) {
      setTooltip({ point: nearest, sx: e.clientX - svgRect.left, sy: e.clientY - svgRect.top });
    } else {
      setTooltip(null);
    }
  }, [visible, transform, xMin, yMin, xRange, yRange, plotW, plotH]);
  const onMouseUp = useCallback((e) => {
    isPanning.current = false;
    if (e.currentTarget) e.currentTarget.style.cursor = 'grab';
  }, []);
  const onMouseLeave = useCallback(() => {
    isPanning.current = false;
    setTooltip(null);
  }, []);

  if (!points.length) {
    return (
      <div style={{ width, height, display:'flex', alignItems:'center', justifyContent:'center',
        background:'rgba(15,23,42,0.6)', borderRadius:12, border:'1px solid #334155', color:'#64748b', fontSize:'0.85rem' }}>
        No t-SNE data — click Run to compute.
      </div>
    );
  }

  const { tx, ty, s } = transform;
  const groupTransform = `translate(${tx},${ty}) scale(${s})`;

  const ptX = (p) => ((p.x - xMin) / xRange) * plotW;
  const ptY = (p) => ((p.y - yMin) / yRange) * plotH;
  const r = Math.max(2.5, 5 / s);

  return (
    <div style={{ position:'relative', userSelect:'none' }}>
      {/* Zoom controls */}
      <div style={{ position:'absolute', top:8, right:8, zIndex:10, display:'flex', flexDirection:'column', gap:4 }}>
        {[
          { icon: <ZoomIn size={13}/>, action: () => setTransform(p=>({...p, s:Math.min(20,p.s*1.3), tx:p.tx-(plotW/2)*0.3, ty:p.ty-(plotH/2)*0.3})), title:'Zoom in' },
          { icon: <ZoomOut size={13}/>, action: () => setTransform(p=>({...p, s:Math.max(0.2,p.s/1.3), tx:p.tx+(plotW/2)*0.23, ty:p.ty+(plotH/2)*0.23})), title:'Zoom out' },
          { icon: <Maximize2 size={13}/>, action: resetTransform, title:'Reset view' },
        ].map(({icon, action, title}) => (
          <button key={title} onClick={action} title={title}
            style={{ background:'rgba(15,23,42,0.85)', border:'1px solid #334155', borderRadius:6,
              width:26, height:26, display:'flex', alignItems:'center', justifyContent:'center',
              cursor:'pointer', color:'#94a3b8', transition:'color 0.15s' }}
            onMouseEnter={e=>e.currentTarget.style.color='#00DE93'}
            onMouseLeave={e=>e.currentTarget.style.color='#94a3b8'}
          >{icon}</button>
        ))}
      </div>

      <svg
        ref={svgRef}
        width={width} height={height}
        style={{ display:'block', cursor:'grab', borderRadius:10,
          background:'linear-gradient(135deg, rgba(15,23,42,0.95), rgba(30,41,59,0.95))' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onDoubleClick={resetTransform}
      >
        {/* Subtle grid lines */}
        <defs>
          <pattern id="tsne-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(51,65,85,0.4)" strokeWidth="0.5"/>
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#tsne-grid)" />

        {/* Data points */}
        <g transform={groupTransform}>
          {visible.map((p, i) => {
            const cx = ptX(p), cy = ptY(p);
            const col = ppbToColor(p.ppb);
            return (
              <g key={i}>
                {/* Glow ring for real data */}
                {!p.isSynthetic && (
                  <circle cx={cx} cy={cy} r={r * 2.2} fill={col} opacity={0.12} />
                )}
                <circle
                  cx={cx} cy={cy} r={r}
                  fill={col}
                  stroke={p.isSynthetic ? 'rgba(255,255,255,0.15)' : col}
                  strokeWidth={p.isSynthetic ? 0.8 / s : 0}
                  opacity={p.isSynthetic ? 0.65 : 0.92}
                  style={{ transition: 'r 0.1s' }}
                />
              </g>
            );
          })}
        </g>

        {/* Axis labels */}
        <text x={width/2} y={height-4} textAnchor="middle"
          fill="#475569" fontSize={10} fontFamily="Inter,sans-serif">t-SNE 1</text>
        <text x={8} y={height/2} textAnchor="middle"
          fill="#475569" fontSize={10} fontFamily="Inter,sans-serif"
          transform={`rotate(-90,8,${height/2})`}>t-SNE 2</text>
      </svg>

      {/* Tooltip */}
      <AnimatePresence>
        {tooltip && (
          <motion.div
            initial={{ opacity:0, scale:0.9 }}
            animate={{ opacity:1, scale:1 }}
            exit={{ opacity:0, scale:0.9 }}
            transition={{ duration:0.1 }}
            style={{
              position:'absolute',
              left: Math.min(tooltip.sx + 14, width - 200),
              top: Math.max(4, tooltip.sy - 60),
              background:'rgba(15,23,42,0.97)',
              border:`1px solid ${ppbToColor(tooltip.point.ppb)}55`,
              borderRadius:8, padding:'8px 12px',
              pointerEvents:'none', zIndex:20,
              boxShadow:`0 4px 20px rgba(0,0,0,0.5), 0 0 0 1px ${ppbToColor(tooltip.point.ppb)}33`,
              minWidth:140,
            }}
          >
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
              <span style={{ width:10, height:10, borderRadius:'50%', background:ppbToColor(tooltip.point.ppb), display:'inline-block', flexShrink:0 }}/>
              <span style={{ color:'#f8fafc', fontSize:'0.8rem', fontWeight:600 }}>
                {tooltip.point.ppb} ppb
              </span>
              {tooltip.point.isSynthetic && (
                <span style={{ fontSize:'0.65rem', color:'#94a3b8', background:'rgba(148,163,184,0.15)', borderRadius:4, padding:'1px 5px' }}>synthetic</span>
              )}
            </div>
            <div style={{ color:'#64748b', fontSize:'0.7rem', maxWidth:170, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {tooltip.point.fileName?.split('/').pop()?.slice(0, 40) || 'unknown'}
            </div>
            {tooltip.point.deviceId !== 'SYNTHETIC' && (
              <div style={{ color:'#475569', fontSize:'0.68rem', marginTop:2 }}>
                {shortAuLabel(tooltip.point.deviceId)}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Concentration Legend + Filter
// ═══════════════════════════════════════════════════════════════════════════════

function ConcLegend({ concentrations, hiddenConcs, onToggle }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
      <div style={{ fontSize:'0.72rem', color:'#64748b', fontWeight:600, letterSpacing:'0.06em',
        textTransform:'uppercase', marginBottom:4 }}>Concentration (ppb)</div>
      {concentrations.map(ppb => {
        const hidden = hiddenConcs.has(ppb);
        return (
          <button key={ppb} onClick={() => onToggle(ppb)}
            style={{ display:'flex', alignItems:'center', gap:8, background:'transparent', border:'none',
              cursor:'pointer', padding:'3px 0', borderRadius:6, transition:'opacity 0.15s',
              opacity: hidden ? 0.35 : 1 }}
          >
            <span style={{ width:12, height:12, borderRadius:'50%', background:ppbToColor(ppb),
              display:'inline-block', flexShrink:0, boxShadow: hidden ? 'none' : `0 0 6px ${ppbToColor(ppb)}66` }} />
            <span style={{ color: hidden ? '#475569' : '#cbd5e1', fontSize:'0.78rem', fontWeight:500 }}>
              {ppb} ppb
            </span>
            <span style={{ marginLeft:'auto', color:'#475569' }}>
              {hidden ? <EyeOff size={11}/> : <Eye size={11}/>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main TSNEPage
// ═══════════════════════════════════════════════════════════════════════════════

export default function TSNEPage({ workspaceFiles = [] }) {
  // ── Core state ──────────────────────────────────────────────────────────────
  const [stage, setStage] = useState('idle'); // idle | loading | computing | done | error
  const [loadProg, setLoadProg] = useState(0);
  const [computeProg, setComputeProg] = useState({});
  const [dataPoints, setDataPoints] = useState([]);
  const [tsneResults, setTsneResults] = useState({});
  const [selectedTab, setSelectedTab] = useState('combined');
  const [hiddenConcs, setHiddenConcs] = useState(new Set());
  const [errorMsg, setErrorMsg] = useState(null);

  // ── Settings ────────────────────────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [perplexity, setPerplexity] = useState(25);
  const [nIter, setNIter] = useState(500);
  const [epsilon, setEpsilon] = useState(10);

  // ── Synthetic panel ─────────────────────────────────────────────────────────
  const [synthOpen, setSynthOpen] = useState(false);
  const [synthNPerConc, setSynthNPerConc] = useState(15);
  const [synthConcs, setSynthConcs] = useState([0, 5, 10, 25, 50, 100]);
  const [synthConcInput, setSynthConcInput] = useState('0,5,10,25,50,100');
  const [synthAdded, setSynthAdded] = useState(false);
  const cancelRef = useRef(false);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const eligibleFiles = useMemo(() =>
    workspaceFiles.filter(f => !f.isFolder && parseFenosePpbFromFilename(f.name) !== null),
    [workspaceFiles]
  );

  const realCount = useMemo(() => dataPoints.filter(p => !p.isSynthetic).length, [dataPoints]);
  const allConcs = useMemo(
    () => [...new Set(dataPoints.map(p => p.ppb))].filter(Number.isFinite).sort((a,b) => a-b),
    [dataPoints]
  );

  const auGroups = useMemo(() => {
    const g = {};
    for (const p of dataPoints) {
      if (!p.isSynthetic) { (g[p.deviceId] = g[p.deviceId] || []).push(p); }
    }
    return g;
  }, [dataPoints]);

  const tabs = useMemo(() => {
    const list = [{ key:'combined', label:'All AUs', count: dataPoints.length }];
    for (const [did, pts] of Object.entries(auGroups)) {
      list.push({ key: did, label: shortAuLabel(did), count: pts.length });
    }
    return list;
  }, [auGroups, dataPoints.length]);

  // ── Feature extraction ───────────────────────────────────────────────────────
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
        const featVec = Object.values(feats).filter(v => Number.isFinite(v));
        if (!featVec.length) continue;
        results.push({
          feats: featVec,
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

  // ── Synthetic generation (in-memory, no workspace save) ─────────────────────
  const buildSynthetics = useCallback(async (nPerConc, concs) => {
    // compute calibration from a subset of real files
    const calFiles = [];
    for (const f of eligibleFiles.slice(0, 25)) {
      try {
        const p = await parseFile(f);
        if (p?.data?.length) calFiles.push({ data: p.data, name: f.name });
      } catch { /* skip unreadable files */ }
    }
    const pooledCal = computeCalibrationFromFiles(calFiles);
    const cal = resolveSyntheticCalibration([], pooledCal);

    const synthPts = [];
    const baseSeed = (Date.now() & 0xFFFFFF) >>> 0;
    let k = 0;
    for (const ppb of concs) {
      for (let r = 0; r < nPerConc; r++) {
        if (cancelRef.current) break;
        try {
          const rows = generateSyntheticFenoseRows({
            ppb,
            seed: (baseSeed + k * 7919) >>> 0,
            calibration: cal,
          });
          const feats = extractFenoseFeaturesFromRows(rows);
          const featVec = Object.values(feats).filter(v => Number.isFinite(v));
          if (featVec.length) synthPts.push({
            feats: featVec, ppb,
            deviceId: 'SYNTHETIC',
            fileName: `synthetic_${ppb}ppb_rep${r+1}`,
            isSynthetic: true,
          });
        } catch { /* skip failed synthetic generation */ }
        k++;
        if (k % 20 === 0) await new Promise(r2 => setTimeout(r2, 0));
      }
    }
    return synthPts;
  }, [eligibleFiles]);

  // ── t-SNE computation ────────────────────────────────────────────────────────
  const computeTSNE = useCallback(async (allPoints) => {
    setStage('computing');
    const results = {};

    // Build groups: real AU groups + combined (all)
    const groupMap = { combined: allPoints };
    for (const [did, pts] of Object.entries(
      allPoints.reduce((acc, p) => {
        if (!p.isSynthetic) (acc[p.deviceId] = acc[p.deviceId] || []).push(p);
        return acc;
      }, {})
    )) {
      if (pts.length >= MIN_TSNE_SAMPLES) groupMap[did] = pts;
      else groupMap[did] = pts; // still track, will mark as skipped
    }

    for (const [key, pts] of Object.entries(groupMap)) {
      if (cancelRef.current) break;
      if (pts.length < MIN_TSNE_SAMPLES) {
        results[key] = { status:'skipped', reason:`Only ${pts.length} samples`, points:[] };
        setTsneResults({ ...results });
        continue;
      }
      results[key] = { status:'running', points:[] };
      setTsneResults({ ...results });
      try {
        const featureMatrix = normalizeMatrix(pts.map(p => p.feats));
        const solution = await runTSNEAsync(
          featureMatrix,
          { perplexity, epsilon, nIter },
          (prog) => {
            setComputeProg(prev => ({ ...prev, [key]: prog }));
          }
        );
        results[key] = {
          status: 'done',
          points: pts.map((p, i) => ({
            x: solution[i][0], y: solution[i][1],
            ppb: p.ppb, deviceId: p.deviceId,
            fileName: p.fileName, isSynthetic: p.isSynthetic,
          })),
        };
      } catch (err) {
        results[key] = { status:'error', error: err.message, points:[] };
      }
      setTsneResults({ ...results });
    }
    setStage('done');
  }, [perplexity, epsilon, nIter]);

  // ── Handle Run ───────────────────────────────────────────────────────────────
  const handleRun = useCallback(async () => {
    cancelRef.current = false;
    setStage('loading');
    setErrorMsg(null);
    setComputeProg({});
    setSynthAdded(false);
    try {
      const real = await loadAndExtract();
      setDataPoints(real);
      if (real.length < MIN_TSNE_SAMPLES) {
        setStage('idle');
        setSynthOpen(true);
        return;
      }
      await computeTSNE(real);
    } catch (e) {
      setErrorMsg(e.message);
      setStage('error');
    }
  }, [loadAndExtract, computeTSNE]);

  // ── Handle Add Synthetics + Recompute ───────────────────────────────────────
  const handleAddSynthAndRun = useCallback(async () => {
    cancelRef.current = false;
    const parsedConcs = synthConcs.filter(c => Number.isFinite(c));
    if (!parsedConcs.length) return;
    setStage('loading');
    setErrorMsg(null);
    setComputeProg({});
    try {
      // Load real data if not loaded yet
      let real = dataPoints.filter(p => !p.isSynthetic);
      if (real.length === 0) {
        real = await loadAndExtract();
      }
      const synths = await buildSynthetics(synthNPerConc, parsedConcs);
      const allPts = [...real, ...synths];
      setDataPoints(allPts);
      setSynthAdded(true);
      setSynthOpen(false);
      await computeTSNE(allPts);
    } catch (e) {
      setErrorMsg(e.message);
      setStage('error');
    }
  }, [dataPoints, synthConcs, synthNPerConc, loadAndExtract, buildSynthetics, computeTSNE]);

  const toggleConc = useCallback((ppb) => {
    setHiddenConcs(prev => {
      const next = new Set(prev);
      if (next.has(ppb)) next.delete(ppb); else next.add(ppb);
      return next;
    });
  }, []);

  const parseSynthConcs = (raw) => {
    return raw.split(/[\s,;]+/).map(Number).filter(v => Number.isFinite(v) && v >= 0);
  };

  // ── Current tab result ───────────────────────────────────────────────────────
  const curResult = tsneResults[selectedTab] || null;
  const curProg = computeProg[selectedTab] || 0;
  const isComputing = stage === 'computing' || stage === 'loading';

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -16 }}
      transition={{ duration: 0.3 }}
      style={{
        minHeight: '100%',
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-family)',
      }}
    >

      {/* ── Header ─────────────────────────────────────────────────────────────── */}
      <div style={{
        padding: '20px 28px 16px',
        borderBottom: '1px solid #334155',
        background: 'rgba(15,23,42,0.5)',
        display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
            <div style={{
              width:32, height:32, borderRadius:8,
              background:'linear-gradient(135deg,rgba(0,222,147,0.2),rgba(6,182,212,0.2))',
              border:'1px solid rgba(0,222,147,0.3)',
              display:'flex', alignItems:'center', justifyContent:'center',
            }}>
              <Atom size={16} color="#00DE93" />
            </div>
            <h1 style={{ margin:0, fontSize:'1.15rem', fontWeight:700, color:'#f8fafc', letterSpacing:'-0.02em' }}>
              t-SNE Explorer
            </h1>
            <span style={{ fontSize:'0.7rem', color:'#00DE93', background:'rgba(0,222,147,0.1)',
              border:'1px solid rgba(0,222,147,0.2)', borderRadius:20, padding:'2px 8px', fontWeight:600 }}>
              BETA
            </span>
          </div>
          <p style={{ margin:0, fontSize:'0.8rem', color:'#64748b', lineHeight:1.5 }}>
            Concentration-dependent dimensionality reduction for sensor array data.&nbsp;
            {eligibleFiles.length > 0
              ? <span style={{color:'#94a3b8'}}>{eligibleFiles.length} file{eligibleFiles.length!==1?'s':''} with PPB labels found in workspace.</span>
              : <span style={{color:'#ef4444'}}>No files with PPB labels found. Upload files with <code style={{fontSize:'0.75rem',color:'#f59e0b'}}>Xppb</code> in the filename.</span>}
          </p>
        </div>

        {/* Controls */}
        <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          {/* Settings toggle */}
          <button
            onClick={() => setSettingsOpen(o => !o)}
            style={{
              display:'flex', alignItems:'center', gap:5,
              padding:'7px 12px', borderRadius:8, border:'1px solid #334155',
              background: settingsOpen ? 'rgba(100,116,139,0.2)' : 'transparent',
              cursor:'pointer', color: settingsOpen ? '#cbd5e1' : '#64748b',
              fontSize:'0.78rem', fontWeight:600, transition:'all 0.15s',
            }}
          >
            <Settings2 size={13}/> Settings
          </button>

          {/* Synthetic data */}
          <button
            onClick={() => setSynthOpen(o => !o)}
            style={{
              display:'flex', alignItems:'center', gap:5,
              padding:'7px 12px', borderRadius:8,
              border: synthAdded ? '1px solid rgba(168,85,247,0.4)' : '1px solid #334155',
              background: synthAdded ? 'rgba(168,85,247,0.1)' : (synthOpen ? 'rgba(168,85,247,0.08)' : 'transparent'),
              cursor:'pointer', color: synthAdded ? '#c084fc' : (synthOpen ? '#a855f7' : '#64748b'),
              fontSize:'0.78rem', fontWeight:600, transition:'all 0.15s',
            }}
          >
            <Sparkles size={13}/> Synthetic
            {synthAdded && <CheckCircle size={11} style={{marginLeft:2,color:'#a855f7'}}/>}
          </button>

          {/* Run button */}
          <button
            onClick={handleRun}
            disabled={isComputing || eligibleFiles.length === 0}
            style={{
              display:'flex', alignItems:'center', gap:6,
              padding:'8px 18px', borderRadius:8, border:'none',
              background: isComputing ? 'rgba(0,222,147,0.1)' :
                (eligibleFiles.length === 0 ? 'rgba(51,65,85,0.5)' :
                  'linear-gradient(135deg, #00DE93, #06b6d4)'),
              cursor: (isComputing || eligibleFiles.length === 0) ? 'not-allowed' : 'pointer',
              color: isComputing ? '#00DE93' : (eligibleFiles.length === 0 ? '#475569' : '#0f172a'),
              fontSize:'0.82rem', fontWeight:700,
              boxShadow: (!isComputing && eligibleFiles.length > 0) ? '0 0 20px rgba(0,222,147,0.3)' : 'none',
              transition:'all 0.2s',
            }}
          >
            {isComputing
              ? <><Loader2 size={14} style={{animation:'spin 1s linear infinite'}}/> Running…</>
              : <><Play size={13}/> Run t-SNE</>}
          </button>
        </div>
      </div>

      {/* ── Settings Panel ──────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {settingsOpen && (
          <motion.div
            initial={{ height:0, opacity:0 }}
            animate={{ height:'auto', opacity:1 }}
            exit={{ height:0, opacity:0 }}
            style={{ overflow:'hidden', borderBottom:'1px solid #334155' }}
          >
            <div style={{ padding:'14px 28px', background:'rgba(15,23,42,0.4)',
              display:'flex', gap:28, flexWrap:'wrap', alignItems:'flex-end' }}>
              {[
                { label:'Perplexity', value:perplexity, set:setPerplexity, min:5, max:100, step:5,
                  hint:'Controls neighbourhood size (5–50)' },
                { label:'Iterations', value:nIter, set:setNIter, min:100, max:2000, step:100,
                  hint:'More = better quality, slower' },
                { label:'Learning rate ε', value:epsilon, set:setEpsilon, min:1, max:200, step:5,
                  hint:'Step size for gradient descent' },
              ].map(({ label, value, set, min, max, step, hint }) => (
                <div key={label} style={{ display:'flex', flexDirection:'column', gap:4 }}>
                  <label style={{ fontSize:'0.72rem', color:'#94a3b8', fontWeight:600 }}>{label}</label>
                  <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                    <input type="range" min={min} max={max} step={step} value={value}
                      onChange={e => set(Number(e.target.value))}
                      style={{ width:120, accentColor:'#00DE93' }} />
                    <span style={{ fontSize:'0.82rem', color:'#00DE93', fontWeight:700, minWidth:36 }}>{value}</span>
                  </div>
                  <span style={{ fontSize:'0.68rem', color:'#475569' }}>{hint}</span>
                </div>
              ))}
              <div style={{ fontSize:'0.72rem', color:'#475569', maxWidth:220, lineHeight:1.6 }}>
                <Info size={11} style={{marginRight:4,verticalAlign:'middle'}}/>
                Settings apply on next run. Perplexity is auto-clamped to N−2 when data is limited.
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Synthetic Data Panel ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {synthOpen && (
          <motion.div
            initial={{ height:0, opacity:0 }}
            animate={{ height:'auto', opacity:1 }}
            exit={{ height:0, opacity:0 }}
            style={{ overflow:'hidden', borderBottom:'1px solid #334155' }}
          >
            <div style={{
              padding:'16px 28px',
              background:'linear-gradient(135deg, rgba(168,85,247,0.05), rgba(15,23,42,0.3))',
              borderBottom:'1px solid rgba(168,85,247,0.15)',
            }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
                <Sparkles size={14} color="#a855f7"/>
                <span style={{ fontSize:'0.85rem', fontWeight:700, color:'#c084fc' }}>
                  Synthetic Data Generator
                </span>
                <span style={{ fontSize:'0.72rem', color:'#64748b', marginLeft:4 }}>
                  — augments workspace data with calibration-aware simulated captures
                </span>
              </div>

              {eligibleFiles.length < WARN_REAL_SAMPLES && (
                <div style={{ display:'flex', alignItems:'flex-start', gap:8, padding:'8px 12px',
                  background:'rgba(245,158,11,0.08)', border:'1px solid rgba(245,158,11,0.2)',
                  borderRadius:8, marginBottom:12, fontSize:'0.78rem', color:'#d97706' }}>
                  <AlertTriangle size={13} style={{marginTop:1,flexShrink:0}}/>
                  <span>
                    Only <b>{eligibleFiles.length}</b> PPB-labelled files found. t-SNE requires at least {MIN_TSNE_SAMPLES} samples
                    and works best with 15+. Add synthetic data below, or upload more real captures.
                  </span>
                </div>
              )}

              <div style={{ display:'flex', gap:24, flexWrap:'wrap', alignItems:'flex-end' }}>
                <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                  <label style={{ fontSize:'0.72rem', color:'#94a3b8', fontWeight:600 }}>
                    Samples per concentration
                  </label>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <input type="number" min={1} max={200} value={synthNPerConc}
                      onChange={e => setSynthNPerConc(Math.max(1, Math.min(200, Number(e.target.value))))}
                      style={{
                        width:80, padding:'5px 10px', background:'#1e293b',
                        border:'1px solid #475569', borderRadius:6, color:'#f8fafc',
                        fontSize:'0.82rem', outline:'none',
                      }}
                    />
                    <span style={{ fontSize:'0.72rem', color:'#64748b' }}>samples</span>
                  </div>
                </div>

                <div style={{ display:'flex', flexDirection:'column', gap:4, flex:1, minWidth:200 }}>
                  <label style={{ fontSize:'0.72rem', color:'#94a3b8', fontWeight:600 }}>
                    Concentrations (ppb, comma-separated)
                  </label>
                  <input type="text" value={synthConcInput}
                    onChange={e => {
                      setSynthConcInput(e.target.value);
                      setSynthConcs(parseSynthConcs(e.target.value));
                    }}
                    placeholder="0,5,10,25,50,100"
                    style={{
                      width:'100%', padding:'5px 10px', background:'#1e293b',
                      border:'1px solid #475569', borderRadius:6, color:'#f8fafc',
                      fontSize:'0.82rem', outline:'none',
                    }}
                  />
                  <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginTop:2 }}>
                    {synthConcs.map(c => (
                      <span key={c} style={{ fontSize:'0.68rem', padding:'2px 6px',
                        borderRadius:20, background:`${ppbToColor(c)}22`, color: ppbToColor(c),
                        border:`1px solid ${ppbToColor(c)}44` }}>
                        {c} ppb
                      </span>
                    ))}
                  </div>
                </div>

                <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                  <div style={{ fontSize:'0.72rem', color:'#64748b' }}>
                    Total: <b style={{color:'#c084fc'}}>{synthNPerConc * synthConcs.length}</b> synthetic samples
                  </div>
                  <button
                    onClick={handleAddSynthAndRun}
                    disabled={isComputing || synthConcs.length === 0}
                    style={{
                      display:'flex', alignItems:'center', gap:6,
                      padding:'8px 16px', borderRadius:8,
                      border:'1px solid rgba(168,85,247,0.4)',
                      background: isComputing ? 'rgba(168,85,247,0.05)' : 'rgba(168,85,247,0.15)',
                      cursor: (isComputing || !synthConcs.length) ? 'not-allowed' : 'pointer',
                      color: '#c084fc', fontSize:'0.8rem', fontWeight:700,
                      transition:'all 0.15s',
                    }}
                  >
                    {isComputing
                      ? <><Loader2 size={13} style={{animation:'spin 1s linear infinite'}}/> Generating…</>
                      : <><Sparkles size={13}/> Generate & Run</>}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Error Banner ─────────────────────────────────────────────────────────── */}
      {errorMsg && (
        <div style={{ margin:'12px 28px 0', padding:'10px 14px', background:'rgba(239,68,68,0.1)',
          border:'1px solid rgba(239,68,68,0.3)', borderRadius:8,
          display:'flex', gap:8, alignItems:'flex-start', fontSize:'0.8rem', color:'#fca5a5' }}>
          <AlertTriangle size={14} style={{flexShrink:0,marginTop:1}}/>
          <span>{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} style={{ marginLeft:'auto', background:'transparent',
            border:'none', cursor:'pointer', color:'#f87171', padding:0 }}><X size={13}/></button>
        </div>
      )}

      {/* ── Loading Progress ─────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {stage === 'loading' && (
          <motion.div
            initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
            style={{ padding:'10px 28px', display:'flex', alignItems:'center', gap:10,
              fontSize:'0.78rem', color:'#94a3b8', borderBottom:'1px solid #334155',
              background:'rgba(0,222,147,0.04)' }}
          >
            <Loader2 size={13} style={{animation:'spin 1s linear infinite', color:'#00DE93'}}/>
            <span>Loading & extracting features…</span>
            <div style={{ flex:1, height:3, borderRadius:3, background:'#1e293b', overflow:'hidden' }}>
              <motion.div
                style={{ height:'100%', background:'linear-gradient(90deg,#00DE93,#06b6d4)', borderRadius:3 }}
                animate={{ width:`${Math.round(loadProg * 100)}%` }}
                transition={{ duration:0.2 }}
              />
            </div>
            <span style={{ color:'#00DE93', fontWeight:600 }}>{Math.round(loadProg*100)}%</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Tab bar ─────────────────────────────────────────────────────────────── */}
      {(stage === 'computing' || stage === 'done') && tabs.length > 0 && (
        <div style={{ padding:'0 28px', borderBottom:'1px solid #334155',
          display:'flex', gap:0, overflowX:'auto', background:'rgba(15,23,42,0.3)', flexShrink:0 }}>
          {tabs.map(tab => {
            const res = tsneResults[tab.key];
            const active = selectedTab === tab.key;
            const isRunning = res?.status === 'running';
            return (
              <button key={tab.key} onClick={() => setSelectedTab(tab.key)}
                style={{
                  padding:'10px 16px', border:'none', borderBottom: active ? '2px solid #00DE93' : '2px solid transparent',
                  background:'transparent', cursor:'pointer',
                  color: active ? '#00DE93' : '#64748b',
                  fontSize:'0.78rem', fontWeight: active ? 700 : 500,
                  display:'flex', alignItems:'center', gap:6,
                  transition:'all 0.15s', whiteSpace:'nowrap',
                }}
              >
                {isRunning && <Loader2 size={11} style={{animation:'spin 1s linear infinite'}}/>}
                {res?.status === 'done' && <CheckCircle size={11} style={{color:'#00DE93'}}/>}
                {res?.status === 'error' && <AlertTriangle size={11} style={{color:'#ef4444'}}/>}
                {res?.status === 'skipped' && <Info size={11} style={{color:'#f59e0b'}}/>}
                {tab.label}
                <span style={{ fontSize:'0.68rem', color: active ? '#00DE93' : '#475569',
                  background: active ? 'rgba(0,222,147,0.1)' : 'rgba(51,65,85,0.5)',
                  borderRadius:20, padding:'1px 6px', fontWeight:700 }}>
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Main content area ────────────────────────────────────────────────────── */}
      <div style={{ flex:1, overflow:'auto', padding:'20px 28px', display:'flex', gap:20, flexWrap:'wrap', minHeight:0 }}>

        {/* ── Idle / empty state ─────────────────────────────────────────────────── */}
        {stage === 'idle' && eligibleFiles.length === 0 && (
          <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center',
            flexDirection:'column', gap:16, padding:40, color:'#475569' }}>
            <div style={{ width:56, height:56, borderRadius:16, border:'1px solid #334155',
              display:'flex', alignItems:'center', justifyContent:'center',
              background:'rgba(15,23,42,0.6)' }}>
              <Atom size={26} color="#334155"/>
            </div>
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:'1rem', fontWeight:600, color:'#64748b', marginBottom:6 }}>
                No PPB-labelled data
              </div>
              <div style={{ fontSize:'0.8rem', color:'#475569', maxWidth:340, lineHeight:1.6 }}>
                Upload CSV files with <code style={{color:'#f59e0b'}}>Xppb</code> in the filename
                (e.g. <code style={{color:'#94a3b8'}}>capture_10ppb_rep1.csv</code>), or use Synthetic
                Data to generate example data.
              </div>
            </div>
            <button onClick={() => setSynthOpen(true)}
              style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px',
                borderRadius:8, border:'1px solid rgba(168,85,247,0.3)',
                background:'rgba(168,85,247,0.08)', cursor:'pointer',
                color:'#c084fc', fontSize:'0.8rem', fontWeight:600 }}>
              <Sparkles size={13}/> Generate synthetic data to explore
            </button>
          </div>
        )}

        {stage === 'idle' && eligibleFiles.length > 0 && (
          <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center',
            flexDirection:'column', gap:12, color:'#475569', padding:40 }}>
            <GitBranch size={32} color="#334155"/>
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:'1rem', fontWeight:600, color:'#64748b', marginBottom:6 }}>
                Ready to compute
              </div>
              <div style={{ fontSize:'0.8rem', color:'#475569', maxWidth:320, lineHeight:1.6 }}>
                {eligibleFiles.length} file{eligibleFiles.length!==1?'s':''} available.
                {eligibleFiles.length < WARN_REAL_SAMPLES
                  ? ` Consider adding synthetic data (${WARN_REAL_SAMPLES}+ samples recommended for meaningful clusters).`
                  : ' Click Run t-SNE to start.'}
              </div>
            </div>
            {eligibleFiles.length < WARN_REAL_SAMPLES && (
              <button onClick={() => setSynthOpen(true)}
                style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px',
                  borderRadius:8, border:'1px solid rgba(168,85,247,0.3)',
                  background:'rgba(168,85,247,0.08)', cursor:'pointer',
                  color:'#c084fc', fontSize:'0.78rem', fontWeight:600 }}>
                <Sparkles size={12}/> Add synthetic data
              </button>
            )}
          </div>
        )}

        {/* ── Computing — per-tab progress ─────────────────────────────────────── */}
        {stage === 'computing' && curResult?.status === 'running' && (
          <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center',
            flexDirection:'column', gap:16, padding:40 }}>
            <div style={{ position:'relative', width:80, height:80 }}>
              <svg width={80} height={80} style={{ position:'absolute', top:0, left:0 }}>
                <circle cx={40} cy={40} r={34} fill="none" stroke="#1e293b" strokeWidth={5}/>
                <circle cx={40} cy={40} r={34} fill="none" stroke="#00DE93" strokeWidth={5}
                  strokeLinecap="round"
                  strokeDasharray={`${2*Math.PI*34}`}
                  strokeDashoffset={`${2*Math.PI*34*(1-curProg)}`}
                  transform="rotate(-90 40 40)"
                  style={{ transition:'stroke-dashoffset 0.3s ease' }}/>
              </svg>
              <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center',
                justifyContent:'center', fontSize:'0.9rem', fontWeight:700, color:'#00DE93' }}>
                {Math.round(curProg*100)}%
              </div>
            </div>
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:'0.9rem', fontWeight:600, color:'#94a3b8', marginBottom:4 }}>
                Computing t-SNE — {selectedTab === 'combined' ? 'All AUs' : shortAuLabel(selectedTab)}
              </div>
              <div style={{ fontSize:'0.78rem', color:'#475569' }}>
                Iteration {Math.round(curProg * nIter)} / {nIter}
              </div>
            </div>
          </div>
        )}

        {/* ── Done — scatter plot ────────────────────────────────────────────────── */}
        {(stage === 'done' || (stage === 'computing' && curResult?.status === 'done')) && curResult && (
          <div style={{ flex:1, display:'flex', gap:20, flexWrap:'wrap', minWidth:0 }}>
            {/* Plot area */}
            <div style={{ flex:1, minWidth:320, minHeight:400 }}>
              {curResult.status === 'done' ? (
                <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  {/* Stats bar */}
                  <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
                    {[
                      { label:'Points', value: curResult.points.length },
                      { label:'Real', value: curResult.points.filter(p=>!p.isSynthetic).length, color:'#00DE93' },
                      { label:'Synthetic', value: curResult.points.filter(p=>p.isSynthetic).length, color:'#c084fc' },
                      { label:'Concentrations', value: [...new Set(curResult.points.map(p=>p.ppb))].length, color:'#f59e0b' },
                    ].map(s => (
                      <div key={s.label} style={{ padding:'5px 12px', borderRadius:8,
                        background:'rgba(15,23,42,0.6)', border:'1px solid #334155',
                        display:'flex', flexDirection:'column', alignItems:'center' }}>
                        <span style={{ fontSize:'1rem', fontWeight:700, color: s.color || '#f8fafc' }}>{s.value}</span>
                        <span style={{ fontSize:'0.68rem', color:'#64748b' }}>{s.label}</span>
                      </div>
                    ))}
                  </div>
                  <TSNEPlot
                    points={curResult.points}
                    width={Math.min(640, window.innerWidth - 380)}
                    height={460}
                    hiddenConcs={hiddenConcs}
                    title={selectedTab === 'combined' ? 'All AUs Combined' : shortAuLabel(selectedTab)}
                  />
                  <div style={{ fontSize:'0.7rem', color:'#475569', display:'flex', gap:14, flexWrap:'wrap' }}>
                    <span>⟡ Scroll to zoom · Drag to pan · Double-click to reset</span>
                    <span>⟡ Dim points = synthetic data</span>
                    <span>⟡ Perplexity {perplexity} · {nIter} iterations · ε={epsilon}</span>
                  </div>
                </div>
              ) : curResult.status === 'skipped' ? (
                <div style={{ padding:20, background:'rgba(245,158,11,0.06)', border:'1px solid rgba(245,158,11,0.2)',
                  borderRadius:10, fontSize:'0.82rem', color:'#d97706', display:'flex', gap:8 }}>
                  <AlertTriangle size={14} style={{marginTop:1, flexShrink:0}}/>
                  <span>{curResult.reason} — need at least {MIN_TSNE_SAMPLES} samples for t-SNE.</span>
                </div>
              ) : curResult.status === 'error' ? (
                <div style={{ padding:20, background:'rgba(239,68,68,0.06)', border:'1px solid rgba(239,68,68,0.2)',
                  borderRadius:10, fontSize:'0.82rem', color:'#fca5a5', display:'flex', gap:8 }}>
                  <AlertTriangle size={14} style={{marginTop:1, flexShrink:0}}/>
                  <span>Error: {curResult.error}</span>
                </div>
              ) : (
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:300,
                  color:'#475569', fontSize:'0.85rem', gap:8 }}>
                  <Loader2 size={14} style={{animation:'spin 1s linear infinite'}}/> Computing…
                </div>
              )}
            </div>

            {/* Legend + all-tab overview panel */}
            <div style={{ width:200, flexShrink:0, display:'flex', flexDirection:'column', gap:16 }}>
              {/* Concentration filter legend */}
              {allConcs.length > 0 && (
                <div style={{ background:'rgba(15,23,42,0.6)', border:'1px solid #334155',
                  borderRadius:10, padding:'12px 14px' }}>
                  <ConcLegend concentrations={allConcs} hiddenConcs={hiddenConcs} onToggle={toggleConc}/>
                </div>
              )}

              {/* Per-AU summary cards */}
              {Object.keys(auGroups).length > 1 && (
                <div style={{ background:'rgba(15,23,42,0.6)', border:'1px solid #334155',
                  borderRadius:10, padding:'12px 14px' }}>
                  <div style={{ fontSize:'0.72rem', color:'#64748b', fontWeight:600,
                    letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:8 }}>AU Breakdown</div>
                  {Object.entries(auGroups).map(([did, pts]) => {
                    const res = tsneResults[did];
                    return (
                      <button key={did} onClick={() => setSelectedTab(did)}
                        style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'space-between',
                          padding:'5px 6px', borderRadius:6, border:'none', background:'transparent',
                          cursor:'pointer', marginBottom:2,
                          color: selectedTab===did ? '#00DE93' : '#94a3b8',
                          transition:'all 0.15s', fontSize:'0.78rem' }}>
                        <span style={{ fontWeight: selectedTab===did ? 700 : 400 }}>{shortAuLabel(did)}</span>
                        <span style={{ display:'flex', alignItems:'center', gap:4 }}>
                          <span style={{ fontSize:'0.68rem', color:'#475569' }}>{pts.length}</span>
                          {res?.status === 'done' && <CheckCircle size={10} style={{color:'#00DE93'}}/>}
                          {res?.status === 'skipped' && <AlertTriangle size={10} style={{color:'#f59e0b'}}/>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Data info card */}
              <div style={{ background:'rgba(15,23,42,0.6)', border:'1px solid #334155',
                borderRadius:10, padding:'12px 14px', fontSize:'0.75rem' }}>
                <div style={{ color:'#64748b', fontWeight:600, letterSpacing:'0.06em',
                  textTransform:'uppercase', marginBottom:8 }}>Dataset</div>
                <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <span style={{color:'#475569'}}>Real files</span>
                    <span style={{color:'#f8fafc',fontWeight:600}}>{realCount}</span>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <span style={{color:'#475569'}}>Synthetic</span>
                    <span style={{color: synthAdded ? '#c084fc' : '#475569', fontWeight:600}}>
                      {dataPoints.length - realCount}
                    </span>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <span style={{color:'#475569'}}>AU units</span>
                    <span style={{color:'#f8fafc',fontWeight:600}}>{Object.keys(auGroups).length}</span>
                  </div>
                </div>
                {!synthAdded && realCount < WARN_REAL_SAMPLES && (
                  <div style={{ marginTop:8, padding:'6px 8px',
                    background:'rgba(168,85,247,0.08)', border:'1px solid rgba(168,85,247,0.2)',
                    borderRadius:6, fontSize:'0.7rem', color:'#a78bfa', lineHeight:1.5 }}>
                    Tip: add synthetic data for richer clusters.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Spinner keyframes */}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </motion.div>
  );
}
