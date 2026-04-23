/**
 * Geometry helpers for Flow Lab.
 *
 * Entities are plain JS objects — see the shape documented on
 * `createPolylineEntity`. All coordinates are in MILLIMETRES internally;
 * the UI can display them in mm or µm via the `units.js` helpers.
 *
 * Rendering is done in SVG on the main thread; the solver works on a
 * rasterised mask (see `rasterizeDomain`).
 */

let _id = 0;
function nextId() {
    _id++;
    return `e_${Date.now().toString(36)}_${_id}`;
}

/**
 * A closed polyline fluid region. `points` is an array of {x,y} in mm.
 * `edgeBC[i]` is the boundary condition for the edge from points[i]
 * to points[i+1] (wrapping). Default: every edge is a no-slip wall.
 *
 * Shape: `{ id, type:'region', points, edgeBC: { [i]: { type, ...params } } }`
 */
export function createPolylineEntity(points, { closed = true } = {}) {
    // For closed polylines every edge (including the wrap) needs a BC slot.
    // For OPEN polylines (Line tool construction geometry) we only have
    // n-1 edges, and no edge wraps back to the start.
    const edgeBC = {};
    const nEdges = closed ? points.length : Math.max(0, points.length - 1);
    for (let i = 0; i < nEdges; i++) edgeBC[i] = { type: 'wall' };
    return {
        id: nextId(),
        type: 'region',
        closed,
        points: points.map((p) => ({ x: p.x, y: p.y })),
        edgeBC,
    };
}

/**
 * Remove vertex at index `idx` from an entity. edgeBC is re-indexed so
 * downstream code (rasterizer, BC picker) stays in sync.
 *
 * Returns a new entity, or `null` if the removal would leave fewer than
 * 2 vertices (which is degenerate — caller should delete the whole
 * entity instead).
 */
/** Remove a single edge (segment) from an entity, preserving both
 *  endpoints. This is the "break the line here" operation:
 *    · Closed polygon → opens at that edge, producing a single open
 *      polyline that starts at vertex (edgeIdx + 1) and wraps around
 *      to vertex edgeIdx (no vertices are lost, the ring is broken).
 *    · Open polyline → splits at that edge, producing up to two open
 *      polylines (the "left" piece pts[0..edgeIdx], and the "right"
 *      piece pts[edgeIdx+1..end]). Either side that collapses to a
 *      single vertex is dropped.
 *  edgeBCs are re-indexed so surviving edges keep their BC types.
 *  The right-hand piece of an open-polyline split gets a fresh id so
 *  React's list-reconciliation treats it as a new entity.
 *
 *  Returns an array of entities (0, 1, or 2) to replace the original.
 *  Callers substitute the original via `splice(idx, 1, ...result)`. */
export function removeEdgeAt(entity, edgeIdx, { idFactory } = {}) {
    if (!entity || !entity.points || entity.points.length < 2) return [];
    const pts = entity.points;
    const n = pts.length;
    const oldEdgeBC = entity.edgeBC || {};
    const nextId = idFactory || (() => `${entity.id}_b${Math.floor(Math.random() * 1e6).toString(36)}`);

    if (entity.closed !== false) {
        // Closed polygon. Edge edgeIdx connects vertex edgeIdx → edgeIdx+1 (mod n).
        // Breaking it yields an open polyline that walks the other way around:
        //   [v_{i+1}, v_{i+2}, …, v_{i-1}, v_i]   (n vertices, n-1 edges)
        if (edgeIdx < 0 || edgeIdx >= n) return [entity];
        if (n < 3) return []; // degenerate — just remove
        const newPts = [];
        for (let k = 0; k < n; k++) {
            newPts.push(pts[(edgeIdx + 1 + k) % n]);
        }
        const newEdgeBC = {};
        for (let k = 0; k < n - 1; k++) {
            const oldI = (edgeIdx + 1 + k) % n;
            newEdgeBC[k] = oldEdgeBC[oldI] || { type: 'wall' };
        }
        return [{ ...entity, closed: false, points: newPts, edgeBC: newEdgeBC }];
    }

    // Open polyline. Removing edge edgeIdx splits it between pts[edgeIdx]
    // and pts[edgeIdx+1]. Either side with < 2 vertices is dropped.
    if (edgeIdx < 0 || edgeIdx >= n - 1) return [entity];
    const out = [];
    const leftPts = pts.slice(0, edgeIdx + 1);
    const rightPts = pts.slice(edgeIdx + 1);
    if (leftPts.length >= 2) {
        const leftBC = {};
        for (let k = 0; k < edgeIdx; k++) leftBC[k] = oldEdgeBC[k] || { type: 'wall' };
        out.push({ ...entity, points: leftPts, edgeBC: leftBC });
    }
    if (rightPts.length >= 2) {
        const rightBC = {};
        for (let k = 0; k < rightPts.length - 1; k++) {
            rightBC[k] = oldEdgeBC[edgeIdx + 1 + k] || { type: 'wall' };
        }
        out.push({ ...entity, id: nextId(), points: rightPts, edgeBC: rightBC });
    }
    return out;
}

export function removeVertexAt(entity, idx) {
    const pts = entity.points.slice();
    if (idx < 0 || idx >= pts.length) return entity;
    if (pts.length <= 2) return null; // can't shrink a line to nothing
    pts.splice(idx, 1);

    // edgeBC re-index:
    //   - For a CLOSED polygon, vertex i sits between edge (i-1) and edge i.
    //     Removing vertex i merges those two edges into the (new) edge at
    //     position i-1. We keep the BC of edge (i-1) and drop edge i.
    //   - For OPEN polylines removing the last vertex also removes the last
    //     edge; removing an interior vertex removes edge at index i (the
    //     outgoing one) and keeps the incoming edge.
    const oldEdgeBC = entity.edgeBC || {};
    const newEdgeBC = {};
    const oldN = entity.points.length;
    const nEdgesNew = entity.closed ? pts.length : pts.length - 1;

    if (entity.closed) {
        // Old edges are indexed 0..oldN-1. After removing vertex idx, the
        // new edges are old edges minus edge idx (its two endpoints collapsed).
        for (let newI = 0; newI < nEdgesNew; newI++) {
            // Map new-edge index back to which old edge it came from.
            //   new edges 0..idx-1     ← old edges 0..idx-1
            //   new edge  idx-1 (just above) already covers the incoming edge
            //   new edges idx..end     ← old edges idx+1..oldN-1
            const oldI = newI < idx ? newI : newI + 1;
            newEdgeBC[newI] = oldEdgeBC[oldI] || { type: 'wall' };
        }
    } else {
        // Open polyline: remove one edge.
        // If idx==0, the first edge (0) is gone → shift down.
        // If idx==last, the last edge (idx-1) is gone → keep 0..idx-2.
        // Interior idx: edges 0..idx-1 shift, edge idx removed, edges idx+1.. shift down.
        for (let newI = 0; newI < nEdgesNew; newI++) {
            let oldI;
            if (idx === 0) oldI = newI + 1;              // drop edge 0
            else if (idx === oldN - 1) oldI = newI;      // drop last edge
            else oldI = newI < idx ? newI : newI + 1;    // drop edge at idx
            newEdgeBC[newI] = oldEdgeBC[oldI] || { type: 'wall' };
        }
    }

    return { ...entity, points: pts, edgeBC: newEdgeBC };
}

/**
 * Replace the sharp corner at `vertexIdx` of a CLOSED polygon with a
 * circular-arc fillet of radius `r_mm`, approximated by `segments` line
 * segments. Returns a new entity with edgeBC re-indexed.
 *
 * Geometry:
 *   A = pts[idx-1], V = pts[idx], B = pts[idx+1].
 *   Interior angle at V is θ (computed from the unit vectors VA and VB).
 *   The fillet tangent-offset along each edge is  d = r / tan(θ/2).
 *   Tangent points:  A' = V + d·(unit VA),  B' = V + d·(unit VB).
 *   Arc centre C is on the angle bisector from V at distance r/sin(θ/2),
 *   positioned INSIDE the polygon (so the arc cuts the corner off).
 *
 * Returns null if:
 *   • the entity is open
 *   • the polygon has fewer than 4 vertices (nothing to fillet)
 *   • the computed tangent-offset d is longer than either adjacent edge
 *     (radius too large for this corner)
 *   • the corner is almost straight (θ close to π) or almost spiked
 *     (θ close to 0) — fillet would be degenerate
 *
 * BC handling:
 *   • Both transition edges (A→A' and B'→B) inherit the BC of the two
 *     original edges they replace (A→V and V→B respectively).
 *   • Arc interior edges default to 'wall' — the usual case, since
 *     filleted corners almost always sit between two no-slip walls.
 */
export function filletVertex(entity, vertexIdx, r_mm, segments = 16) {
    if (!entity || entity.closed === false) return null;
    const pts = entity.points;
    const n = pts.length;
    if (n < 4) return null;
    if (!(r_mm > 0) || !Number.isFinite(r_mm)) return null;
    const segs = Math.max(4, Math.min(96, Math.round(segments)));

    const idx = ((vertexIdx % n) + n) % n;
    const V = pts[idx];
    const A = pts[(idx - 1 + n) % n];
    const B = pts[(idx + 1) % n];

    const vaX = A.x - V.x, vaY = A.y - V.y;
    const vbX = B.x - V.x, vbY = B.y - V.y;
    const lenVA = Math.hypot(vaX, vaY);
    const lenVB = Math.hypot(vbX, vbY);
    if (lenVA < 1e-9 || lenVB < 1e-9) return null;
    const uaX = vaX / lenVA, uaY = vaY / lenVA;
    const ubX = vbX / lenVB, ubY = vbY / lenVB;

    const cosT = Math.max(-1, Math.min(1, uaX * ubX + uaY * ubY));
    const theta = Math.acos(cosT);
    // Reject nearly-straight / nearly-spike corners.
    if (theta < 0.02 || Math.PI - theta < 0.02) return null;

    const halfT = theta / 2;
    const d = r_mm / Math.tan(halfT);
    // 95% safety margin so we don't eat the whole neighbour edge.
    if (d > 0.95 * lenVA || d > 0.95 * lenVB) return null;

    const Ap = { x: V.x + d * uaX, y: V.y + d * uaY };
    const Bp = { x: V.x + d * ubX, y: V.y + d * ubY };

    // Arc centre on the angle bisector (pointing AWAY from V into the
    // polygon interior — the average of ua and ub does exactly that
    // because both point from V outward along the two edges).
    const bx = uaX + ubX, by = uaY + ubY;
    const bLen = Math.hypot(bx, by);
    if (bLen < 1e-9) return null;
    const dist = r_mm / Math.sin(halfT);
    const Cx = V.x + dist * (bx / bLen);
    const Cy = V.y + dist * (by / bLen);

    // Start / end angles on the fillet circle (centred at C).
    const a1 = Math.atan2(Ap.y - Cy, Ap.x - Cx);
    const a2 = Math.atan2(Bp.y - Cy, Bp.x - Cx);
    // Pick the short arc — its signed sweep is always in [-π, π].
    let sweep = a2 - a1;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;

    const arcPts = [];
    for (let k = 0; k <= segs; k++) {
        const a = a1 + sweep * (k / segs);
        arcPts.push({ x: Cx + r_mm * Math.cos(a), y: Cy + r_mm * Math.sin(a) });
    }
    // Replace exact endpoints so floating-point drift can't bruise the
    // transition edges (caller used `d` to compute them, we keep those).
    arcPts[0] = Ap;
    arcPts[arcPts.length - 1] = Bp;

    const newPts = [
        ...pts.slice(0, idx),
        ...arcPts,
        ...pts.slice(idx + 1),
    ];
    const newN = newPts.length;
    const P = arcPts.length; // = segs + 1

    /* ── Re-key edge BCs ──────────────────────────────────────────
       Mapping from OLD edges → NEW edge indices:
         • old edge  e<idx-1                 →  new edge e                (unchanged)
         • old edge  (idx-1+n)%n  "A→V"      →  new edge (idx-1+newN)%newN (A→A')
         • arc internal edges                →  new edges idx..idx+P-2    (defaults to wall)
         • old edge  idx          "V→B"      →  new edge idx+P-1          (B'→B)
         • old edge  e>idx                   →  new edge e+(P-1)          (shifted)
    */
    const oldEdgeBC = entity.edgeBC || {};
    const newEdgeBC = {};
    for (let i = 0; i < P - 1; i++) {
        newEdgeBC[idx + i] = { type: 'wall' };
    }
    const prevOldEdge = (idx - 1 + n) % n;
    const newPrevEdgeIdx = (idx - 1 + newN) % newN;
    newEdgeBC[newPrevEdgeIdx] = { ...(oldEdgeBC[prevOldEdge] || { type: 'wall' }) };
    newEdgeBC[idx + P - 1] = { ...(oldEdgeBC[idx] || { type: 'wall' }) };
    for (let e = 0; e < n; e++) {
        if (e === prevOldEdge || e === idx) continue;
        let newI;
        if (e < idx - 1) newI = e;
        else if (e > idx) newI = e + (P - 1);
        else continue;
        // Don't overwrite the transition edges we already set.
        if (newEdgeBC[newI]) continue;
        newEdgeBC[newI] = { ...(oldEdgeBC[e] || { type: 'wall' }) };
    }

    return { ...entity, points: newPts, edgeBC: newEdgeBC };
}

/** Close an open polyline into a polygon (used by Line tool when the
    user clicks near the first vertex). */
export function closeOpenPolyline(entity) {
    if (!entity || entity.closed) return entity;
    const pts = entity.points;
    if (pts.length < 3) return entity;
    // The wrap edge (last → first) needs a default BC slot.
    const edgeBC = { ...(entity.edgeBC || {}) };
    edgeBC[pts.length - 1] = edgeBC[pts.length - 1] || { type: 'wall' };
    return { ...entity, closed: true, edgeBC };
}

export function createRectEntity(x0, y0, x1, y1) {
    const xmin = Math.min(x0, x1);
    const xmax = Math.max(x0, x1);
    const ymin = Math.min(y0, y1);
    const ymax = Math.max(y0, y1);
    return createPolylineEntity([
        { x: xmin, y: ymin },
        { x: xmax, y: ymin },
        { x: xmax, y: ymax },
        { x: xmin, y: ymax },
    ]);
}

export function createCircleEntity(cx, cy, r, segments = 48) {
    const pts = [];
    for (let i = 0; i < segments; i++) {
        const a = (i / segments) * 2 * Math.PI;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return createPolylineEntity(pts);
}

/**
 * Axis-aligned ellipse defined by its bounding box corners. Produces a
 * closed polyline; `segments` controls smoothness.
 */
export function createEllipseEntity(x0, y0, x1, y1, segments = 64) {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = Math.abs(x1 - x0) / 2;
    const ry = Math.abs(y1 - y0) / 2;
    if (rx < 1e-9 || ry < 1e-9) return null;
    const pts = [];
    for (let i = 0; i < segments; i++) {
        const a = (i / segments) * 2 * Math.PI;
        pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
    }
    return createPolylineEntity(pts);
}

/**
 * Sample a circular arc passing through 3 points (p0 → p1 → p2).
 * Returns `points`, `closed: false` — caller decides whether to wrap
 * it into a createPolylineEntity. If the 3 points are collinear or
 * coincident the function falls back to a straight polyline.
 *
 * The arc is drawn in the direction p0 → p1 → p2 (i.e. the middle
 * point is honoured as a "through" point, picking the correct sweep).
 */
export function sampleArc3Point(p0, p1, p2, maxSegments = 64) {
    const ax = p1.x - p0.x, ay = p1.y - p0.y;
    const bx = p2.x - p1.x, by = p2.y - p1.y;
    const cross = ax * by - ay * bx;
    if (!Number.isFinite(cross) || Math.abs(cross) < 1e-9) {
        // Collinear / degenerate — return a straight polyline.
        return [
            { x: p0.x, y: p0.y },
            { x: p1.x, y: p1.y },
            { x: p2.x, y: p2.y },
        ];
    }
    // Circumcircle centre via perpendicular bisector intersection.
    const m1x = (p0.x + p1.x) / 2, m1y = (p0.y + p1.y) / 2;
    const m2x = (p1.x + p2.x) / 2, m2y = (p1.y + p2.y) / 2;
    // Perpendicular to (ax,ay) is (-ay, ax); same for (bx,by).
    const d = ax * by - ay * bx;
    const t = ((m2x - m1x) * by - (m2y - m1y) * bx) / d;
    const cx = m1x + t * (-ay);
    const cy = m1y + t * ax;
    const r = Math.hypot(p0.x - cx, p0.y - cy);
    const a0 = Math.atan2(p0.y - cy, p0.x - cx);
    const a1 = Math.atan2(p1.y - cy, p1.x - cx);
    const a2 = Math.atan2(p2.y - cy, p2.x - cx);
    // Choose sweep direction (CCW or CW) so that a1 lies between a0 and a2.
    const wrapCCW = (a) => {
        let v = a - a0; while (v < 0) v += 2 * Math.PI; while (v >= 2 * Math.PI) v -= 2 * Math.PI;
        return v;
    };
    const t1 = wrapCCW(a1);
    const tEnd = wrapCCW(a2);
    const goCCW = t1 <= tEnd;
    const sweep = goCCW ? tEnd : (2 * Math.PI - tEnd);
    const n = Math.max(8, Math.min(maxSegments, Math.ceil(maxSegments * sweep / (2 * Math.PI))));
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const u = i / n;
        const a = a0 + (goCCW ? 1 : -1) * sweep * u;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
}

/** Point-in-polygon (ray cast). `pts` is a closed polygon (last → first wraps). */
export function pointInPolygon(pts, x, y) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, yi = pts[i].y;
        const xj = pts[j].x, yj = pts[j].y;
        const intersect = (yi > y) !== (yj > y)
            && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-18) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

/** Shortest distance from point (px,py) to line segment (a,b). */
export function distToSegment(px, py, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = px - a.x, wy = py - a.y;
    const c1 = vx * wx + vy * wy;
    if (c1 <= 0) return Math.hypot(px - a.x, py - a.y);
    const c2 = vx * vx + vy * vy;
    if (c2 <= c1) return Math.hypot(px - b.x, py - b.y);
    const t = c1 / c2;
    return Math.hypot(px - (a.x + t * vx), py - (a.y + t * vy));
}

/** Bounding box of a list of polyline entities. Returns null if none have points. */
export function entitiesBBox(entities) {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    let found = false;
    for (const e of entities) {
        for (const p of e.points) {
            if (p.x < xmin) xmin = p.x;
            if (p.y < ymin) ymin = p.y;
            if (p.x > xmax) xmax = p.x;
            if (p.y > ymax) ymax = p.y;
            found = true;
        }
    }
    return found ? { xmin, ymin, xmax, ymax } : null;
}

/**
 * Rasterize a single fluid domain (one closed polyline entity) onto a
 * square-cell grid. The caller supplies a target longest-axis resolution
 * `nxTarget`; the shorter axis is derived from the domain's aspect ratio
 * so that **dx = dy** — a hard requirement for the D2Q9 lattice.
 *
 * Returns:
 *   { mask: Uint8Array,   // 0=fluid, 1=wall, 2=inlet, 3=outlet
 *     nx, ny,
 *     dx, dy,             // mm per cell (equal by construction)
 *     dxPhys_m,           // physical cell size in metres
 *     bbox: {xmin,...} }
 *
 * Strategy:
 *   1. Take the domain bbox, add a small halo of wall cells around it so
 *      the solver always has a wall outside the fluid (prevents run-off).
 *   2. Pick nx / ny so the larger axis matches `nxTarget` and cells are
 *      square; then for each cell centre, test whether it falls inside
 *      the polygon. Inside → FLUID; outside → WALL.
 *   3. For each cell adjacent to a wall, find the nearest polygon edge;
 *      if that edge has an inlet/outlet BC, upgrade the fluid cell to
 *      INLET or OUTLET. (2-cell band gives a smoother Zou-He inlet.)
 */
export function rasterizeDomain(entity, nxTarget, { obstacles = [] } = {}) {
    if (!entity || entity.closed === false) return null;
    const pts = entity.points;
    if (pts.length < 3) return null;

    /* Normalise obstacle polygons into a uniform shape the inner loop
     *  can test cheaply. Each entry carries its own bbox so we can skip
     *  whole cell ranges when an obstacle is far from a given row. */
    const obstacleRings = (Array.isArray(obstacles) ? obstacles : [])
        .map((ob) => {
            const opts = ob?.points;
            if (!Array.isArray(opts) || opts.length < 3) return null;
            let xmn = Infinity, ymn = Infinity, xmx = -Infinity, ymx = -Infinity;
            for (const p of opts) {
                if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
                if (p.x < xmn) xmn = p.x;
                if (p.y < ymn) ymn = p.y;
                if (p.x > xmx) xmx = p.x;
                if (p.y > ymx) ymx = p.y;
            }
            return { points: opts, xmin: xmn, ymin: ymn, xmax: xmx, ymax: ymx };
        })
        .filter(Boolean);

    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const p of pts) {
        if (p.x < xmin) xmin = p.x;
        if (p.y < ymin) ymin = p.y;
        if (p.x > xmax) xmax = p.x;
        if (p.y > ymax) ymax = p.y;
    }

    const padX = (xmax - xmin) * 0.02;
    const padY = (ymax - ymin) * 0.02;
    xmin -= padX; xmax += padX;
    ymin -= padY; ymax += padY;

    const W_mm = xmax - xmin;
    const H_mm = ymax - ymin;
    let nx, ny;
    if (W_mm >= H_mm) {
        nx = nxTarget;
        ny = Math.max(8, Math.round(nxTarget * (H_mm / W_mm)));
    } else {
        ny = nxTarget;
        nx = Math.max(8, Math.round(nxTarget * (W_mm / H_mm)));
    }
    // Grow the shorter side's bbox padding so cells stay square.
    const dx = W_mm / nx;
    const dy = H_mm / ny;
    // By construction these should match within float epsilon; clamp exactly
    // to avoid anisotropy if the user draws weird aspect ratios.
    const d_mm = Math.min(dx, dy);
    const dxPhys_m = d_mm / 1000;

    const mask = new Uint8Array(nx * ny);
    mask.fill(1); // wall by default

    for (let j = 0; j < ny; j++) {
        const yc = ymin + (j + 0.5) * dy;
        for (let i = 0; i < nx; i++) {
            const xc = xmin + (i + 0.5) * dx;
            if (pointInPolygon(pts, xc, yc)) mask[j * nx + i] = 0; // fluid
        }
    }

    /* Carve out obstacles ─ any cell whose centre falls inside an
     *  obstacle polygon flips back to wall. Done BEFORE inlet/outlet
     *  tagging so obstacle-adjacent cells aren't mistaken for
     *  boundary fluid. Per-obstacle bbox short-circuits the cell scan
     *  for non-overlapping shapes. */
    if (obstacleRings.length > 0) {
        for (const ob of obstacleRings) {
            const jLo = Math.max(0, Math.floor((ob.ymin - ymin) / dy) - 1);
            const jHi = Math.min(ny - 1, Math.ceil((ob.ymax - ymin) / dy) + 1);
            const iLo = Math.max(0, Math.floor((ob.xmin - xmin) / dx) - 1);
            const iHi = Math.min(nx - 1, Math.ceil((ob.xmax - xmin) / dx) + 1);
            for (let j = jLo; j <= jHi; j++) {
                const yc = ymin + (j + 0.5) * dy;
                for (let i = iLo; i <= iHi; i++) {
                    const k = j * nx + i;
                    if (mask[k] !== 0) continue; // already wall / inlet / outlet
                    const xc = xmin + (i + 0.5) * dx;
                    if (pointInPolygon(ob.points, xc, yc)) mask[k] = 1;
                }
            }
        }
    }

    /* Tag inlet / outlet cells. For each fluid cell that borders a wall,
       find the nearest polygon edge; if that edge has type 'inlet' or
       'outlet', mark this cell accordingly. We widen the tagged band by
       inspecting 2 cells deep from the boundary — helps the Zou-He inlet
       converge without speckled noise along oblique edges. */
    const maxCells = 2;
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            if (mask[k] !== 0) continue;

            // Is this cell near the boundary? (Any neighbour in a 2-cell
            // window is a wall.)
            let nearBoundary = false;
            outer: for (let dj = -maxCells; dj <= maxCells; dj++) {
                for (let di = -maxCells; di <= maxCells; di++) {
                    const ii = i + di, jj = j + dj;
                    if (ii < 0 || ii >= nx || jj < 0 || jj >= ny) continue;
                    if (mask[jj * nx + ii] === 1) { nearBoundary = true; break outer; }
                }
            }
            if (!nearBoundary) continue;

            const xc = xmin + (i + 0.5) * dx;
            const yc = ymin + (j + 0.5) * dy;
            // Find nearest polygon edge.
            let bestIdx = -1;
            let bestDist = Infinity;
            for (let e = 0; e < pts.length; e++) {
                const a = pts[e];
                const b = pts[(e + 1) % pts.length];
                const d = distToSegment(xc, yc, a, b);
                if (d < bestDist) { bestDist = d; bestIdx = e; }
            }
            const bc = entity.edgeBC?.[bestIdx];
            if (!bc) continue;
            if (bc.type === 'inlet') mask[k] = 2;
            else if (bc.type === 'outlet') mask[k] = 3;
            // Sensor edges are logically walls for the flow solver (no-slip),
            // but we keep a map of which fluid cell borders each sensor
            // so the species solver can sample c there without a second
            // rasterisation pass. The mask itself stays wall (=1) for
            // sensor cells — see sensorEdgeNearFluid below.
        }
    }

    /* ── Sensor bookkeeping (for species transport + wall analysis) ──
     * For every polygon edge tagged as sensor we collect the fluid-cell
     * indices that touch that edge (≤ 2 cells deep). The solver uses
     * these to compute (a) mean near-wall concentration c(t), (b) mean
     * near-wall velocity magnitude |u|(t), and (c) a crude wall shear
     * estimate. Length of each sensor edge is returned so the main
     * thread can normalise extensive quantities.                         */
    const sensorEdges = [];
    const inletLength_mm = (() => {
        let total = 0;
        for (let e = 0; e < pts.length; e++) {
            if (entity.edgeBC?.[e]?.type !== 'inlet') continue;
            const a = pts[e], b = pts[(e + 1) % pts.length];
            total += Math.hypot(b.x - a.x, b.y - a.y);
        }
        return total;
    })();

    for (let e = 0; e < pts.length; e++) {
        const bc = entity.edgeBC?.[e];
        if (bc?.type !== 'sensor') continue;
        const a = pts[e], b = pts[(e + 1) % pts.length];
        const edgeLen = Math.hypot(b.x - a.x, b.y - a.y);
        // Find all fluid cells whose centre is within ~1.2 cell widths of
        // this segment AND closer to this segment than to any other edge
        // of the polygon. That "closest-edge" test is what lets adjacent
        // sensor edges stay disjoint.
        const cells = [];
        // Tightened from 2.2 to 1.2 to only capture the immediate wet layer
        // of fluid adjacent to the wall, giving a sharper c(t) reading.
        const maxDist = d_mm * 1.2;
        for (let j = 0; j < ny; j++) {
            const yc = ymin + (j + 0.5) * dy;
            for (let i = 0; i < nx; i++) {
                const k = j * nx + i;
                if (mask[k] !== 0) continue;
                const xc = xmin + (i + 0.5) * dx;
                const d = distToSegment(xc, yc, a, b);
                if (d > maxDist) continue;
                // Closest-edge check
                let bestDist = Infinity, bestIdx = -1;
                for (let ee = 0; ee < pts.length; ee++) {
                    const aa = pts[ee], bb = pts[(ee + 1) % pts.length];
                    const dd = distToSegment(xc, yc, aa, bb);
                    if (dd < bestDist) { bestDist = dd; bestIdx = ee; }
                }
                if (bestIdx !== e) continue;
                cells.push(k);
            }
        }
        sensorEdges.push({ edgeIdx: e, cells, length_mm: edgeLen, label: bc.label || `S${sensorEdges.length + 1}` });
    }

    return {
        mask,
        nx, ny,
        dx: d_mm, dy: d_mm,
        dxPhys_m,
        bbox: { xmin, ymin, xmax, ymax },
        sensorEdges,          // [{edgeIdx, cells:[k,…], length_mm, label}, …]
        inletLength_mm,       // total length of all inlet edges (mm)
    };
}

/** Unit outward normal of polygon edge `i` (ccw-oriented polygon).
    Used by the solver to know which direction an inlet pushes into. */
export function edgeOutwardNormal(pts, i) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    // Edge tangent:
    const tx = b.x - a.x, ty = b.y - a.y;
    // Rotate -90° to get outward normal for a CCW polygon.
    // (If the user drew clockwise we'll flip later via signed area.)
    const area = signedArea(pts);
    const sign = area > 0 ? 1 : -1;
    const L = Math.hypot(tx, ty) || 1;
    return { x: sign * (ty / L), y: -sign * (tx / L) };
}

export function signedArea(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        s += a.x * b.y - b.x * a.y;
    }
    return 0.5 * s;
}

/** Compute characteristic length for Reynolds number: shortest bbox dim. */
export function characteristicLength_mm(entity) {
    const bb = entitiesBBox([entity]);
    if (!bb) return 1;
    return Math.min(bb.xmax - bb.xmin, bb.ymax - bb.ymin);
}

/** Segment/segment intersection in 2D.
 *  Returns { t, u, x, y } where
 *    t ∈ [0,1] = parameter along (p1,p2)
 *    u ∈ [0,1] = parameter along (p3,p4)
 *  or null if the segments are parallel / don't intersect within the
 *  valid parameter range. `eps` lets callers decide whether to include
 *  exact endpoint touches (default: strict, so endpoint-on-endpoint is
 *  rejected — cleaner for the trim tool, which otherwise sees ghost
 *  intersections at the segment ends themselves). */
export function segSegIntersection(p1, p2, p3, p4, eps = 1e-9) {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-12) return null;
    const rx = p3.x - p1.x, ry = p3.y - p1.y;
    const t = (rx * d2y - ry * d2x) / denom;
    const u = (rx * d1y - ry * d1x) / denom;
    if (t < eps || t > 1 - eps) return null;
    if (u < eps || u > 1 - eps) return null;
    return { t, u, x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/** Parametric position of point projected onto segment (p1,p2). Clamped. */
export function projectPointOnSegment(px, py, p1, p2) {
    const vx = p2.x - p1.x, vy = p2.y - p1.y;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-20) return 0;
    const wx = px - p1.x, wy = py - p1.y;
    return Math.max(0, Math.min(1, (vx * wx + vy * wy) / len2));
}

/** Trim a single straight line (p1,p2) using a set of cutting segments.
 *  `clickPoint` = the user's click in world coords (mm). The algorithm
 *  finds all intersection parameters t ∈ (0,1) along the line, sorts
 *  them, then removes the unique sub-interval that brackets the click.
 *  Returns an array of {t0, t1} intervals for the REMAINING pieces of
 *  the line (possibly empty = whole line gone; often 1 interval = line
 *  got shorter; sometimes 2 intervals = the line was split).
 *  Adjacent intervals are merged. */
export function trimLineAtPoint(p1, p2, clickPoint, cuttingEdges) {
    const tClick = projectPointOnSegment(clickPoint.x, clickPoint.y, p1, p2);
    // Collect intersections strictly inside (0,1).
    const ts = [];
    for (const edge of cuttingEdges) {
        const r = segSegIntersection(p1, p2, edge[0], edge[1], 1e-6);
        if (r) ts.push(r.t);
    }
    // Dedupe close intersections (numerical robustness).
    ts.sort((a, b) => a - b);
    const dedup = [];
    for (const t of ts) {
        if (!dedup.length || Math.abs(t - dedup[dedup.length - 1]) > 1e-6) dedup.push(t);
    }
    if (dedup.length === 0) {
        // No cutting edge — nothing to trim. Return the whole line.
        return [{ t0: 0, t1: 1, trimmed: false }];
    }
    // Find the unique [tPrev, tNext] bracket that contains tClick.
    let tPrev = 0, tNext = 1;
    for (const t of dedup) {
        if (t <= tClick) tPrev = t;
        else { tNext = t; break; }
    }
    // Build break-points then remove the bracket.
    const breaks = [0, ...dedup, 1];
    const kept = [];
    for (let i = 0; i < breaks.length - 1; i++) {
        const a = breaks[i], b = breaks[i + 1];
        if (Math.abs(a - tPrev) < 1e-9 && Math.abs(b - tNext) < 1e-9) continue;
        kept.push({ t0: a, t1: b, trimmed: true });
    }
    // Merge adjacent kept intervals.
    const merged = [];
    for (const seg of kept) {
        if (merged.length && Math.abs(merged[merged.length - 1].t1 - seg.t0) < 1e-9) {
            merged[merged.length - 1].t1 = seg.t1;
        } else merged.push({ ...seg });
    }
    return merged;
}

/** Convenience: list all line segments in a scene that can act as
 *  cutting edges. Each entry is `[p1, p2]`. `exclude` lets the caller
 *  omit the line being trimmed. Closed polygons contribute all their
 *  edges; open polylines contribute all their sub-segments; sections
 *  contribute their two end-points. */
export function collectCuttingEdges(entities, sections, { excludeEntityId, excludeSectionId, excludeEdge } = {}) {
    const out = [];
    for (const e of entities) {
        if (!e?.points?.length || e.points.length < 2) continue;
        const isClosed = e.closed !== false;
        const nEdges = isClosed ? e.points.length : e.points.length - 1;
        for (let i = 0; i < nEdges; i++) {
            if (excludeEntityId === e.id && excludeEdge === i) continue;
            const a = e.points[i];
            const b = e.points[(i + 1) % e.points.length];
            out.push([a, b]);
        }
    }
    for (const s of sections) {
        if (!s?.points?.length || s.points.length < 2) continue;
        if (excludeSectionId === s.id) continue;
        out.push([s.points[0], s.points[1]]);
    }
    return out;
}

/** Apply `trimLineAtPoint` to a section and return the resulting array
 *  of new sections (0, 1, or 2 of them — a middle-trim splits in two).
 *  Each new section inherits the source's label/colour/visibility; the
 *  second copy gets a unique id + suffixed label so the UI treats them
 *  distinctly. */
export function trimSection(section, clickPoint, cuttingEdges, { idFactory } = {}) {
    const p1 = section.points[0], p2 = section.points[1];
    const intervals = trimLineAtPoint(p1, p2, clickPoint, cuttingEdges);
    if (!intervals.length) return [];
    // Drop tiny slivers (< 0.1% of length). Leftover sub-mm noise isn't
    // a useful probe; it'd just clutter the list.
    const lenMm = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const minFrac = 0.001;
    const nonTrivial = intervals.filter((iv) => (iv.t1 - iv.t0) > minFrac);
    if (!nonTrivial.length) return [];
    const pointAt = (t) => ({
        x: p1.x + t * (p2.x - p1.x),
        y: p1.y + t * (p2.y - p1.y),
    });
    const nextId = idFactory || (() => `${section.id}_t${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`);
    return nonTrivial.map((iv, i) => ({
        ...section,
        id: i === 0 ? section.id : nextId(),
        label: i === 0 ? (section.label || section.id) : `${section.label || section.id} (trim ${i})`,
        points: [pointAt(iv.t0), pointAt(iv.t1)],
    }));
    // Note: lenMm kept only as a named computation for clarity.
    // eslint-disable-next-line no-unused-expressions
    lenMm;
}

/** Trim a single edge of an open polyline entity. `edgeIdx` is the
 *  index of the edge in `entity.points` (0 → edge between pts[0] and
 *  pts[1], etc.). `clickPoint` is the user's click in world mm.
 *
 *  After trimming, the polyline may:
 *    · stay intact (click did nothing — no intersections on this edge),
 *    · keep its vertex count but with the edge shortened on one side,
 *    · split into two independent polylines (middle trim or full-edge
 *      removal), or
 *    · split into three (edge with ≥ 3 intersections, middle segment
 *      floats). This is rare but handled.
 *
 *  Returns the replacement entity array (1, 2 or 3 entities). Callers
 *  should substitute the original entity with this array. */
export function trimOpenPolylineEdge(entity, edgeIdx, clickPoint, cuttingEdges, { idFactory } = {}) {
    if (!entity || entity.closed !== false) return [entity];
    const pts = entity.points;
    if (edgeIdx < 0 || edgeIdx >= pts.length - 1) return [entity];
    const a = pts[edgeIdx], b = pts[edgeIdx + 1];
    const intervals = trimLineAtPoint(a, b, clickPoint, cuttingEdges);
    // No trim happened (no cutting edges cross this edge).
    if (intervals.length === 1 && !intervals[0].trimmed) return [entity];
    const nextId = idFactory || (() => `${entity.id}_${Math.floor(Math.random() * 1e6).toString(36)}`);
    const pointAt = (t) => ({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    const minFrac = 0.001;
    const kept = intervals.filter((iv) => (iv.t1 - iv.t0) > minFrac);

    // Whole edge consumed → polyline splits at this edge.
    if (!kept.length) {
        const preVerts = pts.slice(0, edgeIdx + 1);
        const postVerts = pts.slice(edgeIdx + 1);
        const out = [];
        if (preVerts.length >= 2) out.push({ ...entity, points: preVerts });
        if (postVerts.length >= 2) out.push({ ...entity, id: nextId(), points: postVerts });
        return out;
    }

    // Single kept piece — click straddled one end of the edge, so the
    // piece ALWAYS touches exactly one of (a, b). We simplify by just
    // replacing the edge's endpoints inside the original polyline.
    if (kept.length === 1) {
        const iv = kept[0];
        const touchesA = iv.t0 < 1e-6;
        const touchesB = iv.t1 > 1 - 1e-6;
        if (touchesA && touchesB) return [entity]; // nothing trimmed
        if (touchesA) {
            // Polyline continues from pre-verts into the kept sub-edge
            // ending at `newB`; post-verts become a separate polyline
            // starting at `b`.
            const newB = pointAt(iv.t1);
            const preVerts = pts.slice(0, edgeIdx + 1).concat([newB]);
            const postVerts = pts.slice(edgeIdx + 1);
            const out = [];
            if (preVerts.length >= 2) out.push({ ...entity, points: preVerts });
            if (postVerts.length >= 2) out.push({ ...entity, id: nextId(), points: postVerts });
            return out;
        }
        if (touchesB) {
            // Mirror case: pre stays at `a`, post starts at `newA`.
            const newA = pointAt(iv.t0);
            const preVerts = pts.slice(0, edgeIdx + 1);
            const postVerts = [newA].concat(pts.slice(edgeIdx + 1));
            const out = [];
            if (preVerts.length >= 2) out.push({ ...entity, points: preVerts });
            if (postVerts.length >= 2) out.push({ ...entity, id: nextId(), points: postVerts });
            return out;
        }
        // Floating middle (shouldn't normally happen with our algorithm,
        // but be defensive): pre, kept, post are all separate.
        const preVerts = pts.slice(0, edgeIdx + 1);
        const postVerts = pts.slice(edgeIdx + 1);
        const out = [];
        if (preVerts.length >= 2) out.push({ ...entity, points: preVerts });
        out.push({ ...entity, id: nextId(), points: [pointAt(iv.t0), pointAt(iv.t1)] });
        if (postVerts.length >= 2) out.push({ ...entity, id: nextId(), points: postVerts });
        return out;
    }

    // Two or more kept intervals — trim removed an interior region.
    // kept[0] touches `a`, kept[last] touches `b`. Any interior
    // intervals are floating sub-segments.
    const ivFirst = kept[0];
    const ivLast  = kept[kept.length - 1];
    const preEndpoint = pointAt(ivFirst.t1);
    const postStart   = pointAt(ivLast.t0);
    const preVerts = pts.slice(0, edgeIdx + 1).concat([preEndpoint]);
    const postVerts = [postStart].concat(pts.slice(edgeIdx + 1));
    const out = [];
    if (preVerts.length >= 2) out.push({ ...entity, points: preVerts });
    for (let i = 1; i < kept.length - 1; i++) {
        out.push({ ...entity, id: nextId(), points: [pointAt(kept[i].t0), pointAt(kept[i].t1)] });
    }
    if (postVerts.length >= 2) out.push({ ...entity, id: nextId(), points: postVerts });
    return out;
}

/* ═══════════════════════════════════════════════════════════════════
 * PROFESSIONAL CAD OPERATIONS
 * ───────────────────────────────────────────────────────────────────
 * Boolean ops (union / subtract / intersect / xor), 2D offset, affine
 * transforms (move / rotate / scale / mirror), extend, and boundary
 * tracing from open polylines. The boolean ops use the `polygon-
 * clipping` library (Martinez's algorithm) which handles degenerate
 * cases, self-intersections, and disjoint results robustly.
 * ══════════════════════════════════════════════════════════════════ */

import polyClip from 'polygon-clipping';

/** Convert an entity's points to the [[x,y], …] ring format that
 *  polygon-clipping expects. Rings must be closed; the library
 *  tolerates duplicate first/last vertices but we normalise to a
 *  single closure. */
function entityToRing(entity) {
    if (!entity || entity.closed === false) return null;
    const pts = entity.points;
    if (!pts || pts.length < 3) return null;
    const ring = pts.map((p) => [p.x, p.y]);
    // Close the ring explicitly for the library.
    const f = ring[0], l = ring[ring.length - 1];
    if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
    return ring;
}

/** polygon-clipping returns MultiPolygon: [[outerRing, hole1, …], …].
 *  Each outer ring becomes a closed-polyline entity (the fluid domain
 *  candidate). Every HOLE ring is emitted as a separate entity tagged
 *  with `obstacle: true` — the solver rasteriser recognises these and
 *  carves them out of the fluid domain as no-slip walls. This lets
 *  "rect − circle" produce a rectangle with a circular void, matching
 *  the user's mental model of boolean subtract. */
function multiPolygonToEntities(mp, templateEntity, { idFactory } = {}) {
    const out = [];
    const nextId = idFactory || (() => `${templateEntity?.id || 'bool'}_${Math.floor(Math.random() * 1e6).toString(36)}`);

    /* Normalise a polyclip ring (array of [x,y], first == last) into a
     *  CCW-oriented list of {x,y} with the trailing closure vertex
     *  dropped. Returns null on degenerate input. */
    const ringToCCWPts = (ring, { forceCCW = true } = {}) => {
        if (!ring || ring.length < 4) return null; // 3 verts + closure
        const bare = ring.slice(0, ring.length - 1);
        const pts = bare.map(([x, y]) => ({ x, y }));
        const area = signedArea(pts);
        if (forceCCW && area < 0) pts.reverse();
        return pts;
    };

    for (const poly of mp) {
        if (!poly || !poly.length) continue;

        // Outer ring → regular domain/region entity.
        const outerPts = ringToCCWPts(poly[0]);
        if (!outerPts) continue;
        const outerEdgeBC = {};
        for (let i = 0; i < outerPts.length; i++) outerEdgeBC[i] = { type: 'wall' };
        out.push({
            id: nextId(),
            type: 'region',
            closed: true,
            points: outerPts,
            edgeBC: outerEdgeBC,
        });

        // Hole rings → obstacle entities (no-slip voids carved from
        // the outer domain). polygon-clipping reports holes as inner
        // rings of the same polygon. Keep them CCW for the solver —
        // the `obstacle: true` flag is what makes them walls, not the
        // winding order.
        for (let h = 1; h < poly.length; h++) {
            const holePts = ringToCCWPts(poly[h]);
            if (!holePts) continue;
            const holeEdgeBC = {};
            for (let i = 0; i < holePts.length; i++) holeEdgeBC[i] = { type: 'wall' };
            out.push({
                id: nextId(),
                type: 'obstacle',
                closed: true,
                obstacle: true,
                points: holePts,
                edgeBC: holeEdgeBC,
            });
        }
    }
    return out;
}

/** Boolean UNION of two or more closed-polygon entities. Returns an
 *  array of new entities (one per resulting disjoint outer ring).
 *  Any open polylines in the input are ignored silently. */
export function booleanUnion(entities, opts = {}) {
    const rings = entities.map(entityToRing).filter(Boolean);
    if (rings.length === 0) return [];
    if (rings.length === 1) return entities.slice(0, 1);
    const mp = polyClip.union(...rings.map((r) => [r]));
    return multiPolygonToEntities(mp, entities[0], opts);
}

/** Boolean SUBTRACTION A − (B ∪ C ∪ …). The first entity is the
 *  subject; all the rest are subtracted from it. Returns zero or
 *  more entities. */
export function booleanSubtract(entities, opts = {}) {
    const rings = entities.map(entityToRing).filter(Boolean);
    if (rings.length < 2) return entities;
    const [a, ...rest] = rings;
    const mp = polyClip.difference([a], ...rest.map((r) => [r]));
    return multiPolygonToEntities(mp, entities[0], opts);
}

/** Boolean INTERSECTION — the common region of all inputs. */
export function booleanIntersect(entities, opts = {}) {
    const rings = entities.map(entityToRing).filter(Boolean);
    if (rings.length < 2) return entities;
    const mp = polyClip.intersection(...rings.map((r) => [r]));
    return multiPolygonToEntities(mp, entities[0], opts);
}

/** Boolean XOR — the symmetric difference (exclusive regions). */
export function booleanXor(entities, opts = {}) {
    const rings = entities.map(entityToRing).filter(Boolean);
    if (rings.length < 2) return entities;
    const mp = polyClip.xor(...rings.map((r) => [r]));
    return multiPolygonToEntities(mp, entities[0], opts);
}

/** 2D polygon offset (a.k.a. "buffer" in GIS). A positive distance
 *  grows the polygon outward; negative shrinks it. Implemented via a
 *  minimal Minkowski-sum-style algorithm: offset each edge along its
 *  outward normal, then trim/extend intersections at corners.
 *
 *  For very concave polygons or when a negative offset exceeds the
 *  local "radius" of the shape, the offset may self-intersect — we
 *  run the result through polygon-clipping's union to clean it up. */
export function offsetPolygon(entity, distance_mm, { idFactory } = {}) {
    if (!entity || entity.closed !== true) return [entity];
    const pts = entity.points;
    if (!pts || pts.length < 3 || !Number.isFinite(distance_mm) || distance_mm === 0) return [entity];

    // Force CCW so outward normal = rotate edge 90° CW.
    const area = signedArea(pts);
    const src = area >= 0 ? pts : pts.slice().reverse();
    const n = src.length;

    // 1. Build offset lines (each edge translated along its outward normal).
    const offLines = new Array(n);
    for (let i = 0; i < n; i++) {
        const a = src[i], b = src[(i + 1) % n];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        // outward normal for CCW ring = (dy, -dx)/len
        const nx = dy / len, ny = -dx / len;
        offLines[i] = {
            a: { x: a.x + nx * distance_mm, y: a.y + ny * distance_mm },
            b: { x: b.x + nx * distance_mm, y: b.y + ny * distance_mm },
        };
    }

    // 2. Intersect consecutive offset lines to find new vertices.
    const newPts = [];
    for (let i = 0; i < n; i++) {
        const L0 = offLines[(i - 1 + n) % n];
        const L1 = offLines[i];
        const p = lineLineIntersection(L0.a, L0.b, L1.a, L1.b);
        if (p) newPts.push(p);
        else   newPts.push({ x: L1.a.x, y: L1.a.y }); // parallel → keep
    }

    // 3. If the offset caused a self-intersection (typical for heavy
    //    inward offsets of concave shapes), clean it up with a UNION
    //    of the result with itself — polygon-clipping will simplify.
    const cleaned = polyClip.union([newPts.concat([newPts[0]]).map((p) => [p.x, p.y])]);
    const out = multiPolygonToEntities(cleaned, entity, { idFactory });
    // Inherit the original edge BCs when topology is preserved (same
    // vertex count), so inlet/outlet tags survive a small offset.
    if (out.length === 1 && out[0].points.length === n) {
        const inherited = {};
        for (let i = 0; i < n; i++) {
            inherited[i] = entity.edgeBC?.[i] || { type: 'wall' };
        }
        out[0] = { ...out[0], edgeBC: inherited };
    }
    return out;
}

/** Line–line intersection (infinite lines, not segments). Returns
 *  null if they're parallel. */
function lineLineIntersection(p1, p2, p3, p4) {
    const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-12) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

/** Affine transform helpers — all return a NEW entity (never mutate).
 *  edgeBC is preserved verbatim since topology doesn't change. */
export function transformEntity(entity, matrix) {
    if (!entity) return entity;
    const { a, b, c, d, e, f } = matrix; // [[a c e] [b d f]]
    const pts = entity.points.map((p) => ({
        x: a * p.x + c * p.y + e,
        y: b * p.x + d * p.y + f,
    }));
    return { ...entity, points: pts };
}
export const translateEntity = (entity, dx, dy) =>
    transformEntity(entity, { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });
export function rotateEntity(entity, cx, cy, deg) {
    const r = (deg * Math.PI) / 180;
    const cosT = Math.cos(r), sinT = Math.sin(r);
    return transformEntity(entity, {
        a: cosT, b: sinT, c: -sinT, d: cosT,
        e: cx - cx * cosT + cy * sinT,
        f: cy - cx * sinT - cy * cosT,
    });
}
export function scaleEntity(entity, cx, cy, sx, sy = sx) {
    return transformEntity(entity, {
        a: sx, b: 0, c: 0, d: sy,
        e: cx - cx * sx,
        f: cy - cy * sy,
    });
}
/** Reflect across the line through (ax,ay)→(bx,by). */
export function mirrorEntity(entity, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return entity;
    // Reflection matrix about line through origin with direction d̂:
    //   [ d̂x²−d̂y²    2 d̂x d̂y ]
    //   [ 2 d̂x d̂y   d̂y²−d̂x² ]
    // then translate so `a` is a fixed point.
    const nx = dx / Math.sqrt(len2), ny = dy / Math.sqrt(len2);
    const mxx = nx * nx - ny * ny;
    const mxy = 2 * nx * ny;
    const myy = ny * ny - nx * nx;
    const mat = {
        a: mxx, b: mxy, c: mxy, d: myy,
        e: a.x - (mxx * a.x + mxy * a.y),
        f: a.y - (mxy * a.x + myy * a.y),
    };
    const reflected = transformEntity(entity, mat);
    // Reflection flips orientation. For closed polygons we reverse the
    // point list so the outward normal keeps pointing the right way.
    if (reflected.closed !== false) {
        const n = reflected.points.length;
        reflected.points = reflected.points.slice().reverse();
        // Re-key edgeBC: old edge i (pts[i]→pts[i+1]) becomes edge
        // (n-2-i) after reversal (pts[n-1-i]→pts[n-2-i] = reverse).
        const oldBC = entity.edgeBC || {};
        const newBC = {};
        for (let i = 0; i < n; i++) {
            const newIdx = (n - 1 - i - 1 + n) % n;
            newBC[newIdx] = oldBC[i] || { type: 'wall' };
        }
        reflected.edgeBC = newBC;
    }
    return reflected;
}

/** EXTEND — grow an open polyline's endpoint forward along the last
 *  (or first) edge direction until it hits the NEAREST of the given
 *  cutting edges. Returns a new entity or the original if no
 *  intersection is found within `maxDist_mm` (default 1 e 6).
 *
 *  `endpoint`: 'start' (extend from pts[0] backward along edge 0→1)
 *              or 'end' (extend from pts[last] forward along last edge).
 */
export function extendOpenPolyline(entity, endpoint, cuttingEdges, { maxDist_mm = 1e6 } = {}) {
    if (!entity || entity.closed !== false) return entity;
    const pts = entity.points;
    if (pts.length < 2) return entity;
    let anchor, direction, replaceIdx;
    if (endpoint === 'start') {
        anchor = pts[0];
        const nextV = pts[1];
        // Direction goes OUT from the polyline at the start → reverse
        // of the start-edge direction.
        direction = { x: anchor.x - nextV.x, y: anchor.y - nextV.y };
        replaceIdx = 0;
    } else {
        anchor = pts[pts.length - 1];
        const prevV = pts[pts.length - 2];
        direction = { x: anchor.x - prevV.x, y: anchor.y - prevV.y };
        replaceIdx = pts.length - 1;
    }
    const dlen = Math.hypot(direction.x, direction.y);
    if (dlen < 1e-9) return entity;
    const dx = direction.x / dlen, dy = direction.y / dlen;
    // Walk ray (anchor + t * d) and find smallest positive t that hits
    // any cutting edge. We clamp to maxDist_mm to avoid infinite rays.
    const far = { x: anchor.x + dx * maxDist_mm, y: anchor.y + dy * maxDist_mm };
    let bestT = Infinity, bestPt = null;
    for (const e of cuttingEdges) {
        // Skip edges that touch anchor (own polyline start/end edge).
        const touchesAnchor = (p) => Math.hypot(p.x - anchor.x, p.y - anchor.y) < 1e-6;
        if (touchesAnchor(e.a) || touchesAnchor(e.b)) continue;
        const hit = segSegIntersection(anchor, far, e.a, e.b);
        if (!hit) continue;
        const t = (hit.x - anchor.x) * dx + (hit.y - anchor.y) * dy;
        if (t > 1e-6 && t < bestT) {
            bestT = t;
            bestPt = hit;
        }
    }
    if (!bestPt) return entity;
    const newPts = pts.slice();
    newPts[replaceIdx] = { x: bestPt.x, y: bestPt.y };
    return { ...entity, points: newPts };
}

/** JOIN / BOUNDARY — take a set of open polylines and try to stitch
 *  them into a single closed polygon by chaining endpoints whose
 *  coordinates match within `tol_mm`. Returns:
 *    { ok: true, entity }   if a full closed loop was formed
 *    { ok: false, reason }  with a human-readable error otherwise.
 *
 *  Typical workflow: user draws several Line segments that form a
 *  rough outline, uses Trim / Extend to clean intersections, then
 *  picks all of them + clicks "Make region" → closed polygon ready
 *  for boundary conditions. */
export function joinPolylinesIntoRegion(entities, { tol_mm = 1e-3, idFactory } = {}) {
    const open = entities.filter((e) => e && e.closed === false && e.points && e.points.length >= 2);
    if (open.length === 0) return { ok: false, reason: 'Select at least one open polyline.' };

    // Work on mutable copies of each polyline's point list. We'll walk
    // greedily: start with the first segment, then find another segment
    // whose start OR end matches our current tip, and append it
    // (reversing if needed). Stop when we return to the original start.
    const unused = open.map((e) => e.points.map((p) => ({ x: p.x, y: p.y })));
    const chain = unused.shift();
    const close = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= tol_mm;

    let progress = true;
    while (progress && unused.length > 0) {
        progress = false;
        for (let i = 0; i < unused.length; i++) {
            const seg = unused[i];
            const tip = chain[chain.length - 1];
            const head = chain[0];
            if (close(tip, seg[0])) {
                chain.push(...seg.slice(1));
                unused.splice(i, 1);
                progress = true; break;
            }
            if (close(tip, seg[seg.length - 1])) {
                chain.push(...seg.slice(0, -1).reverse());
                unused.splice(i, 1);
                progress = true; break;
            }
            if (close(head, seg[0])) {
                chain.unshift(...seg.slice(1).reverse());
                unused.splice(i, 1);
                progress = true; break;
            }
            if (close(head, seg[seg.length - 1])) {
                chain.unshift(...seg.slice(0, -1));
                unused.splice(i, 1);
                progress = true; break;
            }
        }
    }

    if (unused.length > 0) {
        return { ok: false, reason: `Could not chain ${unused.length} polyline${unused.length === 1 ? '' : 's'} — endpoints don't meet (try Extend / Trim first).` };
    }

    // Check that the chain closes (head ≈ tail). Drop the duplicate
    // closing vertex if present.
    if (!close(chain[0], chain[chain.length - 1])) {
        return { ok: false, reason: 'Polylines chain but the final endpoint doesn\'t return to the start — extend or add the closing segment.' };
    }
    if (chain.length >= 2 && close(chain[0], chain[chain.length - 1])) {
        chain.pop();
    }
    if (chain.length < 3) {
        return { ok: false, reason: 'Need at least 3 distinct vertices to form a region.' };
    }

    const nextId = idFactory || (() => `region_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`);
    const edgeBC = {};
    for (let i = 0; i < chain.length; i++) edgeBC[i] = { type: 'wall' };
    return {
        ok: true,
        entity: {
            id: nextId(),
            type: 'region',
            closed: true,
            points: chain,
            edgeBC,
        },
    };
}

/** Compute the centroid of a closed polygon (for rotation pivot). */
export function polygonCentroid(pts) {
    const n = pts.length;
    let cx = 0, cy = 0, a = 0;
    for (let i = 0; i < n; i++) {
        const p = pts[i], q = pts[(i + 1) % n];
        const cross = p.x * q.y - q.x * p.y;
        a += cross;
        cx += (p.x + q.x) * cross;
        cy += (p.y + q.y) * cross;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-12) {
        // degenerate → fall back to arithmetic mean
        cx = pts.reduce((s, p) => s + p.x, 0) / n;
        cy = pts.reduce((s, p) => s + p.y, 0) / n;
        return { x: cx, y: cy };
    }
    return { x: cx / (6 * a), y: cy / (6 * a) };
}

/** Bounding-box centroid of a set of entities (for "mirror about bbox
 *  centre" default pivot). */
export function entitiesCentroid(entities) {
    const bb = entitiesBBox(entities);
    if (!bb) return { x: 0, y: 0 };
    return { x: (bb.xmin + bb.xmax) / 2, y: (bb.ymin + bb.ymax) / 2 };
}
