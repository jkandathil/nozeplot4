/**
 * Canvas interaction helpers for MEMS layout editor (µm space).
 */

import {
    entityBBox,
    rotateEntityAround,
    resizeRectAABBNwSe,
    resizeEllipseAABBNwSe,
} from './memsGeometry.js';
import { resolvedEntityBBox } from './memsHierarchy.js';
import { findEntity } from './memsMaskDoc.js';

export function primarySelectionId(selectedIds) {
    if (!selectedIds || selectedIds.size !== 1) return null;
    return [...selectedIds][0];
}

/**
 * Hit-test rotation handle (above bbox) or SE resize handle for unrotated rect/ellipse.
 */
export function pickTransformOverlay(wx, wy, doc, selectedIds, viewBoxW) {
    const id = primarySelectionId(selectedIds);
    if (!id) return null;
    const hit = findEntity(doc, id);
    if (!hit) return null;
    if (hit.layer.locked || hit.layer.selectable === false) return null;
    const e = hit.entity;
    const b = resolvedEntityBBox(doc, e);
    if (!b) return null;
    const tol = Math.max(10, viewBoxW / 120);

    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const rotDist = Math.max(24, viewBoxW / 60);
    const rotX = cx;
    const rotY = b.minY - rotDist;
    if (Math.hypot(wx - rotX, wy - rotY) < tol * 2) {
        return { kind: 'rotate', entityId: id, layerId: hit.layer.id };
    }

    const rot = e.rotationDeg || 0;
    if (!rot && (e.type === 'rect' || e.type === 'ellipse')) {
        if (Math.hypot(wx - b.maxX, wy - b.maxY) < tol * 2) {
            return { kind: 'resize', handle: 'se', entityId: id, layerId: hit.layer.id };
        }
    }
    return null;
}

export function centroidFromBBox(b) {
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/**
 * Apply rotate gesture: delta from initial mouse angle around bbox centroid.
 */
export function rotatedEntityFromGesture(baseEntity, wx, wy, ox, oy, doc) {
    const b = resolvedEntityBBox(doc, baseEntity);
    if (!b) return baseEntity;
    const { x: cx, y: cy } = centroidFromBBox(b);
    const a0 = Math.atan2(oy - cy, ox - cx);
    const a1 = Math.atan2(wy - cy, wx - cx);
    let deltaDeg = ((a1 - a0) * 180) / Math.PI;
    while (deltaDeg > 180) deltaDeg -= 360;
    while (deltaDeg < -180) deltaDeg += 360;
    return rotateEntityAround(baseEntity, cx, cy, deltaDeg);
}

export function resizedEntityFromCorner(baseEntity, wx, wy) {
    const e = baseEntity;
    if (e.type === 'rect' && !(e.rotationDeg || 0)) {
        return resizeRectAABBNwSe(e, wx, wy);
    }
    if (e.type === 'ellipse' && !(e.rotationDeg || 0)) {
        return resizeEllipseAABBNwSe(e, wx, wy);
    }
    return e;
}
