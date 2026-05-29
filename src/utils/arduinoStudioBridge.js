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
