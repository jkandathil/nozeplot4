import { TRANSFORMERS_EMBED_MODEL_ID } from './registry.js';

let extractorPromise = null;

async function getExtractor() {
    if (!extractorPromise) {
        extractorPromise = (async () => {
            const { pipeline } = await import('@xenova/transformers');
            return pipeline('feature-extraction', TRANSFORMERS_EMBED_MODEL_ID);
        })();
    }
    return extractorPromise;
}

/**
 * Mean-pooled MiniLM embedding; returns first `dims` values (model is 384-dim).
 * @param {string} text
 * @param {number} [dims=8]
 * @returns {Promise<number[]>}
 */
export async function embedMiniLmSlice(text, dims = 8) {
    const ext = await getExtractor();
    const t = String(text || '').trim().slice(0, 512);
    if (!t) {
        return new Array(dims).fill(0);
    }
    const out = await ext(t, { pooling: 'mean', normalize: true });
    const data = out?.data;
    if (!data || !(data.length >= dims)) {
        const arr = data ? Array.from(data) : [];
        while (arr.length < dims) arr.push(0);
        return arr.slice(0, dims);
    }
    const arr = [];
    for (let i = 0; i < dims; i++) arr.push(Number(data[i]) || 0);
    return arr;
}
