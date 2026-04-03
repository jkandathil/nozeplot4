"""
fenose_predict.py  —  FeNOse Breathalyzer NO Concentration Predictor
Usage:
    python fenose_predict.py path/to/measurement.csv
"""
import numpy as np
import pandas as pd
import sys, os

SENSOR_COLS = [f"{r}{c}" for r in "ABCDEFGH" for c in "12345678"]

def load_model(model_dir="."):
    w = np.load(os.path.join(model_dir, "fenose_mlp_weights.npz"))
    p = np.load(os.path.join(model_dir, "fenose_preprocessing.npz"), allow_pickle=True)
    return w, p

def extract_features(csv_path):
    df = pd.read_csv(csv_path, low_memory=False)
    ambient = df[df["event_name"] == "AmbientSamplingRFC"]
    feno    = df[df["event_name"] == "FeNOMeasurement"]
    window  = df[df["event_name"] == "FeNOWindow"]
    if len(feno) == 0 or len(ambient) == 0:
        raise ValueError("Missing AmbientSamplingRFC or FeNOMeasurement phases")

    amb_mean  = ambient[SENSOR_COLS].mean()
    feno_mean = feno[SENSOR_COLS].mean()
    feno_std  = feno[SENSOR_COLS].std().fillna(0)
    delta     = feno_mean - amb_mean
    norm_d    = delta / (amb_mean.abs() + 1e-6)

    feats = {}
    for s in SENSOR_COLS:
        feats[f"d_{s}"]  = delta[s]
        feats[f"nd_{s}"] = norm_d[s]
        feats[f"fs_{s}"] = feno_std[s]
    if len(window) > 0:
        wd = window[SENSOR_COLS].mean() - amb_mean
        for s in SENSOR_COLS: feats[f"wd_{s}"] = wd[s]
    else:
        for s in SENSOR_COLS: feats[f"wd_{s}"] = 0.0
    for e in ["AQT0", "AQH0", "AQP0"]:
        feats[f"env_{e}"] = df[e].mean() if e in df.columns else 0.0
    feats["delta_mean"] = float(delta.mean()); feats["delta_max"] = float(delta.max())
    feats["delta_min"]  = float(delta.min());  feats["delta_std"] = float(delta.std())
    feats["nd_mean"] = float(norm_d.mean());   feats["nd_std"]    = float(norm_d.std())
    return feats

def mlp_predict(X, w):
    a1 = np.maximum(0, X @ w["W1"] + w["b1"])
    a2 = np.maximum(0, a1 @ w["W2"] + w["b2"])
    return (a2 @ w["W3"] + w["b3"]).flatten()

def predict_ppb(csv_path, model_dir="."):
    w, p = load_model(model_dir)
    feat_cols = list(p["feat_cols"])
    top_idx   = p["top_idx"]
    mu, std   = p["scaler_mean"], p["scaler_std"]

    feats = extract_features(csv_path)
    X = np.array([[feats.get(c, 0.0) for c in feat_cols]])
    X_sel = X[:, top_idx]
    X_sc  = (X_sel - mu) / std
    y_log = mlp_predict(X_sc, w)
    ppb   = float(np.expm1(np.clip(y_log, 0, 10)))
    return round(ppb, 2)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python fenose_predict.py <measurement.csv> [model_dir]")
        sys.exit(1)
    csv_file  = sys.argv[1]
    model_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(__file__)
    ppb = predict_ppb(csv_file, model_dir)
    print(f"Predicted NO concentration: {ppb} ppb")
