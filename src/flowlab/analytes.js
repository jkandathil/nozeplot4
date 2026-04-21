/**
 * Aroma / volatile analyte preset library.
 *
 * Values are binary gas-phase diffusivities D_AB (m²/s) of each analyte
 * in air at 25 °C, 1 atm. They come from the Chapman-Enskog / Fuller-
 * Schettler-Giddings correlations as tabulated in the usual process-
 * engineering handbooks (Poling, Prausnitz & O'Connell; Perry's); each
 * rounded to ~3 s.f. For many of the heavier volatiles there is some
 * spread in the literature (±10–15 %) — the tabulated value is a
 * reasonable mid-range pick for ballpark device design work.
 *
 * Why this matters for the aroma sensor chip: the Schmidt number
 * Sc = ν / D and Peclet Pe = U·L / D drive the shape and timing of
 * the concentration front that hits the sensor, and the mass-transfer
 * coefficient at the sensor wall. With typical gas viscosities ν ≈
 * 1.5·10⁻⁵ m²/s and these D values, Sc ≈ 1–3 — meaning momentum and
 * species diffuse at comparable rates, a regime where both advection
 * and diffusion matter.
 *
 * M_g is the molar mass in g/mol (only used to let the UI surface a
 * "ppm ↔ mg/m³" hint when the user asks).
 */
export const ANALYTE_PRESETS = [
    { id: 'tracer',     label: 'Passive tracer (normalised)',     D: 2.0e-5, M_g: 29,  note: 'Unitless c/c₀ — use this to see front propagation without picking a real molecule.' },
    { id: 'ethanol',    label: 'Ethanol (C₂H₆O)',                  D: 1.18e-5, M_g: 46.07, note: 'Fermentation / alcoholic beverages.' },
    { id: 'methanol',   label: 'Methanol (CH₄O)',                  D: 1.59e-5, M_g: 32.04 },
    { id: 'acetone',    label: 'Acetone (C₃H₆O)',                  D: 1.09e-5, M_g: 58.08, note: 'Breath biomarker; solvent headspace.' },
    { id: 'acetaldehyde', label: 'Acetaldehyde (C₂H₄O)',           D: 1.24e-5, M_g: 44.05 },
    { id: 'water',      label: 'Water vapour (H₂O)',               D: 2.4e-5,  M_g: 18.02, note: 'Humidity background — useful for breath / food headspace.' },
    { id: 'co2',        label: 'CO₂',                              D: 1.6e-5,  M_g: 44.01 },
    { id: 'nh3',        label: 'Ammonia (NH₃)',                    D: 2.28e-5, M_g: 17.03 },
    { id: 'no',         label: 'Nitric oxide (NO)',                D: 2.00e-5, M_g: 30.01, note: 'Reactive inorganic — low ppb range in breath / combustion; oxidises to NO₂ in humid air.' },
    { id: 'no2',        label: 'Nitrogen dioxide (NO₂)',           D: 1.51e-5, M_g: 46.01, note: 'Reactive inorganic — urban air-quality marker; can form HNO₃ on humid sensor surfaces.' },
    { id: 'limonene',   label: 'Limonene (C₁₀H₁₆) — citrus',       D: 7.0e-6,  M_g: 136.23, note: 'Heavy terpene, slow diffusion — sharp fronts.' },
    { id: 'linalool',   label: 'Linalool (C₁₀H₁₈O) — floral',      D: 6.5e-6,  M_g: 154.25 },
    { id: 'ethyl_acet', label: 'Ethyl acetate (C₄H₈O₂) — fruity',  D: 8.7e-6,  M_g: 88.11 },
    { id: 'isoamyl_ac', label: 'Isoamyl acetate (C₇H₁₄O₂) — banana', D: 6.8e-6, M_g: 130.19 },
    { id: 'hexanal',    label: 'Hexanal (C₆H₁₂O) — green / grass', D: 7.3e-6,  M_g: 100.16 },
    { id: '2-pentanone', label: '2-Pentanone (C₅H₁₀O)',            D: 8.3e-6,  M_g: 86.13 },
    { id: 'diacetyl',   label: 'Diacetyl (C₄H₆O₂) — butter',       D: 9.4e-6,  M_g: 86.09 },
    { id: 'dms',        label: 'DMS (C₂H₆S) — malty',              D: 1.20e-5, M_g: 62.13 },
    { id: 'pyrazine',   label: 'Pyrazine (C₄H₄N₂) — nutty/roasted', D: 9.6e-6, M_g: 80.09 },
    { id: 'custom',     label: 'Custom…',                          D: 1.0e-5, M_g: 50 },
];

export function analyteById(id) {
    return ANALYTE_PRESETS.find((a) => a.id === id) || ANALYTE_PRESETS[0];
}

/** Reference state for the tabulated diffusivities. */
export const T_REF_K = 298.15;      // 25 °C
export const P_REF_ATM = 1.0;

/**
 * Apply Fuller-Schettler-Giddings temperature / pressure scaling to a
 * reference binary gas-phase diffusivity:
 *
 *   D(T, P) = D_ref · (T / T_ref)^1.75 · (P_ref / P)
 *
 * Accurate to a few percent across 0–80 °C for all the species in the
 * preset library. Humidity has a second-order effect (< ~2 % for most
 * VOCs in moist air) and is ignored here — we surface it separately as
 * a metadata field so the user can record experimental conditions and
 * reason about surface chemistry (e.g. NO₂ + H₂O → HNO₃).
 */
export function correctedDiffusivity(D_ref_m2s, T_C = 25, P_atm = 1) {
    if (!Number.isFinite(D_ref_m2s) || D_ref_m2s <= 0) return NaN;
    const T_K = Math.max(1, 273.15 + T_C);
    const P = Math.max(1e-6, P_atm);
    return D_ref_m2s * Math.pow(T_K / T_REF_K, 1.75) * (P_REF_ATM / P);
}

/**
 * Very-small humidity correction for the kinematic viscosity of air at
 * atmospheric pressure. Provided for completeness — the solver
 * currently ignores it (carrier gas ν is taken from the gas preset),
 * but the helper is handy for UI hints and future extension.
 *
 * Antoine-style saturation pressure (Tetens) → mole fraction of water
 * → linear mix of ν_dry_air and ν_water_vapour.
 */
export function humidAirKinematicViscosity(T_C = 25, RH_pct = 0, P_atm = 1) {
    const T_K = 273.15 + T_C;
    const p_sat_Pa = 610.78 * Math.exp((17.27 * T_C) / (T_C + 237.3));
    const p_w_Pa = Math.max(0, Math.min(1, RH_pct / 100)) * p_sat_Pa;
    const P_Pa = P_atm * 101325;
    const x_w = Math.max(0, Math.min(0.06, p_w_Pa / P_Pa));
    const nu_dry = 1.516e-5 * Math.pow(T_K / T_REF_K, 1.5);
    const nu_wv = 1.0e-5 * Math.pow(T_K / T_REF_K, 1.5);
    return (1 - x_w) * nu_dry + x_w * nu_wv;
}

/** Schmidt number Sc = ν / D. `nu_m2s` from gases.nu, `D_m2s` from this table. */
export function schmidt(nu_m2s, D_m2s) {
    if (!D_m2s || D_m2s <= 0) return NaN;
    return nu_m2s / D_m2s;
}

/** Peclet number Pe = U·L / D. U in m/s, L in mm (to match the rest of the app). */
export function peclet(U_m_s, L_mm, D_m2s) {
    if (!D_m2s || D_m2s <= 0) return NaN;
    const L_m = L_mm * 1e-3;
    return (U_m_s * L_m) / D_m2s;
}

/** Characteristic diffusion time τ_diff = L² / D  (seconds). */
export function diffusionTime_s(L_mm, D_m2s) {
    if (!D_m2s || D_m2s <= 0) return NaN;
    const L_m = L_mm * 1e-3;
    return (L_m * L_m) / D_m2s;
}

/* ───────── Inlet pulse profiles ─────────
 * Each profile is a function of (t, params) that returns a concentration
 * value in [0, 1] (normalised — the user's "Inlet c₀" just scales this).
 * Keep them cheap: evalPulse is invoked once per LBM sub-step inside
 * the worker (same scalar for every inlet cell — no per-cell cost).
 */
export const PULSE_PROFILES = [
    {
        id: 'step',
        label: 'Step (constant from t=0)',
        params: [],
        eval: (t /* s */) => (t >= 0 ? 1 : 0),
        description: 'Concentration switches to 1 at t=0 and stays there. The classic washout / breakthrough curve.',
    },
    {
        id: 'rect',
        label: 'Rectangular pulse',
        params: [
            /* Defaults chosen for a typical 1 cm chamber at ~1 cm/s, giving
               roughly one residence time of exposure (τ_flow ≈ 1 s) after
               a short 0.2 s flow-development pre-roll. Users pressed for
               impulse tests can shorten `t_dur` back to 0.2 s; users doing
               breakthrough / steady-state tests can lengthen it further. */
            { id: 't_start', label: 'start (s)', default: 0.2, step: 0.01, min: 0 },
            { id: 't_dur', label: 'duration (s)', default: 1.0, step: 0.1, min: 0.0001 },
        ],
        eval: (t, p) => (t >= p.t_start && t <= p.t_start + p.t_dur ? 1 : 0),
        description: 'A rectangular slug of analyte — good for impulse / residence-time tests.',
    },
    {
        id: 'gauss',
        label: 'Gaussian pulse',
        params: [
            { id: 'mu', label: 'centre (s)', default: 0.2, step: 0.01, min: 0 },
            { id: 'sigma', label: 'σ (s)', default: 0.05, step: 0.005, min: 0.001 },
        ],
        eval: (t, p) => {
            const z = (t - p.mu) / Math.max(1e-12, p.sigma);
            return Math.exp(-0.5 * z * z);
        },
        description: 'Smooth Gaussian injection — realistic for a carefully-controlled bolus.',
    },
    {
        id: 'exp',
        label: 'Exponential decay (vial headspace)',
        params: [
            { id: 't_start', label: 'start (s)', default: 0, step: 0.01, min: 0 },
            { id: 'tau', label: 'τ (s)', default: 0.5, step: 0.05, min: 0.001 },
        ],
        eval: (t, p) => (t >= p.t_start ? Math.exp(-(t - p.t_start) / Math.max(1e-12, p.tau)) : 0),
        description: 'Models a finite vial emptying: concentration starts at 1 and decays with time constant τ.',
    },
    {
        id: 'double',
        label: 'Double step (on / off)',
        params: [
            /* ~1 s open window after a short flow-development pre-roll —
               long enough for a gas-phase chamber (τ_flow ≈ 1 s @ 1 cm,
               1 cm/s) to reach quasi-steady before the inlet is shut. */
            { id: 't_on', label: 'on (s)', default: 0.2, step: 0.01, min: 0 },
            { id: 't_off', label: 'off (s)', default: 1.2, step: 0.1, min: 0.0001 },
        ],
        eval: (t, p) => (t >= p.t_on && t < p.t_off ? 1 : 0),
        description: 'Open the inlet at t_on, close it at t_off — classical sensor recovery study.',
    },
];

export function pulseProfileById(id) {
    return PULSE_PROFILES.find((p) => p.id === id) || PULSE_PROFILES[0];
}

/** Return the current inlet concentration for profile `id` at sim time t. */
export function evalPulse(id, params, t_s) {
    const prof = pulseProfileById(id);
    const safeParams = { ...Object.fromEntries(prof.params.map((p) => [p.id, p.default])), ...(params || {}) };
    return prof.eval(t_s, safeParams);
}
