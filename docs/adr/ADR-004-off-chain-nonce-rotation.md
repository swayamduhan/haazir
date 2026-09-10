# ADR-004: Nonce Rotation Computed, Never Written Per Tick

**Status:** Accepted (retained from `HANDOFF.md` §2)

## Context

Defeating screenshot-sharing needs a nonce that changes every ~10 seconds. The
obvious implementation writes each new nonce to the ledger.

## Decision

Nonces are derived, not stored: `nonce(w) = HMAC-SHA256(seed, w)`, computed
locally by the faculty device with no ledger interaction.

## Consequences

A 60-student, one-hour session costs two transactions instead of roughly 360.
Chain throughput becomes irrelevant to session length.

It creates the verification problem that ADR-007 exists to solve: if nobody on
chain holds the seed, nobody on chain can check the nonce. Commit-reveal
resolves that without reintroducing per-tick writes.
