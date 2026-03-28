/**
 * Binary polymer + carbon black: ideal volume additivity (no excess volume).
 * ρ in g/cm³. wt% CB is mass of CB / total composite mass × 100.
 */

export function wtPercentCbToVolumeFraction(wtCbPercent, rhoCbGcm3, rhoPolymerGcm3) {
    const w = Math.max(0, Math.min(100, Number(wtCbPercent))) / 100;
    const rhoC = Number(rhoCbGcm3);
    const rhoP = Number(rhoPolymerGcm3);
    if (!(rhoC > 0) || !(rhoP > 0)) return null;

    if (w <= 0) {
        return { phiCb: 0, phiPolymer: 1, phr: 0, volPercentCb: 0 };
    }
    if (w >= 1) {
        return { phiCb: 1, phiPolymer: 0, phr: Infinity, volPercentCb: 100 };
    }

    const wp = 1 - w;
    const vCb = w / rhoC;
    const vP = wp / rhoP;
    const sum = vCb + vP;
    const phiCb = sum > 0 ? vCb / sum : 0;
    const phr = wp > 0 ? (100 * w) / wp : Infinity;

    return {
        phiCb,
        phiPolymer: 1 - phiCb,
        phr,
        volPercentCb: 100 * phiCb,
    };
}

/** Inverse: target volume % CB → mass % CB */
export function volPercentCbToWtPercent(volCbPercent, rhoCbGcm3, rhoPolymerGcm3) {
    const phi = Math.max(0, Math.min(100, Number(volCbPercent))) / 100;
    const rhoC = Number(rhoCbGcm3);
    const rhoP = Number(rhoPolymerGcm3);
    if (!(rhoC > 0) || !(rhoP > 0)) return null;

    if (phi <= 0) return { wtPercentCb: 0, phr: 0 };
    if (phi >= 1) return { wtPercentCb: 100, phr: Infinity };

    const mCb = phi * rhoC;
    const mP = (1 - phi) * rhoP;
    const total = mCb + mP;
    const wtCb = total > 0 ? mCb / total : 0;
    const phr = mP > 0 ? (100 * mCb) / mP : Infinity;

    return { wtPercentCb: 100 * wtCb, phr };
}
