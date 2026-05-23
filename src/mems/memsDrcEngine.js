/**
 * MEMS mask DRC engine — runs against flattened active cell geometry (µm).
 */

import polygonClipping from 'polygon-clipping';
import { nanoid } from 'nanoid';
import {
    entityToMultiPolygonNm,
    offsetMultiPolygonNm,
    emptyMultiPolygon,
    sanitizeMultiPolygonNm,
} from './memsPolygonKernel.js';
import { entityToClosedRingsUm } from './memsShapeToRings.js';
import { flattenActiveCell } from './memsHierarchy.js';
import { entityBBox } from './memsGeometry.js';
import { nmPairToPointUm } from './memsGeomPrecision.js';
import { ruleMatchesLayers, layerNameMatches } from './memsDrcSchema.js';

/** @typedef {import('./memsDrcSchema.js').DrcSeverity} DrcSeverity */

/**
 * @typedef {{
 *   id: string,
 *   severity: DrcSeverity,
 *   rule: string,
 *   message: string,
 *   layerId?: string,
 *   layerName?: string,
 *   entityIds?: string[],
 *   xUm: number,
 *   yUm: number,
 *   bboxUm?: { minX: number, minY: number, maxX: number, maxY: number },
 * }} DrcViolation
 */

function ringAreaSignedNm(ring) {
    if (!ring || ring.length < 3) return 0;
    let a = 0;
    const n = ring.length;
    const upto = ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? n - 1 : n;
    for (let i = 0; i < upto; i++) {
        const j = (i + 1) % n;
        const p = ring[i];
        const q = ring[j];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
}

export function multiPolygonAreaNm(mp) {
    let sum = 0;
    for (const poly of mp || []) {
        if (!poly?.length) continue;
        sum += Math.abs(ringAreaSignedNm(poly[0]));
        for (let i = 1; i < poly.length; i++) {
            sum -= Math.abs(ringAreaSignedNm(poly[i]));
        }
    }
    return Math.max(0, sum);
}

function ringBBoxUmFromNm(ring) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [xn, yn] of ring) {
        const p = nmPairToPointUm([xn, yn]);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
}

function multiPolygonBBoxUm(mp) {
    let b = null;
    for (const poly of mp || []) {
        if (!poly?.length) continue;
        for (const ring of poly) {
            const rb = ringBBoxUmFromNm(ring);
            if (!rb) continue;
            if (!b) b = { ...rb };
            else {
                b.minX = Math.min(b.minX, rb.minX);
                b.minY = Math.min(b.minY, rb.minY);
                b.maxX = Math.max(b.maxX, rb.maxX);
                b.maxY = Math.max(b.maxY, rb.maxY);
            }
        }
    }
    return b;
}

function mkViolation(partial) {
    return {
        id: nanoid(10),
        severity: partial.severity || 'error',
        rule: partial.rule,
        message: partial.message,
        layerId: partial.layerId,
        layerName: partial.layerName,
        entityIds: partial.entityIds,
        xUm: partial.xUm,
        yUm: partial.yUm,
        bboxUm: partial.bboxUm,
    };
}

/** Smallest angle between two undirected edges meeting at a vertex (degrees). */
function smallestCornerAngleDeg(ax, ay, bx, by, cx, cy) {
    const v1x = ax - bx;
    const v1y = ay - by;
    const v2x = cx - bx;
    const v2y = cy - by;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-15 || l2 < 1e-15) return 180;
    const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
    const phi = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
    return Math.min(phi, 180 - phi);
}

/**
 * @param {object} doc
 * @param {object} ruleSet from memsDrcSchema defaultDrcRuleSet shape
 * @returns {{ violations: DrcViolation[], stats: { checksRun: number, durationMs: number } }}
 */
export function runDrc(doc, ruleSet) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    /** @type {DrcViolation[]} */
    const violations = [];
    let checksRun = 0;

    const kernel = ruleSet.kernel || {};
    const tessOpts = {
        lineHalfWidthUm: kernel.lineHalfWidthUm ?? 0.005,
        pathCapUm: kernel.pathCapUm ?? 0.01,
        arcToleranceUm: kernel.arcToleranceUm ?? 0.25,
    };

    const metaOut = {};
    const flat = flattenActiveCell(doc, { metaOut });
    if (metaOut.truncated) {
        violations.unshift(
            mkViolation({
                severity: 'warning',
                rule: 'memsNote',
                message:
                    'DRC ran on a partial geometry set (expanded shape budget reached). Results may be incomplete for large wafer maps — hide layers, simplify the device cell, or run checks on a smaller layout.',
                xUm: 0,
                yUm: 0,
            })
        );
    }
    /** @type {{ id: string, name: string, entities: object[] }[]} */
    const layers = flat.map((row) => ({
        id: row.layerId,
        name: row.layerName || row.layerId,
        entities: row.entities || [],
    }));

    const offsetOpts = { arcToleranceUm: tessOpts.arcToleranceUm };

    function entityMp(e) {
        return entityToMultiPolygonNm(e, tessOpts);
    }

    /** ---------- Min width ---------- */
    for (const rule of ruleSet.minWidth || []) {
        if (rule.enabled === false) continue;
        const minUm = Number(rule.minUm);
        if (!(minUm > 0)) continue;
        const half = minUm / 2;
        const epsArea = (minUm * minUm) / 1e6;

        for (const L of layers) {
            if (!ruleMatchesLayers(rule.layers || ['*'], L.name)) continue;
            for (const e of L.entities) {
                checksRun++;
                const mp = entityMp(e);
                if (!mp.length) continue;
                const area0 = multiPolygonAreaNm(mp);
                if (area0 <= epsArea) continue;

                const shrunk = offsetMultiPolygonNm(mp, -half, offsetOpts);
                const area1 = multiPolygonAreaNm(shrunk);
                if (area1 <= epsArea) {
                    const b = entityBBox(e) || multiPolygonBBoxUm(mp);
                    const cx = b ? (b.minX + b.maxX) / 2 : 0;
                    const cy = b ? (b.minY + b.maxY) / 2 : 0;
                    violations.push(
                        mkViolation({
                            severity: rule.severity || 'error',
                            rule: 'minWidth',
                            message: `Min width ${minUm} µm — feature too narrow on “${L.name}”`,
                            layerId: L.id,
                            layerName: L.name,
                            entityIds: [e.id],
                            xUm: cx,
                            yUm: cy,
                            bboxUm: b || undefined,
                        })
                    );
                }
            }
        }
    }

    /** ---------- Min spacing (same layer, pairwise) ---------- */
    for (const rule of ruleSet.minSpacing || []) {
        if (rule.enabled === false) continue;
        const minUm = Number(rule.minUm);
        if (!(minUm > 0)) continue;
        const half = minUm / 2;

        for (const L of layers) {
            if (!ruleMatchesLayers(rule.layers || ['*'], L.name)) continue;
            const ents = L.entities.filter((e) => entityMp(e).length);
            for (let i = 0; i < ents.length; i++) {
                const mpi = entityMp(ents[i]);
                for (let j = i + 1; j < ents.length; j++) {
                    checksRun++;
                    const mpj = entityMp(ents[j]);
                    const overlap = mpi.length && mpj.length ? polygonClipping.intersection(mpi, mpj) : emptyMultiPolygon();
                    const overlapA = multiPolygonAreaNm(overlap);
                    if (overlapA > 1e-9) continue;

                    const di = offsetMultiPolygonNm(mpi, half, offsetOpts);
                    const dj = offsetMultiPolygonNm(mpj, half, offsetOpts);
                    const close = di.length && dj.length ? polygonClipping.intersection(di, dj) : emptyMultiPolygon();
                    const closeA = multiPolygonAreaNm(close);
                    if (closeA > 1e-9) {
                        const b = multiPolygonBBoxUm(close);
                        const cx = b ? (b.minX + b.maxX) / 2 : 0;
                        const cy = b ? (b.minY + b.maxY) / 2 : 0;
                        violations.push(
                            mkViolation({
                                severity: rule.severity || 'error',
                                rule: 'minSpacing',
                                message: `Min spacing ${minUm} µm — shapes too close on “${L.name}”`,
                                layerId: L.id,
                                layerName: L.name,
                                entityIds: [ents[i].id, ents[j].id],
                                xUm: cx,
                                yUm: cy,
                                bboxUm: b || undefined,
                            })
                        );
                    }
                }
            }
        }
    }

    /** ---------- Layer clearance ---------- */
    for (const rule of ruleSet.clearance || []) {
        if (rule.enabled === false) continue;
        const minUm = Number(rule.minUm);
        if (!(minUm > 0)) continue;
        const half = minUm / 2;

        const LA = layers.filter((l) => layerNameMatches(rule.layerA, l.name));
        const LB = layers.filter((l) => layerNameMatches(rule.layerB, l.name));
        if (!LA.length || !LB.length) continue;

        const unionMp = (layerList) => {
            /** @type {import('polygon-clipping').MultiPolygon} */
            let acc = emptyMultiPolygon();
            for (const L of layerList) {
                for (const e of L.entities) {
                    const mp = entityMp(e);
                    if (!mp.length) continue;
                    acc = acc.length === 0 ? mp : polygonClipping.union(acc, mp);
                }
            }
            return sanitizeMultiPolygonNm(acc);
        };

        const UA = unionMp(LA);
        const UB = unionMp(LB);
        if (!UA.length || !UB.length) continue;

        checksRun++;
        const overlap = polygonClipping.intersection(UA, UB);
        const overlapA = multiPolygonAreaNm(overlap);

        const dilA = offsetMultiPolygonNm(UA, half, offsetOpts);
        const dilB = offsetMultiPolygonNm(UB, half, offsetOpts);
        const touch = dilA.length && dilB.length ? polygonClipping.intersection(dilA, dilB) : emptyMultiPolygon();
        const touchA = multiPolygonAreaNm(touch);

        if (overlapA <= 1e-9 && touchA > 1e-9) {
            const b = multiPolygonBBoxUm(touch);
            const cx = b ? (b.minX + b.maxX) / 2 : 0;
            const cy = b ? (b.minY + b.maxY) / 2 : 0;
            violations.push(
                mkViolation({
                    severity: rule.severity || 'error',
                    rule: 'clearance',
                    message: `Clearance ${minUm} µm between “${rule.layerA}” and “${rule.layerB}”`,
                    xUm: cx,
                    yUm: cy,
                    bboxUm: b || undefined,
                })
            );
        }
    }

    /** ---------- Enclosure (inner must sit inside outer by margin) ---------- */
    for (const rule of ruleSet.enclosure || []) {
        if (rule.enabled === false) continue;
        const minUm = Number(rule.minUm);
        if (!(minUm > 0)) continue;

        const Linner = layers.filter((l) => layerNameMatches(rule.innerLayer, l.name));
        const Louter = layers.filter((l) => layerNameMatches(rule.outerLayer, l.name));
        if (!Linner.length || !Louter.length) continue;

        /** @type {import('polygon-clipping').MultiPolygon} */
        let outerUnion = emptyMultiPolygon();
        for (const L of Louter) {
            for (const e of L.entities) {
                const mp = entityMp(e);
                if (!mp.length) continue;
                outerUnion = outerUnion.length === 0 ? mp : polygonClipping.union(outerUnion, mp);
            }
        }
        outerUnion = sanitizeMultiPolygonNm(outerUnion);
        if (!outerUnion.length) continue;

        for (const L of Linner) {
            for (const e of L.entities) {
                checksRun++;
                const innerMp = entityMp(e);
                if (!innerMp.length) continue;
                const expandedInner = offsetMultiPolygonNm(innerMp, minUm, offsetOpts);
                if (!expandedInner.length) continue;
                const leak = polygonClipping.difference(expandedInner, outerUnion);
                const leakA = multiPolygonAreaNm(leak);
                if (leakA > 1e-9) {
                    const b = multiPolygonBBoxUm(leak) || entityBBox(e);
                    const cx = b ? (b.minX + b.maxX) / 2 : 0;
                    const cy = b ? (b.minY + b.maxY) / 2 : 0;
                    violations.push(
                        mkViolation({
                            severity: rule.severity || 'error',
                            rule: 'enclosure',
                            message: `Enclosure ${minUm} µm — inner “${rule.innerLayer}” not enclosed by “${rule.outerLayer}”`,
                            layerId: L.id,
                            layerName: L.name,
                            entityIds: [e.id],
                            xUm: cx,
                            yUm: cy,
                            bboxUm: b || undefined,
                        })
                    );
                }
            }
        }
    }

    /** ---------- Minimum overlap area ---------- */
    for (const rule of ruleSet.minOverlap || []) {
        if (rule.enabled === false) continue;
        const minA = Number(rule.minAreaUm2);
        if (!(minA > 0)) continue;

        const LA = layers.filter((l) => layerNameMatches(rule.layerA, l.name));
        const LB = layers.filter((l) => layerNameMatches(rule.layerB, l.name));

        let UA = emptyMultiPolygon();
        for (const L of LA) {
            for (const e of L.entities) {
                const mp = entityMp(e);
                if (!mp.length) continue;
                UA = UA.length === 0 ? mp : polygonClipping.union(UA, mp);
            }
        }
        UA = sanitizeMultiPolygonNm(UA);

        let UB = emptyMultiPolygon();
        for (const L of LB) {
            for (const e of L.entities) {
                const mp = entityMp(e);
                if (!mp.length) continue;
                UB = UB.length === 0 ? mp : polygonClipping.union(UB, mp);
            }
        }
        UB = sanitizeMultiPolygonNm(UB);

        checksRun++;
        if (!UA.length || !UB.length) continue;
        const ov = polygonClipping.intersection(UA, UB);
        const areaUm2 = multiPolygonAreaNm(ov) / (1000 * 1000);
        if (areaUm2 < minA - 1e-15) {
            const b = multiPolygonBBoxUm(ov);
            const cx = b ? (b.minX + b.maxX) / 2 : 0;
            const cy = b ? (b.minY + b.maxY) / 2 : 0;
            violations.push(
                mkViolation({
                    severity: rule.severity || 'warning',
                    rule: 'minOverlap',
                    message: `Min overlap ${minA} µm² between “${rule.layerA}” and “${rule.layerB}” (got ${areaUm2.toFixed(4)})`,
                    xUm: cx,
                    yUm: cy,
                    bboxUm: b || undefined,
                })
            );
        }
    }

    /** ---------- Area min / max ---------- */
    for (const rule of ruleSet.minArea || []) {
        if (rule.enabled === false) continue;
        const minA = Number(rule.minUm2);
        if (!(minA > 0)) continue;
        for (const L of layers) {
            if (!ruleMatchesLayers(rule.layers || ['*'], L.name)) continue;
            for (const e of L.entities) {
                checksRun++;
                const mp = entityMp(e);
                const a = multiPolygonAreaNm(mp) / (1000 * 1000);
                if (a > 0 && a < minA) {
                    const b = entityBBox(e);
                    violations.push(
                        mkViolation({
                            severity: rule.severity || 'error',
                            rule: 'minArea',
                            message: `Min area ${minA} µm² on “${L.name}”`,
                            layerId: L.id,
                            layerName: L.name,
                            entityIds: [e.id],
                            xUm: b ? (b.minX + b.maxX) / 2 : 0,
                            yUm: b ? (b.minY + b.maxY) / 2 : 0,
                            bboxUm: b || undefined,
                        })
                    );
                }
            }
        }
    }

    for (const rule of ruleSet.maxArea || []) {
        if (rule.enabled === false) continue;
        const maxA = Number(rule.maxUm2);
        if (!(maxA > 0)) continue;
        for (const L of layers) {
            if (!ruleMatchesLayers(rule.layers || ['*'], L.name)) continue;
            for (const e of L.entities) {
                checksRun++;
                const mp = entityMp(e);
                const a = multiPolygonAreaNm(mp) / (1000 * 1000);
                if (a > maxA) {
                    const b = entityBBox(e);
                    violations.push(
                        mkViolation({
                            severity: rule.severity || 'warning',
                            rule: 'maxArea',
                            message: `Max area ${maxA} µm² exceeded on “${L.name}”`,
                            layerId: L.id,
                            layerName: L.name,
                            entityIds: [e.id],
                            xUm: b ? (b.minX + b.maxX) / 2 : 0,
                            yUm: b ? (b.minY + b.maxY) / 2 : 0,
                            bboxUm: b || undefined,
                        })
                    );
                }
            }
        }
    }

    /** ---------- Acute angles ---------- */
    for (const rule of ruleSet.acuteAngle || []) {
        if (rule.enabled === false) continue;
        const minDeg = Number(rule.minInteriorDeg);
        if (!(minDeg > 0) || minDeg >= 90) continue;

        for (const L of layers) {
            if (!ruleMatchesLayers(rule.layers || ['*'], L.name)) continue;
            for (const e of L.entities) {
                checksRun++;
                const { rings } = entityToClosedRingsUm(e, tessOpts);
                for (const ringUm of rings || []) {
                    const pts = ringUm;
                    const n = pts.length;
                    const upto = pts[0].x === pts[n - 1].x && pts[0].y === pts[n - 1].y ? n - 1 : n;
                    if (upto < 3) continue;
                    for (let i = 0; i < upto; i++) {
                        const prev = pts[(i - 1 + upto) % upto];
                        const cur = pts[i];
                        const next = pts[(i + 1) % upto];
                        const sharp = smallestCornerAngleDeg(prev.x, prev.y, cur.x, cur.y, next.x, next.y);
                        if (sharp < minDeg && sharp > 0.05) {
                            violations.push(
                                mkViolation({
                                    severity: rule.severity || 'warning',
                                    rule: 'acuteAngle',
                                    message: `Sharp corner ~${sharp.toFixed(1)}° (< ${minDeg}°) on “${L.name}”`,
                                    layerId: L.id,
                                    layerName: L.name,
                                    entityIds: [e.id],
                                    xUm: cur.x,
                                    yUm: cur.y,
                                    bboxUm: {
                                        minX: cur.x - 1,
                                        minY: cur.y - 1,
                                        maxX: cur.x + 1,
                                        maxY: cur.y + 1,
                                    },
                                })
                            );
                        }
                    }
                }
            }
        }
    }

    /** ---------- Pad size (bbox) ---------- */
    for (const rule of ruleSet.pads || []) {
        if (rule.enabled === false) continue;
        const minW = Number(rule.minWidthUm);
        const minH = Number(rule.minHeightUm);
        if (!(minW > 0) || !(minH > 0)) continue;

        for (const L of layers) {
            if (!layerNameMatches(rule.layerPattern, L.name)) continue;
            for (const e of L.entities) {
                checksRun++;
                const b = entityBBox(e);
                if (!b) continue;
                const w = b.maxX - b.minX;
                const h = b.maxY - b.minY;
                if (w < minW || h < minH) {
                    violations.push(
                        mkViolation({
                            severity: rule.severity || 'error',
                            rule: 'padSize',
                            message: `Pad min ${minW}×${minH} µm on “${L.name}”`,
                            layerId: L.id,
                            layerName: L.name,
                            entityIds: [e.id],
                            xUm: (b.minX + b.maxX) / 2,
                            yUm: (b.minY + b.maxY) / 2,
                            bboxUm: b,
                        })
                    );
                }
            }
        }
    }

    /** ---------- Via / TSV diameter ---------- */
    for (const rule of ruleSet.viaTsv || []) {
        if (rule.enabled === false) continue;
        const minD = rule.minDiameterUm != null ? Number(rule.minDiameterUm) : null;
        const maxD = rule.maxDiameterUm != null ? Number(rule.maxDiameterUm) : null;

        for (const L of layers) {
            if (!layerNameMatches(rule.layerPattern, L.name)) continue;
            for (const e of L.entities) {
                checksRun++;
                let dMin;
                if (e.type === 'ellipse') {
                    dMin = 2 * Math.min(e.rx, e.ry);
                } else {
                    const b = entityBBox(e);
                    if (!b) continue;
                    dMin = Math.min(b.maxX - b.minX, b.maxY - b.minY);
                }
                if (minD != null && Number.isFinite(minD) && dMin < minD - 1e-9) {
                    const b = entityBBox(e);
                    violations.push(
                        mkViolation({
                            severity: rule.severity || 'error',
                            rule: 'viaSize',
                            message: `Via min Ø ${minD} µm on “${L.name}”`,
                            layerId: L.id,
                            layerName: L.name,
                            entityIds: [e.id],
                            xUm: b ? (b.minX + b.maxX) / 2 : 0,
                            yUm: b ? (b.minY + b.maxY) / 2 : 0,
                            bboxUm: b || undefined,
                        })
                    );
                }
                if (maxD != null && Number.isFinite(maxD) && dMin > maxD + 1e-9) {
                    const b = entityBBox(e);
                    violations.push(
                        mkViolation({
                            severity: rule.severity || 'warning',
                            rule: 'viaSize',
                            message: `Via max Ø ${maxD} µm on “${L.name}”`,
                            layerId: L.id,
                            layerName: L.name,
                            entityIds: [e.id],
                            xUm: b ? (b.minX + b.maxX) / 2 : 0,
                            yUm: b ? (b.minY + b.maxY) / 2 : 0,
                            bboxUm: b || undefined,
                        })
                    );
                }
            }
        }
    }

    /** ---------- Process notes (manual checklist — emit as informational warnings in batch only) ---------- */
    for (const rule of ruleSet.memsNotes || []) {
        if (rule.enabled === false) continue;
        violations.push(
            mkViolation({
                severity: rule.severity || 'warning',
                rule: 'memsNote',
                message: `[Process] ${rule.note || rule.id}`,
                xUm: 0,
                yUm: 0,
            })
        );
        checksRun++;
    }

    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
        violations,
        stats: { checksRun, durationMs: t1 - t0 },
    };
}
