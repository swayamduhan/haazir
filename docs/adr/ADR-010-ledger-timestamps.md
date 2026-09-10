# ADR-010: Ledger Timestamps Are Authoritative

**Status:** Accepted, implemented
**Resolves:** defect C4

## Context

`HANDOFF.md` §7 passes `timestamp` into `markAttendance` as a parameter. A
client-supplied timestamp is a claim, not a fact: a student could backdate
attendance to a session they missed. Using the system clock inside chaincode
is equally wrong — peers execute at different instants and would disagree.

## Decision

Recorded times come from `ctx.stub.getTxTimestamp()`, which is part of the
transaction and identical on every peer. Client-supplied times are retained
separately and labelled as claims where they are genuinely caller-determined.

`Session` illustrates the distinction: `startTime` is caller-supplied because
it is the *scheduled* start and anchors the nonce window epoch, while
`createdAt` is the ledger timestamp of the creating transaction. Storing both
makes the gap between "when the class was scheduled" and "when the session was
actually opened" visible rather than conflated.

## Consequences

Backdating is impossible for any field that carries weight.

Constructing a date from an explicit millisecond value remains permitted — the
rule bans reading the clock, not formatting a known instant — and the lint
rule is written to allow exactly that case.
