#!/usr/bin/env bash
# Ubuntu's ~/.bashrc returns early for non-interactive shells, so nvm lines
# appended there never load under `bash -lc`. ~/.profile has no such guard,
# so the toolchain goes there instead. Idempotent.
set -euo pipefail

PROFILE="$HOME/.profile"
add_line() {
  grep -qxF "$1" "$PROFILE" 2>/dev/null || echo "$1" >> "$PROFILE"
}

add_line ''
add_line '# haazir toolchain'
add_line 'export NVM_DIR="$HOME/.nvm"'
add_line '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
add_line 'export PATH="$HOME/fabric-samples/bin:$PATH"'
add_line 'export FABRIC_CFG_PATH="$HOME/fabric-samples/config"'

echo "Updated $PROFILE"
