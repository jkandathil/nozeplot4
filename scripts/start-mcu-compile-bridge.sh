#!/usr/bin/env bash
# One-time setup + start the MCU compile bridge used by NozePlot MCU Flash.
# Keeps running in this terminal; the web app auto-detects http://localhost:8787.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"

if ! command -v arduino-cli >/dev/null 2>&1; then
    echo "arduino-cli not found."
    if command -v brew >/dev/null 2>&1; then
        echo "Installing via Homebrew…"
        brew install arduino-cli
    else
        echo "Install arduino-cli first: https://arduino.github.io/arduino-cli/"
        exit 1
    fi
fi

arduino-cli config init 2>/dev/null || true
arduino-cli core update-index

echo "Installing board cores (AVR + ESP32) if missing…"
arduino-cli core install arduino:avr 2>/dev/null || true
if ! arduino-cli core list 2>/dev/null | grep -q 'esp32:esp32'; then
    arduino-cli config add board_manager.additional_urls \
        https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json 2>/dev/null || true
    arduino-cli core update-index
    arduino-cli core install esp32:esp32 2>/dev/null || true
fi

echo ""
echo "MCU compile bridge → http://localhost:${PORT}"
echo "Leave this terminal open. In NozePlot MCU Flash, click Build & Flash."
echo ""

exec node "$ROOT/tools/arduino-compile-server/server.mjs"
