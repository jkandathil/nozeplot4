/**
 * Kloehn / Cavro Data Terminal (DT) protocol — browser port of the Python
 * driver in `Syringe_pump_control/pump_programming/kloehn_pump.py`.
 *
 * Wire format (all bytes ASCII unless noted):
 *
 *   PC → pump :    "/{address}{cmd}\r"     e.g. "/1IA1000R\r"
 *   pump → PC :    0xFF <addr> <status> <data>* 0x03 \r \n
 *
 *   - `address`     : 1–15 (pump's DIP-switch ID; default 1)
 *   - `cmd`         : one or more ASCII command characters
 *   - `R`           : the Execute terminator. Without R, a command is queued.
 *   - `status` byte : bit 5 = ready (1) / busy (0); bits 0-3 = error code.
 *
 * Defaults (Kloehn V6/V15C): 9600 baud, 8-N-1.
 *
 * This module is **pure protocol** — framing, parsing, command strings.
 * It does no IO; see `printerSession.js` for the Web Serial transport.
 */

/** Error names matching the Kloehn V6 manual section 5.1. */
export const KLOEHN_ERROR_CODES = {
    0: 'no error',
    1: 'syringe failed to initialize',
    2: 'invalid command',
    3: 'invalid argument',
    4: 'communication error',
    5: 'invalid R command',
    6: 'supply voltage too low',
    7: 'device not initialized',
    8: 'program in progress',
    9: 'syringe overload',
    11: 'syringe move not allowed',
    12: 'cannot move against limit',
    13: 'expanded NVM failed',
    15: 'command buffer overflow',
};

/** Preset speed mnemonics (S0..S34) → steps/sec (section 4.1.2 of manual). */
export const KLOEHN_SPEED_TABLE = {
    0: 6400, 1: 5600, 2: 5000, 3: 4400, 4: 3800, 5: 3200, 6: 2600, 7: 2200,
    8: 2000, 9: 1800, 10: 1600, 11: 1400, 12: 1200, 13: 1000, 14: 800, 15: 600,
    16: 400, 17: 200, 18: 190, 19: 180, 20: 170, 21: 160, 22: 150, 23: 140,
    24: 130, 25: 120, 26: 110, 27: 100, 28: 90, 29: 80, 30: 70, 31: 60,
    32: 50, 33: 40, 34: 30,
};

/** Build the full request frame for a given pump address + command string. */
export function buildFrame(address, cmd) {
    return `/${address}${cmd}\r`;
}

const STX = 0xff;
const ETX = 0x03;

/**
 * Parse a raw byte response from the pump. Strips framing (STX, ETX, CR/LF,
 * address bytes) and decomposes the status byte into ready / error code.
 *
 * @param {Uint8Array | ArrayBuffer | Array<number>} raw
 * @returns {{
 *   raw: Uint8Array,
 *   status: string | null,
 *   data: string,
 *   ready: boolean | null,
 *   errorCode: number | null,
 *   errorName: string | null,
 * }}
 */
export function parseResponse(raw) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw || []);
    if (bytes.length === 0) {
        return { raw: bytes, status: null, data: '', ready: null, errorCode: null, errorName: null };
    }
    /* Trim leading framing junk (STX, `/`, stray CR/LF, NULs that sometimes
       trail a previous frame when chunk boundaries fall between ETX and the
       \r\n tail), trailing CR/LF and ETX. */
    let start = 0;
    while (start < bytes.length && (
        bytes[start] === STX ||
        bytes[start] === 0x2f /* '/' */ ||
        bytes[start] === 0x0d /* CR */ ||
        bytes[start] === 0x0a /* LF */ ||
        bytes[start] === 0x00 /* NUL */
    )) start++;
    let end = bytes.length;
    while (end > start) {
        const b = bytes[end - 1];
        if (b === ETX || b === 0x0d /* CR */ || b === 0x0a /* LF */ || b === 0x00 /* NUL */) end--;
        else break;
    }
    /* The first byte after framing is usually the master address (often '0'). */
    if (end > start && bytes[start] >= 0x30 && bytes[start] <= 0x39) start++;

    const slice = bytes.subarray(start, end);
    let text = '';
    for (let i = 0; i < slice.length; i++) text += String.fromCharCode(slice[i]);

    const status = text.length > 0 ? text[0] : null;
    let data = text.length > 1 ? text.slice(1) : '';
    /* Clean any residual framing characters / replacement chars. */
    data = data.replace(/[\x00\x03\r\n\ufffd]/g, '').trim();

    let ready = null;
    let errorCode = null;
    if (status) {
        const sb = status.charCodeAt(0);
        ready = (sb & 0x20) !== 0;
        errorCode = sb & 0x0f;
    }

    return {
        raw: bytes,
        status,
        data,
        ready,
        errorCode,
        errorName: errorCode != null ? KLOEHN_ERROR_CODES[errorCode] ?? 'unknown' : null,
    };
}

/** ------------------------------------------------------------------
 * High-level DT command builders.
 *
 * Most return a string suitable for `buildFrame(address, cmd)`. Stack
 * multiple low-level letters to chain (e.g. "IA1000R" = valve in, move
 * absolute to 1000, execute).
 * ------------------------------------------------------------------ */

/** Status query (non-destructive). */
export const cmdQueryStatus = () => 'Q';
/** Firmware/version query. */
export const cmdQueryFirmware = () => '?23';
/** Current syringe position. */
export const cmdQueryPosition = () => '?';
/** Initialize the syringe (front-panel INITIALIZE button equivalent). */
export const cmdInitialize = () => 'W4R';
/** Valve to Input position (typically reservoir side). */
export const cmdValveInput = () => 'IR';
/** Valve to Output position (dispense side). */
export const cmdValveOutput = () => 'OR';
/** Move syringe to absolute step position (0..stroke). */
export const cmdMoveAbsolute = (stepPosition) => `A${stepPosition | 0}R`;
/** Aspirate relative steps (draw in). */
export const cmdAspirateRel = (steps) => `P${steps | 0}R`;
/** Dispense relative steps. */
export const cmdDispenseRel = (steps) => `D${steps | 0}R`;
/** Set predefined top speed (S0..S34). Returns just the speed letter — append R only once. */
export const cmdSetSpeed = (sIndex) => `S${sIndex | 0}R`;
/** Set arbitrary top speed in steps/sec (40..10000). No R per manual. */
export const cmdSetTopSpeedSps = (sps) => `V${sps | 0}`;
/** Set acceleration code 1..20 (L7R is the manual default). */
export const cmdSetAccel = (lIndex) => `L${lIndex | 0}R`;
/** Halt any motion immediately (terminate command buffer). */
export const cmdHalt = () => 'T';

/** Build a chained sequence "IA<n>R" / "OA<n>R". */
export function cmdAspirateToAbsolute(stepPosition) {
    return `IA${stepPosition | 0}R`;
}
export function cmdDispenseToAbsolute(stepPosition) {
    return `OA${stepPosition | 0}R`;
}

/**
 * Convenience: convert volume in nL to plunger steps, given the syringe size
 * and stroke.
 *
 *   stepsPerNl = stroke / (syringeUl × 1000)
 *
 * Example: 250 µL syringe with 24 000 steps → 24000/250000 = 0.096 step/nL
 *          → 100 nL = 9.6 steps (rounded to 10).
 *
 * @param {number} volumeNl
 * @param {number} syringeUl
 * @param {number} stroke
 */
export function nlToSteps(volumeNl, syringeUl, stroke) {
    const totalNl = Math.max(1, Number(syringeUl) || 0) * 1000;
    const s = (Number(volumeNl) || 0) * (Math.max(1, Number(stroke) || 0) / totalNl);
    return Math.max(0, Math.round(s));
}
/** Inverse of {@link nlToSteps}: integer plunger steps → volume in nL. */
export function stepsToNl(steps, syringeUl, stroke) {
    const totalNl = Math.max(1, Number(syringeUl) || 0) * 1000;
    return ((Number(steps) || 0) * totalNl) / Math.max(1, Number(stroke) || 0);
}

/** Round a step count to a 1-step grid, since the pump only addresses integers. */
export const roundSteps = (steps) => Math.max(0, Math.round(steps));
