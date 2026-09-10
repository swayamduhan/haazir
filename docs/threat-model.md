# Threat Model — Anti-Proxy Attendance

**Status:** Living document. Updated as countermeasures are built and tested.
**Scope note:** Milestone 2 (Review II) implements identity enrolment, session
lifecycle, and multi-organization consensus. Rows marked *Milestone 3* are
designed but not yet built; they are listed here because a threat model that
only contains solved problems is not a threat model.

Every row states what actually defeats the attack, what residual risk remains,
and — honestly — where the design does not close the gap. The rows we cannot
close are the ones worth reading.

---

## 1. Attack / Countermeasure Table

| # | Attack | Defeated by | Residual risk | Status |
|---|---|---|---|---|
| 1 | **Static QR screenshot, shared to an absent student** | Rotating nonce, 10-second window (§5.2). `markAttendance` rejects a window more than one rotation from the ledger clock; the nonce itself is adjudicated at close | A forged nonce is *accepted* at marking and exposed at close, not before — the price of keeping the seed off chain (ADR-016) | **Implemented and tested** |
| 2 | **Faculty forges attendance using the nonce seed** | Commit-reveal: the seed's hash is committed before any submission is seen, and the seed is revealed at close (§5) | None for retrofitting. Faculty can still refuse to close, which is visible (row 3). | **Implemented and tested** |
| 3 | **Faculty never closes the session, leaving records unverifiable** | `expireSession`, plus a verification state derived at read time so an unswept session never reads as healthy | Recording the sanction still requires an endorsed write; Audit cannot do it alone this milestone (§3) | **Implemented and tested** |
| 4 | **Admin or insider rewrites the record** | `AND(RegistrarMSP.peer, ExamCellMSP.peer)` endorsement policy — enforced at validation, not merely configured | Requires ≥2 organizations colluding, materially harder than one administrator | **Implemented and demonstrated** — see §2 |
| 5 | **Duplicate or replayed submission for the same session** | Composite-key existence check inside the transaction's read set, so MVCC rejects the second write. A replay into another session, window or place fails because all three are inside the signed payload | None. A rich-query check would *not* be safe here — see §3.2 | **Implemented and tested** |
| 6 | **Lent device, no liveness check** | Active liveness: blink / head-turn challenge plus on-device embedding match | Defeated only if liveness itself is not bypassed (rows 8, 9) | Milestone 3 |
| 7 | **GPS / geofence spoofing via mock-location tooling** | Rooted-device and mock-location detection | **Partial.** Sophisticated spoofing evades detection. | Milestone 3 |
| 8 | **BLE relay / wormhole** — a confederate in the room forwards the proximity signal to an absent student in real time | Not defeated by BLE alone | **Real, unclosed gap.** Needs round-trip-time bounding or an NFC-tap fallback for high-stakes sessions. | **Open** |
| 9 | **Lent device with coerced or cooperative liveness** — a friend physically present performs the liveness challenge on someone else's behalf | Not defeated by any factor in this design | **Genuine, unclosed gap.** This is a social and policy problem more than a technical one; no combination of possession, proximity, freshness, and liveness distinguishes a willing proxy from the real student. | **Open** |
| 10 | **Deepfake video injected via a virtual camera driver** | Not defeated by phone-camera active liveness | Needs depth-sensing hardware not all pilot devices have | Future work |
| 11 | **Key theft or device malware** | Private key held in Keychain / Keystore-protected storage; on-chain key rotation via `revokeAndReissueKey`; `markAttendance` verifies the signature against the *currently registered* key, so a rotated-out key stops working immediately | **Higher than it first appears** — see §3.1. Nothing proves the key is in a secure element rather than a rooted phone's filesystem | Rotation and verification **implemented and tested**; hardware binding is future work |
| 12 | **Sybil — one student enrols several device identities** | In-person enrolment, one identity per verified person; duplicate `identityHash` rejected on chain | Depends on registrar-side diligence. This is a policy control with a technical backstop, not the reverse. | **Backstop implemented and tested** |
| 13 | **Attendance marked for a student not enrolled in the course** | On-chain course roster, read by `markAttendance` on an exact composite key inside the read set (ADR-015) | Depends on the roster being synchronised from the SIS. A stale roster is a wrong roster, and nothing on chain can tell | **Implemented and tested** |

---

## 2. Row 4 Has Executable Evidence

Most threat-model rows are arguments. Row 4 is a test.

`network/scripts/prove-endorsement-policy.sh` submits the same operation twice:
once endorsed by Registrar alone, once by Registrar and ExamCell together. The
committer's own log records the verdict:

```
Block [8] Transaction index [0] marked as invalid by committer.
Reason code [ENDORSEMENT_POLICY_FAILURE]
endorsingIdentities="(mspid=RegistrarMSP ...)"
```

and reading the ledger back returns `IDENTITY_NOT_FOUND`. The single-organization
write does not exist.

**A subtlety worth stating, because it is easy to get wrong.** Fabric evaluates
the endorsement policy at *validation* time, when the block commits — not when
the proposal is endorsed. `peer chaincode invoke` reports the proposal response,
so it prints "successful" for a transaction that is subsequently discarded. An
earlier version of our own proof script was fooled by exactly this. The only
honest test is to read the ledger back, which is also the more convincing
demonstration: the record simply is not there.

---

## 3. Where This Design Is Weaker Than It Looks

### 3.1 Signing keys are not hardware-bound

`HANDOFF.md` credits Keychain/Keystore with defeating key theft. That overstates
it. The chosen design uses `tweetnacl` ed25519 keys stored as a Keystore-protected
*blob*: the private key is decrypted into JavaScript memory on every signature.
Malware with code execution in the app's process can extract it. A truly
hardware-bound key would be generated inside Android Keystore and never leave it.

This is an acceptable pilot trade-off — ed25519 is far simpler and integrates
cleanly with the rest of the stack — but it must be stated rather than claimed
away. Row 11's residual risk is real.

### 3.2 Rich queries would silently break duplicate detection

Fabric does not include rich-query (CouchDB) results in a transaction's read set,
so they are not revalidated at commit time. A duplicate check written as a rich
query passes under test and fails under load: two concurrent submissions for the
same student can both endorse and both commit. Every existence check in this
codebase is a composite-key `getState`, which *is* in the read set and is
therefore protected by MVCC.

### 3.3 Audit cannot yet sanction the parties it oversees

The Audit organization exists so no combination of interested parties can rewrite
history unobserved. But under this milestone's package-level endorsement policy,
`expireSession` — the sanction for a faculty member who never reveals their seed —
requires the same `AND(Registrar, ExamCell)` endorsement as any other write.
Requiring the interested parties to endorse a record of their own failure is
circular.

The practical impact is limited: `getSession` derives verification state at read
time, so an unrevealed session reads as `unverified` to every reader whether or
not anyone has swept it. The gap is in recording the sanction durably, not in
detecting the condition. Closing it needs per-function state-based endorsement,
deferred to Milestone 3.

### 3.4 On-chain identities are not bound to X.509 client identities

`session.facultyID` is an on-chain identity id; `ctx.clientIdentity.getID()` is an
X.509 name from the caller's MSP. Nothing connects them. `closeSession` therefore
enforces the check that genuinely exists — the caller's organization must be an
endorsing one — rather than the per-faculty check the design assumed. See ADR-013.

---

## 4. What Would Actually Defeat Rows 8 and 9

Stated plainly, because reviewers will ask.

**Row 8 (BLE relay)** is solvable with engineering: distance-bounding protocols
bound the round-trip time of a challenge-response so tightly that a relay's added
latency exceeds the bound. Commodity BLE hardware cannot measure this reliably; an
NFC tap, which is physically limited to a few centimetres, is the pragmatic
substitute for high-stakes sessions.

**Row 9 (cooperative proxy)** is not solvable by this architecture, and probably
not by any attendance technology. Every factor the system checks — possession,
proximity, freshness, liveness — is satisfied by a real, live, present human who
is simply the wrong one, acting with the absent student's consent. Detecting that
requires identifying *which* human, continuously, which is a surveillance
trade-off rather than a cryptographic one. The honest mitigation is policy:
randomised in-person spot checks, with the ledger providing a tamper-evident
record to check *against*.

This is worth stating as a limitation rather than papering over. A system that
makes casual proxying costly and leaves deliberate collusion detectable-by-audit
is a large improvement over a paper register — and claiming more than that would
be false.
