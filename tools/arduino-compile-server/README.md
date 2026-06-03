# NozePlot MCU cloud compile bridge

Powers **Build & Flash** in the hosted app: compiles editor source to AVR `.hex` or ESP `.bin` via `arduino-cli`.

Deploy this **once**. After that, every visitor of the GitHub Pages app uses it
automatically — no setup, no server on their machine.

## Deploy (required once for GitHub Pages)

### Option A — Render free + keep-alive (no VM, no credit card, recommended) ⭐

Fully managed, no server to maintain, no payment. Render's free tier gives
750 instance-hours/month (≈ one service running 24/7), so a **keep-alive ping**
keeps it awake and removes cold starts.

1. [Render Dashboard](https://dashboard.render.com/) → **New** → **Blueprint** →
   connect this repo (`render.yaml` is included). No credit card required.
2. Copy the service URL (e.g. `https://noze-mcu-compile-bridge.onrender.com`).
3. GitHub → repo **Settings → Secrets and variables → Actions** → add
   `VITE_MCU_COMPILE_URL` = that URL.
4. Push to `main` or re-run **Deploy to GitHub Pages**.
5. **Keep it warm (removes cold starts):** create a free monitor at
   [cron-job.org](https://cron-job.org) (or [UptimeRobot](https://uptimerobot.com))
   that GETs `<your-url>/health` every **5 minutes**. The included workflow
   `.github/workflows/keep-bridge-warm.yml` also pings every 10 min as a backup
   (GitHub schedules can be delayed, so the external monitor is the reliable one).

> First request after the very first deploy may take ~30–60s while the service
> builds/wakes; once the keep-alive is running it stays warm.

### Option B — Oracle Cloud Always Free (free + always-on, but needs a VM)

Free forever, no cold starts, runs 24/7 — but you set up a small VM once.
Full walkthrough: **[ORACLE_DEPLOY.md](./ORACLE_DEPLOY.md)**.

### Option C — Google Cloud Run

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
