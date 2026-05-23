/**
 * Parse controlled number inputs only when editing is complete.
 * Number('') === 0, so empty fields must not commit or geometry jumps to the origin and
 * segments can collapse to ~0 length (objects look gone).
 *
 * @param {string} raw
 * @returns {number | null} null = skip commit and keep previous document state
 */
export function parseCommittedNumberInput(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    if (s === '-' || s === '+' || s === '.' || s === '-.' || s === '+.') return null;
    const v = Number(s);
    if (!Number.isFinite(v)) return null;
    return v;
}
