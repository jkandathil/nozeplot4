/**
 * SiAC64-class devices: USB shell `rpc send "<json-string>"` exactly as in Telemetry.md.
 *
 * Example (period 1000 ms):
 *   rpc send "{\"method\":\"TELEMETRY\",\"params\":{\"period\":1000}}"
 *
 * Built as: rpc send + space + JSON.stringify(JSON.stringify(payload))
 * so the shell receives one argv that parses to the inner JSON object.
 */

const encoder = new TextEncoder();

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** Firmware sometimes prints JSON with unquoted nan — normalize for JSON.parse. */
export function sanitizeSiacFirmwareJsonText(s) {
    return String(s)
        .replace(/\bNaN\b/g, 'null')
        .replace(/\bnan\b/g, 'null')
        .replace(/\bInfinity\b/g, 'null')
        .replace(/\b-Infinity\b/g, 'null');
}

/**
 * Full shell line (no trailing newline) for `rpc send` — matches Telemetry.md quoting.
 * @param {Record<string, unknown>} payloadObj
 * @returns {string}
 */
export function buildSiac64RpcSendCommandLine(payloadObj) {
    const inner = JSON.stringify(payloadObj);
    return `rpc send ${JSON.stringify(inner)}`;
}

/**
 * Machine-style line: raw JSON-RPC object + newline (some builds accept this without `rpc send`).
 * @param {Record<string, unknown>} payloadObj
 */
export function buildSiac64RawJsonRpcLine(payloadObj, lineEnding = '\n') {
    return `${JSON.stringify(payloadObj)}${lineEnding}`;
}

/**
 * @param {SerialPort} port opened Web Serial port with writable
 * @param {Record<string, unknown>} payloadObj RPC body, e.g. { method: 'TELEMETRY', params: { period: 100 } }
 * @param {{ lineEnding?: string; alsoSendRawJson?: boolean }} [options] lineEnding default `\r\n` after the command (set `\n` if the device expects LF-only)
 */
export async function writeSiac64RpcLine(port, payloadObj, options = {}) {
    if (!port?.writable) return;
    const lineEnding = options.lineEnding ?? '\r\n';
    const line = `${buildSiac64RpcSendCommandLine(payloadObj)}${lineEnding}`;
    let writer;
    try {
        writer = port.writable.getWriter();
        if (writer.ready) await writer.ready;
        await writer.write(encoder.encode(line));
        if (writer.ready) await writer.ready;
    } finally {
        try {
            writer?.releaseLock();
        } catch {
            /* ignore */
        }
    }
    await delay(options.postWriteDelayMs ?? 35);

    if (options.alsoSendRawJson) {
        const raw = buildSiac64RawJsonRpcLine(payloadObj, lineEnding);
        try {
            writer = port.writable.getWriter();
            if (writer.ready) await writer.ready;
            await writer.write(encoder.encode(raw));
            if (writer.ready) await writer.ready;
        } finally {
            try {
                writer?.releaseLock();
            } catch {
                /* ignore */
            }
        }
        await delay(40);
    }
}

/** Default 1000 ms = one TELEMETRY sample per second (Telemetry.md: period 10–1000). */
export const DEFAULT_TELEMETRY_PERIOD_MS = 1000;

export function clampTelemetryPeriodMs(n) {
    const x = Math.floor(Number(n));
    if (!Number.isFinite(x)) return DEFAULT_TELEMETRY_PERIOD_MS;
    return Math.max(10, Math.min(1000, x));
}
