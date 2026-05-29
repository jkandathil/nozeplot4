/**
 * Byte-level Web Serial helper with a buffered, timeout-aware reader.
 *
 * A single outstanding `reader.read()` is reused across calls so a timeout never
 * drops bytes (the pending read resolves into the buffer on the next call).
 */

export function isWebSerialSupported() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
}

function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

export class SerialIO {
    constructor(port) {
        this.port = port;
        this.reader = null;
        this.writer = null;
        this.buf = new Uint8Array(0);
        this.pendingRead = null;
        this.opened = false;
    }

    async open(baudRate) {
        await this.port.open({ baudRate });
        this.reader = this.port.readable.getReader();
        this.writer = this.port.writable.getWriter();
        this.opened = true;
    }

    async write(bytes) {
        const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
        await this.writer.write(arr);
    }

    async _pull(timeoutMs) {
        if (!this.pendingRead) this.pendingRead = this.reader.read();
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        });
        try {
            const { value, done } = await Promise.race([this.pendingRead, timeout]);
            this.pendingRead = null;
            if (done) return null;
            return value || new Uint8Array(0);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** Read exactly `n` bytes or throw on timeout. */
    async read(n, timeoutMs = 1000) {
        const deadline = Date.now() + timeoutMs;
        while (this.buf.length < n) {
            const remain = deadline - Date.now();
            if (remain <= 0) throw new Error(`Serial read timeout (wanted ${n} bytes, got ${this.buf.length})`);
            const chunk = await this._pull(remain);
            if (chunk && chunk.length) this.buf = concat(this.buf, chunk);
        }
        const out = this.buf.slice(0, n);
        this.buf = this.buf.slice(n);
        return out;
    }

    /** Drop any buffered + immediately-available input. */
    async drain(quietMs = 60) {
        this.buf = new Uint8Array(0);
        try {
            // consume whatever arrives within a short quiet window
            while (true) {
                const chunk = await this._pull(quietMs);
                if (!chunk || !chunk.length) break;
            }
        } catch {
            /* timeout = drained */
        }
        this.buf = new Uint8Array(0);
    }

    async setSignals(signals) {
        try {
            await this.port.setSignals(signals);
        } catch {
            /* not all ports support every signal */
        }
    }

    async close() {
        try {
            if (this.reader) {
                await this.reader.cancel().catch(() => {});
                this.reader.releaseLock();
            }
        } catch {
            /* ignore */
        }
        try {
            if (this.writer) {
                this.writer.releaseLock();
            }
        } catch {
            /* ignore */
        }
        try {
            if (this.opened) await this.port.close();
        } catch {
            /* ignore */
        }
        this.reader = null;
        this.writer = null;
        this.pendingRead = null;
        this.opened = false;
    }
}
