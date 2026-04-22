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

    if (
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
        post({
            type: 'error',
            message: String(err?.message || err),
            stack: String(err?.stack || ''),
        });
        post({ type: 'status', status: 'idle' });
    }
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
        const streamer = new TextStreamer(generator.tokenizer, {
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
                // Low-level per-token pulse: lets the UI show "alive" dot
                // well before the first word-boundary flush.
                if (tokensOut === 1) {
                    post({ type: 'first-raw-token', delayMs: Math.round(performance.now() - t0) });
                }
            },
        });

        const {
            max_new_tokens = 512,
            temperature = 0.7,
            top_p = 0.9,
            do_sample = true,
            repetition_penalty = 1.1,
        } = params || {};

        const output = await generator(messages, {
            max_new_tokens,
            temperature,
            top_p,
            do_sample,
            repetition_penalty,
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

        // If the model produced nothing (e.g. immediate EOS), fall back
        // to whatever made it through the streamer so the user sees
        // _something_ instead of an empty bubble.
        if (!finalText) finalText = streamedText;

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
            post({ type: 'status', status: 'idle' });
            break;
        default:
            break;
    }
};
