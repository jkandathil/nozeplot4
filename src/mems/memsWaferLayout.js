/**
 * Build a wafer-scale mask layout: die grid, dicing scribe lines, optional GDS device.
 * GDS layer/datatype buckets are preserved: each becomes a **mask layer** on the layout cell; the
 * library master keeps the same layer stack so instance expansion maps master layer i → layout layer i
 * (aligned across all masks). Coordinates: layout µm, die outline centered on origin.
 */

import { translateEntity } from './memsGeometry.js';
import { cellContentBBoxUm, normalizeInstanceArray } from './memsHierarchy.js';
import { importGdsToMemsDoc } from './memsGdsImport.js';
import { normalizeLayerMetadata } from './memsLayoutModel.js';
import {
    newId,
    newMemsMaskDesignDoc,
    setProjectDie,
    setProjectName,
    addInstance,
    addLine,
    addEllipse,
    appendEntitiesToCellLayer,
    replaceCellLayers,
    updateProjectMetadata,
    cloneEntityNewIds,
} from './memsMaskDoc.js';

/** 1 mm in µm */
const MM_UM = 1000;

export const WAFER_PRESETS_MM = [
    { label: '4 inch (100 mm)', mm: 100 },
    { label: '6 inch (150 mm)', mm: 150 },
    { label: '8 inch (200 mm)', mm: 200 },
    { label: '12 inch (300 mm)', mm: 300 },
];

/**
 * @param {number} Ru usable radius (µm)
 * @param {number} pitchX
 * @param {number} pitchY
 * @param {number} W die width
 * @param {number} H die height
 */
export function gridFitsCircle(Ru, x0, y0, cols, rows, pitchX, pitchY, W, H) {
    if (Ru <= 0 || cols < 1 || rows < 1) return false;
    const Ru2 = Ru * Ru;
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const ox = x0 + i * pitchX;
            const oy = y0 + j * pitchY;
            const corners = [
                [ox, oy],
                [ox + W, oy],
                [ox + W, oy + H],
                [ox, oy + H],
            ];
            for (const [px, py] of corners) {
                if (px * px + py * py > Ru2 + 1e-6) return false;
            }
        }
    }
    return true;
}

/**
 * Maximize cols×rows grid (centered at origin) that fits in usable radius.
 */
export function maxDieGridInCircle(Ru, pitchX, pitchY, W, H) {
    let best = { cols: 1, rows: 1 };
    let bestCount = 1;
    const maxN = Math.min(400, Math.ceil((2 * Ru) / Math.max(Math.min(pitchX, pitchY), 1)) + 4);
    for (let cols = 1; cols <= maxN; cols++) {
        const gridW = (cols - 1) * pitchX + W;
        for (let rows = 1; rows <= maxN; rows++) {
            const gridH = (rows - 1) * pitchY + H;
            const x0 = -gridW / 2;
            const y0 = -gridH / 2;
            if (!gridFitsCircle(Ru, x0, y0, cols, rows, pitchX, pitchY, W, H)) continue;
            const n = cols * rows;
            if (n > bestCount) {
                bestCount = n;
                best = { cols, rows };
            }
        }
    }
    return best;
}

/**
 * Copy imported device into the library cell, **one layout layer per GDS layer** (order preserved).
 */
function mergeImportedDevicePreservingLayers(doc, importedDoc, srcCellId, libraryCellId, warnings) {
    const src = importedDoc.cells.find((c) => c.id === srcCellId);
    if (!src?.layers?.length) {
        warnings.push('Selected GDS structure has no layers.');
        return doc;
    }

    const bb = cellContentBBoxUm(importedDoc, srcCellId);
    if (!bb || !Number.isFinite(bb.minX)) {
        warnings.push('Could not compute device bounding box.');
        return doc;
    }

    const dx = -bb.minX;
    const dy = -bb.minY;

    const newLayers = (src.layers || []).map((L, idx) => {
        /** @type {object[]} */
        const ents = [];
        for (const e of L.entities || []) {
            if (e.type === 'instance') {
                warnings.push(
                    'Skipped nested cell instance in device — export a flattened leaf cell from layout CAD if needed.'
                );
                continue;
            }
            ents.push(translateEntity(cloneEntityNewIds(e), dx, dy));
        }
        return {
            id: newId(),
            name: L.name || `Layer ${idx + 1}`,
            color: L.color,
            visible: L.visible !== false,
            locked: !!L.locked,
            selectable: L.selectable !== false,
            opacity: L.opacity ?? 1,
            metadata: normalizeLayerMetadata(L.metadata),
            entities: ents,
        };
    });

    if (!newLayers.some((L) => L.entities.length)) {
        warnings.push('No drawable shapes were copied — check the selected structure.');
    }

    return replaceCellLayers(doc, libraryCellId, newLayers, newLayers[0]?.id);
}

/**
 * Build layout cell layers: [Mask·0…Mask·N-1] + wafer + dicing + alignment.
 * Master layer index i must map to layout layer index i (see {@link flattenActiveCell}).
 */
function buildLayoutLayerStackFromLibrary(libraryCell) {
    const libLayers = libraryCell.layers || [];
    const nMask = libLayers.length;

    const maskLayers = libLayers.map((L, idx) => ({
        id: newId(),
        name: `Mask · ${L.name}`,
        color: L.color,
        visible: true,
        locked: false,
        selectable: true,
        opacity: L.opacity ?? 1,
        metadata: normalizeLayerMetadata({
            ...L.metadata,
            waferMaskRole: 'fieldReplica',
            sourceLibraryLayerIndex: idx,
        }),
        entities: [],
    }));

    const waferLayer = {
        id: newId(),
        name: 'Wafer (guide)',
        color: '#64748b',
        visible: true,
        locked: false,
        selectable: true,
        opacity: 1,
        metadata: normalizeLayerMetadata({ waferMaskRole: 'waferOutline', purpose: 'guide' }),
        entities: [],
    };
    const dicingLayer = {
        id: newId(),
        name: 'Dicing',
        color: '#94a3b8',
        visible: true,
        locked: false,
        selectable: true,
        opacity: 1,
        metadata: normalizeLayerMetadata({ waferMaskRole: 'dicing', purpose: 'scribe' }),
        entities: [],
    };
    const alignLayer = {
        id: newId(),
        name: 'Alignment',
        color: '#fbbf24',
        visible: true,
        locked: false,
        selectable: true,
        opacity: 1,
        metadata: normalizeLayerMetadata({ waferMaskRole: 'alignment', purpose: 'litho marks' }),
        entities: [],
    };

    const all = [...maskLayers, waferLayer, dicingLayer, alignLayer];

    return {
        allLayers: all,
        firstMaskLayerId: maskLayers[0]?.id,
        waferLayerId: waferLayer.id,
        dicingLayerId: dicingLayer.id,
        alignmentLayerId: alignLayer.id,
        maskLayerCount: nMask,
    };
}

/** Photolithography-style crosses near the usable rim (global coords, centered wafer). */
function addPhotolithographyAlignmentMarks(doc, layerId, waferRadiusUm, halfArmUm, insetUm) {
    let next = doc;
    const rPos = Math.max(waferRadiusUm - insetUm, waferRadiusUm * 0.85);
    const pts = [
        [rPos, 0],
        [-rPos, 0],
        [0, rPos],
        [0, -rPos],
    ];
    const h = Math.max(20, halfArmUm);
    for (const [cx, cy] of pts) {
        next = addLine(next, layerId, {
            x1: cx - h,
            y1: cy,
            x2: cx + h,
            y2: cy,
        });
        next = addLine(next, layerId, {
            x1: cx,
            y1: cy - h,
            x2: cx,
            y2: cy + h,
        });
    }
    return next;
}

/**
 * @param {{
 *   waferDiameterMm: number,
 *   edgeExclusionMm?: number,
 *   streetUm: number,
 *   gdsBytes?: ArrayBuffer | null,
 *   deviceStructureName?: string | null,
 *   manualDieWidthUm?: number,
 *   manualDieHeightUm?: number,
 *   projectLabel?: string,
 *   includeAlignmentMarks?: boolean,
 *   alignmentMarkHalfUm?: number,
 *   alignmentInsetUm?: number,
 * }} opts
 */
export function buildWaferLayoutDocument(opts) {
    const warnings = [];
    const diaMm = Math.max(1, Number(opts.waferDiameterMm) || 150);
    const edgeMm = Math.max(0, Number(opts.edgeExclusionMm) ?? 3);
    const streetUm = Math.max(0, Number(opts.streetUm) ?? 80);
    const includeAlignment =
        opts.includeAlignmentMarks !== false && opts.includeAlignmentMarks !== '0';
    const alignHalf = Math.max(20, Number(opts.alignmentMarkHalfUm) ?? 150);
    const alignInset = Math.max(100, Number(opts.alignmentInsetUm) ?? 5000);

    const R_um = (diaMm * MM_UM) / 2;
    const Ru = Math.max(100, R_um - edgeMm * MM_UM);

    const label = opts.projectLabel?.trim() || `Wafer ${diaMm} mm`;

    let doc = newMemsMaskDesignDoc({
        projectName: label,
        libraryMasterName: 'Device cell',
        placeFirstInstance: false,
    });

    const layoutCell = doc.cells.find((c) => c.kind !== 'library') || doc.cells[0];
    let libraryCell = doc.cells.find((c) => c.kind === 'library');
    if (!layoutCell || !libraryCell) {
        warnings.push('Internal: missing layout or library cell.');
        return { doc, warnings, stats: null };
    }

    const libraryCellId = libraryCell.id;
    const layoutCellId = layoutCell.id;

    let dieW = Math.max(10, Number(opts.manualDieWidthUm) || 5000);
    let dieH = Math.max(10, Number(opts.manualDieHeightUm) || 5000);

    if (opts.gdsBytes) {
        try {
            let buf = opts.gdsBytes;
            if (buf instanceof Uint8Array) {
                buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            } else if (!(buf instanceof ArrayBuffer)) {
                buf = null;
            }
            if (!buf) throw new Error('Invalid GDS buffer');
            const imported = importGdsToMemsDoc(buf);
            let srcCell = imported.cells.find((c) => c.name === opts.deviceStructureName);
            if (!srcCell) {
                srcCell =
                    imported.cells.find((c) => c.kind === 'library') ||
                    imported.cells.find((c) => !/^TOP$/i.test(c.name)) ||
                    imported.cells[0];
            }
            if (srcCell) {
                doc = mergeImportedDevicePreservingLayers(doc, imported, srcCell.id, libraryCellId, warnings);
                libraryCell = doc.cells.find((c) => c.id === libraryCellId) || libraryCell;
                const bb = cellContentBBoxUm(doc, libraryCellId);
                if (bb && Number.isFinite(bb.minX)) {
                    dieW = Math.max(10, bb.maxX - bb.minX);
                    dieH = Math.max(10, bb.maxY - bb.minY);
                }
            }
        } catch (e) {
            warnings.push(`GDS import failed: ${e?.message || e}`);
        }
    } else {
        doc = appendEntitiesToCellLayer(doc, libraryCellId, libraryCell.layers[0].id, [
            {
                id: newId(),
                type: 'rect',
                x: 0,
                y: 0,
                width: dieW,
                height: dieH,
                rotationDeg: 0,
            },
        ]);
        warnings.push(
            'No GDS — single-mask placeholder rectangle in the Device cell; edit the library or re-run with GDS for multi-layer masks.'
        );
    }

    libraryCell = doc.cells.find((c) => c.id === libraryCellId);
    if (!libraryCell?.layers?.length) {
        warnings.push('Device library cell has no layers.');
        return { doc, warnings, stats: null };
    }

    const stack = buildLayoutLayerStackFromLibrary(libraryCell);
    doc = replaceCellLayers(doc, layoutCellId, stack.allLayers, stack.firstMaskLayerId);

    const pitchX = dieW + streetUm;
    const pitchY = dieH + streetUm;
    const { cols, rows } = maxDieGridInCircle(Ru, pitchX, pitchY, dieW, dieH);

    if (cols * rows === 0) {
        warnings.push('No dies fit inside usable radius — reduce die size or edge exclusion.');
    }

    const gridW = (cols - 1) * pitchX + dieW;
    const gridH = (rows - 1) * pitchY + dieH;
    const x0 = -gridW / 2;
    const y0 = -gridH / 2;

    doc = setProjectName(doc, label);
    doc = setProjectDie(doc, 2 * R_um, 2 * R_um);
    doc = updateProjectMetadata(doc, {
        description: `Wafer ${diaMm} mm Ø · ${edgeMm} mm edge · ${cols}×${rows} dies · ${stack.maskLayerCount} mask layer(s) · street ${streetUm} µm`,
        technology: 'Wafer map (wizard)',
    });

    doc = addEllipse(doc, stack.waferLayerId, {
        cx: 0,
        cy: 0,
        rx: R_um,
        ry: R_um,
        rotationDeg: 0,
    });

    const margin = streetUm;
    const xMin = x0 - margin;
    const xMax = x0 + gridW + margin;
    const yMin = y0 - margin;
    const yMax = y0 + gridH + margin;

    for (let j = 0; j < rows - 1; j++) {
        const y = y0 + j * pitchY + dieH + streetUm / 2;
        doc = addLine(doc, stack.dicingLayerId, { x1: xMin, y1: y, x2: xMax, y2: y });
    }
    for (let i = 0; i < cols - 1; i++) {
        const x = x0 + i * pitchX + dieW + streetUm / 2;
        doc = addLine(doc, stack.dicingLayerId, { x1: x, y1: yMin, x2: x, y2: yMax });
    }

    if (includeAlignment) {
        doc = addPhotolithographyAlignmentMarks(doc, stack.alignmentLayerId, R_um, alignHalf, alignInset);
    }

    const arr = normalizeInstanceArray({ rows: 1, cols: 1, pitchXUm: 0, pitchYUm: 0 });
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            doc = addInstance(doc, stack.firstMaskLayerId, {
                masterCellId: libraryCellId,
                x: x0 + i * pitchX,
                y: y0 + j * pitchY,
                rotationDeg: 0,
                scaleX: 1,
                scaleY: 1,
                mirrorX: false,
                mirrorY: false,
                array: arr,
            });
        }
    }

    const stats = {
        waferDiameterMm: diaMm,
        usableRadiusUm: Ru,
        cols,
        rows,
        diePitchXUm: pitchX,
        diePitchYUm: pitchY,
        dieWidthUm: dieW,
        dieHeightUm: dieH,
        streetUm,
        edgeExclusionMm: edgeMm,
        maskLayerCount: stack.maskLayerCount,
    };

    return { doc, warnings, stats };
}
