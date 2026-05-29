/**
 * Bridges AI replies into the Arduino page: applies fenced C/C++ (Arduino) code to
 * the sketch editor, and exposes "agent actions" (compile, flash, read serial) so
 * the AI panel can run a build→flash→observe loop without importing the page.
 */

import { extractFencedCodeBlocks } from './codeStudioBridge.js';

let editorApi = null;
let agentActions = null;

/** @param {null | { applyFromMarkdown: (md: string) => { ok: boolean, reason?: string } }} api */
export function registerArduinoEditorApi(api) {
    editorApi = api || null;
}

/**
 * @param {null | {
 *   getSketch: () => string,
 *   compile: () => Promise<{ ok: boolean, log: string }>,
 *   flash: () => Promise<{ ok: boolean, log: string }>,
 *   readSerial: (ms: number) => Promise<string>,
 *   getState: () => { boardName: string, portConnected: boolean, compileConfigured: boolean },
 * }} actions
 */
export function registerArduinoAgentActions(actions) {
    agentActions = actions || null;
}

export function getArduinoAgentActions() {
    return agentActions;
}

export function isApplyCodeToArduinoEnabled() {
    try {
        return localStorage.getItem('arduino:apply-code') !== 'false';
    } catch {
        return true;
    }
}

const ARDUINO_FENCE_LANGS = ['arduino', 'ino', 'cpp', 'c++', 'cxx', 'c', 'cc', 'h', 'hpp'];
const FILE_NAME_RE = /[\w./-]+\.(?:ino|pde|cpp|cc|cxx|c|hpp|hh|h)/i;

/** Prefer Arduino/C/C++ blocks; else the longest block. */
export function pickBestArduinoBlock(blocks) {
    if (!blocks?.length) return null;
    const cpp = blocks.find((b) => ARDUINO_FENCE_LANGS.includes(b.lang));
    if (cpp) return cpp;
    return blocks.reduce((a, b) => (b.body.length > a.body.length ? b : a));
}

export function extractBestArduinoSketch(markdown) {
    return pickBestArduinoBlock(extractFencedCodeBlocks(markdown));
}

export function markdownHasArduinoCode(markdown) {
    return extractFencedCodeBlocks(markdown).length > 0;
}

function fileNameFromInfoString(info) {
    if (!info) return null;
    // tokens like:  cpp main.ino   |   cpp:sensor.h   |   cpp title=foo.cpp
    const cleaned = info.replace(/title=/gi, ' ').replace(/[:=]/g, ' ');
    const m = cleaned.match(FILE_NAME_RE);
    return m ? m[0].split(/[\\/]/).pop() : null;
}

function fileNameFromContext(before) {
    if (!before) return null;
    const lines = before.split('\n').filter((l) => l.trim());
    // search last few non-empty lines for an explicit filename
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i -= 1) {
        const line = lines[i];
        if (/file\s*[:=]/i.test(line) || /\b(create|new|update|add)\b/i.test(line) || /^[#*>\s`]*[\w./-]+\.\w+/.test(line)) {
            const m = line.match(FILE_NAME_RE);
            if (m) return m[0].split(/[\\/]/).pop();
        }
    }
    return null;
}

/**
 * Extract one or more named code files from an assistant reply. Filenames come
 * from the fence info string (```cpp main.ino), or a preceding line
 * (e.g. **File: sensor.h**). Returns `[{ lang, body, name|null, isMain }]`.
 */
export function extractNamedCodeFiles(markdown) {
    const s = String(markdown || '');
    const fence = /```([^\n]*)\n([\s\S]*?)```/g;
    const out = [];
    let m;
    while ((m = fence.exec(s)) !== null) {
        const info = (m[1] || '').trim();
        const body = String(m[2] || '').replace(/\n$/, '');
        if (!body.trim()) continue;
        const lang = info.split(/\s+/)[0]?.toLowerCase() || '';
        const before = s.slice(Math.max(0, m.index - 240), m.index);
        const name = fileNameFromInfoString(info) || fileNameFromContext(before);
        const hasEntry = /\bvoid\s+setup\s*\(/.test(body) && /\bvoid\s+loop\s*\(/.test(body);
        out.push({ lang, body, name: name || null, isMain: hasEntry });
    }
    // keep only code-ish blocks (skip pure shell/json/etc. when cpp blocks exist)
    const codeish = out.filter((b) => !b.lang || ARDUINO_FENCE_LANGS.includes(b.lang) || b.name);
    return codeish.length ? codeish : out;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} markdown
 * @param {{ maxWaitMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function tryApplyAssistantMarkdownToArduino(markdown, options = {}) {
    const { maxWaitMs = 4000 } = options;
    if (!markdownHasArduinoCode(markdown)) return { ok: false, reason: 'no_fence' };
    const deadline = Date.now() + maxWaitMs;
    let last = { ok: false, reason: 'not_ready' };
    while (Date.now() < deadline) {
        const r = editorApi?.applyFromMarkdown?.(markdown);
        if (r?.ok) return r;
        last = r || last;
        if (r?.reason && r.reason !== 'not_ready') return r;
        await sleep(50);
    }
    return last;
}
