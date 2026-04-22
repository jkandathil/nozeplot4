/* eslint-disable no-restricted-globals */

/**
 * AI Chat inference worker.
 *
 * Runs Hugging Face / ONNX chat-instruct models fully inside the browser
 * via @huggingface/transformers v4 (WebGPU-preferred, WASM fallback).
 * Models download once from the HF CDN and are persisted in the browser
 * Cache Storage so subsequent sessions are instant — this is what makes
 * "download into the app, stay available" work without a server.
 *
 * Protocol (main → worker):
 *   { type: 'load',    modelId, device, dtype }
 *   { type: 'generate', messages, params: { max_new_tokens, temperature, top_p } }
 *   { type: 'stop' }
 *   { type: 'unload' }
 *
 * Protocol (worker → main):
 *   { type: 'status',   status: 'idle'|'loading'|'ready'|'generating'|'error' }
 *   { type: 'progress', status, file, progress, loaded, total }
 *   { type: 'ready',    modelId, device, dtype, cached }
 *   { type: 'token',    text }
 *   { type: 'complete', text, stats }
 *   { type: 'stopped' }
 *   { type: 'error',    message }
 */

import {
    pipeline,
    TextStreamer,
    InterruptableStoppingCriteria,
    env,
} from '@huggingface/transformers';

// Allow only remote models from the HF hub; the browser Cache Storage
// then keeps the weights between sessions without needing a server.
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

async function loadModel(modelId, device, dtype) {
    const wantDevice = device || 'webgpu';
    const wantDtype = dtype || 'q4';

    if (
        generator &&
        currentModelId === modelId &&
        currentDevice === wantDevice &&
        currentDtype === wantDtype
    ) {
        post({ type: 'ready', modelId, device: wantDevice, dtype: wantDtype, cached: true });
        post({ type: 'status', status: 'ready' });
        return;
    }

    if (generator) {
        try { await generator.dispose?.(); } catch { /* ignore */ }
        generator = null;
        currentModelId = null;
    }

    post({ type: 'status', status: 'loading' });

    try {
        generator = await pipeline('text-generation', modelId, {
            device: wantDevice,
            dtype: wantDtype,
            progress_callback: (p) => {
                // p has shape { status, file?, progress?, loaded?, total?, name? }
                post({ type: 'progress', ...p });
            },
        });
        currentModelId = modelId;
        currentDevice = wantDevice;
        currentDtype = wantDtype;
        post({ type: 'ready', modelId, device: wantDevice, dtype: wantDtype, cached: false });
        post({ type: 'status', status: 'ready' });
    } catch (err) {
        generator = null;
        currentModelId = null;
        post({ type: 'error', message: String(err?.message || err) });
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
    const t0 = performance.now();
    let tokensOut = 0;

    try {
        const streamer = new TextStreamer(generator.tokenizer, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: (text) => {
                if (!text) return;
                tokensOut += 1;
                post({ type: 'token', text });
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
            return_full_text: false,
        });

        const dt = (performance.now() - t0) / 1000;

        // Extract the final assistant text (shape varies by model — we try
        // the common chat-template path first, then fall back).
        let finalText = '';
        const raw = output?.[0]?.generated_text;
        if (Array.isArray(raw)) {
            const last = raw[raw.length - 1];
            finalText = last?.content ?? '';
        } else if (typeof raw === 'string') {
            finalText = raw;
        }

        post({
            type: 'complete',
            text: finalText,
            stats: {
                seconds: dt,
                tokens: tokensOut,
                tps: dt > 0 ? tokensOut / dt : 0,
            },
        });
        post({ type: 'status', status: 'ready' });
    } catch (err) {
        post({ type: 'error', message: String(err?.message || err) });
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
