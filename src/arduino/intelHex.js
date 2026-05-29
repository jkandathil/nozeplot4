/**
 * Minimal Intel HEX parser → flat byte image, for AVR (.hex) flashing.
 * Supports record types 00 (data), 01 (EOF), 02/04 (segment/linear extended address).
 */

/**
 * @param {string} hexText
 * @returns {{ data: Uint8Array, minAddress: number, maxAddress: number }}
 */
export function parseIntelHex(hexText) {
    const lines = String(hexText || '').split(/\r?\n/);
    let extLinear = 0;
    let extSegment = 0;
    let minAddr = Infinity;
    let maxAddr = 0;
    const chunks = [];

    for (let i = 0; i < lines.length; i += 1) {
        let line = lines[i].trim();
        if (!line) continue;
        if (line[0] !== ':') throw new Error(`Intel HEX line ${i + 1} does not start with ':'`);
        line = line.slice(1);
        if (line.length < 10 || line.length % 2 !== 0) {
            throw new Error(`Intel HEX line ${i + 1} has invalid length`);
        }
        const bytes = [];
        for (let j = 0; j < line.length; j += 2) {
            bytes.push(parseInt(line.slice(j, j + 2), 16));
        }
        const byteCount = bytes[0];
        const address = (bytes[1] << 8) | bytes[2];
        const recordType = bytes[3];
        const dataBytes = bytes.slice(4, 4 + byteCount);

        // checksum
        const sum = bytes.slice(0, 4 + byteCount + 1).reduce((a, b) => (a + b) & 0xff, 0);
        if (sum !== 0) throw new Error(`Intel HEX checksum error on line ${i + 1}`);

        if (recordType === 0x00) {
            const absAddr = (extLinear << 16) + extSegment + address;
            chunks.push({ addr: absAddr, data: Uint8Array.from(dataBytes) });
            minAddr = Math.min(minAddr, absAddr);
            maxAddr = Math.max(maxAddr, absAddr + byteCount);
        } else if (recordType === 0x01) {
            break;
        } else if (recordType === 0x02) {
            extSegment = ((dataBytes[0] << 8) | dataBytes[1]) << 4;
        } else if (recordType === 0x04) {
            extLinear = (dataBytes[0] << 8) | dataBytes[1];
        }
        // 0x03 / 0x05 (start address) ignored for flashing
    }

    if (!chunks.length) throw new Error('Intel HEX contained no data records');
    if (minAddr === Infinity) minAddr = 0;

    const data = new Uint8Array(maxAddr - minAddr).fill(0xff);
    for (const c of chunks) {
        data.set(c.data, c.addr - minAddr);
    }
    return { data, minAddress: minAddr, maxAddress: maxAddr };
}

/** True if the text looks like Intel HEX (':' records). */
export function looksLikeIntelHex(text) {
    const t = String(text || '').trim();
    if (!t.startsWith(':')) return false;
    return /^:[0-9A-Fa-f]{8,}/.test(t);
}
