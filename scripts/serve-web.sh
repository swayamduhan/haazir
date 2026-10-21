#!/usr/bin/env bash
# Runs the REST API and the web clients together, for a demo or development.
# Both stop when this script stops. Requires the network to be up:
#   ./network/scripts/full-demo.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."
npm run build --workspace @haazir/shared >/dev/null
npm run build --workspace @haazir/backend >/dev/null
PORT=3000 node backend/dist/server.js > /tmp/haazir-api.log 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT
echo "API log: /tmp/haazir-api.log"
cd web && npm run dev -- --host --strictPort
