/**
 * MEMS mask document → GDSII stream (cells, layer/datatype, SREF/AREF).
 */

import { nanoid } from 'nanoid';
import { RecordType } from 'gdsii';
import { centeredToFabUm } from './memsMaskDoc.js';
import { encodeReal8 } from './memsGdsReal.js';
import {
    appendRecord,
    gdsStringBytes,
    GdsBuffer,
    int16Bytes,
    int32Bytes,
    nowTimestampBytes,
} from './memsGdsStream.js';

export const DEFAULT_METERS_PER_DB = 1e-9;
export const DEFAULT_USER_UNIT_RATIO = 1e-3;

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

function umToDb(xUm, yUm, metersPerDb) {
    return {
        x: Math.round(xUm / (metersPerDb * 1e6)),
        y: Math.round(yUm / (metersPerDb * 1e6)),
    };
}

/** Die-centered layout µm → database units (fab origin at lower-left of die). */
function umToDbFab(doc, xUm, yUm, metersPerDb) {
    const { x, y } = centeredToFabUm(doc, xUm, yUm);
    return umToDb(x, y, metersPerDb);
}

function ellipseToPolygon(cx, cy, rx, ry, rotationDeg, segments = 64) {
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

function rectToPolygon(r) {
    const deg = r.rotationDeg || 0;
    if (!deg) {
        return [
            { x: r.x, y: r.y },
            { x: r.x + r.width, y: r.y },
            { x: r.x + r.width, y: r.y + r.height },
            { x: r.x, y: r.y + r.height },
        ];
    }
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const corners = [
        { x: r.x, y: r.y },
        { x: r.x + r.width, y: r.y },
        { x: r.x + r.width, y: r.y + r.height },
        { x: r.x, y: r.y + r.height },
    ];
    return corners.map((p) => {
        const dx = p.x - cx;
        const dy = p.y - cy;
        return {
            x: cx + dx * cos - dy * sin,
            y: cy + dx * sin + dy * cos,
        };
    });
}

/** Topological order: referenced masters appear before referencing cells. */
export function sortCellsForExport(doc) {
    const cells = doc.cells || [];
    const ids = new Set(cells.map((c) => c.id));
    const deps = new Map();
    for (const c of cells) {
        const s = new Set();
        for (const L of c.layers || []) {
            for (const e of L.entities || []) {
                if (e.type === 'instance' && ids.has(e.masterCellId)) s.add(e.masterCellId);
            }
        }
        deps.set(c.id, s);
    }

    const byId = new Map(cells.map((c) => [c.id, c]));
    const visited = new Set();
    const out = [];

    function dfs(cid) {
        if (visited.has(cid)) return;
        visited.add(cid);
        for (const m of deps.get(cid) || []) dfs(m);
        const c = byId.get(cid);
        if (c) out.push(c);
    }

    for (const c of cells) dfs(c.id);
    return out;
}

function uniqueStructName(base, usedNames) {
    let n = String(base || 'CELL').replace(/[^\w.\-+]/g, '_').slice(0, 32) || 'CELL';
    if (!usedNames.has(n)) {
        usedNames.add(n);
        return n;
    }
    for (let i = 1; i < 100000; i++) {
        const cand = `${n.slice(0, 28)}_${i}`;
        if (!usedNames.has(cand)) {
            usedNames.add(cand);
            return cand;
        }
    }
    const cand = `${n.slice(0, 24)}_${nanoid(6)}`;
    usedNames.add(cand);
    return cand;
}

/**
 * @param {object} entity
 * @param {number} metersPerDb
 * @param {number} layer
 * @param {number} datatype
 * @returns {{ tag: number, payload: Uint8Array }[]}
 */
function entityToGdsRecords(entity, metersPerDb, layer, datatype, doc) {
    /** @type {{ tag: number, payload: Uint8Array }[]} */
    const recs = [];

    const emitBoundary = (pointsUm) => {
        const dbPts = [];
        for (const p of pointsUm) {
            const q = umToDbFab(doc, p.x, p.y, metersPerDb);
            dbPts.push(q.x, q.y);
        }
        if (dbPts.length >= 6) {
            dbPts.push(dbPts[0], dbPts[1]);
        }
        const xyPayload = new Uint8Array(dbPts.length * 4);
        const dv = new DataView(xyPayload.buffer);
        for (let i = 0; i < dbPts.length; i++) {
            dv.setInt32(i * 4, dbPts[i], false);
        }
        recs.push({ tag: RecordType.BOUNDARY, payload: new Uint8Array(0) });
        recs.push({ tag: RecordType.LAYER, payload: int16Bytes(clampLayerNum(layer)) });
        recs.push({ tag: RecordType.DATATYPE, payload: int16Bytes(clampDtNum(datatype)) });
        recs.push({ tag: RecordType.XY, payload: xyPayload });
        recs.push({ tag: RecordType.ENDEL, payload: new Uint8Array(0) });
    };

    if (entity.type === 'polygon') {
        emitBoundary(entity.points || []);
        return recs;
    }
    if (entity.type === 'rect') {
        emitBoundary(rectToPolygon(entity));
        return recs;
    }
    if (entity.type === 'ellipse') {
        emitBoundary(
            ellipseToPolygon(entity.cx, entity.cy, entity.rx, entity.ry, entity.rotationDeg || 0)
        );
        return recs;
    }
    if (entity.type === 'line') {
        const p1 = umToDbFab(doc, entity.x1, entity.y1, metersPerDb);
        const p2 = umToDbFab(doc, entity.x2, entity.y2, metersPerDb);
        const xyPayload = new Uint8Array(16);
        const dv = new DataView(xyPayload.buffer);
        dv.setInt32(0, p1.x, false);
        dv.setInt32(4, p1.y, false);
        dv.setInt32(8, p2.x, false);
        dv.setInt32(12, p2.y, false);
        recs.push({ tag: RecordType.PATH, payload: new Uint8Array(0) });
        recs.push({ tag: RecordType.LAYER, payload: int16Bytes(clampLayerNum(layer)) });
        recs.push({ tag: RecordType.DATATYPE, payload: int16Bytes(clampDtNum(datatype)) });
        recs.push({ tag: RecordType.PATHTYPE, payload: int16Bytes(0) });
        recs.push({ tag: RecordType.WIDTH, payload: int32Bytes(0) });
        recs.push({ tag: RecordType.XY, payload: xyPayload });
        recs.push({ tag: RecordType.ENDEL, payload: new Uint8Array(0) });
        return recs;
    }
    if (entity.type === 'path') {
        const pts = entity.points || [];
        if (pts.length < 2) return recs;
        const dbPts = [];
        for (const p of pts) {
            const q = umToDbFab(doc, p.x, p.y, metersPerDb);
            dbPts.push(q.x, q.y);
        }
        const xyPayload = new Uint8Array(dbPts.length * 4);
        const dv = new DataView(xyPayload.buffer);
        for (let i = 0; i < dbPts.length; i++) {
            dv.setInt32(i * 4, dbPts[i], false);
        }
        const widthUm = Number(entity.widthUm);
        const widthDb =
            Number.isFinite(widthUm) && widthUm > 0
                ? Math.max(1, Math.round(widthUm / (metersPerDb * 1e6)))
                : 0;
        recs.push({ tag: RecordType.PATH, payload: new Uint8Array(0) });
        recs.push({ tag: RecordType.LAYER, payload: int16Bytes(clampLayerNum(layer)) });
        recs.push({ tag: RecordType.DATATYPE, payload: int16Bytes(clampDtNum(datatype)) });
        recs.push({ tag: RecordType.PATHTYPE, payload: int16Bytes(Number(entity.pathtype) || 0) });
        recs.push({ tag: RecordType.WIDTH, payload: int32Bytes(widthDb) });
        recs.push({ tag: RecordType.XY, payload: xyPayload });
        recs.push({ tag: RecordType.ENDEL, payload: new Uint8Array(0) });
        return recs;
    }
    if (entity.type === 'text') {
        const p = umToDbFab(doc, entity.x, entity.y, metersPerDb);
        const xyPayload = new Uint8Array(8);
        const dv = new DataView(xyPayload.buffer);
        dv.setInt32(0, p.x, false);
        dv.setInt32(4, p.y, false);
        recs.push({ tag: RecordType.TEXT, payload: new Uint8Array(0) });
        recs.push({ tag: RecordType.LAYER, payload: int16Bytes(clampLayerNum(layer)) });
        recs.push({ tag: RecordType.TEXTTYPE, payload: int16Bytes(clampDtNum(datatype)) });
        recs.push({ tag: RecordType.XY, payload: xyPayload });
        recs.push({
            tag: RecordType.STRING,
            payload: gdsStringBytes(String(entity.text ?? '').slice(0, 512)),
        });
        if (entity.rotationDeg)
            recs.push({ tag: RecordType.ANGLE, payload: encodeReal8(Number(entity.rotationDeg)) });
        if (entity.scale && entity.scale !== 1)
            recs.push({ tag: RecordType.MAG, payload: encodeReal8(Number(entity.scale)) });
        recs.push({ tag: RecordType.ENDEL, payload: new Uint8Array(0) });
        return recs;
    }
    return recs;
}

function flushEntityRecs(buf, list) {
    for (const r of list) {
        appendRecord(buf, r.tag, r.payload);
    }
}

/**
 * @param {object} doc
 * @param {{ metersPerDb?: number, userUnit?: number, libName?: string }} [opts]
 */
export function exportMemsDocToGds(doc, opts = {}) {
    const metersPerDb = opts.metersPerDb ?? DEFAULT_METERS_PER_DB;
    const userUnit = opts.userUnit ?? DEFAULT_USER_UNIT_RATIO;
    const libName = opts.libName ?? doc.project?.name ?? 'LIB';

    const buf = new GdsBuffer();
    appendRecord(buf, RecordType.HEADER, int16Bytes(600));
    appendRecord(buf, RecordType.BGNLIB, nowTimestampBytes());
    appendRecord(buf, RecordType.LIBNAME, gdsStringBytes(String(libName).slice(0, 256)));

    const up = new Uint8Array(16);
    up.set(encodeReal8(userUnit), 0);
    up.set(encodeReal8(metersPerDb), 8);
    appendRecord(buf, RecordType.UNITS, up);

    const sortedCells = sortCellsForExport(doc);
    /** @type {Map<string, string>} */
    const idToName = new Map();
    const usedNames = new Set();

    for (const cell of sortedCells) {
        idToName.set(cell.id, uniqueStructName(cell.name, usedNames));
    }

    for (let ci = 0; ci < sortedCells.length; ci++) {
        const cell = sortedCells[ci];
        const structName = idToName.get(cell.id) || `C${ci}`;

        appendRecord(buf, RecordType.BGNSTR, nowTimestampBytes());
        appendRecord(buf, RecordType.STRNAME, gdsStringBytes(structName));

        let layerIndex = 0;
        for (const layer of cell.layers || []) {
            const meta = layer.metadata || {};
            const gL =
                meta.gdsLayer != null && Number.isFinite(Number(meta.gdsLayer))
                    ? clampLayerNum(meta.gdsLayer)
                    : layerIndex;
            const gD =
                meta.gdsDatatype != null && Number.isFinite(Number(meta.gdsDatatype))
                    ? clampDtNum(meta.gdsDatatype)
                    : 0;

            for (const ent of layer.entities || []) {
                if (ent.type === 'instance') {
                    const masterName = idToName.get(ent.masterCellId);
                    if (!masterName) continue;
                    const p = umToDbFab(doc, ent.x, ent.y, metersPerDb);
                    const xy = new Uint8Array(8);
                    const dv = new DataView(xy.buffer);
                    dv.setInt32(0, p.x, false);
                    dv.setInt32(4, p.y, false);

                    const arr = ent.array || { rows: 1, cols: 1, pitchXUm: 0, pitchYUm: 0 };
                    const rows = Math.max(1, arr.rows | 0);
                    const cols = Math.max(1, arr.cols | 0);

                    if (rows <= 1 && cols <= 1) {
                        appendRecord(buf, RecordType.SREF, new Uint8Array(0));
                        appendRecord(buf, RecordType.SNAME, gdsStringBytes(masterName));
                        let strans = 0;
                        if (ent.mirrorX) strans |= 0x8000;
                        if (strans) appendRecord(buf, RecordType.STRANS, int16Bytes(strans));
                        const sx = Number(ent.scaleX);
                        const sy = Number(ent.scaleY);
                        if (Number.isFinite(sx) && sx !== 1 && sx === sy) {
                            appendRecord(buf, RecordType.MAG, encodeReal8(sx));
                        }
                        if (ent.rotationDeg)
                            appendRecord(buf, RecordType.ANGLE, encodeReal8(Number(ent.rotationDeg)));
                        appendRecord(buf, RecordType.XY, xy);
                        appendRecord(buf, RecordType.ENDEL, new Uint8Array(0));
                    } else {
                        const pitchXUm = Number(arr.pitchXUm) || 0;
                        const pitchYUm = Number(arr.pitchYUm) || 0;
                        const p0 = umToDbFab(doc, ent.x, ent.y, metersPerDb);
                        const p1 = umToDbFab(doc, ent.x + pitchXUm, ent.y, metersPerDb);
                        const p2 = umToDbFab(doc, ent.x, ent.y + pitchYUm, metersPerDb);
                        const xy3 = new Uint8Array(24);
                        const dv3 = new DataView(xy3.buffer);
                        dv3.setInt32(0, p0.x, false);
                        dv3.setInt32(4, p0.y, false);
                        dv3.setInt32(8, p1.x, false);
                        dv3.setInt32(12, p1.y, false);
                        dv3.setInt32(16, p2.x, false);
                        dv3.setInt32(20, p2.y, false);

                        appendRecord(buf, RecordType.AREF, new Uint8Array(0));
                        appendRecord(buf, RecordType.SNAME, gdsStringBytes(masterName));
                        const cr = new Uint8Array(4);
                        const cdv = new DataView(cr.buffer);
                        cdv.setUint16(0, cols, false);
                        cdv.setUint16(2, rows, false);
                        appendRecord(buf, RecordType.COLROW, cr);
                        let strans = 0;
                        if (ent.mirrorX) strans |= 0x8000;
                        if (strans) appendRecord(buf, RecordType.STRANS, int16Bytes(strans));
                        const sc = Number(ent.scaleX);
                        if (Number.isFinite(sc) && sc !== 1) appendRecord(buf, RecordType.MAG, encodeReal8(sc));
                        if (ent.rotationDeg)
                            appendRecord(buf, RecordType.ANGLE, encodeReal8(Number(ent.rotationDeg)));
                        appendRecord(buf, RecordType.XY, xy3);
                        appendRecord(buf, RecordType.ENDEL, new Uint8Array(0));
                    }
                    continue;
                }

                flushEntityRecs(buf, entityToGdsRecords(ent, metersPerDb, gL, gD, doc));
            }
            layerIndex++;
        }

        appendRecord(buf, RecordType.ENDSTR, new Uint8Array(0));
    }

    appendRecord(buf, RecordType.ENDLIB, new Uint8Array(0));
    return buf.toUint8Array();
}
