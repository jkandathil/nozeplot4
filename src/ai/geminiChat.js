/**
 * Google Gemini API (Generative Language) — browser-side streaming chat.
 * API key is supplied by the user (localStorage) or VITE_GEMINI_API_KEY at build time.
 *
 * @see https://ai.google.dev/api/generate-content
 */

/** Google is phasing out 2.0 Flash for new API keys — use 2.5 as default. */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/** @type {Record<string, string>} */
const DEPRECATED_GEMINI_MODEL_IDS = {
    'gemini-2.0-flash': 'gemini-2.5-flash',
    'gemini-2.0-flash-001': 'gemini-2.5-flash',
    'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
    'gemini-2.0-flash-lite-001': 'gemini-2.5-flash-lite',
};

/**
 * Map retired model ids (saved in localStorage / old builds) to current ids.
 * @param {string | undefined} id
 */
export function normalizeGeminiModelId(id) {
    let t = String(id || '').trim();
    if (!t) return DEFAULT_GEMINI_MODEL;
    // Strip resource prefix sometimes stored or echoed by APIs (`models/gemini-2.0-flash`)
    t = t.replace(/^models\//, '');
    if (DEPRECATED_GEMINI_MODEL_IDS[t]) return DEPRECATED_GEMINI_MODEL_IDS[t];
    // Any other 2.0 Flash variant (preview, exp, dated, …) → 2.5
    if (t.startsWith('gemini-2.0-flash-lite')) return 'gemini-2.5-flash-lite';
    if (t.startsWith('gemini-2.0-flash')) return 'gemini-2.5-flash';
    return t;
}

export const GEMINI_MODEL_OPTIONS = [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (recommended)' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
];

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * @param {Array<{ role: string, content: string }>} messages
 * @returns {{ contents: object[], systemInstruction?: object }}
 */
export function messagesToGeminiRequest(messages) {
    const contents = [];
    let systemParts = [];

    for (const m of messages) {
        if (!m?.content?.trim()) continue;
        if (m.role === 'system') {
            systemParts.push(m.content.trim());
            continue;
        }
        contents.push({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        });
    }

    const systemText = systemParts.join('\n\n');
    return {
        contents,
        ...(systemText
            ? { systemInstruction: { parts: [{ text: systemText }] } }
            : {}),
    };
}

/**
 * Parse one SSE `data:` line from streamGenerateContent (?alt=sse).
 * @param {string} line
 * @returns {string} incremental text, if any
 */
function extractTextFromSseDataLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return '';
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') return '';
    try {
        const data = JSON.parse(jsonStr);
        const parts = data?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return '';
        return parts.map((p) => p.text || '').join('');
    } catch {
        return '';
    }
}

/**
 * Stream a chat completion from Gemini.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array<{ role: string, content: string }>} opts.messages
 * @param {{ temperature?: number, top_p?: number, max_new_tokens?: number }} [opts.params]
 * @param {AbortSignal} [opts.signal]
 * @param {(text: string) => void} [opts.onChunk]
 * @param {() => void} [opts.onFirstChunk]
 * @returns {Promise<{ text: string, stats: { tokens: number, seconds: number, tps: number } }>}
 */
export async function streamGeminiChat({
    apiKey,
    model,
    messages,
    params = {},
    signal,
    onChunk,
    onFirstChunk,
}) {
    if (!apiKey?.trim()) {
        throw new Error('Gemini API key is missing. Add your key in AI Agents → Gemini Flash.');
    }

    const resolvedModel = normalizeGeminiModelId(model || DEFAULT_GEMINI_MODEL);

    const { contents, systemInstruction } = messagesToGeminiRequest(messages);
    if (!contents.length) {
        throw new Error('No messages to send to Gemini.');
    }

    const body = {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        generationConfig: {
            temperature: params.temperature ?? 0.5,
            topP: params.top_p ?? 0.9,
            maxOutputTokens: params.max_new_tokens ?? 2048,
        },
    };

    const url = `${API_BASE}/models/${encodeURIComponent(resolvedModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey.trim())}`;
    const started = Date.now();
    let firstChunkAt = null;
    let fullText = '';

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });

    if (!res.ok) {
        let detail = '';
        try {
            const errJson = await res.json();
            detail = errJson?.error?.message || JSON.stringify(errJson);
        } catch {
            try {
                detail = await res.text();
            } catch { /* ignore */ }
        }
        throw new Error(detail || `Gemini API error (${res.status})`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
        throw new Error('Gemini response had no body (streaming unavailable).');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const chunk = extractTextFromSseDataLine(line);
            if (!chunk) continue;
            if (firstChunkAt == null) {
                firstChunkAt = Date.now();
                onFirstChunk?.();
            }
            fullText += chunk;
            onChunk?.(chunk);
        }
    }

    if (buffer.trim()) {
        const chunk = extractTextFromSseDataLine(buffer);
        if (chunk) {
            if (firstChunkAt == null) {
                firstChunkAt = Date.now();
                onFirstChunk?.();
            }
            fullText += chunk;
            onChunk?.(chunk);
        }
    }

    const seconds = (Date.now() - started) / 1000;
    const tokens = Math.max(1, Math.ceil(fullText.length / 3.8));

    return {
        text: fullText,
        stats: {
            tokens,
            seconds,
            tps: seconds > 0 ? tokens / seconds : 0,
        },
    };
}

/**
 * Resolve API key: user override in UI, else Vite env at build time.
 * @param {string} storedKey from localStorage
 */
export function resolveGeminiApiKey(storedKey) {
    const fromEnv = typeof import.meta !== 'undefined' && import.meta.env?.VITE_GEMINI_API_KEY;
    const trimmed = String(storedKey || '').trim();
    if (trimmed) return trimmed;
    if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
    return '';
}
