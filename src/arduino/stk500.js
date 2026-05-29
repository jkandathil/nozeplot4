/**
 * AVR STK500 v1 flashing over Web Serial (Arduino Uno / Nano / Pro Mini / Duemilanove).
 *
 * Implements the optiboot/Arduino bootloader subset: auto-reset (DTR/RTS pulse),
 * sync, enter program mode, paged flash write, and leave program mode.
 * Flash addresses on STK500 are WORD addresses (byte address >> 1).
 */

import { SerialIO } from './serialIO.js';
import { parseIntelHex } from './intelHex.js';

const Resp_STK_OK = 0x10;
const Resp_STK_INSYNC = 0x14;
const Sync_CRC_EOP = 0x20;
const Cmnd_STK_GET_SYNC = 0x30;
const Cmnd_STK_ENTER_PROGMODE = 0x50;
const Cmnd_STK_LEAVE_PROGMODE = 0x51;
const Cmnd_STK_LOAD_ADDRESS = 0x55;
const Cmnd_STK_PROG_PAGE = 0x64;
const Cmnd_STK_READ_SIGN = 0x75;

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function cmd(io, bytes, respLen, timeoutMs = 1000) {
    await io.write(Uint8Array.from([...bytes, Sync_CRC_EOP]));
    const head = await io.read(1, timeoutMs);
    if (head[0] !== Resp_STK_INSYNC) {
        throw new Error(`STK500 out of sync (got 0x${head[0].toString(16)})`);
    }
    let payload = new Uint8Array(0);
    if (respLen > 0) {
        payload = await io.read(respLen, timeoutMs);
    }
    const tail = await io.read(1, timeoutMs);
    if (tail[0] !== Resp_STK_OK) {
        throw new Error(`STK500 command not OK (got 0x${tail[0].toString(16)})`);
    }
    return payload;
}

async function autoReset(io) {
    // Pulse DTR/RTS to trigger the Arduino auto-reset capacitor.
    await io.setSignals({ dataTerminalReady: false, requestToSend: false });
    await delay(250);
    await io.setSignals({ dataTerminalReady: true, requestToSend: true });
    await delay(50);
}

async function sync(io, attempts = 10) {
    for (let i = 0; i < attempts; i += 1) {
        try {
            await io.drain(40);
            await io.write(Uint8Array.from([Cmnd_STK_GET_SYNC, Sync_CRC_EOP]));
            const a = await io.read(1, 350);
            if (a[0] === Resp_STK_INSYNC) {
                const b = await io.read(1, 350);
                if (b[0] === Resp_STK_OK) return true;
            }
        } catch {
            /* retry */
        }
    }
    return false;
}

/**
 * Flash an AVR board from an Intel HEX string.
 *
 * @param {SerialPort} port  Web Serial port (closed; this owns it during flashing)
 * @param {object} board     Board entry from boards.js (pageSize, flashSize, uploadBaud, signature)
 * @param {string} hexText   Intel HEX content
 * @param {(p: { phase: string, written?: number, total?: number, message?: string }) => void} [onProgress]
 */
export async function flashAvr(port, board, hexText, onProgress = () => {}) {
    const io = new SerialIO(port);
    try {
        onProgress({ phase: 'connecting', message: `Opening @ ${board.uploadBaud} baud` });
        await io.open(board.uploadBaud);

        onProgress({ phase: 'reset', message: 'Resetting board (DTR/RTS)…' });
        await autoReset(io);

        onProgress({ phase: 'sync', message: 'Synchronizing with bootloader…' });
        const ok = await sync(io);
        if (!ok) {
            throw new Error(
                'Could not sync with the AVR bootloader. Check the board, cable, that the port is not open elsewhere, and that you picked the right board/baud.'
            );
        }

        onProgress({ phase: 'progmode', message: 'Entering program mode…' });
        await cmd(io, [Cmnd_STK_ENTER_PROGMODE], 0);

        // Read + verify device signature (best effort)
        try {
            const sig = await cmd(io, [Cmnd_STK_READ_SIGN], 3);
            if (board.signature && (sig[0] !== board.signature[0] || sig[1] !== board.signature[1] || sig[2] !== board.signature[2])) {
                onProgress({
                    phase: 'warn',
                    message: `Signature 0x${[...sig].map((b) => b.toString(16).padStart(2, '0')).join('')} differs from expected ${board.name}. Continuing.`,
                });
            }
        } catch {
            /* some clones don't answer signature; continue */
        }

        const { data, minAddress } = parseIntelHex(hexText);
        if (board.flashSize && data.length > board.flashSize) {
            throw new Error(`Firmware (${data.length} B) exceeds flash size (${board.flashSize} B) for ${board.name}.`);
        }
        const pageSize = board.pageSize || 128;
        const total = data.length;

        onProgress({ phase: 'writing', written: 0, total });
        for (let offset = 0; offset < total; offset += pageSize) {
            const page = data.slice(offset, offset + pageSize);
            const byteAddr = minAddress + offset;
            const wordAddr = byteAddr >> 1;
            await cmd(io, [Cmnd_STK_LOAD_ADDRESS, wordAddr & 0xff, (wordAddr >> 8) & 0xff], 0);
            const len = page.length;
            await cmd(io, [Cmnd_STK_PROG_PAGE, (len >> 8) & 0xff, len & 0xff, 0x46 /* 'F' flash */, ...page], 0, 2000);
            onProgress({ phase: 'writing', written: Math.min(offset + pageSize, total), total });
        }

        onProgress({ phase: 'finishing', message: 'Leaving program mode…' });
        await cmd(io, [Cmnd_STK_LEAVE_PROGMODE], 0);

        onProgress({ phase: 'done', written: total, total, message: 'Flash complete.' });
    } finally {
        await io.close();
    }
}
