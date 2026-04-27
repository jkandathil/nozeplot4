/**
 * Professional A* Maze Auto-Router for PCB Studio.
 *
 * Tree-based routing: each net is routed as a spanning tree. A* targets any
 * cell on the existing tree (pad areas + previously-routed trace centerlines),
 * enabling T-junction connections — just like Eagle / KiCad auto-routers.
 *
 * Features:
 *   - 4-directional Manhattan A* with turn penalty (clean orthogonal traces)
 *   - Tree-target A* (T-junction to existing same-net traces)
 *   - Same-net copper is free in the obstacle grid (pads, tracks, vias)
 *   - Multi-layer fallback with automatic via insertion
 *   - Net priority ordering (shorter nets first for better routability)
 *   - GND net skipped when GND plane exists on routing layer
 */

import { newId, activeCopperLayerIds } from './pcbDoc.js';
import { getFootprint } from './footprintLib.js';
import { NOZE_GND_PLANE_ID } from './gndPlane.js';

/* ─── Obstacle grid construction ─── */

function rotLocal(x, y, deg) {
  const r = ((Number(deg) || 0) * Math.PI) / 180;
  const c = Math.cos(r); const s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

function padWorld(pl, pad) {
  const [lx, ly] = rotLocal(pad.x, pad.y, pl.rot || 0);
  return [lx + pl.x, ly + pl.y];
}

/**
 * Build a 2D obstacle grid for a given copper layer.
 * Cells are 0 (free) or 1 (blocked).
 *
 * `skipNet` — pads, tracks, and vias on this net are left FREE so the
 * router can reach/cross them as part of the same-net spanning tree.
 */
function buildObstacleGrid(doc, layer, gridRes, clearanceMm, boardW, boardH, trackHalfWidth = 0, skipNet = null) {
  const cols = Math.ceil(boardW / gridRes);
  const rows = Math.ceil(boardH / gridRes);
  const grid = new Uint8Array(cols * rows);

  function blockCell(gx, gy) {
    if (gx >= 0 && gx < cols && gy >= 0 && gy < rows) grid[gy * cols + gx] = 1;
  }

  function blockRadius(cx, cy, radius) {
    const gx0 = Math.floor((cx - radius) / gridRes);
    const gy0 = Math.floor((cy - radius) / gridRes);
    const gx1 = Math.ceil((cx + radius) / gridRes);
    const gy1 = Math.ceil((cy + radius) / gridRes);
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++)
        blockCell(gx, gy);
  }

  function blockSegment(ax, ay, bx, by, halfWidth) {
    const hw = halfWidth + clearanceMm;
    const gx0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw) / gridRes));
    const gy0 = Math.max(0, Math.floor((Math.min(ay, by) - hw) / gridRes));
    const gx1 = Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + hw) / gridRes));
    const gy1 = Math.min(rows - 1, Math.ceil((Math.max(ay, by) + hw) / gridRes));
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++)
        blockCell(gx, gy);
  }

  // Block existing tracks (skip same-net — part of routed tree)
  for (const tr of doc.tracks || []) {
    if (tr.layer !== layer) continue;
    if (skipNet != null && tr.net === skipNet) continue;
    const pts = tr.points || [];
    const hw = (tr.widthMm || 0.35) / 2;
    for (let i = 0; i < pts.length - 1; i++)
      blockSegment(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], hw);
  }

  // Block vias (skip same-net)
  for (const v of doc.vias || []) {
    if (skipNet != null && v.net === skipNet) continue;
    blockRadius(v.x, v.y, (Number(v.diamMm) || 0.8) / 2 + clearanceMm);
  }

  // Block pads (skip same-net — A* reaches them freely)
  for (const pl of doc.placements || []) {
    const fp = getFootprint(pl.footprintId);
    if (!fp?.pads) continue;
    const plNets = pl.padNets || {};
    for (const pad of fp.pads) {
      const padNet = plNets[pad.num] || plNets[pad.id];
      if (skipNet != null && padNet === skipNet) continue;
      const [px, py] = padWorld(pl, pad);
      blockRadius(px, py, Math.max(pad.w, pad.h) / 2 + clearanceMm + trackHalfWidth);
    }
  }

  // Block copper polygons (skip GND plane — it's a pour, not an obstacle)
  for (const poly of doc.polygons || []) {
    if (poly.layer !== layer) continue;
    if (poly.id === NOZE_GND_PLANE_ID) continue;
    const pts = poly.points || [];
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      blockSegment(pts[i][0], pts[i][1], pts[j][0], pts[j][1], clearanceMm);
    }
  }

  return { grid, cols, rows };
}

/* ─── A* Pathfinding (tree-target) ─── */

/** Binary min-heap for A* open set */
class MinHeap {
  constructor() { this.data = []; }
  push(item) {
    this.data.push(item);
    this._up(this.data.length - 1);
  }
  pop() {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0) { this.data[0] = last; this._down(0); }
    return top;
  }
  get size() { return this.data.length; }
  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.data[i].f >= this.data[p].f) break;
      [this.data[i], this.data[p]] = [this.data[p], this.data[i]];
      i = p;
    }
  }
  _down(i) {
    const n = this.data.length;
    while (true) {
      let s = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.data[l].f < this.data[s].f) s = l;
      if (r < n && this.data[r].f < this.data[s].f) s = r;
      if (s === i) break;
      [this.data[i], this.data[s]] = [this.data[s], this.data[i]];
      i = s;
    }
  }
}

/**
 * A* tree-target pathfinding — Manhattan-only with turn penalty.
 *
 * Routes from `startMm` to the nearest cell in `treeGrid` (any pad or
 * previously-routed trace on the same net). This lets the router create
 * T-junctions to existing traces instead of routing pad-to-pad only.
 *
 * @param {Uint8Array} obstacleGrid — blocked cells
 * @param {Uint8Array} treeGrid — target cells (1 = part of routed tree)
 * @param {number} cols
 * @param {number} rows
 * @param {number} gridRes — mm per cell
 * @param {number[]} startMm — [x,y] source pad center
 * @param {number[][]} treePadCenters — connected pad centers (for heuristic)
 * @param {number} [maxIterations]
 * @returns {number[][] | null} waypoints in board mm
 */
function aStarPathToTree(obstacleGrid, treeGrid, cols, rows, gridRes, startMm, treePadCenters, maxIterations = 80000) {
  const sx = Math.round(startMm[0] / gridRes);
  const sy = Math.round(startMm[1] / gridRes);
  if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) return null;

  const ck = (x, y) => y * cols + x;
  if (treeGrid[ck(sx, sy)]) return [startMm];

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const TURN_PENALTY = 3.0;

  const pgc = treePadCenters.map((p) => [Math.round(p[0] / gridRes), Math.round(p[1] / gridRes)]);
  const heuristic = (x, y) => {
    let best = Infinity;
    for (const [px, py] of pgc) {
      const d = Math.abs(x - px) + Math.abs(y - py);
      if (d < best) best = d;
    }
    return best;
  };

  const sk = (x, y, d) => (y * cols + x) * 5 + d;
  const gScore = new Map();
  const cameFrom = new Map();
  const open = new MinHeap();

  const s0 = sk(sx, sy, 4);
  gScore.set(s0, 0);
  open.push({ x: sx, y: sy, dir: 4, f: heuristic(sx, sy), g: 0 });

  let it = 0;
  while (open.size > 0 && it < maxIterations) {
    it++;
    const cur = open.pop();
    const curK = sk(cur.x, cur.y, cur.dir);
    const bg = gScore.get(curK);
    if (bg !== undefined && cur.g > bg) continue;

    if (treeGrid[ck(cur.x, cur.y)]) {
      const rawPath = [];
      let k = curK;
      while (k !== undefined) {
        const d = k % 5, ci = (k - d) / 5;
        rawPath.push([(ci % cols) * gridRes, Math.floor(ci / cols) * gridRes]);
        k = cameFrom.get(k);
      }
      rawPath.reverse();
      return simplifyManhattanPath(rawPath);
    }

    for (let d = 0; d < 4; d++) {
      const nx = cur.x + dirs[d][0], ny = cur.y + dirs[d][1];
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const ci = ck(nx, ny);
      if (obstacleGrid[ci] && !treeGrid[ci]) continue;

      let cost = 1;
      if (cur.dir !== 4 && cur.dir !== d) cost += TURN_PENALTY;
      const tg = cur.g + cost;
      const nk = sk(nx, ny, d);
      const pg = gScore.get(nk);
      if (pg !== undefined && tg >= pg) continue;

      gScore.set(nk, tg);
      cameFrom.set(nk, curK);
      open.push({ x: nx, y: ny, dir: d, f: tg + heuristic(nx, ny), g: tg });
    }
  }
  return null;
}

/**
 * Simplify Manhattan path: keep only start, corners, and end.
 */
function simplifyManhattanPath(path) {
  if (path.length <= 2) return path;
  const result = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const [px, py] = path[i - 1];
    const [cx, cy] = path[i];
    const [nx, ny] = path[i + 1];
    if (Math.sign(cx - px) !== Math.sign(nx - cx) || Math.sign(cy - py) !== Math.sign(ny - cy))
      result.push(path[i]);
  }
  result.push(path[path.length - 1]);
  return result;
}

/* ─── Main Auto-Route function ─── */

/**
 * Auto-route all unconnected nets using tree-based A* pathfinding.
 * @param {object} doc  PCB document
 * @param {Map<string, number[][]>} padCentersByNet  Net → pad positions
 * @param {object} [options]
 * @returns {{ tracks: object[], vias: object[] }}
 */
export function autoRoute(doc, padCentersByNet, options = {}) {
  const {
    gridResolution = 0.25,
    maxIterationsPerNet = 80000,
    routeLayer: routeLayerOpt = null,
  } = options;

  const boardW = Number(doc.meta?.boardWmm) || 80;
  const boardH = Number(doc.meta?.boardHmm) || 50;
  const clearanceMm = doc.meta?.designRules?.minCopperClearanceMm || 0.2;
  const trackWidth = doc.meta?.defaultTrackMm || 0.35;
  const trackHalfW = trackWidth / 2;
  const stack = activeCopperLayerIds(doc);

  const defaultRouteLayer =
    routeLayerOpt && stack.includes(String(routeLayerOpt))
      ? String(routeLayerOpt)
      : stack.includes('F.Cu') ? 'F.Cu' : stack[0];

  const newTracks = [];
  const newVias = [];

  // Skip GND net when a GND copper pour exists on the routing layer
  const gndPlaneOnRouteLayer = (doc.polygons || []).some(
    (p) => p.id === NOZE_GND_PLANE_ID && String(p.net || '') === '0' && p.layer === defaultRouteLayer,
  );

  const netEntries = [...padCentersByNet.entries()]
    .filter(([net, pts]) => {
      if (pts.length < 2 || net == null || String(net) === '') return false;
      if (gndPlaneOnRouteLayer && (String(net).trim() === '0' || String(net).trim().toLowerCase() === 'gnd')) return false;
      return true;
    })
    .sort((a, b) => a[1].length - b[1].length);

  let workingDoc = JSON.parse(JSON.stringify(doc));

  for (const [net, pts] of netEntries) {
    if (pts.length < 2) continue;
    const layer = defaultRouteLayer;

    // Build obstacle grid — same-net copper is free
    const { grid, cols, rows } = buildObstacleGrid(
      workingDoc, layer, gridResolution, clearanceMm, boardW, boardH, trackHalfW, net
    );

    /* ── Tree grid: marks cells that are part of the routed spanning tree ── */
    const treeGrid = new Uint8Array(cols * rows);

    // Helper: mark pad-area cells as tree targets
    const markPadInTree = (px, py, pad) => {
      const r = Math.max(pad.w, pad.h) / 2;
      const gx0 = Math.max(0, Math.floor((px - r) / gridResolution));
      const gy0 = Math.max(0, Math.floor((py - r) / gridResolution));
      const gx1 = Math.min(cols - 1, Math.ceil((px + r) / gridResolution));
      const gy1 = Math.min(rows - 1, Math.ceil((py + r) / gridResolution));
      for (let gy = gy0; gy <= gy1; gy++)
        for (let gx = gx0; gx <= gx1; gx++)
          treeGrid[gy * cols + gx] = 1;
    };

    // Helper: mark trace centerline cells as tree (for T-junction targets)
    const markTraceInTree = (path) => {
      for (let i = 0; i < path.length - 1; i++) {
        const gax = Math.round(path[i][0] / gridResolution);
        const gay = Math.round(path[i][1] / gridResolution);
        const gbx = Math.round(path[i + 1][0] / gridResolution);
        const gby = Math.round(path[i + 1][1] / gridResolution);
        const steps = Math.max(Math.abs(gbx - gax), Math.abs(gby - gay));
        for (let s = 0; s <= steps; s++) {
          const gx = steps === 0 ? gax : Math.round(gax + (gbx - gax) * s / steps);
          const gy = steps === 0 ? gay : Math.round(gay + (gby - gay) * s / steps);
          if (gx >= 0 && gx < cols && gy >= 0 && gy < rows)
            treeGrid[gy * cols + gx] = 1;
        }
      }
    };

    // Collect same-net pad info for tree seeding
    const padInfos = [];
    for (const pl of workingDoc.placements || []) {
      const fp = getFootprint(pl.footprintId);
      if (!fp?.pads) continue;
      const plNets = pl.padNets || {};
      for (const pad of fp.pads) {
        const padNet = plNets[pad.num] || plNets[pad.id];
        if (padNet !== net) continue;
        const [px, py] = padWorld(pl, pad);
        padInfos.push({ px, py, pad });
      }
    }

    // Seed tree with pad 0
    const connectedIdxs = new Set([0]);
    // Mark pad 0 cells
    for (const pi of padInfos) {
      if (Math.hypot(pi.px - pts[0][0], pi.py - pts[0][1]) < 0.01) {
        markPadInTree(pi.px, pi.py, pi.pad);
        break;
      }
    }
    // Ensure center cell is in tree
    const g0x = Math.round(pts[0][0] / gridResolution);
    const g0y = Math.round(pts[0][1] / gridResolution);
    if (g0x >= 0 && g0x < cols && g0y >= 0 && g0y < rows) treeGrid[g0y * cols + g0x] = 1;

    // Route each remaining pad to the tree (Prim's order: closest first)
    while (connectedIdxs.size < pts.length) {
      let bestDist = Infinity, bestIdx = -1;
      for (let i = 0; i < pts.length; i++) {
        if (connectedIdxs.has(i)) continue;
        for (const ci of connectedIdxs) {
          const d = Math.hypot(pts[i][0] - pts[ci][0], pts[i][1] - pts[ci][1]);
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
      }
      if (bestIdx < 0) break;

      // Heuristic reference points = connected pad centers
      const treePads = [];
      for (const ci of connectedIdxs) treePads.push(pts[ci]);

      const path = aStarPathToTree(
        grid, treeGrid, cols, rows, gridResolution,
        pts[bestIdx], treePads, maxIterationsPerNet
      );

      if (path && path.length >= 2) {
        // Snap start to exact pad center
        path[0] = [pts[bestIdx][0], pts[bestIdx][1]];

        const track = { id: newId('tr'), layer, widthMm: trackWidth, net, points: path };
        newTracks.push(track);
        workingDoc.tracks.push(track);

        // Grow the tree with the new trace
        markTraceInTree(path);
      } else {
        // Alt-layer fallback with vias
        const altLayer = stack.find((ly) => ly !== layer) || layer;
        if (altLayer !== layer && stack.length > 1) {
          const alt = buildObstacleGrid(workingDoc, altLayer, gridResolution, clearanceMm, boardW, boardH, trackHalfW, net);
          // Build a simple tree grid for alt layer (just pad cells)
          const altTree = new Uint8Array(alt.cols * alt.rows);
          for (const ci of connectedIdxs) {
            const gx = Math.round(pts[ci][0] / gridResolution);
            const gy = Math.round(pts[ci][1] / gridResolution);
            if (gx >= 0 && gx < alt.cols && gy >= 0 && gy < alt.rows)
              altTree[gy * alt.cols + gx] = 1;
          }
          const treePads = [];
          for (const ci of connectedIdxs) treePads.push(pts[ci]);

          const altPath = aStarPathToTree(alt.grid, altTree, alt.cols, alt.rows, gridResolution,
            pts[bestIdx], treePads, maxIterationsPerNet);

          if (altPath && altPath.length >= 2) {
            altPath[0] = [pts[bestIdx][0], pts[bestIdx][1]];
            const viaDrill = doc.meta?.defaultViaDrillMm || 0.4;
            const viaDiam = doc.meta?.defaultViaDiamMm || 0.8;
            const endPt = altPath[altPath.length - 1];
            newVias.push({ id: newId('via'), x: pts[bestIdx][0], y: pts[bestIdx][1], drillMm: viaDrill, diamMm: viaDiam, net });
            newVias.push({ id: newId('via'), x: endPt[0], y: endPt[1], drillMm: viaDrill, diamMm: viaDiam, net });

            const track = { id: newId('tr'), layer: altLayer, widthMm: trackWidth, net, points: altPath };
            newTracks.push(track);
            workingDoc.tracks.push(track);
            workingDoc.vias.push(...newVias.slice(-2));
            markTraceInTree(altPath);
          }
          // No blind L-path fallback — skip unroutable connections
        }
      }

      // Mark this pad in tree + connected set (even if routing failed, to avoid infinite loop)
      connectedIdxs.add(bestIdx);
      for (const pi of padInfos) {
        if (Math.hypot(pi.px - pts[bestIdx][0], pi.py - pts[bestIdx][1]) < 0.01) {
          markPadInTree(pi.px, pi.py, pi.pad);
          break;
        }
      }
      const gpx = Math.round(pts[bestIdx][0] / gridResolution);
      const gpy = Math.round(pts[bestIdx][1] / gridResolution);
      if (gpx >= 0 && gpx < cols && gpy >= 0 && gpy < rows) treeGrid[gpy * cols + gpx] = 1;
    }
  }

  return { tracks: newTracks, vias: newVias };
}
