/**
 * Export Noze PCB document to industry-standard `.kicad_pcb` s-expression (subset).
 * Placements (embedded footprints from built-in lib), tracks, vias, board outline.
 * Copper pours (doc.polygons) are emitted as filled (zone) regions for interchange.
 */

import { activeCopperLayerIds, migratePcbDoc } from './pcbDoc.js';

const KICAD_PCB_VERSION = '20240108';

/** Interchange format copper layer ordinals (canonical names match pcbDoc). */
const COPPER_LAYER_ORDINAL = {
    'F.Cu': 0,
    'In1.Cu': 1,
    'In2.Cu': 2,
    'In3.Cu': 3,
    'In4.Cu': 4,
    'In5.Cu': 5,
    'In6.Cu': 6,
    'B.Cu': 31,
};

/** Standard technical layers after copper (interchange default naming). */
const TECH_LAYERS = [
    [32, 'B.Adhes', 'user'],
    [33, 'F.Adhes', 'user'],
    [34, 'B.Paste', 'user'],
    [35, 'F.Paste', 'user'],
    [36, 'B.SilkS', 'user'],
    [37, 'F.SilkS', 'user'],
    [38, 'B.Mask', 'user'],
    [39, 'F.Mask', 'user'],
    [40, 'Dwgs.User', 'user'],
    [41, 'Cmts.User', 'user'],
    [42, 'Eco1.User', 'user'],
    [43, 'Eco2.User', 'user'],
    [44, 'Edge.Cuts', 'user'],
    [45, 'Margin', 'user'],
    [46, 'B.CrtYd', 'user'],
    [47, 'F.CrtYd', 'user'],
    [48, 'B.Fab', 'user'],
    [49, 'F.Fab', 'user'],
];

/** @param {string} s */
function q(s) {
    return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** @param {number} n */
function fmtMm(n) {
    if (!Number.isFinite(n)) return '0';
    const s = Number(n).toFixed(6);
    return s.replace(/\.?0+$/, '') || '0';
}

function randomUuid() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const b = new Uint8Array(16);
        crypto.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
    return '00000000-0000-4000-8000-000000000001';
}

/** @param {string} layerId */
function kicadLayerString(layerId) {
    const id = String(layerId || 'F.Cu');
    if (COPPER_LAYER_ORDINAL[id] !== undefined) return q(id);
    return q('F.Cu');
}

/**
 * @param {object} doc — migrated pcb doc
 * @returns {string}
 */
function buildLayersSection(doc) {
    const stack = activeCopperLayerIds(doc);
    const lines = ['  (layers'];
    for (const id of stack) {
        const ord = COPPER_LAYER_ORDINAL[id];
        if (ord === undefined) continue;
        lines.push(`    (${ord} ${q(id)} signal)`);
    }
    for (const [ord, name, typ] of TECH_LAYERS) {
        lines.push(`    (${ord} ${q(name)} ${typ})`);
    }
    lines.push('  )');
    return lines.join('\n');
}

function buildSetupSection() {
    return `  (setup
    (pad_to_mask_clearance 0)
    (pcbplotparams
      (layerselection 0x00010fc_ffffffff)
      (plot_on_all_layers_selection 0x0000000_00000000)
      (disableapertmacros false)
      (usegerberextensions true)
      (usegerberattributes true)
      (usegerberadvancedattributes true)
      (creategerberjobfile true)
      (svguseinch false)
      (svgprecision 6)
      (excludeedgelayer true)
      (plotframeref false)
      (viasonmask false)
      (mode 1)
      (useauxorigin false)
      (hpglpennumber 1)
      (hpglpenspeed 20)
      (hpglpendiameter 15)
      (dxfpolygonmode true)
      (dxfimperialunits true)
      (dxfusepcbnewfont true)
      (psnegative false)
      (psa4output false)
      (plotreference true)
      (plotvalue true)
      (plotinvisibletext false)
      (sketchpadsonfab false)
      (subtractmaskfromsilk false)
      (outputformat 1)
      (mirror false)
      (drillshape 1)
      (scaleselection 1)
      (outputdirectory "")
    )
  )`;
}

/**
 * Collect unique net names (non-empty strings).
 * @param {object} doc
 * @returns {string[]}
 */
function collectNetNames(doc) {
    const set = new Set();
    for (const pl of doc.placements || []) {
        const pn = pl.padNets;
        if (pn && typeof pn === 'object') {
            for (const v of Object.values(pn)) {
                if (v != null && String(v).trim()) set.add(String(v).trim());
            }
        }
    }
    for (const t of doc.tracks || []) {
        if (t?.net != null && String(t.net).trim()) set.add(String(t.net).trim());
    }
    for (const v of doc.vias || []) {
        if (v?.net != null && String(v.net).trim()) set.add(String(v.net).trim());
    }
    for (const z of doc.polygons || []) {
        if (z?.net != null && String(z.net).trim()) set.add(String(z.net).trim());
    }
    return [...set].sort();
}

/**
 * @param {object} doc
 * @param {(id: string) => import('./footprintLib.js').FootprintDef | null} getFootprint
 * @returns {string}
 */
export function exportPcbDocToKicadPcb(doc, getFootprint) {
    const d = migratePcbDoc(doc);
    const stack = activeCopperLayerIds(d);
    const outerTop = stack[0] || 'F.Cu';
    const outerBot = stack[stack.length - 1] || 'B.Cu';

    const netNames = collectNetNames(d);
    /** @type {Map<string, number>} */
    const netOrdinal = new Map();
    netOrdinal.set('', 0);
    let ni = 1;
    for (const name of netNames) {
        netOrdinal.set(name, ni++);
    }

    const W = Number(d.meta?.boardWmm) || 80;
    const H = Number(d.meta?.boardHmm) || 50;
    const title = (d.meta?.name && String(d.meta.name).trim()) || 'Noze board';

    const parts = [];
    parts.push(`(kicad_pcb (version ${KICAD_PCB_VERSION}) (generator "nozeplot")`);
    parts.push('');
    parts.push('  (general');
    parts.push('    (thickness 1.6)');
    parts.push('  )');
    parts.push('');
    parts.push('  (paper "A4")');
    parts.push('');
    parts.push(`  (title_block (title ${q(title)}))`);
    parts.push('');
    parts.push(buildLayersSection(d));
    parts.push('');
    parts.push(buildSetupSection());
    parts.push('');
    parts.push('  (net 0 "")');
    for (const name of netNames) {
        parts.push(`  (net ${netOrdinal.get(name)} ${q(name)})`);
    }
    parts.push('');

    for (const pl of d.placements || []) {
        const fp = getFootprint?.(pl.footprintId);
        const ref = String(pl.ref || 'FP').replace(/"/g, "'");
        const val = String(pl.value ?? '').replace(/"/g, "'");
        const px = Number(pl.x) || 0;
        const py = Number(pl.y) || 0;
        const rot = Number(pl.rot) || 0;
        const tedit = Math.floor(Date.now() / 1000).toString(16);
        const libId = fp?.id || pl.footprintId || 'unknown';
        const descr = fp?.name || libId;

        const padLines = [];
        if (fp && Array.isArray(fp.pads)) {
            for (const pad of fp.pads) {
                const num = String(pad.num || pad.id || '1');
                const pnx = Number(pad.x) || 0;
                const pny = Number(pad.y) || 0;
                const pw = Number(pad.w) || 0.5;
                const ph = Number(pad.h) || 0.5;
                const netKey =
                    pl.padNets && typeof pl.padNets === 'object'
                        ? pl.padNets[pad.num] || pl.padNets[pad.id] || pl.padNets[num]
                        : '';
                const netStr = netKey != null && String(netKey).trim() ? String(netKey).trim() : '';
                const nOrd = netOrdinal.has(netStr) ? netOrdinal.get(netStr) : 0;
                const netSexpr =
                    nOrd === 0 ? '' : `\n      (net ${nOrd} ${q(netStr)})`;
                padLines.push(
                    `    (pad ${q(num)} smd rect (at ${fmtMm(pnx)} ${fmtMm(pny)}) (size ${fmtMm(pw)} ${fmtMm(
                        ph,
                    )}) (layers "F.Cu" "F.Paste" "F.Mask")${netSexpr}\n      (uuid "${randomUuid()}"))`,
                );
            }
        }

        const silkLines = [];
        if (fp && Array.isArray(fp.silk)) {
            for (const ln of fp.silk) {
                if (ln?.kind !== 'line') continue;
                silkLines.push(
                    `    (fp_line (start ${fmtMm(ln.x1)} ${fmtMm(ln.y1)}) (end ${fmtMm(ln.x2)} ${fmtMm(ln.y2)}) (layer "F.SilkS") (width 0.12) (uuid "${randomUuid()}"))`,
                );
            }
        }

        parts.push(`  (footprint ${q(`nozeplot:${libId}`)}`);
        parts.push('    (layer "F.Cu")');
        parts.push(`    (tedit ${tedit})`);
        parts.push(`    (uuid "${randomUuid()}")`);
        parts.push(`    (at ${fmtMm(px)} ${fmtMm(py)} ${fmtMm(rot)})`);
        parts.push(`    (descr ${q(descr)})`);
        parts.push(`    (tags ${q('nozeplot')})`);
        parts.push(`    (path ${q(`/noze/${pl.id}`)})`);
        parts.push('    (attr smd)');
        parts.push(
            `    (fp_text reference ${q(ref)} (at 0 -2) (layer "F.SilkS")\n      (effects (font (size 1 1) (thickness 0.15))))`,
        );
        parts.push(
            `    (fp_text value ${q(val)} (at 0 2) (layer "F.SilkS")\n      (effects (font (size 1 1) (thickness 0.15))))`,
        );
        for (const s of silkLines) parts.push(s);
        for (const p of padLines) parts.push(p);
        if (padLines.length === 0) {
            parts.push(
                `    (fp_text user ${q('?')} (at 0 0) (layer "F.SilkS")\n      (effects (font (size 0.8 0.8) (thickness 0.12))))`,
            );
        }
        parts.push('  )');
        parts.push('');
    }

    parts.push(`  (gr_line (start 0 0) (end ${fmtMm(W)} 0) (layer "Edge.Cuts") (width 0.15) (uuid "${randomUuid()}"))`);
    parts.push(`  (gr_line (start ${fmtMm(W)} 0) (end ${fmtMm(W)} ${fmtMm(H)}) (layer "Edge.Cuts") (width 0.15) (uuid "${randomUuid()}"))`);
    parts.push(`  (gr_line (start ${fmtMm(W)} ${fmtMm(H)}) (end 0 ${fmtMm(H)}) (layer "Edge.Cuts") (width 0.15) (uuid "${randomUuid()}"))`);
    parts.push(`  (gr_line (start 0 ${fmtMm(H)}) (end 0 0) (layer "Edge.Cuts") (width 0.15) (uuid "${randomUuid()}"))`);
    parts.push('');

    for (const tr of d.tracks || []) {
        if (!tr || !Array.isArray(tr.points) || tr.points.length < 2) continue;
        const layer = stack.includes(tr.layer) ? tr.layer : outerTop;
        const w = Number(tr.widthMm) || Number(d.meta?.defaultTrackMm) || 0.35;
        const netStr = tr.net != null && String(tr.net).trim() ? String(tr.net).trim() : '';
        const nOrd = netOrdinal.has(netStr) ? netOrdinal.get(netStr) : 0;
        for (let i = 0; i < tr.points.length - 1; i++) {
            const [x1, y1] = tr.points[i];
            const [x2, y2] = tr.points[i + 1];
            parts.push(
                `  (segment (start ${fmtMm(x1)} ${fmtMm(y1)}) (end ${fmtMm(x2)} ${fmtMm(y2)}) (width ${fmtMm(w)}) (layer ${kicadLayerString(
                    layer,
                )}) (net ${nOrd}) (uuid "${randomUuid()}"))`,
            );
        }
    }

    const zoneClear = Math.max(0.2, Number(d.meta?.designRules?.minCopperClearanceMm) || 0.2);
    for (const poly of d.polygons || []) {
        if (!poly || !Array.isArray(poly.points) || poly.points.length < 3) continue;
        const layer = stack.includes(poly.layer) ? poly.layer : outerTop;
        const netStr = poly.net != null && String(poly.net).trim() ? String(poly.net).trim() : '';
        const nOrd = netOrdinal.has(netStr) ? netOrdinal.get(netStr) : 0;
        const ptsLines = poly.points
            .map(([x, y]) => `        (xy ${fmtMm(x)} ${fmtMm(y)})`)
            .join('\n');
        const zoneLead = netStr
            ? `  (zone (net ${nOrd}) (net_name ${q(netStr)}) (layer ${kicadLayerString(layer)}) (tstamp "${randomUuid()}") (hatch edge 0.508)`
            : `  (zone (net ${nOrd}) (layer ${kicadLayerString(layer)}) (tstamp "${randomUuid()}") (hatch edge 0.508)`;
        parts.push(zoneLead);
        parts.push(`    (connect_pads (clearance ${fmtMm(zoneClear)}))`);
        parts.push(`    (min_thickness ${fmtMm(0.25)})`);
        parts.push(
            `    (fill (arc_segments 16) (thermal_gap ${fmtMm(zoneClear)}) (thermal_bridge_width ${fmtMm(Math.max(0.2, zoneClear))}))`,
        );
        parts.push('    (polygon');
        parts.push('      (pts');
        parts.push(ptsLines);
        parts.push('      )');
        parts.push('    )');
        parts.push('  )');
        parts.push('');
    }

    for (const v of d.vias || []) {
        if (!v) continue;
        const vx = Number(v.x) || 0;
        const vy = Number(v.y) || 0;
        const drill = Number(v.drillMm) || Number(d.meta?.defaultViaDrillMm) || 0.4;
        const diam = Number(v.diamMm) || Number(d.meta?.defaultViaDiamMm) || 0.8;
        const netStr = v.net != null && String(v.net).trim() ? String(v.net).trim() : '';
        const nOrd = netOrdinal.has(netStr) ? netOrdinal.get(netStr) : 0;
        parts.push(
            `  (via (at ${fmtMm(vx)} ${fmtMm(vy)}) (size ${fmtMm(diam)}) (drill ${fmtMm(drill)}) (layers ${q(outerTop)} ${q(
                outerBot,
            )}) (net ${nOrd}) (uuid "${randomUuid()}"))`,
        );
    }

    parts.push(')');
    return parts.join('\n');
}
