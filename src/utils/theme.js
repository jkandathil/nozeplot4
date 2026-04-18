/**
 * App theme controller.
 *
 * Modes:
 *   - 'noze'  → current branded look (slate-800 chrome, green accent). Default.
 *   - 'dark'  → near-black, higher contrast for OLED / low-light.
 *   - 'light' → light surfaces with the same green accent.
 *
 * Applied by setting `data-theme` on <html> so CSS variables in `index.css`
 * cascade to the whole app. Theme is persisted in localStorage under
 * `nozeplot.theme`. Call `initTheme()` once on app boot.
 */

const STORAGE_KEY = 'nozeplot.theme';
const VALID = new Set(['noze', 'dark', 'light']);

export function readStoredTheme() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw && VALID.has(raw)) return raw;
    } catch {
        /* ignore */
    }
    return 'noze';
}

export function applyTheme(mode) {
    const next = VALID.has(mode) ? mode : 'noze';
    const root = document.documentElement;
    root.setAttribute('data-theme', next);
    try {
        localStorage.setItem(STORAGE_KEY, next);
    } catch {
        /* ignore */
    }
    try {
        window.dispatchEvent(new CustomEvent('noze-theme-change', { detail: { theme: next } }));
    } catch {
        /* ignore */
    }
    return next;
}

export function initTheme() {
    applyTheme(readStoredTheme());
}

export function cycleTheme(current) {
    const order = ['noze', 'dark', 'light'];
    const idx = order.indexOf(current);
    const next = order[(idx + 1) % order.length];
    return applyTheme(next);
}

export const THEME_ORDER = ['noze', 'dark', 'light'];
