import {
    drainJsonObjectsFromBuffer,
    extractAuSerialNumberFromParsedJson,
    parseGen3AuDelimitedLine,
} from './siacDeviceProfiles.js';
import { writeSiac64RpcLine, sanitizeSiacFirmwareJsonText } from './siac64RpcSerial.js';

export function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Treat as Windows only when we are confident — Windows CDC/CP210x needs longer delays;
 * macOS/Linux use the shorter path so capture stays responsive.
 * Prefer `userAgentData.platform` (Chromium) over deprecated `navigator.platform` / UA sniffing.
 */
function detectWindowsHost() {
    if (typeof navigator === 'undefined') return false;
    const hint = navigator.userAgentData?.platform;
    if (hint === 'Windows') return true;
    if (hint === 'macOS' || hint === 'Linux' || hint === 'Chrome OS') return false;
    const ua = navigator.userAgent || '';
    const plat = navigator.platform || '';
    return /Win/i.test(plat) || /Windows/i.test(ua);
}

/** Heuristic: Windows CDC/CP210x drivers often need longer settle times between close/open and reads. */
export function getSerialPlatformTiming() {
    if (typeof navigator === 'undefined') {
        return {
            win: false,
            postCloseBeforeOpenMs: 220,
            postCloseAfterProbeMs: 90,
            scanReadTimeoutMs: 5500,
            bustExtraMs: 2800,
            preReadAfterOpenMs: 0,
            readableWaitAttempts: 12,
            readableWaitStepMs: 40,
            afterReaderReleasedMs: 40,
            afterPortCloseMs: 40,
            postWakeSignalsMs: 20,
            writableWaitAttempts: 8,
            writableWaitStepMs: 40,
            afterWritablePingMs: 80,
            scanSecondReadMs: 7000,
        };
    }
    const win = detectWindowsHost();
    return {
        win,
        postCloseBeforeOpenMs: win ? 450 : 220,
        postCloseAfterProbeMs: win ? 260 : 90,
        scanReadTimeoutMs: win ? 14000 : 5500,
        bustExtraMs: win ? 6000 : 2800,
        preReadAfterOpenMs: win ? 120 : 0,
        readableWaitAttempts: win ? 36 : 12,
        readableWaitStepMs: win ? 50 : 40,
        afterReaderReleasedMs: win ? 150 : 40,
        afterPortCloseMs: win ? 120 : 40,
        postWakeSignalsMs: win ? 350 : 20,
        writableWaitAttempts: win ? 36 : 8,
        writableWaitStepMs: win ? 50 : 40,
        afterWritablePingMs: win ? 450 : 80,
        scanSecondReadMs: win ? 10000 : 7000,
    };
}

/**
 * After port.open(), read raw bytes until a full SiAC JSON object appears and return obj.sn.
 * Releases the reader so capture can attach to port.readable again.
 */
export async function readAuSerialFromOpenPort(port, timeoutMs = 2000, externalAbortSignal = null, validateObjFn = null) {
    if (!port?.readable) return null;

    let reader;
    try {
        reader = port.readable.getReader();
    } catch {
        return null;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let found = null;

    const onExternalAbort = () => {
        reader?.cancel().catch(() => {});
    };
    if (externalAbortSignal) {
        if (externalAbortSignal.aborted) {
            try {
                reader.releaseLock();
            } catch {
                /* ignore */
            }
            return null;
        }
        externalAbortSignal.addEventListener('abort', onExternalAbort);
    }

    const timer = setTimeout(() => {
        reader?.cancel().catch(() => {});
    }, timeoutMs);

    try {
        while (!found) {
            let readResult;
            try {
                readResult = await reader.read();
            } catch {
                break;
            }
            const { value, done } = readResult;
            if (done) break;
            if (value?.byteLength) {
                buffer += decoder.decode(value, { stream: true });
            }
            const { chunks, rest } = drainJsonObjectsFromBuffer(buffer);
            buffer = rest;
            for (const jsonStr of chunks) {
                try {
                    const obj = JSON.parse(sanitizeSiacFirmwareJsonText(jsonStr));
                    if (validateObjFn && !validateObjFn(obj)) continue;
                    const sn = extractAuSerialNumberFromParsedJson(obj);
                    if (sn) {
                        found = sn;
                        break;
                    }
                } catch {
                    /* skip */
                }
            }
        }
        if (!found) {
            buffer += decoder.decode();
            const { chunks, rest } = drainJsonObjectsFromBuffer(buffer);
            if (chunks.length > 0) {
                console.debug(`[Scan] Detected ${chunks.length} potential JSON fragments on ${port.getInfo?.()?.usbVendorId || 'port'}`);
            }
            for (const c of chunks) {
                try {
                    const clean = sanitizeSiacFirmwareJsonText(c);
                    const parsed = JSON.parse(clean);
                    if (validateObjFn && !validateObjFn(parsed)) {
                        console.debug(`[Scan] JSON payload exists but is incompatible with selected device profile:`, parsed);
                        continue;
                    }
                    const sn = extractAuSerialNumberFromParsedJson(parsed);
                    if (sn) {
                        console.info(`[Scan] Verified Serial Number: "${sn}"`);
                        found = sn;
                        break;
                    } else {
                        console.debug(`[Scan] JSON chunk did not contain a recognized serial ID:`, parsed);
                    }
                } catch (e) {
                    console.warn(`[Scan] Fragment parse error:`, e.message, "Content:", c);
                }
            }
            buffer = rest;
        }
    } finally {
        clearTimeout(timer);
        if (externalAbortSignal) {
            externalAbortSignal.removeEventListener('abort', onExternalAbort);
        }
        try {
            await reader.cancel();
        } catch {
            /* ignore */
        }
        try {
            reader.releaseLock();
        } catch {
            /* ignore */
        }
    }

    return found;
}

/**
 * Wall-clock fallback: abort read (releases reader); optionally port.close() if the read never completes.
 * @param {boolean} closePortOnBust - false on Windows first scan pass so a second read can run on the same open.
 */
async function readAuSerialWithWatchdog(port, readTimeoutMs, bustAfterMs, closePortOnBust = true, validateObjFn = null) {
    const ac = new AbortController();
    let bustTimer;
    let settled = false;
    return new Promise((resolve) => {
        bustTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ac.abort();
            if (closePortOnBust && typeof port.close === 'function') {
                port.close().catch(() => {});
            }
            resolve(null);
        }, bustAfterMs);
        readAuSerialFromOpenPort(port, readTimeoutMs, ac.signal, validateObjFn)
            .then((sn) => {
                if (settled) return;
                settled = true;
                clearTimeout(bustTimer);
                resolve(sn ?? null);
            })
            .catch(() => {
                if (settled) return;
                settled = true;
                clearTimeout(bustTimer);
                resolve(null);
            });
    });
}

/**
 * CP210x / FTDI / CDC on Windows often buffers TX until DTR (and sometimes RTS) is asserted.
 */
export async function applySerialPortWakeSignals(port) {
    if (!port || typeof port.setSignals !== 'function') return;
    try {
        await port.setSignals({
            dataTerminalReady: true,
            requestToSend: true,
        });
    } catch {
        try {
            await port.setSignals({
                dataTerminalReady: true,
                requestToSend: false,
            });
        } catch {
            /* ignore */
        }
    }
}

/** Toggle lines low then high — helps some RS-485 / USB-UART front-ends on Windows. */
async function applyAlternateWindowsSerialSignals(port) {
    if (!port || typeof port.setSignals !== 'function') return;
    try {
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
        await delay(100);
        await port.setSignals({ dataTerminalReady: true, requestToSend: true });
        await delay(100);
    } catch {
        /* ignore */
    }
}

async function waitForReadable(port, attempts, stepMs) {
    for (let i = 0; i < attempts; i++) {
        if (port?.readable) return true;
        await delay(stepMs);
    }
    return !!port?.readable;
}

async function waitForWritable(port, attempts, stepMs) {
    for (let i = 0; i < attempts; i++) {
        if (port?.writable) return true;
        await delay(stepMs);
    }
    return !!port?.writable;
}

/**
 * Many stacks only expose `writable` after open(); sending CRLF can wake SiAC / flush bridge TX on Windows.
 */
async function trySiAcStreamWakeWrite(port, t) {
    const ok = await waitForWritable(port, t.writableWaitAttempts, t.writableWaitStepMs);
    if (!ok || !port.writable) return;

    let writer;
    try {
        writer = port.writable.getWriter();
        await writer.write(new Uint8Array([0x0d, 0x0a]));
    } catch {
        /* ignore */
    } finally {
        try {
            writer?.releaseLock();
        } catch {
            /* ignore */
        }
    }
}

/**
 * After `port.open()`, run the same wake sequence as scan (DTR/RTS, optional settle, CRLF on writable).
 * Call this before `readable.getReader()` so capture sees JSON on picky Windows CDC bridges.
 * @param {{ txPing?: boolean }} [opts] — set `txPing: false` for read-only devices (no CRLF on TX).
 */
export async function primeSerialPortForSiAcRead(port, opts = {}) {
    const txPing = opts.txPing !== false;
    const t = getSerialPlatformTiming();
    if (t.win) {
        await applyAlternateWindowsSerialSignals(port);
    }
    await applySerialPortWakeSignals(port);
    await delay(t.postWakeSignalsMs);
    if (t.preReadAfterOpenMs > 0) {
        await delay(t.preReadAfterOpenMs);
    }
    await waitForReadable(port, t.readableWaitAttempts, t.readableWaitStepMs);
    if (txPing) {
        await trySiAcStreamWakeWrite(port, t);
        await delay(t.afterWritablePingMs);
        if (t.win) {
            await delay(320);
            await applySerialPortWakeSignals(port);
            await trySiAcStreamWakeWrite(port, t);
            await delay(Math.min(t.afterWritablePingMs, 160));
        }
    }
}

/**
 * Read line-delimited GEN3 AU CSV until a data row yields `sn` (passive stream, no writes).
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
export async function readGen3AuStreamForSn(port, timeoutMs = 8000) {
    if (!port?.readable) return null;
    let reader;
    try {
        reader = port.readable.getReader();
    } catch {
        return null;
    }
    const decoder = new TextDecoder();
    let carry = '';
    let foundSn = null;
    const timer = setTimeout(() => {
        reader?.cancel().catch(() => {});
    }, timeoutMs);
    try {
        while (!foundSn) {
            let readResult;
            try {
                readResult = await reader.read();
            } catch {
                break;
            }
            const { value, done } = readResult;
            if (done) break;
            if (value?.byteLength) {
                carry += decoder.decode(value, { stream: true });
            }
            carry = carry.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const parts = carry.split('\n');
            carry = parts.pop() ?? '';
            for (const line of parts) {
                const ts = new Date().toISOString();
                const row = parseGen3AuDelimitedLine(line, ts);
                const sn = row?.sn && String(row.sn).trim();
                if (sn) {
                    foundSn = sn;
                    break;
                }
            }
        }
        carry += decoder.decode();
        carry = carry.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const tailParts = carry.split('\n');
        for (const line of tailParts) {
            if (foundSn) break;
            const ts = new Date().toISOString();
            const row = parseGen3AuDelimitedLine(line, ts);
            const sn = row?.sn && String(row.sn).trim();
            if (sn) foundSn = sn;
        }
    } finally {
        clearTimeout(timer);
        try {
            await reader.cancel();
        } catch {
            /* ignore */
        }
        try {
            reader.releaseLock();
        } catch {
            /* ignore */
        }
    }
    return foundSn || null;
}

/**
 * Scan one port for GEN3 AU (9600 CSV). No RPC / no TX wake bytes — DTR/RTS only.
 */
export async function scanProbeGen3AuPort(port, openOpts) {
    const t = getSerialPlatformTiming();
    const readMs = Math.max(t.scanReadTimeoutMs, 4000);
    const openWithFlow = { ...openOpts, flowControl: openOpts.flowControl ?? 'none' };
    if (t.win) {
        openWithFlow.bufferSize = openWithFlow.bufferSize ?? 16384;
    }
    try {
        try {
            await port.close();
        } catch {
            /* ignore */
        }
        await delay(t.postCloseBeforeOpenMs);
        try {
            await port.open(openWithFlow);
        } catch (e) {
            if (t.win && openWithFlow.bufferSize) {
                const { bufferSize: _b, ...rest } = openWithFlow;
                await port.open(rest);
            } else {
                throw e;
            }
        }
        await applySerialPortWakeSignals(port);
        await delay(t.postWakeSignalsMs);
        if (t.preReadAfterOpenMs > 0) {
            await delay(t.preReadAfterOpenMs);
        }
        const okReadable = await waitForReadable(port, t.readableWaitAttempts, t.readableWaitStepMs);
        if (!okReadable) {
            return { sn: null, error: 'No readable stream after open.' };
        }
        let sn = await readGen3AuStreamForSn(port, readMs);
        if (!sn && t.win) {
            await applyAlternateWindowsSerialSignals(port);
            await delay(200);
            sn = await readGen3AuStreamForSn(port, t.scanSecondReadMs);
        }
        return {
            sn,
            error: sn ? null : 'No GEN3 CSV line with serial (sn) seen — check 9600 baud and streaming.',
        };
    } catch (e) {
        return { sn: null, error: e?.message || 'Could not open port' };
    } finally {
        try {
            await port.close();
        } catch {
            /* ignore */
        }
        await delay(t.postCloseAfterProbeMs);
    }
}

/**
 * Merge open options. Large RX `bufferSize` helps some Windows scan reads but has been linked to empty
 * capture on other CDC drivers — use `useLargeRxBuffer: false` for all long capture opens.
 */
export function serialOpenOptsForPlatform(baseOpenOpts, useLargeRxBuffer = true) {
    const t = getSerialPlatformTiming();
    const merged = { ...baseOpenOpts, flowControl: baseOpenOpts.flowControl ?? 'none' };
    if (t.win && useLargeRxBuffer) {
        merged.bufferSize = baseOpenOpts.bufferSize ?? 16384;
    }
    return merged;
}

/**
 * Open the port; on Windows retry without `bufferSize` if the browser rejects it.
 * @param {{ useLargeRxBuffer?: boolean }} [extra]  default true (scan-style); false for capture sessions
 */
export async function openSerialPortForSiAc(port, baseOpenOpts, extra = {}) {
    const useLargeRxBuffer = extra.useLargeRxBuffer !== false;
    const t = getSerialPlatformTiming();
    const openOpts = serialOpenOptsForPlatform(baseOpenOpts, useLargeRxBuffer);
    try {
        await port.open(openOpts);
    } catch (e) {
        if (t.win && openOpts.bufferSize != null) {
            const { bufferSize: _b, ...rest } = openOpts;
            await port.open(rest);
        } else {
            throw e;
        }
    }
}
/**
 * Close if needed, open, probe for sn, always close. One port at a time.
 * @param {Record<string, unknown> | null} [rpcProbePayload] If set, sends `rpc send "…"` (SiAC64 shell) before reading.
 */
export async function scanProbeSerialPort(port, openOpts, readTimeoutMs, rpcProbePayload = null, validateObjFn = null) {
    const t = getSerialPlatformTiming();
    const maxWaitMs = 3000;
    const readMs = Math.max(readTimeoutMs ?? t.scanReadTimeoutMs, maxWaitMs);
    const bustAfterMs = readMs + t.bustExtraMs;
    const openWithFlow = { ...openOpts, flowControl: openOpts.flowControl ?? 'none' };
    if (t.win) {
        openWithFlow.bufferSize = openWithFlow.bufferSize ?? 16384;
    }

    try {
        try {
            await port.close();
        } catch {
            /* ignore */
        }
        await delay(t.postCloseBeforeOpenMs);

        try {
            await port.open(openWithFlow);
        } catch (e) {
            if (t.win && openWithFlow.bufferSize) {
                const { bufferSize: _b, ...rest } = openWithFlow;
                await port.open(rest);
            } else {
                throw e;
            }
        }

        await applySerialPortWakeSignals(port);
        await delay(t.postWakeSignalsMs);

        if (t.preReadAfterOpenMs > 0) {
            await delay(t.preReadAfterOpenMs);
        }

        const okReadable = await waitForReadable(port, t.readableWaitAttempts, t.readableWaitStepMs);
        if (!okReadable) {
            try {
                await port.close();
            } catch {
                /* ignore */
            }
            await delay(t.postCloseAfterProbeMs);
            return { sn: null, error: 'No readable stream after open (try scan again or replug USB).' };
        }

        await trySiAcStreamWakeWrite(port, t);
        await delay(t.afterWritablePingMs);

        if (rpcProbePayload && typeof rpcProbePayload === 'object') {
            try {
                /* Shell `rpc send '…'` + raw JSON line — some mux-dev builds only accept one style. */
                await writeSiac64RpcLine(port, rpcProbePayload, {
                    alsoSendRawJson: true,
                    postWriteDelayMs: 25,
                });
                /* TELEMETRY JSON is large; give the stack time before read. */
                await delay(t.win ? 520 : 380);
            } catch {
                /* ignore — probe read may still see passive stream */
            }
        }

        const closeOnFirstBust = !t.win;
        let sn = await readAuSerialWithWatchdog(port, readMs, bustAfterMs, closeOnFirstBust, validateObjFn);

        /* SiAC64: first TELEMETRY can be slow or lost; resend RPC once before OS-specific retries. */
        if (!sn && rpcProbePayload && typeof rpcProbePayload === 'object') {
            try {
                await writeSiac64RpcLine(port, rpcProbePayload, {
                    alsoSendRawJson: true,
                    postWriteDelayMs: 25,
                });
                await delay(t.win ? 520 : 400);
                sn = await readAuSerialWithWatchdog(port, readMs, bustAfterMs, closeOnFirstBust, validateObjFn);
            } catch {
                /* ignore */
            }
        }

        if (!sn && t.win) {
            await applyAlternateWindowsSerialSignals(port);
            await trySiAcStreamWakeWrite(port, t);
            await delay(t.afterWritablePingMs);
            if (rpcProbePayload && typeof rpcProbePayload === 'object') {
                try {
                    await writeSiac64RpcLine(port, rpcProbePayload, {
                        alsoSendRawJson: true,
                        postWriteDelayMs: 25,
                    });
                    await delay(420);
                } catch {
                    /* ignore */
                }
            }
            const secondMs = t.scanSecondReadMs;
            sn = await readAuSerialWithWatchdog(port, secondMs, secondMs + 5000, true, validateObjFn);
        }

        return { sn, error: null };
    } catch (e) {
        return { sn: null, error: e?.message || 'Could not open port' };
    } finally {
        try {
            await port.close();
        } catch {
            /* ignore */
        }
        await delay(t.postCloseAfterProbeMs);
    }
}

/**
 * Read UTF-8 from an open Web Serial port until `endAt` or `shouldStop()`.
 * Uses Uint8Array + TextDecoder with `{ stream: true }` — same decoding path as scan (`readAuSerialFromOpenPort`),
 * not `pipeThrough(TextDecoderStream)`, which can behave differently on some OS/browser builds.
 * A timer calls `reader.cancel()` so a silent device cannot leave `read()` blocking past `endAt`.
 *
 * @param {SerialPort} port
 * @param {object} options
 * @param {number} options.endAt
 * @param {() => boolean} [options.shouldStop]
 * @param {(text: string) => void} options.onChunk
 * @param {{ current: unknown }} [options.registerForCancelRef]  e.g. readerRef — Stop capture cancels this reader
 * @param {{ current: unknown[] }} [options.registerInMultiListRef]  multi-AU: list for stopCapture.cancel()
 * @param {number} [options.readKickMs]  interval for end-of-window cancel watchdog (default: slower on Windows)
 * @returns {Promise<{ bytesIn: number }>}
 */
export async function readSiAcPortUtf8Until(port, options) {
    const {
        endAt,
        shouldStop = () => false,
        onChunk,
        registerForCancelRef,
        registerInMultiListRef,
        readKickMs,
    } = options;

    if (!port?.readable) {
        throw new Error('No readable stream on serial port.');
    }

    const decoder = new TextDecoder();
    let bytesIn = 0;
    const shouldEnd = () => Date.now() >= endAt || shouldStop();
    const t = getSerialPlatformTiming();
    const kickEveryMs = readKickMs ?? (t.win ? 320 : 200);
    const readerSlot = { current: null };

    const kick = () => {
        if (shouldEnd()) {
            readerSlot.current?.cancel().catch(() => {});
        }
    };
    const interval = setInterval(kick, kickEveryMs);
    let reopenStalls = 0;
    const MAX_REOPEN_STALLS = 50;

    try {
        while (!shouldEnd() && !shouldStop()) {
            let reader;
            try {
                reader = port.readable.getReader();
            } catch {
                reopenStalls++;
                if (reopenStalls > MAX_REOPEN_STALLS) break;
                await delay(t.win ? 50 : 30);
                continue;
            }
            reopenStalls = 0;

            readerSlot.current = reader;
            if (registerForCancelRef) registerForCancelRef.current = reader;
            if (registerInMultiListRef) registerInMultiListRef.current.push(reader);

            let exitedWithDone = false;
            try {
                while (!shouldEnd() && !shouldStop()) {
                    let readResult;
                    try {
                        readResult = await reader.read();
                    } catch {
                        exitedWithDone = true;
                        break;
                    }
                    const { value, done } = readResult;
                    if (done) {
                        exitedWithDone = true;
                        break;
                    }
                    if (value && value.byteLength > 0) {
                        bytesIn += value.byteLength;
                        onChunk(decoder.decode(value, { stream: true }));
                    }
                }
            } finally {
                readerSlot.current = null;
                if (registerForCancelRef) registerForCancelRef.current = null;
                if (registerInMultiListRef) {
                    registerInMultiListRef.current = registerInMultiListRef.current.filter((r) => r !== reader);
                }
                try {
                    await reader.cancel();
                } catch {
                    /* ignore */
                }
                try {
                    reader.releaseLock();
                } catch {
                    /* ignore */
                }
            }

            // Do not flush the decoder when we immediately re-open the reader on the same byte stream
            // (spurious `done` on some OS/driver stacks). A flush with no following input finalizes any
            // trailing incomplete UTF-8 as U+FFFD; the next chunk then decodes mid-sequence and corrupts JSON.
            const willReopenSameStream = exitedWithDone && !shouldEnd() && !shouldStop();
            if (!willReopenSameStream) {
                onChunk(decoder.decode());
            }

            if (shouldEnd() || shouldStop()) break;
            if (!exitedWithDone) break;
            await delay(t.win ? 55 : 30);
        }

        onChunk(decoder.decode());
    } finally {
        clearInterval(interval);
        readerSlot.current = null;
        if (registerForCancelRef) registerForCancelRef.current = null;
        // Multi-AU: if anything threw before the inner per-reader finally ran, clear dangling refs and locks.
        if (registerInMultiListRef?.current?.length) {
            const stale = [...registerInMultiListRef.current];
            registerInMultiListRef.current.length = 0;
            for (const r of stale) {
                try {
                    await r.cancel();
                } catch {
                    /* ignore */
                }
                try {
                    r.releaseLock();
                } catch {
                    /* ignore */
                }
            }
        }
    }

    return { bytesIn };
}

/**
 * Best-effort close for specific keys in a port Map. Ignores errors.
 * Call only after readers are released, otherwise close() may reject (readable locked).
 * @param {Map<string, SerialPort>} portMap
 * @param {string[]} keys
 */
export async function closeSerialPortsForKeys(portMap, keys) {
    if (!portMap || !keys?.length) return;
    const t = getSerialPlatformTiming();
    for (const key of keys) {
        const p = portMap.get(key);
        if (!p) continue;
        try {
            await p.close();
        } catch {
            /* ignore */
        }
    }
    await delay(t.afterPortCloseMs);
}
