/**
 * Web Serial transport for a Kloehn / Cavro DT-protocol syringe pump.
 *
 * The browser counterpart of `kloehn_pump.py:KloehnPump`. Owns one
 * `SerialPort` + reader/writer pair and exposes promise-based methods
 * that send a command frame and resolve with the parsed response.
 *
 * Usage:
 *   const session = new PrinterSession({ baudRate: 9600, address: 1 });
 *   await session.openInteractive();   // prompts the user once
 *   await session.initializeSyringe();
 *   await session.dispenseRelative(96); // 96 steps ≈ 1 µL on a 250 µL/24k pump
 *   await session.close();
 *
 * The class is event-driven (`addEventListener('status', cb)`) so the UI can
 * stream log lines without poll-locking the React render path.
 */

import {
    buildFrame,
    parseResponse,
    cmdQueryStatus,
    cmdQueryFirmware,
    cmdQueryPosition,
    cmdInitialize,
    cmdValveInput,
    cmdValveOutput,
    cmdAspirateToAbsolute,
    cmdDispenseToAbsolute,
    cmdMoveAbsolute,
    cmdAspirateRel,
    cmdDispenseRel,
    cmdSetSpeed,
    cmdSetTopSpeedSps,
    cmdSetAccel,
    cmdHalt,
} from './kloehnProtocol.js';

/** Helpful default for Kloehn V6/V15C. */
export const DEFAULT_SERIAL_OPTS = Object.freeze({
    baudRate: 9600,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    flowControl: 'none',
    address: 1,
});

const ENCODER = new TextEncoder();

/** Detect Web Serial API availability. */
export function isWebSerialSupported() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
}

/**
 * Return `true` when the port's `getInfo()` looks like a Bluetooth serial
 * port (BT-SPP profile) rather than a USB-to-serial adapter. Chrome exposes
 * Bluetooth ports here as well, but they're almost never the right answer
 * for a benchtop syringe pump, so we hide them from the picker.
 */
function isBluetoothPort(port) {
    try {
        const info = port?.getInfo?.() ?? {};
        if (info.bluetoothServiceClassId != null) return true;
        if (info.usbVendorId == null && info.usbProductId == null) {
            /* On some Chromium builds the BT entries simply have no USB IDs
               at all. Treat that as Bluetooth/virtual unless the host
               specifically labels it differently. */
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Build a human-readable label for a granted serial port. Falls back to a
 * generic "Serial port" string when the browser can't tell us the
 * USB IDs (e.g. behind a virtual hub).
 */
export function describeSerialPort(port, indexHint = 0) {
    if (!port) return 'Unknown port';
    let info = {};
    try { info = port.getInfo() || {}; } catch { /* ignore */ }
    const vid = info.usbVendorId;
    const pid = info.usbProductId;
    const hex = (n, w) => (n ?? 0).toString(16).padStart(w, '0');
    if (vid != null && pid != null) {
        const vendor = KNOWN_USB_VENDORS[vid];
        const base = vendor
            ? `${vendor} ${hex(vid, 4)}:${hex(pid, 4)}`
            : `USB ${hex(vid, 4)}:${hex(pid, 4)}`;
        return `${base}`;
    }
    return `Serial port #${indexHint + 1}`;
}

/** A few common USB-to-serial bridges so the dropdown is easier to read. */
const KNOWN_USB_VENDORS = {
    0x0403: 'FTDI',
    0x067b: 'Prolific',
    0x10c4: 'Silicon Labs CP210x',
    0x1a86: 'WCH CH340',
    0x2341: 'Arduino',
    0x239a: 'Adafruit',
    0x0483: 'STMicro',
    0x16c0: 'Van Ooijen',
    0x04d8: 'Microchip',
};

/**
 * List every serial port previously granted to the page, skipping Bluetooth
 * SPP entries. Each entry is `{ port, label, key, info }`. The `key` is a
 * stable string suitable for using as a React `value=`/`<option key>`.
 */
export async function listGrantedSerialPorts() {
    if (!isWebSerialSupported()) return [];
    let ports = [];
    try { ports = await navigator.serial.getPorts(); } catch { return []; }
    const out = [];
    ports.forEach((p, i) => {
        if (isBluetoothPort(p)) return;
        let info = {};
        try { info = p.getInfo() || {}; } catch { /* ignore */ }
        const key = `${info.usbVendorId ?? 'x'}:${info.usbProductId ?? 'x'}#${i}`;
        out.push({ port: p, info, key, label: describeSerialPort(p, i) });
    });
    return out;
}

/**
 * Prompt the user to grant a new serial port. Returns the granted port, or
 * `null` if the dialog was cancelled. Caller is responsible for refreshing
 * any cached port list afterwards.
 */
export async function requestNewSerialPort() {
    if (!isWebSerialSupported()) throw new Error('Web Serial is not supported in this browser.');
    try {
        return await navigator.serial.requestPort();
    } catch (err) {
        /* User clicked Cancel in the chooser → `NotFoundError`. Surface as null. */
        if (err?.name === 'NotFoundError') return null;
        throw err;
    }
}

/**
 * Revoke the page's permission to access a previously-granted port. Uses
 * `SerialPort.forget()` when available (Chrome 103+). No-op on older builds.
 */
export async function forgetSerialPort(port) {
    if (!port) return false;
    if (typeof port.forget === 'function') {
        try { await port.forget(); return true; } catch { return false; }
    }
    return false;
}

/** Simple browser-side event target wrapper that tolerates manual listeners. */
class PrinterEventTarget {
    constructor() {
        this._listeners = new Map();
    }
    addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
        this._listeners.get(type)?.delete(fn);
    }
    dispatch(type, detail) {
        const set = this._listeners.get(type);
        if (!set) return;
        for (const fn of [...set]) {
            try {
                fn({ type, detail });
            } catch {
                /* ignore listener errors so a bad UI doesn't break IO */
            }
        }
    }
}

/**
 * One opened pump connection.
 *
 * Events:
 *   'log'     — { level: 'info'|'warn'|'error', message }
 *   'tx'      — { frame: string }
 *   'rx'      — { frame: string, parsed: object }
 *   'open'    — null
 *   'close'   — { reason }
 */
export class PrinterSession extends PrinterEventTarget {
    constructor(opts = {}) {
        super();
        this.opts = { ...DEFAULT_SERIAL_OPTS, ...opts };
        this.port = null;
        this.reader = null;
        this.writer = null;
        this._buffer = new Uint8Array(0);
        this._busy = false;
        this._cancelToken = null;
    }

    _log(level, message) {
        this.dispatch('log', { level, message });
    }

    /** Open a port previously granted to the page (after user gesture). */
    async openPort(port) {
        if (this.port) {
            this._log('warn', 'Already open — disconnect first.');
            return;
        }
        this.port = port;
        await port.open({
            baudRate: this.opts.baudRate,
            dataBits: this.opts.dataBits,
            parity: this.opts.parity,
            stopBits: this.opts.stopBits,
            flowControl: this.opts.flowControl,
        });
        this.reader = port.readable.getReader();
        this.writer = port.writable.getWriter();
        this._buffer = new Uint8Array(0);
        this.dispatch('open', null);
        this._log('info', `Serial port opened @ ${this.opts.baudRate} baud.`);
        this._pumpReader();
    }

    /**
     * Open a specific serial port that the page has already been granted.
     * Used by the UI dropdown so the user can pick *which* device to use
     * when they have several adapters plugged in.
     */
    async openGranted(port) {
        if (!isWebSerialSupported()) {
            throw new Error('Web Serial is not supported in this browser. Use Chrome / Edge over HTTPS or localhost.');
        }
        if (!port) throw new Error('No serial port supplied.');
        await this.openPort(port);
        return port;
    }

    /**
     * Prompt the user to pick a serial port and open it. The chooser shows
     * every USB-to-serial adapter on the machine (Bluetooth SPP ports are
     * filtered later on the UI side). Returns the granted port, or null if
     * the user cancelled the dialog.
     */
    async openInteractive() {
        if (!isWebSerialSupported()) {
            throw new Error('Web Serial is not supported in this browser. Use Chrome / Edge over HTTPS or localhost.');
        }
        const port = await requestNewSerialPort();
        if (!port) return null;
        await this.openPort(port);
        return port;
    }

    async close(reason = 'user') {
        const port = this.port;
        try {
            if (this.reader) {
                try { await this.reader.cancel(); } catch { /* ignore */ }
                try { this.reader.releaseLock(); } catch { /* ignore */ }
            }
            if (this.writer) {
                try { await this.writer.close(); } catch { /* ignore */ }
                try { this.writer.releaseLock(); } catch { /* ignore */ }
            }
            if (port) {
                try { await port.close(); } catch { /* ignore */ }
            }
        } finally {
            this.port = null;
            this.reader = null;
            this.writer = null;
            this._buffer = new Uint8Array(0);
            this.dispatch('close', { reason });
            this._log('info', `Serial port closed (${reason}).`);
        }
    }

    get isOpen() {
        return !!this.port && !!this.writer;
    }

    /** Background loop: append incoming chunks to the rx buffer. */
    async _pumpReader() {
        if (!this.reader) return;
        try {
            for (;;) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value && value.byteLength) {
                    /* concat into the rx buffer */
                    const next = new Uint8Array(this._buffer.length + value.byteLength);
                    next.set(this._buffer, 0);
                    next.set(value, this._buffer.length);
                    this._buffer = next;
                }
            }
        } catch (err) {
            this._log('warn', `Read loop ended: ${err?.message ?? err}`);
        }
    }

    /**
     * Wait for one full DT response in the rx buffer.
     *
     * A complete reply is `… ETX CR LF`. Because the Web Serial reader is
     * chunked, the trailing CR/LF can arrive in a SEPARATE chunk after the
     * ETX. We must consume them together with the frame, otherwise they leak
     * into the next response and the parser misreads CR (0x0D) / LF (0x0A)
     * as the status byte (errorCode = 13 "expanded NVM failed" or 10
     * "unknown").
     *
     * Algorithm:
     *   1. Scan the buffer for ETX (0x03).
     *   2. Once found, wait up to `tailSettleMs` for CR/LF to arrive.
     *   3. Cut the frame INCLUDING trailing CR/LF, regardless of whether
     *      both bytes showed up — anything left in the buffer afterwards
     *      will be dropped at the start of the next sendCommand().
     *
     * @param {number} timeoutMs
     */
    async _readResponse(timeoutMs = 1200, tailSettleMs = 40) {
        const deadline = performance.now() + timeoutMs;
        let etxIdx = -1;
        let etxFoundAt = 0;
        for (;;) {
            if (etxIdx < 0) {
                for (let i = 0; i < this._buffer.length; i++) {
                    if (this._buffer[i] === 0x03 /* ETX */) {
                        etxIdx = i;
                        etxFoundAt = performance.now();
                        break;
                    }
                }
            }
            if (etxIdx >= 0) {
                /* Have we already swallowed the CR LF tail? */
                const haveCR = this._buffer[etxIdx + 1] === 0x0d;
                const haveLF =
                    this._buffer[etxIdx + 1] === 0x0a ||
                    this._buffer[etxIdx + 2] === 0x0a;
                const settled = performance.now() - etxFoundAt >= tailSettleMs;
                if ((haveCR && haveLF) || settled) {
                    let j = etxIdx + 1;
                    if (this._buffer[j] === 0x0d) j++;
                    if (this._buffer[j] === 0x0a) j++;
                    const frame = this._buffer.subarray(0, j);
                    this._buffer = this._buffer.subarray(j);
                    return frame;
                }
            }
            if (performance.now() >= deadline) {
                const frame = this._buffer;
                this._buffer = new Uint8Array(0);
                return frame;
            }
            await new Promise((r) => setTimeout(r, 5));
        }
    }

    /**
     * Send a raw command (no address / no terminator). Resolves with the
     * parsed response.
     *
     * @param {string} cmd  e.g. "Q", "IA1000R", "W4R"
     * @param {{ timeoutMs?: number }} [opts]
     */
    async sendCommand(cmd, opts = {}) {
        if (!this.writer) throw new Error('Pump is not connected.');
        if (this._busy) {
            /* Serialize requests so concurrent UI clicks don't garble the bus. */
            while (this._busy) await new Promise((r) => setTimeout(r, 4));
        }
        this._busy = true;
        try {
            /* Drain any stale bytes lingering from a previous misframed
               response (e.g. a stray CR/LF after a chunked frame). Without
               this, the next parse can pick up the orphaned byte as the
               status character — producing phantom err 10/13 codes. */
            if (this._buffer.length > 0) {
                if (this._buffer.length > 2) {
                    this._log('warn', `dropped ${this._buffer.length} stale rx byte(s) before send`);
                }
                this._buffer = new Uint8Array(0);
            }
            const frame = buildFrame(this.opts.address, cmd);
            this.dispatch('tx', { frame: frame.trim() });
            this._log('info', `→ ${frame.trim()}`);
            await this.writer.write(ENCODER.encode(frame));
            /* Tiny breath so the pump can latch the inbound byte stream.
               (The reader also waits up to 40 ms for the CR/LF tail after
               ETX, so this only needs to be long enough for the first byte
               to come back over the USB-to-serial bridge.) */
            await new Promise((r) => setTimeout(r, 30));
            const raw = await this._readResponse(opts.timeoutMs ?? 1200);
            const parsed = parseResponse(raw);
            this.dispatch('rx', { frame: this._safeFrameStr(raw), parsed });
            const tag = parsed.errorCode ? `err ${parsed.errorCode} (${parsed.errorName})` : 'ok';
            this._log(parsed.errorCode ? 'warn' : 'info', `← ${tag}${parsed.data ? ` · ${parsed.data}` : ''}`);
            return parsed;
        } finally {
            this._busy = false;
        }
    }

    /** Decode a frame byte buffer to a debug-friendly string (escape non-printables). */
    _safeFrameStr(buf) {
        let out = '';
        for (let i = 0; i < buf.length; i++) {
            const b = buf[i];
            if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
            else out += `\\x${b.toString(16).padStart(2, '0')}`;
        }
        return out;
    }

    /**
     * Poll status until pump reports ready (or timeout). Resolves with the
     * final parsed status frame.
     */
    /**
     * Poll the pump until it reports ready.
     *
     * The polling strategy interleaves two query types to balance responsiveness
     * against motor disturbance:
     *
     *   - **`Q`** (most polls): cheap status query, non-destructive, the
     *     manufacturer-documented "did the buffered command finish?" probe.
     *     Issuing it back-to-back during motion is safe and quiet.
     *   - **`?`** (every Nth poll, default 3rd): syringe position query.
     *     Returns both the status byte AND the live step count, which we
     *     dispatch as a 'position' event so the UI gauge can track the
     *     plunger in real time. Slightly heavier than `Q`, so we send it
     *     less often.
     *
     * On the final "ready" frame we also fire one explicit `?` so the gauge
     * lands on the exact end-of-move position even if the last interleaved
     * poll happened to be a `Q`.
     */
    async waitUntilReady({
        pollMs = 250,
        timeoutMs = 60000,
        positionEveryNthPoll = 3,
    } = {}) {
        const deadline = performance.now() + timeoutMs;
        let lastParsed = null;
        let pollCount = 0;
        for (;;) {
            const usePosition =
                positionEveryNthPoll > 0 && pollCount % positionEveryNthPoll === 0;
            const r = usePosition
                ? await this.sendCommand(cmdQueryPosition())
                : await this.sendCommand(cmdQueryStatus());
            pollCount++;
            lastParsed = r;
            if (usePosition) {
                const posN = parseInt((r?.data || '').trim(), 10);
                if (Number.isFinite(posN)) this.dispatch('position', { steps: posN });
            }
            /* Only honour `ready=true` when the error code is also clean — a
               malformed frame might claim ready with a phantom errorCode. */
            if (r?.ready && (r.errorCode === 0 || r.errorCode == null)) {
                /* Final position update so the gauge snaps to the exact end. */
                if (positionEveryNthPoll > 0 && !usePosition) {
                    try {
                        const pr = await this.sendCommand(cmdQueryPosition());
                        const posN = parseInt((pr?.data || '').trim(), 10);
                        if (Number.isFinite(posN)) this.dispatch('position', { steps: posN });
                    } catch {
                        /* ignore — caller will refresh position separately */
                    }
                }
                return r;
            }
            if (performance.now() >= deadline) {
                this._log('warn', `waitUntilReady timed out after ${timeoutMs} ms`);
                return r;
            }
            await new Promise((res) => setTimeout(res, pollMs));
        }
    }

    /* ---------------- high-level convenience ---------------- */

    queryStatus() { return this.sendCommand(cmdQueryStatus()); }
    queryFirmware() { return this.sendCommand(cmdQueryFirmware()); }
    queryPosition() { return this.sendCommand(cmdQueryPosition()); }
    initializeSyringe() { return this.sendCommand(cmdInitialize()); }

    /**
     * Initialise the syringe with the motion-control registers reset first.
     *
     * The pump keeps the last `V<n>` top-speed and `L<n>` acceleration
     * between commands. After a slow drop step (e.g. 200 sps), W4R would
     * home the plunger at that speed — meaning a half-stroke takes 2+
     * minutes and the stepper strains audibly the whole way. This helper
     * issues L7 + V<fastSps> first so init always runs at a quick, quiet
     * speed regardless of what the previous step left behind. Tolerates
     * rejection of the speed commands when the pump is in
     * "device not initialised" state (the W4R itself will clear the error).
     *
     * @param {number} fastSps Top speed for the homing move (≥ 2000 sps).
     */
    async safeInitialize(fastSps = 4000) {
        try {
            await this.setAcceleration(7);
            await this.setTopSpeedSps(Math.max(2000, fastSps | 0));
        } catch { /* tolerated — pump may currently reject any non-init cmd */ }
        return this.initializeSyringe();
    }
    valveInput() { return this.sendCommand(cmdValveInput()); }
    valveOutput() { return this.sendCommand(cmdValveOutput()); }
    moveAbsolute(stepPos) { return this.sendCommand(cmdMoveAbsolute(stepPos)); }
    aspirateRelative(steps) { return this.sendCommand(cmdAspirateRel(steps)); }
    dispenseRelative(steps) { return this.sendCommand(cmdDispenseRel(steps)); }
    setSpeedPreset(sIndex) { return this.sendCommand(cmdSetSpeed(sIndex)); }
    setTopSpeedSps(sps) { return this.sendCommand(cmdSetTopSpeedSps(sps)); }
    setAcceleration(lIndex) { return this.sendCommand(cmdSetAccel(lIndex)); }
    halt() { return this.sendCommand(cmdHalt()); }

    /** Chained "valve to input → aspirate to absolute → run". */
    aspirateToAbs(stepPos) { return this.sendCommand(cmdAspirateToAbsolute(stepPos)); }
    /** Chained "valve to output → dispense to absolute → run". */
    dispenseToAbs(stepPos) { return this.sendCommand(cmdDispenseToAbsolute(stepPos)); }

    /** Read the plunger's current step position (or null on failure). */
    async readPositionSteps() {
        const r = await this.queryPosition();
        const n = parseInt((r?.data || '').trim(), 10);
        return Number.isFinite(n) ? n : null;
    }

    /**
     * Aspirate exactly `deltaSteps` MORE liquid into the syringe, clamped to
     * the pump's stroke (so a "draw 250 µL from a syringe that already has 100
     * µL in it" doesn't blow past the upper limit).
     *
     * Uses an absolute `A<target>R` move so the final position is exactly
     * what was intended — no drift from the previous `P/D` relative model.
     *
     * Returns { current, target, delta, skipped } so the caller can report
     * whether the move was capped.
     *
     * @param {number} deltaSteps  positive = pull more liquid in
     * @param {number} stroke      pump's full-stroke step count (e.g. 48000)
     */
    async aspirateBy(deltaSteps, stroke) {
        const cur = (await this.readPositionSteps()) ?? 0;
        const dmag = Math.max(0, Math.round(deltaSteps));
        const target = Math.min(Math.max(1, stroke), cur + dmag);
        if (target <= cur) return { current: cur, target: cur, delta: 0, skipped: true };
        await this.moveAbsolute(target);
        return { current: cur, target, delta: target - cur, skipped: false };
    }

    /**
     * Dispense exactly `deltaSteps` OUT of the syringe, clamped to position 0.
     * Mirror of {@link aspirateBy}.
     *
     * @param {number} deltaSteps  positive = push that many steps out
     */
    async dispenseBy(deltaSteps) {
        const cur = (await this.readPositionSteps()) ?? 0;
        const dmag = Math.max(0, Math.round(deltaSteps));
        const target = Math.max(0, cur - dmag);
        if (target >= cur) return { current: cur, target: cur, delta: 0, skipped: true };
        await this.moveAbsolute(target);
        return { current: cur, target, delta: cur - target, skipped: false };
    }

    /**
     * Detect whether the pump has a **24 000-step** or **48 000-step** plunger.
     *
     * Mirrors the logic in `aspirate_now.py`:
     *   1. Park at 0.
     *   2. Try `A48000R`. If the pump replies with error code 3
     *      ("invalid argument" — position out of range) the stroke is 24 000.
     *   3. Otherwise the move succeeds and the stroke is 48 000. We then
     *      park back at 0 to leave the pump empty.
     *
     * Returns the stroke (24000 or 48000), or null if we couldn't probe
     * (e.g. pump not initialised yet → caller should run Init first).
     *
     * @param {{ moveTimeoutMs?: number }} [opts]
     */
    async detectStroke({ moveTimeoutMs = 90000 } = {}) {
        /* Park at 0 first so the test move is a meaningful full-stroke. */
        await this.moveAbsolute(0);
        await this.waitUntilReady({ timeoutMs: 20000 });

        const probe = await this.sendCommand('A48000R');
        if (probe?.errorCode === 7) {
            this._log('warn', 'Stroke detect: pump not initialised — run Init first.');
            return null;
        }
        if (probe?.errorCode === 3) {
            /* Rejected — 24 k pump. */
            this._log('info', 'Stroke detect: pump is 24 000 steps (A48000 rejected).');
            return 24000;
        }
        /* Accepted — wait for the full move, then return to 0. */
        await this.waitUntilReady({ timeoutMs: moveTimeoutMs });
        await this.moveAbsolute(0);
        await this.waitUntilReady({ timeoutMs: moveTimeoutMs });
        this._log('info', 'Stroke detect: pump is 48 000 steps.');
        return 48000;
    }
}
