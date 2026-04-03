#!/bin/bash
# ─────────────────────────────────────────────────────────────
# FeNOse Model Testing App — Launch Script (Mac / Linux)
# ─────────────────────────────────────────────────────────────
echo "🫁 FeNOse NO Concentration Predictor"
echo "─────────────────────────────────────────"

echo "📦 Installing dependencies..."
pip install streamlit pandas numpy plotly --quiet

echo ""
echo "🚀 Starting app at http://localhost:8501"
echo "   Other devices on your network: use your machine's IP address"
echo "   Press Ctrl+C to stop"
echo "─────────────────────────────────────────"

streamlit run app.py --server.address 0.0.0.0 --server.port 8501
