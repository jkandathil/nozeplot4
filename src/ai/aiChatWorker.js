/* eslint-disable no-restricted-globals */

/**
 * AI Chat inference worker.
 *
 * Runs Hugging Face / ONNX chat-instruct models fully inside the browser
 * via @huggingface/transformers v4 (WebGPU-preferred, WASM fallback).
 * Models download once from the HF CDN and are persisted in the browser
 * Cache Storage so subsequent sessions are instant.
 *
 * Protocol (main → worker):
 *   { type: 'load',     modelId, device, dtype }
 *   { type: 'load-uploaded', device, dtype, files: { "relative/path": ArrayBuffer } }
 *      ONNX / tokenizer files from a zip (Transformers.js–compatible layout).
 *   { type: 'generate', messages, params }
 *   { type: 'stop' }
 *   { type: 'unload' }
 *
 * Protocol (worker → main):
 *   { type: 'status',    status }
 *   { type: 'progress',  status, file, progress, loaded, total, name }
 *   { type: 'ready',     modelId, device, dtype, cached }
 *   { type: 'generation-started' }
 *   { type: 'first-token', delayMs }
 *   { type: 'token',      text }
 *   { type: 'complete',   text, stats }
 *   { type: 'stopped' }
 *   { type: 'error',      message, stack }
 *   { type: 'log',        level, message }
 */

import {
    pipeline,
    TextStreamer,
    InterruptableStoppingCriteria,
    env,
} from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

/** Synthetic repo id — actual bytes come from `uploadFileBuffers` via `env.fetch`. */
const UPLOAD_MODEL_ID = 'hf-internal/user-upload';

const defaultEnvFetch = env.fetch.bind(env);

/** Relative path (as in the Hugging Face repo zip) → file bytes */
const uploadFileBuffers = new Map();

function restoreDefaultUploadFetch() {
    uploadFileBuffers.clear();
    env.fetch = defaultEnvFetch;
}

function uploadAwareFetch(input, init) {
    let urlStr;
    if (typeof input === 'string') urlStr = input;
    else if (typeof Request !== 'undefined' && input instanceof Request) urlStr = input.url;
    else urlStr = String(input?.url || input || '');
    try {
        const u = new URL(urlStr, 'https://huggingface.co');
        const hostOk = u.hostname === 'huggingface.co' || u.hostname === 'hf.co';
        const needle = `/${UPLOAD_MODEL_ID}/resolve/`;
        if (hostOk && u.pathname.includes(needle)) {
            const m = /\/resolve\/[^/]+\/(.+)$/.exec(u.pathname);
            if (m) {
                const rel = decodeURIComponent(m[1]);
                if (uploadFileBuffers.has(rel)) {
                    const buf = uploadFileBuffers.get(rel);
                    return Promise.resolve(
                        new Response(buf, {
                            status: 200,
                            headers: {
                                'Content-Type': 'application/octet-stream',
                                'Content-Length': String(buf.byteLength),
                            },
                        })
                    );
                }
            }
        }
    } catch {
        /* fall through */
    }
    return defaultEnvFetch(input, init);
}

/**
 * Eager token-by-token streamer.
 *
 * The stock `TextStreamer` is word-boundary gated: it only fires
 * `callback_function` after a space is decoded. For short replies
 * ("Hi", "Yes.", code blocks with no spaces yet) the user sees an
 * empty bubble with only a "warming up" dot until end() is called,
 * which makes the UI look completely broken. This class decodes the
 * whole token cache after every generated token and emits the delta,
 * so text appears in the chat the instant it is produced.
 *
 * We deliberately extend `TextStreamer` (rather than the unexported
 * `BaseStreamer`) so we inherit the special-token handling and the
 * generate-loop's `put`/`end` protocol while overriding the flush
 * heuristic with something that is NOT space-gated.
 */
class EagerTextStreamer extends TextStreamer {
    constructor(tokenizer, options = {}) {
        super(tokenizer, options);
        this._emittedLen = 0;
    }

    put(value) {
        if (value.length > 1) {
            throw Error('EagerTextStreamer only supports batch size of 1');
        }

        const is_prompt = this.next_tokens_are_prompt;
        if (is_prompt) {
            this.next_tokens_are_prompt = false;
            if (this.skip_prompt) return;
        }

        const tokens = value[0];
        this.token_callback_function?.(tokens);

        // Skip decoding when the ONLY token in this batch is a special
        // token we're configured to hide.
        if (tokens.length === 1 && this.special_ids.has(tokens[0])) {
            if (this.decode_kwargs.skip_special_tokens) return;
        }

        this.token_cache.push(...tokens);

        let decoded;
        try {
            decoded = this.tokenizer.decode(this.token_cache, this.decode_kwargs);
        } catch {
            // Very rarely, partial UTF-8 bytes can throw during decode;
            // just wait for the next token to complete the sequence.
            return;
        }

        if (decoded.length > this._emittedLen) {
            const delta = decoded.slice(this._emittedLen);
            this._emittedLen = decoded.length;
            this.on_finalized_text(delta, false);
        }
    }

    end() {
        let decoded;
        try {
            decoded = this.tokenizer.decode(this.token_cache, this.decode_kwargs);
        } catch {
            decoded = '';
        }
        if (decoded.length > this._emittedLen) {
            const delta = decoded.slice(this._emittedLen);
            this._emittedLen = decoded.length;
            this.on_finalized_text(delta, true);
        } else {
            this.on_finalized_text('', true);
        }
        this.token_cache = [];
        this._emittedLen = 0;
        this.next_tokens_are_prompt = true;
    }
}

let generator = null;
let currentModelId = null;
let currentDevice = null;
let currentDtype = null;

let stoppingCriteria = null;

function post(msg) {
    try { self.postMessage(msg); } catch { /* ignore */ }
}

function logInfo(message, ...rest) {
    try { console.log('[aiChatWorker]', message, ...rest); } catch { /* ignore */ }
    post({ type: 'log', level: 'info', message: String(message) });
}

function logError(message, err) {
    try { console.error('[aiChatWorker]', message, err); } catch { /* ignore */ }
    post({
        type: 'log',
        level: 'error',
        message: `${message}${err ? `: ${err?.message || err}` : ''}`,
    });
}

async function loadModel(modelId, device, dtype) {
    const wantDevice = device || 'webgpu';
    const wantDtype = dtype || 'q4';

    if (modelId !== UPLOAD_MODEL_ID) {
        restoreDefaultUploadFetch();
    }

    if (
        modelId !== UPLOAD_MODEL_ID &&
        generator &&
        currentModelId === modelId &&
        currentDevice === wantDevice &&
        currentDtype === wantDtype
    ) {
        logInfo(`Reusing cached generator for ${modelId}`);
        post({ type: 'ready', modelId, device: wantDevice, dtype: wantDtype, cached: true });
        post({ type: 'status', status: 'ready' });
        return;
    }

    if (generator) {
        try { await generator.dispose?.(); } catch { /* ignore */ }
        generator = null;
        currentModelId = null;
    }

    logInfo(`Loading model ${modelId} on ${wantDevice} with dtype=${wantDtype}`);
    post({ type: 'status', status: 'loading' });

    try {
        generator = await pipeline('text-generation', modelId, {
            device: wantDevice,
            dtype: wantDtype,
            progress_callback: (p) => {
                post({ type: 'progress', ...p });
            },
        });
        currentModelId = modelId;
        currentDevice = wantDevice;
        currentDtype = wantDtype;
        logInfo(`Model ready: ${modelId}`);
        post({ type: 'ready', modelId, device: wantDevice, dtype: wantDtype, cached: false });
        post({ type: 'status', status: 'ready' });
    } catch (err) {
        logError('Model load failed', err);
        generator = null;
        currentModelId = null;
        if (modelId === UPLOAD_MODEL_ID) {
            restoreDefaultUploadFetch();
        }
        post({
            type: 'error',
            message: String(err?.message || err),
            stack: String(err?.stack || ''),
        });
        post({ type: 'status', status: 'idle' });
    }
}

async function loadUploadedModel(files, device, dtype) {
    if (generator) {
        try { await generator.dispose?.(); } catch { /* ignore */ }
        generator = null;
        currentModelId = null;
    }
    uploadFileBuffers.clear();
    if (files && typeof files === 'object') {
        for (const [path, buf] of Object.entries(files)) {
            const key = String(path).replace(/\\/g, '/');
            if (buf instanceof ArrayBuffer && key) {
                uploadFileBuffers.set(key, buf);
            }
        }
    }
    if (uploadFileBuffers.size === 0) {
        post({ type: 'error', message: 'No model files in upload — expected a Transformers.js ONNX zip.' });
        post({ type: 'status', status: 'idle' });
        return;
    }
    env.fetch = uploadAwareFetch;
    logInfo(`Uploaded ONNX bundle: ${uploadFileBuffers.size} file(s) → ${UPLOAD_MODEL_ID}`);
    await loadModel(UPLOAD_MODEL_ID, device, dtype);
}

async function generate(messages, params) {
    if (!generator) {
        post({ type: 'error', message: 'No model loaded yet — pick a model and click Load.' });
        return;
    }

    stoppingCriteria = new InterruptableStoppingCriteria();

    post({ type: 'status', status: 'generating' });
    post({ type: 'generation-started' });
    const t0 = performance.now();
    let firstTokenAt = 0;
    let tokensOut = 0;
    let streamedText = '';

    logInfo(`Generating with ${messages.length} message(s)`, {
        params,
        modelId: currentModelId,
        device: currentDevice,
        dtype: currentDtype,
    });
    try {
        // Compact preview of the full message list for end-to-end debug.
        // Lets users confirm in DevTools > Console that prior user +
        // assistant turns are ACTUALLY reaching the model.
        const preview = messages.map((m, i) => {
            const head = String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 160);
            const tail = (m.content?.length || 0) > 160 ? '…' : '';
            return `[${i}] ${m.role.padEnd(9)} ${head}${tail}`;
        });
        console.log(
            '[aiChatWorker] chat turns seen by the model:\n' + preview.join('\n')
        );
    } catch { /* ignore */ }

    try {
        const streamer = new EagerTextStreamer(generator.tokenizer, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: (text) => {
                if (!text) return;
                if (firstTokenAt === 0) {
                    firstTokenAt = performance.now();
                    post({ type: 'first-token', delayMs: Math.round(firstTokenAt - t0) });
                    logInfo(`First chunk emitted after ${Math.round(firstTokenAt - t0)}ms`);
                }
                streamedText += text;
                post({ type: 'token', text });
            },
            token_callback_function: () => {
                tokensOut += 1;
                if (tokensOut === 1) {
                    post({ type: 'first-raw-token', delayMs: Math.round(performance.now() - t0) });
                }
            },
        });

        const {
            max_new_tokens = 400,
            temperature = 0.4,
            top_p = 0.85,
            do_sample = true,
            repetition_penalty = 1.15,
            /* Hard cadence guard: 0 disables, 3–4 is typical. We
               default to 0 here so the worker stays generic; the UI
               layer is the one that decides per model tier whether to
               enable it. */
            no_repeat_ngram_size = 0,
            /* Top-K sampling cutoff. 0 disables, 40 is a sane chat
               default. Caps the rare-word tail that drives "lamb leg
               lemon line linking logistics" thesaurus drift. */
            top_k = 0,
        } = params || {};

        const output = await generator(messages, {
            max_new_tokens,
            temperature,
            top_p,
            top_k,
            do_sample,
            repetition_penalty,
            no_repeat_ngram_size,
            streamer,
            stopping_criteria: stoppingCriteria,
        });

        const dt = (performance.now() - t0) / 1000;

        // Extract the final assistant text. For chat inputs the pipeline
        // returns `generated_text` as the appended chat list.
        let finalText = '';
        const raw = output?.[0]?.generated_text;
        if (Array.isArray(raw)) {
            const last = raw[raw.length - 1];
            finalText = last?.content ?? '';
        } else if (typeof raw === 'string') {
            finalText = raw;
        }

        // If the pipeline returned no text (happens with some chat
        // templates when we can't round-trip the assistant role), fall
        // back to whatever made it through the streamer.
        if (!finalText) finalText = streamedText;

        // Last-resort: if truly nothing came out, surface a diagnostic
        // instead of a silent empty bubble so the user isn't left
        // wondering if the app broke.
        if (!finalText) {
            finalText = tokensOut > 0
                ? `⚠️ The model emitted ${tokensOut} token(s) but the decoder produced empty text. Try a different dtype or model.`
                : '⚠️ The model returned no output. Try reloading the model, lowering max_new_tokens, or switching dtype.';
            logError('Generator produced empty final text', { tokensOut, streamedLen: streamedText.length });
        }

        logInfo(`Done in ${dt.toFixed(2)}s · raw tokens=${tokensOut} · final=${finalText.length} chars`);
        post({
            type: 'complete',
            text: finalText,
            stats: {
                seconds: dt,
                tokens: tokensOut,
                tps: dt > 0 ? tokensOut / dt : 0,
                firstTokenMs: firstTokenAt ? firstTokenAt - t0 : null,
            },
        });
        post({ type: 'status', status: 'ready' });
    } catch (err) {
        logError('Generation failed', err);
        post({
            type: 'error',
            message: String(err?.message || err),
            stack: String(err?.stack || ''),
        });
        post({ type: 'status', status: 'ready' });
    } finally {
        stoppingCriteria = null;
    }
}

self.onmessage = async (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
        case 'load':
            await loadModel(msg.modelId, msg.device, msg.dtype);
            break;
        case 'load-uploaded':
            await loadUploadedModel(msg.files, msg.device, msg.dtype);
            break;
        case 'generate':
            await generate(msg.messages, msg.params);
            break;
        case 'stop':
            try { stoppingCriteria?.interrupt?.(); } catch { /* ignore */ }
            break;
        case 'unload':
            try { await generator?.dispose?.(); } catch { /* ignore */ }
            generator = null;
            currentModelId = null;
            currentDevice = null;
            currentDtype = null;
            restoreDefaultUploadFetch();
            post({ type: 'status', status: 'idle' });
            break;
        default:
            break;
    }
};
