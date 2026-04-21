/**
 * Gas property presets at 25 °C, 1 atm. Density in kg/m³, dynamic
 * viscosity in Pa·s. Kinematic viscosity ν = μ/ρ in m²/s.
 *
 * Sources: NIST WebBook; all values rounded to 3 s.f. We keep the
 * preset list short and practical — users doing aroma / breath work
 * rarely need more than this. A "custom" entry lets the user type
 * their own (ρ, μ) pair if they're simulating humid breath, a
 * solvent-laden stream, etc.
 */
export const GAS_PRESETS = [
    { id: 'air',  label: 'Air (25 °C, 1 atm)',      rho: 1.184,  mu: 1.849e-5 },
    { id: 'n2',   label: 'Nitrogen (25 °C)',        rho: 1.145,  mu: 1.781e-5 },
    { id: 'o2',   label: 'Oxygen (25 °C)',          rho: 1.308,  mu: 2.066e-5 },
    { id: 'co2',  label: 'CO₂ (25 °C)',             rho: 1.808,  mu: 1.490e-5 },
    { id: 'ar',   label: 'Argon (25 °C)',           rho: 1.635,  mu: 2.260e-5 },
    { id: 'he',   label: 'Helium (25 °C)',          rho: 0.164,  mu: 1.990e-5 },
    { id: 'breath', label: 'Humid breath (34 °C, ~80% RH)', rho: 1.130, mu: 1.870e-5 },
];

export function gasById(id) {
    return GAS_PRESETS.find((g) => g.id === id) || GAS_PRESETS[0];
}

/** Kinematic viscosity (m²/s). */
export function nu(gas) {
    return gas.mu / gas.rho;
}

/** Reynolds number. U_m_s in m/s, L_mm in mm. */
export function reynolds(gas, U_m_s, L_mm) {
    const L_m = L_mm * 1e-3;
    return (U_m_s * L_m) / nu(gas);
}
