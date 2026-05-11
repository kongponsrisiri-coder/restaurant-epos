#!/bin/bash
# Launcher for SiamEPOS Pro — used by the Desktop SiamEPOS.app shortcut
# and macOS Login Items. Logs to ~/Library/Logs/siamepos.log so a silent
# failure can be diagnosed after the fact.

# AppleScript / Login Items run with a stripped PATH — add Homebrew +
# /usr/local so node and npm resolve regardless of how this is invoked.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

mkdir -p "$HOME/Library/Logs"
exec >> "$HOME/Library/Logs/siamepos.log" 2>&1
echo
echo "=== siamepos launcher $(date '+%Y-%m-%d %H:%M:%S') ==="

cd /Users/korakot/Desktop/restaurant-epos/electron || {
  echo "ERR: project directory not found"
  exit 1
}

# CLOUD_API_URL is no longer hard-coded here — electron/config.json (filled
# via the first-launch setup wizard) is now the source of truth. The env
# var still wins if exported by the calling shell for ad-hoc overrides.
exec npm start
