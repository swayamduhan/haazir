#!/usr/bin/env bash
# Demonstrates that AND(Registrar, ExamCell) is actually enforced.
#
# This is the direct evidence for the project's central claim: no single
# organization can write the attendance record alone. The positive result
# shows the system works; the NEGATIVE result shows it cannot be bypassed,
# which is the part that matters. Spec section 4.3, DoD item 4.
#
# IMPORTANT — why this checks state rather than the invoke's exit code:
# Fabric evaluates the endorsement policy at VALIDATION time, when the block
# commits, not when the proposal is endorsed. `peer chaincode invoke` reports
# the proposal response, so it prints "successful" for a transaction that is
# subsequently marked invalid and never applied. Reading the ledger back is
# the only honest test, and it is also the more convincing demonstration:
# the record simply is not there.
set -uo pipefail

CHANNEL="${CHANNEL:-attendance-channel}"
CC_NAME="${CC_NAME:-haazir}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
source "$HERE/set-org-env.sh" registrar >/dev/null
REG_TLS="$CORE_PEER_TLS_ROOTCERT_FILE"
# shellcheck disable=SC1091
source "$HERE/set-org-env.sh" examcell >/dev/null
EXAM_TLS="$CORE_PEER_TLS_ROOTCERT_FILE"
# shellcheck disable=SC1091
source "$HERE/set-org-env.sh" registrar >/dev/null

hash_a=$(head -c 32 /dev/urandom | sha256sum | cut -d' ' -f1)
hash_b=$(head -c 32 /dev/urandom | sha256sum | cut -d' ' -f1)
pubkey=$(head -c 32 /dev/urandom | xxd -p -c 64)

rule() {
  echo
  echo "=============================================================="
  echo " $1"
  echo " Expected: $2"
  echo "=============================================================="
}

# Returns 0 if the identity exists in committed state.
identity_exists() {
  peer chaincode query -C "$CHANNEL" -n "$CC_NAME" \
    -c "{\"function\":\"IdentityRegistry:getIdentityStatus\",\"Args\":[\"$1\"]}" \
    >/dev/null 2>&1
}

invoke_id() {
  # Echoes the identityID from the proposal response payload.
  sed -n 's/.*payload:"\([^"]*\)".*/\1/p' <<<"$1"
}

# ---------------------------------------------------------------- negative
rule "NEGATIVE — write endorsed by Registrar ALONE" \
     "transaction invalidated; nothing written to the ledger"

out=$(peer chaincode invoke -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$ORDERER_CA" \
  -C "$CHANNEL" -n "$CC_NAME" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "$REG_TLS" \
  -c "{\"function\":\"IdentityRegistry:registerIdentity\",\"Args\":[\"$hash_a\",\"$pubkey\",\"student\"]}" 2>&1)

solo_id=$(invoke_id "$out")

# The proposal MUST have succeeded, or this test proves nothing. Without
# this guard a network that is simply down looks identical to a policy
# rejection, and the demo would claim a pass it has not earned.
if [[ -z "$solo_id" ]]; then
  echo
  echo ">>> INCONCLUSIVE: the proposal never reached the chaincode, so this"
  echo ">>> says nothing about the endorsement policy. Underlying error:"
  echo "$out" | sed 's/^/    /'
  exit 2
fi

echo "  proposal simulated an identity: $solo_id"
echo "  (the CLI reports the proposal, not the commit — so it looks fine here)"
sleep 3

if identity_exists "$solo_id"; then
  echo
  echo ">>> FAILURE: the single-org write IS present in the ledger."
  echo ">>> The endorsement policy is not being enforced."
  exit 1
fi

echo
echo "  Reading the ledger back: IDENTITY_NOT_FOUND."
echo "  Committer's reason code:"
docker logs peer0.org1.example.com 2>&1 \
  | grep -oE 'marked as invalid by committer. Reason code \[[A-Z_]+\]' \
  | tail -1 | sed 's/^/    /'
echo ">>> Correctly rejected. No single organization can write alone."

# ---------------------------------------------------------------- positive
rule "POSITIVE — write endorsed by Registrar AND ExamCell" \
     "transaction valid; record present in the ledger"

out=$(peer chaincode invoke -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$ORDERER_CA" \
  -C "$CHANNEL" -n "$CC_NAME" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "$REG_TLS" \
  --peerAddresses localhost:9051 --tlsRootCertFiles "$EXAM_TLS" \
  -c "{\"function\":\"IdentityRegistry:registerIdentity\",\"Args\":[\"$hash_b\",\"$pubkey\",\"student\"]}" 2>&1)

duo_id=$(invoke_id "$out")
echo "  identityID: ${duo_id:-<none>}"
sleep 3

if [[ -z "$duo_id" ]] || ! identity_exists "$duo_id"; then
  echo
  echo ">>> FAILURE: both organizations endorsed but the record is absent."
  echo "$out"
  exit 1
fi

echo "  Reading the ledger back:"
peer chaincode query -C "$CHANNEL" -n "$CC_NAME" \
  -c "{\"function\":\"IdentityRegistry:getIdentityStatus\",\"Args\":[\"$duo_id\"]}" 2>/dev/null \
  | sed 's/^/    /'
echo ">>> Accepted, as expected."

echo
echo "=============================================================="
echo " AND(Registrar, ExamCell) is enforced by consensus."
echo " One organization acting alone cannot alter the record."
echo "=============================================================="
