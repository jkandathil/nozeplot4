/**
 * ML backend registry for FeNOse / tabular sensor workflows.
 * TensorFlow.js is the default trainer; Ridge is a fast linear head on the same PCA features;
 * Transformers.js adds optional text embeddings; ONNX Runtime Web runs exported models (inference only).
 */

export const ML_ENGINE_TF_MLP = 'tensorflow_mlp';
export const ML_ENGINE_RIDGE_PCA = 'ridge_pca';

/** Training-time engine options (v2 pipeline). */
export const FENOSE_V2_TRAINING_ENGINES = [
    {
        id: ML_ENGINE_TF_MLP,
        label: 'TensorFlow.js — 2-layer MLP (default)',
        description:
            'Adam + MSE on PCA features. Best flexibility; exports W1…W3 JSON compatible with all existing FeNOse v2 models.',
        supportsTraining: true,
        usesEpochs: true,
    },
    {
        id: ML_ENGINE_RIDGE_PCA,
        label: 'Ridge regression — linear on PCA (fast)',
        description:
            'Closed-form L2-regularized linear model on the same PCA space as v2. Small data, quick baseline; weights use engine "ridge_pca" in JSON.',
        supportsTraining: true,
        usesEpochs: false,
    },
];

export const TRANSFORMERS_EMBED_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/** Optional ONNX inference: train in Python/R and export with input [1, nPca] float32. */
export const ONNX_INFERENCE_HINT =
    'ONNX Runtime Web loads in-browser when you call predictFenosePpbWithOnnx() from src/utils/mlEngines/onnxFeNOsePredict.js. ' +
    'Input tensor shape must be [1, n_components] matching your v2 preprocessing PCA size. ' +
    'Training ONNX models is not done in the browser — export from sklearn/pytorch after matching our feature pipeline.';
