# Haazir — Blockchain Student Attendance Ledger
## Design Spec: Review II Scope (Milestones 1 & 2)

**Date:** 2026-09-09
**Status:** Approved for implementation
**Source document:** `HANDOFF.md` (full-system handoff, all milestones)
**This spec covers:** Milestones 1 and 2 only. Milestone 3 and beyond are recorded in §13 as deferred, with enough detail that the in-scope work does not paint them into a corner.

---

## 1. Purpose and Scope

### 1.1 What this spec is for

`HANDOFF.md` describes the complete system across three milestones. This spec narrows that to exactly what must exist for the Review II demonstration, resolves six defects found in the handoff during design review, and specifies behaviour precisely enough to implement without further design decisions.

The build has a hard constraint of **two working sessions**. Scope discipline is therefore part of the design, not a compromise on it. Everything cut is recorded in §13 rather than forgotten.

### 1.2 Definition of Done

Taken directly from `HANDOFF.md` §16. The work is complete when all of the following hold:

1. A 3-organization Hyperledger Fabric network starts from a clean clone via a single script.
2. Both in-scope contracts are deployed, on a channel joined by all three organizations.
3. A demo (CLI) enrols an identity, creates a session, closes it, and queries both back.
4. The demo additionally proves the endorsement policy by showing a single-organization submission being **rejected**.
5. `docs/threat-model.md` exists as a living document and includes the BLE-relay and coerced-liveness rows.
6. Both contracts have unit tests that pass.

Item 4 is an addition to the handoff's checklist. It is the single most direct evidence for the project's central claim — that no one organization can write the record alone — and it costs almost nothing to demonstrate.

### 1.3 In scope

| Component | Extent |
|---|---|
| Fabric network | 3 orgs (Registrar, ExamCell, Audit), 1 channel, Raft ordering, CouchDB state DB |
| Chaincode | One deployable package, two contract classes: `IdentityRegistry`, `SessionManager` |
| Endorsement policy | Package-level `AND(Registrar, ExamCell)`, demonstrably enforced |
| Nonce scheme | Commit-reveal seed lifecycle (commit at session create, reveal at session close) |
| Shared library | Canonical encoding, hashing, and nonce derivation, used by every consumer |
| Backend | `fabric-gateway` connection module; CLI demo driver |
| Docs | Threat model, ADRs for each fixed decision, determinism checklist |

### 1.4 Out of scope for Review II

`AttendanceRecorder`, `PolicyEngine`, the React Native mobile app, on-device liveness detection, BLE and geofence proximity, PostgreSQL, IPFS, the public verifier web app, Caliper and JMeter benchmarking, and per-key state-based endorsement.

Express HTTP routes are **stretch scope**: built only if session 2 has room. The `fabric-gateway` module underneath is in scope regardless, so the CLI demo is the guaranteed deliverable and HTTP routes are a thin wrapper added later at no rework cost.

---

## 2. Corrections to the Handoff

Six defects were identified in `HANDOFF.md` during design review. Four affect in-scope work and are resolved by this spec. Two affect deferred work and are recorded so they are not rediscovered later. Each gets an ADR under `docs/adr/`.

### 2.1 In scope — resolved here

**C1 — The nonce validation scheme reintroduced a single trusted party.**
`HANDOFF.md` §9.3 concluded that because the chaincode never holds the nonce seed, the faculty backend must validate nonces server-side and forward pre-approved submissions. This makes freshness — one of the system's four claimed proofs — an assertion by one server. A compromised faculty backend could mint attendance for any student, and consensus would faithfully preserve the forgery. This contradicts `HANDOFF.md` §2, which exists to eliminate exactly this kind of single-party trust.

Resolved by the commit-reveal scheme in §5. Freshness becomes verifiable by consensus and by any third party, with no per-tick transactions and therefore no change to the throughput budget that motivated the original design.

**C2 — Multi-organization consensus was asserted but never specified.**
`HANDOFF.md` §11 answers insider tampering with "requires ≥2 orgs colluding," but no endorsement policy appears anywhere in the document. Under a permissive policy, one organization can write alone and the claim is false. Resolved by §4.3, which makes the policy an explicit, checked-in, demonstrable artifact.

**C3 — Identity IDs cannot be randomly generated inside chaincode.**
`HANDOFF.md` §6 specifies `identityID` as a UUID and §7 has `registerIdentity` returning one. Chaincode must be deterministic: every endorsing peer executes the same transaction independently and must produce byte-identical results. A randomly generated UUID differs per peer, so endorsement fails. Resolved in §6.1 by deriving the ID deterministically from the transaction ID.

**C4 — Record timestamps must come from the ledger, not the client.**
`HANDOFF.md` §7 passes `timestamp` into `markAttendance` as a parameter. A client-supplied timestamp is a claim, not a fact, and allows backdating. The same issue applies to session times. Resolved in §6.3: `ctx.stub.getTxTimestamp()` is authoritative wherever a recorded time carries weight; client-supplied times are retained separately and labelled as claims.

### 2.2 Deferred — recorded for Milestone 3

**C5 — ML Kit cannot produce the face embeddings that §10.4 requires.**
`HANDOFF.md` §4 and §10 specify Google ML Kit Face Detection, then §10 step 4 requires comparing a fresh face embedding against an enrolled one. ML Kit Face Detection returns bounding boxes, landmarks, contours, eye-open probabilities, and head Euler angles. It produces no embeddings, and ML Kit ships no face-recognition API at all. Steps 1–3 and 5 are achievable as written; step 4 has no implementation behind it.

The chosen resolution is to add an on-device MobileFaceNet TFLite model for embeddings, keeping biometric data on the device as `HANDOFF.md` §2 requires. The alternative — dropping identity matching and keeping only blink/head-turn liveness — was rejected because it downgrades the "lent device" row of the threat model from *defeated* to *partial*, which removes the project's principal anti-proxy claim.

**C6 — The duplicate-submission check as described is unsafe under concurrency.**
`HANDOFF.md` §7 requires `markAttendance` to reject a second record for the same `(sessionID, studentID)`. If implemented as a CouchDB rich query, this is incorrect: Fabric does not include rich-query results in a transaction's read set, so they are not revalidated at commit time, and two concurrent submissions can both endorse and both commit. The fix is a composite key with a plain state read, which *is* in the read set and therefore protected by MVCC. Recorded now because the load testing in `HANDOFF.md` §14 is precisely the condition that would expose it.

### 2.3 Additional handoff amendments

- **Remove Slither and Mythril from the stack.** Both are EVM/Solidity tools with no role in a pure Fabric system. They are replaced by the determinism checklist in §10.3, which targets the failure mode this project actually has.
- **`nonceWindowUsed` must have an explicitly pinned epoch.** Windows are counted from `session.startTime`, not from the Unix epoch. See §5.2. Left unstated, the mobile app and the chaincode will disagree, and only intermittently.
- **`HANDOFF.md` §15 Milestone 1 step 6 is internally inconsistent** — it ends the demo with an eligibility query, but `PolicyEngine` is not built until Milestone 3. The Milestone 1 demo ends at reading a session back.
- **Key storage is not hardware-bound.** `HANDOFF.md` §11 credits Keychain/Keystore for defeating key theft. In the chosen design, `tweetnacl` ed25519 private keys are stored as a Keystore-protected blob but enter JavaScript memory on every signature. This is an acceptable pilot trade-off — ed25519 is far simpler and integrates cleanly — but the threat model must state it rather than overclaim. Deferred to Milestone 3; recorded here so the threat model is written honestly from the start.
- **IPFS must not pin to the public network.** Medical certificates and OD letters on a public DHT is a privacy failure. Local Kubo node only. Deferred to Milestone 3.

### 2.4 Decisions explicitly retained

`HANDOFF.md` §2 marks several choices as non-negotiable. All are retained: Hyperledger Fabric with a minimum of three organizations, TypeScript chaincode, `@hyperledger/fabric-gateway` as the client SDK, off-chain nonce rotation, biometrics never leaving the device, and append-only corrections.

**Fabric 2.5 LTS is retained over Fabric 3.x.** Fabric 3.x offers BFT ordering, which would let the report claim Byzantine rather than crash fault tolerance — genuinely attractive for this threat model. It is rejected for this timeline because the documentation, `fabric-samples`, and virtually all available troubleshooting material target 2.5. BFT ordering moves to future work, where it earns the intellectual credit without the schedule risk.

---

## 3. Trust Model

Unchanged from `HANDOFF.md` §3; restated because §4.3 enforces it directly.

| Organization | Role | Ledger capability |
|---|---|---|
| **Registrar** | Identity enrolment, key issuance and revocation | Endorses; required for every write |
| **ExamCell (COE)** | Policy thresholds, eligibility, exam linkage | Endorses; required for every write |
| **Audit** | External oversight — student ombudsman or a UGC-facing node | Commits and reads; endorses nothing |

The Audit organization exists so that no combination of the operationally interested parties can rewrite history without an independent party holding a complete copy. Its value is structural: it is not trusted to *do* anything, it is positioned so that it would *see* everything.

**On what "read-only" means here.** Audit's read-only status is not a matter of configuration politeness. As a channel member, Audit can technically submit a transaction proposal. What prevents any effect is that the endorsement policy in §4.3 does not include Audit, so nothing Audit proposes can ever gather sufficient endorsement to commit. Enforcement is cryptographic and consensus-level, not administrative. This distinction should be stated in the report, because a reviewer may probe it.

---

## 4. Network Architecture

### 4.1 Topology

One channel, `attendance-channel`. Three organizations, each with one peer and its own CouchDB instance. A Raft ordering service. Each organization has its own MSP and Certificate Authority.

CouchDB is retained over LevelDB despite adding three containers, because it supports the rich queries that `PolicyEngine` will require in Milestone 3. Switching state databases later means rebuilding the network from scratch, so the cost is paid now.

### 4.2 Bring-up strategy: two-phase, deliberately

First-time Fabric network bring-up is the highest-variance task in this project. Image pulls, WSL memory limits, and certificate path handling all fail in ways that consume hours. With only two sessions, there is no slack for a bad first one. The strategy therefore banks a working fallback before attempting the version we actually want.

**Phase A — reach green using stock tooling.** Extend the `fabric-samples` two-org test network to three organizations using its own `addOrg3` script, unmodified. Organizations are named Org1, Org2, Org3. This is the fastest known path to a network that demonstrably works, and it is committed as a fallback before anything else is attempted.

**Phase B — rename to the real organizations.** Rename to Registrar, ExamCell, and Audit across `configtx.yaml`, the crypto material, and the scripts. This matters: the organization names *are* the argument in §3, and a Review II demo showing "Org1" undercuts it.

Phase B is a separate, revertible commit. If it resists, Phase A ships and the report names the organizations correctly in prose and diagrams. The demo is slightly less polished; the argument is unaffected.

### 4.3 Endorsement policy — the central artifact

This is the mechanism behind the project's core claim, and it must be visible, not implied.

**Package-level policy for the deployed chaincode:**

```
AND('RegistrarMSP.peer', 'ExamCellMSP.peer')
```

Every write to either in-scope contract requires endorsement from both the Registrar and the ExamCell. Neither can act alone. Audit appears in no endorsement policy.

`HANDOFF.md` originally implied per-operation policies, with `markAttendance` under a permissive `OR` for throughput and everything else under `AND`. That requires state-based endorsement, applied per key. Because `AttendanceRecorder` is out of scope, **every operation in this milestone wants `AND` anyway** — so a single package-level policy delivers an identical demonstration for a fraction of the effort. State-based endorsement moves to Milestone 3, where the high-volume `markAttendance` path actually needs it.

Channel-level ACLs in `configtx.yaml` are configured consistently: all three organizations are Readers; Registrar and ExamCell are Writers.

**Negative demonstration.** The demo script must attempt a write endorsed by Registrar alone and show it rejected. A positive result proves the system works; the negative result proves it *cannot be bypassed*, which is the actual thesis. This is a required deliverable, not a nice-to-have.

### 4.4 Chaincode packaging

**One deployable package containing multiple contract classes**, rather than the four separate packages in `HANDOFF.md` §5.

`fabric-contract-api` accepts an array of contract classes in a single package, each retaining its own namespace, so operations are addressed as `IdentityRegistry:registerIdentity` and `SessionManager:createSession`. Logical separation, file organization, and the contract boundaries of `HANDOFF.md` §7 are all preserved exactly.

What changes is deployment cost. Four packages across three organizations means roughly twelve lifecycle operations — install, approve, commit — for every code change. One package makes that three. Over a two-session build with many iterations, this is a large multiplier on the only resource that is genuinely scarce.

The one thing a single package gives up is differing endorsement policies per package. Section 4.3 already establishes that every in-scope operation wants the same policy, and state-based endorsement offers finer granularity than package splitting ever would. Nothing is lost.

---

## 5. The Commit-Reveal Nonce Scheme

This is the substantive design contribution of the milestone and the resolution of defect C1. It is specified in full even though its consumer, `AttendanceRecorder`, is out of scope — because the seed lifecycle it depends on lives entirely in `SessionManager`, which *is* in scope.

### 5.1 The problem being solved

Rotating nonces prevent replay: a screenshot of a QR code is worthless after roughly ten seconds. But a nonce must be *checked* by someone, and `HANDOFF.md` §9.3 assigned that check to the faculty backend because the chaincode never holds the seed. That places the freshness proof in one server's hands, which is the exact failure the multi-organization design exists to prevent.

Writing a fresh nonce on-chain every ten seconds per session would solve it and destroy the throughput budget. The design needs verifiability without per-tick transactions.

### 5.2 The scheme

**Commit, at session creation.** The faculty client generates a cryptographically random 32-byte seed and keeps it locally. Only `SHA-256(seed)` is submitted to `createSession` and stored on-chain as `nonceSeedHash`. The faculty is now cryptographically committed to a seed chosen before any submission is seen, and cannot later substitute a different one.

**Derive, during the session.** Nonces are computed locally by the faculty device, with no ledger interaction:

```
window w  = floor((t - session.startTime) / 10 seconds)
nonce(w)  = HMAC-SHA256(key = seed, message = w)
```

The window epoch is anchored to `session.startTime`, **not** the Unix epoch. This is stated explicitly because an unstated epoch is the kind of ambiguity that produces intermittent, hard-to-reproduce mismatches between the mobile app and the chaincode.

**Reveal, at session close.** `closeSession` submits the seed itself. The chaincode verifies that `SHA-256(seed)` equals the `nonceSeedHash` committed at creation, then stores the revealed seed on-chain.

### 5.3 Why this is stronger

Once the seed is public, **anyone** can recompute every nonce for every window of that session and check it against any attendance record. Verification requires the ledger and nothing else — no institutional server, no trusted API. This is what makes `HANDOFF.md` §9.6 ("verify without trusting the institution's server") true, which under the original scheme it was not.

Throughput is unchanged: one write at session open, one at close, and none in between.

Verification is retrospective — during a live session the chaincode still cannot check nonces, because the seed is not yet public. This is an acceptable and deliberate trade: attendance is not a real-time-safety-critical operation, and a forgery that is guaranteed to be detectable after the session closes is a fundamentally different risk from one that is never detectable at all.

### 5.4 Failure mode: the unrevealed seed

A faculty member who never closes a session leaves its records permanently unverifiable. The scheme converts a silent forgery risk into a loud, attributable failure, which is the correct direction — but it must be handled explicitly rather than left as an unreachable state.

Fabric chaincode cannot act on a timer; it executes only when invoked. The lifecycle is therefore:

- `open` — created, seed committed, not yet revealed.
- `closed` — seed revealed and verified against the commitment. The terminal healthy state.
- `expired` — the grace period elapsed with no valid reveal. Set by an explicit `expireSession` invocation, permitted once `startTime + durationSec + gracePeriod` has passed, judged against the ledger transaction timestamp.

Because `expired` requires someone to invoke it, `getSession` additionally reports a **derived** verification state, computed at read time, so an un-swept session is never silently misreported as healthy. The stored status is authoritative for writes; the derived state is what a reader is shown.

**A known limitation of this milestone's policy.** Ideally `expireSession` would be invocable by the Audit organization alone, since it is the sanction *against* the two operationally interested parties, and requiring their endorsement to record their own failure is circular. That is not achievable under the package-level `AND(Registrar, ExamCell)` policy of §4.3, which governs every write uniformly and does not include Audit as a Writer at all.

For this milestone, `expireSession` therefore carries the same endorsement requirement as every other write. The contract logic imposes no additional caller restriction beyond the grace-period check, so the function is ready for a narrower policy the moment one can be applied. Granting Audit unilateral expiry requires per-function state-based endorsement and Writer rights on the channel, and is deferred to Milestone 3 alongside the rest of the state-based endorsement work.

This is worth naming explicitly in the report rather than leaving implicit. The derived verification state in `getSession` substantially reduces the practical impact — an unrevealed session is reported as unverified to every reader whether or not anyone has swept it — so the gap is in recording the sanction durably, not in detecting the condition.

---

## 6. On-Chain Data Model

The subset of `HANDOFF.md` §6 that this milestone touches, with corrections applied.

### 6.1 Identity

Fields as in `HANDOFF.md` §6, with these resolutions:

- **`identityID` is derived deterministically from the transaction ID**, resolving defect C3. A random UUID cannot be generated in chaincode, because every endorsing peer must independently compute identical output. The transaction ID is unique, deterministic across peers, and not predictable by the submitter — it satisfies every property the original UUID was chosen for.
- **`identityHash`** is a salted hash of the student's name and enrolment number, computed off-chain by the caller. The chaincode stores it opaquely and never sees the underlying values. The salt is managed off-chain. Because PostgreSQL is out of scope, the demo generates and records the salt in a local file; this is demo scaffolding, not the design, and is labelled as such in the code.
- **`enrolledAt`** comes from the ledger transaction timestamp, per defect C4.
- **`publicKey`** holds the currently active ed25519 public key. Key rotation replaces it and writes a `KeyRevocationEvent`; history remains recoverable from the ledger.

Identities are stored under a composite key namespaced by identity, so lookups are direct state reads rather than queries.

### 6.2 Session

Fields as in `HANDOFF.md` §6, extended for §5:

- **`nonceSeedHash`** — committed at creation, never modified.
- **`revealedSeed`** — absent until `closeSession`; the seed whose hash matches the commitment.
- **`status`** — `open`, `closed`, or `expired`, per §5.4.
- **`gracePeriodSec`** — how long after nominal session end a reveal remains acceptable. Configured per session; a system default is defined in the shared configuration.
- **`startTime`** — the scheduled start, supplied by the caller. It anchors the nonce window epoch (§5.2) and so is genuinely caller-determined, unlike a record timestamp. The ledger timestamp of the creating transaction is stored separately as `createdAt`, so the gap between "when the class was scheduled" and "when the session was actually opened" is visible rather than conflated.
- **`geofenceCenter` and `geofenceRadiusM`** are stored as specified in `HANDOFF.md`. Nothing in scope consumes them; they are recorded now so that Milestone 3 does not require a data migration.

`sessionID` is caller-supplied, unlike `identityID`. The chaincode enforces uniqueness by rejecting a create against an existing key.

### 6.3 KeyRevocationEvent

As in `HANDOFF.md` §6. `timestamp` is the ledger transaction timestamp (C4). `authorizedBy` is the invoking client identity as reported by the chaincode context — taken from the transaction's verified credentials, never from a parameter, so it cannot be spoofed.

### 6.4 Deferred models

`AttendanceRecord` and `CorrectionRecord` are not implemented in this milestone. Their `HANDOFF.md` §6 definitions stand, with defect C6 (composite-key duplicate detection) and defect C4 (ledger timestamps) to be applied when they are built.

---

## 7. Contract Behaviour

Function names and signatures follow `HANDOFF.md` §7. Specified here is required behaviour: validation order, failure conditions, and what is written.

Two rules apply to every operation below. **Validation fails fast and returns a specific reason** — a generic failure is not acceptable, because the demo's value is in showing exactly which check rejected a bad submission. And **the caller's identity is always taken from the transaction context**, never from a parameter.

### 7.1 IdentityRegistry

**`registerIdentity(identityHash, publicKey, role)`**

Validates in order: the role is one of `student`, `faculty`, `admin`; the public key is well-formed as an ed25519 key; no active identity already exists for this `identityHash`. Then derives `identityID` from the transaction ID (§6.1), writes the identity with status `active` and `enrolledAt` from the ledger timestamp, and returns the identity ID.

The duplicate check is a direct composite-key state read, so it participates in the read set and is safe under concurrency — the same reasoning as defect C6, applied preemptively.

**`revokeAndReissueKey(identityID, oldPublicKeyHash, newPublicKey, reason, authorizedBy)`**

Validates in order: the identity exists; its status is `active`; the hash of the currently stored public key matches `oldPublicKeyHash`, which prevents a rotation racing against a concurrent one; the new key is well-formed and differs from the old; `reason` is one of the four enumerated values. Then updates the stored public key and writes a `KeyRevocationEvent` recording both the old key hash and the authorizing identity.

The identity remains `active` — this is a rotation, not a revocation of the person. Full revocation (status `revoked`, no replacement key) is a separate path and is deferred with `AttendanceRecorder`, since nothing in scope reads identity status for authorization yet.

**`getIdentityStatus(identityID)`**

Read-only. Returns the identity record, or a specific not-found error. No PII is present in the record by construction.

### 7.2 SessionManager

**`createSession(...)`**

Validates in order: no session exists with this `sessionID`; the faculty identity exists, is `active`, and holds the `faculty` role; `durationSec` is positive and within a configured maximum; `nonceSeedHash` is a well-formed SHA-256 digest; geofence values are within valid coordinate and radius ranges. Then writes the session with status `open` and `createdAt` from the ledger timestamp.

The seed itself is never transmitted and never stored at this stage. Only its hash crosses the network.

**`closeSession(sessionID, revealedSeed)`**

The signature gains a parameter relative to `HANDOFF.md` §7; this is the commit-reveal scheme's reveal step (§5.2).

Validates in order: the session exists; its status is `open`; the caller is the faculty who created it, or holds the `admin` role; `SHA-256(revealedSeed)` equals the stored `nonceSeedHash`; the ledger timestamp is within `startTime + durationSec + gracePeriodSec`. Then stores the revealed seed, sets status to `closed`, and records the closing time.

The hash comparison is the load-bearing check. Failing it means the faculty is presenting a seed other than the one committed to — an attempt to retrofit nonces after seeing submissions. This must be rejected loudly and is a required unit test.

**`expireSession(sessionID)`**

Validates that the session exists, that its status is `open`, and that the ledger timestamp is past `startTime + durationSec + gracePeriodSec`. Sets status to `expired`.

The contract deliberately imposes **no caller restriction** beyond the grace-period check — unlike every other write in §7, it does not test the caller's role or identity. Under this milestone's uniform endorsement policy that makes no practical difference, but it means the function needs no logic change when a narrower per-function policy becomes available (§5.4).

**`getSession(sessionID)`**

Read-only. Returns the session together with the derived verification state of §5.4, so a session that is past its grace period but not yet swept is reported accurately rather than as healthy.

---

## 8. Shared Library

A single module used identically by the chaincode, the backend, and — in Milestone 3 — the mobile app. This does not appear in `HANDOFF.md` §5 and is added deliberately.

**Why it exists.** Signature verification breaks if any two consumers serialize the signed payload even slightly differently: a reordered key, a differently formatted number, a changed separator. The failure surfaces as "valid signatures are rejected," which is among the most expensive classes of bug to diagnose, because both sides look correct in isolation. Making canonical encoding a single shared implementation with round-trip tests eliminates the entire category.

**Responsibilities:**

- **Canonical encoding** — a deterministic byte representation of any signable payload. Keys sorted, no insignificant whitespace, explicit number formatting, UTF-8. Deterministic in both directions.
- **Nonce derivation** — the HMAC computation and window arithmetic of §5.2, defined once so the faculty device and any verifier cannot diverge.
- **Hashing helpers** — identity hashing with salt, public key hashing, seed commitment hashing.
- **Shared types** — the on-chain model definitions of §6, so all consumers compile against one source of truth.

**Constraint:** this module is imported by chaincode and must therefore obey the determinism rules of §10.3 in full. No time, no randomness, no I/O. It is pure functions over their inputs.

---

## 9. Backend and Demo

### 9.1 Gateway module

Wraps `@hyperledger/fabric-gateway`: connection establishment, identity and signer construction from MSP material, and two helpers — one for submitting transactions, one for evaluating queries — with consistent error translation.

Fabric errors are notoriously opaque; an endorsement failure arrives as a nested structure that does not obviously say which check rejected it. The error translation layer surfaces the actual chaincode rejection reason. This matters directly for the demo, since §4.3's negative demonstration is only convincing if the rejection is legible on screen.

### 9.2 CLI demo

The Definition of Done deliverable. A single scripted run, printing each step and its result:

1. Enrol a student identity. Show the returned identity ID.
2. Read the identity back.
3. Rotate that identity's key. Show the revocation event.
4. Generate a seed, commit its hash, create a session.
5. Read the session back — status `open`, seed hash present, seed absent.
6. Derive and display a few nonce windows locally, demonstrating that rotation requires no ledger interaction.
7. Close the session with the correct seed. Show the commitment verifying.
8. Attempt to close a second session with a *wrong* seed. Show it rejected.
9. **Attempt a write endorsed by Registrar alone. Show it rejected.**

Steps 8 and 9 are the substance. Step 9 in particular is the direct evidence for the multi-organization claim, and should be the moment the demo is built around.

### 9.3 Express routes (stretch)

If session 2 permits: `POST /auth/enrol`, `POST /sessions`, `POST /sessions/:id/close`, `GET /sessions/:id`, `GET /identities/:id`, and `POST /keys/revoke-reissue`, all thin wrappers over §9.1. The remaining endpoints in `HANDOFF.md` §12 depend on out-of-scope contracts.

---

## 10. Testing

### 10.1 Approach

Test-driven, contract by contract. Every validation rule in §7 gets a test asserting both that valid input passes and that invalid input is rejected *with the specific expected reason*. Generic failure assertions are insufficient, because §7's fail-fast requirement is itself a deliverable.

Unit tests mock the chaincode stub and run without a network. This has schedule value beyond correctness: it decouples contract development from network bring-up, so if Phase A of §4.2 goes badly, contract work still proceeds and is demonstrable.

### 10.2 Required coverage

Beyond routine validation paths, these must be explicitly tested:

- Commit-reveal succeeds with the correct seed and **fails with any other seed** (§7.2).
- Duplicate registration and duplicate session creation are both rejected.
- Key rotation with a stale `oldPublicKeyHash` is rejected.
- `expireSession` is rejected before the grace period and accepted after.
- `getSession` reports the derived state correctly for a session past its grace period but unswept.
- Canonical encoding round-trips, and is byte-identical for semantically identical inputs presented in different key orders.

Integration coverage is the §9.2 demo script run against the live network, including its two negative cases.

### 10.3 Determinism checklist

Non-deterministic chaincode fails endorsement intermittently and confusingly, because peers disagree without any single one being wrong. It replaces Slither and Mythril (§2.3) as this project's static analysis story, and is both a documented checklist and an enforced lint rule over chaincode and shared library source.

Prohibited in chaincode and in the shared library: `Math.random` or any randomness source; `Date.now`, `new Date()`, or any system clock read; network and filesystem access; iteration over unordered collections where order affects output; JSON serialization with unstable key ordering; floating-point where exact equality matters.

Required instead: `ctx.stub.getTxTimestamp()` for time, `ctx.stub.getTxID()` for unique identifiers, explicit sorting before any iteration whose order affects output, and canonical encoding (§8) for anything hashed or signed.

Documented in `docs/determinism-checklist.md`. It is a genuine report artifact — it addresses the failure mode this architecture actually has, which is more defensible than a mis-targeted EVM tool.

---

## 11. Repository Layout

Extends `HANDOFF.md` §5 with the shared package (§8), a benchmark home, and ADRs.

```
haazir/
├── packages/
│   ├── shared/                 # §8 — canonical encoding, nonce derivation,
│   │                           #      hashing, shared types. Determinism-constrained.
│   └── chaincode/              # §4.4 — one package, contract classes within
│       └── src/contracts/      #   identity-registry, session-manager
│                               #   (attendance-recorder, policy-engine: Milestone 3)
├── network/
│   ├── fabric-config/          # configtx.yaml, crypto-config, endorsement policies
│   ├── compose/                # peers, orderers, CouchDB
│   └── scripts/                # network-up, channel-create, chaincode-deploy
├── backend/
│   └── src/{gateway,routes,cli}/
├── bench/                      # Caliper workloads, JMeter plans (Milestone 3)
├── docs/
│   ├── superpowers/specs/      # this document
│   ├── adr/                    # one per §2 decision and per §2.4 retention
│   ├── threat-model.md         # living document
│   └── determinism-checklist.md
├── verifier-web/               # Milestone 3
├── mobile/                     # Milestone 3 — see §12
└── HANDOFF.md
```

Managed as an npm workspace. `bench/` and `docs/adr/` are established now, empty or near-empty, because `HANDOFF.md` §14 requires every threat-model row to be executed as a real test rather than merely designed — and that only happens if those tests have somewhere to live from the beginning.

**On ADRs:** `HANDOFF.md` §2 is already six architecture decision records in compressed form, and §2 of this spec adds six more. "We considered X, chose Y, because Z" is exactly the form a viva examination probes, so the reasoning is recorded where it can be cited rather than reconstructed under questioning.

---

## 12. Development Environment

**The repository lives at `/home/swayam/haazir`, inside the WSL2 Ubuntu filesystem.** Not on `/mnt/d`.

There are two reasons, and the second is the binding one. Cross-filesystem I/O through `/mnt/` is roughly an order of magnitude slower, which turns every network restart into a wait. More seriously, Fabric bind-mounts MSP and TLS material into peer containers, and the file permissions on those certificates are load-bearing. Under the default drvfs mount, Windows-hosted files present as `0777` and `chmod` has no effect — so key material that must be `0600` cannot be made so. That is not a slow build; that is a network that does not start.

| Runs in WSL | Runs on Windows |
|---|---|
| The entire repository | Docker **Desktop** — installed and configured here |
| Node 20 LTS (via nvm) | VS Code window (connected via the WSL extension) |
| Fabric binaries and scripts | Browser — `localhost` forwards into WSL automatically |
| `docker` CLI and all containers | `C:\Users\swaya\.wslconfig` — WSL VM memory limits |
| git, npm, and Claude Code | Android Studio and JDK (Milestone 3) |

**Node 20 LTS specifically.** The system's Windows-side Node 24 is ahead of what `fabric-shim` supports; chaincode containers target Node 18 and 20, and running ahead of that produces obscure runtime failures inside the chaincode container where they are hardest to diagnose.

**Resource budget.** A three-organization network with CouchDB is roughly ten containers, requiring 6–8 GB. The machine has 15.7 GB and WSL2's default allocation is about half of physical memory, which is adequate; `.wslconfig` will set it explicitly rather than rely on the default.

**Known future wrinkle.** In Milestone 3, Android Studio will want to live on Windows — the phone connects to a Windows USB port, and Gradle over a `\\wsl$` path performs badly. That places `mobile/` on the Windows side while everything else stays in WSL, which breaks the npm workspace link to `packages/shared`. The app communicates with the backend over HTTP and needs no shared filesystem, so the resolution is to publish `shared` to a local registry or vendor a copy. Recorded so the shared package's boundary is designed for it now, rather than being rediscovered as a blocker later.

---

## 13. Deferred Work

Everything below is genuinely deferred, not abandoned. Each item belongs in the report's future-work section.

**Milestone 3 — next build phase.** `AttendanceRecorder` (applying defects C4 and C6), `PolicyEngine`, the React Native mobile application, on-device liveness with MobileFaceNet embeddings (defect C5), BLE and geofence proximity, the faculty console, PostgreSQL for off-chain PII, a local-only IPFS node for exemption evidence, the public verifier web application, state-based per-key endorsement, and Caliper and JMeter benchmarking against the `HANDOFF.md` §14 targets.

**A note on those targets.** The stated throughput goal — 60 students marked within 30 seconds — is approximately 2 transactions per second, which is far below anything Fabric finds difficult. The real constraint is the mobile marking flow, where the liveness challenge alone takes several seconds per student. When benchmarking is written up, the honest framing is that the ledger is not the bottleneck and measurement should target the end-to-end student experience. Stating this proactively is stronger than having a reviewer observe that the chain target was never in doubt.

**Longer-term, per `HANDOFF.md` §17.** Zero-knowledge eligibility proofs, ABC/DigiLocker export interoperability, passive liveness detection, and depth-sensor anti-deepfake liveness. Added by this review: Fabric 3.x BFT ordering (§2.4), and hardware-bound signing keys via Android Keystore rather than `tweetnacl` in application memory (§2.3).

**Named unsolved problems, carried forward from `HANDOFF.md` §11.** BLE relay attacks are not defeated by BLE alone and need round-trip-time bounding or an NFC tap fallback. Coerced liveness — a confederate physically present to pass the challenge on someone's behalf — is not defeated by any factor in this design and is more a policy problem than a technical one. Both must appear in the threat model. `HANDOFF.md` is right that reviewers will look for exactly these, and naming them is worth more than a table with no gaps in it.

---

## 14. Risks

**The network is the schedule risk.** First-time Fabric bring-up dominates the variance in this plan. Mitigated by the two-phase strategy of §4.2, which banks a working fallback before attempting the preferred configuration, and by §10.1's network-independent unit tests, which keep contract development moving even if the network does not cooperate.

**Two sessions has no slack.** If session 1 is consumed by environment setup, the fallback position is that both contracts and their tests are complete and demonstrable off-chain. That is real, reviewable work covering Definition of Done items 3, 5, and 6, with the network as a stated and specific gap. Preferable to a partial attempt at everything.

**The rename in Phase B is optional by design.** If it fights, Phase A ships. The organization names appear correctly throughout the report and diagrams regardless; only the demo's console output is less polished.

---

## 15. Session Plan

**Session 1 — environment and network.** WSL preparation: Docker Desktop WSL integration, Node 20 via nvm, `jq`/`curl`/`build-essential`, Fabric 2.5 binaries and images. Repository scaffolding per §11 with the workspace configured. Phase A network to green and committed. Phase B rename attempted. Ends with a running three-organization network and a trivial chaincode deployed under the §4.3 endorsement policy, proving the write path end to end.

**Session 2 — contracts and demo.** Shared library with tests. Both contracts, test-driven, per §7 and §10.2. Deployment to the live network. Gateway module. CLI demo per §9.2 including both negative cases. `docs/threat-model.md` and `docs/determinism-checklist.md`. Express routes if room remains.

Contracts follow the network deliberately: building against a network already proven avoids diagnosing contract bugs and network bugs simultaneously, which is where time disappears fastest.
