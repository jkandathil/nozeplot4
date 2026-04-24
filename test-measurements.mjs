import {
    steadyStateEst, peakToPeak, riseTime, fallTime, settlingTime, overshoot,
    corner3dB, peakGain, unityGainFreq, phaseMargin, gainMargin, sampleAt,
} from './src/circuit/measurements.js';

function assertClose(label, got, want, tol = 0.05, absTol = 0) {
    const relOk = Math.abs(got - want) <= tol * Math.max(1e-9, Math.abs(want));
    const absOk = absTol > 0 && Math.abs(got - want) <= absTol;
    const ok = relOk || absOk;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}: got ${got.toPrecision(4)}, want ${want.toPrecision(4)}`);
    if (!ok) process.exitCode = 1;
}
function assertNaN(label, got) {
    const ok = Number.isNaN(got);
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}: got ${got} (expected NaN)`);
    if (!ok) process.exitCode = 1;
}

// --- Transient: simple RC step response ---
// y(t) = 1 - exp(-t/tau), tau = 1 ms
{
    const tau = 1e-3;
    const T = 10e-3;
    const N = 2001;
    const t = new Array(N); const y = new Array(N);
    for (let i = 0; i < N; i++) {
        t[i] = i * T / (N - 1);
        y[i] = 1 - Math.exp(-t[i] / tau);
    }
    console.log('RC step (tau=1ms):');
    assertClose('steady-state', steadyStateEst(y), 1.0, 0.01);
    assertClose('peak-to-peak', peakToPeak(y), 1.0, 0.01);
    // theoretical rise-time: tau * ln(9) ≈ 2.197 ms
    assertClose('rise time', riseTime(t, y), tau * Math.log(9), 0.02);
    assertClose('settling 5%', settlingTime(t, y, 0.05), -tau * Math.log(0.05), 0.05);
    assertClose('overshoot', overshoot(y), 0, 0.05, 0.5);
}

// --- Transient: second-order underdamped step response ---
// y(t) = 1 - exp(-ζωn t) * [cos(ωd t) + (ζ/√(1-ζ²)) sin(ωd t)]
// ζ=0.3, ωn=2π·1000
{
    const zeta = 0.3;
    const wn = 2 * Math.PI * 1000;
    const wd = wn * Math.sqrt(1 - zeta * zeta);
    const T = 5e-3;
    const N = 2001;
    const t = new Array(N); const y = new Array(N);
    for (let i = 0; i < N; i++) {
        t[i] = i * T / (N - 1);
        const tt = t[i];
        y[i] = 1 - Math.exp(-zeta * wn * tt) * (Math.cos(wd * tt) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * tt));
    }
    console.log('2nd-order underdamped (zeta=0.3):');
    // Theoretical overshoot: exp(-πζ/√(1-ζ²)) · 100%
    const theoryOS = Math.exp(-Math.PI * zeta / Math.sqrt(1 - zeta * zeta)) * 100;
    assertClose('overshoot %', overshoot(y), theoryOS, 0.05);
    assertClose('steady-state', steadyStateEst(y), 1.0, 0.02);
}

// --- AC: single-pole low-pass, pole at 1 kHz ---
// |H(f)| = 1 / sqrt(1 + (f/fp)^2), phase = -atan(f/fp)
{
    const fp = 1000;
    const N = 201;
    const f = new Array(N); const mag = new Array(N); const phase = new Array(N);
    for (let i = 0; i < N; i++) {
        f[i] = Math.pow(10, 1 + 4 * i / (N - 1));
        const r = f[i] / fp;
        mag[i] = 1 / Math.sqrt(1 + r * r);
        phase[i] = -Math.atan(r) * 180 / Math.PI;
    }
    console.log('1st-order LPF (fp=1kHz):');
    assertClose('-3 dB corner', corner3dB(f, mag), fp, 0.05);
    assertClose('peak gain (dB)', peakGain(mag), 0, 0.1, 0.05);
    // Unity gain crosses near DC so no unity freq within range; returns NaN.
    assertNaN('unity-gain freq', unityGainFreq(f, mag));
}

// --- AC: opamp open-loop two-pole; expect phase margin ≈ 45° ---
// H(s) = A0 / ((1+s/ω1)(1+s/ω2)), A0=10^5, ω1=10 rad/s, ω2=2π·1M
{
    const A0 = 1e5;
    const w1 = 10;
    const w2 = 2 * Math.PI * 1e6;
    const N = 801;
    const f = new Array(N); const mag = new Array(N); const phase = new Array(N);
    for (let i = 0; i < N; i++) {
        f[i] = Math.pow(10, -1 + 9 * i / (N - 1));
        const w = 2 * Math.PI * f[i];
        const m = A0 / Math.sqrt((1 + (w / w1) ** 2) * (1 + (w / w2) ** 2));
        const p = -(Math.atan(w / w1) + Math.atan(w / w2)) * 180 / Math.PI;
        mag[i] = m;
        phase[i] = p;
    }
    console.log('Two-pole amp (A0=1e5, p1≈1.6Hz, p2=1MHz):');
    const fug = unityGainFreq(f, mag);
    // GBW = A0 · p1 = 1e5 · (10 / 2π) ≈ 159 kHz
    assertClose('unity-gain freq (Hz)', fug, A0 * (w1 / (2 * Math.PI)), 0.05);
    const pm = phaseMargin(f, mag, phase);
    console.log(`  INFO  phase margin: ${pm.toFixed(1)}°  (unity-gain ~160 kHz, p2=1MHz → PM ~80°)`);
}

// --- sampleAt sanity ---
{
    const x = [0, 1, 2, 3];
    const y = [0, 10, 20, 30];
    console.log('sampleAt:');
    assertClose('mid-bucket 1.5', sampleAt(x, y, 1.5), 15, 1e-9);
    assertClose('on node 2', sampleAt(x, y, 2), 20, 1e-9);
    assertClose('left clip', sampleAt(x, y, -5), 0, 1e-9);
    assertClose('right clip', sampleAt(x, y, 99), 30, 1e-9);
}

console.log('\nDone.');
