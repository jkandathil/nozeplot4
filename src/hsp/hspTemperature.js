/**
 * Temperature correction for Hansen solubility parameters.
 * Hansen handbook: δ components scale with thermal expansion of cohesion energy.
 */

const T_REF = 25; /* °C */

/**
 * Scale HSP triplet from T_ref to T_target using simplified Hansen thermal model.
 * δ(T) ≈ δ(T_ref) · √(1 − α_v · (T − T_ref)), α_v ≈ 0.001 K⁻¹ typical.
 *
 * @param {{ dD:number, dP:number, dH:number }} hsp
 * @param {number} T_targetC
 * @param {{ T_refC?: number, alphaV?: number }} [opts]
 */
export function correctHspAtTemperature(hsp, T_targetC, opts = {}) {
    const Tref = opts.T_refC ?? T_REF;
    const alpha = opts.alphaV ?? 0.001;
    const dT = Number(T_targetC) - Tref;
    const factor = Math.sqrt(Math.max(0.5, 1 - alpha * dT));
    return {
        dD: (hsp.dD ?? 0) * factor,
        dP: (hsp.dP ?? 0) * factor,
        dH: (hsp.dH ?? 0) * factor,
        factor,
        T_refC: Tref,
        T_targetC: Number(T_targetC),
    };
}

/** Apply temperature correction to a sphere (centre + radii scale equally). */
export function correctSphereAtTemperature(sphere, T_targetC, opts = {}) {
    const c = correctHspAtTemperature(
        { dD: sphere.dD, dP: sphere.dP, dH: sphere.dH },
        T_targetC,
        opts
    );
    const f = c.factor;
    return {
        ...sphere,
        dD: c.dD,
        dP: c.dP,
        dH: c.dH,
        R: (sphere.R ?? 8) * f,
        R_inner: sphere.R_inner != null ? sphere.R_inner * f : undefined,
        R_outer: sphere.R_outer != null ? sphere.R_outer * f : undefined,
        _T_corrected: T_targetC,
    };
}
