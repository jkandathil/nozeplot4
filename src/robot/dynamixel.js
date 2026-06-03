/**
 * DYNAMIXEL Protocol 1.0 driver over the Web Serial API.
 *
 * The Andrew robot's 7 servos (MX-28 / MX-106) sit on a shared half-duplex
 * serial bus at 250000 baud and speak Protocol 1.0. This implements the small
 * subset the drop-cast app needs: ping, register read/write, and (optionally)
 * sync-write — all client-side, no server.
 *
 * Instruction packet:  FF FF ID LEN INSTR P1..Pn CHK
 *   LEN = n + 2,  CHK = ~(ID + LEN + INSTR + ΣP) & 0xFF
 * Status packet:       FF FF ID LEN ERR  P1..Pn CHK
 *
 * Reference: https://emanual.robotis.com/docs/en/dxl/protocol1/
 */

export const INSTR = {
    PING: 0x01,
    READ: 0x02,
    WRITE: 0x03,
    REG_WRITE: 0x04,
    ACTION: 0x05,
    RESET: 0x06,
    SYNC_WRITE: 0x83,
};

export const BROADCAST_ID = 0xfe;

/** Human-readable bits of the Protocol-1.0 error byte. */
export function describeError(err) {
    if (!err) return '';
    const bits = [
        [0x01, 'input voltage'],
        [0x02, 'angle limit'],
        [0x04, 'overheating'],
        [0x08, 'range'],
        [0x10, 'checksum'],
        [0x20, 'overload'],
        [0x40, 'instruction'],
    ];
    return bits
        .filter(([m]) => err & m)
        .map(([, name]) => name)
        .join(', ');
}

function checksum(id, len, instrOrErr, params) {
    let sum = id + len + instrOrErr;
    for (const p of params) sum += p;
    return (~sum) & 0xff;
}

export class DynamixelError extends Error {}

export class Dynamixel {
    /**
     * @param {import('../arduino/serialIO.js').SerialIO} io  an *opened* SerialIO at 250000 baud
     */
    constructor(io) {
        this.io = io;
        // Serialize bus access so overlapping reads/writes can't interleave.
        this._chain = Promise.resolve();
    }

    _enqueue(fn) {
        const run = this._chain.then(fn, fn);
        // Keep the chain alive regardless of individual failures.
        this._chain = run.then(
            () => {},
            () => {},
        );
        return run;
    }

    async _txPacket(id, instr, params = []) {
        const len = params.length + 2;
        const bytes = [0xff, 0xff, id & 0xff, len & 0xff, instr & 0xff, ...params, checksum(id, len, instr, params)];
        await this.io.write(Uint8Array.from(bytes));
    }

    /**
     * Read one status packet. Resyncs on the FF FF header so stray bytes from
     * the half-duplex echo or a previous timeout don't desync the stream.
     */
    async _rxStatus(timeoutMs = 250) {
        const deadline = Date.now() + timeoutMs;
        // Find header FF FF
        let prev = -1;
        for (;;) {
            const remain = deadline - Date.now();
            if (remain <= 0) throw new DynamixelError('Servo status timeout (no header)');
            const [b] = await this.io.read(1, remain);
            if (prev === 0xff && b === 0xff) break;
            prev = b;
        }
        const remain1 = Math.max(1, deadline - Date.now());
        const [id, len] = await this.io.read(2, remain1);
        if (len < 2) throw new DynamixelError(`Bad status length ${len}`);
        const remain2 = Math.max(1, deadline - Date.now());
        const rest = await this.io.read(len, remain2); // err + params + checksum
        const err = rest[0];
        const params = Array.from(rest.slice(1, len - 1));
        const chk = rest[len - 1];
        const expect = checksum(id, len, err, params);
        if (chk !== expect) throw new DynamixelError(`Servo checksum mismatch (id ${id})`);
        return { id, err, params };
    }

    /** PING a servo; resolves true if it answers. */
    ping(id, timeoutMs = 200) {
        return this._enqueue(async () => {
            await this.io.drain(10);
            await this._txPacket(id, INSTR.PING);
            try {
                const s = await this._rxStatus(timeoutMs);
                return s.id === id;
            } catch {
                return false;
            }
        });
    }

    /** Read `length` bytes from `addr`, returned little-endian as an integer. */
    readInt(id, addr, length, timeoutMs = 250) {
        return this._enqueue(async () => {
            await this.io.drain(6);
            await this._txPacket(id, INSTR.READ, [addr & 0xff, length & 0xff]);
            const s = await this._rxStatus(timeoutMs);
            if (s.params.length < length) throw new DynamixelError(`Short read from servo ${id}`);
            let v = 0;
            for (let i = 0; i < length; i += 1) v |= s.params[i] << (8 * i);
            return v >>> 0;
        });
    }

    /** Write an integer (little-endian, `length` bytes) to `addr`. */
    writeInt(id, addr, length, value, { expectStatus = true, timeoutMs = 250 } = {}) {
        return this._enqueue(async () => {
            const data = [];
            for (let i = 0; i < length; i += 1) data.push((value >> (8 * i)) & 0xff);
            await this.io.drain(4);
            await this._txPacket(id, INSTR.WRITE, [addr & 0xff, ...data]);
            if (id === BROADCAST_ID || !expectStatus) return null;
            const s = await this._rxStatus(timeoutMs);
            if (s.err) throw new DynamixelError(`Servo ${id} error: ${describeError(s.err)}`);
            return s;
        });
    }

    /**
     * SYNC_WRITE: write the same `length`-byte field to many servos in one
     * packet (no status returned). `entries` = [{ id, value }, …].
     */
    syncWriteInt(addr, length, entries) {
        return this._enqueue(async () => {
            const params = [addr & 0xff, length & 0xff];
            for (const { id, value } of entries) {
                params.push(id & 0xff);
                for (let i = 0; i < length; i += 1) params.push((value >> (8 * i)) & 0xff);
            }
            await this._txPacket(BROADCAST_ID, INSTR.SYNC_WRITE, params);
        });
    }
}
