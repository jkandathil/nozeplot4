/**
 * Export FeNOse model .npz artifacts into browser-loadable JSON in /public/fenose_model/.
 * Output is gitignored — for local dev only; the production app loads models from workspace Model/.
 *
 * Why: the app runs in the browser; it can fetch JSON easily, but can't read local .npz files.
 *
 * Usage:
 *   node scripts/exportFenoseNpzsToPublic.mjs \
 *     --v1w "/abs/path/fenose_mlp_weights.npz" \
 *     --v1p "/abs/path/fenose_preprocessing.npz" \
 *     --v2w "/abs/path/fenose_mlp_weights_v2.npz" \
 *     --v2p "/abs/path/fenose_preprocessing_v2.npz"
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const v1w = getArg('--v1w');
const v1p = getArg('--v1p');
const v2w = getArg('--v2w');
const v2p = getArg('--v2p');

if (!v1w || !v1p || !v2w || !v2p) {
  console.error('Missing args. See file header for usage.');
  process.exit(1);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(root, 'public', 'fenose_model');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

ensureDir(path.join(outDir, 'v1'));
ensureDir(path.join(outDir, 'v2'));

const py = String.raw`
import argparse, json, numpy as np

def to_jsonable(x):
    if isinstance(x, np.ndarray):
        if x.dtype == np.object_:
            # e.g. feat_cols stored as object array of strings
            return [to_jsonable(v) for v in x.tolist()]
        if x.shape == ():
            return to_jsonable(x.item())
        return x.tolist()
    if isinstance(x, (np.floating, np.float32, np.float64)):
        return float(x)
    if isinstance(x, (np.integer, np.int32, np.int64)):
        return int(x)
    if isinstance(x, (bytes, bytearray)):
        try:
            return x.decode("utf-8")
        except Exception:
            return str(x)
    return x

def load_npz_dict(p, allow_pickle=False):
    d = np.load(p, allow_pickle=allow_pickle)
    out = {}
    for k in d.files:
        out[k] = to_jsonable(d[k])
    return out

ap = argparse.ArgumentParser()
ap.add_argument("--v1w", required=True)
ap.add_argument("--v1p", required=True)
ap.add_argument("--v2w", required=True)
ap.add_argument("--v2p", required=True)
ap.add_argument("--out", required=True)
args = ap.parse_args()

v1w = load_npz_dict(args.v1w, allow_pickle=False)
v1p = load_npz_dict(args.v1p, allow_pickle=True)
v2w = load_npz_dict(args.v2w, allow_pickle=False)
v2p = load_npz_dict(args.v2p, allow_pickle=True)

def pick(d, keys):
    return {k: d[k] for k in keys if k in d}

# v1 expected by app
v1_weights = pick(v1w, ["W1","b1","W2","b2","W3","b3"])
v1_p = pick(v1p, ["feat_cols","top_idx","scaler_mean","scaler_std"])

# v2 expected by app (based on model_tester/app.py)
v2_weights = pick(v2w, ["W1","b1","W2","b2","W3","b3"])
v2_p = pick(v2p, ["feat_cols","good_mask","feat_mean","feat_std","V_pca","y_max"])

payload = {"v1": {"weights": v1_weights, "preprocessing": v1_p},
           "v2": {"weights": v2_weights, "preprocessing": v2_p}}

print(json.dumps(payload))
`;

const payload = execFileSync('python3', ['-c', py, '--v1w', v1w, '--v1p', v1p, '--v2w', v2w, '--v2p', v2p, '--out', outDir], {
  encoding: 'utf8',
});

const parsed = JSON.parse(payload);

fs.writeFileSync(path.join(outDir, 'v1', 'weights.json'), JSON.stringify(parsed.v1.weights));
fs.writeFileSync(path.join(outDir, 'v1', 'preprocessing.json'), JSON.stringify(parsed.v1.preprocessing));
fs.writeFileSync(path.join(outDir, 'v2', 'weights.json'), JSON.stringify(parsed.v2.weights));
fs.writeFileSync(path.join(outDir, 'v2', 'preprocessing.json'), JSON.stringify(parsed.v2.preprocessing));

console.log('Exported FeNOse model JSON to', outDir);

