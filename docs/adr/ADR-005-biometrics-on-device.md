# ADR-005: Biometrics Never Leave the Device

**Status:** Accepted (retained from `HANDOFF.md` §2)

## Context

Liveness detection needs a face embedding to compare against. Sending
biometric templates to a server creates a permanent, unrevocable privacy
liability — a leaked face template cannot be reissued like a password.

## Decision

Face embeddings are captured, stored, and compared entirely in device secure
storage. Only a boolean match result, hashed and bound to the specific session
and nonce window, crosses the network.

## Consequences

No biometric data exists server-side to leak, subpoena, or breach. The
attestation hash binds `(matchResult, challengeType, sessionNonceWindow)`, so
a recorded pass cannot be replayed against a different session.

Losing a device means re-enrolling in person, which is the correct trade.

This decision constrains implementation: ML Kit Face Detection produces no
embeddings at all, so an on-device TFLite model is required. See defect C5 in
the design spec.
