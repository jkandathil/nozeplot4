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
import { applyLowPowerThreeStageTutorialLayout } from './tutorialLayouts.js';

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
        id: 'opamp-inv',
        title: 'Ideal op-amp — inverting amplifier',
        tagline: 'Virtual ground at the summing node; closed-loop gain −R_f / R_in.',
        category: 'Op-amps',
        netlist: `* Inverting amplifier with the built-in ideal op-amp (O device).
* Non-inverting input tied to 0 V. Feedback forces V(−) ≈ V(+) = 0.
* DC: V(vout) = −(R_f/R_in)·V(vin). Here gain = −10 k / 1 k = −10.

V1 vin 0 AC 1 SIN(0 0.05 1k)
Rin vin nsum 1k
Rf nsum vout 10k
O1 0 nsum vout

.op
.ac dec 20 10 1meg
.tran 5u 5m
.end`,
        defaultAnalysis: 'tran',
        signals: {
            tran: ['V(vin)', 'V(vout)'],
            ac: ['V(vout)'],
            op: ['V(vout)', 'V(nsum)'],
        },
        tour: [
            {
                title: 'Ideal op-amp (O)',
                body: 'The O device enforces V(+) = V(−) and drives whatever output voltage satisfies that constraint. There is no finite gain or bandwidth here — it is a linear algebra idealization, perfect for learning feedback.',
            },
            {
                title: 'Virtual ground',
                body: 'The + input is grounded, so the summing node nsum sits at ~0 V. All of V(vin) appears across R_in, so I = V(vin)/R_in flows through R_f, giving V(vout) = −(R_f/R_in)·V(vin).',
            },
            {
                title: 'Run transient',
                body: 'You should see V(vout) as an inverted, 10× larger sine than V(vin). Switch to AC to confirm flat 20 dB gain until the sweep runs out of band (ideal op-amp has no rolloff in this model).',
            },
        ],
    },
    {
        id: 'opamp-noninv',
        title: 'Ideal op-amp — non-inverting amplifier',
        tagline: 'Input on +; resistor divider from output to − sets gain 1 + R2/R1.',
        category: 'Op-amps',
        netlist: `* Non-inverting amplifier: V(vout) = (1 + R2/R1)·V(vin).
* The − pin tracks V(vin) on +; divider current sets the output.

V1 vin 0 AC 1 SIN(0 0.05 1k)
R1 nminus 0 1k
R2 vout nminus 10k
O1 vin nminus vout

.op
.ac dec 20 10 1meg
.tran 5u 5m
.end`,
        defaultAnalysis: 'tran',
        signals: {
            tran: ['V(vin)', 'V(vout)'],
            ac: ['V(vout)'],
            op: ['V(vout)', 'V(nminus)'],
        },
        tour: [
            {
                title: 'Same-phase gain',
                body: 'Signal enters the + input. The − pin sits at the same voltage (virtual short), so the voltage across R1 is V(vin) and the current through R2 is V(vin)/R1. That gives V(vout) = V(vin) + R2·(V(vin)/R1) = (1 + R2/R1)·V(vin) ≈ 11× here.',
            },
            {
                title: 'High input impedance',
                body: 'Unlike the inverting topology, the driving source only sees the op-amp’s + terminal (infinite in this ideal model). That is why sensor front-ends often use non-inverting stages first.',
            },
            {
                title: 'Run and compare',
                body: 'Transient: V(vout) should be in phase with V(vin) and about eleven times larger. DC op-point with V(vin)=0 gives 0 V out; bias V1 with a .dc sweep on a copy if you want a DC transfer curve.',
            },
        ],
    },
    {
        id: 'opamp-buffer',
        title: 'Ideal op-amp — voltage follower',
        tagline: 'Unity-gain buffer: V(vout) = V(vin); isolates load from source.',
        category: 'Op-amps',
        netlist: `* Voltage follower (non-inverting gain of 1).
* Output tied to − input → op-amp drives until V(−) = V(+).

V1 vin 0 AC 1 SIN(0 0.2 1k)
O1 vin vout vout

.op
.ac dec 20 10 1meg
.tran 2u 5m
.end`,
        defaultAnalysis: 'tran',
        signals: {
            tran: ['V(vin)', 'V(vout)'],
            ac: ['V(vout)'],
            op: ['V(vout)'],
        },
        tour: [
            {
                title: 'Why use a buffer?',
                body: 'A resistive divider or sensor with high Thevenin impedance would sag if you hung a low load on it. The follower presents a very light load at its input and a stiff voltage at its output.',
            },
            {
                title: 'Unity gain',
                body: 'With − tied to out, the only solution consistent with V(+) = V(−) is V(vout) = V(vin). Run transient — the two traces overlay (gain 0 dB in AC).',
            },
        ],
    },
    {
        id: 'amp-stability',
        title: 'Op-amp stability & compensation (Bode)',
        tagline: 'Non-inverting gain with finite GBW, load cap, and Miller Cf — tune PM on the Bode plot.',
        category: 'Op-amps',
        netlist: `* Non-inverting amplifier + finite GBW op-amp + capacitive load.
* Cf (Miller / feedback) fights the extra phase lag from Cload so the
* closed-loop AC response stays well-behaved. Try Parametric sweep on Cf.

Vin vp 0 AC 1 DC 0
R1 vm 0 10k
R2 vout vm 90k
Cf vm vout 6p
* VCVS ~100k open-loop gain; Rout + Cload create a dominant output pole.
Eoa vtmp 0 vp vm 100000
Rout vtmp vout 250
Cload vout 0 400p

.op
.ac dec 50 1 50meg
.tran 2n 3u
.end`,
        defaultAnalysis: 'ac',
        signals: {
            tran: ['V(vp)', 'V(vout)'],
            ac: ['V(vout)', 'V(vp)'],
            op: ['V(vout)', 'V(vm)', 'V(vp)'],
        },
        postImport: (doc) => {
            const cl = doc.components.find((c) => String(c.ref).toLowerCase() === 'cload');
            if (!cl) return;
            const pins = componentPins(cl);
            const tip = pins.find((p) => p.id === 'n1') || pins[0];
            if (!tip) return;
            addComponent(doc, 'VP', tip.x, tip.y, 0);
        },
        tour: [
            {
                title: 'What you are looking at',
                body: 'This is a 1 + R2/R1 ≈ 10× non-inverting stage. The op-amp is a high-gain VCVS with a 250 Ω output resistor and 400 pF load — that extra pole can make the loop marginal. Cf from the output back toward the inverting node adds phase lead (classic compensation intuition).',
            },
            {
                title: 'Run AC first',
                body: 'Analysis is already set to AC. Hit Run. Tick V(vout) in the plot (V(vp) is the 0 dB reference). Open Measure under the chart: you will see peak gain, −3 dB bandwidth, unity-gain frequency, phase margin (PM), and gain margin (GM).',
            },
            {
                title: 'Read phase & gain margin',
                body: 'PM is computed at the first 0 dB crossing of |V(vout)| (SPICE-style small-signal magnitude). GM reports how many dB of gain you have when the phase hits −180° — larger GM usually means a more conservative, slower loop.',
            },
            {
                title: 'Optimize with a sweep',
                body: 'Enable Parametric sweep, pick target Cf, sweep e.g. 1p → 20p in 2p steps, Run again, and compare overlaid Bodes. More Cf often damps peaking (higher PM) but shrinks bandwidth — the plot + auto-measure make the trade-off visible.',
            },
            {
                title: 'Cross-check in transient',
                body: 'Switch to Transient and Run: a well-compensated step should settle without long ringing. Remove or shrink Cf to see the opposite — then restore it from the palette or inspector.',
            },
        ],
    },
    {
        id: 'opamp-diff',
        title: 'Ideal op-amp — difference amplifier',
        tagline: 'Matched resistor bridge: V(vout) ≈ V(vb) − V(va) when ratios match.',
        category: 'Op-amps',
        netlist: `* Single-op-amp difference (subtractor) stage.
* With R1=R2=R3=R4, V(vout) = V(vb) − V(va) (common-mode cancels).

Va va 0 AC 0.5 SIN(0 0.08 1k)
Vb vb 0 AC -0.5 SIN(0 -0.08 1k)
R1 va nminus 10k
R2 nminus vout 10k
R3 vb nplus 10k
R4 nplus 0 10k
O1 nplus nminus vout

.op
.ac dec 20 10 1meg
.tran 5u 5m
.end`,
        defaultAnalysis: 'tran',
        signals: {
            tran: ['V(va)', 'V(vb)', 'V(vout)'],
            ac: ['V(vout)'],
            op: ['V(vout)', 'V(nplus)', 'V(nminus)'],
        },
        tour: [
            {
                title: 'Matched resistors',
                body: 'The + input sees a divider from V(vb) to ground; the − input mixes V(va) and V(vout) through R1 and R2. When R3/R4 = R1/R2, common-mode terms cancel and the output tracks the differential input.',
            },
            {
                title: 'Transient',
                body: 'V(va) and V(vb) are equal sine waves but opposite sign, so V(vb)−V(va) is a sine at twice the single-ended amplitude. V(vout) should follow that difference in phase and magnitude (≈ 0.16 V peak here).',
            },
            {
                title: 'Common-mode experiment',
                body: 'Edit both sources to the same polarity (+0.08 V sine on each). The output should collapse toward zero — that is common-mode rejection. Mismatch R3 vs R1 by 10 % in the netlist to see CMRR degrade.',
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
        id: 'low-power-3stage-amp',
        title: 'Low power 3-stage transistor amplifier (tutorial)',
        tagline: 'Three 2N2222-class NPNs: AC-coupled stages, B–C bias resistors, decoupled 9 V supply, 64 Ω load.',
        category: 'Tutorial',
        netlist: `* Low power 3-stage transistor amplifier — Circuit Studio tutorial
* Topology (discrete “pocket” audio pre+driver):
*   Stage 1 (Q1): Cin 0.01µF, R2 560k B–C feedback bias, R1 5.6k to decoupled rail.
*   Stage 2 (Q2): C2 22µF couple, R3 270k B–C, R4 3.3k collector load to V+.
*   Stage 3 (Q3): C3 22µF couple, R5 15k B–C, 64 Ω from V+ to collector (speaker model).
*   Rb 2.2k + C4 100µF decouple the bias node; C5 220µF bulk on supply.
* Emitters reference ground (no emitter resistors — textbook values; real builds often add 10–100 Ω for stability).

Vcc vcc 0 9
Vin nin 0 AC 1m SIN(0 12m 1k)

Rb  vcc nbias 2.2k
C4  nbias 0 100u
C5  vcc 0 220u

* --- Stage 1 ---
C1  nin nb1 0.01u
R2  nc1 nb1 560k
R1  nc1 nbias 5.6k
Q1  nc1 nb1 0 QN
C2  nc1 nb2 22u

* --- Stage 2 ---
R3  nc2 nb2 270k
R4  vcc nc2 3.3k
Q2  nc2 nb2 0 QN
C3  nc2 nb3 22u

* --- Stage 3 ---
R5  nc3 nb3 15k
RL  vcc nc3 64
Q3  nc3 nb3 0 QN

.model QN NPN(Is=1e-15 Bf=200 Vaf=100 Cje=12p Cjc=8p)

.op
.ac dec 30 1 5meg
.tran 5u 5m
.end`,
        defaultAnalysis: 'tran',
        signals: {
            tran: ['V(nin)', 'V(nc1)', 'V(nc2)', 'V(nc3)'],
            ac: ['V(nc3)', 'V(nin)'],
            op: ['V(nb1)', 'V(nc1)', 'V(nb2)', 'V(nc2)', 'V(nb3)', 'V(nc3)', 'V(nbias)'],
        },
        postImport: (doc) => applyLowPowerThreeStageTutorialLayout(doc),
        tour: [
            {
                title: 'What this schematic is',
                body: 'Three common-emitter stages with AC coupling (C1–C3) between them so each transistor can sit at its own DC bias. Resistors R2, R3, and R5 run from collector to base of the same device — a classic high-value feedback pair that sets a stable operating point without a zener reference.',
            },
            {
                title: 'Power supply & decoupling',
                body: 'Vcc is 9 V. Rb (2.2 kΩ) feeds the decoupled node nbias; C4 (100 µF) to ground holds that node quiet at AC so stage 1 does not talk back up the rail. C5 (220 µF) is bulk storage from Vcc to ground — always place a big cap near the active devices in a real layout.',
            },
            {
                title: 'Stage 1 — Q1',
                body: 'The input arrives through C1 (0.01 µF). R2 (560 kΩ) from collector to base sets the first bias loop together with R1 (5.6 kΩ) to nbias. C2 passes AC from Q1 collector into stage 2.',
            },
            {
                title: 'Stage 2 — Q2',
                body: 'R3 (270 kΩ) provides collector–base feedback for Q2; R4 (3.3 kΩ) is the collector load to Vcc. C3 couples the amplified voltage into the output transistor base.',
            },
            {
                title: 'Stage 3 — Q3 & 64 Ω load',
                body: 'R5 (15 kΩ) biases Q3 the same way. RL (64 Ω) models an 8 Ω speaker reflected through a small output transformer, or a headphone element — here it is simplified as a single resistor from Vcc to the collector so you can read drive current in the transient.',
            },
            {
                title: 'Run DC op-point',
                body: 'Pick DC op-point and Run. Check V(nb1…3) and V(nc1…3) — collectors should sit somewhere in the middle of the swing range (not slammed to rail or cutoff). V(nbias) reflects the drop through Rb from Vcc.',
            },
            {
                title: 'Run transient',
                body: 'Default Transient shows the 1 kHz sine propagating and growing stage-by-stage. Compare V(nin) with V(nc3) — overall voltage gain is large, so if you see clipping, reduce Vin amplitude in the netlist or add emitter degeneration in a follow-on exercise.',
            },
            {
                title: 'Run AC sweep',
                body: 'AC shows bandwidth and how each coupling capacitor contributes a low-frequency zero. High-frequency roll-off comes from the simplified Cje/Cjc device capacitances in the .model line.',
            },
            {
                title: 'Try your own edits',
                body: 'Duplicate the project (Save As), then change C2/C3 (coupling) or R4 (second-stage load) and re-Run — watch how bandwidth and clipping trade off. When you are happy, use File → Send to PCB Studio to try a board layout on a copy.',
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
        tagline: 'RC low-pass with a dual-channel scope on vout (CH1). Run → double-click for the CRT viewer.',
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
                body: 'Double-click the scope — a CRT-style modal shows CH1 and CH2 on the same timebase (shared Y autoscale). Tick Live before Run for a streaming-replay effect.',
            },
            {
                title: 'Move the scope',
                body: 'Drag the scope by its body — both tips move together. Drop CH1 or CH2 onto different nets; the modal updates on the next Run.',
            },
        ],
    },
    {
        id: 'pcb-gerber-walkthrough',
        title: 'Tutorial: schematic → auto-route → Gerber',
        tagline: 'Tiny RC + 5 V source. Guided steps through PCB Studio and a zip download.',
        category: 'Tutorial',
        netlist: `* PCB / Gerber walkthrough — minimal RC low-pass + 5 V DC source
* Simulator: run .tran to see the node waveforms.
* Layout: Circuit Studio → File → Send to PCB Studio, then Auto-route and Gerber ZIP.

V1 vin 0 DC 5
R1 vin vout 1k
C1 vout 0 100n

.tran 1u 500u
.end`,
        defaultAnalysis: 'tran',
        signals: {
            tran: ['V(vin)', 'V(vout)'],
            ac: ['V(vout)'],
            op: ['V(vin)', 'V(vout)'],
        },
        tour: [
            {
                title: 'What is on the canvas',
                body: 'V1 is a 5 V DC source (vin → ground). R1 and C1 form a 1st-order low-pass from vin to vout. Node names match the SPICE labels so nets stay easy to follow.',
            },
            {
                title: 'Run the transient',
                body: 'Click Run. You should see V(vin) step to 5 V and V(vout) charge toward 5 V with an RC time constant τ ≈ R·C = 100 µs (1 kΩ · 100 nF).',
            },
            {
                title: 'Push the design to PCB Studio',
                body: 'Open File → Send to PCB Studio… (or use the Schematic / Board switch after sending). The app copies component refs, footprints, and net names into a new board layout session.',
            },
            {
                title: 'In PCB Studio — place review',
                body: 'Parts appear in a small grid of footprints (source, resistor, capacitor). Nets such as vin, vout, and ground are attached to pads so the router knows what to connect.',
            },
            {
                title: 'Auto-route',
                body: 'Click the lightning (⚡) tool in the left rail. It adds Manhattan-style copper tracks between pads on the same net (demo router — not DRC-clean production routing).',
            },
            {
                title: 'Gerber ZIP',
                body: 'Use Gerber ZIP in the top bar. Your browser downloads a zip of copper and outline layers you can open in any Gerber viewer or send to a fab for quoting.',
            },
            {
                title: 'Iterate',
                body: 'Return to Schematic with Home → Circuit Studio, tweak R or C, send to PCB again, and re-route. Use DRC in PCB Studio if you want a quick clearance sanity check.',
            },
        ],
    },
];
