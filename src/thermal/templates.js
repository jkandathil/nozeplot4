/**
 * Geometry templates for the thermal studio. Each template paints a material
 * grid + heater mask suitable for a typical MEMS hotplate device.
 *
 * Coordinates are in cells. Conventions:
 *   - (i, j) = (column, row), origin top-left of the canvas.
 *   - frame is the outer Si rim that sinks heat to ambient.
 *   - membrane is the suspended dielectric (Si3N4 or SiO2/Si3N4 stack).
 *   - heater is the resistive metal trace generating Joule heat.
 */

import { THERMAL_MATERIAL_IDS, materialIndex } from './materials.js';

/** @returns {Uint8Array} */
function fillIdx(N, materialId) {
    const a = new Uint8Array(N);
    a.fill(materialIndex(materialId));
    return a;
}

/** Fill rect [i0,j0)..[i1,j1) on the materialIdx grid with `materialId`. */
function paintRect(grid, Nx, i0, j0, i1, j1, materialId) {
    const idx = materialIndex(materialId);
    const ii0 = Math.max(0, i0 | 0);
    const jj0 = Math.max(0, j0 | 0);
    const ii1 = Math.min(Nx, i1 | 0);
    const jj1 = Math.min(grid.length / Nx, j1 | 0);
    for (let j = jj0; j < jj1; j++) {
        const row = j * Nx;
        for (let i = ii0; i < ii1; i++) grid[row + i] = idx;
    }
}

function setMaskRect(mask, Nx, i0, j0, i1, j1, value) {
    const ii0 = Math.max(0, i0 | 0);
    const jj0 = Math.max(0, j0 | 0);
    const ii1 = Math.min(Nx, i1 | 0);
    const jj1 = Math.min(mask.length / Nx, j1 | 0);
    for (let j = jj0; j < jj1; j++) {
        const row = j * Nx;
        for (let i = ii0; i < ii1; i++) mask[row + i] = value;
    }
}

/**
 * Membrane micro-hotplate template:
 *   - Si frame on the outer 4 cells (sinks heat to ambient via Dirichlet on edge).
 *   - Si3N4 membrane fills the middle.
 *   - Pt meander heater snakes across the centre.
 *
 * @param {number} Nx
 * @param {number} Ny
 * @returns {{ materialIdx: Uint8Array, heaterMask: Uint8Array }}
 */
export function membraneHotplateTemplate(Nx, Ny) {
    const N = Nx * Ny;
    const materialIdx = fillIdx(N, 'air');
    const heaterMask = new Uint8Array(N);

    /* Si frame (outer ring, ~12% of grid). */
    const frame = Math.max(2, Math.round(Math.min(Nx, Ny) * 0.12));
    paintRect(materialIdx, Nx, 0, 0, Nx, Ny, 'silicon');

    /* Si3N4 membrane. */
    paintRect(materialIdx, Nx, frame, frame, Nx - frame, Ny - frame, 'si3n4');

    /* Pt meander heater — 4 horizontal arms connected at alternating ends.
       Trace width ≈ 4 cells; arms occupy the central 60% of the membrane. */
    const cx0 = Math.floor(Nx * 0.25);
    const cx1 = Math.ceil(Nx * 0.75);
    const cy0 = Math.floor(Ny * 0.32);
    const cy1 = Math.ceil(Ny * 0.68);
    const arms = 4;
    const traceW = Math.max(2, Math.round(Math.min(Nx, Ny) / 30));
    const span = cy1 - cy0;
    for (let a = 0; a < arms; a++) {
        const yc = Math.round(cy0 + ((a + 0.5) * span) / arms);
        const ys = yc - Math.floor(traceW / 2);
        const ye = ys + traceW;
        paintRect(materialIdx, Nx, cx0, ys, cx1, ye, 'platinum');
        setMaskRect(heaterMask, Nx, cx0, ys, cx1, ye, 1);
        /* connecting bend on alternating side */
        const bendX = a % 2 === 0 ? cx1 - traceW : cx0;
        const nextYc = a < arms - 1 ? Math.round(cy0 + ((a + 1.5) * span) / arms) : null;
        if (nextYc !== null) {
            const j0 = Math.min(yc, nextYc);
            const j1 = Math.max(yc, nextYc) + traceW;
            paintRect(materialIdx, Nx, bendX, j0, bendX + traceW, j1, 'platinum');
            setMaskRect(heaterMask, Nx, bendX, j0, bendX + traceW, j1, 1);
        }
    }

    /* Bond pads on left + right frame edge (so user sees they exist). */
    const padW = Math.max(3, Math.round(Math.min(Nx, Ny) / 18));
    paintRect(materialIdx, Nx, 0, Math.floor(Ny * 0.45), padW, Math.floor(Ny * 0.55), 'gold');
    paintRect(materialIdx, Nx, Nx - padW, Math.floor(Ny * 0.45), Nx, Math.floor(Ny * 0.55), 'gold');

    return { materialIdx, heaterMask };
}

/**
 * Disk hotplate template — circular membrane with a spiral heater.
 *
 * @param {number} Nx
 * @param {number} Ny
 * @returns {{ materialIdx: Uint8Array, heaterMask: Uint8Array }}
 */
export function diskHotplateTemplate(Nx, Ny) {
    const N = Nx * Ny;
    const materialIdx = fillIdx(N, 'silicon');
    const heaterMask = new Uint8Array(N);

    const cx = (Nx - 1) / 2;
    const cy = (Ny - 1) / 2;
    const rMembrane = Math.min(Nx, Ny) * 0.36;
    const rHeaterMin = Math.min(Nx, Ny) * 0.08;
    const rHeaterMax = Math.min(Nx, Ny) * 0.28;
    const traceW = Math.max(1.2, Math.min(Nx, Ny) / 60);

    const niSi3N4 = materialIndex('si3n4');
    const niPt = materialIndex('platinum');

    for (let j = 0; j < Ny; j++) {
        for (let i = 0; i < Nx; i++) {
            const dx = i - cx;
            const dy = j - cy;
            const r = Math.hypot(dx, dy);
            const p = j * Nx + i;
            if (r <= rMembrane) materialIdx[p] = niSi3N4;
        }
    }

    /* Archimedean spiral heater. */
    const turns = 4;
    const samples = 4000;
    for (let s = 0; s < samples; s++) {
        const u = s / (samples - 1);
        const theta = u * turns * Math.PI * 2;
        const r = rHeaterMin + (rHeaterMax - rHeaterMin) * u;
        const x = cx + r * Math.cos(theta);
        const y = cy + r * Math.sin(theta);
        for (let dy = -traceW; dy <= traceW; dy++) {
            for (let dx = -traceW; dx <= traceW; dx++) {
                const i = Math.round(x + dx);
                const j = Math.round(y + dy);
                if (i < 0 || j < 0 || i >= Nx || j >= Ny) continue;
                if (Math.hypot(dx, dy) > traceW) continue;
                const p = j * Nx + i;
                materialIdx[p] = niPt;
                heaterMask[p] = 1;
            }
        }
    }

    return { materialIdx, heaterMask };
}

/** Empty template — Si everywhere (fully clamped). */
export function blankTemplate(Nx, Ny) {
    const materialIdx = fillIdx(Nx * Ny, 'silicon');
    const heaterMask = new Uint8Array(Nx * Ny);
    return { materialIdx, heaterMask };
}

export const THERMAL_TEMPLATES = [
    {
        id: 'membrane',
        label: 'Suspended membrane (Pt meander)',
        description: 'Si frame · Si₃N₄ membrane · platinum meander heater',
        build: membraneHotplateTemplate,
    },
    {
        id: 'disk',
        label: 'Disk hotplate (Pt spiral)',
        description: 'Circular Si₃N₄ disc with a spiral platinum heater',
        build: diskHotplateTemplate,
    },
    {
        id: 'blank',
        label: 'Blank silicon block',
        description: 'Solid Si — paint your own geometry from scratch',
        build: blankTemplate,
    },
];

export const THERMAL_MATERIAL_LIST = THERMAL_MATERIAL_IDS;
