/**
 * DXF ↔ MEMS mask exchange (ASCII DXF, layers = drawing layers).
 * Coordinates exported as millimetres ($INSUNITS = 4); imported using header units → µm.
 */

import DxfParser from 'dxf-parser';
import { nanoid } from 'nanoid';
import {
    migrateMemsMaskDoc,
    newId,
    centeredToFabUm,
    MEMS_DOC_VERSION,
    fitDocumentDieToActiveCellContent,
} from './memsMaskDoc.js';
import { normalizeLayerMetadata } from './memsLayoutModel.js';

/** Scale raw DXF coordinates to millimetres (matches Flow Lab importer). */
const UNIT_TO_MM = {
    0: 1,
    1: 25.4,
    2: 304.8,
    4: 1,
    5: 10,
    6: 1000,
    8: 25.4e-6,
    9: 25.4e-3,
    12: 1e-6,
    13: 1e-3,
};

const DEFAULT_PALETTE = [
    '#38bdf8',
    '#a78bfa',
    '#34d399',
    '#fb923c',
    '#f472b6',
    '#fbbf24',
    '#94a3b8',
];

function normaliseDxf(text) {
    if (typeof text !== 'string') text = String(text ?? '');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\r\n?/g, '\n');
    while (text.endsWith('\n')) text = text.slice(0, -1);
    const lines = text.split('\n').map((l) => l.trim());
    let sawEof = false;
    for (let i = lines.length - 1; i >= 1; i--) {
        if (!lines[i]) continue;
        if (lines[i] === 'EOF' && lines[i - 1] === '0') {
            sawEof = true;
            break;
        }
        if (lines[i] === 'EOF') {
            sawEof = true;
            break;
        }
        break;
    }
    if (!sawEof) text += '\n0\nEOF\n';
    else text += '\n';
    return text;
}

function mmToUm(mm) {
    return mm * 1000;
}

function umToMm(um) {
    return um / 1000;
}

function circlePoints(cx, cy, r, segs = 48) {
    const pts = [];
    for (let i = 0; i < segs; i++) {
        const a = ((2 * Math.PI) / segs) * i;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
}

function arcPoints(cx, cy, r, a0Deg, a1Deg, segsPerFull = 48) {
    let a0 = (a0Deg * Math.PI) / 180;
    let a1 = (a1Deg * Math.PI) / 180;
    if (a1 <= a0) a1 += 2 * Math.PI;
    const sweep = a1 - a0;
    const n = Math.max(4, Math.ceil((segsPerFull * sweep) / (2 * Math.PI)));
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const a = a0 + sweep * (i / n);
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
}

function sanitizeLayerName(name) {
    return String(name || '0').replace(/[^\w.\-+]/g, '_').slice(0, 128) || '0';
}

/**
 * @param {string} dxfText
 */
export function importDxfToMemsDoc(dxfText) {
    const cleaned = normaliseDxf(dxfText);
    const parser = new DxfParser();
    const dxf = parser.parseSync(cleaned);
    const unitsCode = dxf.header?.$INSUNITS ?? 0;
    const mmScale = UNIT_TO_MM[unitsCode] ?? 1;

    /** @type {Map<string, object[]>} */
    const byLayer = new Map();

    const push = (layerName, entity) => {
        const k = sanitizeLayerName(layerName);
        if (!byLayer.has(k)) byLayer.set(k, []);
        byLayer.get(k).push(entity);
    };

    for (const e of dxf.entities || []) {
        if (!e) continue;
        const layer = sanitizeLayerName(e.layer || '0');
        try {
            switch (e.type) {
                case 'LINE': {
                    if (e.vertices?.length >= 2) {
                        const a = e.vertices[0];
                        const b = e.vertices[1];
                        push(layer, {
                            id: nanoid(12),
                            type: 'line',
                            x1: mmToUm(a.x * mmScale),
                            y1: mmToUm(a.y * mmScale),
                            x2: mmToUm(b.x * mmScale),
                            y2: mmToUm(b.y * mmScale),
                        });
                    }
                    break;
                }
                case 'LWPOLYLINE':
                case 'POLYLINE': {
                    const verts = (e.vertices || []).map((v) => ({
                        x: mmToUm(v.x * mmScale),
                        y: mmToUm(v.y * mmScale),
                    }));
                    const closed = !!(e.shape || e.closed);
                    if (verts.length >= 3 && closed) {
                        push(layer, { id: nanoid(12), type: 'polygon', points: verts });
                    } else if (verts.length >= 2) {
                        push(layer, { id: nanoid(12), type: 'path', points: verts });
                    }
                    break;
                }
                case 'CIRCLE': {
                    const cx = e.center?.x ?? 0;
                    const cy = e.center?.y ?? 0;
                    const r = mmToUm((e.radius || 0) * mmScale);
                    const cxe = mmToUm(cx * mmScale);
                    const cye = mmToUm(cy * mmScale);
                    push(layer, {
                        id: nanoid(12),
                        type: 'polygon',
                        points: circlePoints(cxe, cye, r),
                    });
                    break;
                }
                case 'ARC': {
                    const cx = e.center?.x ?? 0;
                    const cy = e.center?.y ?? 0;
                    const r = mmToUm((e.radius || 0) * mmScale);
                    const cxe = mmToUm(cx * mmScale);
                    const cye = mmToUm(cy * mmScale);
                    push(layer, {
                        id: nanoid(12),
                        type: 'path',
                        points: arcPoints(cxe, cye, r, e.startAngle || 0, e.endAngle || 360),
                    });
                    break;
                }
                case 'ELLIPSE': {
                    const cx = e.center?.x ?? 0;
                    const cy = e.center?.y ?? 0;
                    const cxe = mmToUm(cx * mmScale);
                    const cye = mmToUm(cy * mmScale);
                    const majX = e.majorAxisEndPoint?.x || 0;
                    const majY = e.majorAxisEndPoint?.y || 0;
                    const majLen = Math.hypot(majX, majY) * mmScale;
                    const ratio = e.axisRatio ?? 1;
                    const rx = mmToUm(majLen);
                    const ry = mmToUm(majLen * ratio);
                    const steps = 64;
                    const ux = majLen > 0 ? majX / Math.hypot(majX, majY) : 1;
                    const uy = majLen > 0 ? majY / Math.hypot(majX, majY) : 0;
                    const vx = -uy;
                    const vy = ux;
                    const pts = [];
                    const a0 = e.startAngle ?? 0;
                    const a1 = e.endAngle ?? 2 * Math.PI;
                    let s = a0;
                    let end = a1;
                    if (end <= s) end += 2 * Math.PI;
                    const sweep = end - s;
                    const n = Math.max(8, Math.ceil((steps * sweep) / (2 * Math.PI)));
                    for (let i = 0; i <= n; i++) {
                        const t = s + sweep * (i / n);
                        const ox = rx * Math.cos(t);
                        const oy = ry * Math.sin(t);
                        pts.push({
                            x: cxe + ux * ox + vx * oy,
                            y: cye + uy * ox + vy * oy,
                        });
                    }
                    const closed = Math.abs(a1 - a0 - 2 * Math.PI) < 1e-6;
                    if (closed && pts.length >= 3) {
                        push(layer, { id: nanoid(12), type: 'polygon', points: pts });
                    } else {
                        push(layer, { id: nanoid(12), type: 'path', points: pts });
                    }
                    break;
                }
                case 'TEXT':
                case 'MTEXT': {
                    const x = mmToUm((e.startPoint?.x ?? e.position?.x ?? 0) * mmScale);
                    const y = mmToUm((e.startPoint?.y ?? e.position?.y ?? 0) * mmScale);
                    const txt = String(e.text ?? '').replace(/\r|\n/g, ' ').slice(0, 4096);
                    const h = e.textHeight || e.height || e.nominalTextHeight || 2.5;
                    const heightUm = mmToUm(Number(h) * mmScale);
                    push(layer, {
                        id: nanoid(12),
                        type: 'text',
                        x,
                        y,
                        text: String(txt).replace(/\r|\n/g, ' ').slice(0, 4096),
                        rotationDeg: e.rotation || 0,
                        heightUm,
                    });
                    break;
                }
                default:
                    break;
            }
        } catch {
            /* skip bad entity */
        }
    }

    const keys = [...byLayer.keys()].sort();
    const layers = keys.map((k, i) => ({
        id: newId(),
        name: k,
        color: DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
        visible: true,
        locked: false,
        selectable: true,
        opacity: 1,
        metadata: normalizeLayerMetadata({
            dxfLayer: k,
            gdsLayer: i,
            gdsDatatype: 0,
        }),
        entities: byLayer.get(k) || [],
    }));

    const cellId = newId();
    const doc = migrateMemsMaskDoc({
        version: MEMS_DOC_VERSION,
        project: {
            id: newId(),
            name: 'Imported DXF',
            unit: 'um',
            displayUnit: 'um',
            die: { widthUm: 5000, heightUm: 5000 },
            metadata: {
                description: `Imported DXF (units code ${unitsCode})`,
                technology: '',
                notes: '',
            },
        },
        cells: [
            {
                id: cellId,
                name: 'Root',
                kind: 'layout',
                metadata: { role: 'top', notes: '' },
                layers,
            },
        ],
        activeCellId: cellId,
        activeLayerId: layers[0]?.id,
    });

    return fitDocumentDieToActiveCellContent(doc);
}

function umToMmFab(doc, xUm, yUm) {
    const f = centeredToFabUm(doc, xUm, yUm);
    return { mx: umToMm(f.x), my: umToMm(f.y) };
}

function emitPolylineChunk(lines, layer, pts, closed, doc) {
    lines.push('0', 'LWPOLYLINE', '8', layer, '90', String(pts.length), '70', closed ? '1' : '0');
    for (const p of pts) {
        const { mx, my } = umToMmFab(doc, p.x, p.y);
        lines.push('10', String(mx), '20', String(my));
    }
}

function ellipseToPolygonUm(cx, cy, rx, ry, rotationDeg = 0, segments = 64) {
    const pts = [];
    const rad = (rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    for (let i = 0; i <= segments; i++) {
        const t = (i / segments) * 2 * Math.PI;
        const ox = rx * Math.cos(t);
        const oy = ry * Math.sin(t);
        pts.push({
            x: cx + ox * cos - oy * sin,
            y: cy + ox * sin + oy * cos,
        });
    }
    return pts;
}

/**
 * @param {object} doc
 */
export function exportMemsDocToDxf(doc) {
    const lines = [];
    lines.push('0', 'SECTION', '2', 'HEADER');
    lines.push('9', '$INSUNITS', '70', '4');
    lines.push('0', 'ENDSEC');
    lines.push('0', 'SECTION', '2', 'TABLES');
    lines.push('0', 'TABLE', '2', 'LAYER', '70', '1');

    /** @type {Map<string, boolean>} */
    const layerNamesAdded = new Map();
    for (const cell of doc.cells || []) {
        for (const L of cell.layers || []) {
            const n = sanitizeLayerName(L.name);
            if (layerNamesAdded.has(n)) continue;
            layerNamesAdded.set(n, true);
            lines.push('0', 'LAYER', '2', n, '70', '0', '62', '7', '6', 'CONTINUOUS');
        }
    }

    lines.push('0', 'ENDTAB', '0', 'ENDSEC');
    lines.push('0', 'SECTION', '2', 'ENTITIES');

    for (const cell of doc.cells || []) {
        for (const L of cell.layers || []) {
            const layer = sanitizeLayerName(L.name);
            for (const e of L.entities || []) {
                if (e.type === 'line') {
                    const a = umToMmFab(doc, e.x1, e.y1);
                    const b = umToMmFab(doc, e.x2, e.y2);
                    lines.push(
                        '0',
                        'LINE',
                        '8',
                        layer,
                        '10',
                        String(a.mx),
                        '20',
                        String(a.my),
                        '11',
                        String(b.mx),
                        '21',
                        String(b.my)
                    );
                } else if (e.type === 'polygon') {
                    const pts = e.points || [];
                    if (pts.length >= 3) emitPolylineChunk(lines, layer, pts, true, doc);
                } else if (e.type === 'path') {
                    const pts = e.points || [];
                    if (pts.length >= 2) emitPolylineChunk(lines, layer, pts, false, doc);
                } else if (e.type === 'rect') {
                    const pts = [
                        { x: e.x, y: e.y },
                        { x: e.x + e.width, y: e.y },
                        { x: e.x + e.width, y: e.y + e.height },
                        { x: e.x, y: e.y + e.height },
                    ];
                    emitPolylineChunk(lines, layer, pts, true, doc);
                } else if (e.type === 'ellipse') {
                    const pts = ellipseToPolygonUm(e.cx, e.cy, e.rx, e.ry, e.rotationDeg || 0);
                    emitPolylineChunk(lines, layer, pts, true, doc);
                } else if (e.type === 'text') {
                    const p = umToMmFab(doc, e.x, e.y);
                    lines.push(
                        '0',
                        'TEXT',
                        '8',
                        layer,
                        '10',
                        String(p.mx),
                        '20',
                        String(p.my),
                        '40',
                        String(umToMm(e.heightUm ?? 2.5)),
                        '50',
                        String(e.rotationDeg ?? 0),
                        '1',
                        String(e.text ?? '').slice(0, 256)
                    );
                }
            }
        }
    }

    lines.push('0', 'ENDSEC', '0', 'EOF');
    return lines.join('\n');
}
