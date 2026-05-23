/**
 * Published group-contribution tables for HSP estimation.
 *
 * Sources:
 *   - Stefanis & Panayiotou, Int J Thermophys 29 (2008) 568–585 (UNIFAC 1st/2nd order)
 *   - Hansen, Hansen Solubility Parameters: A User's Handbook, 2nd ed., CRC 2007, Table 1.1
 *   - van Krevelen / Hoftyzer (Grulke, Polymer Handbook, Table 4)
 *   - Hoy (Grulke, Polymer Handbook, Table 5)
 */

/** CGS (cal/cm³)^½ → SI MPa^½ — Hansen handbook factor. */
export const CGS_TO_MPA = 2.0455;

/** Stefanis–Panayiotou equation intercepts (MPa^½). */
export const SP_CONSTANTS = {
    dD: 17.3231,
    dP: 7.3548,
    dH: 7.9793,
    dP_low: 2.7467,
    dH_low: 1.3720,
};

/**
 * First-order UNIFAC groups → contributions to δD, δP, δH (MPa^½ each).
 * `null` means unavailable (*** in paper).
 * Optional `lowDP` / `lowDH` for δ < 3 MPa^½ alternate fits.
 */
export const SP_FIRST_ORDER = {
    CH3:              { dD: -0.9714, dP: -1.6448, dH: -0.7813, lowDP: -0.72412, lowDH: 0.29901 },
    CH2:              { dD: -0.0269, dP: -0.3045, dH: -0.4119, lowDP: -0.14030, lowDH: -0.11610 },
    'CH<':            { dD: 0.6450,  dP: 0.6491,  dH: -0.2018, lowDP: 0.58978,  lowDH: 0.1386 },
    '>C<':            { dD: 1.2686,  dP: 2.0838,  dH: 0.0866 },
    'CH2=CH-':        { dD: -1.0585, dP: -2.0035, dH: -1.2985, lowDP: -0.29774, lowDH: 1.35521 },
    '-CH=CH-':        { dD: 0.0048,  dP: -0.2984, dH: -0.0400, lowDP: -0.22864, lowDH: 0.48189 },
    'CH2=C<':         { dD: -0.4829, dP: -0.7794, dH: -0.8260, lowDP: 0.64816,  lowDH: 0.11148 },
    '-CH=C<':         { dD: 0.5372,  dP: -0.9024, dH: -1.8872, lowDP: 1.22566,  lowDH: -0.03066 },
    '>C=C<':          { dD: 0.3592,  dP: 1.0526,  dH: -15.4659, lowDH: -0.12117 },
    'CH2=C=CH-':      { dD: -1.6518, dP: null,    dH: -0.9980, lowDP: -0.32258 },
    'CH≡C-':          { dD: 0.2320,  dP: -1.3294, dH: 1.0736,  lowDP: -0.74895, lowDH: 0.43846 },
    'C≡C':            { dD: -0.2028, dP: -0.7598, dH: -1.1083, lowDH: -0.35107 },
    ACH:              { dD: 0.1105,  dP: -0.5303, dH: -0.4305, lowDP: -0.19313, lowDH: 0.13532 },
    AC:               { dD: 0.8446,  dP: 0.6187,  dH: 0.0084,  lowDP: 0.16369,  lowDH: -0.17405 },
    ACCH3:            { dD: 0.2174,  dP: -0.5705, dH: -1.1473, lowDP: -0.47724, lowDH: -0.28733 },
    'ACCH2-':         { dD: 0.6933,  dP: 0.6517,  dH: -0.1375, lowDP: -0.33086, lowDH: -0.88084 },
    CH3CO:            { dD: -0.3551, dP: 2.3192,  dH: -1.3078 },
    CH2CO:            { dD: 0.6527,  dP: 3.7328,  dH: -0.5344 },
    'CHO (aldehydes)':{ dD: -0.4030, dP: 3.4734,  dH: 0.1687 },
    COOH:             { dD: -0.2910, dP: 0.9042,  dH: 3.7391 },
    CH3COO:           { dD: -0.5401, dP: -0.3970, dH: 1.5826, lowDP: 1.71923 },
    CH2COO:           { dD: 0.2913,  dP: 3.6462,  dH: 1.2523, lowDP: 2.16274 },
    HCOO:             { dD: null,    dP: 1.9308,  dH: 2.1202 },
    COO:              { dD: 0.2039,  dP: 3.4637,  dH: 1.1389, lowDP: 1.60913, lowDH: 0.37204 },
    OH:               { dD: -0.3462, dP: 1.1404,  dH: 7.1908, lowDP: 1.84013 },
    ACOH:             { dD: 0.5288,  dP: 1.1010,  dH: 6.9580 },
    CH3O:             { dD: -0.5828, dP: 0.1764,  dH: 0.1460, lowDP: -0.40320 },
    CH2O:             { dD: 0.0310,  dP: 0.8826,  dH: -0.1528 },
    'CHO (ethers)':   { dD: 0.8833,  dP: 1.6853,  dH: 0.4470, lowDH: -0.40667 },
    C2H5O2:           { dD: -0.1249, dP: 3.6422,  dH: 8.3579 },
    'CH2O (cyclic)':  { dD: 0.2753,  dP: 0.1994,  dH: -0.1610, lowDP: -0.33305 },
    CH2NH2:           { dD: -0.5828, dP: 1.4084,  dH: 2.5920 },
    CHNH2:            { dD: 0.0112,  dP: -1.1989, dH: 0.3818, lowDP: 1.25999 },
    CH3NH:            { dD: null,    dP: 0.6777,  dH: 5.6646 },
    CH2NH:            { dD: 0.8116,  dP: 0.9412,  dH: 1.3400, lowDP: 0.83214 },
    CH3N:             { dD: 0.8769,  dP: 1.2046,  dH: 1.6062, lowDP: -0.17004 },
    CH2N:             { dD: 1.4681,  dP: 2.8345,  dH: 1.2505, lowDP: 0.65229, lowDH: -1.03686 },
    ACNH2:            { dD: 1.6987,  dP: 1.6761,  dH: 4.5274 },
    CONH2:            { dD: -0.0689, dP: 6.0694,  dH: 5.2280 },
    'CON(CH3)2':      { dD: 0.4482,  dP: 5.7899,  dH: 3.0020 },
    CH2SH:            { dD: 1.2797,  dP: -0.8223, dH: 4.4646, lowDH: 0.14606 },
    CH3S:             { dD: null,    dP: 0.4944,  dH: -1.4861 },
    CH2S:             { dD: 1.0595,  dP: 0.7530,  dH: -0.2287 },
    I:                { dD: 0.7797,  dP: 0.6777,  dH: 0.2646 },
    Br:               { dD: 0.5717,  dP: 0.6997,  dH: -1.0722 },
    CH2Cl:            { dD: 0.2623,  dP: 0.5970,  dH: -0.5364, lowDP: 0.48952 },
    CHCl:             { dD: 0.4462,  dP: 2.8060,  dH: -1.4125, lowDP: 0.12996 },
    CCl:              { dD: 2.7576,  dP: 2.0406,  dH: 0.1101,  lowDP: 0.52541 },
    CHCl2:            { dD: 1.1797,  dP: 1.8361,  dH: -3.2861 },
    CCl2:             { dD: 0.3653,  dP: 0.1696,  dH: -1.4334 },
    CCl3:             { dD: null,    dP: 1.2777,  dH: -2.6354 },
    ACCl:             { dD: 0.8475,  dP: -0.0339, dH: -0.7840, lowDP: -0.10778, lowDH: 0.44238 },
    ACF:              { dD: 0.1170,  dP: 0.1856,  dH: -0.7182, lowDH: -0.37183 },
    'Cl-(C=C)':       { dD: 0.2289,  dP: 2.3444,  dH: 3.8893,  lowDP: 0.66062 },
    CF3:              { dD: -0.2293, dP: -1.9735, dH: -1.4665, lowDH: -0.08871 },
    CH2NO2:           { dD: null,    dP: 6.8944,  dH: -1.2861 },
    CHNO2:            { dD: null,    dP: 8.0347,  dH: -2.3167 },
    ACNO2:            { dD: 1.4195,  dP: 4.4838,  dH: -0.7167 },
    CH2CN:            { dD: -0.3392, dP: 6.5341,  dH: -0.8892 },
    CF2:              { dD: -0.9729, dP: null,    dH: null },
    CF:               { dD: 0.1707,  dP: null,    dH: null },
    'F (except above)':{ dD: -0.7069, dP: null,   dH: null },
    'CH2=C=C<':       { dD: -0.2804, dP: null,    dH: -1.9167, lowDP: 1.20154 },
    'O (except above)':{ dD: 0.0472, dP: 3.3432,  dH: 0.0256, lowDP: -0.48942 },
    'Cl (except above)':{ dD: 0.2256, dP: 1.8711, dH: -0.3295, lowDH: 1.12515 },
    '>C=N-':          { dD: -0.3074, dP: -0.0012, dH: -5.3956 },
    '-CH=N-':         { dD: 0.9672,  dP: 1.9728,  dH: 0.7668 },
    'NH (except above)':{ dD: null,  dP: 0.0103,  dH: 2.2086 },
    'CN (except above)':{ dD: 0.0861, dP: 6.5331, dH: -0.6849 },
    'O=C=N-':         { dD: -0.1306, dP: 1.6102,  dH: 4.0461 },
    'SH (except above)':{ dD: 1.0427, dP: 1.9813, dH: 4.8181 },
    'S (except above)':{ dD: 1.4899, dP: 9.2072,  dH: -0.6250, lowDP: 0.11058 },
    SO2:              { dD: 1.5502,  dP: 11.1758, dH: 0.1055 },
    '>C=S':           { dD: 0.7747,  dP: 0.0683,  dH: 3.4080 },
    '>C=O (except above)':{ dD: -0.4343, dP: 0.7905, dH: 1.8147, lowDH: -0.05529 },
    'N (except above)':{ dD: 1.5438,  dP: 2.5780,  dH: 1.1189 },
};

/** Second-order UNIFAC groups (Stefanis–Panayiotou Table 4). */
export const SP_SECOND_ORDER = {
    '(CH3)2-CH-':              { dD: 0.0460,  dP: 0.0019,  dH: 0.3149,  lowDH: 0.00000001 },
    '(CH3)3-C-':               { dD: -0.0738, dP: 1.1881,  dH: -0.2966 },
    'ring of 5 carbons':       { dD: -0.6681, dP: -2.3430, dH: -0.3079, lowDP: -0.897912, lowDH: 0.19438 },
    'ring of 6 carbons':       { dD: -0.3874, dP: -3.6432, dH: null,     lowDP: -0.956852, lowDH: 0.00000002 },
    '-C=C-C=C-':               { dD: -0.1355, dP: -3.5085, dH: -1.0795, lowDP: 0.648793 },
    'CH3-C=':                  { dD: -0.0785, dP: 0.3316,  dH: 0.3875,  lowDP: -0.008375, lowDH: -0.061370 },
    '-CH2-C=':                 { dD: -0.3236, dP: -2.3179, dH: -0.5836, lowDP: 0.011009,  lowDH: 0.06599 },
    '>C{H or C}-C=':           { dD: -0.2798, dP: null,    dH: -1.1164, lowDP: -0.39720,  lowDH: 0.342229 },
    'string in cyclic':        { dD: -0.1945, dP: null,    dH: null,     lowDH: -0.280859 },
    'CH3(CO)CH2-':             { dD: -0.0451, dP: -0.3383, dH: -0.4083 },
    'Ccyclic=O':               { dD: -0.2981, dP: 0.4497,  dH: -0.4794, lowDP: 0.491153,  lowDH: 0.00000001 },
    ACCOOH:                    { dD: -0.2293, dP: -0.6349, dH: -0.9030 },
    '>C{H or C}-COOH':         { dD: null,    dP: -0.2187, dH: 1.1460 },
    'CH3(CO)OC{H or C}<':      { dD: -0.5220, dP: -0.0652, dH: 0.3085 },
    '(CO)C{H2}COO':            { dD: null,    dP: -2.3792, dH: 0.8412 },
    '(CO)O(CO)':               { dD: -0.2707, dP: -1.0562, dH: 1.6335 },
    ACHO:                      { dD: 0.3772,  dP: -1.8110, dH: -1.0096 },
    '>CHOH':                   { dD: 0.1123,  dP: 0.2564,  dH: -0.1928 },
    '>C N{H or C}(in cyclic)':  { dD: 0.2218,  dP: -2.2018, dH: -0.0452 },
    '-S-(in cyclic)':          { dD: 0.4892,  dP: 0.3040,  dH: 0.2297 },
    ACBr:                      { dD: 0.1234,  dP: -0.4495, dH: 0.3397 },
    '(C=C)-Br':                { dD: -0.4059, dP: -0.0024, dH: -1.1304 },
    'ring of 3 carbons':       { dD: 0.0200,  dP: 1.8288,  dH: -0.8073 },
    ACCOO:                     { dD: -0.1847, dP: 0.4059,  dH: -0.1921, lowDP: 0.491153 },
    'AC(ACHm)2AC(ACHn)2':     { dD: -0.3751, dP: -1.2980, dH: 0.6844,  lowDP: 0.013012,  lowDH: 0.086424 },
    'Ocyclic-Ccyclic=O':       { dD: 0.2468,  dP: 2.7501,  dH: 0.1220 },
    'AC-O-AC':                 { dD: -0.5646, dP: -3.4329, dH: 2.0830 },
    'CcyclicHm=Ncyclic-CcyclicHn=CcyclicHp': { dD: 0.7002, dP: 0.0691, dH: -2.7661 },
    'NcyclicHm-Ccyclic=O':     { dD: 0.2956,  dP: 2.8958,  dH: 1.3125 },
    '-O-CHm-O-CHn-':           { dD: 0.0839,  dP: 0.3451,  dH: 0.3767,  lowDP: 0 },
    'C(=O)-C-C(=O)':           { dD: -0.4862, dP: -0.4888, dH: 1.2482 },
};

/** Hansen / Beerbower Table 1.1 — molar volume and cohesive energy contributions. */
export const BEERBOWER_GROUPS = {
    CH3:     { V: 33.5,  Ed: 1125, Ep: 0,    Eh: 0 },
    CH2:     { V: 16.1,  Ed: 1180, Ep: 0,    Eh: 0 },
    'CH<':   { V: -1.0,  Ed: 820,  Ep: 0,    Eh: 0 },
    '>C<':   { V: -19.2, Ed: 350,  Ep: 0,    Eh: 0 },
    'CH2=':  { V: 28.5,  Ed: 850,  Ep: 25,   Eh: 180 },
    '-CH=':  { V: 13.5,  Ed: 875,  Ep: 18,   Eh: 180 },
    '>C=':   { V: -5.5,  Ed: 800,  Ep: 60,   Eh: 180 },
    Phenyl:  { V: 71.4,  Ed: 7530, Ep: 0,    Eh: 50 },
    'C-5 ring': { V: 16, Ed: 250,  Ep: 0,    Eh: 0 },
    'C-6 ring': { V: 16, Ed: 250,  Ep: 0,    Eh: 0 },
    '-F':    { V: 18.0,  Ed: 0,    Ep: 0,    Eh: 1000 },
    '-Cl':   { V: 24.0,  Ed: 1400, Ep: 1300, Eh: 800 },
    '-Br':   { V: 30.0,  Ed: 1950, Ep: 1650, Eh: 800 },
    '-I':    { V: 31.5,  Ed: 2350, Ep: 2000, Eh: 800 },
    '-O-':   { V: 3.8,   Ed: 0,    Ep: 500,  Eh: 1200 },
    '>CO':   { V: 10.8,  Ed: 0,    Ep: 2350, Eh: 400 },
    '-CHO':  { V: 23.2,  Ed: 950,  Ep: 550,  Eh: 750 },
    '-COO-': { V: 18.0,  Ed: 0,    Ep: 0,    Eh: 1250 },
    '-COOH': { V: 28.5,  Ed: 3350, Ep: 3600, Eh: 2750 },
    '-OH':   { V: 10.0,  Ed: 1770, Ep: 700,  Eh: 4650 },
    '-CN':   { V: 24.0,  Ed: 1600, Ep: 0,    Eh: 3750 },
    '-NO2':  { V: 24.0,  Ed: 3000, Ep: 2550, Eh: 1750 },
    '-NH2':  { V: 19.2,  Ed: 1050, Ep: 600,  Eh: 1350 },
    '>NH':   { V: 4.5,   Ed: 1150, Ep: 100,  Eh: 750 },
};

/** van Krevelen Table 4 (Grulke) — dispersion uses Beerbower Ed for accuracy. */
export const VK_GROUPS = {
    CH3:     { V: 33.5, Fd: 1125, Fp: 0,   Eh: 0 },
    CH2:     { V: 16.1, Fd: 1180, Fp: 0,   Eh: 0 },
    'CH<':   { V: -1.0, Fd: 820,  Fp: 0,   Eh: 0 },
    '>C<':   { V: -19.2,Fd: 350,  Fp: 0,   Eh: 0 },
    'CH2=':  { V: 28.5, Fd: 850,  Fp: 2500, Eh: 18000 },
    '-CH=':  { V: 13.5, Fd: 875,  Fp: 1800, Eh: 18000 },
    '>C=':   { V: -5.5, Fd: 800,  Fp: 6000, Eh: 18000 },
    Phenyl:  { V: 71.4, Fd: 7530, Fp: 0,   Eh: 5000 },
    '-OH':   { V: 10.0, Fd: 1770, Fp: 700, Eh: 46500 },
    '-O-':   { V: 3.8,  Fd: 0,    Fp: 500, Eh: 12000 },
    '>CO':   { V: 10.8, Fd: 0,    Fp: 2350, Eh: 40000 },
    '-COOH': { V: 28.5, Fd: 3350, Fp: 3600, Eh: 27500 },
    '-COO-': { V: 18.0, Fd: 0,    Fp: 0,    Eh: 12500 },
    '-CHO':  { V: 23.2, Fd: 950,  Fp: 550,  Eh: 7500 },
    '-CN':   { V: 24.0, Fd: 1600, Fp: 0,    Eh: 37500 },
    '-Cl':   { V: 24.0, Fd: 1400, Fp: 1300, Eh: 80000 },
    '-NH2':  { V: 19.2, Fd: 1050, Fp: 600,  Eh: 13500 },
    Ring:    { V: 16,   Fd: 250,  Fp: 0,    Eh: 0 },
};

/** Hoy Table 5 — Ft, Fp, V, T (Lydersen ΔT) per group. B = 277 base value. */
export const HOY_GROUPS = {
    CH3:        { Ft: 303.5, Fp: 0,    V: 21.55, T: 0.023 },
    CH2:        { Ft: 269.0, Fp: 0,    V: 15.55, T: 0.020 },
    'CH<':      { Ft: 176.0, Fp: 0,    V: 9.56,  T: 0.012 },
    '>C<':      { Ft: 65.5,  Fp: 0,    V: 3.56,  T: 0 },
    'CH2=':     { Ft: 259,   Fp: 67,   V: 19.17, T: 0.018 },
    '-CH=':     { Ft: 249,   Fp: 59.5, V: 13.18, T: 0.0185 },
    '>C=':      { Ft: 173,   Fp: 63,   V: 7.18,  T: 0.013 },
    'CH (arom)':{ Ft: 241,   Fp: 62.5, V: 13.42, T: 0.011 },
    'C (arom)': { Ft: 201,   Fp: 65,   V: 7.42,  T: 0.011 },
    '-HC=O':    { Ft: 600,   Fp: 532,  V: 23.3,  T: 0.048 },
    '>CO':      { Ft: 538,   Fp: 525,  V: 17.3,  T: 0.040 },
    '-COOH':    { Ft: 565,   Fp: 415,  V: 26.1,  T: 0.039 },
    '-COO-':    { Ft: 640,   Fp: 528,  V: 23.7,  T: 0.047 },
    '-CN':      { Ft: 725,   Fp: 725,  V: 23.1,  T: 0.060 },
    '-OH (prim)':{ Ft: 675,  Fp: 675,  V: 12.45, T: 0.082 },
    '-OH (sec)': { Ft: 591,  Fp: 591,  V: 12.45, T: 0.082 },
    '-O-':      { Ft: 235,   Fp: 216,  V: 6.45,  T: 0.021 },
    '-NH2':     { Ft: 464,   Fp: 464,  V: 17.0,  T: 0.031 },
    '-NH-':     { Ft: 368,   Fp: 368,  V: 11.0,  T: 0.031 },
    '-Cl (prim)':{ Ft: 419.5,Fp: 307,  V: 19.5,  T: 0.017 },
    '-Br (aliph)':{ Ft: 528, Fp: 123,  V: 25.3,  T: 0.010 },
};

export const HOY_BASE = 277;

/** Symmetry planes for van Krevelen δP reduction. */
export const SYMMETRY_OPTIONS = [
    { id: 0, label: 'None', factorP: 1, factorH: 1 },
    { id: 1, label: '1 plane', factorP: 0.5, factorH: 1 },
    { id: 2, label: '2 planes', factorP: 0.25, factorH: 1 },
    { id: 3, label: '3+ planes', factorP: 0, factorH: 0 },
];

export const SP_GROUP_NAMES = Object.keys(SP_FIRST_ORDER).sort();
export const SP_SECOND_ORDER_NAMES = Object.keys(SP_SECOND_ORDER).sort();
export const BEERBOWER_GROUP_NAMES = Object.keys(BEERBOWER_GROUPS).sort();
export const VK_GROUP_NAMES = Object.keys(VK_GROUPS).sort();
export const HOY_GROUP_NAMES = Object.keys(HOY_GROUPS).sort();
