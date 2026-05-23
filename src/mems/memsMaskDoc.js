/**
 * MEMS layout document — versioned project → cell → layer → shape graph (canonical µm).
 * JSON round-trip for GDS/DXF/DRC; UI reads via accessors below.
 */

import { nanoid } from 'nanoid';
import { translateEntity } from './memsGeometry.js';
import { cellContentBBoxUm, normalizeInstanceArray } from './memsHierarchy.js';
import { clampOpacity, normalizeLayerMetadata } from './memsLayoutModel.js';

export const MEMS_DOC_VERSION = 8;

/** @typedef {'um'|'mm'} DisplayUnit */

/** @typedef {{ id: string, type: 'rect', x: number, y: number, width: number, height: number, rotationDeg?: number }} MemsRect */
/** @typedef {{ id: string, type: 'polygon', points: { x: number, y: number }[], holes?: { x: number, y: number }[][] }} MemsPolygon */
/** @typedef {{ id: string, type: 'ellipse', cx: number, cy: number, rx: number, ry: number, rotationDeg?: number }} MemsEllipse */
/** @typedef {{ id: string, type: 'line', x1: number, y1: number, x2: number, y2: number }} MemsLine */
/** @typedef {{ id: string, type: 'path', points: { x: number, y: number }[], widthUm?: number, pathtype?: number }} MemsPath */
/** @typedef {{ id: string, type: 'text', x: number, y: number, text: string, rotationDeg?: number, scale?: number, heightUm?: number, presentation?: number }} MemsText */
/** @typedef {MemsRect | MemsPolygon | MemsEllipse | MemsLine | MemsPath | MemsInstance | MemsText} MemsEntity */
/** @typedef {MemsEntity} MemsShape */

const DEFAULT_LAYER_PALETTE = [
    '#38bdf8',
    '#a78bfa',
    '#34d399',
    '#fb923c',
    '#f472b6',
    '#fbbf24',
    '#94a3b8',
];

export function newId() {
    return nanoid(12);
}

/** @returns {import('./memsLayoutModel.js').LayoutCell | undefined} */
export function activeCell(doc) {
    if (!doc?.cells?.length) return undefined;
    const id = doc.activeCellId;
    return doc.cells.find((c) => c.id === id) || doc.cells[0];
}

/** Layers of the active layout cell — primary editing surface. */
export function layoutLayers(doc) {
    const c = activeCell(doc);
    return c?.layers ?? [];
}

/** All layers in document order (cells → layers). Hit-testing, IDs, global ops. */
export function allLayersFlat(doc) {
    return (doc.cells || []).flatMap((c) => c.layers);
}

export function dieWidthUm(doc) {
    const d = doc?.project?.die;
    if (d && Number.isFinite(d.widthUm)) return d.widthUm;
    return Math.max(100, Number(doc?.dieWidthUm) || 5000);
}

export function dieHeightUm(doc) {
    const d = doc?.project?.die;
    if (d && Number.isFinite(d.heightUm)) return d.heightUm;
    return Math.max(100, Number(doc?.dieHeightUm) || 5000);
}

/**
 * Grow {@link project.die} so the symmetric outline (centered at origin) still contains all
 * geometry in the active cell — including instances — plus margin. Does not shrink the die;
 * use {@link fitDocumentDieToActiveCellContent} import flow or edit die manually to reduce size.
 */
export function expandProjectDieToCoverActiveCellContent(doc, opts = {}) {
    const cellId = doc.activeCellId;
    if (!cellId) return doc;
    const bbox = cellContentBBoxUm(doc, cellId);
    if (!bbox || !Number.isFinite(bbox.minX)) return doc;

    const w0 = Math.max(0, bbox.maxX - bbox.minX);
    const h0 = Math.max(0, bbox.maxY - bbox.minY);
    let margin =
        opts.marginUm != null && Number.isFinite(opts.marginUm) ? Math.max(0, opts.marginUm) : undefined;
    if (margin === undefined) {
        const frac =
            opts.marginFrac != null && Number.isFinite(opts.marginFrac) ? opts.marginFrac : 0.06;
        margin = Math.max(50, frac * Math.max(w0, h0, 1));
    }

    const halfNeedX = Math.max(-bbox.minX, bbox.maxX) + margin;
    const halfNeedY = Math.max(-bbox.minY, bbox.maxY) + margin;
    const needW = Math.max(100, 2 * halfNeedX);
    const needH = Math.max(100, 2 * halfNeedY);

    const curW = dieWidthUm(doc);
    const curH = dieHeightUm(doc);
    if (needW <= curW && needH <= curH) return doc;
    return setProjectDie(doc, Math.max(curW, needW), Math.max(curH, needH));
}

/** Half-extents of the die rectangle in layout µm (origin at die center). */
export function dieHalfExtentsUm(doc) {
    return { hx: dieWidthUm(doc) / 2, hy: dieHeightUm(doc) / 2 };
}

/** Layout µm (die-centered) → fab µm (lower-left die corner at (0,0), +Y down). */
export function centeredToFabUm(doc, x, y) {
    const { hx, hy } = dieHalfExtentsUm(doc);
    return { x: x + hx, y: y + hy };
}

function normalizeUserOrigin(raw) {
    if (!raw || typeof raw !== 'object') return { x: 0, y: 0 };
    const x = Number(raw.x);
    const y = Number(raw.y);
    return {
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
    };
}

/**
 * Movable design origin in global layout µm (same frame as stored geometry).
 * User coordinates: global minus this offset.
 */
export function userOriginUm(doc) {
    return normalizeUserOrigin(doc?.project?.userOriginUm);
}

export function globalToUserUm(doc, gx, gy) {
    const o = userOriginUm(doc);
    return { x: gx - o.x, y: gy - o.y };
}

export function userToGlobalUm(doc, ux, uy) {
    const o = userOriginUm(doc);
    return { x: ux + o.x, y: uy + o.y };
}

export function setUserOriginUm(doc, x, y) {
    return {
        ...doc,
        project: {
            ...doc.project,
            userOriginUm: normalizeUserOrigin({ x, y }),
        },
    };
}

/**
 * Shift every entity by (dx, dy) in all cells (library + layout).
 * @param {object} doc
 * @param {number} dx
 * @param {number} dy
 */
export function translateDocumentEntities(doc, dx, dy) {
    return {
        ...doc,
        cells: (doc.cells || []).map((cell) => ({
            ...cell,
            layers: (cell.layers || []).map((L) => ({
                ...L,
                entities: (L.entities || []).map((e) => translateEntity(e, dx, dy)),
            })),
        })),
    };
}

function migrateCornerOriginToDieCenter(doc) {
    const dw = dieWidthUm(doc);
    const dh = dieHeightUm(doc);
    return translateDocumentEntities(doc, -dw / 2, -dh / 2);
}

let __memsMaskBootstrapCache = null;

/**
 * One-shot load from localStorage for MEMS Studio (survives React Strict Mode double init).
 * Migrates stored docs and reports whether layout guides were saved in pre-v7 corner space.
 * @param {string} storageKey
 * @param {string[]} [legacyKeys]
 */
export function bootstrapMemsMaskStudio(storageKey, legacyKeys = []) {
    const cacheKey = `${storageKey}\0${legacyKeys.join('\0')}`;
    if (__memsMaskBootstrapCache?.cacheKey === cacheKey) {
        return __memsMaskBootstrapCache.val;
    }
    try {
        let raw = localStorage.getItem(storageKey);
        if (!raw && legacyKeys.length) {
            for (const k of legacyKeys) {
                raw = localStorage.getItem(k);
                if (raw) break;
            }
        }
        if (!raw) {
            const doc = emptyMemsMaskDoc();
            const val = { doc, guidesNeedCornerShift: false };
            __memsMaskBootstrapCache = { cacheKey, val };
            return val;
        }
        const parsed = JSON.parse(raw);
        const prevVer = Number(parsed.version);
        const guidesNeedCornerShift = Number.isFinite(prevVer) ? prevVer < 7 : true;
        const doc = migrateMemsMaskDoc(parsed);
        try {
            localStorage.setItem(storageKey, JSON.stringify(doc));
        } catch {
            /* quota */
        }
        const val = { doc, guidesNeedCornerShift };
        __memsMaskBootstrapCache = { cacheKey, val };
        return val;
    } catch {
        const doc = emptyMemsMaskDoc();
        const val = { doc, guidesNeedCornerShift: false };
        __memsMaskBootstrapCache = { cacheKey, val };
        return val;
    }
}

export function projectDisplayUnit(doc) {
    const u = doc?.project?.displayUnit ?? doc?.displayUnit;
    return u === 'mm' ? 'mm' : 'um';
}

export function projectName(doc) {
    return typeof doc?.project?.name === 'string'
        ? doc.project.name
        : typeof doc?.name === 'string'
          ? doc.name
          : 'Untitled layout';
}

/**
 * @param {(layers: object[]) => object[]} fn
 */
export function mapActiveCellLayers(doc, fn) {
    const cid = doc.activeCellId;
    return {
        ...doc,
        cells: doc.cells.map((cell) =>
            cell.id === cid ? { ...cell, layers: fn(cell.layers) } : cell
        ),
    };
}

/**
 * Map layers of an arbitrary cell (e.g. library master when building wafer layouts).
 * @param {(layers: object[]) => object[]} fn
 */
export function mapCellLayers(doc, cellId, fn) {
    return {
        ...doc,
        cells: doc.cells.map((cell) =>
            cell.id === cellId ? { ...cell, layers: fn(cell.layers) } : cell
        ),
    };
}

/** Append entities to one layer inside a specific cell (library or layout). */
export function appendEntitiesToCellLayer(doc, cellId, layerId, newEntities) {
    if (!newEntities?.length) return doc;
    return mapCellLayers(doc, cellId, (layers) =>
        layers.map((L) =>
            L.id === layerId ? { ...L, entities: [...L.entities, ...newEntities] } : L
        )
    );
}

/**
 * Replace all layers of a cell (e.g. rebuild mask stack for wafer layout).
 * If the active cell is this cell and {@link preferredActiveLayerId} is set and exists in {@link newLayers}, updates {@link activeLayerId}.
 */
export function replaceCellLayers(doc, cellId, newLayers, preferredActiveLayerId) {
    const next = {
        ...doc,
        cells: doc.cells.map((cell) =>
            cell.id === cellId ? { ...cell, layers: newLayers } : cell
        ),
    };
    if (
        doc.activeCellId === cellId &&
        typeof preferredActiveLayerId === 'string' &&
        newLayers.some((l) => l.id === preferredActiveLayerId)
    ) {
        return { ...next, activeLayerId: preferredActiveLayerId };
    }
    return next;
}

export function emptyMemsMaskDoc() {
    const layerId = newId();
    const cellId = newId();
    const projId = newId();
    return {
        version: MEMS_DOC_VERSION,
        project: {
            id: projId,
            name: 'Untitled layout',
            unit: 'um',
            displayUnit: /** @type {DisplayUnit} */ ('um'),
            die: { widthUm: 5000, heightUm: 5000 },
            userOriginUm: { x: 0, y: 0 },
            metadata: {
                description: '',
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
                layers: [
                    {
                        id: layerId,
                        name: 'Layer 1',
                        color: DEFAULT_LAYER_PALETTE[0],
                        visible: true,
                        locked: false,
                        selectable: true,
                        opacity: 1,
                        metadata: normalizeLayerMetadata({}),
                        entities: [],
                    },
                ],
            },
        ],
        activeCellId: cellId,
        activeLayerId: layerId,
    };
}

/**
 * Start a fresh named design: layout cell (Root) + one library master so instances can be used immediately.
 * Stays on the layout cell; optionally places one instance of the library at the origin.
 *
 * @param {{ projectName?: string, libraryMasterName?: string, placeFirstInstance?: boolean }} [opts]
 */
export function newMemsMaskDesignDoc(opts = {}) {
    const base = emptyMemsMaskDoc();
    const pn = typeof opts.projectName === 'string' ? opts.projectName.trim() : '';
    const ln = typeof opts.libraryMasterName === 'string' ? opts.libraryMasterName.trim() : '';
    const projectName = pn || 'Untitled layout';
    const libraryName = ln || 'Unit';

    const layoutCell = base.cells[0];
    const layoutLayerId = layoutCell.layers[0]?.id;
    if (!layoutLayerId) return base;

    const libLayerId = newId();
    const libCellId = newId();
    const libCell = {
        id: libCellId,
        name: libraryName,
        kind: 'library',
        metadata: { role: 'library', notes: '' },
        layers: [
            {
                id: libLayerId,
                name: 'Layer 1',
                color: DEFAULT_LAYER_PALETTE[1 % DEFAULT_LAYER_PALETTE.length],
                visible: true,
                locked: false,
                selectable: true,
                opacity: 1,
                metadata: normalizeLayerMetadata({}),
                entities: [],
            },
        ],
    };

    let doc = {
        ...base,
        project: {
            ...base.project,
            id: newId(),
            name: projectName,
        },
        cells: [layoutCell, libCell],
        activeCellId: layoutCell.id,
        activeLayerId: layoutLayerId,
    };

    const place = opts.placeFirstInstance !== false;
    if (place) {
        doc = addInstance(doc, layoutLayerId, { masterCellId: libCellId, x: 0, y: 0 });
    }
    return doc;
}

export function migrateMemsMaskDoc(raw) {
    if (!raw || typeof raw !== 'object') return emptyMemsMaskDoc();

    if (Number(raw.version) >= 5 && raw.project && Array.isArray(raw.cells)) {
        return normalizeV5Document(raw);
    }

    return migrateLegacyToV5(raw);
}

function normalizeV5Document(raw) {
    const base = emptyMemsMaskDoc();
    const proj = raw.project && typeof raw.project === 'object' ? raw.project : {};
    const cellsIn = Array.isArray(raw.cells) ? raw.cells : base.cells;
    const migratedCells = cellsIn.map((c, i) => migrateCell(c, i));

    const activeCellId =
        typeof raw.activeCellId === 'string' &&
        migratedCells.some((c) => c.id === raw.activeCellId)
            ? raw.activeCellId
            : migratedCells[0]?.id || base.activeCellId;

    const layerIds = new Set(migratedCells.flatMap((c) => c.layers.map((l) => l.id)));
    let activeLayerId =
        typeof raw.activeLayerId === 'string' && layerIds.has(raw.activeLayerId)
            ? raw.activeLayerId
            : migratedCells[0]?.layers[0]?.id || base.activeLayerId;

    const dw = Number(proj.die?.widthUm ?? proj.dieWidthUm ?? raw.dieWidthUm);
    const dh = Number(proj.die?.heightUm ?? proj.dieHeightUm ?? raw.dieHeightUm);

    let result = {
        version: MEMS_DOC_VERSION,
        project: {
            id: typeof proj.id === 'string' ? proj.id : newId(),
            name: typeof proj.name === 'string' ? proj.name : projectName(raw),
            unit: 'um',
            displayUnit: proj.displayUnit === 'mm' || raw.displayUnit === 'mm' ? 'mm' : 'um',
            die: {
                widthUm: Math.max(100, Number.isFinite(dw) ? dw : dieWidthUm(base)),
                heightUm: Math.max(100, Number.isFinite(dh) ? dh : dieHeightUm(base)),
            },
            userOriginUm: normalizeUserOrigin(proj.userOriginUm),
            metadata: {
                description:
                    typeof proj.metadata?.description === 'string'
                        ? proj.metadata.description
                        : '',
                technology:
                    typeof proj.metadata?.technology === 'string' ? proj.metadata.technology : '',
                notes: typeof proj.metadata?.notes === 'string' ? proj.metadata.notes : '',
            },
        },
        cells: migratedCells,
        activeCellId,
        activeLayerId,
    };

    const prevVer = Number(raw.version);
    const needsCornerToCenter = Number.isFinite(prevVer) ? prevVer < 7 : true;
    if (needsCornerToCenter) {
        result = migrateCornerOriginToDieCenter(result);
    }
    return result;
}

function migrateLegacyToV5(raw) {
    const layersRaw = Array.isArray(raw.layers) ? raw.layers : [];
    const migratedLayers = layersRaw.map((L, i) => migrateLayer(L, i));
    const cellId = newId();

    const ids = new Set(migratedLayers.map((l) => l.id));
    const activeLayerId =
        typeof raw.activeLayerId === 'string' && ids.has(raw.activeLayerId)
            ? raw.activeLayerId
            : migratedLayers[0]?.id || newId();

    const dw = Number(raw.dieWidthUm);
    const dh = Number(raw.dieHeightUm);

    const emptyCell = emptyMemsMaskDoc().cells[0];

    return migrateCornerOriginToDieCenter({
        version: MEMS_DOC_VERSION,
        project: {
            id: newId(),
            name: typeof raw.name === 'string' ? raw.name : 'Untitled layout',
            unit: 'um',
            displayUnit: raw.displayUnit === 'mm' ? 'mm' : 'um',
            die: {
                widthUm: Math.max(100, Number.isFinite(dw) ? dw : 5000),
                heightUm: Math.max(100, Number.isFinite(dh) ? dh : 5000),
            },
            userOriginUm: { x: 0, y: 0 },
            metadata: {
                description: '',
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
                layers: migratedLayers.length ? migratedLayers : emptyCell.layers,
            },
        ],
        activeCellId: cellId,
        activeLayerId,
    });
}

function migrateCell(C, index) {
    const id = typeof C?.id === 'string' ? C.id : newId();
    const layers = Array.isArray(C?.layers)
        ? C.layers.map((L, i) => migrateLayer(L, i))
        : [];
    return {
        id,
        name: typeof C?.name === 'string' ? C.name : index === 0 ? 'Root' : `Cell ${index + 1}`,
        kind: C?.kind === 'library' ? 'library' : 'layout',
        metadata: {
            role: typeof C?.metadata?.role === 'string' ? C.metadata.role : 'top',
            notes: typeof C?.metadata?.notes === 'string' ? C.metadata.notes : '',
        },
        layers,
    };
}

function migrateLayer(L, index) {
    const id = typeof L?.id === 'string' ? L.id : newId();
    const entities = Array.isArray(L?.entities)
        ? L.entities.map(migrateEntity).filter(Boolean)
        : [];
    return {
        id,
        name: typeof L?.name === 'string' ? L.name : `Layer ${index + 1}`,
        color: typeof L?.color === 'string' ? L.color : DEFAULT_LAYER_PALETTE[index % DEFAULT_LAYER_PALETTE.length],
        visible: L?.visible !== false,
        locked: !!L?.locked,
        selectable: L?.selectable !== false,
        opacity: clampOpacity(L?.opacity ?? 1),
        metadata: normalizeLayerMetadata(L?.metadata),
        entities,
    };
}

function migrateEntity(e) {
    if (!e || typeof e !== 'object') return null;
    if (e.type === 'rect') {
        const x = Number(e.x);
        const y = Number(e.y);
        const width = Number(e.width);
        const height = Number(e.height);
        if (![x, y, width, height].every(Number.isFinite)) return null;
        if (width <= 0 || height <= 0) return null;
        const rotationDeg = Number(e.rotationDeg);
        return {
            id: typeof e.id === 'string' ? e.id : newId(),
            type: 'rect',
            x,
            y,
            width,
            height,
            rotationDeg: Number.isFinite(rotationDeg) ? rotationDeg : 0,
        };
    }
    if (e.type === 'polygon') {
        const pts = Array.isArray(e.points)
            ? e.points
                  .map((p) => ({
                      x: Number(p?.x),
                      y: Number(p?.y),
                  }))
                  .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
            : [];
        if (pts.length < 3) return null;
        const holesIn = Array.isArray(e.holes) ? e.holes : [];
        const holes = holesIn
            .map((ring) =>
                Array.isArray(ring)
                    ? ring
                          .map((p) => ({
                              x: Number(p?.x),
                              y: Number(p?.y),
                          }))
                          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
                    : []
            )
            .filter((ring) => ring.length >= 3);
        return {
            id: typeof e.id === 'string' ? e.id : newId(),
            type: 'polygon',
            points: pts,
            ...(holes.length ? { holes } : {}),
        };
    }
    if (e.type === 'ellipse') {
        const cx = Number(e.cx);
        const cy = Number(e.cy);
        const rx = Number(e.rx);
        const ry = Number(e.ry);
        if (![cx, cy, rx, ry].every(Number.isFinite)) return null;
        if (rx <= 0 || ry <= 0) return null;
        const rotationDeg = Number(e.rotationDeg);
        return {
            id: typeof e.id === 'string' ? e.id : newId(),
            type: 'ellipse',
            cx,
            cy,
            rx,
            ry,
            rotationDeg: Number.isFinite(rotationDeg) ? rotationDeg : 0,
        };
    }
    if (e.type === 'line') {
        const x1 = Number(e.x1);
        const y1 = Number(e.y1);
        const x2 = Number(e.x2);
        const y2 = Number(e.y2);
        if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
        return {
            id: typeof e.id === 'string' ? e.id : newId(),
            type: 'line',
            x1,
            y1,
            x2,
            y2,
        };
    }
    if (e.type === 'path') {
        const pts = Array.isArray(e.points)
            ? e.points
                  .map((p) => ({
                      x: Number(p?.x),
                      y: Number(p?.y),
                  }))
                  .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
            : [];
        if (pts.length < 2) return null;
        const w = Number(e.widthUm);
        return {
            id: typeof e.id === 'string' ? e.id : newId(),
            type: 'path',
            points: pts,
            ...(Number.isFinite(w) && w > 0 ? { widthUm: w } : {}),
            ...(e.pathtype != null ? { pathtype: Number(e.pathtype) } : {}),
        };
    }
    if (e.type === 'text') {
        const x = Number(e.x);
        const y = Number(e.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const rotationDeg = Number(e.rotationDeg);
        const scale = Number(e.scale);
        const heightUm = Number(e.heightUm);
        return {
            id: typeof e.id === 'string' ? e.id : newId(),
            type: 'text',
            x,
            y,
            text: typeof e.text === 'string' ? e.text : '',
            ...(Number.isFinite(rotationDeg) && rotationDeg !== 0 ? { rotationDeg } : {}),
            ...(Number.isFinite(scale) && scale !== 1 ? { scale } : {}),
            ...(Number.isFinite(heightUm) && heightUm > 0 ? { heightUm } : {}),
            ...(e.presentation != null ? { presentation: Number(e.presentation) } : {}),
        };
    }
    if (e.type === 'instance') {
        const masterCellId = typeof e.masterCellId === 'string' ? e.masterCellId : '';
        if (!masterCellId) return null;
        return {
            id: typeof e.id === 'string' ? e.id : newId(),
            type: 'instance',
            masterCellId,
            x: Number.isFinite(Number(e.x)) ? Number(e.x) : 0,
            y: Number.isFinite(Number(e.y)) ? Number(e.y) : 0,
            rotationDeg: Number.isFinite(Number(e.rotationDeg)) ? Number(e.rotationDeg) : 0,
            scaleX:
                Number.isFinite(Number(e.scaleX)) && Number(e.scaleX) !== 0 ? Number(e.scaleX) : 1,
            scaleY:
                Number.isFinite(Number(e.scaleY)) && Number(e.scaleY) !== 0 ? Number(e.scaleY) : 1,
            mirrorX: !!e.mirrorX,
            mirrorY: !!e.mirrorY,
            array: normalizeInstanceArray(e.array),
        };
    }
    return null;
}

export function updateProjectMetadata(doc, patch) {
    return {
        ...doc,
        project: {
            ...doc.project,
            metadata: { ...doc.project.metadata, ...patch },
        },
    };
}

export function setProjectName(doc, name) {
    return {
        ...doc,
        project: { ...doc.project, name: typeof name === 'string' ? name : doc.project.name },
    };
}

export function setProjectDie(doc, widthUm, heightUm) {
    return {
        ...doc,
        project: {
            ...doc.project,
            die: {
                widthUm: Math.max(100, widthUm),
                heightUm: Math.max(100, heightUm),
            },
        },
    };
}

/**
 * Set die to the active cell’s content bounds (+ margin) and translate all entities so that
 * bbox is centered on the origin (die-centered layout coordinates).
 * Used after GDS/DXF import so rulers and grid match the real geometry extent.
 * @param {object} doc
 * @param {{ marginUm?: number, marginFrac?: number }} [opts]
 */
export function fitDocumentDieToActiveCellContent(doc, opts = {}) {
    const cellId = doc.activeCellId;
    if (!cellId) return doc;
    const bbox = cellContentBBoxUm(doc, cellId);
    if (!bbox || !Number.isFinite(bbox.minX) || !Number.isFinite(bbox.maxX)) return doc;

    const w0 = Math.max(0, bbox.maxX - bbox.minX);
    const h0 = Math.max(0, bbox.maxY - bbox.minY);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;

    let margin =
        opts.marginUm != null && Number.isFinite(opts.marginUm) ? Math.max(0, opts.marginUm) : undefined;
    if (margin === undefined) {
        const frac =
            opts.marginFrac != null && Number.isFinite(opts.marginFrac) ? opts.marginFrac : 0.06;
        margin = Math.max(50, frac * Math.max(w0, h0, 1));
    }

    const widthUm = Math.max(100, w0 + 2 * margin);
    const heightUm = Math.max(100, h0 + 2 * margin);

    let next = translateDocumentEntities(doc, -cx, -cy);
    next = setProjectDie(next, widthUm, heightUm);
    return next;
}

/**
 * View rectangle (µm) that contains all drawable content in the active layout cell, including
 * placed instances (hierarchy). Used for “fit to screen” without changing die or coordinates.
 * Falls back to the die rectangle when there is no geometry.
 * @param {object} doc
 * @param {{ marginUm?: number, marginFrac?: number }} [opts]
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function viewBoxToFitActiveCellContent(doc, opts = {}) {
    const cellId = doc.activeCellId;
    if (!cellId) {
        const dw = dieWidthUm(doc);
        const dh = dieHeightUm(doc);
        return { x: -dw / 2, y: -dh / 2, w: dw, h: dh };
    }
    const bbox = cellContentBBoxUm(doc, cellId);
    if (!bbox || !Number.isFinite(bbox.minX)) {
        const dw = dieWidthUm(doc);
        const dh = dieHeightUm(doc);
        return { x: -dw / 2, y: -dh / 2, w: dw, h: dh };
    }

    const w0 = Math.max(0, bbox.maxX - bbox.minX);
    const h0 = Math.max(0, bbox.maxY - bbox.minY);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;

    let margin =
        opts.marginUm != null && Number.isFinite(opts.marginUm) ? Math.max(0, opts.marginUm) : undefined;
    if (margin === undefined) {
        const frac =
            opts.marginFrac != null && Number.isFinite(opts.marginFrac) ? opts.marginFrac : 0.08;
        margin = Math.max(20, frac * Math.max(w0, h0, 1));
    }

    const w = Math.max(100, w0 + 2 * margin);
    const h = Math.max(100, h0 + 2 * margin);
    return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function setDisplayUnit(doc, displayUnit) {
    const u = displayUnit === 'mm' ? 'mm' : 'um';
    return {
        ...doc,
        project: { ...doc.project, displayUnit: u },
    };
}

export function setActiveCell(doc, cellId) {
    if (!doc.cells.some((c) => c.id === cellId)) return doc;
    return { ...doc, activeCellId: cellId };
}

export function addLayer(doc, name) {
    const layers = layoutLayers(doc);
    const idx = layers.length;
    const layer = {
        id: newId(),
        name: name || `Layer ${idx + 1}`,
        color: DEFAULT_LAYER_PALETTE[idx % DEFAULT_LAYER_PALETTE.length],
        visible: true,
        locked: false,
        selectable: true,
        opacity: 1,
        metadata: normalizeLayerMetadata({}),
        entities: [],
    };
    return mapActiveCellLayers(doc, (ls) => [...ls, layer]);
}

export function removeLayer(doc, layerId) {
    const layers = layoutLayers(doc);
    if (layers.length <= 1) return doc;
    const next = layers.filter((l) => l.id !== layerId);
    let activeLayerId = doc.activeLayerId;
    if (activeLayerId === layerId) {
        activeLayerId = next[0]?.id || '';
    }
    return { ...mapActiveCellLayers(doc, () => next), activeLayerId };
}

export function reorderLayers(doc, fromIndex, toIndex) {
    const layers = [...layoutLayers(doc)];
    if (fromIndex < 0 || fromIndex >= layers.length) return doc;
    if (toIndex < 0 || toIndex >= layers.length) return doc;
    const [item] = layers.splice(fromIndex, 1);
    layers.splice(toIndex, 0, item);
    return mapActiveCellLayers(doc, () => layers);
}

function normalizeLayerPatch(L) {
    return {
        ...L,
        opacity: clampOpacity(L.opacity ?? 1),
        selectable: L.selectable !== false,
        metadata: L.metadata ? normalizeLayerMetadata(L.metadata) : normalizeLayerMetadata({}),
    };
}

export function updateLayer(doc, layerId, patch) {
    return mapActiveCellLayers(doc, (layers) =>
        layers.map((l) => {
            if (l.id !== layerId) return l;
            const merged = { ...l, ...patch };
            if (patch.metadata && typeof patch.metadata === 'object') {
                merged.metadata = normalizeLayerMetadata({
                    ...l.metadata,
                    ...patch.metadata,
                });
            }
            return normalizeLayerPatch(merged);
        })
    );
}

export function setActiveLayer(doc, layerId) {
    if (!layoutLayers(doc).some((l) => l.id === layerId)) return doc;
    return { ...doc, activeLayerId: layerId };
}

export function addRectangle(doc, layerId, rect) {
    const entity = {
        id: newId(),
        type: 'rect',
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        rotationDeg: rect.rotationDeg ?? 0,
    };
    return mapActiveCellLayers(doc, (layers) =>
        layers.map((l) =>
            l.id === layerId ? { ...l, entities: [...l.entities, entity] } : l
        )
    );
}

export function addPolygon(doc, layerId, points, holes) {
    if (!points || points.length < 3) return doc;
    const entity = {
        id: newId(),
        type: 'polygon',
        points: points.map((p) => ({ x: p.x, y: p.y })),
    };
    if (Array.isArray(holes) && holes.length) {
        entity.holes = holes
            .filter((ring) => ring && ring.length >= 3)
            .map((ring) => ring.map((p) => ({ x: p.x, y: p.y })));
    }
    return mapActiveCellLayers(doc, (layers) =>
        layers.map((l) =>
            l.id === layerId ? { ...l, entities: [...l.entities, entity] } : l
        )
    );
}

/**
 * Append multiple polygons (e.g. Boolean / offset results with optional holes).
 * @param {{ points: {x:number,y:number}[], holes?: {x:number,y:number}[][] }[]} specs
 */
export function addPolygonSpecs(doc, layerId, specs) {
    if (!specs?.length) return doc;
    let next = doc;
    for (const s of specs) {
        if (!s?.points || s.points.length < 3) continue;
        next = addPolygon(next, layerId, s.points, s.holes);
    }
    return next;
}

/** Append a layer tagged as derived (mask derivation / Boolean results). */
export function addDerivedLayer(doc, name, derivedFrom) {
    const layers = layoutLayers(doc);
    const idx = layers.length;
    const layer = {
        id: newId(),
        name: name || `Derived ${idx + 1}`,
        color: DEFAULT_LAYER_PALETTE[idx % DEFAULT_LAYER_PALETTE.length],
        visible: true,
        locked: false,
        selectable: true,
        opacity: 1,
        metadata: normalizeLayerMetadata({
            purpose: 'derived',
            derivedFrom:
                derivedFrom && typeof derivedFrom === 'object'
                    ? {
                          op: typeof derivedFrom.op === 'string' ? derivedFrom.op : '',
                          sourceLayerIds: Array.isArray(derivedFrom.sourceLayerIds)
                              ? derivedFrom.sourceLayerIds.filter((x) => typeof x === 'string')
                              : [],
                          sourceEntityIds: Array.isArray(derivedFrom.sourceEntityIds)
                              ? derivedFrom.sourceEntityIds.filter((x) => typeof x === 'string')
                              : [],
                      }
                    : undefined,
        }),
        entities: [],
    };
    return { ...mapActiveCellLayers(doc, (ls) => [...ls, layer]), activeLayerId: layer.id };
}

export function addEllipse(doc, layerId, ellipse) {
    const entity = {
        id: newId(),
        type: 'ellipse',
        cx: ellipse.cx,
        cy: ellipse.cy,
        rx: ellipse.rx,
        ry: ellipse.ry,
        rotationDeg: ellipse.rotationDeg ?? 0,
    };
    return mapActiveCellLayers(doc, (layers) =>
        layers.map((l) =>
            l.id === layerId ? { ...l, entities: [...l.entities, entity] } : l
        )
    );
}

export function addLineReturningId(doc, layerId, line) {
    const entityId = newId();
    const entity = {
        id: entityId,
        type: 'line',
        x1: line.x1,
        y1: line.y1,
        x2: line.x2,
        y2: line.y2,
    };
    const next = mapActiveCellLayers(doc, (layers) =>
        layers.map((l) =>
            l.id === layerId ? { ...l, entities: [...l.entities, entity] } : l
        )
    );
    return { doc: next, entityId };
}

export function addLine(doc, layerId, line) {
    return addLineReturningId(doc, layerId, line).doc;
}

export function addPath(doc, layerId, points) {
    if (!points || points.length < 2) return doc;
    const entity = {
        id: newId(),
        type: 'path',
        points: points.map((p) => ({ x: p.x, y: p.y })),
    };
    return mapActiveCellLayers(doc, (layers) =>
        layers.map((l) =>
            l.id === layerId ? { ...l, entities: [...l.entities, entity] } : l
        )
    );
}

/** Create a reusable library cell (editable master) and switch to it. */
export function addLibraryCell(doc, name) {
    const layerId = newId();
    const cellId = newId();
    const idx = doc.cells?.length ?? 0;
    const cell = {
        id: cellId,
        name: (typeof name === 'string' && name.trim()) || `Cell ${idx + 1}`,
        kind: 'library',
        metadata: { role: 'library', notes: '' },
        layers: [
            {
                id: layerId,
                name: 'Layer 1',
                color: DEFAULT_LAYER_PALETTE[0],
                visible: true,
                locked: false,
                selectable: true,
                opacity: 1,
                metadata: normalizeLayerMetadata({}),
                entities: [],
            },
        ],
    };
    return { ...doc, cells: [...doc.cells, cell], activeCellId: cellId, activeLayerId: layerId };
}

export function renameCell(doc, cellId, name) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) return doc;
    return {
        ...doc,
        cells: doc.cells.map((c) => (c.id === cellId ? { ...c, name: n } : c)),
    };
}

/**
 * Place a cell master as an instance (live link — edits to master propagate).
 * @param {object} inst masterCellId, x, y, rotationDeg?, scaleX?, scaleY?, mirrorX?, mirrorY?, array?
 */
export function addInstance(doc, layerId, inst) {
    const masterCellId = typeof inst.masterCellId === 'string' ? inst.masterCellId : '';
    if (!masterCellId || !doc.cells.some((c) => c.id === masterCellId)) return doc;
    const entity = {
        id: newId(),
        type: 'instance',
        masterCellId,
        x: Number.isFinite(Number(inst.x)) ? Number(inst.x) : 0,
        y: Number.isFinite(Number(inst.y)) ? Number(inst.y) : 0,
        rotationDeg: Number.isFinite(Number(inst.rotationDeg)) ? Number(inst.rotationDeg) : 0,
        scaleX:
            Number.isFinite(Number(inst.scaleX)) && Number(inst.scaleX) !== 0 ? Number(inst.scaleX) : 1,
        scaleY:
            Number.isFinite(Number(inst.scaleY)) && Number(inst.scaleY) !== 0 ? Number(inst.scaleY) : 1,
        mirrorX: !!inst.mirrorX,
        mirrorY: !!inst.mirrorY,
        array: normalizeInstanceArray(inst.array),
    };
    return mapActiveCellLayers(doc, (layers) =>
        layers.map((l) =>
            l.id === layerId ? { ...l, entities: [...l.entities, entity] } : l
        )
    );
}

export function replaceEntity(doc, layerId, entityId, nextEntity) {
    return {
        ...doc,
        cells: doc.cells.map((cell) => ({
            ...cell,
            layers: cell.layers.map((l) =>
                l.id === layerId
                    ? {
                          ...l,
                          entities: l.entities.map((e) =>
                              e.id === entityId ? { ...nextEntity, id: entityId } : e
                          ),
                      }
                    : l
            ),
        })),
    };
}

/**
 * @param {{ layerId: string, entityId: string }[]} refs
 */
export function translateSelection(doc, refs, dx, dy) {
    if (!refs.length || (dx === 0 && dy === 0)) return doc;
    const byLayer = new Map();
    for (const r of refs) {
        if (!byLayer.has(r.layerId)) byLayer.set(r.layerId, new Set());
        byLayer.get(r.layerId).add(r.entityId);
    }
    return {
        ...doc,
        cells: doc.cells.map((cell) => ({
            ...cell,
            layers: cell.layers.map((l) => {
                const ids = byLayer.get(l.id);
                if (!ids) return l;
                return {
                    ...l,
                    entities: l.entities.map((e) =>
                        ids.has(e.id) ? translateEntity(e, dx, dy) : e
                    ),
                };
            }),
        })),
    };
}

export function cloneEntityNewIds(e) {
    const id = newId();
    if (e.type === 'rect') {
        return { ...e, id };
    }
    if (e.type === 'polygon' || e.type === 'path') {
        return {
            ...e,
            id,
            points: (e.points || []).map((p) => ({ x: p.x, y: p.y })),
            ...(e.type === 'polygon' && e.holes?.length
                ? {
                      holes: e.holes.map((ring) => ring.map((p) => ({ x: p.x, y: p.y }))),
                  }
                : {}),
        };
    }
    if (e.type === 'ellipse') {
        return { ...e, id };
    }
    if (e.type === 'line') {
        return { ...e, id };
    }
    if (e.type === 'instance') {
        return {
            ...e,
            id,
            array: normalizeInstanceArray(e.array),
        };
    }
    if (e.type === 'text') {
        return { ...e, id };
    }
    return e;
}

/**
 * Append clones onto target layer (paste).
 * @param {{ dx?: number, dy?: number }} [opts] Applied to each clone after new ids (µm); used to tile repeated paste.
 */
export function pasteEntityCopies(doc, targetLayerId, templates, opts = {}) {
    if (!templates.length) return doc;
    const dx = Number.isFinite(Number(opts.dx)) ? Number(opts.dx) : 0;
    const dy = Number.isFinite(Number(opts.dy)) ? Number(opts.dy) : 0;
    const clones = templates
        .map(cloneEntityNewIds)
        .map((e) => (dx !== 0 || dy !== 0 ? translateEntity(e, dx, dy) : e));
    return {
        ...mapActiveCellLayers(doc, (layers) =>
            layers.map((l) =>
                l.id === targetLayerId ? { ...l, entities: [...l.entities, ...clones] } : l
            )
        ),
        activeLayerId: targetLayerId,
    };
}

export function deleteEntities(doc, layerId, entityIds) {
    const drop = new Set(entityIds);
    return mapActiveCellLayers(doc, (layers) =>
        layers.map((l) =>
            l.id === layerId ? { ...l, entities: l.entities.filter((e) => !drop.has(e.id)) } : l
        )
    );
}

/** Remove entities by id on every layer (ids are unique across the document). */
export function deleteEntitiesByIds(doc, entityIds) {
    const drop = new Set(entityIds);
    return {
        ...doc,
        cells: doc.cells.map((cell) => ({
            ...cell,
            layers: cell.layers.map((l) => ({
                ...l,
                entities: l.entities.filter((e) => !drop.has(e.id)),
            })),
        })),
    };
}

export function activeLayer(doc) {
    const ls = layoutLayers(doc);
    return ls.find((l) => l.id === doc.activeLayerId) || ls[0];
}

/** Find shape and layer (searches all cells — ids are global). */
export function findEntity(doc, entityId) {
    for (const cell of doc.cells || []) {
        for (const layer of cell.layers) {
            const e = layer.entities.find((x) => x.id === entityId);
            if (e) return { cell, layer, entity: e };
        }
    }
    return null;
}
