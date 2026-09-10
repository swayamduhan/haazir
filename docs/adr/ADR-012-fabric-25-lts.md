# ADR-012: Fabric 2.5 LTS Rather Than 3.x

**Status:** Accepted

## Context

Fabric 3.x ships BFT ordering, which would let this project claim Byzantine
rather than crash fault tolerance — genuinely attractive for a threat model
built around parties who may act dishonestly.

## Decision

Fabric 2.5.9 LTS with Raft ordering.

## Consequences

The documentation, `fabric-samples`, and virtually all available
troubleshooting material target 2.5. On a two-session timeline, being able to
find an answer quickly outweighs a stronger consensus claim.

BFT ordering moves to future work, where the report gets the intellectual
credit for identifying it without the schedule risk of adopting it.

This decision did not spare us every compatibility problem — see ADR-014,
where 2.5.9's peer-side Docker builder proved incompatible with a current
Docker Desktop.
