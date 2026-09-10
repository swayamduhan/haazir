# ADR-016: Nonces Are Recorded At Marking, Verified At Close

**Status:** Accepted, implemented
**Extends:** [ADR-007](ADR-007-commit-reveal-nonce.md)

## Context

ADR-007 established that only `SHA-256(seed)` is on chain during a live
session. That decision has an unavoidable consequence which ADR-007 named but
did not resolve: **`markAttendance` cannot check the nonce it is given.** The
seed is still on the faculty device. The contract has nothing to compare
against.

So a marking transaction can verify possession (signature), proximity
(geofence) and liveness (attestation hash), but freshness — the one proof that
stops a screenshotted QR code being forwarded to an absent student — is
unverified at the moment the record is written.

Three ways out were considered.

**Write each nonce on chain as it rotates.** Restores immediate verification
and destroys the throughput budget: one transaction every ten seconds per live
session, for no attendance data. Rejected in ADR-004.

**Leave verification to off-chain verifiers.** Publish the seed at close and
let anyone recompute. Simple, and it is what ADR-007 implies. But it puts the
check outside consensus: the ledger would contain records nobody has ever
checked, and "verified" would mean "whoever last looked said so". The whole
reason enrolment moved on chain (ADR-015) argues against this.

**Verify inside `closeSession`.** The seed becomes known in exactly the
transaction that reveals it. Every nonce claimed during the session can be
recomputed and checked there, by both endorsing organisations, atomically with
the reveal.

## Decision

`markAttendance` records the claim; `closeSession` adjudicates it.

- Marking stores `claimedWindow` and `claimedNonce` on the record, together
  with a check that the claimed window is the window the *ledger clock* is in,
  plus or minus one window for skew. Wrong-window claims are rejected
  immediately — that much is verifiable without the seed.
- `closeSession`, having verified the revealed seed against its commitment,
  iterates the session's device-marked records with
  `GetStateByPartialCompositeKey`, recomputes `HMAC-SHA256(seed, window)` for
  each claimed window, and writes one `NonceAudit` document recording every
  comparison and its verdict.
- The audit document is written in the same transaction as the reveal, so a
  session cannot be closed without its nonces being adjudicated.

Attendance records are never rewritten by the sweep. The verdict lives in the
audit document, keyed by session, alongside the seed that produced it.

## Consequences

**Freshness is checked by consensus, not by whoever asks.** Registrar and Exam
Cell independently recompute every nonce and must agree on every verdict for
the close to commit. The result is on the ledger, not in a report.

**Range queries, not rich queries.** The sweep uses a partial composite key.
Fabric records range queries in the read-write set as `RangeQueryInfo` and
revalidates them at commit, so a record inserted concurrently invalidates the
close rather than escaping the sweep. CouchDB rich queries carry no such
record and would have made the sweep silently incomplete — the same defect as
C6, in a new place.

**Verification is retrospective, and stated as such.** A forged nonce is
accepted at marking and exposed at close. This is the trade ADR-007 already
made; this decision limits how long it lasts and guarantees somebody looks.

**closeSession becomes O(n) in class size.** For n = 60 that is 60 state reads
and one write in a single transaction — some tens of milliseconds and a write
set of a few kilobytes. It is bounded by enrolment, not by time, and the bound
is a class roster. A 500-student session would want a paged sweep; that is not
this system.

**An expired session leaves its nonces unadjudicated, permanently.** No seed
is ever revealed, so no verdict can be reached. The records stay `pending` and
the session derives as `unverified` — which is the correct reading, and is why
`expireSession` exists.
