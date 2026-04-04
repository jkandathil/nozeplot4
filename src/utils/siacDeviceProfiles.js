/**
 * SiAC / aroma unit line parsers (build-time device profile).
 * SiAC32-V2: JSON objects with keys sn + t[]. Web Serial often chunks mid-string;
 * use drainJsonObjectsFromBuffer instead of splitting on \n only.
 */

import { DEFAULT_TELEMETRY_PERIOD_MS } from './siac64RpcSerial.js';

/**
 * Extract complete top-level `{...}` JSON substrings (string-aware brace matching).
 * @param {string} buffer
 * @returns {{ chunks: string[], rest: string }}
 */
/** Safe one-line preview of unparsed serial text (for error messages). */
export function describePartialSerialBuffer(s, maxLen = 100) {
    if (s == null || s === '') return '';
    const slice = String(s).slice(0, maxLen);
    return JSON.stringify(slice) + (String(s).length > maxLen ? '…' : '');
}

/**
 * Serial / scan: pull AU id from a parsed JSON object (SiAC32 `sn`, SiAC64 TELEMETRY envelope, etc.).
 * @param {unknown} obj
 * @returns {string} trimmed serial or ""
 */
export function extractAuSerialNumberFromParsedJson(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
    const top = obj.sn ?? obj.SN ?? obj.serial ?? obj.id ?? obj.ID ?? obj.AU_ID ?? obj.device_id;
    if (top != null) {
        const s = String(top).trim();
        if (s) return s;
    }
    const meth = obj.method != null ? String(obj.method).toUpperCase() : '';
    if (meth === 'TELEMETRY' && obj.result && typeof obj.result === 'object' && !Array.isArray(obj.result)) {
        const r = obj.result.sn ?? obj.result.SN ?? obj.result.id ?? obj.result.ID ?? obj.result.AU_ID;
        if (r != null) {
            const s = String(r).trim();
            if (s) return s;
        }
    }
    return '';
}

/**
 * True if `buffer` contains a `{` starting an object whose braces are not yet balanced
 * (string-aware). Used to extend serial reads briefly when a large SiAC JSON frame is split
 * across the capture end boundary.
 */
export function hasIncompleteLeadingJsonObject(buffer) {
    const b = String(buffer);
    const match = b.match(/(?:^|\n)\s*\{/);
    if (!match) return false;
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < b.length; i++) {
        const c = b[i];
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
        else if (c === '}') depth--;
    }
    return depth > 0;
}

export function drainJsonObjectsFromBuffer(buffer) {
    const chunks = [];
    let i = 0;

    while (i < buffer.length) {
        const searchBuf = buffer.slice(i);
        const match = searchBuf.match(/(?:^|\n)\s*\{/);
        if (!match) {
            return { chunks, rest: buffer.slice(i) };
        }
        const start = i + match.index + match[0].length - 1;

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
                if (c === '"') {
                    inString = false;
                }
                continue;
            }
            if (c === '"') {
                inString = true;
                continue;
            }

            if (c === '{') {
                depth++;
            } else if (c === '}') {
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

/**
 * SiAC64 TELEMETRY RPC JSON → one CSV row (Telemetry.md “Telemetry Example Output”, ~lines 104–214).
 *
 * Envelope: `code`, `message`, `sn`, `method`, `format`, `version`, `frequency`, `result` (Telemetry.md § example).
 * `result` is a flat map: `A1`…`H8`, `ASELT`, `BT1`, pump keys (`PZTFR0`, …), `DPP0`, `AQ*`, `SYS*`, etc.
 * Firmware may emit unquoted `nan` in JSON; we sanitize before parse.
 */
export function parseSiAc64RpcTelemetryLine(line, timestampIso) {
    const raw = String(line).replace(/^\r+|\r+$/g, '').trim();
    if (!raw) return null;
    let obj;
    try {
        const s = raw
            .replace(/\bNaN\b/g, 'null')
            .replace(/\bnan\b/g, 'null')
            .replace(/\bInfinity\b/g, 'null')
            .replace(/\b-Infinity\b/g, 'null');
        obj = JSON.parse(s);
    } catch {
        return null;
    }
    if (!obj || typeof obj !== 'object') return null;

    const snRaw = obj.sn ?? obj.SN ?? obj.id ?? obj.ID ?? obj.AU_ID ?? obj.device_id;
    const row = {
        timestamp: timestampIso,
        sn: snRaw != null ? String(snRaw) : '',
    };

    // SiAC64: sensors A1..H8 can be in 'result' (standard) or at the top level
    const res = obj.result || obj;
    if (res && typeof res === 'object' && !Array.isArray(res)) {
        for (const [k, v] of Object.entries(res)) {
            const up = k.toUpperCase();
            // Match A1..H8, pump flow, env sensors, and system stats
            const isSen = /^[A-H][1-8]$/.test(up) ||
                        /^(ASELT|BT[1-2]|DPP0|DPT0|DPSN|DPPID|PZTFR0|PZCFR0|PZEFR0|PZVMV0|PZCDV0|PZEN0|PZDM0|PZCAL0|AQT0|AQH0|AQP0|AQGR0|AQAH0|AQBSTAT|AQBTS|AQBVAL|AQSENS|AQSID|TRHT0|TRHH0|TRHSN|SYSUT|SYSHF|SYSHA|SYSCL|SYSRC)$/.test(up);

            if (isSen) {
                if (v === null || v === undefined) {
                    row[k] = '';
                } else if (typeof v === 'string') {
                    const n = parseFloat(v);
                    row[k] = isNaN(n) ? v : n;
                } else {
                    row[k] = v;
                }
            }
        }
    }

    // Capture other JSON-RPC metadata
    if (obj.code !== undefined && obj.code !== null) row.telemetry_code = obj.code;
    if (obj.message != null) row.telemetry_message = String(obj.message);
    if (obj.method != null) row.telemetry_method = String(obj.method);
    if (obj.format != null) row.telemetry_format = String(obj.format);
    if (obj.version !== undefined && obj.version !== null) row.telemetry_version = obj.version;
    if (obj.frequency != null) {
        const f = Number(obj.frequency);
        if (Number.isFinite(f)) row.telemetry_frequency_hz = f;
    }

    return row;
}

export function parseSiac32V2Line(line, timestampIso) {
    const s = String(line).replace(/^\r+|\r+$/g, '').trim();
    if (!s) return null;
    const obj = JSON.parse(s);
    const snRaw = obj.sn ?? obj.SN ?? obj.serial;
    const row = {
        timestamp: timestampIso,
        sn: snRaw != null ? String(snRaw) : '',
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

/** First non-empty `sn` among parsed capture rows. */
export function firstNonEmptySnInRows(rows) {
    if (!rows?.length) return '';
    for (const r of rows) {
        const s = String(r?.sn ?? '').trim();
        if (s) return s;
    }
    return '';
}

/**
 * True if the row has at least one value beyond `timestamp` / `sn` (e.g. CHR*, RRF* from SiAC `t`[], or
 * A1–H8 / pump keys from SiAC64 `result`). Skips `telemetry_*` envelope fields so SiAC64 rows with only
 * metadata and an empty `result` are not treated as captured data.
 */
export function captureRowHasSensorValues(row) {
    if (!row || typeof row !== 'object') return false;
    for (const k of Object.keys(row)) {
        if (k === 'timestamp' || k === 'sn') continue;
        if (k.startsWith('telemetry_')) continue;
        const v = row[k];
        if (v === '' || v === null || v === undefined) continue;
        return true;
    }
    return false;
}

/**
 * Ensures every row has `sn` for workspace naming: use any row that already has `sn`, else the scan result.
 * Fixes saves to `unknown-device` when the first JSON object omits `sn` or keys differ slightly.
 */
export function coerceCaptureRowsSn(rows, fallbackSnFromScan) {
    if (!rows?.length) return rows;
    const fb = String(fallbackSnFromScan ?? '').trim();
    const fromRows = firstNonEmptySnInRows(rows);
    const sn = fromRows || fb;
    if (!sn) return rows;
    return rows.map((r) => {
        const cur = String(r?.sn ?? '').trim();
        if (cur) return r;
        return { ...r, sn };
    });
}

/** Stable column order: timestamp, sn, then rest sorted (numeric-aware). */
export function normalizeCaptureRows(rows) {
    if (!rows.length) return { data: [], fields: [] };
    const keys = new Set();
    for (const r of rows) {
        Object.keys(r).forEach((k) => keys.add(k));
    }
    const priority = ['timestamp', 'sn', 'Event'];
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

/**
 * Drop sensor columns that are empty for every row (keeps timestamp + sn).
 * Avoids CSV columns that exist only because normalize filled them with blanks.
 */
export function dropSensorColumnsEmptyInAllRows(data) {
    if (!data?.length) return data;
    const keys = new Set();
    for (const r of data) {
        Object.keys(r).forEach((k) => keys.add(k));
    }
    const priority = ['timestamp', 'sn'];
    const rest = [...keys]
        .filter((k) => !priority.includes(k))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const order = [...priority.filter((k) => keys.has(k)), ...rest];
    const drop = new Set(
        rest.filter((k) =>
            data.every((r) => {
                const v = r[k];
                return v === '' || v === null || v === undefined;
            })
        )
    );
    if (!drop.size) return data;
    const keepOrder = order.filter((k) => !drop.has(k));
    return data.map((r) => {
        const o = {};
        for (const k of keepOrder) {
            const v = r[k];
            o[k] = v === undefined || v === null ? '' : v;
        }
        return o;
    });
}

export const AU_DEVICE_PROFILES = {
    SIAC32_V2: {
        id: 'SiAC32-V2',
        label: 'SiAC32-V2',
        baudRate: 115200,
        parseLine: parseSiac32V2Line,
        isFormatCompatible: (obj) => obj && Array.isArray(obj.t),
    },
    SIAC32_V3: {
        id: 'SiAC32-V3',
        label: 'SiAC32-V3',
        baudRate: 115200,
        disabled: true,
        hint: 'Different frame format — support coming later.',
        parseLine: null,
        isFormatCompatible: () => false,
    },
    /** SiAC64 v0.3.x mux-dev: USB shell `rpc send` + TELEMETRY JSON (A1–H8, pump, env). See Telemetry.md */
    SIAC64_V03_RPC: {
        id: 'SiAC64-v0.3-RPC',
        label: 'SiAC64 v0.3 (TELEMETRY RPC)',
        baudRate: 115200,
        parseLine: parseSiAc64RpcTelemetryLine,
        isFormatCompatible: (obj) => obj && (obj.method != null || obj.result != null || obj.params != null),
        rpcShell: {
            probePayload: () => ({ method: 'TELEMETRY', params: { period: 1000, outputFormat: 0 } }),
            captureStartPayload: (ms) => ({ method: 'TELEMETRY', params: { period: ms, outputFormat: 0 } }),
            captureStopPayload: () => ({ method: 'TELEMETRY', params: { period: 0 } }),
        },
        /** Piezo pump: SET_PIEZO_PUMP (setFlow + enable) — see siac64PumpRpc.js */
        pumpControl: {
            maxCcm: 500,
            sliderStep: 1,
        },
    },
};

export function getAuProfile(profileKey) {
    return AU_DEVICE_PROFILES[profileKey] || AU_DEVICE_PROFILES.SIAC32_V2;
}

/** Workspace folder name for one physical AU (matches device `sn` field). */
export function auDeviceFolderNameFromSn(sn) {
    const t = String(sn ?? '').trim();
    if (!t) return 'unknown-device';
    return t.replace(/[\\/:*?"<>|]/g, '-').slice(0, 120);
}
