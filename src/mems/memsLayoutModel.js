/**
 * MEMS layout data model — semantic types and normalization (canonical µm).
 * Editor state is JSON-serializable; shapes are explicit geometry, not pixels.
 *
 * Hierarchy: LayoutDocument → Project → Cell[] → Layer[] → Shape[]
 * (Single active cell for now; structure supports arrays, booleans, DRC, GDS.)
 */

/** @typedef {'um'|'mm'} DisplayUnit */

/**
 * Top-level mask / die envelope and labelling.
 * @typedef {{
 *   id: string,
 *   name: string,
 *   unit: 'um',
 *   displayUnit: DisplayUnit,
 *   die: { widthUm: number, heightUm: number },
 *   metadata: ProjectMetadata
 * }} LayoutProject
 */

/** @typedef {{
 *   description: string,
 *   technology: string,
 *   notes: string
 * }} ProjectMetadata */

/**
 * Optional fabrication / flow tagging for export and DRC rule targeting.
 * @typedef {{
 *   material: string,
 *   processRole: string,
 *   purpose: string,
 *   gdsLayer?: number,
 *   gdsDatatype?: number,
 *   dxfLayer?: string
 * }} LayerMetadata */

/**
 * Drawing plane: holds ordered layers. Future: references, placement transform.
 * @typedef {{
 *   id: string,
 *   name: string,
 *   kind: 'layout'|'library',
 *   metadata: { role?: string, notes?: string },
 *   layers: MemsLayer[]
 * }} LayoutCell
 */

/**
 * Visual grouping + editing policy for mask geometry.
 * @typedef {{
 *   id: string,
 *   name: string,
 *   color: string,
 *   visible: boolean,
 *   locked: boolean,
 *   selectable: boolean,
 *   opacity: number,
 *   metadata: LayerMetadata,
 *   entities: object[]
 * }} MemsLayer */

export const DEFAULT_PROJECT_METADATA = () => ({
    description: '',
    technology: '',
    notes: '',
});

export const DEFAULT_LAYER_METADATA = () => ({
    material: '',
    processRole: '',
    purpose: '',
});

/** @param {unknown} m */
export function normalizeLayerMetadata(m) {
    if (!m || typeof m !== 'object') return DEFAULT_LAYER_METADATA();
    const derivedRaw = /** @type {{ op?: unknown, sourceLayerIds?: unknown, sourceEntityIds?: unknown }} */ (
        m
    ).derivedFrom;
    const derivedFrom =
        derivedRaw &&
        typeof derivedRaw === 'object' &&
        typeof derivedRaw.op === 'string' &&
        derivedRaw.op.length > 0
            ? {
                  op: derivedRaw.op,
                  sourceLayerIds: Array.isArray(derivedRaw.sourceLayerIds)
                      ? derivedRaw.sourceLayerIds.filter((x) => typeof x === 'string')
                      : [],
                  sourceEntityIds: Array.isArray(derivedRaw.sourceEntityIds)
                      ? derivedRaw.sourceEntityIds.filter((x) => typeof x === 'string')
                      : [],
              }
            : undefined;
    const base = {
        material: typeof m.material === 'string' ? m.material : '',
        processRole: typeof m.processRole === 'string' ? m.processRole : '',
        purpose: typeof m.purpose === 'string' ? m.purpose : '',
    };
    const gl =
        typeof m.gdsLayer === 'number' && Number.isFinite(m.gdsLayer)
            ? Math.round(m.gdsLayer)
            : undefined;
    const gd =
        typeof m.gdsDatatype === 'number' && Number.isFinite(m.gdsDatatype)
            ? Math.round(m.gdsDatatype)
            : undefined;
    const dx =
        typeof m.dxfLayer === 'string' && m.dxfLayer.length > 0 ? m.dxfLayer : undefined;
    const withGds = {
        ...base,
        ...(gl !== undefined ? { gdsLayer: gl } : {}),
        ...(gd !== undefined ? { gdsDatatype: gd } : {}),
        ...(dx !== undefined ? { dxfLayer: dx } : {}),
    };
    return derivedFrom ? { ...withGds, derivedFrom } : withGds;
}

/** Clamp opacity to [0,1]. */
export function clampOpacity(v) {
    const x = Number(v);
    if (!Number.isFinite(x)) return 1;
    return Math.min(1, Math.max(0, x));
}
