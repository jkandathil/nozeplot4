#!/usr/bin/env bash
# One-shot setup for the MCU compile bridge on an Oracle Cloud Always Free
# Ubuntu VM. Installs Docker, opens ports 80/443, and starts the always-on
# HTTPS compile service. Run from this directory:
#
#   sudo bash setup-oracle.sh yourname.duckdns.org [https://your.app.origin]
#
# Arg 1 (required): the domain pointing at this VM's public IP.
# Arg 2 (optional): app origin to lock CORS to (default "*").
set -euo pipefail

DOMAIN="${1:-}"
ALLOWED_ORIGIN="${2:-*}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo bash setup-oracle.sh <domain> [allowed-origin]" >&2
  echo "Example: sudo bash setup-oracle.sh noze-mcu.duckdns.org https://jkandathil.github.io" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Installing Docker (if needed)…"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "==> Opening firewall ports 80 and 443…"
# Oracle Ubuntu images ship a default-deny iptables ruleset; insert ACCEPTs
# ahead of the catch-all REJECT, then persist.
for PORT in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 6 -m state --state NEW -p tcp --dport "$PORT" -j ACCEPT || \
      iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT
  fi
done
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save || true
else
  DEBIAN_FRONTEND=noninteractive apt-get update -y && \
  DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent || true
  netfilter-persistent save 2>/dev/null || true
fi

echo "==> Writing .env…"
cat > .env <<EOF
DOMAIN=$DOMAIN
ALLOWED_ORIGIN=$ALLOWED_ORIGIN
EOF

echo "==> Building and starting the compile bridge (this first build takes a few minutes)…"
docker compose up -d --build

echo ""
echo "Waiting for HTTPS certificate + health check…"
for i in $(seq 1 30); do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
    echo ""
    echo "✓ Compile bridge is live at: https://$DOMAIN"
    echo ""
    echo "Next: add a GitHub repo secret VITE_MCU_COMPILE_URL = https://$DOMAIN"
    echo "      then re-run the 'Deploy to GitHub Pages' workflow."
    exit 0
  fi
  sleep 5
done

echo ""
echo "Service started, but https://$DOMAIN/health did not respond yet."
echo "Check: (1) the domain points to this VM's public IP,"
echo "       (2) Oracle Security List allows ingress on 80 and 443,"
echo "       (3) logs: docker compose logs -f caddy bridge"
