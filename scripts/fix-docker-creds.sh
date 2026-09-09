#!/usr/bin/env bash
# Docker Desktop writes credsStore="desktop.exe" into the WSL docker config,
# but WSL cannot exec the Windows credential helper:
#   docker-credential-desktop.exe: exec format error
# Every pull then fails while install-fabric.sh still exits 0.
#
# Public images need no credentials, so the key is simply removed. The
# original is backed up alongside. Idempotent.
set -euo pipefail

CONFIG="$HOME/.docker/config.json"

if [ ! -f "$CONFIG" ]; then
  echo "No $CONFIG — nothing to do."
  exit 0
fi

if ! grep -q 'credsStore' "$CONFIG"; then
  echo "credsStore already absent from $CONFIG"
  exit 0
fi

cp "$CONFIG" "$CONFIG.bak"
jq 'del(.credsStore)' "$CONFIG.bak" > "$CONFIG"
echo "Removed credsStore from $CONFIG (backup at $CONFIG.bak)"
cat "$CONFIG"
