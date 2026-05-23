/**
 * Bridges AI chat replies into Code Studio's Monaco editor (syntax highlighting
 * follows the fenced code language). Shell callbacks are set from App.jsx;
 * the editor API is registered when Code Studio mounts.
 */

let shell = {
    ensureEverOpened: () => {},
    focusCodeStudio: () => {},
};

/** @type {null | { applyFromMarkdown: (md: string) => { ok: boolean, reason?: string } }} */
let editorApi = null;

export function initCodeStudioShell(next) {
    shell = { ...shell, ...next };
}

export function registerCodeStudioEditorApi(api) {
    editorApi = api || null;
}

/**
 * @param {string} markdown
 * @returns {{ lang: string, body: string }[]}
 */
export function extractFencedCodeBlocks(markdown) {
    const s = String(markdown || '');
    const re = /```([\w.-]*)\s*\n([\s\S]*?)```/g;
    const out = [];
    let m;
    while ((m = re.exec(s)) !== null) {
        const lang = (m[1] || '').trim().toLowerCase();
        const body = String(m[2] || '').replace(/\n$/, '');
        if (body.trim()) out.push({ lang, body });
    }
    return out;
}

export function isApplyCodeToStudioEnabled() {
    try {
        return localStorage.getItem('ai-chat:apply-code-to-studio') !== 'false';
    } catch {
        return true;
    }
}

export function markdownHasFencedCode(markdown) {
    return extractFencedCodeBlocks(markdown).length > 0;
}

/** Map common fence tags → Monaco language id */
export function fenceLangToMonacoLanguage(fenceLang) {
    const f = String(fenceLang || '').toLowerCase();
    const map = {
        py: 'python',
        python3: 'python',
        rb: 'ruby',
        rs: 'rust',
        sh: 'shell',
        bash: 'shell',
        zsh: 'shell',
        yml: 'yaml',
        js: 'javascript',
        jsx: 'javascript',
        ts: 'typescript',
        tsx: 'typescript',
        mjs: 'javascript',
        cjs: 'javascript',
    };
    if (map[f]) return map[f];
    if (f === 'json' || f === 'jsonc') return 'json';
    if (f === 'md' || f === 'markdown') return 'markdown';
    if (f === 'html' || f === 'htm') return 'html';
    if (f === 'css') return 'css';
    if (f === 'sql') return 'sql';
    if (f === 'xml') return 'xml';
    if (f === 'txt' || f === 'text' || f === '') return 'plaintext';
    return f;
}

/**
 * @param {{ lang: string, body: string }[]} blocks
 * @returns {{ lang: string, body: string } | null}
 */
export function pickBestCodeBlock(blocks) {
    if (!blocks?.length) return null;
    const py = blocks.find((b) => ['python', 'py', 'python3'].includes(b.lang));
    if (py) return py;
    return blocks.reduce((a, b) => (b.body.length > a.body.length ? b : a));
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} markdown
 * @param {{ autoFocus?: boolean, maxWaitMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function tryApplyAssistantMarkdownToCodeStudio(markdown, options = {}) {
    const { autoFocus = true, maxWaitMs = 6000 } = options;
    if (!markdownHasFencedCode(markdown)) {
        return { ok: false, reason: 'no_fence' };
    }

    shell.ensureEverOpened?.();
    if (autoFocus) shell.focusCodeStudio?.();

    const deadline = Date.now() + maxWaitMs;
    let last = { ok: false, reason: 'not_ready' };
    while (Date.now() < deadline) {
        const r = editorApi?.applyFromMarkdown?.(markdown);
        if (r?.ok) return r;
        last = r || last;
        if (r?.reason && r.reason !== 'not_ready') return r;
        await sleep(50);
    }
    return last.reason === 'no_file' ? last : { ok: false, reason: 'timeout' };
}
