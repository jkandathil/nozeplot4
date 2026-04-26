/**
 * Ratsnest (air-wires) between pad islands on the same net, hidden when copper connects them.
 */

function rotLocal(x, y, deg) {
  const r = ((Number(deg) || 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

function padWorld(pl, pad) {
  const [lx, ly] = rotLocal(pad.x, pad.y, pl.rot || 0);
  return [lx + pl.x, ly + pl.y];
}

function pointToSegmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

function minDistPointToPolyline(px, py, pts) {
  const p = [px, py];
  if (!pts || pts.length < 2) return Infinity;
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    d = Math.min(d, pointToSegmentDistance(p, pts[i], pts[i + 1]));
  }
  return d;
}

function trackEndpointsTouch(ptsA, ptsB, eps) {
  if (!ptsA?.length || !ptsB?.length) return false;
  const endsA = [ptsA[0], ptsA[ptsA.length - 1]];
  const endsB = [ptsB[0], ptsB[ptsB.length - 1]];
  for (const a of endsA) {
    for (const b of endsB) {
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps) return true;
    }
  }
  return false;
}

function trackTouchesPoint(pts, x, y, eps) {
  if (!pts?.length) return false;
  const ends = [pts[0], pts[pts.length - 1]];
  for (const e of ends) {
    if (Math.hypot(e[0] - x, e[1] - y) <= eps) return true;
  }
  return false;
}

function padTouchesTrack(px, py, track, padSlopMm) {
  const hw = (Number(track.widthMm) || 0.35) / 2;
  const tol = hw + padSlopMm;
  return minDistPointToPolyline(px, py, track.points || []) <= tol;
}

/**
 * @param {object} doc
 * @param {(id: string) => object|undefined} getFootprint
 * @returns {Map<string, number[][]>} net → hub pad positions [x,y] per **unconnected** island (star draw)
 */
export function buildRatsnestHubsByNet(doc, getFootprint) {
  const map = new Map();
  const padSlopMm = 0.48;
  const endpointEpsMm = 0.42;
  const viaSlopMm = 0.55;

  /** @type {Map<string, { x: number, y: number }[]>} */
  const padsByNet = new Map();
  for (const pl of doc.placements || []) {
    const fp = getFootprint(pl.footprintId);
    if (!fp) continue;
    const nets = pl.padNets || {};
    for (const pad of fp.pads || []) {
      const net = nets[pad.num] || nets[pad.id];
      if (!net || net === '0') continue;
      const [x, y] = padWorld(pl, pad);
      const key = String(net);
      if (!padsByNet.has(key)) padsByNet.set(key, []);
      padsByNet.get(key).push({ x, y });
    }
  }

  for (const [net, pads] of padsByNet) {
    if (pads.length < 2) continue;

    const tracksOnNet = (doc.tracks || []).filter((t) => t && String(t.net || '') === net);
    const viasOnNet = (doc.vias || []).filter((v) => v && String(v.net || '') === net);

    const n = pads.length;
    const adj = new Map();
    const addEdge = (a, b) => {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a).add(b);
      adj.get(b).add(a);
    };

    for (let i = 0; i < n; i++) {
      const pi = `p${i}`;
      const { x, y } = pads[i];
      for (const tr of tracksOnNet) {
        if (!tr.id || !padTouchesTrack(x, y, tr, padSlopMm)) continue;
        addEdge(pi, `t${tr.id}`);
      }
      for (const v of viasOnNet) {
        const vr = (Number(v.diamMm) || 0.8) / 2 + 0.18;
        if (Math.hypot(x - v.x, y - v.y) <= vr + viaSlopMm) addEdge(pi, `via${v.id}`);
      }
    }

    for (let a = 0; a < tracksOnNet.length; a++) {
      const ta = tracksOnNet[a];
      const ptsA = ta.points || [];
      for (let b = a + 1; b < tracksOnNet.length; b++) {
        const tb = tracksOnNet[b];
        if (trackEndpointsTouch(ptsA, tb.points || [], endpointEpsMm)) {
          addEdge(`t${ta.id}`, `t${tb.id}`);
        }
      }
    }

    for (const v of viasOnNet) {
      const vnode = `via${v.id}`;
      for (const tr of tracksOnNet) {
        if (trackTouchesPoint(tr.points || [], v.x, v.y, viaSlopMm)) addEdge(`t${tr.id}`, vnode);
      }
    }

    const padSeen = new Set();
    const components = [];

    const bfsPads = (startIdx) => {
      const comp = [];
      const q = [`p${startIdx}`];
      const seen = new Set();
      while (q.length) {
        const u = q.pop();
        if (seen.has(u)) continue;
        seen.add(u);
        for (const v of adj.get(u) || []) {
          if (!seen.has(v)) q.push(v);
        }
        if (u.startsWith('p')) {
          const idx = Number(u.slice(1));
          if (Number.isFinite(idx) && idx >= 0 && idx < n) {
            comp.push(idx);
            padSeen.add(idx);
          }
        }
      }
      return comp;
    };

    for (let i = 0; i < n; i++) {
      if (padSeen.has(i)) continue;
      const comp = bfsPads(i);
      if (comp.length) components.push(comp);
    }

    if (components.length <= 1) continue;

    const hubs = components.map((comp) => {
      const k = comp[0];
      return [pads[k].x, pads[k].y];
    });
    map.set(net, hubs);
  }

  return map;
}
