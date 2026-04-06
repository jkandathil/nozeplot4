import { buildFenoseV2PcaFloat32Vector } from '../fenoseModel.js';

/**
 * Run an ONNX model on the same PCA feature vector as FeNOse v2 JSON preprocessing.
 * Expects a single float32 input [1, nPca] and a single float output (scaled target, same as MLP head: multiply by y_max for ppb).
 *
 * @param {object[]} dataRows — parsed CSV rows (same as predictFenosePpbV2FromRows)
 * @param {object} opts
 * @param {ArrayBuffer} opts.onnxBuffer
 * @param {object} opts.preprocessing — v2 preprocessing JSON
 * @param {{ fileName?: string, deviceId?: string }} [opts.predictContext] — required if preprocessing used text embeddings during training
 * @param {string} [opts.ep] — execution provider: 'wasm' | 'webgpu' (if available)
 * @returns {Promise<number>} predicted ppb
 */
export async function predictFenosePpbWithOnnx(dataRows, opts) {
    const { onnxBuffer, preprocessing, predictContext = {}, ep = 'wasm' } = opts;
    if (!onnxBuffer || !(onnxBuffer.byteLength > 0)) {
        throw new Error('ONNX: missing model buffer.');
    }
    const vec = await buildFenoseV2PcaFloat32Vector(dataRows, preprocessing, predictContext);
    const ort = await import('onnxruntime-web');
    if (ep === 'wasm') {
        ort.env.wasm.numThreads = 1;
    }
    const session = await ort.InferenceSession.create(onnxBuffer, { executionProviders: [ep] });
    const inName = session.inputNames[0];
    const outName = session.outputNames[0];
    const inputTensor = new ort.Tensor('float32', vec, [1, vec.length]);
    const feeds = { [inName]: inputTensor };
    const results = await session.run(feeds);
    const tensor = results[outName];
    if (!tensor?.data) {
        throw new Error('ONNX: output tensor missing.');
    }
    const raw = Number(tensor.data[0]);
    const p = preprocessing;
    const yMax = typeof p?.y_max === 'number' ? p.y_max : (Array.isArray(p?.y_max) ? Number(p.y_max[0]) : null);
    if (!Number.isFinite(yMax) || yMax <= 0) {
        throw new Error('ONNX: preprocessing missing y_max for ppb rescaling.');
    }
    const ppb = Math.max(0, Math.min(yMax, raw * yMax));
    return Math.round(ppb * 100) / 100;
}
