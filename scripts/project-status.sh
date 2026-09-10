#!/usr/bin/env bash
# Where the project currently stands.
set -uo pipefail
cd /home/swayam/haazir

echo "=== git ==="
echo "  branch:  $(git rev-parse --abbrev-ref HEAD)"
echo "  head:    $(git rev-parse --short HEAD)"
echo "  commits: $(git rev-list --count HEAD)"
echo "  remote:  $(git rev-parse --short origin/main 2>/dev/null || echo 'not fetched')"
echo "  dirty:   $(git status --porcelain | wc -l) file(s)"

echo
echo "=== contracts implemented ==="
grep -rho '@Transaction([^)]*)' -A2 packages/chaincode/src/contracts/*.ts 2>/dev/null \
  | grep -oE 'public async [a-zA-Z]+' | sed 's/public async /  /' | sort

echo
echo "=== network right now ==="
if docker info >/dev/null 2>&1; then
  n=$(docker ps -q | wc -l)
  echo "  docker: running, $n container(s)"
  docker ps --format '{{.Names}}' 2>/dev/null | sort | sed 's/^/    /'
else
  echo "  docker: NOT reachable (Docker Desktop not running)"
fi
