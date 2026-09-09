#!/usr/bin/env bash
# Usage: source network/scripts/set-org-env.sh <registrar|examcell|audit>
# Exports the peer CLI environment for the named organization.
#
# Infrastructure names (peer0.org1.example.com) are inherited from
# fabric-samples and appear only in container logs. The MSP ID is the
# identity that carries meaning: it is what appears in endorsement policies
# and authorization checks. The role-to-MSP mapping lives in
# network/fabric-config/msp-ids.env so the Phase A/B switch is one edit.

FABRIC_SAMPLES="${FABRIC_SAMPLES:-$HOME/fabric-samples}"
TEST_NETWORK="$FABRIC_SAMPLES/test-network"
ORG_PATH="$TEST_NETWORK/organizations/peerOrganizations"

_SOE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$_SOE_DIR/../fabric-config/msp-ids.env"

case "${1:-}" in
  registrar) _num=1; _msp="$REGISTRAR_MSP"; _port=7051  ;;
  examcell)  _num=2; _msp="$EXAMCELL_MSP";  _port=9051  ;;
  audit)     _num=3; _msp="$AUDIT_MSP";     _port=11051 ;;
  *) echo "Usage: source set-org-env.sh <registrar|examcell|audit>" >&2; return 1 ;;
esac

export PATH="$FABRIC_SAMPLES/bin:$PATH"
export FABRIC_CFG_PATH="$FABRIC_SAMPLES/config"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="$_msp"
export CORE_PEER_TLS_ROOTCERT_FILE="$ORG_PATH/org${_num}.example.com/peers/peer0.org${_num}.example.com/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="$ORG_PATH/org${_num}.example.com/users/Admin@org${_num}.example.com/msp"
export CORE_PEER_ADDRESS="localhost:${_port}"
export ORDERER_CA="$TEST_NETWORK/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem"

echo "Environment set for $1 ($_msp) at localhost:$_port"
