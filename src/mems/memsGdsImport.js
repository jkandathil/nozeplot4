/**
 * GDSII → MEMS mask document (structures, layer/datatype, hierarchy).
 */

import { nanoid } from 'nanoid';
import { RecordType } from 'gdsii';
import { forEachGdsRecord } from './memsGdsStream.js';
import {
    migrateMemsMaskDoc,
    newId,
    MEMS_DOC_VERSION,
    fitDocumentDieToActiveCellContent,
} from './memsMaskDoc.js';
import { normalizeLayerMetadata } from './memsLayoutModel.js';

const DEFAULT_PALETTE = [
    '#38bdf8',
    '#a78bfa',
    '#34d399',
    '#fb923c',
    '#f472b6',
    '#fbbf24',
    '#94a3b8',
];

function clampLayerNum(n) {
    const x = Math.round(Number(n));
    if (!Number.isFinite(x)) return 0;
    return Math.min(255, Math.max(0, x));
}

function clampDtNum(n) {
    const x = Math.round(Number(n));
    if (!Number.isFinite(x)) return 0;
    return Math.min(255, Math.max(0, x));
}

function dbXYToUmXY(ix, iy, metersPerDb) {
    const x = ix * metersPerDb * 1e6;
    const y = iy * metersPerDb * 1e6;
    return { x, y };
}

function bucketKey(layer, dt) {
    return `${clampLayerNum(layer)}:${clampDtNum(dt)}`;
}

/**
 * @param {{ tag: number, data: unknown }[]} records
 * @param {number} metersPerDb
 */
export function parseStructureRecords(records, metersPerDb) {
    /** @type {Map<string, object[]>} */
    const buckets = new Map();
    /** @type {object[]} */
    const refs = [];

    const pushPoly = (layer, dt, points, holes) => {
        const k = bucketKey(layer, dt);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push({
            id: nanoid(12),
            type: 'polygon',
            points,
            ...(holes?.length ? { holes } : {}),
        });
    };

    const pushPath = (layer, dt, points, widthDb, pathtype) => {
        const k = bucketKey(layer, dt);
        if (!buckets.has(k)) buckets.set(k, []);
        const widthUm =
            widthDb != null && Number.isFinite(widthDb)
                ? Math.abs(Number(widthDb)) * metersPerDb * 1e6
                : undefined;
        buckets.get(k).push({
            id: nanoid(12),
            type: 'path',
            points,
            ...(widthUm != null && widthUm > 0 ? { widthUm } : {}),
            ...(pathtype != null ? { pathtype: clampDtNum(pathtype) } : {}),
        });
    };

    const pushLine = (layer, dt, x1, y1, x2, y2) => {
        const k = bucketKey(layer, dt);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push({
            id: nanoid(12),
            type: 'line',
            x1,
            y1,
            x2,
            y2,
        });
    };

    const pushText = (layer, dt, x, y, text, rotationDeg, scale, presentation) => {
        const k = bucketKey(layer, dt);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push({
            id: nanoid(12),
            type: 'text',
            x,
            y,
            text: String(text ?? ''),
            ...(rotationDeg ? { rotationDeg } : {}),
            ...(scale && scale !== 1 ? { scale } : {}),
            ...(presentation != null ? { presentation } : {}),
        });
    };

    let i = 0;
    while (i < records.length) {
        const r = records[i];
        if (r.tag === RecordType.BOUNDARY || r.tag === RecordType.BOX) {
            let layer = 0;
            let datatype = 0;
            /** @type {number[]} */
            let xyFlat = [];
            i++;
            while (i < records.length) {
                const q = records[i];
                if (q.tag === RecordType.ENDEL) {
                    i++;
                    break;
                }
                if (q.tag === RecordType.LAYER) layer = Number(q.data);
                else if (q.tag === RecordType.DATATYPE) datatype = Number(q.data);
                else if (q.tag === RecordType.XY && Array.isArray(q.data)) xyFlat = /** @type {number[]} */ (q.data);
                i++;
            }
            const pts = [];
            for (let k = 0; k + 1 < xyFlat.length; k += 2) {
                pts.push(dbXYToUmXY(xyFlat[k], xyFlat[k + 1], metersPerDb));
            }
            if (pts.length >= 4) {
                const last = pts[pts.length - 1];
                const first = pts[0];
                if (last.x === first.x && last.y === first.y) pts.pop();
            }
            if (pts.length >= 3) pushPoly(layer, datatype, pts, undefined);
            continue;
        }

        if (r.tag === RecordType.PATH) {
            let layer = 0;
            let datatype = 0;
            let width = 0;
            /** @type {number[]} */
            let xyFlat = [];
            let pathtype = 0;
            i++;
            while (i < records.length) {
                const q = records[i];
                if (q.tag === RecordType.ENDEL) {
                    i++;
                    break;
                }
                if (q.tag === RecordType.LAYER) layer = Number(q.data);
                else if (q.tag === RecordType.DATATYPE) datatype = Number(q.data);
                else if (q.tag === RecordType.WIDTH) width = Number(q.data);
                else if (q.tag === RecordType.PATHTYPE) pathtype = Number(q.data);
                else if (q.tag === RecordType.XY && Array.isArray(q.data)) xyFlat = /** @type {number[]} */ (q.data);
                i++;
            }
            const pts = [];
            for (let k = 0; k + 1 < xyFlat.length; k += 2) {
                pts.push(dbXYToUmXY(xyFlat[k], xyFlat[k + 1], metersPerDb));
            }
            if (pts.length >= 2) pushPath(layer, datatype, pts, width, pathtype);
            else if (pts.length === 2 && width === 0) {
                pushLine(layer, datatype, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
            }
            continue;
        }

        if (r.tag === RecordType.TEXT) {
            let layer = 0;
            let texttype = 0;
            let presentation = undefined;
            /** @type {number[]} */
            let xyFlat = [];
            let str = '';
            let angle = 0;
            let mag = 1;
            i++;
            while (i < records.length) {
                const q = records[i];
                if (q.tag === RecordType.ENDEL) {
                    i++;
                    break;
                }
                if (q.tag === RecordType.LAYER) layer = Number(q.data);
                else if (q.tag === RecordType.TEXTTYPE) texttype = Number(q.data);
                else if (q.tag === RecordType.PRESENTATION) presentation = Number(q.data);
                else if (q.tag === RecordType.XY && Array.isArray(q.data)) xyFlat = /** @type {number[]} */ (q.data);
                else if (q.tag === RecordType.STRING) str = typeof q.data === 'string' ? q.data : '';
                else if (q.tag === RecordType.ANGLE) angle = Number(q.data);
                else if (q.tag === RecordType.MAG) mag = Number(q.data);
                i++;
            }
            if (xyFlat.length >= 2) {
                const p = dbXYToUmXY(xyFlat[0], xyFlat[1], metersPerDb);
                pushText(layer, texttype, p.x, p.y, str, angle, mag, presentation);
            }
            continue;
        }

        if (r.tag === RecordType.SREF) {
            let sname = '';
            /** @type {number[]} */
            let xyFlat = [];
            let strans = 0;
            let angle = 0;
            let mag = 1;
            i++;
            while (i < records.length) {
                const q = records[i];
                if (q.tag === RecordType.ENDEL) {
                    i++;
                    break;
                }
                if (q.tag === RecordType.SNAME) sname = typeof q.data === 'string' ? q.data : '';
                else if (q.tag === RecordType.XY && Array.isArray(q.data)) xyFlat = /** @type {number[]} */ (q.data);
                else if (q.tag === RecordType.STRANS) strans = Number(q.data);
                else if (q.tag === RecordType.ANGLE) angle = Number(q.data);
                else if (q.tag === RecordType.MAG) mag = Number(q.data);
                i++;
            }
            const p =
                xyFlat.length >= 2 ? dbXYToUmXY(xyFlat[0], xyFlat[1], metersPerDb) : { x: 0, y: 0 };
            refs.push({
                kind: 'sref',
                sname,
                x: p.x,
                y: p.y,
                mirrorX: !!(strans & 0x8000),
                mirrorY: false,
                rotationDeg: angle || 0,
                scaleX: mag != null && Number.isFinite(mag) ? mag : 1,
                scaleY: mag != null && Number.isFinite(mag) ? mag : 1,
            });
            continue;
        }

        if (r.tag === RecordType.AREF) {
            let sname = '';
            let cols = 1;
            let rows = 1;
            /** @type {number[]} */
            let xyFlat = [];
            let strans = 0;
            let angle = 0;
            let mag = 1;
            i++;
            while (i < records.length) {
                const q = records[i];
                if (q.tag === RecordType.ENDEL) {
                    i++;
                    break;
                }
                if (q.tag === RecordType.SNAME) sname = typeof q.data === 'string' ? q.data : '';
                else if (q.tag === RecordType.COLROW) {
                    const d = q.data;
                    if (Array.isArray(d) && d.length >= 2) {
                        cols = d[0];
                        rows = d[1];
                    } else if (d && typeof d === 'object' && 'columns' in d) {
                        cols = /** @type {{ columns: number }} */ (d).columns;
                        rows = /** @type {{ rows: number }} */ (d).rows;
                    }
                } else if (q.tag === RecordType.XY && Array.isArray(q.data)) xyFlat = /** @type {number[]} */ (q.data);
                else if (q.tag === RecordType.STRANS) strans = Number(q.data);
                else if (q.tag === RecordType.ANGLE) angle = Number(q.data);
                else if (q.tag === RecordType.MAG) mag = Number(q.data);
                i++;
            }
            const pairs = [];
            for (let k = 0; k + 1 < xyFlat.length; k += 2) {
                pairs.push(dbXYToUmXY(xyFlat[k], xyFlat[k + 1], metersPerDb));
            }
            refs.push({
                kind: 'aref',
                sname,
                columns: cols,
                rows,
                points: pairs,
                mirrorX: !!(strans & 0x8000),
                rotationDeg: angle || 0,
                scale: mag != null && Number.isFinite(mag) ? mag : 1,
            });
            continue;
        }

        i++;
    }

    return { buckets, refs };
}

/**
 * @param {ArrayBuffer | Uint8Array} bytes
 */
export function scanGdsFile(bytes) {
    /** @type {{ tag: number, data: unknown }[]} */
    const all = [];
    forEachGdsRecord(bytes, (r) => all.push(r));

    /** @type {{ tag: number, data: unknown }[]} */
    const libHead = [];
    /** @type {{ name: string, records: { tag: number, data: unknown }[] }[]} */
    const structures = [];

    let cur = null;
    for (const r of all) {
        if (r.tag === RecordType.BGNSTR) {
            cur = { name: '', records: [] };
        } else if (r.tag === RecordType.STRNAME) {
            if (cur) cur.name = typeof r.data === 'string' ? r.data : '';
        } else if (r.tag === RecordType.ENDSTR) {
            if (cur) {
                structures.push(cur);
                cur = null;
            }
        } else if (cur) {
            cur.records.push(r);
        } else {
            libHead.push(r);
        }
    }

    let libName = 'LIB';
    let userUnit = 1e-3;
    let metersPerDb = 1e-9;

    for (const r of libHead) {
        if (r.tag === RecordType.LIBNAME && typeof r.data === 'string') libName = r.data;
        if (r.tag === RecordType.UNITS) {
            if (Array.isArray(r.data) && r.data.length >= 2) {
                userUnit = Number(r.data[0]);
                metersPerDb = Number(r.data[1]);
            }
        }
    }

    if (!Number.isFinite(userUnit) || userUnit <= 0) userUnit = 1e-3;
    if (!Number.isFinite(metersPerDb) || metersPerDb <= 0) metersPerDb = 1e-9;

    return { libName, userUnit, metersPerDb, structures };
}

/**
 * @param {ArrayBuffer | Uint8Array} bytes
 */
export function importGdsToMemsDoc(bytes) {
    const { libName, metersPerDb, structures } = scanGdsFile(bytes);

    /** @type {Map<string, string>} */
    const nameToId = new Map();

    const cellsInOrder = [];

    for (const st of structures) {
        const cid = newId();
        nameToId.set(st.name, cid);
        const { buckets, refs } = parseStructureRecords(st.records, metersPerDb);

        /** @type {object[]} */
        const layers = [];
        const sortedKeys = [...buckets.keys()].sort();

        let idx = 0;
        for (const key of sortedKeys) {
            const [ls, ds] = key.split(':').map((x) => Number(x));
            const ents = buckets.get(key) || [];
            layers.push({
                id: newId(),
                name: `L${ls} / DT${ds}`,
                color: DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length],
                visible: true,
                locked: false,
                selectable: true,
                opacity: 1,
                metadata: normalizeLayerMetadata({
                    gdsLayer: ls,
                    gdsDatatype: ds,
                }),
                entities: ents,
            });
            idx++;
        }

        const refLayerId =
            layers[0]?.id ||
            (() => {
                const id = newId();
                layers.push({
                    id,
                    name: 'Refs',
                    color: '#64748b',
                    visible: true,
                    locked: false,
                    selectable: true,
                    opacity: 1,
                    metadata: normalizeLayerMetadata({ gdsLayer: 0, gdsDatatype: 0 }),
                    entities: [],
                });
                return id;
            })();

        const refLayer = layers.find((l) => l.id === refLayerId);
        for (const rf of refs) {
            if (rf.kind === 'sref') {
                const mid = nameToId.get(rf.sname);
                if (!mid) continue;
                refLayer.entities.push({
                    id: newId(),
                    type: 'instance',
                    masterCellId: mid,
                    x: rf.x,
                    y: rf.y,
                    rotationDeg: rf.rotationDeg || 0,
                    scaleX: rf.scaleX ?? 1,
                    scaleY: rf.scaleY ?? 1,
                    mirrorX: rf.mirrorX || false,
                    mirrorY: rf.mirrorY || false,
                    array: { rows: 1, cols: 1, pitchXUm: 0, pitchYUm: 0 },
                });
            } else if (rf.kind === 'aref' && rf.points?.length >= 3) {
                const mid = nameToId.get(rf.sname);
                if (!mid) continue;
                const p0 = rf.points[0];
                const p1 = rf.points[1];
                const p2 = rf.points[2];
                const colStep = { x: p1.x - p0.x, y: p1.y - p0.y };
                const rowStep = { x: p2.x - p0.x, y: p2.y - p0.y };
                const cols = Math.max(1, rf.columns | 0);
                const rows = Math.max(1, rf.rows | 0);
                const maxPlacements = 250000;
                if (cols * rows <= maxPlacements) {
                    for (let rr = 0; rr < rows; rr++) {
                        for (let cc = 0; cc < cols; cc++) {
                            refLayer.entities.push({
                                id: newId(),
                                type: 'instance',
                                masterCellId: mid,
                                x: p0.x + cc * colStep.x + rr * rowStep.x,
                                y: p0.y + cc * colStep.y + rr * rowStep.y,
                                rotationDeg: rf.rotationDeg || 0,
                                scaleX: rf.scale ?? 1,
                                scaleY: rf.scale ?? 1,
                                mirrorX: rf.mirrorX || false,
                                mirrorY: false,
                                array: { rows: 1, cols: 1, pitchXUm: 0, pitchYUm: 0 },
                            });
                        }
                    }
                }
            }
        }

        cellsInOrder.push({
            id: cid,
            name: st.name.slice(0, 128) || 'CELL',
            kind: 'layout',
            metadata: { role: 'imported', notes: '' },
            layers,
        });
    }

    let topIdx = cellsInOrder.findIndex((c) => /^TOP$/i.test(c.name));
    if (topIdx < 0) topIdx = 0;

    for (let i = 0; i < cellsInOrder.length; i++) {
        cellsInOrder[i].kind = i === topIdx ? 'layout' : 'library';
    }

    const cells = cellsInOrder.length ? cellsInOrder : migrateMemsMaskDoc(null).cells;

    const doc = migrateMemsMaskDoc({
        version: MEMS_DOC_VERSION,
        project: {
            id: newId(),
            name: libName.slice(0, 128) || 'Imported GDS',
            unit: 'um',
            displayUnit: 'um',
            die: { widthUm: 5000, heightUm: 5000 },
            metadata: {
                description: `Imported from GDSII (${structures.length} structures)`,
                technology: '',
                notes: '',
            },
        },
        cells,
        activeCellId: cells[topIdx]?.id || cells[0]?.id,
        activeLayerId: cells[topIdx]?.layers[0]?.id || cells[0]?.layers[0]?.id,
    });

    return fitDocumentDieToActiveCellContent(doc);
}
