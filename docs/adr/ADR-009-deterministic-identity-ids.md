# ADR-009: Identity Ids Derived From the Transaction Id

**Status:** Accepted, implemented
**Resolves:** defect C3

## Context

`HANDOFF.md` §6 specifies `identityID` as a UUID and §7 has `registerIdentity`
return one. This cannot work. Every endorsing peer executes the transaction
independently and must produce byte-identical output; a randomly generated
UUID differs per peer, so endorsement fails outright.

## Decision

The id is derived from the transaction id:

    identityID = format_as_uuid(SHA-256("identity|" + ctx.stub.getTxID()))

## Consequences

Deterministic across peers, unique per transaction, and not predictable by the
submitter — every property the UUID was chosen for. The UUID *shape* is kept,
so the data model and downstream consumers are unaffected.

The same reasoning applies to `deriveEventId` for revocation events, and will
apply to `recordID` when `AttendanceRecorder` is built.

This is the clearest example of why the determinism checklist exists: the
original specification looked entirely reasonable, and would have failed at
endorsement with a confusing, intermittent error.
