/**
 * Sort key for chronological ordering of trial captures (matches Drift Map / Recovery page).
 * AU serial: `..._YYYY-MM-DD_HHMMSS.csv`; legacy: `_YYYYMMDD-HHMM.csv`.
 */
export function extractChronoSortKey(name) {
    const base = String(name).split(/[/\\]/).pop() || '';
    const auCap = base.match(/_(\d{4}-\d{2}-\d{2})_(\d{6})\.csv$/i);
    if (auCap) return `${auCap[1].replace(/-/g, '')}${auCap[2]}`;
    const legacy = base.match(/_(\d{8}-\d{4})\.csv$/i);
    if (legacy) return legacy[1];
    return base;
}
