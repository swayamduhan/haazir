#!/usr/bin/env bash
# Starts PostgreSQL (personal data) and a private IPFS node (exemption evidence).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker compose -f "$HERE/../offchain/docker-compose.yml" up -d
echo "==> Waiting for the stores"
for _ in $(seq 1 60); do
  pg=$(docker inspect -f '{{.State.Health.Status}}' haazir-postgres 2>/dev/null || true)
  ipfs=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:5001/api/v0/id || true)
  [[ "$pg" == "healthy" && "$ipfs" == "200" ]] && break
  sleep 1
done
echo "  postgres: $pg   ipfs: HTTP $ipfs"
[[ "$pg" == "healthy" && "$ipfs" == "200" ]]
