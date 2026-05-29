/**
 * Client for a user-provided remote compile server (an arduino-cli wrapper).
 *
 * The browser cannot run a C/C++ toolchain, so closing the AI "write → compile →
 * flash" loop needs an external service. The expected contract is intentionally
 * simple so a tiny arduino-cli wrapper can satisfy it:
 *
 *   POST {baseUrl}/compile
 *   Request JSON:  { fqbn: string, sketch: string, files?: { [name]: string } }
 *   Response JSON: {
 *     ok: boolean,
 *     stdout?: string,
 *     stderr?: string,
 *     // exactly one of these, base64-encoded:
 *     hex?: string,                    // AVR .hex (Intel HEX, base64)
 *     bin?: string,                    // single merged ESP .bin (base64)
 *     parts?: { address: number, data: string }[],  // ESP multi-part (base64 each)
 *   }
 *
 * The server URL is configured per-browser in the Arduino page (localStorage).
 */

const LS_COMPILE_URL = 'arduino:compile-server-url';

export function getCompileServerUrl() {
    try {
        return localStorage.getItem(LS_COMPILE_URL) || '';
    } catch {
        return '';
    }
}

export function setCompileServerUrl(url) {
    try {
        if (url) localStorage.setItem(LS_COMPILE_URL, url);
        else localStorage.removeItem(LS_COMPILE_URL);
    } catch {
        /* ignore */
    }
}

export function base64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
}

export function bytesToBase64(bytes) {
    let bin = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const chunk = 0x8000;
    for (let i = 0; i < arr.length; i += chunk) {
        bin += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
    }
    return btoa(bin);
}

/**
 * Compile a sketch on the remote server.
 *
 * @param {object} args
 * @param {string} args.fqbn   Fully-qualified board name (board.fqbn)
 * @param {string} args.sketch Sketch source
 * @param {Record<string,string>} [args.files] Extra files by name
 * @param {string} [args.baseUrl] Override server URL (else stored value)
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, hex?: Uint8Array, parts?: {address:number,data:Uint8Array}[] }>}
 */
export async function compileSketch({ fqbn, sketch, files, baseUrl, signal }) {
    const url = (baseUrl || getCompileServerUrl()).replace(/\/+$/, '');
    if (!url) {
        throw new Error('No compile server configured. Set a compile server URL, or upload a precompiled .hex/.bin.');
    }
    const res = await fetch(`${url}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fqbn, sketch, files: files || undefined }),
        signal,
    });
    if (!res.ok) {
        let detail = '';
        try {
            detail = await res.text();
        } catch {
            /* ignore */
        }
        throw new Error(`Compile server HTTP ${res.status}. ${detail.slice(0, 400)}`);
    }
    const json = await res.json();
    const result = {
        ok: !!json.ok,
        stdout: String(json.stdout || ''),
        stderr: String(json.stderr || ''),
    };
    if (!json.ok) return result;

    if (json.hex) {
        // hex may be base64 of Intel HEX text, or raw Intel HEX text
        const raw = json.hex;
        if (/^[\s:0-9A-Fa-f]+$/.test(raw) && raw.includes(':')) {
            result.hexText = raw;
        } else {
            result.hexText = new TextDecoder().decode(base64ToBytes(raw));
        }
    } else if (Array.isArray(json.parts) && json.parts.length) {
        result.parts = json.parts.map((p) => ({ address: Number(p.address) || 0, data: base64ToBytes(p.data) }));
    } else if (json.bin) {
        result.parts = [{ address: 0, data: base64ToBytes(json.bin) }];
    }
    return result;
}
