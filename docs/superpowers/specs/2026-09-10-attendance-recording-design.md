# Design Spec: Attendance Recording (Milestone 3, part 1)

**Date:** 2026-09-10
**Status:** Implemented
**Extends:** [Review II design spec](2026-09-09-attendance-chain-review-ii-design.md)

This is a delta. The Review II spec stands as the record of what that review
covered; everything below is new or changed, and nothing that spec says is
silently overwritten — where this document contradicts it, the contradiction
is named.

---

## 1. What this milestone closes

Review II delivered a ledger that could open a session, commit to a nonce
seed, reveal it and prove the reveal. It could not record a single attendance
mark. The four proofs the project claims — possession, proximity, freshness,
liveness — existed as a design, not as code.

This milestone makes marking real:

| Proof | Where it is now checked |
|---|---|
| Possession | `markAttendance` verifies an ed25519 signature against the key in the registry |
| Proximity | `markAttendance` compares integer distance against the session geofence |
| Liveness | `markAttendance` requires a well-formed on-device attestation digest |
| Freshness | Claimed at marking, adjudicated by `closeSession` when the seed is revealed |
| Eligibility | `markAttendance` reads the on-chain course roster |

## 2. Corrections to the Review II design

**§6.4 "Deferred models" is partly resolved.** `AttendanceRecord` and the
course roster were listed as Milestone 3 models with no schema. Both are now
specified in §4 below. `ExemptionRecord` and the policy models remain
deferred.

**`HANDOFF.md` §7 step 6 is superseded.** Enrolment was to be checked in the
backend against the institutional SIS before invoking. That check is
unenforceable — the contract never sees it — and cannot be moved inside,
because chaincode may not make network calls. The roster is now ledger state.
[ADR-015](../../adr/ADR-015-on-chain-course-roster.md).

**§5.4 gains a fifth verification state.** `VerificationState` was
`in_progress | awaiting_reveal | unverified | verified`. A closed session
whose nonce sweep found a forged claim is now `disputed`. Reporting it as
`verified` would have been the most misleading thing the contract could say:
the seed reveal proves the faculty committed honestly, and says nothing about
whether the submissions were fresh.

**§5.4's derivation is corrected.** `verificationStateOf` decided expiry from
the clock alone, so a session already stored as `expired` reported as
`in_progress` to any reader whose transaction carried an earlier timestamp.
The stored fact now outranks the clock.

**§10.3's determinism checklist was not enforced.** The lint configuration it
named existed, but ESLint was never a dependency and no script ran it. It is
now `eslint.determinism.config.mjs`, run by `npm run lint:determinism`, and it
additionally bans trigonometry (§7 below).

## 3. Scope

**In scope.** `CourseRoster`; `AttendanceRecorder` with `markAttendance`,
`correctAttendance` and three queries; the nonce sweep inside `closeSession`;
ed25519 signing and verification in the shared library; deterministic
geodistance; the reference device signer; an end-to-end demo on the live
network.

**Out of scope.** `PolicyEngine` (eligibility percentages, exemptions); the
Express routes; the mobile client; the faculty console; PostgreSQL and IPFS;
benchmarking. All remain as the Review II spec left them.

---

## 4. Data model additions

### 4.1 RosterEntry

Key: `roster~courseID~studentID`.

| Field | Notes |
|---|---|
| `courseID`, `studentID` | Also the key components |
| `status` | `enrolled` or `dropped` |
| `enrolledBy`, `enrolledAt` | X.509 identity of the writer, ledger timestamp |
| `droppedBy`, `droppedAt` | Present only once dropped |

A drop marks the entry rather than deleting it. An audit of a disputed record
needs to see that the student was once enrolled, and records marked while they
were enrolled remain valid.

### 4.2 AttendanceRecord

Key: `attRec~sessionID~studentID~seq`, where `seq` is zero-padded to six
digits so Fabric's lexical key order is also sequence order — unpadded, `"10"`
sorts before `"2"`.

| Field | Notes |
|---|---|
| `recordID` | `SHA-256("attendance" + txID)`, truncated. Never random |
| `seq` | 0 for the device mark; each correction takes the next |
| `status` | `present` or `absent` |
| `origin` | `device` or `correction` |
| `markedAt`, `markedBy` | Ledger timestamp; the submitting *organisation*, not the student |
| `claimedWindow`, `claimedNonce` | Device records only. A claim, not a verified fact |
| `location` | Integer microdegrees |
| `livenessHash` | Digest of the on-device match result. Never an embedding |
| `deviceSignature`, `devicePublicKey` | The signature and the key it verified against |
| `supersedes`, `reason` | Corrections only |

Records are written once and never rewritten — not by a correction, and not by
the sweep. The ledger would preserve an overwrite as history anyway, but only
the state database is queryable, so append-only *in state* is what makes the
history readable.

### 4.3 AttendanceIndex

Key: `attendance~sessionID~studentID`. Holds `currentRecordID`, `currentSeq`,
`currentStatus`, `updatedAt`.

The one mutable structure here, and it exists for a specific reason: the
duplicate check in `markAttendance` must be a single `getState` on an exact
composite key. That read enters the transaction's read set and is protected by
MVCC. A scan or a rich query would not be — defect C6.

### 4.4 NonceAudit

Key: `nonceAudit~sessionID`. Holds `checkedAt`, `recordsChecked`,
`validCount`, `invalidCount`, and one `NonceVerdict` per device record giving
`claimedNonce`, `expectedNonce` and `valid`.

Written once, by `closeSession`. A three-field summary is copied onto the
session itself so a reader does not need a second lookup to know whether the
session is disputed.

---

## 5. Contract behaviour

### 5.1 CourseRoster

| Function | Rejects with |
|---|---|
| `enrolStudent(courseID, studentID)` | `UNAUTHORISED_ORG`, `INVALID_COURSE_ID`, `STUDENT_NOT_FOUND`, `NOT_STUDENT`, `STUDENT_NOT_ACTIVE`, `ALREADY_ENROLLED` |
| `dropStudent(courseID, studentID)` | `UNAUTHORISED_ORG`, `NOT_ENROLLED` |
| `isEnrolled(courseID, studentID)` | — returns `"true"` or `"false"` |
| `getEnrolment(courseID, studentID)` | `NOT_ENROLLED` |
| `getRoster(courseID)` | `INVALID_COURSE_ID` |

`INVALID_COURSE_ID` covers an empty id and one containing U+0000. Both are
composite-key hazards: U+0000 is Fabric's delimiter, and an empty id would
make the partial key in `getRoster` match every course.

Re-enrolment after a drop reuses the same key rather than appending, so the
membership check stays a single exact-key read.

### 5.2 AttendanceRecorder, markAttendance

Arguments: `sessionID`, `studentID`, `claimedWindow`, `claimedNonce`, `latE7`,
`lngE7`, `livenessHash`, `deviceSignature`.

Checks run in this order, each naming its own reason. Knowing *which* proof
failed is the value of the demonstration, and of a dispute:

1. `UNAUTHORISED_ORG` — Registrar or Exam Cell only
2. `SESSION_NOT_FOUND`, `SESSION_NOT_OPEN`
3. `STUDENT_NOT_FOUND`, `NOT_STUDENT`, `STUDENT_NOT_ACTIVE`
4. `NOT_ENROLLED` — exact-key roster read
5. `DUPLICATE_ATTENDANCE` — exact-key index read
6. `OUTSIDE_SESSION_WINDOW` — ledger clock against start and duration
7. `INVALID_WINDOW`, `WINDOW_MISMATCH` — claimed window within one of the ledger's
8. `INVALID_NONCE`, `INVALID_LIVENESS_ATTESTATION`, `INVALID_SIGNATURE` (format)
9. `INVALID_LOCATION`, `OUTSIDE_GEOFENCE`
10. `INVALID_SIGNATURE` (verification)

Two properties of this list are load-bearing.

**`courseID` is taken from the session, never from the caller.** It goes into
the signed payload, so the device must have signed the course it is actually
being marked for.

**A wrong nonce is not rejected here.** The seed is on the faculty device; the
contract has nothing to compare against. What *is* checkable without the seed
is whether the claim is even about now, which is what `WINDOW_MISMATCH` does.
The one-window tolerance covers skew between the student's device and the
ordering service. See ADR-016.

### 5.3 AttendanceRecorder, correctAttendance

Arguments: `sessionID`, `studentID`, `newStatus`, `reason`.

Appends a record at the next sequence number carrying `supersedes`, and moves
the index. The superseded record is not touched.

A correction for a student with no prior record is allowed and takes sequence
0 — that is the device-failed case, and it is one of the two reasons
corrections exist. A correction that would not change the status is rejected
as `NO_CHANGE`, so the history means something. A reason shorter than four
characters is rejected as `MISSING_REASON`: an append-only history whose
entries do not say why is not auditable, which defeats the point of keeping
the superseded record.

Corrections are permitted on closed and expired sessions. That is when most of
them happen.

### 5.4 The sweep inside closeSession

After the revealed seed is checked against its commitment, and before the
session is written:

1. Collect the session's records with `GetStateByPartialCompositeKey`.
2. Skip corrections — they carry no nonce.
3. For each device record, recompute `HMAC-SHA256(seed, claimedWindow)` and
   compare.
4. Write one `NonceAudit`; copy its summary onto the session.

Superseded records are audited too. What the device claimed is a fact about
that instant; a later correction changes the attendance outcome, not the
claim.

Range queries are used, never rich queries. Fabric records a range query in
the read-write set as `RangeQueryInfo` and revalidates it at commit, so a
record inserted concurrently invalidates the close rather than escaping the
sweep. A rich query carries no such record and would have made the sweep
silently incomplete — defect C6 in a new place.

Cost is O(n) in class size, bounded by the roster rather than by elapsed time.
At n = 60 that is 60 reads and one write in one transaction. A 500-student
session would want a paged sweep; that is not this system.

An expired session is never swept: no seed is ever revealed, so no verdict can
be reached. Its records stay unadjudicated and it derives as `unverified`,
which is the correct reading and is why `expireSession` exists.

---

## 6. The signing protocol

The device signs the canonical encoding of eight fields — `claimedNonce`,
`claimedWindow`, `courseID`, `latE7`, `lngE7`, `livenessHash`, `sessionID`,
`studentID` — with ed25519.

One function in `@haazir/shared` builds those bytes, and both the signer and
the verifier call it. Two implementations that merely intend to agree
eventually disagree over key order or number formatting, and the symptom,
"valid signatures are rejected", is expensive to diagnose and
indistinguishable from an attack.

All eight fields are inside the signature, so a captured signature cannot be
replayed into another session, a later window or a different place.

Keys are stored as 32 raw bytes in hex, which is what a mobile secure element
exports. Node's `crypto.verify` wants a `KeyObject`, so the raw key is wrapped
in the fixed SPKI prefix `302a300506032b6570032100` and imported as DER. See
ADR-017.

The record stores the key the signature verified against, so a later rotation
does not make old records unverifiable.

---

## 7. Geodistance without trigonometry

Haversine cannot be used. ECMAScript specifies `sin`, `cos`, `tan`, `atan2`,
`log`, `exp` and `pow` as *implementation-approximated*: any approximation
conforms, and correct rounding is not required. Two peers on different Node
builds may legitimately differ in the last ulp — invisible almost everywhere,
except at a geofence boundary, where it flips accept to reject and endorsement
fails with no peer being wrong.

Instead: an equirectangular approximation over the microdegree coordinates
already on chain, with the longitude difference scaled by a cosine read from a
91-entry integer table (scaled by 1e6) and linearly interpolated in integer
arithmetic. The comparison is between squared millimetre distances, so no
square root is taken on the path that decides acceptance.

`Math.sqrt` is exempt — IEEE-754 requires it to be correctly rounded — and is
used only for the human-readable distance in error messages.

The lint rule now bans the transcendentals, so the obvious implementation
cannot be reintroduced by someone who has not read ADR-018.

---

## 8. Testing

186 tests, up from 98: 67 in `@haazir/shared` (was 41), 111 in
`@haazir/chaincode` (was 49), and the backend's 8 error-translation tests
unchanged.

| Area | Focus |
|---|---|
| `geo.test.ts` | Cosine accuracy against the stated bound; the accept path calls no `sqrt` |
| `signing.test.ts` | Round trip; each of the eight fields tampered independently; wrong key; malformed input |
| `course-roster.test.ts` | Enrol, drop, re-enrol; a dropped student is visible but not enrolled; course isolation |
| `attendance-marking.test.ts` | One test per rejection code, plus the rotated-key replay |
| `attendance-corrections.test.ts` | The original is byte-identical after correction; chains past sequence 9 |
| `nonce-sweep.test.ts` | Honest and forged in one session; disputed versus verified; expiry leaves no verdict |

Two defects were found by tests written for this milestone rather than by
review: the cosine table's four-decimal quantisation exceeded the accuracy
this document claims, fixed by moving to six places; and
`verificationStateOf` ignored a stored expiry and derived it from the clock.

The mock stub gained `getStateByPartialCompositeKey`, returning entries in
lexical key order. A mock returning insertion order would let tests pass
against behaviour the real peer does not have.

---

## 9. Verified on the live network

Deployed as `haazir` v2.0, sequence 2, under the unchanged policy
`AND('RegistrarMSP.peer','ExamCellMSP.peer')`, across three organisations
running their own chaincode services. The CLI demo runs seventeen steps
end-to-end, including six negative cases that must reject: an out-of-geofence
submission, a signature from a revoked key, a duplicate mark, a wrong seed at
close, and a forged nonce that is accepted at marking and exposed at close.
The session then reports `disputed` rather than `verified`.

---

## 10. Still deferred

Unchanged from the Review II spec: `PolicyEngine`, exemptions and evidence
anchoring, the Express routes, the mobile client, the faculty console,
PostgreSQL for PII, IPFS, the public verifier page, and benchmarking.

Newly relevant:

- **SIS synchronisation.** The roster now has to be fed from the institutional
  system — a nightly or event-driven push to `enrolStudent` and
  `dropStudent`. Real integration work, and the honest cost of ADR-015.
- **Hardware-bound keys.** Nothing proves a private key lives in a secure
  element rather than in a rooted phone's filesystem.
- **Per-function endorsement**, so Audit could invoke `expireSession` alone.
  Carried from ADR-013.
