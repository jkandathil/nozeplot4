/**
 * SiAC / aroma unit line parsers (build-time device profile).
 * SiAC32-V2: JSON objects with keys sn + t[]. Web Serial often chunks mid-string;
 * use drainJsonObjectsFromBuffer instead of splitting on \n only.
 */

/**
 * Extract complete top-level `{...}` JSON substrings (string-aware brace matching).
 * @param {string} buffer
 * @returns {{ chunks: string[], rest: string }}
 */
export function drainJsonObjectsFromBuffer(buffer) {
    const chunks = [];
    let i = 0;

    while (i < buffer.length) {
        const start = buffer.indexOf('{', i);
        if (start < 0) {
            return { chunks, rest: buffer.slice(i) };
        }

        let depth = 0;
        let inString = false;
        let escape = false;
        let j = start;
        let closed = false;

        for (; j < buffer.length; j++) {
            const c = buffer[j];
            if (escape) {
                escape = false;
                continue;
            }
            if (inString) {
                if (c === '\\') {
                    escape = true;
                    continue;
                }
                if (c === '"') inString = false;
                continue;
            }
            if (c === '"') {
                inString = true;
                continue;
            }
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) {
                    chunks.push(buffer.slice(start, j + 1));
                    i = j + 1;
                    closed = true;
                    break;
                }
            }
        }

        if (!closed) {
            return { chunks, rest: buffer.slice(start) };
        }
    }

    return { chunks, rest: buffer.slice(i) };
}

/** @param {string} line raw JSON object from serial */
/** @param {string} timestampIso ISO-8601 receive time */
export function parseSiac32V2Line(line, timestampIso) {
    const s = String(line).replace(/^\r+|\r+$/g, '').trim();
    if (!s) return null;
    const obj = JSON.parse(s);
    const row = {
        timestamp: timestampIso,
        sn: obj.sn != null ? String(obj.sn) : '',
    };
    const t = Array.isArray(obj.t) ? obj.t : [];
    for (const piece of t) {
        if (piece && typeof piece === 'object' && !Array.isArray(piece)) {
            for (const [k, v] of Object.entries(piece)) {
                row[k] = v;
            }
        }
    }
    return row;
}

/** Stable column order: timestamp, sn, then rest sorted (numeric-aware). */
export function normalizeCaptureRows(rows) {
    if (!rows.length) return { data: [], fields: [] };
    const keys = new Set();
    for (const r of rows) {
        Object.keys(r).forEach((k) => keys.add(k));
    }
    const priority = ['timestamp', 'sn'];
    const rest = [...keys]
        .filter((k) => !priority.includes(k))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const order = [...priority.filter((k) => keys.has(k)), ...rest];
    const data = rows.map((r) => {
        const o = {};
        for (const k of order) {
            const v = r[k];
            o[k] = v === undefined || v === null ? '' : v;
        }
        return o;
    });
    return { data, fields: order };
}

export const AU_DEVICE_PROFILES = {
    SIAC32_V2: {
        id: 'SiAC32-V2',
        label: 'SiAC32-V2',
        baudRate: 115200,
        parseLine: parseSiac32V2Line,
    },
    SIAC32_V3: {
        id: 'SiAC32-V3',
        label: 'SiAC32-V3',
        baudRate: 115200,
        disabled: true,
        hint: 'Different frame format — support coming later.',
        parseLine: null,
    },
};

export function getAuProfile(profileKey) {
    return AU_DEVICE_PROFILES[profileKey] || AU_DEVICE_PROFILES.SIAC32_V2;
}
