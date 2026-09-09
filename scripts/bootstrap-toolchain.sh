#!/usr/bin/env bash
# Task 1 steps 4-5: install nvm + Node 20 and the Fabric 2.5.9 binaries/samples.
# Deliberately does NOT pull docker images — that needs Docker Desktop WSL
# integration enabled, and is done separately once the daemon is reachable.
# No sudo required: everything installs under $HOME.
set -euo pipefail

echo "==> [1/3] Installing nvm"
if [ ! -d "$HOME/.nvm" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
else
  echo "    nvm already present, skipping"
fi

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "==> [2/3] Installing Node 20 LTS"
nvm install 20
nvm alias default 20
echo "    node $(nvm exec 20 node --version 2>/dev/null | tail -1)"

echo "==> [3/3] Installing Fabric 2.5.9 binaries and samples"
cd "$HOME"
if [ ! -f install-fabric.sh ]; then
  curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
  chmod +x install-fabric.sh
fi
./install-fabric.sh --fabric-version 2.5.9 --ca-version 1.5.12 binary samples

# Make the toolchain available in future non-login shells.
BASHRC="$HOME/.bashrc"
add_line() { grep -qxF "$1" "$BASHRC" 2>/dev/null || echo "$1" >> "$BASHRC"; }
add_line 'export NVM_DIR="$HOME/.nvm"'
add_line '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
add_line 'export PATH=$HOME/fabric-samples/bin:$PATH'
add_line 'export FABRIC_CFG_PATH=$HOME/fabric-samples/config'

echo
echo "==> Toolchain bootstrap complete."
echo "    Remaining: docker images (needs Docker Desktop WSL integration)."
