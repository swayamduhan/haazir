#!/usr/bin/env bash
# Usage: deploy-chaincode.sh <chaincode-path> <name> <version> [sequence]
#
# Installs on all three organizations, but takes approval only from
# Registrar and ExamCell, then commits under
#   AND('RegistrarMSP.peer','ExamCellMSP.peer')
#
# Audit installs the code (so it can validate and commit blocks) but is
# deliberately not part of the endorsement policy: it holds a complete copy
# without being able to authorise a write. Spec sections 3 and 4.3.
set -euo pipefail

CC_PATH="$1"; CC_NAME="$2"; CC_VERSION="$3"; CC_SEQUENCE="${4:-1}"
CHANNEL="${CHANNEL:-attendance-channel}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
. "$HERE/../fabric-config/msp-ids.env"
POLICY="AND('${REGISTRAR_MSP}.peer','${EXAMCELL_MSP}.peer')"

echo "==> Packaging $CC_NAME v$CC_VERSION (sequence $CC_SEQUENCE)"
# shellcheck disable=SC1091
source "$HERE/set-org-env.sh" registrar >/dev/null
peer lifecycle chaincode package "/tmp/${CC_NAME}.tar.gz" \
  --path "$CC_PATH" --lang node --label "${CC_NAME}_${CC_VERSION}"

for org in registrar examcell audit; do
  echo "==> Installing on $org"
  # shellcheck disable=SC1091
  source "$HERE/set-org-env.sh" "$org" >/dev/null
  peer lifecycle chaincode install "/tmp/${CC_NAME}.tar.gz" 2>&1 | tail -1
done

# shellcheck disable=SC1091
source "$HERE/set-org-env.sh" registrar >/dev/null
PACKAGE_ID=$(peer lifecycle chaincode queryinstalled --output json \
  | jq -r ".installed_chaincodes[] | select(.label==\"${CC_NAME}_${CC_VERSION}\") | .package_id")

if [[ -z "$PACKAGE_ID" || "$PACKAGE_ID" == "null" ]]; then
  echo "Could not determine package id for label ${CC_NAME}_${CC_VERSION}" >&2
  exit 1
fi
echo "==> Package ID: $PACKAGE_ID"

# Audit deliberately does NOT approve.
for org in registrar examcell; do
  echo "==> Approving for $org"
  # shellcheck disable=SC1091
  source "$HERE/set-org-env.sh" "$org" >/dev/null
  peer lifecycle chaincode approveformyorg \
    -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" --channelID "$CHANNEL" --name "$CC_NAME" \
    --version "$CC_VERSION" --package-id "$PACKAGE_ID" \
    --sequence "$CC_SEQUENCE" --signature-policy "$POLICY"
done

echo "==> Commit readiness (Audit false is expected and correct)"
peer lifecycle chaincode checkcommitreadiness --channelID "$CHANNEL" \
  --name "$CC_NAME" --version "$CC_VERSION" --sequence "$CC_SEQUENCE" \
  --signature-policy "$POLICY" --output json

# Collect each org's TLS cert for the multi-peer commit.
# shellcheck disable=SC1091
source "$HERE/set-org-env.sh" registrar >/dev/null
REG_TLS="$CORE_PEER_TLS_ROOTCERT_FILE"
# shellcheck disable=SC1091
source "$HERE/set-org-env.sh" examcell >/dev/null
EXAM_TLS="$CORE_PEER_TLS_ROOTCERT_FILE"

echo "==> Committing"
peer lifecycle chaincode commit \
  -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "$ORDERER_CA" --channelID "$CHANNEL" --name "$CC_NAME" \
  --version "$CC_VERSION" --sequence "$CC_SEQUENCE" --signature-policy "$POLICY" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "$REG_TLS" \
  --peerAddresses localhost:9051 --tlsRootCertFiles "$EXAM_TLS"

echo
echo "==> Deployed $CC_NAME v$CC_VERSION under policy: $POLICY"
