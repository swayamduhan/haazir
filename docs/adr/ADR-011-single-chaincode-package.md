# ADR-011: One Chaincode Package, Several Contract Classes

**Status:** Accepted, implemented

## Context

`HANDOFF.md` §5 lays out four separate chaincode packages: `identity-registry`,
`session-manager`, `attendance-recorder`, `policy-engine`.

Four packages across three organizations means roughly twelve lifecycle
operations — install, approve, commit — for every code change.

## Decision

One deployable package containing multiple `Contract` classes.
`fabric-contract-api` accepts an array of them, each keeping its own
namespace, so operations address as `IdentityRegistry:registerIdentity`.

## Consequences

Logical separation, file organization, and the contract boundaries of
`HANDOFF.md` §7 are preserved exactly. What changes is deployment cost: three
lifecycle operations per change instead of twelve, over a build with many
iterations.

Contracts can also read each other's state directly — `SessionManager`
validates the faculty identity written by `IdentityRegistry` without a
cross-chaincode invocation.

The trade-off is that one package cannot carry differing endorsement policies
per contract. ADR-008 establishes that every in-scope operation wants the same
policy, and state-based endorsement offers finer granularity than package
splitting ever would, so nothing is lost.
