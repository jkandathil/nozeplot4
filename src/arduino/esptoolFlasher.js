/**
 * ESP32 family / ESP8266 flashing via esptool-js over Web Serial.
 *
 * esptool-js owns the port (Transport opens/closes it), so the port must be
 * CLOSED before calling this. Any app serial monitor must disconnect first.
 */

/**
 * @param {SerialPort} port  Web Serial port (closed)
 * @param {object} board     Board entry from boards.js (flashBaud, appOffset, name)
 * @param {{ data: Uint8Array, address: number }[]} fileArray  Binaries + flash offsets
 * @param {(p: { phase: string, written?: number, total?: number, message?: string }) => void} [onProgress]
 */
export async function flashEsp(port, board, fileArray, onProgress = () => {}) {
    const { ESPLoader, Transport } = await import('esptool-js');

    const terminal = {
        clean() {},
        writeLine(data) {
            onProgress({ phase: 'log', message: String(data) });
        },
        write(data) {
            onProgress({ phase: 'log', message: String(data) });
        },
    };

    const transport = new Transport(port, false);
    const esploader = new ESPLoader({
        transport,
        baudrate: board.flashBaud || 460800,
        romBaudrate: 115200,
        terminal,
    });

    try {
        onProgress({ phase: 'connecting', message: 'Connecting to ESP bootloader…' });
        const chip = await esploader.main();
        onProgress({ phase: 'detected', message: `Detected: ${chip}` });

        const total = fileArray.reduce((a, f) => a + f.data.length, 0);
        onProgress({ phase: 'writing', written: 0, total });

        await esploader.writeFlash({
            fileArray,
            flashSize: 'keep',
            flashMode: 'keep',
            flashFreq: 'keep',
            eraseAll: false,
            compress: true,
            reportProgress: (fileIndex, written, fileTotal) => {
                const base = fileArray.slice(0, fileIndex).reduce((a, f) => a + f.data.length, 0);
                onProgress({ phase: 'writing', written: base + written, total, fileIndex, fileTotal });
            },
        });

        onProgress({ phase: 'finishing', message: 'Resetting board…' });
        await esploader.after('hard_reset');
        onProgress({ phase: 'done', written: total, total, message: 'Flash complete.' });
    } finally {
        try {
            await transport.disconnect();
        } catch {
            /* ignore */
        }
    }
}
