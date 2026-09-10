#!/usr/bin/env bash
# Runs the complete Review II path from a clean state.
#
# This is Definition of Done (spec section 1.2) executed end to end:
#   1. environment gate
#   2. 3-org network up, all three joined
#   3. chaincode built and deployed under AND(Registrar, ExamCell)
#   4. endorsement policy proven, including the negative case
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

step() {
  echo
  echo "##############################################################"
  echo "# $1"
  echo "##############################################################"
}

cd "$ROOT"

step "1/5  Environment"
./scripts/verify-env.sh

step "2/5  Network up (3 organizations)"
./network/scripts/network-up.sh

step "3/5  Channel membership"
./network/scripts/check-channel.sh

step "4/5  Build and deploy chaincode as a service"
./network/scripts/build-cc-package.sh
./network/scripts/deploy-ccaas.sh

step "5/5  Prove the endorsement policy"
./network/scripts/prove-endorsement-policy.sh

echo
echo "=============================================================="
echo " Review II path complete."
echo "=============================================================="
