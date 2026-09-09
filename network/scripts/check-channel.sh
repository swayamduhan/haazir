#!/usr/bin/env bash
# Verifies every organization has independently joined the channel.
# This is Definition of Done item 2 (spec section 1.2).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHANNEL="${CHANNEL:-attendance-channel}"
fail=0

for org in registrar examcell audit; do
  # shellcheck disable=SC1091
  source "$HERE/set-org-env.sh" "$org" >/dev/null
  if peer channel list 2>/dev/null | grep -q "^${CHANNEL}$"; then
    printf '  OK    %-10s (%-13s) joined %s\n' "$org" "$CORE_PEER_LOCALMSPID" "$CHANNEL"
  else
    printf '  FAIL  %-10s (%-13s) has NOT joined %s\n' \
      "$org" "$CORE_PEER_LOCALMSPID" "$CHANNEL"
    fail=1
  fi
done

echo
if [[ $fail -eq 0 ]]; then
  echo "All three organizations have joined $CHANNEL."
else
  echo "Channel membership incomplete."
fi
exit $fail
