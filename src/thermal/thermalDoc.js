/**
 * Thermal Studio project document — JSON round-trip for save / load.
 *
 * A project captures everything needed to reproduce a simulation:
 *   - domain (canvas size, grid resolution, membrane thickness),
 *   - physics (ambient T, top/bottom convection),
 *   - simulation mode (pure 'thermal' vs 'electrothermal'),
 *   - electrical drive parameters (V/I/P, R₀, α, T_ref, P_max, trace width),
 *   - entities[] — vector CAD geometry with material + boundary-condition
 *                  metadata (heat source, fixed T, initial T, heater flag).
 *
 * Entities are exactly the same shape as in-memory CAD objects, so a save
 * is just `JSON.stringify(entities)` plus the wrapper.
 */

export const THERMAL_DOC_SCHEMA = 'thermallab.v1';
export const THERMAL_DOC_VERSION = 1;

/** @returns {object} a fresh empty project. */
export function newThermalDoc(opts = {}) {
    const now = new Date().toISOString();
    return {
        schema: THERMAL_DOC_SCHEMA,
        version: THERMAL_DOC_VERSION,
        name: opts.name || 'untitled',
        description: '',
        createdAt: now,
        updatedAt: now,
        domain: {
            domainUm: opts.domainUm ?? 1000,
            Nx: opts.Nx ?? 100,
            Ny: opts.Ny ?? 100,
            thicknessUm: opts.thicknessUm ?? 1.0,
        },
        physics: {
            ambientC: opts.ambientC ?? 25,
            hTop: opts.hTop ?? 10,
            hBot: opts.hBot ?? 10,
        },
        simulation: {
            mode: opts.simulationMode || 'thermal', // 'thermal' | 'electrothermal'
        },
        drive: {
            mode: 'P', // 'V' | 'I' | 'P'
            value: 30, // V (V), mA (I), mW (P)
            refC: 25,
            R0Override: null,
            tcrOverride: null,
            traceWidthUm: 20,
            maxPowerMW: null,
        },
        entities: [],
    };
}

/** Sniff test for a thermal-studio document loaded from workspace. */
export function isThermalDoc(data) {
    if (!data || typeof data !== 'object') return false;
    if (data.schema !== THERMAL_DOC_SCHEMA) return false;
    return Array.isArray(data.entities);
}

/** Forward-compatible migrator (kept simple — no breaking changes yet). */
export function migrateThermalDoc(data) {
    if (!isThermalDoc(data)) return null;
    /* Backfill any missing top-level keys so older saves still round-trip
       through newer code that reads `doc.simulation.mode` etc. */
    const fresh = newThermalDoc();
    return {
        ...fresh,
        ...data,
        domain: { ...fresh.domain, ...(data.domain || {}) },
        physics: { ...fresh.physics, ...(data.physics || {}) },
        simulation: { ...fresh.simulation, ...(data.simulation || {}) },
        drive: { ...fresh.drive, ...(data.drive || {}) },
        entities: Array.isArray(data.entities) ? data.entities : [],
    };
}

/**
 * Pack the live UI state into a JSON-serialisable doc.
 *
 * @param {{
 *   name?: string,
 *   description?: string,
 *   domainUm: number, Nx: number, Ny: number, thicknessUm: number,
 *   ambientC: number, hTop: number, hBot: number,
 *   simulationMode: 'thermal'|'electrothermal',
 *   drive: object,
 *   entities: object[],
 *   createdAt?: string,
 * }} state
 */
export function serializeThermalDoc(state) {
    const now = new Date().toISOString();
    return {
        schema: THERMAL_DOC_SCHEMA,
        version: THERMAL_DOC_VERSION,
        name: state.name || 'untitled',
        description: state.description || '',
        createdAt: state.createdAt || now,
        updatedAt: now,
        domain: {
            domainUm: state.domainUm,
            Nx: state.Nx,
            Ny: state.Ny,
            thicknessUm: state.thicknessUm,
        },
        physics: {
            ambientC: state.ambientC,
            hTop: state.hTop,
            hBot: state.hBot,
        },
        simulation: {
            mode: state.simulationMode || 'thermal',
        },
        drive: state.drive || {},
        entities: state.entities || [],
    };
}

/** Sanitise a filename component → "{base}{suffix}". */
export function thermalDocFileName(name) {
    const trimmed = (name || 'untitled').trim();
    const cleaned = trimmed.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'untitled';
    return `${cleaned}.thermal.json`;
}
