/**
 * Lightweight Spatial Index (grid-based) for PCB Studio.
 * Used by DRC for O(n) average-case clearance queries, and by hit testing.
 *
 * This is a simple uniform-grid spatial hash. For most PCB boards (< 10K objects),
 * this outperforms R-trees in practice due to lower constant factors.
 */

/**
 * Create a spatial index over axis-aligned bounding boxes.
 * @param {number} cellSize  Grid cell size in mm (e.g. 2.0)
 */
export function createSpatialIndex(cellSize = 2.0) {
  const cells = new Map();
  const items = [];

  function cellKey(cx, cy) { return `${cx},${cy}`; }

  function cellsForBBox(minX, minY, maxX, maxY) {
    const cx0 = Math.floor(minX / cellSize);
    const cy0 = Math.floor(minY / cellSize);
    const cx1 = Math.floor(maxX / cellSize);
    const cy1 = Math.floor(maxY / cellSize);
    const out = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        out.push(cellKey(cx, cy));
      }
    }
    return out;
  }

  return {
    /**
     * Insert an item with a bounding box.
     * @param {object} item  Arbitrary object (will be returned in queries).
     * @param {number} minX
     * @param {number} minY
     * @param {number} maxX
     * @param {number} maxY
     */
    insert(item, minX, minY, maxX, maxY) {
      const idx = items.length;
      items.push({ item, minX, minY, maxX, maxY });
      for (const key of cellsForBBox(minX, minY, maxX, maxY)) {
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(idx);
      }
    },

    /**
     * Query all items whose bounding box intersects the given rectangle.
     * @returns {object[]}  Array of item objects (no duplicates).
     */
    query(minX, minY, maxX, maxY) {
      const seen = new Set();
      const result = [];
      for (const key of cellsForBBox(minX, minY, maxX, maxY)) {
        const bucket = cells.get(key);
        if (!bucket) continue;
        for (const idx of bucket) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          const entry = items[idx];
          // AABB intersection test
          if (entry.maxX >= minX && entry.minX <= maxX &&
              entry.maxY >= minY && entry.minY <= maxY) {
            result.push(entry.item);
          }
        }
      }
      return result;
    },

    /**
     * Query items near a point (within radius).
     */
    queryPoint(px, py, radius = 0) {
      return this.query(px - radius, py - radius, px + radius, py + radius);
    },

    /** Clear the index. */
    clear() {
      cells.clear();
      items.length = 0;
    },

    /** Number of items in the index. */
    get size() { return items.length; },
  };
}

/**
 * Build a spatial index from a PCB document (tracks, vias, pads).
 * Each item is tagged with { kind, id, layer, ... } for DRC and hit testing.
 */
export function buildPcbSpatialIndex(doc, getFootprint) {
  const idx = createSpatialIndex(2.0);

  // Index tracks (each segment as separate entry)
  for (const tr of (doc.tracks || [])) {
    const pts = tr.points || [];
    const hw = (tr.widthMm || 0.35) / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      idx.insert(
        { kind: 'track_seg', trackId: tr.id, layer: tr.layer, net: tr.net, segIdx: i, track: tr, hw },
        Math.min(ax, bx) - hw, Math.min(ay, by) - hw,
        Math.max(ax, bx) + hw, Math.max(ay, by) + hw,
      );
    }
  }

  // Index vias
  for (const v of (doc.vias || [])) {
    const r = (Number(v.diamMm) || 0.8) / 2;
    idx.insert(
      { kind: 'via', id: v.id, net: v.net, via: v },
      v.x - r, v.y - r, v.x + r, v.y + r,
    );
  }

  // Index pads
  for (const pl of (doc.placements || [])) {
    const fp = getFootprint(pl.footprintId);
    if (!fp?.pads) continue;
    for (const pad of fp.pads) {
      const rot = (Number(pl.rot) || 0) * Math.PI / 180;
      const cx = pl.x + pad.x * Math.cos(rot) - pad.y * Math.sin(rot);
      const cy = pl.y + pad.x * Math.sin(rot) + pad.y * Math.cos(rot);
      const r = Math.max(pad.w, pad.h) / 2;
      idx.insert(
        { kind: 'pad', placementId: pl.id, padId: pad.id, padNum: pad.num, ref: pl.ref, cx, cy, pad, placement: pl },
        cx - r, cy - r, cx + r, cy + r,
      );
    }
  }

  // Index polygons
  for (const poly of (doc.polygons || [])) {
    const pts = poly.points || [];
    if (pts.length < 3) continue;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    idx.insert(
      { kind: 'polygon', id: poly.id, layer: poly.layer, net: poly.net, polygon: poly },
      minX, minY, maxX, maxY,
    );
  }

  return idx;
}
