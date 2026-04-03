"""
FeNOse Model Testing App
Streamlit webapp for predicting NO concentration from raw breathalyzer CSV files.
"""

import streamlit as st
import numpy as np
import pandas as pd
import re
import os
import io
import plotly.graph_objects as go
import plotly.express as px
from pathlib import Path

# ── Page config ───────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="FeNOse — NO Concentration Predictor",
    page_icon="🫁",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ── Styling ───────────────────────────────────────────────────────────────────
st.markdown("""
<style>
    .main-title   { font-size:2.2rem; font-weight:700; color:#1565C0; }
    .sub-title    { font-size:1rem; color:#555; margin-bottom:1.5rem; }
    .card         { background:#f0f6ff; border-left:4px solid #1565C0;
                    padding:1rem 1.4rem; border-radius:8px; margin:0.4rem 0; }
    .card-label   { font-size:.8rem; color:#555; font-weight:600;
                    text-transform:uppercase; letter-spacing:.05em; }
    .card-value   { font-size:1.9rem; font-weight:700; color:#1565C0; }
    .card-unit    { font-size:1rem; color:#777; margin-left:.3rem; }
    .ok  { background:#e6f4ea; border-left:4px solid #34a853;
           padding:.5rem 1rem; border-radius:6px; color:#1e7e34; font-weight:500; }
    .err { background:#fce8e6; border-left:4px solid #ea4335;
           padding:.5rem 1rem; border-radius:6px; color:#c62828; font-weight:500; }
    .warn{ background:#fff8e1; border-left:4px solid #f9a825;
           padding:.5rem 1rem; border-radius:6px; color:#6d4c00; font-weight:500; }
    .section { font-size:1.2rem; font-weight:600; color:#1565C0; margin:1rem 0 .4rem; }
</style>
""", unsafe_allow_html=True)

# ── Constants ─────────────────────────────────────────────────────────────────
SENSOR_COLS = [f"{r}{c}" for r in "ABCDEFGH" for c in "12345678"]
MODEL_DIR   = Path(__file__).parent.parent / "model"  # ../model relative to app.py

# ── Model loading ─────────────────────────────────────────────────────────────
@st.cache_resource(show_spinner=False)
def load_model(version: str):
    suffix = "_v2" if version == "v2" else ""
    w = np.load(MODEL_DIR / f"fenose_mlp_weights{suffix}.npz")
    p = np.load(MODEL_DIR / f"fenose_preprocessing{suffix}.npz", allow_pickle=True)
    return w, p

# ── Feature extraction ────────────────────────────────────────────────────────
def extract_features(df: pd.DataFrame) -> dict:
    ambient = df[df["event_name"] == "AmbientSamplingRFC"]
    feno    = df[df["event_name"] == "FeNOMeasurement"]
    window  = df[df["event_name"] == "FeNOWindow"]

    if len(feno) == 0 or len(ambient) == 0:
        raise ValueError("Missing AmbientSamplingRFC or FeNOMeasurement phases in CSV")

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
        feats[f"env_{e}"] = float(df[e].mean()) if e in df.columns else 0.0
    feats["delta_mean"] = float(delta.mean()); feats["delta_max"] = float(delta.max())
    feats["delta_min"]  = float(delta.min());  feats["delta_std"] = float(delta.std())
    feats["nd_mean"]    = float(norm_d.mean()); feats["nd_std"]   = float(norm_d.std())
    return feats

# ── MLP inference ─────────────────────────────────────────────────────────────
def mlp_forward(X: np.ndarray, w) -> np.ndarray:
    a1 = np.maximum(0, X @ w["W1"] + w["b1"])
    a2 = np.maximum(0, a1 @ w["W2"] + w["b2"])
    return (a2 @ w["W3"] + w["b3"]).flatten()

# ── Full prediction pipeline (handles both v1 and v2) ────────────────────────
def predict_from_df(df: pd.DataFrame, w, p, version: str) -> float:
    feats     = extract_features(df)
    feat_cols = list(p["feat_cols"])
    X         = np.array([[feats.get(c, 0.0) for c in feat_cols]])

    if version == "v2":
        # v2: good_mask → standardise → PCA → MLP (linear) → * y_max
        good_mask = p["good_mask"]
        mu, std   = p["feat_mean"][good_mask], p["feat_std"][good_mask]
        V_pca     = p["V_pca"][good_mask]
        y_max     = float(np.asarray(p["y_max"]).flat[0])
        X_g   = X[:, good_mask]
        X_sc  = (X_g - mu) / (std + 1e-8)
        X_pca = X_sc @ V_pca
        raw   = float(np.asarray(mlp_forward(X_pca, w)).flat[0])
        ppb   = float(np.clip(raw * y_max, 0, y_max))
    else:
        # v1: top_idx → standardise → MLP (log-ppb output) → expm1
        top_idx = p["top_idx"]
        mu, std = p["scaler_mean"], p["scaler_std"]
        X_sel = X[:, top_idx]
        X_sc  = (X_sel - mu) / std
        y_log = mlp_forward(X_sc, w)
        ppb   = float(np.expm1(np.clip(float(np.asarray(y_log).flat[0]), 0, 10)))

    return round(ppb, 2)

# ── Parse actual ppb from filename ───────────────────────────────────────────
def parse_actual_ppb(filename: str):
    m = re.search(r"[_\-](\d+(?:\.\d+)?)ppb", filename, re.IGNORECASE)
    return float(m.group(1)) if m else None

# ── Colour helper ─────────────────────────────────────────────────────────────
def error_color(err: float) -> str:
    if err <= 5:   return "🟢"
    if err <= 15:  return "🟡"
    return "🔴"

# ═════════════════════════════════════════════════════════════════════════════
# UI
# ═════════════════════════════════════════════════════════════════════════════

st.markdown('<div class="main-title">🫁 FeNOse NO Concentration Predictor</div>', unsafe_allow_html=True)
st.markdown('<div class="sub-title">Upload one or more raw breathalyzer CSV files to predict exhaled NO concentration (ppb).</div>', unsafe_allow_html=True)
st.divider()

# ── Sidebar ───────────────────────────────────────────────────────────────────
with st.sidebar:
    st.markdown("### ⚙️ Settings")

    model_version = st.radio(
        "Model version",
        ["v2 (latest)", "v1"],
        index=0,
        help="v2 is the most recently trained model"
    )
    ver = "v2" if model_version.startswith("v2") else "v1"

    # Try to load model
    try:
        w, p = load_model(ver)
        st.markdown(f'<div class="ok">✅ Model {ver} loaded</div>', unsafe_allow_html=True)
        feat_cols = list(p["feat_cols"])
        if ver == "v2":
            n_good = int(p["good_mask"].sum())
            n_pca  = p["V_pca"].shape[1]
            st.caption(f"Features: {n_good} → PCA {n_pca} components")
        else:
            st.caption(f"Features: {len(p['top_idx'])} selected from {len(feat_cols)}")
    except Exception as e:
        st.markdown(f'<div class="err">❌ Model load failed: {e}</div>', unsafe_allow_html=True)
        st.stop()

    st.divider()

    # Model performance summary
    st.markdown("### 📊 Model Performance (CV)")
    col_a, col_b = st.columns(2)
    col_a.metric("MAE", "2.02 ppb")
    col_b.metric("RMSE", "3.23 ppb")
    st.caption("Leave-One-Device-Out cross-validation")

    st.divider()

    # File uploader
    st.markdown("### 📂 Upload Files")
    uploaded_files = st.file_uploader(
        "Choose CSV measurement file(s)",
        type=["csv"],
        accept_multiple_files=True,
        label_visibility="collapsed",
        help="Files named like  '...75ppb...'  will auto-extract the actual concentration",
    )

# ── Main area ─────────────────────────────────────────────────────────────────
if not uploaded_files:
    c1, c2, c3 = st.columns(3)
    c1.info("**Step 1**\n\nChoose model version in the sidebar (v2 = latest).", icon="🧠")
    c2.info("**Step 2**\n\nUpload one or more raw CSV measurement files.", icon="📂")
    c3.info("**Step 3**\n\nView predicted NO concentration vs actual (parsed from filename).", icon="📈")

    st.markdown("---")
    st.markdown("**Expected filename format:**")
    st.code("ABGv5MUXOff-75ppb-3AH-75ccm-Maxwell-Q126_...csv")
    st.caption("The app automatically reads the actual concentration from the `75ppb` part of the filename.")

else:
    # ── Run predictions on all files ──────────────────────────────────────────
    results = []
    errors  = []

    progress = st.progress(0, text="Processing files…")

    for i, f in enumerate(uploaded_files):
        progress.progress((i) / len(uploaded_files), text=f"Processing {f.name}…")
        try:
            df  = pd.read_csv(f, low_memory=False)
            ppb = predict_from_df(df, w, p, ver)
            actual = parse_actual_ppb(f.name)
            results.append({
                "Filename": f.name,
                "Predicted (ppb)": ppb,
                "Actual (ppb)": actual,
                "Error (ppb)": round(abs(ppb - actual), 2) if actual is not None else None,
                "Error (%)": round(abs(ppb - actual) / max(actual, 1) * 100, 1) if actual is not None else None,
            })
        except Exception as e:
            errors.append({"Filename": f.name, "Error": str(e)})

    progress.progress(1.0, text="Done ✅")

    # ── Show errors prominently right away ────────────────────────────────────
    if errors:
        st.divider()
        st.error(f"⚠️ {len(errors)} file(s) failed to process:")
        for e in errors:
            st.markdown(f"**{e['Filename']}**")
            st.code(e["Error"])

    res_df = pd.DataFrame(results)

    if len(results) == 0:
        st.stop()

    # ── Single file view ──────────────────────────────────────────────────────
    if len(results) == 1:
        r = results[0]
        st.markdown(f'<div class="section">Result for: {Path(r["Filename"]).stem}</div>', unsafe_allow_html=True)

        m1, m2, m3 = st.columns(3)
        with m1:
            st.markdown(f"""
            <div class="card">
                <div class="card-label">Predicted NO</div>
                <div class="card-value">{r['Predicted (ppb)']}<span class="card-unit">ppb</span></div>
            </div>""", unsafe_allow_html=True)
        with m2:
            actual_str = f"{r['Actual (ppb)']}" if r["Actual (ppb)"] is not None else "—"
            st.markdown(f"""
            <div class="card">
                <div class="card-label">Actual NO (from filename)</div>
                <div class="card-value">{actual_str}<span class="card-unit">ppb</span></div>
            </div>""", unsafe_allow_html=True)
        with m3:
            err_str  = f"{r['Error (ppb)']}" if r["Error (ppb)"] is not None else "—"
            pct_str  = f"  ({r['Error (%)']}%)" if r["Error (%)"] is not None else ""
            st.markdown(f"""
            <div class="card">
                <div class="card-label">Absolute Error</div>
                <div class="card-value">{err_str}<span class="card-unit">ppb{pct_str}</span></div>
            </div>""", unsafe_allow_html=True)

        if r["Actual (ppb)"] is None:
            st.markdown('<div class="warn">⚠️ Could not parse actual concentration from filename. Rename file to include e.g. <b>75ppb</b> to enable comparison.</div>', unsafe_allow_html=True)

        # Clinical interpretation
        st.divider()
        pred = r["Predicted (ppb)"]
        if pred < 25:
            interp, color = "Normal (< 25 ppb) — FeNO within normal range", "#34a853"
        elif pred < 50:
            interp, color = "Borderline (25–50 ppb) — Possible airway inflammation", "#f9a825"
        else:
            interp, color = "Elevated (≥ 50 ppb) — Significant airway inflammation likely", "#ea4335"
        st.markdown(f"**Clinical range:** <span style='color:{color}; font-weight:600'>{interp}</span>", unsafe_allow_html=True)

    # ── Multi-file view ───────────────────────────────────────────────────────
    else:
        st.markdown(f'<div class="section">Results — {len(results)} file(s) processed</div>', unsafe_allow_html=True)

        if len(results) == 0:
            st.warning("No files were processed successfully. Check the error log below.")

        # Summary metrics (only if actuals available)
        has_actual = "Actual (ppb)" in res_df.columns and res_df["Actual (ppb)"].notna().any()
        if has_actual:
            sub = res_df.dropna(subset=["Actual (ppb)", "Error (ppb)"])
            if len(sub):
                mae  = sub["Error (ppb)"].mean()
                rmse = np.sqrt((sub["Error (ppb)"] ** 2).mean())
                r2   = 1 - np.sum((sub["Actual (ppb)"] - sub["Predicted (ppb)"]) ** 2) / \
                           np.sum((sub["Actual (ppb)"] - sub["Actual (ppb)"].mean()) ** 2)

                m1, m2, m3, m4 = st.columns(4)
                m1.metric("Files", len(results))
                m2.metric("MAE", f"{mae:.2f} ppb")
                m3.metric("RMSE", f"{rmse:.2f} ppb")
                m4.metric("R²", f"{r2:.4f}")

        st.divider()

        chart_col, tbl_col = st.columns([1.1, 1], gap="large")

        with chart_col:
            if has_actual:
                sub = res_df.dropna(subset=["Actual (ppb)"])
                tab1, tab2 = st.tabs(["Actual vs Predicted", "Error by Concentration"])

                with tab1:
                    fig = go.Figure()
                    fig.add_trace(go.Scatter(
                        x=sub["Actual (ppb)"],
                        y=sub["Predicted (ppb)"],
                        mode="markers",
                        marker=dict(size=10, color="#1565C0", opacity=0.8,
                                    line=dict(width=1, color="white")),
                        hovertemplate="Actual: %{x} ppb<br>Predicted: %{y} ppb<extra></extra>",
                        name="Measurements",
                    ))
                    lo = float(min(sub["Actual (ppb)"].min(), sub["Predicted (ppb)"].min())) - 2
                    hi = float(max(sub["Actual (ppb)"].max(), sub["Predicted (ppb)"].max())) + 2
                    fig.add_trace(go.Scatter(x=[lo, hi], y=[lo, hi],
                                             mode="lines", name="Perfect fit",
                                             line=dict(color="red", dash="dash", width=1.5)))
                    fig.update_layout(xaxis_title="Actual NO (ppb)",
                                      yaxis_title="Predicted NO (ppb)",
                                      height=380, plot_bgcolor="white", paper_bgcolor="white",
                                      margin=dict(l=10,r=10,t=10,b=10))
                    fig.update_xaxes(showgrid=True, gridcolor="#eee")
                    fig.update_yaxes(showgrid=True, gridcolor="#eee")
                    st.plotly_chart(fig, use_container_width=True)

                with tab2:
                    fig2 = px.bar(
                        sub.sort_values("Actual (ppb)"),
                        x="Actual (ppb)", y="Error (ppb)",
                        color="Error (ppb)",
                        color_continuous_scale=["#34a853", "#f9a825", "#ea4335"],
                        labels={"Error (ppb)": "Abs Error (ppb)"},
                        height=380,
                    )
                    fig2.update_layout(plot_bgcolor="white", paper_bgcolor="white",
                                       margin=dict(l=10,r=10,t=10,b=10))
                    st.plotly_chart(fig2, use_container_width=True)
            else:
                # Just show predicted values as bar
                fig = px.bar(res_df, x=res_df.index, y="Predicted (ppb)",
                             labels={"index": "File", "Predicted (ppb)": "Predicted NO (ppb)"},
                             height=380, color="Predicted (ppb)",
                             color_continuous_scale=["#34a853","#f9a825","#ea4335"])
                fig.add_hline(y=25, line_dash="dash", line_color="orange",
                              annotation_text="Borderline (25 ppb)", annotation_position="top left")
                fig.add_hline(y=50, line_dash="dash", line_color="red",
                              annotation_text="Elevated (50 ppb)", annotation_position="top left")
                fig.update_layout(plot_bgcolor="white", paper_bgcolor="white",
                                  margin=dict(l=10,r=10,t=10,b=10))
                st.plotly_chart(fig, use_container_width=True)

        with tbl_col:
            st.markdown("### 📋 Results Table")
            display = res_df.copy()
            # Add emoji indicator
            if "Error (ppb)" in display.columns:
                display.insert(0, "Status", display["Error (ppb)"].apply(
                    lambda e: error_color(e) if pd.notna(e) else "⚪"))
            display["Filename"] = display["Filename"].apply(lambda x: Path(x).stem[:40])

            st.dataframe(
                display.style.format({
                    "Predicted (ppb)": "{:.2f}",
                    "Actual (ppb)": lambda x: f"{x:.0f}" if pd.notna(x) else "—",
                    "Error (ppb)": lambda x: f"{x:.2f}" if pd.notna(x) else "—",
                    "Error (%)": lambda x: f"{x:.1f}%" if pd.notna(x) else "—",
                }).background_gradient(subset=["Error (ppb)"] if "Error (ppb)" in display.columns else [],
                                       cmap="RdYlGn_r", vmin=0, vmax=20),
                use_container_width=True, height=380,
            )

    # ── Download ───────────────────────────────────────────────────────────────
    if results:
        st.divider()
        csv_bytes = res_df.to_csv(index=False).encode("utf-8")
        st.download_button(
            "⬇️ Download Results as CSV",
            data=csv_bytes, file_name="fenose_predictions.csv",
            mime="text/csv", use_container_width=True,
        )
