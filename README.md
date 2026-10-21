# Haazir — Blockchain Student Attendance Ledger

A permissioned, multi-organization Hyperledger Fabric ledger for classroom
attendance. Every record is a signed transaction proving four things at once:
**possession** (device-bound key), **proximity** (geofence), **freshness**
(rotating nonce), and **liveness** (an on-device check). No single
institutional party can unilaterally write or alter the record. PII and
biometrics never touch the chain — only hashes and pseudonymous ids do.

**Status:** the complete path runs end to end — five smart contracts on a
three-organisation network enforcing `AND(Registrar, ExamCell)`, a REST API,
web clients for faculty, students, the Registrar and the public, off-chain
stores for personal data and evidence, and an evaluation suite. 265 tests.

---

## Quick start

```bash
./scripts/verify-env.sh          # gate: toolchain, Docker, Fabric images
./network/scripts/full-demo.sh   # everything below, end to end
```

Or step by step:

```bash
./network/scripts/network-up.sh              # 3-org network, channel created
./network/scripts/check-channel.sh           # all three orgs joined
./network/scripts/build-cc-package.sh        # build the chaincode image
./network/scripts/deploy-ccaas.sh            # deploy under the AND policy
./network/scripts/prove-endorsement-policy.sh   # the negative demonstration
npm run demo --workspace @haazir/backend     # full walkthrough
npm test                                     # unit tests, no network needed
npm run lint:determinism                     # bans clock, randomness and trigonometry
npm run serve --workspace @haazir/backend    # REST API on :3000, see docs/api.md
./network/scripts/network-down.sh
```

Web clients and off-chain stores:

```bash
./network/scripts/offchain-up.sh             # PostgreSQL (PII) + private IPFS (evidence)
./scripts/serve-web.sh                       # API + web on https://localhost:5173, see docs/web.md
```

Evaluation, against the live network:

```bash
npm run attacks  --workspace @haazir/backend   # threat model as live attacks: 23/23
npm run bench    --workspace @haazir/backend   # load and storage, 30/60/120 students
npm run offchain --workspace @haazir/backend   # privacy and erasure: 15/15
npm run smoke    --workspace @haazir/backend   # REST API end to end: 14/14 (server running)
```

## Prerequisites

Run `./scripts/verify-env.sh` — it checks everything and says what is missing.

- **WSL2 Ubuntu**, with this repository in the **Linux filesystem**
  (`~/haazir`), never under `/mnt/`. Fabric bind-mounts TLS material whose
  `0600` permissions drvfs cannot represent, so a repo on the Windows drive
  produces a network that will not start.
- **Node 20 LTS** via nvm. `fabric-shim` targets Node 18/20.
- **Fabric 2.5.9** binaries and images: `./scripts/bootstrap-toolchain.sh`
- **Docker Desktop** with WSL integration enabled for Ubuntu, ~8 GB allocated.

If image pulls fail with `docker-credential-desktop.exe: exec format error`,
run `./scripts/fix-docker-creds.sh` — WSL cannot exec the Windows credential
helper, and `install-fabric.sh` exits 0 even when every pull failed.

## What is where

| Path | Contents |
|---|---|
| `packages/shared/` | Canonical encoding, hashing, nonce derivation, shared types. Used by chaincode, backend, and later mobile, so signed payloads cannot diverge. |
| `packages/chaincode/` | `IdentityRegistry`, `SessionManager`, `CourseRoster`, `AttendanceRecorder` and `PolicyEngine`, one deployable package (ADR-011). |
| `network/` | Network lifecycle, MSP mapping, CCaaS deployment, endorsement policy proof. |
| `backend/` | Gateway connection, REST API (`docs/api.md`), off-chain stores, CLI demo, evaluation suite (`src/eval/`). |
| `web/` | Faculty console, student app, Registrar desk and public verifier (`docs/web.md`). |
| `docs/evaluation.md` | Attack results, latency, throughput and storage, with the method and its limits. |
| `docs/sus/` | Usability questionnaire, session plan and scoring workbook. |
| `docs/threat-model.md` | Attack/countermeasure table, including the gaps this design does **not** close. |
| `docs/adr/` | Twenty decision records — context, choice, cost. |
| `docs/determinism-checklist.md` | Why chaincode must not read the clock, and what to use instead. |
| `docs/superpowers/specs/` | The design spec this milestone implements. |
| `docs/superpowers/plans/` | The implementation plan. |

## The two things worth understanding

**Commit-reveal nonce seeds (ADR-007).** Rotating nonces defeat screenshot
sharing, but something must check them. Committing `SHA-256(seed)` at session
open and revealing the seed at close makes freshness verifiable by consensus
and by any third party — with two ledger writes per session, not one every ten
seconds.

**The endorsement policy is the whole argument (ADR-008).** "No single party
can alter the record" is a configuration claim, and `prove-endorsement-policy.sh`
tests it: a write endorsed by Registrar alone is committed as **invalid** and
never appears in state. Note that Fabric enforces this at *validation*, not at
proposal — so `peer chaincode invoke` prints "successful" for a transaction
that is then discarded. Any honest test reads the ledger back.

## Known limits

Stated plainly, and in more detail in `docs/threat-model.md` and
`docs/evaluation.md`:

- **Liveness proves a live face, not whose face** — matching against an enrolment
  template is not built.
- **The student's key lives in browser storage**, not a hardware keystore.
- **No end-user authentication on the API** — organisation-level only (ADR-013).
- **No BLE**: proximity is the geofence, which a spoofed GPS reading inside the
  fence defeats.
- **Relay attacks and cooperative proxying** (a present friend doing the liveness
  check) are not defeated by this design.
- **Performance is measured on one laptop**, so it is a lower bound on latency.
- **Usability is unmeasured** until the SUS survey is run with a class.
