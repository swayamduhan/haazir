#!/usr/bin/env bash
# Tears the network down, including the third organization and the
# chaincode services.
#
# The CCaaS containers are started by deploy-ccaas.sh with a plain
# `docker run`, so they are not part of the compose project and
# `network.sh down` does not touch them. Left behind they keep the
# fabric_test network in use — which surfaces as "Resource is still in
# use" during teardown and as a stale chaincode answering on the next
# bring-up, which is the more expensive failure of the two.
set -uo pipefail

CC_NAME="${CC_NAME:-haazir}"
FABRIC_SAMPLES="${FABRIC_SAMPLES:-$HOME/fabric-samples}"

echo "==> Stopping chaincode services"
for org in registrar examcell audit; do
  svc="${CC_NAME}-cc-${org}"
  if docker ps -aq --filter "name=^${svc}$" | grep -q .; then
    docker rm -f "$svc" >/dev/null 2>&1 && printf '  removed %s\n' "$svc"
  fi
done

echo "==> Bringing the Fabric network down"
( cd "$FABRIC_SAMPLES/test-network" && ./network.sh down )

# Only now can the shared network be released, and only if nothing else
# joined it. A failure here is informational, not fatal.
if docker network inspect fabric_test >/dev/null 2>&1; then
  docker network rm fabric_test >/dev/null 2>&1 \
    && echo "==> Removed network fabric_test" \
    || echo "==> Network fabric_test still in use by another container; left in place"
fi

echo "==> Network down."
