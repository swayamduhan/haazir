# ADR-013: Organisation-Level Authorisation for `closeSession`

**Status:** Accepted with a named limitation
**Discovered:** during planning, not design

## Context

Spec §7.2 requires `closeSession` to verify that the caller is the faculty who
created the session, or holds the admin role. This is not implementable as
written.

`session.facultyID` is an on-chain identity id derived from a transaction id
(ADR-009). `ctx.clientIdentity.getID()` returns an X.509 distinguished name
from the caller's MSP. Nothing in the `HANDOFF.md` §6 data model connects the
two, and adding that binding is a real design decision affecting enrolment,
key rotation, and every future authorization check.

## Decision

For this milestone, `closeSession` and `expireSession` enforce the check that
genuinely exists — the caller's MSP must be `RegistrarMSP` or `ExamCellMSP` —
and record `closedBy` and `expiredBy` from the verified client identity for
audit. Per-faculty authorization is deferred with the identity-binding design.

## Consequences

**The Review II demonstration is unaffected.** The endorsement policy, not the
caller check, is what proves no single party can write (ADR-008).

**A faculty member could close another faculty member's session.** Both are
within endorsing organizations, so this is an intra-institutional integrity
gap rather than an outsider attack, and it is attributable after the fact
because `closedBy` records who did it.

**`expireSession` deliberately imposes no caller restriction at all** beyond
the grace-period check, so it needs no logic change when a narrower
per-function policy becomes available. See `docs/threat-model.md` §3.3 for why
Audit cannot yet invoke it alone.
