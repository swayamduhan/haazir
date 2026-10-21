# REST API

`backend/src/api/app.ts` exposes the ledger over HTTP for the faculty console,
the student client and the public verifier. It is deliberately thin: each route
names one chaincode function and passes its arguments through. The chaincode,
executed by both Registrar and Exam Cell, decides whether a request is valid.

```bash
npm run build
npm run serve --workspace @haazir/backend     # PORT=3000, HAAZIR_ORG=registrar
API=http://localhost:3000 npm run smoke --workspace @haazir/backend
```

Writes use `submit`, which gathers endorsements from both endorsing peers.
Reads use `evaluate`, which asks one peer and writes nothing.

## Endpoints

| Method | Path | Chaincode function |
|---|---|---|
| GET | `/health` | — |
| POST | `/identities` | `IdentityRegistry.registerIdentity` |
| GET | `/identities/:id` | `IdentityRegistry.getIdentityStatus` |
| POST | `/identities/:id/rotate-key` | `IdentityRegistry.revokeAndReissueKey` |
| POST | `/courses/:courseID/roster` | `CourseRoster.enrolStudent` |
| DELETE | `/courses/:courseID/roster/:studentID` | `CourseRoster.dropStudent` |
| GET | `/courses/:courseID/roster` | `CourseRoster.getRoster` |
| GET | `/courses/:courseID/sessions` | `PolicyEngine.getCourseSessions` |
| POST | `/sessions` | `SessionManager.createSession` |
| GET | `/sessions/:id` | `SessionManager.getSession` |
| POST | `/sessions/:id/close` | `SessionManager.closeSession` |
| POST | `/sessions/:id/expire` | `SessionManager.expireSession` |
| GET | `/sessions/:id/nonce-audit` | `AttendanceRecorder.getNonceAudit` |
| POST | `/sessions/:id/attendance` | `AttendanceRecorder.markAttendance` |
| GET | `/sessions/:id/attendance` | `AttendanceRecorder.getSessionAttendance` |
| GET | `/sessions/:id/attendance/:studentID` | `AttendanceRecorder.getAttendance` |
| POST | `/sessions/:id/attendance/:studentID/corrections` | `AttendanceRecorder.correctAttendance` |
| GET | `/courses/:courseID/students/:studentID/eligibility` | `PolicyEngine.computeEligibility` |
| GET | `/courses/:courseID/students/:studentID/exemptions` | `PolicyEngine.listExemptions` |
| POST | `/courses/:courseID/students/:studentID/exemptions` | `PolicyEngine.applyExemption` |
| POST | `/courses/:courseID/students/:studentID/exemptions/:sessionID/revoke` | `PolicyEngine.revokeExemption` |

## Off-chain stores

Started with `./network/scripts/offchain-up.sh`. The server connects to them
when reachable and answers `503 OFFCHAIN_UNAVAILABLE` on these routes when not;
every ledger route works either way.

| Method | Path | What it does |
|---|---|---|
| POST | `/registrar/students` | Stores name, registration number and a fresh salt in PostgreSQL; registers only the salted hash on chain |
| GET | `/registrar/students/:id` | The personal data held for an identity, or its erasure tombstone |
| DELETE | `/registrar/students/:id/pii` | Erases name, number, salt and hash. The on-chain identity is untouched and becomes unlinkable |
| POST | `/evidence` | Raw document body (`X-Filename` header) to the private IPFS node; returns its CIDv1 |
| GET | `/evidence/:cid` | The document, while this node still holds it |
| DELETE | `/evidence/:cid` | Unpins and garbage-collects. The on-chain CID remains, a reference to nothing |

A duplicate registration number is refused (`409 REG_NO_EXISTS`) *before* the
chain write, so a failed registration never leaves an orphaned identity on the
ledger. `npm run offchain --workspace @haazir/backend` exercises the whole
cycle against the real stores: 15 of 15 checks.

## Errors

Every error has the same shape, and the chaincode's own code is always kept:

```json
{ "error": { "code": "OUTSIDE_GEOFENCE", "detail": "submitted location is 333 m from the geofence centre, limit 50 m" } }
```

| Status | Meaning |
|---|---|
| 400 | Malformed request: missing field, invalid JSON, or the seed sent at session open |
| 403 | `UNAUTHORISED_ORG` |
| 404 | Any `*_NOT_FOUND`, or no such route |
| 409 | The request contradicts ledger state: duplicate mark, session not open, already enrolled |
| 422 | The contract refused a well-formed request: bad signature, outside geofence, stale window, wrong seed |
| 502 | The ledger failed, including an unsatisfied endorsement policy — a server fault, never the caller's |
| 500 | Anything unexpected |

A test reads every `fail('CODE')` in the chaincode source and asserts that it
maps to a 4xx, so a code added later cannot reach clients as a server error.

## The one rule the API enforces itself

`POST /sessions` refuses any body containing `seed`, `nonceSeed` or
`revealedSeed`, with `400 SEED_MUST_NOT_BE_SENT`. A server that has seen the
seed while the session is open can mint valid codes for absent students, which
is exactly what commit–reveal prevents (ADR-007). Only `nonceSeedHash` is
accepted at open; the seed arrives at `/sessions/:id/close`.
