#!/usr/bin/env bash
# Verifies the WSL toolchain is ready for Fabric work. Exits non-zero on any failure.
# Run this before any network task; a half-configured environment fails later
# in ways that look like Fabric bugs.
set -uo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$HOME/fabric-samples/bin:$PATH"
export FABRIC_CFG_PATH="${FABRIC_CFG_PATH:-$HOME/fabric-samples/config}"

fail=0

check() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    printf '  OK    %-22s %s\n' "$label" "$actual"
  else
    printf '  FAIL  %-22s got "%s", want "%s"\n' "$label" "$actual" "$expected"
    fail=1
  fi
}

echo "Environment check:"
check "node"        "$(node --version 2>/dev/null)"          "v20."
# `peer version` prints "peer:" on line 1 and " Version: 2.5.9" on line 2.
check "peer"        "$(peer version 2>/dev/null | grep -m1 -i 'version:')" "2.5"
check "docker"      "$(docker --version 2>/dev/null)"        "Docker version"
check "configtxgen" "$(command -v configtxgen)"              "configtxgen"
check "jq"          "$(jq --version 2>/dev/null)"            "jq-"

if [[ "$PWD" == /mnt/* ]]; then
  echo "  FAIL  filesystem            repo is on /mnt (drvfs); must be in the Linux filesystem"
  echo "                              Fabric bind-mounts TLS material needing 0600, which"
  echo "                              drvfs cannot represent. See spec section 12."
  fail=1
else
  printf '  OK    %-22s %s\n' "filesystem" "$PWD"
fi

if docker info >/dev/null 2>&1; then
  printf '  OK    %-22s reachable\n' "docker daemon"
else
  echo "  FAIL  docker daemon         not reachable"
  echo "                              Docker Desktop > Settings > Resources >"
  echo "                              WSL Integration > enable Ubuntu > Apply & Restart"
  fail=1
fi

if docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -q 'hyperledger/fabric-peer:2.5'; then
  printf '  OK    %-22s hyperledger/fabric-peer:2.5 present\n' "fabric images"
else
  echo "  FAIL  fabric images         run: ~/install-fabric.sh --fabric-version 2.5.9 docker"
  fail=1
fi

echo
if [[ $fail -eq 0 ]]; then
  echo "Environment ready."
else
  echo "Environment NOT ready."
fi
exit $fail
