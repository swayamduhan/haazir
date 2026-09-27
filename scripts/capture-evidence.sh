#!/usr/bin/env bash
# Captures every piece of evidence the assignment asks for, as text.
#
# Screenshots prove a thing ran; text proves what it said. This writes both a
# numbered file per artefact under docs/evidence/ and a banner to the terminal,
# so the same run can be screenshotted and quoted.
#
# Assumes the network is already up and the chaincode deployed. Run
# ./network/scripts/network-up.sh and ./network/scripts/deploy-ccaas.sh first.
set -uo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$HOME/fabric-samples/bin:$PATH"
export FABRIC_CFG_PATH="${FABRIC_CFG_PATH:-$HOME/fabric-samples/config}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$ROOT/docs/evidence"
CHANNEL="${CHANNEL:-attendance-channel}"
CC_NAME="${CC_NAME:-haazir}"
cd "$ROOT"
mkdir -p "$OUT"

step=0
# Runs a command, echoes a banner, and tees the output to a numbered file.
capture() {
  local slug="$1"; shift
  step=$((step + 1))
  local file
  file="$(printf '%s/%02d-%s.txt' "$OUT" "$step" "$slug")"

  printf '\n%s\n' "$(printf '=%.0s' {1..72})"
  printf '  %02d. %s\n' "$step" "$slug"
  printf '%s\n' "$(printf '=%.0s' {1..72})"

  { printf '$ %s\n\n' "$*"; "$@" 2>&1; } | tee "$file"
}

# Build first, so the demo cannot run against a stale dist/ and report
# yesterday's behaviour as today's evidence.
echo "Building workspaces before capture..."
npm run build >/dev/null 2>&1 || { echo "build failed; run 'npm run build' to see why" >&2; exit 1; }

# --- 1. the toolchain -------------------------------------------------------
capture environment bash "$HERE/verify-env.sh"

# --- 2. the network exists -------------------------------------------------
capture containers docker ps \
  --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

capture channel-membership bash "$ROOT/network/scripts/check-channel.sh"

# --- 3. the chaincode and, crucially, its endorsement policy ---------------
# shellcheck disable=SC1091
source "$ROOT/network/scripts/set-org-env.sh" registrar >/dev/null 2>&1
capture committed-chaincode peer lifecycle chaincode querycommitted \
  --channelID "$CHANNEL" --name "$CC_NAME" --output json

capture installed-chaincode peer lifecycle chaincode queryinstalled --output json

# --- 4. block height, before and after the demo ---------------------------
capture ledger-height-before peer channel getinfo -c "$CHANNEL"

# --- 5. the test suite and the determinism gate ---------------------------
capture unit-tests npm test
capture determinism-lint npm run lint:determinism

# --- 6. the end-to-end demo, which is the working-status proof ------------
capture demo npm run demo --workspace @haazir/backend

capture ledger-height-after peer channel getinfo -c "$CHANNEL"

# --- 7. the endorsement policy, proven rather than asserted --------------
capture endorsement-policy bash "$ROOT/network/scripts/prove-endorsement-policy.sh"

# --- 8. the world state, read straight out of CouchDB -------------------
# Fabric names the state database <channel>_<chaincode>. Read it directly so
# the evidence does not depend on the chaincode being asked nicely.
couch_keys() {
  local db="${CHANNEL}_${CC_NAME}"
  local url="http://admin:adminpw@localhost:5984/${db}"
  echo "CouchDB state database: ${db}"
  echo
  curl -s "${url}" | jq '{db_name, doc_count, disk_size}' 2>/dev/null \
    || echo "(could not reach CouchDB on localhost:5984)"
  echo
  # A Fabric composite key is NUL objectType NUL attr NUL ... Translating the
  # NULs to a printable delimiter first keeps awk out of it: awk has no \u
  # escape and cannot be relied on to split on a NUL byte.
  echo "Keys currently in the world state, grouped by object type:"
  curl -s "${url}/_all_docs?limit=1000" \
    | jq -r '.rows[].id' 2>/dev/null \
    | tr '\000' '|' | sed 's/^|*//' | cut -d'|' -f1 \
    | sort | uniq -c | sort -rn \
    || echo "(could not list keys)"
}
capture world-state couch_keys

# --- 9. what the code actually is ---------------------------------------
code_inventory() {
  echo "Contracts:"
  for f in packages/chaincode/src/contracts/*.ts; do
    printf '  %-46s %4s lines\n' "$f" "$(grep -c '' "$f")"
  done
  echo
  echo "Shared library (used by chaincode, backend and the device signer):"
  for f in packages/shared/src/*.ts; do
    printf '  %-46s %4s lines\n' "$f" "$(grep -c '' "$f")"
  done
  echo
  echo "Transaction functions exposed on the ledger:"
  grep -h -A3 '@Transaction' packages/chaincode/src/contracts/*.ts \
    | grep -oE 'public async [a-zA-Z]+' | sed 's/public async /  /' | sort
  echo
  printf 'TypeScript source, total: %s lines\n' \
    "$(find packages backend -name '*.ts' -not -path '*/dist/*' -exec grep -c '' {} + \
       | awk -F: '{s+=$NF} END {print s}')"
  printf 'Test files: %s, assertions: %s\n' \
    "$(find packages backend -name '*.test.ts' | wc -l)" \
    "$(grep -rh -c 'expect(' packages/*/test backend/test 2>/dev/null \
       | awk '{s+=$1} END {print s}')"
}
capture code-inventory code_inventory

printf '\n%s\n' "$(printf '=%.0s' {1..72})"
printf '  Wrote %d files to %s\n' "$step" "$OUT"
printf '%s\n' "$(printf '=%.0s' {1..72})"
ls -1 "$OUT"
