/**
 * Vite env (build-time). See .env.example for setup.
 * Sign-in is always required; Firebase config must be present at build time.
 */

/** @returns {string[]} lowercase hostnames after @, e.g. ['noze.ca'] */
export function getAllowedEmailDomains() {
    const multi = import.meta.env.VITE_ALLOWED_EMAIL_DOMAINS;
    const single = import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN || 'noze.ca';
    if (multi && String(multi).trim()) {
        return String(multi)
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
    }
    return [single.trim().toLowerCase()].filter(Boolean);
}

export function isEmailDomainAllowed(email) {
    if (!email || typeof email !== 'string') return false;
    const lower = email.trim().toLowerCase();
    const at = lower.lastIndexOf('@');
    if (at < 0 || at === lower.length - 1) return false;
    const domain = lower.slice(at + 1);
    return getAllowedEmailDomains().includes(domain);
}

export function allowedDomainsLabel() {
    return getAllowedEmailDomains().map((d) => `*@${d}`).join(', ');
}
