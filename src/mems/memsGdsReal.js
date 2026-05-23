/**
 * GDSII 8-byte real encoding/decoding (compatible with gdspy / common fab tools).
 * The `gdsii` npm parser uses a different decode; we use gdspy-compatible reals everywhere.
 */

/**
 * @param {number} value
 * @returns {Uint8Array}
 */
export function encodeReal8(value) {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    const out = new Uint8Array(buf);
    if (value === 0) return out;

    let hiByte;
    let x = value;
    if (x < 0) {
        hiByte = 0x80;
        x = -x;
    } else {
        hiByte = 0x00;
    }

    const fexp = Math.log2(x) / 4;
    let exponent = Math.ceil(fexp);
    if (fexp === exponent) exponent += 1;

    const mantissa = Math.round(x * 16 ** (14 - exponent));
    hiByte += exponent + 64;
    const byte2 = Math.floor(mantissa / 281474976710656);
    const short3 = Math.floor((mantissa % 281474976710656) / 4294967296);
    const long4 = mantissa % 4294967296;

    dv.setUint16(0, hiByte * 256 + byte2, false);
    dv.setUint16(2, short3, false);
    dv.setUint32(4, long4 >>> 0, false);
    return out;
}

/**
 * @param {DataView} dv
 * @param {number} offset
 * @returns {number}
 */
export function decodeReal8(dv, offset) {
    const short1 = dv.getUint16(offset, false);
    const short2 = dv.getUint16(offset + 2, false);
    const long3 = dv.getUint32(offset + 4, false);
    const exponent = ((short1 & 0x7f00) >>> 8) - 64;
    const mantissa =
        (((short1 & 0x00ff) * 65536 + short2) * 4294967296 + long3) / 72057594037927936.0;
    const v = mantissa * 16 ** exponent;
    return short1 & 0x8000 ? -v : v;
}
