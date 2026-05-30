# NozePlot MCU cloud compile bridge

Powers **Build & Flash** in the hosted app: compiles editor source to AVR `.hex` or ESP `.bin` via `arduino-cli`.

## Deploy (required once for GitHub Pages)

### Option A — Render (simplest)

1. [Render Dashboard](https://dashboard.render.com/) → **New** → **Blueprint** → connect this repo (`render.yaml` is included).
2. After deploy, copy the service URL (e.g. `https://noze-mcu-compile-bridge.onrender.com`).
3. GitHub → repo **Settings → Secrets → Actions** → add `VITE_MCU_COMPILE_URL` = that URL.
4. Push to `main` or re-run **Deploy to GitHub Pages**.

### Option B — Google Cloud Run

Add secrets `GCP_PROJECT_ID` and `GCP_SA_KEY`, push to `main`. Workflow `.github/workflows/deploy-mcu-bridge.yml` deploys automatically. Add the service URL to `VITE_MCU_COMPILE_URL`.

### Local dev only

```bash
npm run mcu:bridge
```

## API

```
POST /compile  { fqbn, sketch, sketchName?, files?, libraries? }
GET  /health   → { ok: true }
```
