/**
 * Browser-facing capacity hints. We cannot read total system RAM reliably; we use:
 * - navigator.storage.estimate() — IndexedDB / origin quota and usage (best signal for this app)
 * - navigator.deviceMemory — optional, Chrome only, coarse GB bucket (4, 8, …)
 */

export function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** @returns {Promise<{ usage: number, quota: number, fractionUsed: number } | null>} */
export async function getBrowserStorageEstimate() {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') {
        return null;
    }
    try {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        const u = Math.max(0, Number(usage) || 0);
        const q = Math.max(0, Number(quota) || 0);
        return {
            usage: u,
            quota: q,
            fractionUsed: q > 0 ? Math.min(1, u / q) : 0,
        };
    } catch {
        return null;
    }
}

/** Chrome / some Chromium browsers only; else null */
export function getDeviceMemoryGb() {
    const d = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
    return Number.isFinite(d) && d > 0 ? d : null;
}

/** ~typical JSON row payload per synthetic FeNOse file in IndexedDB (order of magnitude) */
export const EST_BYTES_PER_SYNTHETIC_FILE = 130_000;

/**
 * @param {number} plannedFileCount
 * @param {{ usage: number, quota: number, fractionUsed: number } | null} est
 * @returns {{ severity: 'ok'|'warn'|'severe', messages: string[] }}
 */
export function syntheticWorkloadHints(plannedFileCount, est) {
    const messages = [];
    let severity = 'ok';
    const n = Math.max(0, Math.floor(Number(plannedFileCount) || 0));

    if (n <= 0) return { severity, messages };

    if (n > 3000) {
        messages.push(
            `You are about to create ${n.toLocaleString()} files. The tab may stay busy for a long time; consider smaller batches if the browser feels stuck.`
        );
        severity = 'warn';
    }
    if (n > 6000) {
        severity = 'severe';
    }

    const memGb = getDeviceMemoryGb();
    if (memGb != null && memGb <= 4 && n > 1200) {
        messages.push(
            `This browser reports about ${memGb} GB of device memory (coarse hint only). Large synthetic jobs may make the tab slow or unstable.`
        );
        if (severity === 'ok') severity = 'warn';
    }

    if (est && est.quota > 0) {
        const addBytes = n * EST_BYTES_PER_SYNTHETIC_FILE;
        const remaining = Math.max(0, est.quota - est.usage);
        const pct = Math.round(est.fractionUsed * 100);
        if (addBytes > remaining * 0.9) {
            messages.push(
                `Rough space needed for this run (~${formatBytes(addBytes)}) is close to or above estimated free browser storage for this site (~${formatBytes(remaining)}). The run may fail — free space or reduce units × concentrations × replicates.`
            );
            severity = 'severe';
        } else if (addBytes > remaining * 0.55 || est.fractionUsed >= 0.82) {
            messages.push(
                `Site storage is about ${pct}% full (${formatBytes(est.usage)} / ${formatBytes(est.quota)}). A large synthetic run might hit the browser quota.`
            );
            if (severity === 'ok') severity = 'warn';
        }
    }

    return { severity, messages: [...new Set(messages)] };
}

/**
 * @param {number} totalUploadBytes
 * @param {{ usage: number, quota: number, fractionUsed: number } | null} est
 */
export function uploadWorkloadHints(totalUploadBytes, est) {
    const messages = [];
    let severity = 'ok';
    const b = Math.max(0, Number(totalUploadBytes) || 0);

    if (b <= 0) return { severity, messages };

    const HALF_GB = 512 * 1024 * 1024;
    if (b > HALF_GB) {
        messages.push(`This upload is large (~${formatBytes(b)}). Parsing may use extra memory beyond file size.`);
        severity = 'warn';
    }

    const memGb = getDeviceMemoryGb();
    if (memGb != null && memGb <= 4 && b > 80 * 1024 * 1024) {
        messages.push(
            `This browser reports about ${memGb} GB device memory. Uploading ~${formatBytes(b)} may stress the tab on low-RAM profiles.`
        );
        if (severity === 'ok') severity = 'warn';
    }

    if (est && est.quota > 0) {
        const projected = est.usage + b;
        const remaining = est.quota - est.usage;
        const pct = Math.round(est.fractionUsed * 100);
        if (projected > est.quota * 0.98) {
            messages.push(
                `After this upload, site data may exceed the browser storage quota (${formatBytes(est.quota)}). Free workspace files or use smaller uploads.`
            );
            severity = 'severe';
        } else if (projected > est.quota * 0.8 || (remaining < b * 1.2 && b > 10 * 1024 * 1024)) {
            messages.push(
                `Site storage is ~${pct}% full. This upload (~${formatBytes(b)}) may leave little headroom (${formatBytes(remaining)} free).`
            );
            if (severity === 'ok') severity = 'warn';
        }
    }

    return { severity, messages: [...new Set(messages)] };
}
