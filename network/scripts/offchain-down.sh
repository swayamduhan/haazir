#!/usr/bin/env bash
# Stops the off-chain stores. Pass --wipe to delete their volumes as well.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == "--wipe" ]]; then
  docker compose -f "$HERE/../offchain/docker-compose.yml" down -v
else
  docker compose -f "$HERE/../offchain/docker-compose.yml" down
fi
