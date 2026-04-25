/**
 * Curated index of SPICE model packs the app can fetch without CORS issues
 * (served from this site under /public/circuit-models).
 *
 * Remote URLs: fetching third-party sites often fails in the browser due
 * to CORS — the UI still offers a "paste URL" attempt + open-in-tab fallback.
 */

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   description: string,
 *   tags: string[],
 *   partNumbers: string[],
 *   license: string,
 *   suggestedFilename: string,
 *   path: string
 * }} BundledModelPack
 */

/** Normalise for part-number search (ignore spaces, case). */
function normPartKey(s) {
    return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/** @type {BundledModelPack[]} */
export const BUNDLED_MODEL_PACKS = [
    {
        id: 'basic-analog',
        title: 'Basic analog semiconductors',
        description:
            'Small-signal diode + NMOS/PMOS (.model) parameters tuned for Circuit Studio’s built-in D/M stamps.',
        tags: ['diode', 'nmos', 'pmos', 'mosfet', 'curated', 'mit', 'teaching'],
        /** Industry-style strings users type; SPICE .model names in the file are D1N914, SMALLNMOS, SMALLPMOS. */
        partNumbers: [
            '1N914', '1N914A', 'D1N914',
            'SMALLNMOS', 'SMALLPMOS',
        ],
        license: 'MIT — curated text shipped with this app.',
        suggestedFilename: 'basic_analog.inc',
        path: 'circuit-models/basic_analog.inc',
    },
    {
        id: 'bjt-small',
        title: 'Small-signal BJT (2N3904 / 2N3906 class)',
        description:
            'NPN/PNP models with typical SPICE parameter set; reduced to fields the simulator reads (Is, Bf, capacitances, etc.).',
        tags: ['bjt', 'npn', 'pnp', '2n3904', 'curated', 'mit'],
        partNumbers: [
            '2N3904', '2N3906', 'Q2N3904', 'Q2N3906',
            '3904', '3906',
        ],
        license: 'MIT — curated text shipped with this app.',
        suggestedFilename: 'bjt_small_signal.inc',
        path: 'circuit-models/bjt_small_signal.inc',
    },
];

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   description: string,
 *   tags: string[],
 *   partNumbers?: string[],
 *   license: string,
 *   suggestedFilename: string,
 *   fetchUrl: string,
 *   sourceLabel: string
 * }} RemoteModelPack */

/** Optional remote catalog rows (mirrors with permissive CORS). Empty by default. */
export const REMOTE_MODEL_PACKS = [];

/** Preferred UI label (part-style) for a `.model` name in bundled packs. */
export const SPICE_MODEL_NAME_TO_PART_LABEL = {
    D1N914: '1N914',
    SMALLNMOS: 'SMALLNMOS',
    SMALLPMOS: 'SMALLPMOS',
    Q2N3904: '2N3904',
    Q2N3906: '2N3906',
};

/**
 * @param {string} modelName — SPICE `.model` name (e.g. Q2N3904)
 * @returns {string} human-facing part label when known; otherwise the model name
 */
export function partLabelForSpiceModelName(modelName) {
    const raw = String(modelName || '').trim();
    if (!raw) return '';
    if (SPICE_MODEL_NAME_TO_PART_LABEL[raw] != null) return SPICE_MODEL_NAME_TO_PART_LABEL[raw];
    const up = raw.toUpperCase();
    for (const [k, v] of Object.entries(SPICE_MODEL_NAME_TO_PART_LABEL)) {
        if (k.toUpperCase() === up) return v;
    }
    return raw;
}

/** Resolve a path under `public/` for fetch() with the Vite base URL. */
export function resolvePublicAssetUrl(relativePath) {
    const base = import.meta.env.BASE_URL || '/';
    const normBase = base.endsWith('/') ? base : `${base}/`;
    const normPath = String(relativePath || '').replace(/^\//, '');
    return new URL(normPath, window.location.origin + normBase).href;
}

/**
 * @param {string} query
 * @returns {{ bundled: BundledModelPack[], remote: RemoteModelPack[] }}
 */
export function searchModelCatalog(query) {
    const qRaw = String(query || '').trim();
    const q = qRaw.toLowerCase();
    const qKey = normPartKey(qRaw);

    const match = (pack) => {
        if (!q && !qKey) return true;
        if (q && pack.title.toLowerCase().includes(q)) return true;
        if (q && pack.description.toLowerCase().includes(q)) return true;
        if (q && pack.tags.some((t) => t.toLowerCase().includes(q))) return true;

        const pnums = pack.partNumbers || [];
        for (const pn of pnums) {
            const pk = normPartKey(pn);
            if (!qKey) continue;
            if (pk === qKey) return true;
            if (pk.includes(qKey)) return true;
            if (qKey.includes(pk) && pk.length >= 3) return true;
        }
        return false;
    };
    return {
        bundled: BUNDLED_MODEL_PACKS.filter(match),
        remote: REMOTE_MODEL_PACKS.filter(match),
    };
}

export async function fetchTextFromUrl(url) {
    const u = String(url || '').trim();
    if (!u) throw new Error('Empty URL');
    const res = await fetch(u, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
}
