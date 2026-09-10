# ADR-007: Commit-Reveal Nonce Seed

**Status:** Accepted, implemented
**Supersedes:** the nonce validation described in `HANDOFF.md` §9.3

## Context

Attendance must prove freshness: a QR code screenshotted and forwarded to an
absent student has to stop working within seconds. Rotating the nonce every
ten seconds achieves that, but a nonce must be *checked* by someone.

`HANDOFF.md` §9.3 reasoned that because the chaincode never holds the seed,
the faculty backend must validate nonces server-side and forward only
pre-approved submissions. That places one of the system's four claimed proofs
in the hands of a single server. A compromised faculty backend could mint
attendance for any student, and consensus would faithfully preserve the
forgery — the exact failure the multi-organization design exists to prevent
(`HANDOFF.md` §2).

Writing a fresh nonce on chain every ten seconds would solve it and destroy
the throughput budget that motivated off-chain rotation in the first place.

## Decision

Commit-reveal.

- **Commit.** At `createSession` the faculty submits only `SHA-256(seed)`.
  The seed stays on the device.
- **Derive.** Nonces are computed locally:
  `nonce(w) = HMAC-SHA256(seed, w)` where `w = floor((t - startTime) / 10s)`.
  No ledger interaction.
- **Reveal.** At `closeSession` the seed itself is submitted. The chaincode
  verifies `SHA-256(seed)` equals the committed hash and stores the seed.

The epoch is the session start, not the Unix epoch — stated explicitly,
because an unstated epoch produces intermittent mismatches between the
faculty device and any verifier.

## Consequences

**Freshness becomes verifiable by consensus.** The faculty is cryptographically
bound to a seed chosen before any submission was seen and cannot substitute
another afterwards.

**Anyone can verify, using only the ledger.** Once revealed, any third party
recomputes every window's nonce and checks it against any record — no
institutional server, no trusted API. This is what makes `HANDOFF.md` §9.6
true, which under the original scheme it was not.

**Throughput is unchanged.** One write at open, one at close, none between.

**Verification is retrospective.** During a live session the chaincode still
cannot check nonces, because the seed is not yet public. This is a deliberate
trade: attendance is not real-time-safety-critical, and a forgery guaranteed
to be detectable after close is a fundamentally different risk from one that
is never detectable.

**A new failure mode: the unrevealed seed.** A faculty member who never closes
a session leaves its records unverifiable. Handled by `expireSession` plus a
verification state derived at read time, so an unswept session never reads as
healthy. The scheme converts a silent forgery risk into a loud, attributable
one — the correct direction.
