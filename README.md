# Haazir — Blockchain Student Attendance Ledger

A permissioned, multi-organization Hyperledger Fabric ledger for classroom
attendance. Every record is a signed transaction proving four things at once:
**possession** (device-bound key), **proximity** (BLE/geofence), **freshness**
(rotating nonce), and **liveness** (on-device face match). No single
institutional party can unilaterally write or alter the record. PII and
biometrics never touch the chain — only hashes and pseudonymous ids do.

**Current milestone: Review II** — identity enrolment, session lifecycle with
commit-reveal nonce seeds, and a 3-organization network enforcing
`AND(Registrar, ExamCell)`.

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
./network/scripts/network-down.sh
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
| `packages/chaincode/` | `IdentityRegistry` and `SessionManager`, one deployable package (ADR-011). |
| `network/` | Network lifecycle, MSP mapping, CCaaS deployment, endorsement policy proof. |
| `backend/` | `fabric-gateway` connection module and the CLI demo. |
| `docs/threat-model.md` | Attack/countermeasure table, including the gaps this design does **not** close. |
| `docs/adr/` | Fourteen decision records — context, choice, cost. |
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

## Not yet built

`AttendanceRecorder`, `PolicyEngine`, the mobile app, on-device liveness,
BLE/geofence proximity, PostgreSQL, IPFS, and the public verifier. See the
design spec §13 and `docs/threat-model.md` for what remains open — including
BLE relay attacks and cooperative proxying, which this design does not defeat.
