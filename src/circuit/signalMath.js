/**
 * Client-side derived traces (e.g. V(a) − V(b)) merged into a run result for plotting.
 */

function derivedName(sigA, sigB, op) {
    if (op === 'minus') return `${sigA.name} − ${sigB.name}`;
    if (op === 'plus') return `${sigA.name} + ${sigB.name}`;
    return `${sigA.name} × ${sigB.name}`;
}

export function mergeDerivedSignals(result, traceMath) {
    if (!result?.signals?.length || !traceMath?.enabled) return result;
    const sigA = result.signals.find((s) => s.name === traceMath.sigA);
    const sigB = result.signals.find((s) => s.name === traceMath.sigB);
    if (!sigA || !sigB || sigA.kind !== sigB.kind) return result;
    if (sigA.yMode === 'noiseV2' || sigB.yMode === 'noiseV2') return result;
    const op = traceMath.op === 'plus' ? 'plus' : (traceMath.op === 'times' ? 'times' : 'minus');
    const sign = op === 'plus' ? 1 : -1;
    const name = derivedName(sigA, sigB, op);

    if (sigA.kind === 'tran' && sigA.t?.length === sigB.t?.length) {
        const y = sigA.t.map((_, i) => (
            op === 'times' ? sigA.y[i] * sigB.y[i] : sigA.y[i] + sign * sigB.y[i]
        ));
        return {
            ...result,
            signals: [...result.signals, { name, kind: 'tran', t: sigA.t, y, derived: true }],
        };
    }

    if (sigA.kind === 'ac' && sigA.f?.length === sigB.f?.length) {
        const RAD = Math.PI / 180;
        const n = sigA.f.length;
        const mag = new Float64Array(n);
        const phase = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let re;
            let im;
            if (op === 'times') {
                const aRe = sigA.mag[i] * Math.cos(sigA.phase[i] * RAD);
                const aIm = sigA.mag[i] * Math.sin(sigA.phase[i] * RAD);
                const bRe = sigB.mag[i] * Math.cos(sigB.phase[i] * RAD);
                const bIm = sigB.mag[i] * Math.sin(sigB.phase[i] * RAD);
                re = aRe * bRe - aIm * bIm;
                im = aRe * bIm + aIm * bRe;
            } else {
                re = sigA.mag[i] * Math.cos(sigA.phase[i] * RAD) + sign * sigB.mag[i] * Math.cos(sigB.phase[i] * RAD);
                im = sigA.mag[i] * Math.sin(sigA.phase[i] * RAD) + sign * sigB.mag[i] * Math.sin(sigB.phase[i] * RAD);
            }
            mag[i] = Math.hypot(re, im);
            phase[i] = Math.atan2(im, re) * 180 / Math.PI;
        }
        return {
            ...result,
            signals: [...result.signals, {
                name, kind: 'ac', f: sigA.f, mag, phase, derived: true,
            }],
        };
    }

    if (sigA.kind === 'dc' && sigA.x?.length === sigB.x?.length) {
        const y = sigA.x.map((_, i) => (
            op === 'times' ? sigA.y[i] * sigB.y[i] : sigA.y[i] + sign * sigB.y[i]
        ));
        return {
            ...result,
            signals: [...result.signals, {
                name, kind: 'dc', x: sigA.x, y, derived: true,
            }],
        };
    }

    return result;
}

/** Strip ` @R1=1k` style suffix from stepped traces. */
export function stripStepSuffix(name) {
    return String(name).replace(/\s+@.+$/, '');
}

/** If `name` is `V(node)` or `onoise V(node)`, return `node` (after optional step suffix). */
export function voltageProbeNetFromSignalName(name) {
    const base = stripStepSuffix(name);
    const on = /^onoise\s+V\(([^)]+)\)/i.exec(base);
    if (on) return on[1].trim();
    const m = /^V\(([^)]+)\)/i.exec(base);
    return m ? m[1].trim() : null;
}

/** First `V(node)` signal matching `netName` (case-insensitive), or null. */
export function findVoltageSignalForNet(signals, netName) {
    if (!signals?.length || !netName) return null;
    const want = String(netName).trim().toLowerCase();
    if (!want) return null;
    const candidates = signals.filter((s) => {
        const n = voltageProbeNetFromSignalName(s.name);
        return n && n.toLowerCase() === want;
    });
    if (candidates.length === 0) return null;
    const noStep = candidates.find((s) => !/\s+@/.test(s.name));
    return noStep || candidates[0];
}
