/**
 * Client for the MCU cloud compile bridge (arduino-cli wrapper).
 *
 * The browser cannot run a C/C++ toolchain. Build & Flash sends editor source to a
 * hosted HTTPS compile service (VITE_MCU_COMPILE_URL), which returns firmware the
 * app flashes over Web Serial.
 *
 *   POST {baseUrl}/compile
 *   Request JSON:  { fqbn, sketch, sketchName?, files?, libraries? }
 *   Response JSON: { ok, stdout?, stderr?, hex? | bin? | parts? }  (base64 payloads)
 */

const LS_COMPILE_URL = 'arduino:compile-server-url';

/** Dev-only fallback when running `npm run mcu:bridge` locally. */
export const DEV_COMPILE_BRIDGE_URL = 'http://localhost:8787';

export const BUILD_SERVICE_UNAVAILABLE =
    'Cloud build service is unavailable right now. It may be waking up — wait a few seconds and click Build & Flash again.';

/** Optional build-time cloud compile URL (set VITE_MCU_COMPILE_URL in CI). */
export function getBuiltInCompileServerUrl() {
    try {
        const baked = import.meta.env.VITE_MCU_COMPILE_URL;
        if (baked && String(baked).trim()) return String(baked).trim().replace(/\/+$/, '');
    } catch {
        /* ignore */
    }
    return '';
}

export function hasCloudCompileService() {
    return !!getBuiltInCompileServerUrl();
}

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

/** Dev-only: Vite proxies /mcu-compile → localhost compile bridge. */
export function getDevProxyCompileUrl() {
    if (!import.meta.env.DEV) return '';
    try {
        const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
        return `${window.location.origin}${base}/mcu-compile`;
    } catch {
        return '';
    }
}

/** Ordered list of compile bridge URLs to try (cloud → stored → dev proxy → localhost). */
export function listCompileBridgeCandidates() {
    const out = [];
    const baked = getBuiltInCompileServerUrl();
    if (baked) out.push(baked);
    const stored = getCompileServerUrl();
    if (stored && !(baked && /localhost|127\.0\.0\.1/.test(stored)) && !out.includes(stored)) out.push(stored);
    const devProxy = getDevProxyCompileUrl();
    if (devProxy && !out.includes(devProxy)) out.push(devProxy);
    if (!out.includes(DEV_COMPILE_BRIDGE_URL)) out.push(DEV_COMPILE_BRIDGE_URL);
    return out;
}

export function base64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

export async function probeCompileServer(baseUrl, { signal, timeoutMs = 4000 } = {}) {
    const url = String(baseUrl || '').replace(/\/+$/, '');
    if (!url) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    if (signal) {
        if (signal.aborted) {
            clearTimeout(timer);
            return null;
        }
        signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    try {
        for (const path of ['/health', '']) {
            try {
                const res = await fetch(`${url}${path}`, { signal: ac.signal });
                if (!res.ok) continue;
                const json = await res.json();
                if (json?.ok) return url;
            } catch {
                /* try next path */
            }
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Find the first reachable compile bridge; retries for cold-start services. */
export async function resolveCompileBridgeUrl(options = {}) {
    const tries = options.retries ?? 3;
    const timeoutMs = options.timeoutMs ?? 12000;
    const candidates = listCompileBridgeCandidates();
    if (!candidates.length) return '';

    for (let attempt = 0; attempt < tries; attempt += 1) {
        for (const url of candidates) {
            const ok = await probeCompileServer(url, { timeoutMs });
            if (ok) {
                setCompileServerUrl(url);
                return url;
            }
        }
        if (attempt + 1 < tries) {
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
    }
    return '';
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

function resolveCompileUrl(baseUrl) {
    if (baseUrl) return String(baseUrl).replace(/\/+$/, '');
    for (const url of listCompileBridgeCandidates()) {
        if (url) return url;
    }
    return '';
}

/**
 * Compile a sketch on the cloud compile bridge.
 */
export async function compileSketch({ fqbn, sketch, sketchName, files, libraries, baseUrl, signal }) {
    const url = resolveCompileUrl(baseUrl);
    if (!url) {
        throw new Error(BUILD_SERVICE_UNAVAILABLE);
    }
    const res = await fetch(`${url}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fqbn,
            sketch,
            sketchName: sketchName || undefined,
            files: files && Object.keys(files).length ? files : undefined,
            libraries: libraries && libraries.length ? libraries : undefined,
        }),
        signal,
    });
    if (!res.ok) {
        let detail = '';
        try {
            detail = await res.text();
        } catch {
            /* ignore */
        }
        throw new Error(`Build service HTTP ${res.status}. ${detail.slice(0, 400)}`);
    }
    const json = await res.json();
    const result = {
        ok: !!json.ok,
        stdout: String(json.stdout || ''),
        stderr: String(json.stderr || ''),
    };
    if (!json.ok) return result;

    if (json.hex) {
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

// Legacy exports used during migration
export const DEFAULT_COMPILE_SERVER_URL = DEV_COMPILE_BRIDGE_URL;
export async function ensureCompileServerUrl(options) {
    return resolveCompileBridgeUrl(options);
}
