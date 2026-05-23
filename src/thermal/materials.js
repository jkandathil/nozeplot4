/**
 * Material library for the MEMS thermal simulator.
 *
 * Properties are bulk values at room temperature (T ≈ 300 K). Real thin films
 * deviate (e.g. SiO2 thermal-grown vs deposited can vary by ±30%); we keep
 * a single canonical value per material so designs are reproducible. Heater
 * materials carry an extra `tcrPerK` (temperature coefficient of resistance)
 * for hotplate work, even though the solver itself does not currently feed
 * that back into Joule heating self-consistency.
 *
 * `kind` drives palette grouping / icons; `color` drives the layer paint
 * swatches and is independent of the temperature colormap.
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   kWmK: number,        thermal conductivity [W/(m·K)]
 *   rhoKgM3: number,     density [kg/m³]
 *   cJkgK: number,       specific heat capacity [J/(kg·K)]
 *   color: string,       hex swatch
 *   kind: 'void'|'gas'|'substrate'|'dielectric'|'metal'|'heater',
 *   tcrPerK?: number,    temperature coefficient of resistance [1/K]
 *   rhoElecOhmM?: number, electrical resistivity [Ω·m]; insulators set ≥ 1e10
 * }} ThermalMaterial
 */

/** @type {Record<string, ThermalMaterial>} */
export const THERMAL_MATERIALS = {
    void: {
        id: 'void',
        name: 'Void / hole',
        kWmK: 0,
        rhoKgM3: 1,
        cJkgK: 1,
        color: '#0f172a',
        kind: 'void',
        rhoElecOhmM: 1e16,
    },
    air: {
        id: 'air',
        name: 'Air',
        kWmK: 0.026,
        rhoKgM3: 1.225,
        cJkgK: 1005,
        color: '#1e3a5f',
        kind: 'gas',
        rhoElecOhmM: 1e16,
    },
    silicon: {
        id: 'silicon',
        name: 'Silicon (Si, intrinsic)',
        kWmK: 148,
        rhoKgM3: 2330,
        cJkgK: 712,
        color: '#475569',
        kind: 'substrate',
        rhoElecOhmM: 2.3e3,
        tcrPerK: -7.5e-3,
    },
    sio2: {
        id: 'sio2',
        name: 'Silicon dioxide (SiO₂)',
        kWmK: 1.4,
        rhoKgM3: 2200,
        cJkgK: 703,
        color: '#7dd3fc',
        kind: 'dielectric',
        rhoElecOhmM: 1e14,
    },
    si3n4: {
        id: 'si3n4',
        name: 'Silicon nitride (Si₃N₄)',
        kWmK: 20,
        rhoKgM3: 3290,
        cJkgK: 691,
        color: '#a78bfa',
        kind: 'dielectric',
        rhoElecOhmM: 1e14,
    },
    polysi: {
        id: 'polysi',
        name: 'Poly-silicon (doped heater)',
        kWmK: 34,
        rhoKgM3: 2330,
        cJkgK: 678,
        color: '#fbbf24',
        kind: 'heater',
        tcrPerK: 1.2e-3,
        rhoElecOhmM: 5e-4,
    },
    platinum: {
        id: 'platinum',
        name: 'Platinum (Pt heater)',
        kWmK: 71.6,
        rhoKgM3: 21450,
        cJkgK: 133,
        color: '#f87171',
        kind: 'heater',
        tcrPerK: 3.92e-3,
        rhoElecOhmM: 1.06e-7,
    },
    aluminum: {
        id: 'aluminum',
        name: 'Aluminum',
        kWmK: 237,
        rhoKgM3: 2700,
        cJkgK: 897,
        color: '#cbd5e1',
        kind: 'metal',
        rhoElecOhmM: 2.82e-8,
        tcrPerK: 4.29e-3,
    },
    gold: {
        id: 'gold',
        name: 'Gold (Au)',
        kWmK: 318,
        rhoKgM3: 19320,
        cJkgK: 129,
        color: '#fde68a',
        kind: 'metal',
        rhoElecOhmM: 2.44e-8,
        tcrPerK: 3.40e-3,
    },
    titanium: {
        id: 'titanium',
        name: 'Titanium (Ti)',
        kWmK: 21.9,
        rhoKgM3: 4506,
        cJkgK: 523,
        color: '#94a3b8',
        kind: 'metal',
        rhoElecOhmM: 4.20e-7,
        tcrPerK: 3.8e-3,
    },
    tungsten: {
        id: 'tungsten',
        name: 'Tungsten (W heater)',
        kWmK: 173,
        rhoKgM3: 19250,
        cJkgK: 132,
        color: '#fb923c',
        kind: 'heater',
        tcrPerK: 4.5e-3,
        rhoElecOhmM: 5.60e-8,
    },
};

/** Indexable order — Uint8 grid stores indices into this list. */
export const THERMAL_MATERIAL_IDS = Object.keys(THERMAL_MATERIALS);

/** Stable index lookup; default to 'air' when out of range. */
export function materialIndex(id) {
    const i = THERMAL_MATERIAL_IDS.indexOf(id);
    return i < 0 ? THERMAL_MATERIAL_IDS.indexOf('air') : i;
}

/** @param {number} idx */
export function materialPropsByIndex(idx) {
    const id = THERMAL_MATERIAL_IDS[idx] ?? 'air';
    return THERMAL_MATERIALS[id];
}

/** Heater-kind materials (for distinguishing heater regions in the painter). */
export function isHeaterMaterialIndex(idx) {
    const m = materialPropsByIndex(idx);
    return m?.kind === 'heater';
}
