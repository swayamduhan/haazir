# ADR-008: `AND(Registrar, ExamCell)` Endorsement Policy

**Status:** Accepted, implemented, demonstrated

## Context

`HANDOFF.md` §11 answers insider tampering with "requires ≥2 orgs colluding."
No endorsement policy appears anywhere in that document.

This matters more than it sounds. Under a permissive `OR` policy, one
organization can write alone and the project's central claim is simply false —
while the system looks identical from the outside. The claim is only as good
as a specific, checked-in configuration.

## Decision

Chaincode is committed with:

```
AND('RegistrarMSP.peer','ExamCellMSP.peer')
```

Audit appears in no endorsement policy. It installs the chaincode and commits
every block, so it holds a complete, independently verifiable copy, but it
cannot authorise a write.

`HANDOFF.md` implied per-operation policies — `markAttendance` under a
permissive `OR` for throughput, everything else under `AND`. That requires
state-based endorsement applied per key. Since `AttendanceRecorder` is out of
scope for this milestone, **every in-scope operation wants `AND` anyway**, so
a single package-level policy delivers an identical guarantee for a fraction
of the effort.

## Consequences

**The claim is now testable, and tested.** `prove-endorsement-policy.sh`
submits the same operation endorsed by one organization and then by two. The
committer records `ENDORSEMENT_POLICY_FAILURE` for the first, and reading the
ledger back returns `IDENTITY_NOT_FOUND`.

**Enforcement is at validation, not proposal.** Fabric checks the policy when
the block commits, so `peer chaincode invoke` prints "successful" for a
transaction that is subsequently discarded. Any test must read the ledger
back. An early version of our own proof script was fooled by exactly this.

**Audit's read-only status is cryptographic, not administrative.** As a channel
member Audit can submit a proposal; what stops any effect is that nothing it
proposes can gather sufficient endorsement. Worth stating precisely, because a
reviewer may probe it.

**Deferred:** per-operation granularity via state-based endorsement, needed
when high-volume `markAttendance` arrives in Milestone 3, and to let Audit
invoke `expireSession` alone (see ADR-013 and threat-model.md §3.3).
