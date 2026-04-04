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
    let root = obj;
    if (obj.jsonrpc != null && obj.result != null && typeof obj.result === 'object' && !Array.isArray(obj.result)) {
        root = obj.result;
    }
    const top = root.sn ?? root.SN ?? root.serial ?? root.id ?? root.ID ?? root.AU_ID ?? root.device_id;
    if (top != null) {
        const s = String(top).trim();
        if (s) return s;
    }
    const meth = root.method != null ? String(root.method).toUpperCase() : '';
    if (meth === 'TELEMETRY' && root.result && typeof root.result === 'object' && !Array.isArray(root.result)) {
        const r = root.result.sn ?? root.result.SN ?? root.result.id ?? root.result.ID ?? root.result.AU_ID;
        if (r != null) {
            const s = String(r).trim();
            if (s) return s;
        }
    }
    return '';
}

/**
 * SiAC64 UART often mixes Zephyr shell (CSI color, `ASAU:…>` prompts), CRLF, and JSON.
 * Normalize so brace scanning is stable across chunks.
 * @param {string} s
 * @returns {string}
 */
export function normalizeCaptureSerialText(s) {
    let t = String(s);
    t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // CSI sequences: ESC [ … final byte (common Zephyr / shell coloring, cursor moves)
    t = t.replace(/\u001b\[[0-9;?]*[0-9A-Za-z]/g, '');
    return t;
}

/**
 * Index of `{` that starts the next top-level JSON object, or -1.
 * Prefers boundaries after newline, start of buffer, or `}` (back-to-back `}{` frames).
 * Falls back to the first `{` in the remainder so prompts like `> {"code"` still parse.
 * @param {string} buffer normalized
 * @param {number} i
 */
export function findNextJsonObjectStart(buffer, i) {
    const searchBuf = buffer.slice(i);
    const strict = searchBuf.match(/(?:^|[\n]+|\})\s*\{/);
    if (strict) {
        return i + strict.index + strict[0].length - 1;
    }
    const k = searchBuf.indexOf('{');
    return k < 0 ? -1 : i + k;
}

/**
 * True if `buffer` contains a `{` starting an object whose braces are not yet balanced
 * (string-aware). Used to extend serial reads briefly when a large SiAC JSON frame is split
 * across the capture end boundary.
 */
export function hasIncompleteLeadingJsonObject(buffer) {
    const b = normalizeCaptureSerialText(String(buffer));
    const start = findNextJsonObjectStart(b, 0);
    if (start < 0) return false;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let idx = start; idx < b.length; idx++) {
        const c = b[idx];
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

/** SiAC64 TELEMETRY frames are a few KB; larger “open” spans are usually a false `{` or UART junk. */
const DRAIN_INCOMPLETE_RESYNC_BYTES = 96 * 1024;

export function drainJsonObjectsFromBuffer(buffer) {
    const b = normalizeCaptureSerialText(String(buffer));
    const chunks = [];
    let i = 0;

    while (i < b.length) {
        const start = findNextJsonObjectStart(b, i);
        if (start < 0) {
            return { chunks, rest: b.slice(i) };
        }

        let depth = 0;
        let inString = false;
        let escape = false;
        let j = start;
        let closed = false;

        for (; j < b.length; j++) {
            const c = b[j];
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
                    chunks.push(b.slice(start, j + 1));
                    i = j + 1;
                    closed = true;
                    break;
                }
            }
        }

        if (!closed) {
            // Long captures: a bogus `{` (shell/log) can leave us “inside” an object for 100k+ bytes and
            // hide every real TELEMETRY frame. Only resync when this pass emitted no complete objects yet.
            if (
                chunks.length === 0 &&
                b.length - start >= DRAIN_INCOMPLETE_RESYNC_BYTES
            ) {
                const next = findNextJsonObjectStart(b, start + 1);
                if (next > start) {
                    i = next;
                    continue;
                }
                i = start + 1;
                continue;
            }
            return { chunks, rest: b.slice(start) };
        }
    }

    return { chunks, rest: b.slice(i) };
}

/** Collect scalar leaf keys from nested objects (mux groups, etc.). Arrays: recurse into object elements only. */
function collectTelemetryScalarLeaves(o, maxDepth, out, depth = 0) {
    if (o == null || typeof o !== 'object' || depth > maxDepth) return;
    if (Array.isArray(o)) {
        for (const el of o) {
            if (el != null && typeof el === 'object') collectTelemetryScalarLeaves(el, maxDepth, out, depth + 1);
        }
        return;
    }
    for (const [k, v] of Object.entries(o)) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            collectTelemetryScalarLeaves(v, maxDepth, out, depth + 1);
        } else {
            out[k] = v;
        }
    }
}

/**
 * Keys we persist from SiAC64 TELEMETRY `result` (Telemetry.md).
 * Includes `includeRawValues` raw ADC keys (RCH, RRF, REF) and alternate `ch0`…`ch15` shape from Notes.
 */
function isSiAc64TelemetrySensorKey(up) {
    if (/^[A-H][1-8]$/.test(up)) return true;
    if (/^CH\d+$/.test(up)) return true;
    if (/^RCH\d*$/.test(up) || /^RRF\d*$/.test(up) || /^REF\d*$/.test(up)) return true;
    return (
        /^(ASELT|BT[1-2]|DPP0|DPT0|DPSN|DPPID|PZTFR0|PZCFR0|PZEFR0|PZVMV0|PZCDV0|PZEN0|PZDM0|PZCAL0|AQT0|AQH0|AQP0|AQGR0|AQAH0|AQBSTAT|AQBTS|AQBVAL|AQSENS|AQSID|TRHT0|TRHH0|TRHSN|SYSUT|SYSHF|SYSHA|SYSCL|SYSRC)$/.test(
            up
        )
    );
}

/**
 * SiAC64 TELEMETRY RPC JSON → one CSV row (Telemetry.md “Telemetry Example Output”, ~lines 104–214).
 *
 * Envelope: `code`, `message`, `sn`, `method`, `format`, `version`, `frequency`, `result` (Telemetry.md § example).
 * `result` is a flat map: `A1`…`H8`, `ASELT`, `BT1`, pump keys (`PZTFR0`, …), `DPP0`, `AQ*`, `SYS*`, etc.
 * With `includeRawValues:1`, firmware may send **only** `RCH*`, `RRF*`, `REF*` (Telemetry.md § Additional Options).
 * JSON-RPC may wrap the envelope as `{ "jsonrpc":"2.0", "result": { ...telemetry... } }`.
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

    let payload = obj;
    if (
        obj.jsonrpc != null &&
        obj.result != null &&
        typeof obj.result === 'object' &&
        !Array.isArray(obj.result)
    ) {
        payload = obj.result;
    }

    const snRaw =
        payload.sn ?? payload.SN ?? payload.id ?? payload.ID ?? payload.AU_ID ?? payload.device_id;
    const row = {
        timestamp: timestampIso,
        sn: snRaw != null ? String(snRaw) : '',
    };

    let block = payload.result;
    if (block == null || typeof block !== 'object' || Array.isArray(block)) {
        block = payload;
    }

    const leaves = {};
    collectTelemetryScalarLeaves(block, 6, leaves);

    for (const [k, v] of Object.entries(leaves)) {
        const up = k.toUpperCase();
        if (!isSiAc64TelemetrySensorKey(up)) continue;
        if (v === null || v === undefined) {
            row[k] = '';
        } else if (typeof v === 'string') {
            const n = parseFloat(v);
            row[k] = Number.isNaN(n) ? v : n;
        } else {
            row[k] = v;
        }
    }

    // Capture other JSON-RPC metadata from the telemetry envelope
    if (payload.code !== undefined && payload.code !== null) row.telemetry_code = payload.code;
    if (payload.message != null) row.telemetry_message = String(payload.message);
    if (payload.method != null) row.telemetry_method = String(payload.method);
    if (payload.format != null) row.telemetry_format = String(payload.format);
    if (payload.version !== undefined && payload.version !== null) row.telemetry_version = payload.version;
    if (payload.frequency != null) {
        const f = Number(payload.frequency);
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
