/**
 * Low-level GDSII stream scan (lenient) and binary record assembly.
 */

import { RecordType } from 'gdsii';
import { decodeReal8 } from './memsGdsReal.js';

/** @typedef {{ tag: number, data: unknown }} ParsedRecord */

/**
 * Iterate stream records; unknown tags are skipped (foundry extensions).
 * @param {ArrayBuffer | Uint8Array} input
 * @param {(rec: ParsedRecord) => void} fn
 */
export function forEachGdsRecord(input, fn) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    while (offset + 4 <= bytes.length) {
        const len = dv.getUint16(offset, false);
        const tag = dv.getUint16(offset + 2, false);
        if (len < 4 || len % 2 !== 0 || offset + len > bytes.length) break;
        const bodyLen = len - 4;
        const bodyOffset = offset + 4;
        const data = parseRecordBody(dv, tag, bodyOffset, bodyLen);
        fn({ tag, data });
        offset += len;
    }
}

/**
 * @param {DataView} dv
 * @param {number} tag
 * @param {number} bodyOffset
 * @param {number} bodyLen
 */
function parseRecordBody(dv, tag, bodyOffset, bodyLen) {
    if (bodyLen === 0) return null;
    const low = tag & 0xff;
    try {
        if (low === 0x02) {
            if (bodyLen === 2) return dv.getInt16(bodyOffset, false);
            const out = [];
            for (let i = 0; i < bodyLen; i += 2) {
                out.push(dv.getInt16(bodyOffset + i, false));
            }
            return out.length === 1 ? out[0] : out;
        }
        if (low === 0x03) {
            if (bodyLen === 4) return dv.getInt32(bodyOffset, false);
            const out = [];
            for (let i = 0; i < bodyLen; i += 4) {
                out.push(dv.getInt32(bodyOffset + i, false));
            }
            return out.length === 1 ? out[0] : out;
        }
        if (low === 0x05) {
            if (bodyLen % 8 !== 0) return null;
            const reals = [];
            for (let i = 0; i < bodyLen; i += 8) {
                reals.push(decodeReal8(dv, bodyOffset + i));
            }
            return reals.length === 1 ? reals[0] : reals;
        }
        if (low === 0x06) {
            let slen = bodyLen;
            if (slen > 0 && dv.getUint8(bodyOffset + slen - 1) === 0) slen--;
            const td = new TextDecoder();
            return td.decode(new Uint8Array(dv.buffer, dv.byteOffset + bodyOffset, slen));
        }
    } catch {
        return null;
    }
    return new Uint8Array(dv.buffer, dv.byteOffset + bodyOffset, bodyLen);
}

/** Growing buffer for GDSII output */
export class GdsBuffer {
    constructor() {
        /** @type {Uint8Array[]} */
        this.chunks = [];
        this.len = 0;
    }

    /** @param {Uint8Array} u8 */
    push(u8) {
        this.chunks.push(u8);
        this.len += u8.length;
    }

    toUint8Array() {
        const out = new Uint8Array(this.len);
        let o = 0;
        for (const c of this.chunks) {
            out.set(c, o);
            o += c.length;
        }
        return out;
    }
}

/**
 * @param {number} tag RecordType value
 * @param {Uint8Array} payload Even-length body (not including 4-byte header)
 */
export function appendRecord(buf, tag, payload) {
    const plen = payload.length;
    const total = 4 + plen;
    const rec = new Uint8Array(total);
    const dv = new DataView(rec.buffer);
    dv.setUint16(0, total, false);
    dv.setUint16(2, tag, false);
    rec.set(payload, 4);
    buf.push(rec);
}

/** @param {number} n */
export function int16Bytes(n) {
    const u = new Uint8Array(2);
    new DataView(u.buffer).setInt16(0, n, false);
    return u;
}

/** @param {number} n */
export function int32Bytes(n) {
    const u = new Uint8Array(4);
    new DataView(u.buffer).setInt32(0, n, false);
    return u;
}

/** Even-length padded ASCII string for STRNAME/LIBNAME/etc. */
export function gdsStringBytes(str) {
    const td = new TextEncoder();
    let b = td.encode(str.slice(0, 256));
    if (b.length % 2 === 1) {
        const n = new Uint8Array(b.length + 1);
        n.set(b);
        n[b.length] = 0;
        b = n;
    }
    return b;
}

/** GDSII BGNLIB/BGNSTR timestamp */
export function nowTimestampBytes() {
    const d = new Date();
    const u = new Uint8Array(24);
    const dv = new DataView(u.buffer);
    const set = (off, v) => dv.setUint16(off, v, false);
    set(0, d.getUTCFullYear());
    set(2, d.getUTCMonth() + 1);
    set(4, d.getUTCDate());
    set(6, d.getUTCHours());
    set(8, d.getUTCMinutes());
    set(10, d.getUTCSeconds());
    set(12, d.getUTCFullYear());
    set(14, d.getUTCMonth() + 1);
    set(16, d.getUTCDate());
    set(18, d.getUTCHours());
    set(20, d.getUTCMinutes());
    set(22, d.getUTCSeconds());
    return u;
}

export { RecordType };
