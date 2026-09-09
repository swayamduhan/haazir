#!/usr/bin/env bash
# Brings up the 3-org attendance network. Idempotent: tears down first.
#
# Phase A per spec section 4.2 — stock fabric-samples tooling, so there is a
# known-good fallback before any customisation is attempted.
set -euo pipefail

FABRIC_SAMPLES="${FABRIC_SAMPLES:-$HOME/fabric-samples}"
CHANNEL="${CHANNEL:-attendance-channel}"
TEST_NETWORK="$FABRIC_SAMPLES/test-network"

if [[ ! -d "$TEST_NETWORK" ]]; then
  echo "fabric-samples not found at $FABRIC_SAMPLES — run scripts/verify-env.sh" >&2
  exit 1
fi

echo "==> Tearing down any existing network"
( cd "$TEST_NETWORK" && ./network.sh down )

echo "==> Starting 2-org network with CouchDB on channel $CHANNEL"
( cd "$TEST_NETWORK" && ./network.sh up createChannel -c "$CHANNEL" -ca -s couchdb )

echo "==> Adding third organization (Audit)"
( cd "$TEST_NETWORK/addOrg3" && ./addOrg3.sh up -c "$CHANNEL" -ca -s couchdb )

echo "==> Network up. Containers:"
docker ps --format '  {{.Names}}'
