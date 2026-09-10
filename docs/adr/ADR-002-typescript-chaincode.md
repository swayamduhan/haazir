# ADR-002: TypeScript Chaincode

**Status:** Accepted (retained from `HANDOFF.md` §2)

## Context

Go is the more common Fabric chaincode language and has the richest examples.
This project also has a Node backend and a React Native app.

## Decision

TypeScript, via `fabric-contract-api` and `fabric-shim`.

## Consequences

One language across chaincode, backend, and mobile, which makes the shared
canonical-encoding module genuinely shareable — the same implementation runs
in the contract and on the device, so signed payloads cannot diverge.

The cost is fewer worked examples than Go, and the determinism rules must be
enforced by lint rather than inherited from a stricter language. See
`docs/determinism-checklist.md`.
