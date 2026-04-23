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
 */

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
];
