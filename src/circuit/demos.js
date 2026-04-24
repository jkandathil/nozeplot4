/**
 * Pre-built demo netlists for Circuit Studio, Phase 1.
 *
 * Each demo ships with:
 *   - a SPICE netlist the solver runs verbatim
 *   - a short title + description for the home picker
 *   - a guided-tour script (same format as Flow Lab's) that walks
 *     users through the circuit the first time it loads
 *   - a list of "recommended signals" for the plot panel so the user
 *     sees the interesting curves immediately
 *   - an optional postImport(doc) hook that can sprinkle UI-only
 *     parts (SCOPE / VP / IP) onto the imported schematic, since
 *     those don't survive a netlist round-trip.
 */

import { addComponent, componentPins } from './schematicDoc.js';

export const DEMOS = [
    {
        id: 'tia',
        title: 'Photodiode Transimpedance Amplifier',
        tagline: 'Classic gas-sensor optical front-end. Converts photodiode current into voltage.',
        category: 'Sensor front-end',
        netlist: `* Photodiode Transimpedance Amplifier (TIA)
* Classic optical gas-sensor front-end: photodiode current -> voltage
*
* Signal chain: I_pd (photocurrent) flows into the inverting input of
* the op-amp. The op-amp holds n_in at virtual ground, so V_out = -R_f·I_pd.
* Bandwidth is set by R_f · C_f and the op-amp's GBW (we model a finite-
* GBW op-amp as a VCVS + 1-pole rolloff below).

* Photocurrent source: DC bias + AC probe + pulse for transient view.
* 1 µA pulse emulates a brief analyte crossing over the photodiode.
I_pd 0 nin AC 1u PULSE(0 1u 50u 1u 1u 100u 500u)

* Photodiode junction capacitance (forms noise-gain zero with R_f)
C_pd nin 0 10p

* Feedback network: R_f sets transimpedance, C_f tames noise-gain peaking
R_f nin vout 1Meg
C_f nin vout 0.5p

* Finite-GBW op-amp model (A0=100k, f_p=10Hz → GBW=1MHz)
* VCVS with internal single-pole via Rout+Cload on an intermediate node
E_op vtmp 0 0 nin 100000
R_out vtmp vout 1k
C_gbw vout 0 15.9n

.op
.ac dec 20 10 10meg
.tran 1u 500u
.end`,
        defaultAnalysis: 'tran',
        signals: {
            tran: ['V(vout)', 'V(nin)'],
            ac: ['V(vout)'],
            op: ['V(vout)', 'V(nin)'],
        },
        tour: [
            {
                title: 'The photodiode model',
                body: 'I_pd is the photocurrent — a 1 µA pulse lasting 100 µs that represents a photon burst hitting the diode. C_pd is the junction capacitance (~10 pF for a small photodiode).',
            },
            {
                title: 'The feedback network',
                body: 'R_f (1 MΩ) sets the transimpedance: V_out = −R_f · I_pd ≈ −1 V for 1 µA. C_f (0.5 pF) dampens peaking from the noise-gain zero at 1/(2πR_f·C_pd).',
            },
            {
                title: 'The op-amp',
                body: 'Modelled as a VCVS with A₀ = 10⁵ DC gain and a single pole at ~10 Hz (GBW ≈ 1 MHz). Output impedance R_out + load cap C_gbw shape the pole. Real op-amps behave similarly once you add parasitics.',
            },
            {
                title: 'Run DC op-point',
                body: 'Pick Analysis → DC op-point and hit Run. The virtual ground keeps V(nin) within a few µV of 0; V(vout) should sit at 0 V too before the current pulse arrives.',
            },
            {
                title: 'Run AC sweep',
                body: 'Switch to AC analysis (10 Hz – 10 MHz, 20 pts/dec). V(vout) shows the closed-loop transimpedance vs. frequency. The DC plateau is 1 MΩ (120 dBΩ), with the −3 dB corner determined by R_f·C_f and the op-amp GBW.',
            },
            {
                title: 'Run transient',
                body: 'Transient analysis shows the pulse response. Expect a −1 V plateau during the 100 µs pulse, with rise/fall times set by the closed-loop bandwidth. Overshoot would indicate C_f is too small (or absent).',
            },
            {
                title: 'Experiment',
                body: 'Try raising R_f to 10 Meg for a more sensitive (but slower) TIA, or removing C_f to see ringing on the transient edges. Hit Run again after each edit.',
            },
        ],
    },
    {
        id: 'rc-lp',
        title: 'RC low-pass filter',
        tagline: 'Simplest analog building block. Good warm-up for learning the UI.',
        category: 'Introductory',
        netlist: `* Simple first-order RC low-pass filter.
* Cut-off f_c = 1 / (2π·R·C) ≈ 1.59 kHz.

V_in vin 0 AC 1 PULSE(0 1 100u 1u 1u 500u 2m)
R1 vin vout 1k
C1 vout 0 100n

.op
.ac dec 20 1 1meg
.tran 2u 4m
.end`,
        defaultAnalysis: 'ac',
        signals: {
            tran: ['V(vin)', 'V(vout)'],
            ac: ['V(vout)'],
        },
        tour: [
            {
                title: 'The filter',
                body: 'R1 + C1 form a first-order low-pass with cut-off at 1/(2πRC) ≈ 1.59 kHz.',
            },
            {
                title: 'Run AC',
                body: 'Hit Run. You should see a flat response up to ~1 kHz then a −20 dB/decade rolloff — the textbook Bode plot.',
            },
            {
                title: 'Run transient',
                body: 'Pulse response. Rise/fall times settle in ~5·τ (500 µs). Change C1 to 1µ and re-run to see the corner move to 159 Hz.',
            },
        ],
    },
    {
        id: 'diode-clipper',
        title: 'Diode clipper',
        tagline: 'A non-linear circuit — exercises the Newton-Raphson path.',
        category: 'Introductory',
        netlist: `* Symmetric diode clipper: limits output to ± ~0.7 V.
* Input is a 2 V sinusoid at 1 kHz; output clips once V_D crosses 0.7 V.

V_in vin 0 SIN(0 2 1k)
R1 vin vout 1k
D1 vout 0 DMOD
D2 0 vout DMOD

.model DMOD D(Is=1e-14 N=1)

.op
.tran 10u 3m
.end`,
        defaultAnalysis: 'tran',
        signals: {
            tran: ['V(vin)', 'V(vout)'],
        },
        tour: [
            {
                title: 'The clipper',
                body: 'Two diodes in anti-parallel clamp V_out to roughly ±0.7 V. Below the clamp, the circuit is just a resistive divider.',
            },
            {
                title: 'Run transient',
                body: 'See the 2 V sine flatten at the diode turn-on voltages. The waveform is a classic overdriven-guitar-amp shape.',
            },
        ],
    },
    {
        id: 'ce-bjt-amp',
        title: 'Common-emitter BJT amplifier',
        tagline: 'Textbook voltage amplifier — single NPN, coupling caps, emitter degeneration.',
        category: 'Active devices',
        netlist: `* Common-emitter NPN amplifier with emitter degeneration.
*
* DC bias: voltage divider (R1,R2) sets Vb ≈ 3 V ⇒ Ve ≈ 2.3 V,
*          Ie ≈ 2.3 mA through Re = 1 kΩ. Rc = 3.3 kΩ drops
*          ~7.6 V giving Vc ≈ 4.4 V (mid-rail — good swing headroom).
* Small-signal gain ≈ -Rc / Re ≈ -3.3 with full degeneration,
*          or -gm·Rc ≈ -300 if Ce shorts the emitter at high freq.

Vcc  vcc 0 12
R1   vcc vb  47k
R2   vb  0   10k
Rc   vcc vc  3.3k
Re   ve  0   1k
Ce   ve  0   100u
Cin  vin vb  10u
Cout vc  vout 10u
RL   vout 0  100k

Q1   vc vb ve QN

V1   vin 0 AC 1m SIN(0 5m 1k)

.model QN NPN(Is=1e-15 Bf=200 Vaf=100)

.op
.ac dec 20 10 10meg
.tran 10u 5m
.end`,
        defaultAnalysis: 'ac',
        signals: {
            tran: ['V(vin)', 'V(vout)'],
            ac:   ['V(vout)'],
            op:   ['V(vb)', 'V(vc)', 'V(ve)'],
        },
        tour: [
            {
                title: 'DC bias network',
                body: 'R1/R2 divides Vcc down to set the base voltage. The emitter sits a Vbe (~0.7 V) below the base, and the emitter current through Re sets the collector current. Hit Run with DC op-point selected — V(vb) should be ~3 V and V(vc) somewhere near the middle of the supply.',
            },
            {
                title: 'Small-signal gain',
                body: 'Switch to AC analysis. The gain from V(vin) to V(vout) has a plateau set by −gm·Rc||RL (~−300) bracketed by low-frequency roll-off from Cin/Cout and high-frequency roll-off from the BJT′s Early-effect output conductance. Read the mid-band gain off the magnitude trace.',
            },
            {
                title: 'Experiment',
                body: 'Try shorting the emitter capacitor (set Ce to 10µ → 10f): mid-band gain collapses to the resistor-ratio value −Rc/Re ≈ −3.3 because full emitter degeneration is restored. This is the classic gain vs. linearity trade-off.',
            },
        ],
    },
    {
        id: 'diff-pair',
        title: 'BJT differential pair',
        tagline: 'Input stage of every op-amp. Watch common-mode rejection in action.',
        category: 'Active devices',
        netlist: `* NPN differential pair biased by a tail current source.
*
* Ideal long-tailed pair: V(vout) follows the differential
* input (vin+ − vin−) linearly until the tail current gets
* fully switched to one side. Common-mode rejection depends on
* the finite output impedance of the tail — use a real current
* mirror later to see this improve further.

Vcc vcc 0 12
Vee vee 0 -12

* SPICE convention: current flows + → − through the source; here the
* source drains 1 mA from the tail node (that's what a real tail-source
* does — it sinks Ie1 + Ie2). Polarity is tail → vee.
It   tail vee 1m
Rc1  vcc out1 10k
Rc2  vcc out2 10k

Q1   out1 inp tail QN
Q2   out2 inn tail QN

Vinp inp 0 AC 0.5 SIN(0 5m 1k)
Vinn inn 0 AC -0.5 SIN(0 -5m 1k)

.model QN NPN(Is=1e-15 Bf=200 Vaf=100)

.op
.ac dec 20 1 1meg
.tran 2u 3m
.end`,
        defaultAnalysis: 'tran',
        signals: {
            tran: ['V(out1)', 'V(out2)'],
            ac:   ['V(out1)', 'V(out2)'],
            op:   ['V(out1)', 'V(out2)', 'V(tail)'],
        },
        tour: [
            {
                title: 'The topology',
                body: 'Two matched NPNs share an emitter tail node, fed by a 1 mA current source. When Vinp = Vinn the tail current splits evenly and V(out1) = V(out2). Any differential input steers more of the 1 mA to one side.',
            },
            {
                title: 'Transient — differential mode',
                body: 'The two inputs are driven 180° out-of-phase (+5 mV and −5 mV). Transient should show V(out1) and V(out2) swinging in opposite directions around their DC operating point — each with a gain of about gm·Rc/2 ≈ 200 to the differential input.',
            },
            {
                title: 'Try common-mode',
                body: 'Change Vinn to the same sign (+5m) so both inputs rise together — the outputs barely twitch (common-mode gain ≈ 1/gmTail, essentially the tail′s output impedance ratio). That′s CMRR in action.',
            },
        ],
    },
    {
        id: 'cmos-inverter',
        title: 'CMOS inverter — swept VTC',
        tagline: 'Classical transfer curve — .step sweeps VDD to show family of VTCs.',
        category: 'Active devices',
        netlist: `* CMOS inverter — voltage transfer characteristic with .step
*
* PMOS source at VDD, NMOS source at ground. Output switches
* midway through the input sweep (ideally at VDD/2 when Kp·W/L
* matches between devices). The .step directive sweeps VDD so
* we can see how the VTC scales with supply voltage.

Vdd  vdd 0 3.3
Vin  vin 0 0

M1   vout vin 0   0   MN
M2   vout vin vdd vdd MP

.model MN NMOS(Vto=0.5  Kp=200u Lambda=0.02)
.model MP PMOS(Vto=-0.5 Kp=100u Lambda=0.02)

.op
.dc Vin 0 3.3 0.05
.step Vdd 1.8 3.3 0.5
.end`,
        defaultAnalysis: 'dc',
        signals: {
            dc: ['V(vout)'],
            op: ['V(vout)'],
        },
        tour: [
            {
                title: 'The inverter',
                body: 'An NMOS pulls the output to ground when Vin is high; a PMOS pulls it to VDD when Vin is low. Matched β ratios (Kp·W/L) make the switching point symmetric at VDD/2.',
            },
            {
                title: 'Run DC sweep',
                body: 'Pick DC analysis and run. Vin is swept from 0 to 3.3 V; watch V(vout) swing sharply from VDD to 0 as you cross the switching threshold. Steeper = higher small-signal gain in the transition region.',
            },
            {
                title: 'Family of curves',
                body: 'The .step Vdd directive re-runs the sweep at VDD = 1.8, 2.3, 2.8, 3.3 V. Each curve is a different supply; the switching point tracks VDD/2 and the "gain" (slope of the transition) scales with overdrive.',
            },
        ],
    },
    {
        id: 'astable',
        title: 'BJT astable multivibrator',
        tagline: 'Two transistors, two caps — no external clock, just relaxation oscillation.',
        category: 'Active devices',
        netlist: `* Classic BJT astable (2-transistor RC oscillator).
*
* Each transistor′s collector is coupled to the other′s base by
* a capacitor. When one Q turns on, it yanks the other′s base
* negative through the cross-coupling cap; the base relaxes back
* through Rb (base resistor) until the transistor turns on again.
* Period ≈ 2·Rb·C·ln(2) → with 47 k and 10 µF gives ~650 ms / 2 Hz.

Vcc  vcc 0 5

Rc1  vcc c1 1k
Rc2  vcc c2 1k
Rb1  vcc b1 22k
Rb2  vcc b2 22k

* Series base stoppers: limit the reverse-Vbe spike during the
* regenerative flip so Newton-Raphson stays well-conditioned.
Rs1  b1 bq1 1k
Rs2  b2 bq2 1k

* Initial-condition asymmetry (50 mV on C1) breaks the perfectly
* symmetric metastable DC state so the astable actually starts up.
C1   c1 b2 47n IC=0.05
C2   c2 b1 47n IC=0

Q1   c1 bq1 0 QN
Q2   c2 bq2 0 QN

.model QN NPN(Is=1e-15 Bf=100 Vaf=50 Cje=10p Cjc=5p)

.tran 1u 4m 0 UIC
.end`,
        defaultAnalysis: 'tran',
        signals: {
            tran: ['V(c1)', 'V(c2)'],
        },
        tour: [
            {
                title: 'Why it oscillates',
                body: 'Neither device is stable when both are on or both are off. Once one Q is a tiny bit on, it pulls its collector toward ground and — via the cross-coupling cap — yanks the other Q′s base negative, forcing it OFF. The off Q′s base then slowly climbs back through its Rb until the process reverses. The half-period is set by Rb·C·ln(2).',
            },
            {
                title: 'Run transient',
                body: 'Half-period ≈ 22k · 47n · ln(2) ≈ 0.72 ms, so the oscillator runs near 1.4 kHz. The 4 ms transient captures ~5 full cycles. Expect V(c1) and V(c2) as square-ish pulses, 180° out-of-phase. Rise edges are fast (Q turning on), fall edges slope more gently (cap charging through Rb).',
            },
            {
                title: 'Tune the frequency',
                body: 'Halve both cap values (47n → 22n) to double the frequency. Or reduce Rb1/Rb2 to 10 k to do the same. The duty cycle is only 50 % when both halves are symmetric — try making one Rb bigger than the other to see it skew.',
            },
        ],
    },
    {
        id: 'scope-rc',
        title: 'Oscilloscope: RC pulse response',
        tagline: 'RC low-pass with a scope clipped to vout. Run → double-click the scope for a live waveform.',
        category: 'Introductory',
        netlist: `* RC low-pass filter with a pulse input, pre-probed with
* a SCOPE on vout. Run .tran and double-click the scope on
* the canvas to see the trace in a dedicated waveform viewer.

V_in vin 0 PULSE(0 1 100u 1u 1u 500u 2m)
R1 vin vout 1k
C1 vout 0 100n

.tran 2u 4m
.end`,
        defaultAnalysis: 'tran',
        signals: {
            tran: ['V(vin)', 'V(vout)'],
        },
        postImport: (doc) => {
            // Clip a SCOPE onto the vout node after the netlist is
            // imported. The scope's tip pin is at its symbol origin,
            // so comp.pos IS the probed node — we line it up with
            // whichever R1 pin currently lands on vout.
            const r1 = doc.components.find((c) => c.ref === 'R1');
            if (!r1) return;
            const pins = componentPins(r1);
            // `importNetlist` names the downstream pin 'n2' — but
            // defensively pick whichever pin coord has a label /
            // wire attached to vout.
            const voutPin = pins.find((p) => p.id === 'n2') || pins[pins.length - 1];
            if (!voutPin) return;
            addComponent(doc, 'SCOPE', voutPin.x, voutPin.y, 0);
        },
        tour: [
            {
                title: 'Attach a scope',
                body: 'The RC filter is already wired up. A SCOPE component is pre-clipped to the vout node — its triangular probe tip sits right on the wire between R1 and C1.',
            },
            {
                title: 'Run the simulation',
                body: 'Hit Run. The solver produces ~2000 samples over 4 ms. You should see V(vout) appear in the plotter at the bottom.',
            },
            {
                title: 'Open the waveform viewer',
                body: 'Double-click the scope on the canvas — a dedicated CRT-style modal pops up showing just that node\'s waveform. Tick the Live box in the transient subbar before hitting Run for a streaming-replay effect.',
            },
            {
                title: 'Move the scope',
                body: 'Drag the scope by its body — the tip stretches to follow without detaching. Drop the tip on V_in (to the left of R1) to probe the input pulse instead; the modal updates on the next Run.',
            },
        ],
    },
];
