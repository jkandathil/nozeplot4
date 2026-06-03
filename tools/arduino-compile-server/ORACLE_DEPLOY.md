# Free, always-on MCU compile bridge on Oracle Cloud

This hosts the open-source `arduino-cli` compile service on an **Oracle Cloud
Always Free** VM. It is **free forever**, **always on (no cold starts)**, and
your worldwide users do **nothing** — they just open the app and click
**Build & Flash**.

You do this **once**. Budget ~30 minutes.

---

## What you'll end up with

```
Any user's browser (GitHub Pages app)
        │  HTTPS
        ▼
https://<your-domain>           ← Oracle Always Free VM (24/7)
   Caddy (auto HTTPS)
        │
   arduino-cli compile container → returns .hex / .bin
        ▲
   browser flashes MCU over Web Serial
```

---

## Step 1 — Create the Always Free VM

1. Sign up at <https://www.oracle.com/cloud/free/> (a credit card is required for
   identity verification; **Always Free** resources are not charged).
2. Console → **Compute → Instances → Create instance**.
   - **Image:** Canonical Ubuntu (22.04 or 24.04).
   - **Shape:** **Ampere (VM.Standard.A1.Flex)** — Always Free. 1–2 OCPU / 6–12 GB
     RAM is plenty. (If A1 capacity is unavailable in your region, the
     `VM.Standard.E2.1.Micro` AMD shape also works.)
   - **Add SSH keys:** upload/generate a key so you can log in.
3. Create it and note the **public IP address**.

## Step 2 — Open ports 80 + 443 in Oracle's cloud firewall

This is separate from the OS firewall and **must** be done in the console:

1. Open your instance → **Virtual Cloud Network** → the attached subnet →
   **Security List**.
2. **Add Ingress Rules** (Stateless = No, Source `0.0.0.0/0`, IP Protocol TCP):
   - Destination port **80**
   - Destination port **443**

## Step 3 — Point a domain at the VM

Browsers need a real hostname for HTTPS (a bare IP can't get a trusted cert).
Free option — **DuckDNS**:

1. Go to <https://www.duckdns.org>, sign in, create a subdomain, e.g.
   `noze-mcu` → `noze-mcu.duckdns.org`.
2. Set its IP to your VM's **public IP** and save.

(Any domain/registrar works too — just create an `A` record → VM public IP.)

## Step 4 — Run the one-shot setup

SSH into the VM, then:

```bash
# get the code (clone your repo, or copy the tools/arduino-compile-server folder)
git clone https://github.com/jkandathil/nozeplot4.git
cd nozeplot4/tools/arduino-compile-server

# domain from step 3, and your app origin to lock CORS to (recommended)
sudo bash setup-oracle.sh noze-mcu.duckdns.org https://jkandathil.github.io
```

The script installs Docker, opens the OS firewall, builds the image
(installs AVR + ESP32 cores — first build takes a few minutes), and starts the
always-on service. When it finishes you'll see:

```
✓ Compile bridge is live at: https://noze-mcu.duckdns.org
```

Verify any time:

```bash
curl https://noze-mcu.duckdns.org/health   # → {"ok":true,...}
```

## Step 5 — Tell the app to use it

1. GitHub → your repo → **Settings → Secrets and variables → Actions →
   New repository secret**:
   - **Name:** `VITE_MCU_COMPILE_URL`
   - **Value:** `https://noze-mcu.duckdns.org`
2. Re-run **Actions → Deploy to GitHub Pages → Run workflow** (or push to `main`).

Done. Every visitor's app now compiles on your free, always-on VM and flashes
over Web Serial — no setup on their side, no cold starts, no cost.

---

## Operations

```bash
docker compose logs -f bridge caddy   # view logs
docker compose restart                # restart
docker compose pull && docker compose up -d --build   # update after code changes
docker compose down                   # stop
```

**Tuning** (optional, in `.env` then `docker compose up -d`):

| Var | Default | Meaning |
|---|---|---|
| `ALLOWED_ORIGIN` | `*` | Restrict CORS to your app origin |
| `RATE_LIMIT_MAX` | `30` | Compiles per minute per IP |
| `MAX_CONCURRENT` | `4` | Simultaneous compiles |
| `MAX_BODY_BYTES` | `4194304` | Max request size (4 MB) |

## Notes / caveats

- **Reclaim risk:** Oracle *may* reclaim idle Always Free instances. Keeping the
  service running (it is, 24/7) generally avoids this. Upgrading the account to
  "Pay As You Go" (still $0 within Always Free limits) removes the risk.
- **Certificate renewal** is automatic (Caddy).
- **Cores:** the image preinstalls `arduino:avr` and `esp32:esp32`. Add more in
  the `Dockerfile` (`arduino-cli core install …`) and rebuild.
