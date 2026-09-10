#!/usr/bin/env bash
# Definition of Done for Review II (design spec section 1.2), checked end to
# end from a torn-down network. This is what a reviewer would run.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

pass=0
fail=0
result() {
  if [[ $1 -eq 0 ]]; then
    printf '  PASS  %s\n' "$2"; pass=$((pass + 1))
  else
    printf '  FAIL  %s\n' "$2"; fail=$((fail + 1))
  fi
}

echo "Tearing down first, so nothing passes on stale state."
./network/scripts/network-down.sh >/dev/null 2>&1

echo
echo "Running the full path (this takes a few minutes)..."
./network/scripts/full-demo.sh >/tmp/dod-full.log 2>&1
full_rc=$?

npm run demo --workspace @haazir/backend >/tmp/dod-demo.log 2>&1
demo_rc=$?

npm test >/tmp/dod-test.log 2>&1
test_rc=$?

echo
echo "Definition of Done — Review II"
echo "=============================================================="

grep -q 'All three organizations have joined' /tmp/dod-full.log
result $? "1. 3-org network starts from a single script"

result $([ "$(grep -c 'OK    \(registrar\|examcell\|audit\)' /tmp/dod-full.log)" -ge 3 ] && echo 0 || echo 1) \
  "2. Both contracts deployed, channel joined by all 3 orgs"

grep -q 'Demo complete' /tmp/dod-demo.log
result $? "3. Demo enrols an identity, creates a session, queries it back"

grep -q 'Correctly rejected. No single organization can write alone' /tmp/dod-full.log
result $? "4. Single-org write is REJECTED (the negative demonstration)"

{ [[ -f docs/threat-model.md ]] \
  && grep -qi 'BLE relay' docs/threat-model.md \
  && grep -qi 'coerced or cooperative liveness' docs/threat-model.md; }
result $? "5. Threat model includes BLE relay and coerced-liveness rows"

result $test_rc "6. All unit tests pass"

grep -q 'SEED_COMMITMENT_MISMATCH' /tmp/dod-demo.log
result $? "*  Commit-reveal: a wrong seed is rejected by name"

grep -q 'verification needs no trusted server' /tmp/dod-demo.log
result $? "*  Revealed seed reproduces every nonce from the ledger alone"

echo "=============================================================="
printf ' %d passed, %d failed   (full=%d demo=%d tests=%d)\n' \
  "$pass" "$fail" "$full_rc" "$demo_rc" "$test_rc"
echo " Logs: /tmp/dod-full.log /tmp/dod-demo.log /tmp/dod-test.log"

exit $((fail > 0 ? 1 : 0))
