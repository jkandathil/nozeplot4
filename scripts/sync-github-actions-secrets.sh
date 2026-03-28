#!/usr/bin/env bash
# Upload Firebase VITE_* vars from .env.local to GitHub Actions secrets (same repo as cwd).
# Requires: gh CLI, `gh auth login`, and repo default remote pointing at this GitHub repo.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${1:-.env.local}"
if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing ${ENV_FILE}. Copy from .env.example and add your Firebase web config."
    exit 1
fi
if ! gh auth status &>/dev/null; then
    echo "Run: gh auth login -h github.com"
    exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
required=(VITE_FIREBASE_API_KEY VITE_FIREBASE_AUTH_DOMAIN VITE_FIREBASE_PROJECT_ID VITE_FIREBASE_APP_ID)
for name in "${required[@]}"; do
    val="${!name:-}"
    if [[ -z "$val" ]]; then
        echo "Missing ${name} in ${ENV_FILE}"
        exit 1
    fi
    printf '%s' "$val" | gh secret set "$name"
    echo "Set secret ${name}"
done
optional=(VITE_FIREBASE_STORAGE_BUCKET VITE_FIREBASE_MESSAGING_SENDER_ID VITE_AUTH_PUBLIC_URL)
for name in "${optional[@]}"; do
    val="${!name:-}"
    if [[ -n "$val" ]]; then
        printf '%s' "$val" | gh secret set "$name"
        echo "Set secret ${name}"
    fi
done
echo "Done. Push to main or re-run the Deploy workflow in Actions."
