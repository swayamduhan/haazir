#!/usr/bin/env bash
# Deploys the haazir chaincode as a service (CCaaS) under
#   AND('RegistrarMSP.peer','ExamCellMSP.peer')
#
# Why CCaaS rather than the peer building an image: Fabric 2.5.9's
# peer-side Docker builder cannot drive Docker Desktop 29.x's build API
# (the daemon closes the socket mid-stream). CCaaS is supported first-class
# in Fabric 2.5, is what production deployments use, and removes the peer's
# dependence on a compatible Docker daemon entirely. See ADR-014.
#
# Each organization gets its OWN chaincode service and its OWN package id.
# That is deliberate: a single shared container would mean one party's
# process producing the endorsements of both endorsing organizations, which
# would hollow out the multi-org guarantee the project exists to provide.
# Package ids may legitimately differ per org; only the chaincode
# DEFINITION (name, version, sequence, policy) must agree.
set -euo pipefail

CC_NAME="${CC_NAME:-haazir}"
CC_VERSION="${CC_VERSION:-1.0}"
CC_SEQUENCE="${CC_SEQUENCE:-1}"
CC_IMAGE="${CC_IMAGE:-haazir-cc:latest}"
CC_PORT="${CC_PORT:-9999}"
CHANNEL="${CHANNEL:-attendance-channel}"
DOCKER_NET="${DOCKER_NET:-fabric_test}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$ROOT/build/ccaas"

# shellcheck disable=SC1091
. "$HERE/../fabric-config/msp-ids.env"
POLICY="AND('${REGISTRAR_MSP}.peer','${EXAMCELL_MSP}.peer')"

# Organizations that endorse. Audit is intentionally absent from the
# endorsement policy, but still runs a service so it can serve queries
# against the ledger it commits.
ENDORSERS=(registrar examcell)
ALL_ORGS=(registrar examcell audit)

rm -rf "$WORK"; mkdir -p "$WORK"
declare -A PKG_ID

echo "==> Packaging and installing per organization"
for org in "${ALL_ORGS[@]}"; do
  svc="${CC_NAME}-cc-${org}"
  dir="$WORK/$org"
  mkdir -p "$dir"

  # The address the peer will dial. Each org points at its own service.
  cat > "$dir/connection.json" <<EOF
{
  "address": "${svc}:${CC_PORT}",
  "dial_timeout": "10s",
  "tls_required": false
}
EOF
  tar -czf "$dir/code.tar.gz" -C "$dir" connection.json

  cat > "$dir/metadata.json" <<EOF
{"type":"ccaas","label":"${CC_NAME}_${CC_VERSION}"}
EOF
  tar -czf "$dir/${CC_NAME}.tar.gz" -C "$dir" metadata.json code.tar.gz

  # shellcheck disable=SC1091
  source "$HERE/set-org-env.sh" "$org" >/dev/null
  peer lifecycle chaincode install "$dir/${CC_NAME}.tar.gz" >/dev/null 2>&1 || true

  id=$(peer lifecycle chaincode queryinstalled --output json \
    | jq -r --arg label "${CC_NAME}_${CC_VERSION}" \
      '[.installed_chaincodes[] | select(.label==$label)] | last | .package_id')

  if [[ -z "$id" || "$id" == "null" ]]; then
    echo "  Could not determine package id for $org" >&2
    exit 1
  fi
  PKG_ID[$org]="$id"
  printf '  %-10s %s\n' "$org" "$id"
done

echo
echo "==> Starting one chaincode service per organization"
for org in "${ALL_ORGS[@]}"; do
  svc="${CC_NAME}-cc-${org}"
  docker rm -f "$svc" >/dev/null 2>&1 || true
  docker run -d \
    --name "$svc" \
    --network "$DOCKER_NET" \
    -e CHAINCODE_SERVER_ADDRESS="0.0.0.0:${CC_PORT}" \
    -e CHAINCODE_ID="${PKG_ID[$org]}" \
    -e CORE_CHAINCODE_ID_NAME="${PKG_ID[$org]}" \
    "$CC_IMAGE" >/dev/null
  printf '  %-10s %s listening on %s\n' "$org" "$svc" "$CC_PORT"
done

echo
echo "==> Waiting for services to accept connections"
for org in "${ALL_ORGS[@]}"; do
  svc="${CC_NAME}-cc-${org}"
  for _ in $(seq 1 30); do
    if docker logs "$svc" 2>&1 | grep -q 'Starting chaincode'; then break; fi
    if ! docker ps -q --filter "name=^${svc}$" | grep -q .; then
      echo "  $svc exited unexpectedly:" >&2
      docker logs "$svc" 2>&1 | tail -20 >&2
      exit 1
    fi
    sleep 1
  done
  printf '  %-10s up\n' "$org"
done

echo
echo "==> Approving (Audit deliberately does not approve)"
for org in "${ENDORSERS[@]}"; do
  # shellcheck disable=SC1091
  source "$HERE/set-org-env.sh" "$org" >/dev/null
  peer lifecycle chaincode approveformyorg \
    -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" --channelID "$CHANNEL" --name "$CC_NAME" \
    --version "$CC_VERSION" --package-id "${PKG_ID[$org]}" \
    --sequence "$CC_SEQUENCE" --signature-policy "$POLICY" 2>&1 | tail -1
  printf '  %-10s approved\n' "$org"
done

echo
echo "==> Commit readiness (Audit false is expected and correct)"
peer lifecycle chaincode checkcommitreadiness --channelID "$CHANNEL" \
  --name "$CC_NAME" --version "$CC_VERSION" --sequence "$CC_SEQUENCE" \
  --signature-policy "$POLICY" --output json

# shellcheck disable=SC1091
source "$HERE/set-org-env.sh" registrar >/dev/null
REG_TLS="$CORE_PEER_TLS_ROOTCERT_FILE"
# shellcheck disable=SC1091
source "$HERE/set-org-env.sh" examcell >/dev/null
EXAM_TLS="$CORE_PEER_TLS_ROOTCERT_FILE"

echo
echo "==> Committing"
peer lifecycle chaincode commit \
  -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "$ORDERER_CA" --channelID "$CHANNEL" --name "$CC_NAME" \
  --version "$CC_VERSION" --sequence "$CC_SEQUENCE" --signature-policy "$POLICY" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "$REG_TLS" \
  --peerAddresses localhost:9051 --tlsRootCertFiles "$EXAM_TLS" 2>&1 | tail -2

echo
echo "==> Deployed $CC_NAME v$CC_VERSION under policy: $POLICY"
