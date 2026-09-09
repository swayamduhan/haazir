#!/usr/bin/env bash
# Tears the network down, including the third organization's containers.
set -euo pipefail

FABRIC_SAMPLES="${FABRIC_SAMPLES:-$HOME/fabric-samples}"
( cd "$FABRIC_SAMPLES/test-network" && ./network.sh down )
echo "==> Network down."
