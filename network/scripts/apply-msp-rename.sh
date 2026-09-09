#!/usr/bin/env bash
# Phase B (spec section 4.2): rename MSP IDs to the roles they represent.
#
#   Org1MSP -> RegistrarMSP
#   Org2MSP -> ExamCellMSP
#   Org3MSP -> AuditMSP
#
# The MSP ID is what appears in the endorsement policy
# AND('RegistrarMSP.peer','ExamCellMSP.peer'), in enrolledBy, and in every
# authorization decision — that is, everywhere the trust model is actually
# expressed. Container and domain names stay as fabric-samples ships them;
# they appear only in logs.
#
# Patching is scripted rather than hand-edited because fabric-samples lives
# outside this repository. A clean clone plus this script reproduces the
# network exactly, which Definition of Done item 1 requires.
#
# Idempotent: safe to re-run. Only source files are touched; generated
# artifacts under channel-artifacts/ and organizations/ are rebuilt by
# network-up.sh and are deliberately excluded.
set -euo pipefail

FABRIC_SAMPLES="${FABRIC_SAMPLES:-$HOME/fabric-samples}"
TEST_NETWORK="$FABRIC_SAMPLES/test-network"

if [[ ! -d "$TEST_NETWORK" ]]; then
  echo "fabric-samples not found at $FABRIC_SAMPLES" >&2
  exit 1
fi

# Source files only. Generated artifacts are excluded on purpose: they are
# rebuilt from these during network bring-up, and patching them would mask
# a missed source file.
FILES=(
  "configtx/configtx.yaml"
  "addOrg3/configtx.yaml"
  "compose/compose-test-net.yaml"
  "addOrg3/compose/compose-org3.yaml"
  "addOrg3/addOrg3.sh"
  "scripts/envVar.sh"
  "scripts/deployCC.sh"
  "scripts/deployCCAAS.sh"
  "scripts/org3-scripts/updateChannelConfig.sh"
  "setOrgEnv.sh"
)

echo "==> Applying MSP rename in $TEST_NETWORK"

patched=0
skipped=0
for rel in "${FILES[@]}"; do
  path="$TEST_NETWORK/$rel"
  if [[ ! -f "$path" ]]; then
    printf '  WARN  %-45s not found, skipping\n' "$rel"
    continue
  fi

  if ! grep -q 'Org[123]MSP' "$path"; then
    printf '  --    %-45s already renamed\n' "$rel"
    skipped=$((skipped + 1))
    continue
  fi

  # Keep a pristine copy the first time only, so re-running never clobbers it.
  [[ -f "$path.orig" ]] || cp "$path" "$path.orig"

  sed -i \
    -e 's/Org1MSP/RegistrarMSP/g' \
    -e 's/Org2MSP/ExamCellMSP/g' \
    -e 's/Org3MSP/AuditMSP/g' \
    "$path"

  printf '  OK    %-45s patched\n' "$rel"
  patched=$((patched + 1))
done

echo
echo "==> Patched $patched file(s), $skipped already done."

# Fail loudly if a source file still carries an old identifier: a partial
# rename produces an MSP mismatch at channel join, which is far harder to
# diagnose than a failure here.
echo "==> Checking for missed source references"
missed=$(grep -rl 'Org[123]MSP' "$TEST_NETWORK" \
  --include='*.yaml' --include='*.sh' \
  --exclude-dir=channel-artifacts \
  --exclude-dir=organizations \
  --exclude='*.orig' 2>/dev/null \
  | grep -v -E 'bft|podman' || true)
# bft* and podman* are alternative deployment variants this project does not
# use: spec 2.4 keeps Fabric 2.5 LTS with Raft ordering, not BFT.

if [[ -n "$missed" ]]; then
  echo "  Remaining references in source files:" >&2
  echo "$missed" | sed 's/^/    /' >&2
  exit 1
fi
echo "  None."

# Point the repo's own mapping at the new identifiers.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cat > "$HERE/../fabric-config/msp-ids.env" <<'EOF'
# MSP ID per organization role.
#
# Phase B (spec 4.2): identifiers renamed to the roles they represent, so
# the endorsement policy reads AND('RegistrarMSP.peer','ExamCellMSP.peer').
# Revert to Org1MSP/Org2MSP/Org3MSP to fall back to Phase A.
#
# Applied to fabric-samples by network/scripts/apply-msp-rename.sh.

REGISTRAR_MSP=RegistrarMSP
EXAMCELL_MSP=ExamCellMSP
AUDIT_MSP=AuditMSP
EOF

echo "==> Updated network/fabric-config/msp-ids.env"
echo "==> Rename complete. The network must be rebuilt: MSP IDs are in the genesis block."
