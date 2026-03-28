/**
 * Maps raw workspace paths like 2603241428_f74b1433/0000000063-0926-asu-nz.csv to ppb
 * using bundled catalog built from Raw_data/files normalized_* filenames.
 */
import catalog from '../data/concentration-catalog.json';

const SESSION_FOLDER_RE = /^(\d{10})_([a-f0-9]{8})$/i;

function normalizeAuStem(name) {
    return String(name)
        .split(/[/\\]/)
        .pop()
        .replace(/\.csv$/i, '')
        .toLowerCase();
}

const lookupMap = new Map();
for (const e of catalog.entries || []) {
    const key = `${e.time10}|${e.hash}|${normalizeAuStem(e.auId)}`;
    if (!lookupMap.has(key)) lookupMap.set(key, e);
}

/**
 * @param {string} relativePath webkitRelativePath or name with optional parent folder
 * @returns {{ time10: string, hash: string, auStem: string } | null}
 */
export function parseSessionFolderAndAuFromPath(relativePath) {
    if (!relativePath) return null;
    const parts = String(relativePath).split(/[/\\]/).filter(Boolean);
    if (parts.length < 2) return null;
    const fm = parts[0].match(SESSION_FOLDER_RE);
    if (!fm) return null;
    const auStem = normalizeAuStem(parts[parts.length - 1]);
    if (!auStem) return null;
    return { time10: fm[1], hash: fm[2].toLowerCase(), auStem };
}

/**
 * @returns {{ key: string, label: string, numericValue: number, unit: string, source: 'catalog' } | null}
 */
export function lookupConcentrationMetaFromCatalogPath(relativePath) {
    const p = parseSessionFolderAndAuFromPath(relativePath);
    if (!p) return null;
    const row = lookupMap.get(`${p.time10}|${p.hash}|${p.auStem}`);
    if (!row) return null;
    const numericValue = row.valuePpb;
    return {
        key: `${numericValue}|ppb`,
        label: `${numericValue} ppb`,
        numericValue,
        unit: 'ppb',
        source: 'catalog',
    };
}
