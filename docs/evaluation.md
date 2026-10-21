# Evaluation

Measured on the live three-organisation network. Every figure here is produced
by a script in `backend/src/eval/` and written to `docs/evidence/eval/`, so it
can be regenerated rather than taken on trust.

```bash
npm run attacks --workspace @haazir/backend   # docs/evidence/eval/attacks.json
npm run bench   --workspace @haazir/backend   # docs/evidence/eval/bench.json
```

**Environment.** Hyperledger Fabric 2.5.9; three organisations, one peer and
one CouchDB each; one Raft orderer; endorsement policy `AND(Registrar, ExamCell)`;
the test network's batching of **2 s or 10 transactions per block**. Everything
runs on one laptop (WSL2, Docker Desktop), so there is no network latency
between organisations. In a real deployment each organisation is in a
different building, which adds round-trip time to every endorsement — these
figures are a lower bound on latency, not a prediction of it.

## 1. Security: the threat model, executed

Every row of `docs/threat-model.md` that software can exercise was run as a
live attack. **23 of 23 executed checks behaved as the threat model claims.**

| Row | Attack | Expected | Observed |
|---|---|---|---|
| 1 | Replay a genuine code from an earlier window (forwarded screenshot) | rejected | `WINDOW_MISMATCH` |
| 1 | Forge a code for the current window | accepted at marking, by design | accepted |
| 1 | — the forged code is exposed when the seed is revealed | invalid | invalid |
| 1 | — the session reports what it can prove | disputed | disputed |
| 2 | Close revealing a different seed than was committed | rejected | `SEED_COMMITMENT_MISMATCH` |
| 3 | Reveal the seed after the grace period | rejected | `GRACE_PERIOD_ELAPSED` |
| 3 | Record the expiry as a sanction | accepted | accepted |
| 3 | An unrevealed session reads as healthy | must not | `unverified` |
| 4 | Registrar alone rewrites a record (one endorsement) | invalidated | `ENDORSEMENT_POLICY_FAILURE` |
| 4 | — the record afterwards | unchanged | unchanged |
| 4 | The Audit organisation tries to write | rejected | `UNAUTHORISED_ORG` |
| 5 | A second mark for the same student and session | rejected | `DUPLICATE_ATTENDANCE` |
| 5 | A valid signed claim replayed into another session | rejected | `INVALID_SIGNATURE` |
| 7 | Submit from 400 m outside the geofence | rejected | `OUTSIDE_GEOFENCE` |
| 7 | Spoofed GPS reporting a point inside the fence | **accepted — residual risk** | accepted |
| 11 | Sign with a key since rotated out | rejected | `INVALID_SIGNATURE` |
| 11 | Sign with another student's key | rejected | `INVALID_SIGNATURE` |
| 12 | Enrol a second identity for the same person | rejected | `IDENTITY_HASH_EXISTS` |
| 13 | Mark in a course the student is not enrolled in | rejected | `NOT_ENROLLED` |
| 14 | A forged mark earns eligibility credit | must not | `rejectedForNonce=1, present=0` |
| API | Send the session seed to the server at open | rejected | `SEED_MUST_NOT_BE_SENT` |

Controls (a legitimate mark, a correct close) were accepted, so the rejections
above are specific rather than the system refusing everything.

**Not executable in software, reported as open:** row 6 (a lent phone —
defeated on the device by liveness, not on chain), row 8 (BLE or proximity
relay), row 9 (a present friend performs the liveness check), row 10 (a
deepfake injected through a virtual camera). Row 7's spoofed-GPS case is
listed above as *accepted* because that is the truth: a falsified location
inside the fence is indistinguishable from a real one.

## 2. Performance

### A single student

A lone mark takes **2.05 s** to commit (median of 5). That is not processing
time: it is the orderer's 2-second batch timeout, waiting for more
transactions to fill a block before cutting it with just one.

### A class arriving naturally — the representative case

Students arrive at random moments across a scan window.

| Class | Arrivals spread over | All recorded after | Per-student p50 | Per-student p95 |
|---|---|---|---|---|
| 60 | 20 s | 20.2 s | 1.02 s | 2.07 s |
| 120 | 30 s | 29.9 s | 1.02 s | 2.06 s |

The whole class is on the ledger within about 0.2 s of the last student
arriving. Per-student latency is bounded by the batch timeout — it does not
grow with class size. Review I set the target of 60 students in under 30
seconds; the ledger is not the limiting factor, adding at most ~2 s after each
student scans.

### Everyone at once — the stress case

Every student submits in the same instant.

| Class | Committed | Wall time | p50 | p95 | Throughput |
|---|---|---|---|---|---|
| 30 | 30/30 | 0.2 s | 0.19 s | 0.23 s | ~127 tx/s |
| 60 | 60/60 | 0.5 s | 0.33–0.38 s | 0.45–0.51 s | ~116–131 tx/s |
| 120 | 120/120 | 0.9 s | 0.60–0.62 s | 0.82–0.83 s | ~136–139 tx/s |

Two runs each; no failures and no MVCC conflicts, because every student writes
only their own keys. These figures are *faster* than a single student because
a burst fills 10-transaction blocks immediately and no block waits for the
timer. They are also flattered by every class size being a multiple of 10;
with 45 students the last, partial block would wait the full 2 s.

### Closing and querying

| Operation | Time |
|---|---|
| `closeSession` — reveal the seed and recompute every code (30–120 students) | 2.06–2.11 s |
| `computeEligibility` query | 11–13 ms |

Closing is dominated by the same batch timeout. The O(n) nonce sweep inside it
does not show at these sizes: 120 recomputations add about 50 ms.

## 3. Storage

Measured directly: block-file growth on a peer, and CouchDB document sizes.

| Per attendance mark | Bytes |
|---|---|
| Ledger (block data) | ~7,280 |
| World state: the attendance record | 848 |
| World state: the index entry | 210 |
| World state: its share of the nonce audit | ~296 |
| **World state total** | **~1,350** |

The block figure is dominated by what makes the record trustworthy: two
endorsement signatures and the X.509 certificates of the organisations that
gave them. For a department of 2,000 students, each attending 6 courses with
3 meetings a week over a 15-week semester, that is about 540,000 marks: roughly
**3.9 GB of block data and 0.73 GB of world state per semester**, per peer.
Both scale linearly and contain no personal data.

## 4. Method and limits

- **Custom harness, not Caliper.** Hyperledger Caliper was planned. A purpose-built
  harness was used instead because it signs marks exactly as a phone does
  (Ed25519 over the canonical payload, valid geofence and window), which a
  generic Caliper workload would need the same code to reproduce.
- **One machine.** No inter-organisation network latency; real deployments
  will be slower per transaction.
- **Test-network batching.** A production orderer would tune `BatchTimeout`
  (lower for latency) and `MaxMessageCount` (higher for throughput). The
  measured latency is a direct consequence of the 2 s default.
- **Usability is unmeasured.** The SUS survey needs a pilot class; the
  questionnaire and scoring sheet are in `docs/sus/`.
