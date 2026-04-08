"""
Reconstructed FeNOse training script (repeatable baseline).

Context:
- The original training was run interactively (not saved as a single script).
- This file reconstructs the core approach implied by:
  - /Users/jayanozhikandathil/Documents/data_fenoze/model/fenose_predict.py (feature extraction + v1 inference)
  - data_fenoze/model/metrics.json (LODO CV summary + augmentation description)
  - data_fenoze/model/validation_80_20_metrics.json (v2 split summary: PCA + scaled target)

This script is designed to be:
- Easy to run and modify
- Explicit about assumptions and knobs
- Able to export artifacts compatible with the app exporter:
  fenose_mlp_weights(_v2).npz and fenose_preprocessing(_v2).npz

IMPORTANT:
- Exact numerical reproduction of previously trained artifacts is unlikely unless you match
  the original random seeds, data paths, and interactive steps exactly.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

SENSOR_COLS = [f"{r}{c}" for r in "ABCDEFGH" for c in "12345678"]
ENV_COLS = ["AQT0", "AQH0", "AQP0"]


def parse_ppb_from_filename(name: str) -> float | None:
    # Accept both "10 ppb" and "10ppb". Do NOT use a word boundary after ppb because
    # curated filenames often use underscores, and '_' counts as a word char.
    m = re.search(r"(\d+(?:\.\d+)?)\s*ppb(?![a-z0-9])", str(name), re.IGNORECASE)
    return float(m.group(1)) if m else None


def is_validation_instrument_only_csv(name: str) -> bool:
    """
    True when basename names -val-nz without -asu-nz.
    Those CSVs are validation-instrument traces, not AU sensor arrays; exclude from training.
    """
    b = Path(name).name.lower()
    has_asu = re.search(r"\d{10}-\d{4}-asu-nz", b, re.IGNORECASE)
    has_val = re.search(r"\d{10}-\d{4}-val-nz", b, re.IGNORECASE)
    return bool(has_val) and not bool(has_asu)


def extract_features_from_df(df: pd.DataFrame) -> Dict[str, float]:
    """
    Extract ML features using BreathSampleCollection as baseline.

    Baseline: BreathSampleCollection — breath matrix on the sensor array before
    analyte measurement begins.  Falls back to AmbientSamplingRFC for legacy files.
    Signal:   FeNOMeasurement + FeNOWindow — analyte actively present.
    Exclude:  recoveryOff — post-measurement sensor recovery.
    """
    # Prefer BreathSampleCollection; fall back to AmbientSamplingRFC for legacy data
    baseline = df[df["event_name"] == "BreathSampleCollection"]
    if len(baseline) == 0:
        baseline = df[df["event_name"] == "AmbientSamplingRFC"]
    feno = df[df["event_name"] == "FeNOMeasurement"]
    window = df[df["event_name"] == "FeNOWindow"]
    if len(baseline) == 0 or len(feno) == 0:
        raise ValueError("Missing BreathSampleCollection (or AmbientSamplingRFC) or FeNOMeasurement phases")

    bl_mean = baseline[SENSOR_COLS].mean()
    feno_mean = feno[SENSOR_COLS].mean()
    feno_std = feno[SENSOR_COLS].std().fillna(0)
    delta = feno_mean - bl_mean
    norm_d = delta / (bl_mean.abs() + 1e-6)

    feats: Dict[str, float] = {}
    for s in SENSOR_COLS:
        feats[f"d_{s}"] = float(delta[s])
        feats[f"nd_{s}"] = float(norm_d[s])
        feats[f"fs_{s}"] = float(feno_std[s])

    if len(window) > 0:
        wd = window[SENSOR_COLS].mean() - bl_mean
        for s in SENSOR_COLS:
            feats[f"wd_{s}"] = float(wd[s])
    else:
        for s in SENSOR_COLS:
            feats[f"wd_{s}"] = 0.0

    # Environmental features from non-recovery rows only
    non_recovery = df[df["event_name"] != "recoveryOff"]
    for e in ENV_COLS:
        feats[f"env_{e}"] = float(non_recovery[e].mean()) if e in non_recovery.columns else 0.0

    # Environmental delta: BSC conditions vs FeNO conditions
    for e in ENV_COLS:
        bl_env = float(baseline[e].mean()) if e in baseline.columns else 0.0
        feno_env = float(feno[e].mean()) if e in feno.columns else 0.0
        feats[f"env_d_{e}"] = feno_env - bl_env

    feats["delta_mean"] = float(delta.mean())
    feats["delta_max"] = float(delta.max())
    feats["delta_min"] = float(delta.min())
    feats["delta_std"] = float(delta.std())
    feats["nd_mean"] = float(norm_d.mean())
    feats["nd_std"] = float(norm_d.std())
    return feats


def mlp_init(rng: np.random.Generator, d_in: int, h1: int, h2: int, d_out: int = 1):
    # He init
    W1 = rng.normal(0, np.sqrt(2 / d_in), size=(d_in, h1))
    b1 = np.zeros((h1,), dtype=float)
    W2 = rng.normal(0, np.sqrt(2 / h1), size=(h1, h2))
    b2 = np.zeros((h2,), dtype=float)
    W3 = rng.normal(0, np.sqrt(2 / h2), size=(h2, d_out))
    b3 = np.zeros((d_out,), dtype=float)
    return {"W1": W1, "b1": b1, "W2": W2, "b2": b2, "W3": W3, "b3": b3}


def relu(x):
    return np.maximum(0, x)


def mlp_forward(X: np.ndarray, w):
    a1 = relu(X @ w["W1"] + w["b1"])
    a2 = relu(a1 @ w["W2"] + w["b2"])
    y = a2 @ w["W3"] + w["b3"]
    return a1, a2, y


def train_mlp_mse(
    X: np.ndarray,
    y: np.ndarray,
    *,
    h1: int = 64,
    h2: int = 32,
    lr: float = 1e-3,
    epochs: int = 800,
    seed: int = 0,
):
    """
    Minimal numpy MLP trainer (MSE) for reproducible artifacts.
    This is a baseline; tune epochs/lr/regularization as needed.
    """
    rng = np.random.default_rng(seed)
    w = mlp_init(rng, X.shape[1], h1, h2, 1)
    y = y.reshape(-1, 1)
    n = X.shape[0]

    for _ in range(epochs):
        a1, a2, yhat = mlp_forward(X, w)
        err = (yhat - y) / n

        dW3 = a2.T @ (2 * err)
        db3 = (2 * err).sum(axis=0)

        da2 = (2 * err) @ w["W3"].T
        dz2 = da2 * (a2 > 0)
        dW2 = a1.T @ dz2
        db2 = dz2.sum(axis=0)

        da1 = dz2 @ w["W2"].T
        dz1 = da1 * (a1 > 0)
        dW1 = X.T @ dz1
        db1 = dz1.sum(axis=0)

        w["W1"] -= lr * dW1
        w["b1"] -= lr * db1
        w["W2"] -= lr * dW2
        w["b2"] -= lr * db2
        w["W3"] -= lr * dW3
        w["b3"] -= lr * db3

    return w


def standard_scale_fit(X: np.ndarray):
    mu = X.mean(axis=0)
    std = X.std(axis=0)
    std = np.where(std == 0, 1e-6, std)
    return mu, std


def standard_scale_apply(X: np.ndarray, mu: np.ndarray, std: np.ndarray):
    return (X - mu) / std


def pca_fit(X: np.ndarray, n_components: int):
    # SVD PCA (no whitening)
    U, S, Vt = np.linalg.svd(X, full_matrices=False)
    V = Vt.T[:, :n_components]
    return V


@dataclass
class Sample:
    file: Path
    device_id: str
    ppb: float
    feats: Dict[str, float]


def load_dataset(curated_dir: Path) -> List[Sample]:
    rows: List[Sample] = []
    for p in sorted(curated_dir.glob("*.csv")):
        if is_validation_instrument_only_csv(p.name):
            continue
        ppb = parse_ppb_from_filename(p.name)
        if ppb is None:
            continue
        df = pd.read_csv(p, low_memory=False)
        feats = extract_features_from_df(df)
        # device_id heuristic: tail "..._0000000009-0926-asu-nz.csv"
        m = re.search(r"(\d{10}-\d{4}-asu-nz)", p.name, re.IGNORECASE)
        device_id = m.group(1) if m else "UNKNOWN"
        rows.append(Sample(file=p, device_id=device_id, ppb=ppb, feats=feats))
    if not rows:
        # Some curated exports use "5ppb" (no separator) rather than "5 ppb". Accept that too.
        for p in sorted(curated_dir.glob("*.csv")):
            if is_validation_instrument_only_csv(p.name):
                continue
            m2 = re.search(r"(\d+(?:\.\d+)?)ppb\b", p.name, re.IGNORECASE)
            if not m2:
                continue
            ppb = float(m2.group(1))
            df = pd.read_csv(p, low_memory=False)
            feats = extract_features_from_df(df)
            m = re.search(r"(\d{10}-\d{4}-asu-nz)", p.name, re.IGNORECASE)
            device_id = m.group(1) if m else "UNKNOWN"
            rows.append(Sample(file=p, device_id=device_id, ppb=ppb, feats=feats))
            break
        if not rows:
            raise RuntimeError(f"No samples found in {curated_dir} (expected filenames with ppb).")
    return rows


def build_feature_matrix(samples: List[Sample]) -> Tuple[np.ndarray, np.ndarray, List[str]]:
    # Deterministic feature order: all observed keys sorted
    keys = sorted({k for s in samples for k in s.feats.keys()})
    X = np.array([[s.feats.get(k, 0.0) for k in keys] for s in samples], dtype=float)
    y = np.array([s.ppb for s in samples], dtype=float)
    return X, y, keys


def select_topk_by_abs_corr(X: np.ndarray, y: np.ndarray, k: int, eps: float = 1e-9) -> np.ndarray:
    # simple univariate ranking (baseline replacement for interactive feature selection)
    y0 = (y - y.mean()) / (y.std() + eps)
    scores = []
    for i in range(X.shape[1]):
        xi = (X[:, i] - X[:, i].mean()) / (X[:, i].std() + eps)
        scores.append(abs(float((xi * y0).mean())))
    idx = np.argsort(scores)[::-1][:k]
    return idx.astype(int)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--curated", required=True, help="Directory with curated CSVs (event_name + A1..H8).")
    ap.add_argument("--out", required=True, help="Output directory for npz artifacts.")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--v1_topk", type=int, default=80)
    ap.add_argument("--v2_pca", type=int, default=50)
    args = ap.parse_args()

    curated_dir = Path(args.curated)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    samples = load_dataset(curated_dir)
    X, y_ppb, feat_cols = build_feature_matrix(samples)

    # v1 target: log1p(ppb), then expm1 at inference
    y_log = np.log1p(np.clip(y_ppb, 0, None))
    top_idx = select_topk_by_abs_corr(X, y_log, args.v1_topk)
    X_sel = X[:, top_idx]
    mu, std = standard_scale_fit(X_sel)
    X_sc = standard_scale_apply(X_sel, mu, std)
    w1 = train_mlp_mse(X_sc, y_log, h1=64, h2=32, lr=1e-3, epochs=1200, seed=args.seed)

    np.savez(out_dir / "fenose_mlp_weights.npz", **w1)
    np.savez(
        out_dir / "fenose_preprocessing.npz",
        feat_cols=np.array(feat_cols, dtype=object),
        top_idx=top_idx,
        scaler_mean=mu,
        scaler_std=std,
    )

    # v2 (approx): standardize a "good feature" subset, PCA, then predict in ppb space scaled by y_max
    # good_mask here is reconstructed as: keep v1 top-k features in full space
    good_mask = np.zeros((len(feat_cols),), dtype=bool)
    for i in top_idx.tolist():
        good_mask[i] = True
    X_g = X[:, good_mask]
    feat_mean_g, feat_std_g = standard_scale_fit(X_g)
    X_g_sc = standard_scale_apply(X_g, feat_mean_g, feat_std_g)
    # PCA components are capped by rank: n_components <= min(n_samples, n_features)
    n_pca = int(min(args.v2_pca, X_g_sc.shape[0], X_g_sc.shape[1]))
    V_pca = pca_fit(X_g_sc, n_pca)  # shape [n_good x n_pca]

    X_pca = X_g_sc @ V_pca
    y_max = float(np.max(y_ppb))
    y_scaled = y_ppb / max(y_max, 1.0)
    w2 = train_mlp_mse(X_pca, y_scaled, h1=64, h2=32, lr=2e-3, epochs=1400, seed=args.seed + 1)

    np.savez(out_dir / "fenose_mlp_weights_v2.npz", **w2)
    # store V_pca in full feature mask space like the original app expects: [n_feat x n_pca]
    V_full = np.zeros((len(feat_cols), n_pca), dtype=float)
    V_full[good_mask, :] = V_pca
    feat_mean_full = np.zeros((len(feat_cols),), dtype=float)
    feat_std_full = np.ones((len(feat_cols),), dtype=float)
    feat_mean_full[good_mask] = feat_mean_g
    feat_std_full[good_mask] = feat_std_g

    np.savez(
        out_dir / "fenose_preprocessing_v2.npz",
        feat_cols=np.array(feat_cols, dtype=object),
        good_mask=good_mask,
        feat_mean=feat_mean_full,
        feat_std=feat_std_full,
        V_pca=V_full,
        y_max=y_max,
    )

    summary = {
        "n_samples": len(samples),
        "n_features_total": len(feat_cols),
        "v1_topk": int(args.v1_topk),
        "v2_pca": int(args.v2_pca),
        "y_max_ppb": y_max,
        "out_dir": str(out_dir),
    }
    (out_dir / "reconstructed_training_summary.json").write_text(json.dumps(summary, indent=2))
    print("Wrote artifacts to", out_dir)


if __name__ == "__main__":
    main()

