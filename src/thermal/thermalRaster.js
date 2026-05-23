/**
 * Vector → raster conversion for the thermal solver.
 *
 * Given a list of thermal CAD entities (each carrying a `materialId` and an
 * optional `isHeater` flag), bake them into:
 *   - `materialIdx`: Uint8Array of THERMAL_MATERIAL_IDS indices, one per cell.
 *   - `heaterMask`:  Uint8Array, 1 where the cell falls inside any heater
 *                    region (or stroke band of an open trace).
 *
 * Painter's algorithm: entities later in the array overwrite earlier ones.
 * Cells whose centre lies inside the closed polygon take that material.
 *
 * Open polylines (lines, arcs, open chains) get a stroke band of width
 * `entity.openTraceWidthUm` (default 8 µm). This is how heater meanders
 * imported from a sketch are painted onto the membrane.
 *
 * Coordinates: `entities` are in µm, the grid spans `domainUm × domainUm`
 * centred on the origin (matching the Thermal Studio canvas).
 */

import { THERMAL_MATERIAL_IDS, materialIndex } from './materials.js';
import { pointInPolygon, distToSegment } from '../flowlab/geometry.js';

/**
 * Build a fast bounding-box for an entity in µm.
 * @returns {{xmin, ymin, xmax, ymax}|null}
 */
function entityBBox(ent) {
    const pts = ent.points;
    if (!pts || pts.length === 0) return null;
    let xmin = Infinity;
    let ymin = Infinity;
    let xmax = -Infinity;
    let ymax = -Infinity;
    for (const p of pts) {
        if (p.x < xmin) xmin = p.x;
        if (p.y < ymin) ymin = p.y;
        if (p.x > xmax) xmax = p.x;
        if (p.y > ymax) ymax = p.y;
    }
    if (!Number.isFinite(xmin)) return null;
    return { xmin, ymin, xmax, ymax };
}

/**
 * Rasterise the entity stack onto a square grid (Nx × Ny) covering
 * [-L/2, +L/2] × [-L/2, +L/2] (where L = `domainUm`).
 *
 * In addition to the material / heater grids, we also bake **per-region
 * boundary conditions** drawn by the user:
 *
 *   ent.bc.role === 'source'    → cell gets a volumetric Q [W/m³]
 *                                 distributed uniformly so the total
 *                                 power across the region equals
 *                                 ent.bc.sourceMW × 1e-3 W.
 *   ent.bc.role === 'dirichlet' → cell is pinned at ent.bc.fixedTC °C.
 *                                 Solver locks T = pinTValueK there.
 *   ent.bc.initialTC != null    → at t=0 / on Reset, T at this cell
 *                                 starts at initialTC °C instead of T_amb.
 *
 * Painter's z-order applies to everything (later entity wins).
 *
 * @param {object[]} entities  thermal CAD entities (in z-order)
 * @param {{
 *   Nx: number, Ny: number, domainUm: number,
 *   thicknessUm: number,
 *   baseMaterial?: string,
 *   defaultStrokeUm?: number,
 *   ambientC?: number,                used as default initial T baseline
 * }} opts
 * @returns {{
 *   materialIdx: Uint8Array,
 *   heaterMask: Uint8Array,
 *   sourceQwPerM3: Float64Array,       per-cell volumetric Q from sources [W/m³]
 *   pinTMask: Uint8Array,              1 = cell pinned by user-region Dirichlet
 *   pinTValueK: Float64Array,          pinned T in Kelvin (only valid where mask=1)
 *   initialTMask: Uint8Array,          1 = cell has user-overridden initial T
 *   initialTValueK: Float64Array,      initial T (Kelvin) where mask=1
 *   dxUm: number,
 * }}
 */
export function rasterizeEntitiesToGrid(entities, opts) {
    const Nx = opts.Nx | 0;
    const Ny = opts.Ny | 0;
    const N = Nx * Ny;
    const L = Number(opts.domainUm);
    const dxUm = L / Nx;
    const dyUm = L / Ny;
    const tzM = (Number(opts.thicknessUm) > 0 ? Number(opts.thicknessUm) : 1) * 1e-6;
    const baseId = opts.baseMaterial || 'air';
    const baseIdx = materialIndex(baseId);
    const defaultStrokeUm = Number.isFinite(opts.defaultStrokeUm) ? opts.defaultStrokeUm : 8;

    const materialIdx = new Uint8Array(N);
    materialIdx.fill(baseIdx);
    const heaterMask = new Uint8Array(N);
    const sourceQwPerM3 = new Float64Array(N);
    const pinTMask = new Uint8Array(N);
    const pinTValueK = new Float64Array(N);
    const initialTMask = new Uint8Array(N);
    const initialTValueK = new Float64Array(N);

    const halfL = L / 2;
    const list = Array.isArray(entities) ? entities : [];

    /* Helper that computes the cell-list inside a closed entity (or stroke
       band of an open entity). Reused for both painting material and for
       distributing source Q across the region. */
    const cellsForEntity = (ent) => {
        const pts = ent.points;
        const isClosed = ent.closed !== false;
        const bb = entityBBox(ent);
        if (!bb) return [];
        const cells = [];
        if (isClosed) {
            const iLo = Math.max(0, Math.floor((bb.xmin + halfL) / dxUm) - 1);
            const iHi = Math.min(Nx - 1, Math.ceil((bb.xmax + halfL) / dxUm) + 1);
            const jLo = Math.max(0, Math.floor((bb.ymin + halfL) / dyUm) - 1);
            const jHi = Math.min(Ny - 1, Math.ceil((bb.ymax + halfL) / dyUm) + 1);
            for (let j = jLo; j <= jHi; j++) {
                const yc = -halfL + (j + 0.5) * dyUm;
                if (yc < bb.ymin || yc > bb.ymax) continue;
                const row = j * Nx;
                for (let i = iLo; i <= iHi; i++) {
                    const xc = -halfL + (i + 0.5) * dxUm;
                    if (xc < bb.xmin || xc > bb.xmax) continue;
                    if (pointInPolygon(pts, xc, yc)) cells.push(row + i);
                }
            }
        } else {
            const w = Math.max(0.001, Number(ent.openTraceWidthUm) || defaultStrokeUm);
            const half = w / 2;
            const padBB = {
                xmin: bb.xmin - half,
                ymin: bb.ymin - half,
                xmax: bb.xmax + half,
                ymax: bb.ymax + half,
            };
            const iLo = Math.max(0, Math.floor((padBB.xmin + halfL) / dxUm) - 1);
            const iHi = Math.min(Nx - 1, Math.ceil((padBB.xmax + halfL) / dxUm) + 1);
            const jLo = Math.max(0, Math.floor((padBB.ymin + halfL) / dyUm) - 1);
            const jHi = Math.min(Ny - 1, Math.ceil((padBB.ymax + halfL) / dyUm) + 1);
            for (let j = jLo; j <= jHi; j++) {
                const yc = -halfL + (j + 0.5) * dyUm;
                const row = j * Nx;
                for (let i = iLo; i <= iHi; i++) {
                    const xc = -halfL + (i + 0.5) * dxUm;
                    let near = false;
                    for (let k = 0; k < pts.length - 1; k++) {
                        if (distToSegment(xc, yc, pts[k], pts[k + 1]) <= half) {
                            near = true;
                            break;
                        }
                    }
                    if (near) cells.push(row + i);
                }
            }
        }
        return cells;
    };

    /** Painter's loop: later entities win. */
    for (const ent of list) {
        if (!ent || !ent.points || ent.points.length < 2) continue;
        const matId = ent.materialId || baseId;
        const matIndex = materialIndex(matId);
        const isHeater = !!ent.isHeater;
        const cells = cellsForEntity(ent);
        if (cells.length === 0) continue;

        for (const p of cells) {
            materialIdx[p] = matIndex;
            heaterMask[p] = isHeater ? 1 : 0;
            /* Reset BC layers for cells that this entity overwrites — later
               entities supersede earlier BCs, just like material paint. */
            sourceQwPerM3[p] = 0;
            pinTMask[p] = 0;
            initialTMask[p] = 0;
        }

        /* Apply boundary-condition layer for this entity. */
        const bc = ent.bc;
        if (bc) {
            if (bc.role === 'source' && Number.isFinite(bc.sourceMW) && bc.sourceMW > 0) {
                const totalW = bc.sourceMW * 1e-3;
                const cellArea = dxUm * 1e-6 * dyUm * 1e-6;
                const cellVol = cellArea * tzM;
                const Qcell = totalW / Math.max(1, cells.length) / cellVol;
                for (const p of cells) sourceQwPerM3[p] = Qcell;
            } else if (bc.role === 'dirichlet' && Number.isFinite(bc.fixedTC)) {
                const Tk = bc.fixedTC + 273.15;
                for (const p of cells) {
                    pinTMask[p] = 1;
                    pinTValueK[p] = Tk;
                }
            }
            if (Number.isFinite(bc.initialTC)) {
                const Tk = bc.initialTC + 273.15;
                for (const p of cells) {
                    initialTMask[p] = 1;
                    initialTValueK[p] = Tk;
                }
            }
        }
    }

    return {
        materialIdx,
        heaterMask,
        sourceQwPerM3,
        pinTMask,
        pinTValueK,
        initialTMask,
        initialTValueK,
        dxUm,
    };
}

/** Convenience: integer count of cells flagged in a Uint8 mask. */
export function countMaskCells(mask) {
    let c = 0;
    for (let p = 0; p < mask.length; p++) if (mask[p]) c++;
    return c;
}

/** Reverse lookup: cell at (i,j) → material display name (for inspector tooltips). */
export function cellMaterialName(materialIdx, Nx, i, j) {
    const idx = materialIdx[j * Nx + i];
    return THERMAL_MATERIAL_IDS[idx] ?? 'air';
}
