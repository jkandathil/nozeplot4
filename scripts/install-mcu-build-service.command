#!/bin/bash
# Double-click on macOS to install the NozePlot MCU build service (runs in background).
# Chrome can reach http://localhost:8787 from the GitHub Pages app for Build & Flash.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PLIST="$HOME/Library/LaunchAgents/com.nozeplot.mcu-bridge.plist"
LOG_DIR="$HOME/Library/Logs/nozeplot"
mkdir -p "$LOG_DIR"

install_cli() {
  if command -v arduino-cli >/dev/null 2>&1; then return 0; fi
  echo "Installing arduino-cli…"
  if command -v brew >/dev/null 2>&1; then
    brew install arduino-cli
    return 0
  fi
  echo "Homebrew not found — installing arduino-cli directly…"
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR="$HOME/.local/bin" sh
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v arduino-cli >/dev/null 2>&1; then
    echo "Could not install arduino-cli. Install Homebrew from https://brew.sh and run this script again."
    read -r -p "Press Enter to close…"
    exit 1
  fi
}

install_cli
arduino-cli config init 2>/dev/null || true
arduino-cli core update-index
arduino-cli core install arduino:avr 2>/dev/null || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nozeplot.mcu-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$ROOT/tools/arduino-compile-server/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>8787</string>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/mcu-bridge.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/mcu-bridge.err</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.nozeplot.mcu-bridge" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/com.nozeplot.mcu-bridge"
launchctl kickstart -k "gui/$(id -u)/com.nozeplot.mcu-bridge"

sleep 2
if curl -sf "http://localhost:8787/health" >/dev/null; then
  echo ""
  echo "✓ MCU build service is running at http://localhost:8787"
  echo "  Open NozePlot MCU Flash and click Build & Flash."
else
  echo ""
  echo "Service installed but health check failed. See $LOG_DIR/mcu-bridge.err"
fi
echo ""
read -r -p "Press Enter to close…"
