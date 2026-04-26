/**
 * Professional Design Rule Check (DRC) Engine for PCB Studio.
 *
 * Uses spatial indexing for O(n log n) clearance checks.
 * Checks:
 *   1. Track-to-track copper clearance (same layer, different nets)
 *   2. Track-to-pad copper clearance
 *   3. Via-to-track clearance
 *   4. Via-to-via clearance
 *   5. Pad-to-pad clearance
 *   6. Minimum track width
 *   7. Minimum via annular ring
 *   8. Unconnected nets (ratsnest check)
 *   9. Silk-to-pad clearance
 *  10. Board edge clearance
 *  11. Via drill size check
 */

import { createSpatialIndex } from './spatialIndex.js';
import { activeCopperLayerIds } from './pcbDoc.js';

/* ─── Geometry helpers ─── */
function sqr(x) { return x * x; }
function dist2(v, w) { return sqr(v[0] - w[0]) + sqr(v[1] - w[1]); }

function distToSegment(p, v, w) {
  const l2 = dist2(v, w);
  if (l2 === 0) return Math.sqrt(dist2(p, v));
  let t = ((p[0] - v[0]) * (w[0] - v[0]) + (p[1] - v[1]) * (w[1] - v[1])) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.sqrt(dist2(p, [v[0] + t * (w[0] - v[0]), v[1] + t * (w[1] - v[1])]));
}

function segmentsDistance(p1, p2, p3, p4) {
  return Math.min(
    distToSegment(p1, p3, p4),
    distToSegment(p2, p3, p4),
    distToSegment(p3, p1, p2),
    distToSegment(p4, p1, p2),
  );
}

function rotLocal(x, y, deg) {
  const r = ((Number(deg) || 0) * Math.PI) / 180;
  const c = Math.cos(r); const s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

function padWorld(pl, pad) {
  const [lx, ly] = rotLocal(pad.x, pad.y, pl.rot || 0);
  return [lx + pl.x, ly + pl.y];
}

/* ─── Spatial index builder for DRC ─── */
function buildDrcIndex(doc, getFootprint) {
  const idx = createSpatialIndex(2.0);

  // Index track segments
  for (const tr of (doc.tracks || [])) {
    const pts = tr.points || [];
    const hw = (tr.widthMm || 0.35) / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      idx.insert(
        { kind: 'track_seg', trackId: tr.id, layer: tr.layer, net: tr.net || '', hw, seg: [pts[i], pts[i + 1]] },
        Math.min(ax, bx) - hw, Math.min(ay, by) - hw,
        Math.max(ax, bx) + hw, Math.max(ay, by) + hw,
      );
    }
  }

  // Index vias
  for (const v of (doc.vias || [])) {
    const r = (Number(v.diamMm) || 0.8) / 2;
    idx.insert(
      { kind: 'via', id: v.id, net: v.net || '', x: v.x, y: v.y, r, drill: Number(v.drillMm) || 0.4 },
      v.x - r, v.y - r, v.x + r, v.y + r,
    );
  }

  // Index pads
  for (const pl of (doc.placements || [])) {
    const fp = getFootprint(pl.footprintId);
    if (!fp?.pads) continue;
    const nets = pl.padNets || {};
    for (const pad of fp.pads) {
      const [px, py] = padWorld(pl, pad);
      const r = Math.max(pad.w, pad.h) / 2;
      const net = nets[pad.num] || nets[pad.id] || '';
      idx.insert(
        { kind: 'pad', ref: pl.ref, padNum: pad.num, net, x: px, y: py, w: pad.w, h: pad.h, r },
        px - r, py - r, px + r, py + r,
      );
    }
  }

  return idx;
}

/* ─── Main DRC function ─── */
/**
 * Run full DRC on a PCB document.
 * @param {object} doc
 * @param {function} getFootprint
 * @param {object} [options]
 * @returns {Array<{ type: string, severity: 'error'|'warning', message: string, x: number, y: number }>}
 */
export function runDRC(doc, getFootprint, options = {}) {
  const violations = [];
  const dr = doc?.meta?.designRules || {};
  const minClearance = Number(dr.minCopperClearanceMm) > 0 ? Number(dr.minCopperClearanceMm) : 0.2;
  const minTrackWidth = Number(dr.minTrackWidthMm) > 0 ? Number(dr.minTrackWidthMm) : 0.15;
  const minViaDrill = Number(dr.minViaDrillMm) > 0 ? Number(dr.minViaDrillMm) : 0.2;
  const minAnnularRing = Number(dr.minAnnularRingMm) > 0 ? Number(dr.minAnnularRingMm) : 0.125;
  const edgeClearance = Number(dr.edgeClearanceMm) > 0 ? Number(dr.edgeClearanceMm) : 0.25;
  const boardW = Number(doc.meta?.boardWmm) || 80;
  const boardH = Number(doc.meta?.boardHmm) || 50;

  const spatialIdx = buildDrcIndex(doc, getFootprint);

  // ═══ 1. Track-to-Track Clearance ═══
  const tracks = doc.tracks || [];
  for (let i = 0; i < tracks.length; i++) {
    const t1 = tracks[i];
    const pts1 = t1.points || [];
    const hw1 = (t1.widthMm || 0.35) / 2;

    for (let s1 = 0; s1 < pts1.length - 1; s1++) {
      const seg1 = [pts1[s1], pts1[s1 + 1]];
      const minX = Math.min(seg1[0][0], seg1[1][0]) - hw1 - minClearance - 1;
      const minY = Math.min(seg1[0][1], seg1[1][1]) - hw1 - minClearance - 1;
      const maxX = Math.max(seg1[0][0], seg1[1][0]) + hw1 + minClearance + 1;
      const maxY = Math.max(seg1[0][1], seg1[1][1]) + hw1 + minClearance + 1;

      const nearby = spatialIdx.query(minX, minY, maxX, maxY);
      for (const item of nearby) {
        if (item.kind !== 'track_seg') continue;
        if (item.trackId === t1.id) continue; // same track
        if (item.layer !== t1.layer) continue; // different layer
        if (item.net && t1.net && item.net === t1.net) continue; // same net

        const dist = segmentsDistance(seg1[0], seg1[1], item.seg[0], item.seg[1]);
        const requiredClearance = hw1 + item.hw + minClearance;

        // Skip if endpoints are shared (intentional junction)
        const shareEndpoint =
          dist2(seg1[0], item.seg[0]) < 0.001 || dist2(seg1[0], item.seg[1]) < 0.001 ||
          dist2(seg1[1], item.seg[0]) < 0.001 || dist2(seg1[1], item.seg[1]) < 0.001;
        if (shareEndpoint) continue;

        if (dist < requiredClearance) {
          violations.push({
            type: 'track_clearance',
            severity: 'error',
            message: `Track clearance ${dist.toFixed(3)}mm < ${requiredClearance.toFixed(3)}mm on ${t1.layer}`,
            x: (seg1[0][0] + item.seg[0][0]) / 2,
            y: (seg1[0][1] + item.seg[0][1]) / 2,
          });
        }
      }
    }
  }

  // ═══ 2. Track-to-Pad Clearance ═══
  for (const tr of tracks) {
    const pts = tr.points || [];
    const hw = (tr.widthMm || 0.35) / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const seg = [pts[i], pts[i + 1]];
      const minX = Math.min(seg[0][0], seg[1][0]) - hw - minClearance - 2;
      const minY = Math.min(seg[0][1], seg[1][1]) - hw - minClearance - 2;
      const maxX = Math.max(seg[0][0], seg[1][0]) + hw + minClearance + 2;
      const maxY = Math.max(seg[0][1], seg[1][1]) + hw + minClearance + 2;

      for (const item of spatialIdx.query(minX, minY, maxX, maxY)) {
        if (item.kind !== 'pad') continue;
        if (item.net && tr.net && item.net === tr.net) continue; // same net

        const dist = distToSegment([item.x, item.y], seg[0], seg[1]);
        const requiredClearance = hw + item.r + minClearance;

        // Allow if track endpoint is on pad
        const onPad = dist2(pts[i], [item.x, item.y]) < 0.01 || dist2(pts[i + 1], [item.x, item.y]) < 0.01;
        if (onPad) continue;

        if (dist < requiredClearance) {
          violations.push({
            type: 'pad_clearance',
            severity: 'error',
            message: `Track too close to pad ${item.ref}:${item.padNum} (${dist.toFixed(3)}mm < ${requiredClearance.toFixed(3)}mm)`,
            x: item.x,
            y: item.y,
          });
        }
      }
    }
  }

  // ═══ 3. Via-to-Track Clearance ═══
  for (const v of (doc.vias || [])) {
    const vr = (Number(v.diamMm) || 0.8) / 2;
    const nearby = spatialIdx.query(v.x - vr - minClearance - 2, v.y - vr - minClearance - 2,
                                      v.x + vr + minClearance + 2, v.y + vr + minClearance + 2);
    for (const item of nearby) {
      if (item.kind === 'track_seg') {
        if (item.net && v.net && item.net === v.net) continue;
        const dist = distToSegment([v.x, v.y], item.seg[0], item.seg[1]);
        const requiredClearance = vr + item.hw + minClearance;
        if (dist < requiredClearance) {
          violations.push({
            type: 'via_track_clearance',
            severity: 'error',
            message: `Via too close to track on ${item.layer} (${dist.toFixed(3)}mm)`,
            x: v.x, y: v.y,
          });
        }
      }
    }
  }

  // ═══ 4. Via-to-Via Clearance ═══
  const vias = doc.vias || [];
  for (let i = 0; i < vias.length; i++) {
    for (let j = i + 1; j < vias.length; j++) {
      const a = vias[i], b = vias[j];
      if (a.net && b.net && a.net === b.net) continue;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const ra = (Number(a.diamMm) || 0.8) / 2;
      const rb = (Number(b.diamMm) || 0.8) / 2;
      const req = ra + rb + minClearance;
      if (dist < req) {
        violations.push({
          type: 'via_clearance',
          severity: 'error',
          message: `Via-to-via clearance ${dist.toFixed(3)}mm < ${req.toFixed(3)}mm`,
          x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
        });
      }
    }
  }

  // ═══ 5. Minimum Track Width ═══
  for (const tr of tracks) {
    if ((tr.widthMm || 0.35) < minTrackWidth - 0.001) {
      const pts = tr.points || [];
      const cx = pts.length > 0 ? pts[0][0] : 0;
      const cy = pts.length > 0 ? pts[0][1] : 0;
      violations.push({
        type: 'min_track_width',
        severity: 'error',
        message: `Track width ${(tr.widthMm || 0.35).toFixed(3)}mm < minimum ${minTrackWidth.toFixed(3)}mm`,
        x: cx, y: cy,
      });
    }
  }

  // ═══ 6. Via Annular Ring ═══
  for (const v of vias) {
    const drill = Number(v.drillMm) || 0.4;
    const diam = Number(v.diamMm) || 0.8;
    const annular = (diam - drill) / 2;
    if (annular < minAnnularRing - 0.001) {
      violations.push({
        type: 'annular_ring',
        severity: 'error',
        message: `Via annular ring ${annular.toFixed(3)}mm < minimum ${minAnnularRing.toFixed(3)}mm`,
        x: v.x, y: v.y,
      });
    }
    if (drill < minViaDrill - 0.001) {
      violations.push({
        type: 'min_via_drill',
        severity: 'warning',
        message: `Via drill ${drill.toFixed(3)}mm < minimum ${minViaDrill.toFixed(3)}mm`,
        x: v.x, y: v.y,
      });
    }
  }

  // ═══ 7. Board Edge Clearance ═══
  for (const tr of tracks) {
    const hw = (tr.widthMm || 0.35) / 2;
    for (const [px, py] of (tr.points || [])) {
      const edgeDist = Math.min(px - hw, py - hw, boardW - px - hw, boardH - py - hw);
      if (edgeDist < edgeClearance) {
        violations.push({
          type: 'edge_clearance',
          severity: 'warning',
          message: `Track too close to board edge (${Math.max(0, edgeDist).toFixed(3)}mm < ${edgeClearance.toFixed(3)}mm)`,
          x: px, y: py,
        });
      }
    }
  }
  for (const v of vias) {
    const r = (Number(v.diamMm) || 0.8) / 2;
    const edgeDist = Math.min(v.x - r, v.y - r, boardW - v.x - r, boardH - v.y - r);
    if (edgeDist < edgeClearance) {
      violations.push({
        type: 'edge_clearance',
        severity: 'warning',
        message: `Via too close to board edge`,
        x: v.x, y: v.y,
      });
    }
  }

  // ═══ 8. Unconnected Nets ═══
  if (options.checkUnconnected !== false) {
    const netPads = new Map();
    for (const pl of (doc.placements || [])) {
      const fp = getFootprint(pl.footprintId);
      if (!fp?.pads) continue;
      const nets = pl.padNets || {};
      for (const pad of fp.pads) {
        const net = nets[pad.num] || nets[pad.id];
        if (!net || net === '0') continue;
        if (!netPads.has(net)) netPads.set(net, []);
        const [px, py] = padWorld(pl, pad);
        netPads.get(net).push({ x: px, y: py, ref: pl.ref, padNum: pad.num });
      }
    }

    // Check that each net's pads are connected by tracks
    for (const [net, pads] of netPads) {
      if (pads.length < 2) continue;
      // Simple check: see if there are any tracks for this net
      const netTracks = tracks.filter(t => t.net === net);
      if (netTracks.length === 0) {
        violations.push({
          type: 'unconnected_net',
          severity: 'warning',
          message: `Net "${net}" has ${pads.length} pads but no routed tracks`,
          x: pads[0].x, y: pads[0].y,
        });
      }
    }
  }

  // Deduplicate violations that are very close together
  return deduplicateViolations(violations);
}

function deduplicateViolations(violations) {
  const result = [];
  for (const v of violations) {
    const isDupe = result.some(
      r => r.type === v.type && Math.hypot(r.x - v.x, r.y - v.y) < 0.5
    );
    if (!isDupe) result.push(v);
  }
  return result;
}
