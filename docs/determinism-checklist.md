# Chaincode Determinism Checklist

**Applies to:** `packages/chaincode` and `packages/shared`
**Enforced by:** `.eslintrc.determinism.js`

## Why this exists

Every endorsing peer executes a transaction independently and compares
results. If two peers compute different output, endorsement fails — not with
a clear error, but intermittently, under load, with no peer being obviously
wrong. Non-determinism is the characteristic failure mode of Fabric chaincode
and it is expensive to diagnose after the fact.

This checklist replaces Slither and Mythril, which appear in `HANDOFF.md` §4
but target the EVM and have no role in a Fabric system. A tool aimed at the
wrong platform is worse than no tool: it invites a reviewer to ask why it is
there.

## Prohibited

| Never | Because | Use instead |
|---|---|---|
| `Math.random()` | Different value per peer | Derive from `ctx.stub.getTxID()` |
| `Date.now()`, `new Date()` with no argument | Peers execute at different instants | `txTimestampMs(ctx)` |
| `fs`, `http`, `https`, `net` | Peers see different external state, and a network call makes endorsement depend on a third party | Pass data in as transaction arguments |
| Iteration over an unordered collection where order affects output | Insertion order can differ | Sort explicitly first |
| `JSON.stringify` on anything hashed or signed | Key order is insertion order, not canonical | `canonicalize()` from `@haazir/shared` |
| Floating-point where exact equality matters | Formatting is not portable across platforms | Integers — geofence coordinates are microdegrees for this reason |
| A client-supplied timestamp treated as authoritative | It is a claim, and permits backdating | `txTimestampIso(ctx)` |

## Permitted, despite appearances

`new Date(deterministicMillis)` — with an **explicit argument** — is fine. The
rule prohibits *reading* the clock, not formatting a known instant. This is
how `txTimestampIso` renders a ledger timestamp as ISO-8601, and the lint rule
is written to allow exactly this case:

```js
{ selector: "NewExpression[callee.name='Date'][arguments.length=0]" }
```

Zero arguments is banned; an explicit argument is not.

## Determinism the design relies on

Two places where this is load-bearing rather than hygienic:

**Identity ids** (`deriveIdentityId`). `HANDOFF.md` §6 specifies a UUID, but a
randomly generated one differs per peer and fails endorsement outright. Ids
are derived from the transaction id: unique, identical across peers, and not
predictable by the submitter — every property the UUID was chosen for.

**Canonical encoding** (`canonicalize`). Anything hashed or signed must
serialize identically everywhere, or signature verification fails between
mobile and chaincode while both look correct in isolation. Keys are sorted,
arrays keep their order, and non-integer numbers are rejected outright.

## Before merging chaincode changes

- [ ] `npm run lint` passes with the determinism rules applied
- [ ] No new `Date`, `Math`, `fs`, `http` usage in chaincode or shared
- [ ] Anything hashed or signed goes through `canonicalize()`
- [ ] New numeric on-chain fields are integers
- [ ] Existence checks use composite-key `getState`, never a rich query
      (rich-query results are not in the read set — see threat-model.md §3.2)
