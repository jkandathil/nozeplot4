/**
 * Professional Footprint Library for PCB Studio.
 * 100+ SMD/through-hole footprints (mm, origin at package centre).
 * Organized by family: passives, diodes, transistors, ICs, connectors, etc.
 *
 * Pad dimensions follow IPC-7351B nominal land patterns.
 */

/** @typedef {{ id: string, x: number, y: number, w: number, h: number, num: string, shape?: 'rect'|'round'|'roundrect'|'oval', drill?: number }} FpPad */
/** @typedef {{ kind: 'line', x1: number, y1: number, x2: number, y2: number }} SilkLine */
/** @typedef {{ kind: 'circle', cx: number, cy: number, r: number }} SilkCircle */
/** @typedef {{ kind: 'arc', cx: number, cy: number, r: number, startDeg: number, endDeg: number }} SilkArc */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   family: string,
 *   description?: string,
 *   tags?: string[],
 *   courtyard?: { w: number, h: number },
 *   pads: FpPad[],
 *   silk: Array<SilkLine | SilkCircle | SilkArc>,
 * }} FootprintDef
 */

/* ═══════════════════════════════════════════════════════════════
   Helper: generate SMD 2-pad passive footprints
   ═══════════════════════════════════════════════════════════════ */
function smd2Pad(id, name, family, padW, padH, padGap, silkY, tags = []) {
  const cx = padGap / 2 + padW / 2;
  return {
    id, name, family, tags,
    pads: [
      { id: '1', num: '1', x: -cx, y: 0, w: padW, h: padH },
      { id: '2', num: '2', x: cx, y: 0, w: padW, h: padH },
    ],
    silk: silkY > 0 ? [
      { kind: 'line', x1: -(cx + padW / 2), y1: -silkY, x2: cx + padW / 2, y2: -silkY },
      { kind: 'line', x1: -(cx + padW / 2), y1: silkY, x2: cx + padW / 2, y2: silkY },
    ] : [],
  };
}

/* ═══════════════════════════════════════════════════════════════
   Helper: generate DIP/SOIC style IC footprints
   ═══════════════════════════════════════════════════════════════ */
function soicFootprint(id, name, pinCount, pitch, padW, padH, rowSpacing, silkW, silkH) {
  const half = pinCount / 2;
  const pads = [];
  const startY = -((half - 1) * pitch) / 2;
  for (let i = 0; i < half; i++) {
    pads.push({ id: `${i + 1}`, num: `${i + 1}`, x: -rowSpacing / 2, y: startY + i * pitch, w: padW, h: padH });
  }
  for (let i = 0; i < half; i++) {
    pads.push({ id: `${pinCount - i}`, num: `${pinCount - i}`, x: rowSpacing / 2, y: startY + i * pitch, w: padW, h: padH });
  }
  const silk = [
    { kind: 'line', x1: -silkW / 2, y1: -silkH / 2, x2: silkW / 2, y2: -silkH / 2 },
    { kind: 'line', x1: -silkW / 2, y1: silkH / 2, x2: silkW / 2, y2: silkH / 2 },
    { kind: 'line', x1: -silkW / 2, y1: -silkH / 2, x2: -silkW / 2, y2: silkH / 2 },
    { kind: 'line', x1: silkW / 2, y1: -silkH / 2, x2: silkW / 2, y2: silkH / 2 },
  ];
  return { id, name, family: 'IC', tags: ['ic', 'soic'], pads, silk };
}

function qfpFootprint(id, name, totalPins, pitch, padW, padH, bodySize) {
  const pinsPerSide = totalPins / 4;
  const pads = [];
  const startOff = -((pinsPerSide - 1) * pitch) / 2;
  const edgeDist = bodySize / 2 + padW / 2;
  let num = 1;
  // Bottom side (left to right)
  for (let i = 0; i < pinsPerSide; i++) {
    pads.push({ id: `${num}`, num: `${num}`, x: startOff + i * pitch, y: edgeDist, w: padH, h: padW });
    num++;
  }
  // Right side (bottom to top)
  for (let i = 0; i < pinsPerSide; i++) {
    pads.push({ id: `${num}`, num: `${num}`, x: edgeDist, y: -startOff - i * pitch, w: padW, h: padH });
    num++;
  }
  // Top side (right to left)
  for (let i = 0; i < pinsPerSide; i++) {
    pads.push({ id: `${num}`, num: `${num}`, x: -startOff - i * pitch, y: -edgeDist, w: padH, h: padW });
    num++;
  }
  // Left side (top to bottom)
  for (let i = 0; i < pinsPerSide; i++) {
    pads.push({ id: `${num}`, num: `${num}`, x: -edgeDist, y: startOff + i * pitch, w: padW, h: padH });
    num++;
  }
  const bs = bodySize / 2;
  const silk = [
    { kind: 'line', x1: -bs, y1: -bs, x2: bs, y2: -bs },
    { kind: 'line', x1: bs, y1: -bs, x2: bs, y2: bs },
    { kind: 'line', x1: bs, y1: bs, x2: -bs, y2: bs },
    { kind: 'line', x1: -bs, y1: bs, x2: -bs, y2: -bs },
  ];
  return { id, name, family: 'IC', tags: ['ic', 'qfp'], pads, silk };
}

function dipFootprint(id, name, pinCount, pitch, padW, padH, rowSpacing) {
  const half = pinCount / 2;
  const pads = [];
  const startY = -((half - 1) * pitch) / 2;
  for (let i = 0; i < half; i++) {
    pads.push({ id: `${i + 1}`, num: `${i + 1}`, x: -rowSpacing / 2, y: startY + i * pitch, w: padW, h: padH, shape: 'round', drill: 0.8 });
  }
  for (let i = 0; i < half; i++) {
    pads.push({ id: `${pinCount - i}`, num: `${pinCount - i}`, x: rowSpacing / 2, y: startY + i * pitch, w: padW, h: padH, shape: 'round', drill: 0.8 });
  }
  const silkH = half * pitch;
  const silkW = rowSpacing - padW;
  const silk = [
    { kind: 'line', x1: -silkW / 2, y1: -silkH / 2, x2: silkW / 2, y2: -silkH / 2 },
    { kind: 'line', x1: silkW / 2, y1: -silkH / 2, x2: silkW / 2, y2: silkH / 2 },
    { kind: 'line', x1: silkW / 2, y1: silkH / 2, x2: -silkW / 2, y2: silkH / 2 },
    { kind: 'line', x1: -silkW / 2, y1: silkH / 2, x2: -silkW / 2, y2: -silkH / 2 },
  ];
  return { id, name, family: 'IC', tags: ['ic', 'dip', 'through-hole'], pads, silk };
}

function headerFootprint(id, name, pins, rows, pitch) {
  const pads = [];
  const cols = Math.ceil(pins / rows);
  let num = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols && num <= pins; c++) {
      pads.push({
        id: `${num}`, num: `${num}`,
        x: (c - (cols - 1) / 2) * pitch,
        y: (r - (rows - 1) / 2) * pitch,
        w: 1.4, h: 1.4, shape: 'round', drill: 1.0,
      });
      num++;
    }
  }
  return { id, name, family: 'J', tags: ['connector', 'header'], pads, silk: [] };
}

/* ═══════════════════════════════════════════════════════════════
   FOOTPRINT LIBRARY
   ═══════════════════════════════════════════════════════════════ */

/** @type {FootprintDef[]} */
export const FOOTPRINTS = [
  /* ─── RESISTORS (SMD) ─── */
  smd2Pad('R_0201', 'Resistor 0201 (0603 metric)', 'R', 0.3, 0.3, 0.2, 0.25, ['resistor', '0201']),
  smd2Pad('R_0402', 'Resistor 0402 (1005 metric)', 'R', 0.4, 0.5, 0.3, 0.4, ['resistor', '0402']),
  smd2Pad('R_0603', 'Resistor 0603 (1608 metric)', 'R', 0.5, 0.8, 0.5, 0.55, ['resistor', '0603']),
  smd2Pad('R_0805', 'Resistor 0805 (2012 metric)', 'R', 0.55, 1.2, 0.6, 0.65, ['resistor', '0805']),
  smd2Pad('R_1206', 'Resistor 1206 (3216 metric)', 'R', 0.65, 1.6, 1.1, 0.85, ['resistor', '1206']),
  smd2Pad('R_1210', 'Resistor 1210 (3225 metric)', 'R', 0.65, 2.5, 1.1, 1.3, ['resistor', '1210']),
  smd2Pad('R_2010', 'Resistor 2010 (5025 metric)', 'R', 0.75, 2.5, 2.0, 1.3, ['resistor', '2010']),
  smd2Pad('R_2512', 'Resistor 2512 (6332 metric)', 'R', 0.8, 3.2, 2.8, 1.65, ['resistor', '2512']),

  /* ─── CAPACITORS (SMD) ─── */
  smd2Pad('C_0201', 'Capacitor 0201', 'C', 0.3, 0.3, 0.2, 0.25, ['capacitor', '0201']),
  smd2Pad('C_0402', 'Capacitor 0402', 'C', 0.4, 0.5, 0.3, 0.4, ['capacitor', '0402']),
  smd2Pad('C_0603', 'Capacitor 0603', 'C', 0.5, 0.8, 0.5, 0.55, ['capacitor', '0603']),
  smd2Pad('C_0805', 'Capacitor 0805', 'C', 0.55, 1.2, 0.6, 0.65, ['capacitor', '0805']),
  smd2Pad('C_1206', 'Capacitor 1206', 'C', 0.65, 1.6, 1.1, 0.85, ['capacitor', '1206']),
  smd2Pad('C_1210', 'Capacitor 1210', 'C', 0.65, 2.5, 1.1, 1.3, ['capacitor', '1210']),
  smd2Pad('C_1812', 'Capacitor 1812', 'C', 0.75, 3.2, 1.8, 1.65, ['capacitor', '1812']),
  smd2Pad('C_2220', 'Capacitor 2220', 'C', 0.8, 5.0, 2.6, 2.55, ['capacitor', '2220']),

  /* ─── ELECTROLYTIC / TANTALUM ─── */
  {
    id: 'C_ELEC_6x5', name: 'Electrolytic 6.3x5.4mm', family: 'C',
    tags: ['capacitor', 'electrolytic', 'polarized'],
    pads: [
      { id: '1', num: '1', x: -2.2, y: 0, w: 1.5, h: 2.0 },
      { id: '2', num: '2', x: 2.2, y: 0, w: 1.5, h: 2.0 },
    ],
    silk: [
      { kind: 'line', x1: -3.5, y1: -3.0, x2: -3.5, y2: 3.0 },
      { kind: 'line', x1: -3.5, y1: -3.0, x2: 0, y2: -3.0 },
      { kind: 'line', x1: -3.5, y1: 3.0, x2: 0, y2: 3.0 },
    ],
  },
  {
    id: 'C_TANT_A', name: 'Tantalum Case A (3216)', family: 'C',
    tags: ['capacitor', 'tantalum', 'polarized'],
    pads: [
      { id: '1', num: '1', x: -1.25, y: 0, w: 1.0, h: 1.5 },
      { id: '2', num: '2', x: 1.25, y: 0, w: 1.0, h: 1.5 },
    ],
    silk: [{ kind: 'line', x1: -2.0, y1: -0.9, x2: -2.0, y2: 0.9 }],
  },
  {
    id: 'C_TANT_B', name: 'Tantalum Case B (3528)', family: 'C',
    tags: ['capacitor', 'tantalum', 'polarized'],
    pads: [
      { id: '1', num: '1', x: -1.5, y: 0, w: 1.2, h: 2.0 },
      { id: '2', num: '2', x: 1.5, y: 0, w: 1.2, h: 2.0 },
    ],
    silk: [{ kind: 'line', x1: -2.4, y1: -1.2, x2: -2.4, y2: 1.2 }],
  },
  {
    id: 'C_TANT_D', name: 'Tantalum Case D (7343)', family: 'C',
    tags: ['capacitor', 'tantalum', 'polarized'],
    pads: [
      { id: '1', num: '1', x: -2.8, y: 0, w: 1.8, h: 2.8 },
      { id: '2', num: '2', x: 2.8, y: 0, w: 1.8, h: 2.8 },
    ],
    silk: [{ kind: 'line', x1: -4.2, y1: -2.0, x2: -4.2, y2: 2.0 }],
  },

  /* ─── INDUCTORS ─── */
  smd2Pad('L_0402', 'Inductor 0402', 'L', 0.4, 0.5, 0.3, 0.4, ['inductor', '0402']),
  smd2Pad('L_0603', 'Inductor 0603', 'L', 0.5, 0.8, 0.5, 0.55, ['inductor', '0603']),
  smd2Pad('L_0805', 'Inductor 0805', 'L', 0.55, 1.2, 0.6, 0.65, ['inductor', '0805']),
  smd2Pad('L_1206', 'Inductor 1206', 'L', 0.65, 1.6, 1.1, 0.85, ['inductor', '1206']),
  smd2Pad('L_1210', 'Inductor 1210', 'L', 0.7, 1.35, 1.0, 0, ['inductor', '1210']),
  {
    id: 'L_SHIELDED_5x5', name: 'Shielded Inductor 5x5mm', family: 'L',
    tags: ['inductor', 'shielded', 'power'],
    pads: [
      { id: '1', num: '1', x: -1.8, y: 0, w: 1.5, h: 4.0 },
      { id: '2', num: '2', x: 1.8, y: 0, w: 1.5, h: 4.0 },
    ],
    silk: [
      { kind: 'line', x1: -2.5, y1: -2.5, x2: 2.5, y2: -2.5 },
      { kind: 'line', x1: -2.5, y1: 2.5, x2: 2.5, y2: 2.5 },
      { kind: 'line', x1: -2.5, y1: -2.5, x2: -2.5, y2: 2.5 },
      { kind: 'line', x1: 2.5, y1: -2.5, x2: 2.5, y2: 2.5 },
    ],
  },

  /* ─── DIODES ─── */
  {
    id: 'SOD323', name: 'Diode SOD-323', family: 'D',
    tags: ['diode', 'sod323'],
    pads: [
      { id: 'A', num: '1', x: -0.55, y: 0, w: 0.45, h: 0.7 },
      { id: 'K', num: '2', x: 0.55, y: 0, w: 0.45, h: 0.7 },
    ],
    silk: [{ kind: 'line', x1: 0.2, y1: -0.45, x2: 0.2, y2: 0.45 }],
  },
  {
    id: 'SOD123', name: 'Diode SOD-123', family: 'D',
    tags: ['diode', 'sod123'],
    pads: [
      { id: 'A', num: '1', x: -1.2, y: 0, w: 0.8, h: 0.9 },
      { id: 'K', num: '2', x: 1.2, y: 0, w: 0.8, h: 0.9 },
    ],
    silk: [{ kind: 'line', x1: 0.45, y1: -0.6, x2: 0.45, y2: 0.6 }],
  },
  smd2Pad('D_SMA', 'Diode SMA (DO-214AC)', 'D', 1.5, 2.0, 1.5, 1.1, ['diode', 'sma']),
  smd2Pad('D_SMB', 'Diode SMB (DO-214AA)', 'D', 1.7, 2.5, 2.0, 1.4, ['diode', 'smb']),
  smd2Pad('D_SMC', 'Diode SMC (DO-214AB)', 'D', 2.0, 3.5, 3.0, 1.8, ['diode', 'smc']),

  /* ─── LEDs ─── */
  smd2Pad('LED_0603', 'LED 0603', 'LED', 0.5, 0.8, 0.5, 0.55, ['led', '0603']),
  smd2Pad('LED_0805', 'LED 0805', 'LED', 0.55, 1.2, 0.6, 0.65, ['led', '0805']),
  smd2Pad('LED_1206', 'LED 1206', 'LED', 0.65, 1.6, 1.1, 0.85, ['led', '1206']),
  {
    id: 'LED_3mm', name: 'LED 3mm Through-Hole', family: 'LED',
    tags: ['led', 'through-hole', '3mm'],
    pads: [
      { id: 'A', num: '1', x: -1.27, y: 0, w: 1.4, h: 1.4, shape: 'round', drill: 0.8 },
      { id: 'K', num: '2', x: 1.27, y: 0, w: 1.4, h: 1.4, shape: 'round', drill: 0.8 },
    ],
    silk: [],
  },
  {
    id: 'LED_5mm', name: 'LED 5mm Through-Hole', family: 'LED',
    tags: ['led', 'through-hole', '5mm'],
    pads: [
      { id: 'A', num: '1', x: -1.27, y: 0, w: 1.6, h: 1.6, shape: 'round', drill: 0.9 },
      { id: 'K', num: '2', x: 1.27, y: 0, w: 1.6, h: 1.6, shape: 'round', drill: 0.9 },
    ],
    silk: [],
  },
  {
    id: 'LED_WS2812B', name: 'WS2812B Addressable LED (5050)', family: 'LED',
    tags: ['led', 'ws2812', 'neopixel', 'rgb'],
    pads: [
      { id: '1', num: '1', x: -2.45, y: -1.6, w: 1.0, h: 0.9 },
      { id: '2', num: '2', x: -2.45, y: 1.6, w: 1.0, h: 0.9 },
      { id: '3', num: '3', x: 2.45, y: 1.6, w: 1.0, h: 0.9 },
      { id: '4', num: '4', x: 2.45, y: -1.6, w: 1.0, h: 0.9 },
    ],
    silk: [
      { kind: 'line', x1: -2.5, y1: -2.5, x2: 2.5, y2: -2.5 },
      { kind: 'line', x1: 2.5, y1: -2.5, x2: 2.5, y2: 2.5 },
      { kind: 'line', x1: 2.5, y1: 2.5, x2: -2.5, y2: 2.5 },
      { kind: 'line', x1: -2.5, y1: 2.5, x2: -2.5, y2: -2.5 },
    ],
  },

  /* ─── TRANSISTORS / MOSFETs ─── */
  {
    id: 'SOT23_3', name: 'SOT-23 (3-pad)', family: 'Q',
    tags: ['transistor', 'sot23', 'mosfet'],
    pads: [
      { id: '1', num: '1', x: -0.95, y: 1.0, w: 0.6, h: 0.7 },
      { id: '2', num: '2', x: 0.95, y: 1.0, w: 0.6, h: 0.7 },
      { id: '3', num: '3', x: 0, y: -1.0, w: 0.6, h: 0.7 },
    ],
    silk: [{ kind: 'line', x1: -0.7, y1: -1.5, x2: 0.7, y2: -1.5 }],
  },
  {
    id: 'SOT23_5', name: 'SOT-23-5', family: 'IC',
    tags: ['sot23-5', 'regulator', 'opamp'],
    pads: [
      { id: '1', num: '1', x: -0.95, y: 1.0, w: 0.6, h: 0.55 },
      { id: '2', num: '2', x: 0, y: 1.0, w: 0.6, h: 0.55 },
      { id: '3', num: '3', x: 0.95, y: 1.0, w: 0.6, h: 0.55 },
      { id: '4', num: '4', x: 0.95, y: -1.0, w: 0.6, h: 0.55 },
      { id: '5', num: '5', x: -0.95, y: -1.0, w: 0.6, h: 0.55 },
    ],
    silk: [{ kind: 'line', x1: -1.3, y1: -1.5, x2: 1.3, y2: -1.5 }],
  },
  {
    id: 'SOT23_6', name: 'SOT-23-6 / SOT-363', family: 'IC',
    tags: ['sot23-6', 'sot363'],
    pads: [
      { id: '1', num: '1', x: -0.95, y: 1.0, w: 0.6, h: 0.55 },
      { id: '2', num: '2', x: 0, y: 1.0, w: 0.6, h: 0.55 },
      { id: '3', num: '3', x: 0.95, y: 1.0, w: 0.6, h: 0.55 },
      { id: '4', num: '4', x: 0.95, y: -1.0, w: 0.6, h: 0.55 },
      { id: '5', num: '5', x: 0, y: -1.0, w: 0.6, h: 0.55 },
      { id: '6', num: '6', x: -0.95, y: -1.0, w: 0.6, h: 0.55 },
    ],
    silk: [{ kind: 'line', x1: -1.3, y1: -1.5, x2: 1.3, y2: -1.5 }],
  },
  {
    id: 'SOT223', name: 'SOT-223', family: 'REG',
    tags: ['regulator', 'sot223', 'transistor'],
    pads: [
      { id: '1', num: '1', x: -2.3, y: 3.15, w: 1.0, h: 1.5 },
      { id: '2', num: '2', x: 0, y: 3.15, w: 1.0, h: 1.5 },
      { id: '3', num: '3', x: 2.3, y: 3.15, w: 1.0, h: 1.5 },
      { id: '4', num: '4', x: 0, y: -3.15, w: 3.0, h: 1.5 },
    ],
    silk: [
      { kind: 'line', x1: -3.3, y1: -2.3, x2: 3.3, y2: -2.3 },
      { kind: 'line', x1: -3.3, y1: 2.3, x2: 3.3, y2: 2.3 },
    ],
  },
  {
    id: 'TO220_3', name: 'TO-220 (3-lead)', family: 'REG',
    tags: ['to220', 'regulator', 'power'],
    pads: [
      { id: 'in', num: '1', x: -2.54, y: 2.3, w: 1.2, h: 1.4, drill: 1.0 },
      { id: 'gnd', num: '2', x: 0, y: 2.3, w: 1.2, h: 1.4, drill: 1.0 },
      { id: 'out', num: '3', x: 2.54, y: 2.3, w: 1.2, h: 1.4, drill: 1.0 },
    ],
    silk: [
      { kind: 'line', x1: -5, y1: -6, x2: 5, y2: -6 },
      { kind: 'line', x1: -5, y1: -6, x2: -5, y2: 8 },
      { kind: 'line', x1: 5, y1: -6, x2: 5, y2: 8 },
    ],
  },
  {
    id: 'DPAK', name: 'DPAK / TO-252', family: 'Q',
    tags: ['dpak', 'to252', 'mosfet', 'power'],
    pads: [
      { id: '1', num: '1', x: -2.3, y: 3.5, w: 1.2, h: 1.5 },
      { id: '3', num: '3', x: 2.3, y: 3.5, w: 1.2, h: 1.5 },
      { id: '2', num: '2', x: 0, y: -1.0, w: 5.6, h: 5.6 },
    ],
    silk: [
      { kind: 'line', x1: -3.3, y1: -4.0, x2: 3.3, y2: -4.0 },
      { kind: 'line', x1: -3.3, y1: 2.5, x2: 3.3, y2: 2.5 },
    ],
  },
  {
    id: 'D2PAK', name: 'D2PAK / TO-263', family: 'Q',
    tags: ['d2pak', 'to263', 'mosfet', 'power'],
    pads: [
      { id: '1', num: '1', x: -2.54, y: 5.0, w: 1.5, h: 2.0 },
      { id: '3', num: '3', x: 2.54, y: 5.0, w: 1.5, h: 2.0 },
      { id: '2', num: '2', x: 0, y: -1.5, w: 7.0, h: 7.0 },
    ],
    silk: [
      { kind: 'line', x1: -4.5, y1: -5.5, x2: 4.5, y2: -5.5 },
      { kind: 'line', x1: -4.5, y1: 3.5, x2: 4.5, y2: 3.5 },
    ],
  },

  /* ─── SOIC ICs ─── */
  soicFootprint('SOIC8', 'SOIC-8 (1.27mm pitch)', 8, 1.27, 1.5, 0.6, 5.4, 3.8, 5.0),
  soicFootprint('SOIC14', 'SOIC-14 (1.27mm pitch)', 14, 1.27, 1.5, 0.6, 5.4, 3.8, 8.7),
  soicFootprint('SOIC16', 'SOIC-16 (1.27mm pitch)', 16, 1.27, 1.5, 0.6, 5.4, 3.8, 9.9),
  soicFootprint('SOIC20', 'SOIC-20 (1.27mm pitch)', 20, 1.27, 1.5, 0.6, 7.6, 5.2, 12.8),
  soicFootprint('SOIC28W', 'SOIC-28 Wide (1.27mm pitch)', 28, 1.27, 1.5, 0.6, 10.4, 7.4, 17.7),

  /* ─── SSOP / TSSOP ─── */
  soicFootprint('SSOP8', 'SSOP-8 (0.65mm pitch)', 8, 0.65, 1.2, 0.4, 4.3, 3.0, 3.0),
  soicFootprint('SSOP16', 'SSOP-16 (0.65mm pitch)', 16, 0.65, 1.2, 0.4, 4.3, 3.0, 5.5),
  soicFootprint('SSOP20', 'SSOP-20 (0.65mm pitch)', 20, 0.65, 1.2, 0.4, 5.8, 4.2, 7.0),
  soicFootprint('TSSOP8', 'TSSOP-8 (0.65mm pitch)', 8, 0.65, 1.0, 0.35, 4.3, 2.8, 3.0),
  soicFootprint('TSSOP14', 'TSSOP-14 (0.65mm pitch)', 14, 0.65, 1.0, 0.35, 4.3, 2.8, 5.0),
  soicFootprint('TSSOP16', 'TSSOP-16 (0.65mm pitch)', 16, 0.65, 1.0, 0.35, 4.3, 2.8, 5.5),
  soicFootprint('TSSOP20', 'TSSOP-20 (0.65mm pitch)', 20, 0.65, 1.0, 0.35, 4.3, 2.8, 7.0),
  soicFootprint('TSSOP28', 'TSSOP-28 (0.65mm pitch)', 28, 0.65, 1.0, 0.35, 4.3, 2.8, 9.5),

  /* ─── MSOP ─── */
  soicFootprint('MSOP8', 'MSOP-8 (0.65mm pitch)', 8, 0.65, 0.9, 0.35, 3.8, 2.4, 3.0),
  soicFootprint('MSOP10', 'MSOP-10 (0.5mm pitch)', 10, 0.5, 0.9, 0.3, 3.8, 2.4, 3.0),

  /* ─── QFP ─── */
  qfpFootprint('TQFP32', 'TQFP-32 (0.8mm pitch)', 32, 0.8, 1.2, 0.4, 7.0),
  qfpFootprint('TQFP44', 'TQFP-44 (0.8mm pitch)', 44, 0.8, 1.2, 0.4, 10.0),
  qfpFootprint('TQFP48', 'TQFP-48 (0.5mm pitch)', 48, 0.5, 1.2, 0.3, 7.0),
  qfpFootprint('LQFP48', 'LQFP-48 (0.5mm pitch)', 48, 0.5, 1.4, 0.3, 9.0),
  qfpFootprint('TQFP64', 'TQFP-64 (0.5mm pitch)', 64, 0.5, 1.2, 0.3, 10.0),
  qfpFootprint('LQFP64', 'LQFP-64 (0.5mm pitch)', 64, 0.5, 1.4, 0.3, 12.0),
  qfpFootprint('TQFP100', 'TQFP-100 (0.5mm pitch)', 100, 0.5, 1.2, 0.3, 14.0),
  qfpFootprint('LQFP144', 'LQFP-144 (0.5mm pitch)', 144, 0.5, 1.4, 0.3, 20.0),

  /* ─── QFN / DFN ─── */
  {
    id: 'QFN16_3x3', name: 'QFN-16 3x3mm (0.5mm pitch)', family: 'IC',
    tags: ['ic', 'qfn', 'dfn'],
    pads: (() => {
      const p = []; let n = 1;
      const pitch = 0.5, padW = 0.25, padL = 0.7, edge = 1.5;
      for (let i = 0; i < 4; i++) { p.push({ id: `${n}`, num: `${n}`, x: -0.75 + i * pitch, y: edge, w: padW, h: padL }); n++; }
      for (let i = 0; i < 4; i++) { p.push({ id: `${n}`, num: `${n}`, x: edge, y: 0.75 - i * pitch, w: padL, h: padW }); n++; }
      for (let i = 0; i < 4; i++) { p.push({ id: `${n}`, num: `${n}`, x: 0.75 - i * pitch, y: -edge, w: padW, h: padL }); n++; }
      for (let i = 0; i < 4; i++) { p.push({ id: `${n}`, num: `${n}`, x: -edge, y: -0.75 + i * pitch, w: padL, h: padW }); n++; }
      p.push({ id: 'EP', num: '17', x: 0, y: 0, w: 1.5, h: 1.5 }); // exposed pad
      return p;
    })(),
    silk: [
      { kind: 'line', x1: -1.5, y1: -1.5, x2: 1.5, y2: -1.5 },
      { kind: 'line', x1: 1.5, y1: -1.5, x2: 1.5, y2: 1.5 },
      { kind: 'line', x1: 1.5, y1: 1.5, x2: -1.5, y2: 1.5 },
      { kind: 'line', x1: -1.5, y1: 1.5, x2: -1.5, y2: -1.5 },
    ],
  },
  {
    id: 'QFN32_5x5', name: 'QFN-32 5x5mm (0.5mm pitch)', family: 'IC',
    tags: ['ic', 'qfn'],
    pads: (() => {
      const p = []; let n = 1;
      const pitch = 0.5, padW = 0.25, padL = 0.8, edge = 2.5;
      for (let i = 0; i < 8; i++) { p.push({ id: `${n}`, num: `${n}`, x: -1.75 + i * pitch, y: edge, w: padW, h: padL }); n++; }
      for (let i = 0; i < 8; i++) { p.push({ id: `${n}`, num: `${n}`, x: edge, y: 1.75 - i * pitch, w: padL, h: padW }); n++; }
      for (let i = 0; i < 8; i++) { p.push({ id: `${n}`, num: `${n}`, x: 1.75 - i * pitch, y: -edge, w: padW, h: padL }); n++; }
      for (let i = 0; i < 8; i++) { p.push({ id: `${n}`, num: `${n}`, x: -edge, y: -1.75 + i * pitch, w: padL, h: padW }); n++; }
      p.push({ id: 'EP', num: '33', x: 0, y: 0, w: 3.0, h: 3.0 });
      return p;
    })(),
    silk: [
      { kind: 'line', x1: -2.5, y1: -2.5, x2: 2.5, y2: -2.5 },
      { kind: 'line', x1: 2.5, y1: -2.5, x2: 2.5, y2: 2.5 },
      { kind: 'line', x1: 2.5, y1: 2.5, x2: -2.5, y2: 2.5 },
      { kind: 'line', x1: -2.5, y1: 2.5, x2: -2.5, y2: -2.5 },
    ],
  },
  {
    id: 'QFN48_7x7', name: 'QFN-48 7x7mm (0.5mm pitch)', family: 'IC',
    tags: ['ic', 'qfn'],
    pads: (() => {
      const p = []; let n = 1;
      const pitch = 0.5, padW = 0.25, padL = 0.8, edge = 3.5;
      for (let i = 0; i < 12; i++) { p.push({ id: `${n}`, num: `${n}`, x: -2.75 + i * pitch, y: edge, w: padW, h: padL }); n++; }
      for (let i = 0; i < 12; i++) { p.push({ id: `${n}`, num: `${n}`, x: edge, y: 2.75 - i * pitch, w: padL, h: padW }); n++; }
      for (let i = 0; i < 12; i++) { p.push({ id: `${n}`, num: `${n}`, x: 2.75 - i * pitch, y: -edge, w: padW, h: padL }); n++; }
      for (let i = 0; i < 12; i++) { p.push({ id: `${n}`, num: `${n}`, x: -edge, y: -2.75 + i * pitch, w: padL, h: padW }); n++; }
      p.push({ id: 'EP', num: '49', x: 0, y: 0, w: 4.5, h: 4.5 });
      return p;
    })(),
    silk: [
      { kind: 'line', x1: -3.5, y1: -3.5, x2: 3.5, y2: -3.5 },
      { kind: 'line', x1: 3.5, y1: -3.5, x2: 3.5, y2: 3.5 },
      { kind: 'line', x1: 3.5, y1: 3.5, x2: -3.5, y2: 3.5 },
      { kind: 'line', x1: -3.5, y1: 3.5, x2: -3.5, y2: -3.5 },
    ],
  },

  /* ─── DIP (Through-Hole ICs) ─── */
  dipFootprint('DIP8', 'DIP-8 (2.54mm pitch)', 8, 2.54, 1.6, 1.2, 7.62),
  dipFootprint('DIP14', 'DIP-14 (2.54mm pitch)', 14, 2.54, 1.6, 1.2, 7.62),
  dipFootprint('DIP16', 'DIP-16 (2.54mm pitch)', 16, 2.54, 1.6, 1.2, 7.62),
  dipFootprint('DIP18', 'DIP-18 (2.54mm pitch)', 18, 2.54, 1.6, 1.2, 7.62),
  dipFootprint('DIP20', 'DIP-20 (2.54mm pitch)', 20, 2.54, 1.6, 1.2, 7.62),
  dipFootprint('DIP28', 'DIP-28 (2.54mm pitch)', 28, 2.54, 1.6, 1.2, 7.62),
  dipFootprint('DIP40', 'DIP-40 Wide (2.54mm pitch)', 40, 2.54, 1.6, 1.2, 15.24),

  /* ─── CONNECTORS / HEADERS ─── */
  headerFootprint('HDR_1x2', '1x2 Pin Header (2.54mm)', 2, 1, 2.54),
  headerFootprint('HDR_1x3', '1x3 Pin Header (2.54mm)', 3, 1, 2.54),
  headerFootprint('HDR_1x4', '1x4 Pin Header (2.54mm)', 4, 1, 2.54),
  headerFootprint('HDR_1x5', '1x5 Pin Header (2.54mm)', 5, 1, 2.54),
  headerFootprint('HDR_1x6', '1x6 Pin Header (2.54mm)', 6, 1, 2.54),
  headerFootprint('HDR_1x8', '1x8 Pin Header (2.54mm)', 8, 1, 2.54),
  headerFootprint('HDR_1x10', '1x10 Pin Header (2.54mm)', 10, 1, 2.54),
  headerFootprint('HDR_1x20', '1x20 Pin Header (2.54mm)', 20, 1, 2.54),
  headerFootprint('HDR_2x2', '2x2 Pin Header (2.54mm)', 4, 2, 2.54),
  headerFootprint('HDR_2x3', '2x3 Pin Header (2.54mm)', 6, 2, 2.54),
  headerFootprint('HDR_2x4', '2x4 Pin Header (2.54mm)', 8, 2, 2.54),
  headerFootprint('HDR_2x5', '2x5 Pin Header (2.54mm)', 10, 2, 2.54),
  headerFootprint('HDR_2x10', '2x10 Pin Header (2.54mm)', 20, 2, 2.54),
  headerFootprint('HDR_2x17', '2x17 Pin Header (2.54mm) — RPi', 34, 2, 2.54),
  headerFootprint('HDR_2x20', '2x20 Pin Header (2.54mm)', 40, 2, 2.54),
  {
    id: 'PIN2_HDR', name: '2-pin 2.54 header', family: 'V',
    tags: ['connector', 'header', 'power'],
    pads: [
      { id: '1', num: '1', x: -1.27, y: 0, w: 1.4, h: 1.4, drill: 1.0 },
      { id: '2', num: '2', x: 1.27, y: 0, w: 1.4, h: 1.4, drill: 1.0 },
    ],
    silk: [],
  },

  /* ─── USB Connectors ─── */
  {
    id: 'USB_C_16', name: 'USB Type-C 16-pin', family: 'J',
    tags: ['usb', 'usb-c', 'connector'],
    pads: (() => {
      const p = [];
      const pins = ['A1','A4','A5','A6','A7','A8','A9','A12','B1','B4','B5','B6','B7','B8','B9','B12'];
      const xPositions = [-3.25,-2.0,-1.5,-1.0,-0.5,0,0.5,1.0];
      for (let i = 0; i < 8; i++) {
        p.push({ id: pins[i], num: `${i + 1}`, x: xPositions[i], y: 3.5, w: 0.3, h: 0.8 });
      }
      for (let i = 0; i < 8; i++) {
        p.push({ id: pins[i + 8], num: `${i + 9}`, x: xPositions[i], y: 4.3, w: 0.3, h: 0.8 });
      }
      // Shield pins
      p.push({ id: 'S1', num: 'S1', x: -4.3, y: 2.5, w: 1.0, h: 1.5 });
      p.push({ id: 'S2', num: 'S2', x: 4.3, y: 2.5, w: 1.0, h: 1.5 });
      return p;
    })(),
    silk: [
      { kind: 'line', x1: -4.5, y1: 0, x2: 4.5, y2: 0 },
      { kind: 'line', x1: -4.5, y1: 0, x2: -4.5, y2: 5.5 },
      { kind: 'line', x1: 4.5, y1: 0, x2: 4.5, y2: 5.5 },
    ],
  },
  {
    id: 'USB_MICRO_B', name: 'USB Micro-B', family: 'J',
    tags: ['usb', 'micro-b', 'connector'],
    pads: [
      { id: '1', num: '1', x: -1.3, y: 2.7, w: 0.4, h: 1.2 },
      { id: '2', num: '2', x: -0.65, y: 2.7, w: 0.4, h: 1.2 },
      { id: '3', num: '3', x: 0, y: 2.7, w: 0.4, h: 1.2 },
      { id: '4', num: '4', x: 0.65, y: 2.7, w: 0.4, h: 1.2 },
      { id: '5', num: '5', x: 1.3, y: 2.7, w: 0.4, h: 1.2 },
      { id: 'S1', num: 'S1', x: -3.5, y: 1.5, w: 1.5, h: 1.8 },
      { id: 'S2', num: 'S2', x: 3.5, y: 1.5, w: 1.5, h: 1.8 },
    ],
    silk: [
      { kind: 'line', x1: -3.8, y1: 0, x2: 3.8, y2: 0 },
      { kind: 'line', x1: -3.8, y1: 0, x2: -3.8, y2: 3.5 },
      { kind: 'line', x1: 3.8, y1: 0, x2: 3.8, y2: 3.5 },
    ],
  },

  /* ─── CRYSTALS / OSCILLATORS ─── */
  {
    id: 'XTAL_3215', name: 'Crystal 3.2x1.5mm', family: 'Y',
    tags: ['crystal', 'oscillator', '32.768kHz'],
    pads: [
      { id: '1', num: '1', x: -1.0, y: 0, w: 0.9, h: 1.2 },
      { id: '2', num: '2', x: 1.0, y: 0, w: 0.9, h: 1.2 },
    ],
    silk: [
      { kind: 'line', x1: -1.6, y1: -0.75, x2: 1.6, y2: -0.75 },
      { kind: 'line', x1: -1.6, y1: 0.75, x2: 1.6, y2: 0.75 },
    ],
  },
  {
    id: 'XTAL_5032', name: 'Crystal 5.0x3.2mm', family: 'Y',
    tags: ['crystal', 'oscillator'],
    pads: [
      { id: '1', num: '1', x: -1.8, y: 0, w: 1.2, h: 1.8 },
      { id: '2', num: '2', x: 1.8, y: 0, w: 1.2, h: 1.8 },
    ],
    silk: [
      { kind: 'line', x1: -2.5, y1: -1.6, x2: 2.5, y2: -1.6 },
      { kind: 'line', x1: -2.5, y1: 1.6, x2: 2.5, y2: 1.6 },
    ],
  },
  {
    id: 'XTAL_HC49', name: 'Crystal HC-49/S SMD', family: 'Y',
    tags: ['crystal', 'oscillator', 'hc49'],
    pads: [
      { id: '1', num: '1', x: -2.44, y: 0, w: 1.8, h: 2.2 },
      { id: '2', num: '2', x: 2.44, y: 0, w: 1.8, h: 2.2 },
    ],
    silk: [
      { kind: 'line', x1: -5.6, y1: -2.4, x2: 5.6, y2: -2.4 },
      { kind: 'line', x1: -5.6, y1: 2.4, x2: 5.6, y2: 2.4 },
    ],
  },

  /* ─── FERRITE BEADS ─── */
  smd2Pad('FB_0402', 'Ferrite Bead 0402', 'FB', 0.4, 0.5, 0.3, 0.4, ['ferrite', '0402']),
  smd2Pad('FB_0603', 'Ferrite Bead 0603', 'FB', 0.5, 0.8, 0.5, 0.55, ['ferrite', '0603']),
  smd2Pad('FB_0805', 'Ferrite Bead 0805', 'FB', 0.55, 1.2, 0.6, 0.65, ['ferrite', '0805']),

  /* ─── FUSES ─── */
  smd2Pad('FUSE_0603', 'Fuse 0603', 'F', 0.5, 0.8, 0.5, 0.55, ['fuse', '0603']),
  smd2Pad('FUSE_1206', 'Fuse 1206', 'F', 0.65, 1.6, 1.1, 0.85, ['fuse', '1206']),

  /* ─── SCREW TERMINALS ─── */
  {
    id: 'TERM_2P_5mm', name: '2-pos Screw Terminal (5.0mm)', family: 'J',
    tags: ['terminal', 'screw', 'power', 'connector'],
    pads: [
      { id: '1', num: '1', x: -2.5, y: 0, w: 2.2, h: 2.2, shape: 'round', drill: 1.3 },
      { id: '2', num: '2', x: 2.5, y: 0, w: 2.2, h: 2.2, shape: 'round', drill: 1.3 },
    ],
    silk: [
      { kind: 'line', x1: -5.0, y1: -3.8, x2: 5.0, y2: -3.8 },
      { kind: 'line', x1: 5.0, y1: -3.8, x2: 5.0, y2: 3.8 },
      { kind: 'line', x1: 5.0, y1: 3.8, x2: -5.0, y2: 3.8 },
      { kind: 'line', x1: -5.0, y1: 3.8, x2: -5.0, y2: -3.8 },
    ],
  },
  {
    id: 'TERM_3P_5mm', name: '3-pos Screw Terminal (5.0mm)', family: 'J',
    tags: ['terminal', 'screw', 'connector'],
    pads: [
      { id: '1', num: '1', x: -5.0, y: 0, w: 2.2, h: 2.2, shape: 'round', drill: 1.3 },
      { id: '2', num: '2', x: 0, y: 0, w: 2.2, h: 2.2, shape: 'round', drill: 1.3 },
      { id: '3', num: '3', x: 5.0, y: 0, w: 2.2, h: 2.2, shape: 'round', drill: 1.3 },
    ],
    silk: [
      { kind: 'line', x1: -7.5, y1: -3.8, x2: 7.5, y2: -3.8 },
      { kind: 'line', x1: 7.5, y1: -3.8, x2: 7.5, y2: 3.8 },
      { kind: 'line', x1: 7.5, y1: 3.8, x2: -7.5, y2: 3.8 },
      { kind: 'line', x1: -7.5, y1: 3.8, x2: -7.5, y2: -3.8 },
    ],
  },

  /* ─── MISC: Test Points, Mounting Holes, Fiducials ─── */
  {
    id: 'TP_1mm', name: 'Test Point 1mm', family: 'TP',
    tags: ['testpoint', 'debug'],
    pads: [{ id: '1', num: '1', x: 0, y: 0, w: 1.0, h: 1.0, shape: 'round' }],
    silk: [],
  },
  {
    id: 'TP_2mm', name: 'Test Point 2mm', family: 'TP',
    tags: ['testpoint', 'debug'],
    pads: [{ id: '1', num: '1', x: 0, y: 0, w: 2.0, h: 2.0, shape: 'round' }],
    silk: [],
  },
  {
    id: 'MH_M3', name: 'Mounting Hole M3 (3.2mm)', family: 'MH',
    tags: ['mounting', 'hole', 'mechanical'],
    pads: [{ id: '1', num: '1', x: 0, y: 0, w: 6.0, h: 6.0, shape: 'round', drill: 3.2 }],
    silk: [],
  },
  {
    id: 'MH_M2_5', name: 'Mounting Hole M2.5 (2.7mm)', family: 'MH',
    tags: ['mounting', 'hole', 'mechanical'],
    pads: [{ id: '1', num: '1', x: 0, y: 0, w: 5.0, h: 5.0, shape: 'round', drill: 2.7 }],
    silk: [],
  },
  {
    id: 'FID_1mm', name: 'Fiducial Mark 1mm', family: 'FID',
    tags: ['fiducial', 'alignment', 'assembly'],
    pads: [{ id: '1', num: '1', x: 0, y: 0, w: 1.0, h: 1.0, shape: 'round' }],
    silk: [],
  },

  /* ─── CHIP_4SQ (legacy compat) ─── */
  {
    id: 'CHIP_4SQ', name: '4-pad chip (E/G / quad)', family: 'IC',
    pads: [
      { id: '1', num: '1', x: -1.4, y: -1.4, w: 0.9, h: 0.9 },
      { id: '2', num: '2', x: 1.4, y: -1.4, w: 0.9, h: 0.9 },
      { id: '3', num: '3', x: 1.4, y: 1.4, w: 0.9, h: 0.9 },
      { id: '4', num: '4', x: -1.4, y: 1.4, w: 0.9, h: 0.9 },
    ],
    silk: [],
  },

  /* ─── BGA ─── */
  {
    id: 'BGA64_8x8', name: 'BGA-64 (8x8, 0.8mm pitch)', family: 'IC',
    tags: ['ic', 'bga'],
    pads: (() => {
      const p = []; let n = 1;
      const rows = 'ABCDEFGH';
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          p.push({
            id: `${rows[r]}${c + 1}`, num: `${n}`,
            x: (c - 3.5) * 0.8, y: (r - 3.5) * 0.8,
            w: 0.4, h: 0.4, shape: 'round',
          });
          n++;
        }
      }
      return p;
    })(),
    silk: [
      { kind: 'line', x1: -3.5, y1: -3.5, x2: 3.5, y2: -3.5 },
      { kind: 'line', x1: 3.5, y1: -3.5, x2: 3.5, y2: 3.5 },
      { kind: 'line', x1: 3.5, y1: 3.5, x2: -3.5, y2: 3.5 },
      { kind: 'line', x1: -3.5, y1: 3.5, x2: -3.5, y2: -3.5 },
    ],
  },
  {
    id: 'BGA256_16x16', name: 'BGA-256 (16x16, 1.0mm pitch)', family: 'IC',
    tags: ['ic', 'bga'],
    pads: (() => {
      const p = []; let n = 1;
      const rows = 'ABCDEFGHJKLMNPRT';
      for (let r = 0; r < 16; r++) {
        for (let c = 0; c < 16; c++) {
          p.push({
            id: `${rows[r]}${c + 1}`, num: `${n}`,
            x: (c - 7.5) * 1.0, y: (r - 7.5) * 1.0,
            w: 0.5, h: 0.5, shape: 'round',
          });
          n++;
        }
      }
      return p;
    })(),
    silk: [
      { kind: 'line', x1: -8.5, y1: -8.5, x2: 8.5, y2: -8.5 },
      { kind: 'line', x1: 8.5, y1: -8.5, x2: 8.5, y2: 8.5 },
      { kind: 'line', x1: 8.5, y1: 8.5, x2: -8.5, y2: 8.5 },
      { kind: 'line', x1: -8.5, y1: 8.5, x2: -8.5, y2: -8.5 },
    ],
  },

  /* ─── SWITCHES ─── */
  {
    id: 'SW_TACT_6mm', name: 'Tactile Switch 6x6mm', family: 'SW',
    tags: ['switch', 'tactile', 'button'],
    pads: [
      { id: '1', num: '1', x: -3.25, y: -2.25, w: 1.5, h: 1.2 },
      { id: '2', num: '2', x: 3.25, y: -2.25, w: 1.5, h: 1.2 },
      { id: '3', num: '3', x: -3.25, y: 2.25, w: 1.5, h: 1.2 },
      { id: '4', num: '4', x: 3.25, y: 2.25, w: 1.5, h: 1.2 },
    ],
    silk: [
      { kind: 'line', x1: -3, y1: -3, x2: 3, y2: -3 },
      { kind: 'line', x1: 3, y1: -3, x2: 3, y2: 3 },
      { kind: 'line', x1: 3, y1: 3, x2: -3, y2: 3 },
      { kind: 'line', x1: -3, y1: 3, x2: -3, y2: -3 },
    ],
  },
  {
    id: 'SW_SLIDE_SPDT', name: 'Slide Switch SPDT', family: 'SW',
    tags: ['switch', 'slide'],
    pads: [
      { id: '1', num: '1', x: -2.5, y: 0, w: 1.2, h: 1.2, drill: 0.8 },
      { id: '2', num: '2', x: 0, y: 0, w: 1.2, h: 1.2, drill: 0.8 },
      { id: '3', num: '3', x: 2.5, y: 0, w: 1.2, h: 1.2, drill: 0.8 },
    ],
    silk: [
      { kind: 'line', x1: -4.5, y1: -2.0, x2: 4.5, y2: -2.0 },
      { kind: 'line', x1: 4.5, y1: -2.0, x2: 4.5, y2: 2.0 },
      { kind: 'line', x1: 4.5, y1: 2.0, x2: -4.5, y2: 2.0 },
      { kind: 'line', x1: -4.5, y1: 2.0, x2: -4.5, y2: -2.0 },
    ],
  },

  /* ─── SD Card Slot ─── */
  {
    id: 'SD_MICRO', name: 'MicroSD Card Slot', family: 'J',
    tags: ['sd', 'microsd', 'connector', 'storage'],
    pads: (() => {
      const p = [];
      for (let i = 0; i < 8; i++) {
        p.push({ id: `${i + 1}`, num: `${i + 1}`, x: -3.85 + i * 1.1, y: 4.0, w: 0.7, h: 1.5 });
      }
      p.push({ id: 'S1', num: 'S1', x: -6.8, y: 0, w: 1.2, h: 1.5 });
      p.push({ id: 'S2', num: 'S2', x: 6.8, y: 0, w: 1.2, h: 1.5 });
      return p;
    })(),
    silk: [
      { kind: 'line', x1: -7.0, y1: -3.5, x2: 7.0, y2: -3.5 },
      { kind: 'line', x1: -7.0, y1: 5.5, x2: 7.0, y2: 5.5 },
    ],
  },
];

/* ─── Lookup / API ─── */
const BY_ID = Object.fromEntries(FOOTPRINTS.map(f => [f.id, f]));

export function getFootprint(id) { return BY_ID[id] || null; }

export function listFootprintSummaries() {
  return FOOTPRINTS.map(f => ({ id: f.id, name: f.name, family: f.family, tags: f.tags || [] }));
}

export function addFootprint(footprintDef) {
  if (!BY_ID[footprintDef.id]) {
    FOOTPRINTS.push(footprintDef);
    BY_ID[footprintDef.id] = footprintDef;
  }
}

/**
 * Search footprints by keyword (matches id, name, family, tags).
 * @param {string} query
 * @returns {FootprintDef[]}
 */
export function searchFootprints(query) {
  const q = String(query).toLowerCase().trim();
  if (!q) return FOOTPRINTS;
  return FOOTPRINTS.filter(f => {
    const haystack = `${f.id} ${f.name} ${f.family} ${(f.tags || []).join(' ')}`.toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Get all unique families in the library.
 */
export function listFamilies() {
  const families = new Set();
  for (const f of FOOTPRINTS) families.add(f.family);
  return [...families].sort();
}
