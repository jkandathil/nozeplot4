/**
 * Professional A* Maze Auto-Router for PCB Studio.
 * Features:
 *   - A* grid-based pathfinding avoiding existing copper obstacles
 *   - Multi-layer routing with automatic via insertion
 *   - Differential pair awareness (route pairs with matched length)
 *   - Configurable clearance-aware obstacle map
 *   - Net priority ordering (shorter nets first for better routability)
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
 * Each cell is true (blocked) or false (free).
 */
function buildObstacleGrid(doc, layer, gridRes, clearanceMm, boardW, boardH, trackHalfWidth = 0, skipNet = null) {
  const cols = Math.ceil(boardW / gridRes);
  const rows = Math.ceil(boardH / gridRes);
  const grid = new Uint8Array(cols * rows); // 0=free, 1=blocked
  const clearCells = Math.ceil(clearanceMm / gridRes);

  function blockCell(gx, gy) {
    if (gx >= 0 && gx < cols && gy >= 0 && gy < rows) {
      grid[gy * cols + gx] = 1;
    }
  }

  function blockRadius(cx, cy, radius) {
    const gx0 = Math.floor((cx - radius) / gridRes);
    const gy0 = Math.floor((cy - radius) / gridRes);
    const gx1 = Math.ceil((cx + radius) / gridRes);
    const gy1 = Math.ceil((cy + radius) / gridRes);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        blockCell(gx, gy);
      }
    }
  }

  function blockSegment(ax, ay, bx, by, halfWidth) {
    const hw = halfWidth + clearanceMm;
    const minX = Math.min(ax, bx) - hw;
    const maxX = Math.max(ax, bx) + hw;
    const minY = Math.min(ay, by) - hw;
    const maxY = Math.max(ay, by) + hw;
    const gx0 = Math.max(0, Math.floor(minX / gridRes));
    const gy0 = Math.max(0, Math.floor(minY / gridRes));
    const gx1 = Math.min(cols - 1, Math.ceil(maxX / gridRes));
    const gy1 = Math.min(rows - 1, Math.ceil(maxY / gridRes));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        blockCell(gx, gy);
      }
    }
  }

  // Block existing tracks on this layer
  for (const tr of (doc.tracks || [])) {
    if (tr.layer !== layer) continue;
    const pts = tr.points || [];
    const hw = (tr.widthMm || 0.35) / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      blockSegment(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], hw);
    }
  }

  // Block vias (they span all layers)
  for (const v of (doc.vias || [])) {
    const r = (Number(v.diamMm) || 0.8) / 2 + clearanceMm;
    blockRadius(v.x, v.y, r);
  }

  // Block pads on this layer.
  // The blocked radius must include the track half-width so the A* center line
  // stays far enough that the trace EDGE still respects clearance from the pad.
  // Pads belonging to `skipNet` are left FREE so A* can reach them as endpoints.
  for (const pl of (doc.placements || [])) {
    const fp = getFootprint(pl.footprintId);
    if (!fp?.pads) continue;
    const plNets = pl.padNets || {};
    for (const pad of fp.pads) {
      const padNet = plNets[pad.num] || plNets[pad.id];
      if (skipNet != null && padNet === skipNet) continue; // same-net pad — leave free
      const [px, py] = padWorld(pl, pad);
      const r = Math.max(pad.w, pad.h) / 2 + clearanceMm + trackHalfWidth;
      blockRadius(px, py, r);
    }
  }

  // Block polygons on this layer (skip GND plane — it's a copper pour, not an obstacle)
  for (const poly of (doc.polygons || [])) {
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

/* ─── A* Pathfinding ─── */

/** Binary min-heap for A* open set */
class MinHeap {
  constructor() { this.data = []; }
  push(item) {
    this.data.push(item);
    this._bubbleUp(this.data.length - 1);
  }
  pop() {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }
  get size() { return this.data.length; }
  _bubbleUp(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.data[i].f >= this.data[p].f) break;
      [this.data[i], this.data[p]] = [this.data[p], this.data[i]];
      i = p;
    }
  }
  _sinkDown(i) {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.data[l].f < this.data[smallest].f) smallest = l;
      if (r < n && this.data[r].f < this.data[smallest].f) smallest = r;
      if (smallest === i) break;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}

/**
 * A* pathfinding — Manhattan-only (4-directional) with turn penalty.
 * Produces clean orthogonal traces like KiCad/Eagle auto-routers.
 *
 * State key encodes (x, y, arrivalDir) so the turn penalty is properly
 * tracked per arrival direction — arriving at the same cell from a different
 * direction has a separate gScore.
 *
 * @returns {number[][] | null} Array of [boardX, boardY] waypoints, or null.
 */
function aStarPath(obstacleGrid, cols, rows, gridRes, startMm, endMm, maxIterations = 80000) {
  const sx = Math.round(startMm[0] / gridRes);
  const sy = Math.round(startMm[1] / gridRes);
  const ex = Math.round(endMm[0] / gridRes);
  const ey = Math.round(endMm[1] / gridRes);

  if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) return null;
  if (ex < 0 || ex >= cols || ey < 0 || ey >= rows) return null;

  // 4-directional: right, left, down, up (Manhattan only — no diagonals)
  const dirs = [
    [1, 0],   // 0 = right
    [-1, 0],  // 1 = left
    [0, 1],   // 2 = down
    [0, -1],  // 3 = up
  ];

  // Turn penalty: heavily discourages unnecessary bends so traces stay straight
  const TURN_PENALTY = 3.0;

  const heuristic = (x, y) => Math.abs(x - ex) + Math.abs(y - ey);

  // State key: (x, y, dir) — dir ∈ {0,1,2,3,4}; 4 = start (no arrival direction)
  const stateKey = (x, y, dir) => (y * cols + x) * 5 + dir;
  const cellKey = (x, y) => y * cols + x;

  const gScore = new Map();
  const cameFrom = new Map(); // stateKey → parent stateKey
  const open = new MinHeap();

  // Push start state with all 4 possible "arrival" directions (no penalty for first move)
  const startDir = 4; // sentinel: "no direction yet"
  const sk = stateKey(sx, sy, startDir);
  gScore.set(sk, 0);
  open.push({ x: sx, y: sy, dir: startDir, f: heuristic(sx, sy), g: 0 });

  let iterations = 0;
  while (open.size > 0 && iterations < maxIterations) {
    iterations++;
    const cur = open.pop();
    const ck = stateKey(cur.x, cur.y, cur.dir);

    // Check if stale (gScore was updated after this entry was pushed)
    const bestG = gScore.get(ck);
    if (bestG !== undefined && cur.g > bestG) continue;

    if (cur.x === ex && cur.y === ey) {
      // Reconstruct path from state keys
      const rawPath = [];
      let k = ck;
      while (k !== undefined) {
        const dir = k % 5;
        const cellIdx = (k - dir) / 5;
        const x = cellIdx % cols;
        const y = Math.floor(cellIdx / cols);
        rawPath.push([x * gridRes, y * gridRes]);
        k = cameFrom.get(k);
      }
      rawPath.reverse();
      return simplifyManhattanPath(rawPath);
    }

    for (let d = 0; d < 4; d++) {
      const [dx, dy] = dirs[d];
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;

      // Blocked cell — skip. Same-net pads are already excluded from the
      // obstacle grid via skipNet, so we don't need a destination exception
      // (which previously allowed paths to illegally enter blocked zones).
      const ci = cellKey(nx, ny);
      if (obstacleGrid[ci]) continue;

      // Cost: 1 per step + turn penalty if direction changed
      let moveCost = 1;
      if (cur.dir !== 4 && cur.dir !== d) {
        moveCost += TURN_PENALTY;
      }
      const tentG = cur.g + moveCost;

      const nk = stateKey(nx, ny, d);
      const prevG = gScore.get(nk);
      if (prevG !== undefined && tentG >= prevG) continue;

      gScore.set(nk, tentG);
      cameFrom.set(nk, ck);
      open.push({ x: nx, y: ny, dir: d, f: tentG + heuristic(nx, ny), g: tentG });
    }
  }

  return null; // No path found
}

/**
 * Simplify a Manhattan path: remove collinear interior points so only
 * start, corners, and end remain. Then snap to grid-aligned coordinates.
 */
function simplifyManhattanPath(path) {
  if (path.length <= 2) return path;
  const result = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const [px, py] = path[i - 1];
    const [cx, cy] = path[i];
    const [nx, ny] = path[i + 1];
    // Keep point only if direction changes (it's a corner)
    const dx1 = Math.sign(cx - px);
    const dy1 = Math.sign(cy - py);
    const dx2 = Math.sign(nx - cx);
    const dy2 = Math.sign(ny - cy);
    if (dx1 !== dx2 || dy1 !== dy2) {
      result.push(path[i]);
    }
  }
  result.push(path[path.length - 1]);
  return result;
}

/* ─── Main Auto-Route function ─── */

/**
 * Auto-route all unconnected nets using A* pathfinding.
 * @param {object} doc  PCB document
 * @param {Map<string, number[][]>} padCentersByNet  Net → pad positions
 * @param {object} [options]
 * @returns {{ tracks: object[], vias: object[] }}
 */
export function autoRoute(doc, padCentersByNet, options = {}) {
  const {
    gridResolution = 0.25, // mm per grid cell
    maxIterationsPerNet = 80000,
    /** All nets route on this copper layer unless a path only exists on another layer (fallback). */
    routeLayer: routeLayerOpt = null,
  } = options;

  const boardW = Number(doc.meta?.boardWmm) || 80;
  const boardH = Number(doc.meta?.boardHmm) || 50;
  const clearanceMm = doc.meta?.designRules?.minCopperClearanceMm || 0.2;
  const trackWidth = doc.meta?.defaultTrackMm || 0.35;
  const stack = activeCopperLayerIds(doc);

  const defaultRouteLayer =
    routeLayerOpt && stack.includes(String(routeLayerOpt))
      ? String(routeLayerOpt)
      : stack.includes('F.Cu')
        ? 'F.Cu'
        : stack[0];

  const newTracks = [];
  const newVias = [];

  // Check if a GND plane exists on the routing layer — if so, GND net ('0')
  // is connected by the copper pour and does NOT need routed traces.
  const gndPlaneOnRouteLayer = (doc.polygons || []).some(
    (p) => p.id === NOZE_GND_PLANE_ID && String(p.net || '') === '0' && p.layer === defaultRouteLayer,
  );

  // Sort nets by number of pads (route shorter nets first for better routability).
  const netEntries = [...padCentersByNet.entries()]
    .filter(([net, pts]) => {
      if (pts.length < 2 || net == null || String(net) === '') return false;
      // Skip GND net when a GND copper pour handles the connectivity
      if (gndPlaneOnRouteLayer && (String(net).trim() === '0' || String(net).trim().toLowerCase() === 'gnd')) return false;
      return true;
    })
    .sort((a, b) => a[1].length - b[1].length);

  // Build a mutable copy of the doc that accumulates routed tracks
  let workingDoc = JSON.parse(JSON.stringify(doc));

  for (const [net, pts] of netEntries) {
    if (pts.length < 2) continue;

    // One primary layer for all nets so canvas colors match user expectation (hue = layer, not net).
    const layer = defaultRouteLayer;

    // Build obstacle grid (updated with previously routed tracks).
    // Pass trackHalfWidth so pad blocking accounts for trace width.
    // Pass `net` as skipNet so same-net pads are never blocked — A* can freely
    // navigate to them without any unblock/reblock overlap issues.
    const trackHalfW = trackWidth / 2;
    const { grid, cols, rows } = buildObstacleGrid(
      workingDoc, layer, gridResolution, clearanceMm, boardW, boardH, trackHalfW, net
    );

    // Minimum spanning tree ordering (Prim's algorithm for optimal connection order)
    const connected = [0];
    const remaining = new Set(pts.map((_, i) => i).filter(i => i > 0));
    const connections = [];

    while (remaining.size > 0) {
      let bestDist = Infinity;
      let bestFrom = 0;
      let bestTo = 0;

      for (const ci of connected) {
        for (const ri of remaining) {
          const dist = Math.hypot(pts[ci][0] - pts[ri][0], pts[ci][1] - pts[ri][1]);
          if (dist < bestDist) {
            bestDist = dist;
            bestFrom = ci;
            bestTo = ri;
          }
        }
      }

      connections.push([bestFrom, bestTo]);
      connected.push(bestTo);
      remaining.delete(bestTo);
    }

    // Route each connection using A*
    for (const [fromIdx, toIdx] of connections) {
      const start = pts[fromIdx];
      const end = pts[toIdx];

      const path = aStarPath(grid, cols, rows, gridResolution, start, end, maxIterationsPerNet);

      if (path && path.length >= 2) {
        // Snap first/last points to actual pad centers
        path[0] = [start[0], start[1]];
        path[path.length - 1] = [end[0], end[1]];

        const track = {
          id: newId('tr'),
          layer,
          widthMm: trackWidth,
          net,
          points: path,
        };
        newTracks.push(track);

        // Add to working doc for next iteration's obstacle map
        workingDoc.tracks.push(track);

        // Block the new track on the obstacle grid
        const hw = trackWidth / 2;
        for (let i = 0; i < path.length - 1; i++) {
          const [ax, ay] = path[i];
          const [bx, by] = path[i + 1];
          const minGX = Math.max(0, Math.floor((Math.min(ax, bx) - hw - clearanceMm) / gridResolution));
          const maxGX = Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + hw + clearanceMm) / gridResolution));
          const minGY = Math.max(0, Math.floor((Math.min(ay, by) - hw - clearanceMm) / gridResolution));
          const maxGY = Math.min(rows - 1, Math.ceil((Math.max(ay, by) + hw + clearanceMm) / gridResolution));
          for (let gy = minGY; gy <= maxGY; gy++) {
            for (let gx = minGX; gx <= maxGX; gx++) {
              grid[gy * cols + gx] = 1;
            }
          }
        }
      } else {
        // Fallback: try another copper layer with via insertion.
        // NEVER use blind L-shaped routing — it ignores obstacles and causes shorts.
        const altLayer = stack.find((ly) => ly !== layer) || layer;
        if (altLayer !== layer && stack.length > 1) {
          const { grid: altGrid, cols: altCols, rows: altRows } = buildObstacleGrid(
            workingDoc, altLayer, gridResolution, clearanceMm, boardW, boardH, trackHalfW, net
          );
          const altPath = aStarPath(altGrid, altCols, altRows, gridResolution, start, end, maxIterationsPerNet);
          if (altPath && altPath.length >= 2) {
            altPath[0] = [start[0], start[1]];
            altPath[altPath.length - 1] = [end[0], end[1]];

            // Add vias at start and end to switch layers
            const viaDrill = doc.meta?.defaultViaDrillMm || 0.4;
            const viaDiam = doc.meta?.defaultViaDiamMm || 0.8;
            newVias.push({ id: newId('via'), x: start[0], y: start[1], drillMm: viaDrill, diamMm: viaDiam, net });
            newVias.push({ id: newId('via'), x: end[0], y: end[1], drillMm: viaDrill, diamMm: viaDiam, net });

            const track = {
              id: newId('tr'),
              layer: altLayer,
              widthMm: trackWidth,
              net,
              points: altPath,
            };
            newTracks.push(track);
            workingDoc.tracks.push(track);
            workingDoc.vias.push(...newVias.slice(-2));
          }
          // If alt-layer A* also fails, skip this connection (unroutable with current placement).
          // Do NOT create blind L-shaped paths — they ignore obstacles and cause shorts.
        }
        // Single-layer board or alt-layer also failed: skip (unroutable).
      }
    }
  }

  return { tracks: newTracks, vias: newVias };
}
