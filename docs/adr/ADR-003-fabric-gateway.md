# ADR-003: `@hyperledger/fabric-gateway`, Not the Legacy SDK

**Status:** Accepted (retained from `HANDOFF.md` §2)

## Context

`fabric-network` and `fabric-sdk-node` remain widely referenced in tutorials
but are legacy. `@hyperledger/fabric-gateway` is the current client API.

## Decision

`@hyperledger/fabric-gateway` throughout.

## Consequences

Current API, active maintenance, and a cleaner submit/evaluate split.

Its `submit` waits for commit status, which matters here: a transaction
endorsed by only one organization commits as *invalid* rather than failing
outright, and an API that does not wait makes that easy to miss.

Most search results describe the older API, so examples need translating.
