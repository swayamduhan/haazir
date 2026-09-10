# ADR-017: The Device Signature Is Verified Inside The Contract

**Status:** Accepted, implemented

## Context

Possession is the proof that the submission came from the student's enrolled
device. `IdentityRegistry` already stores an ed25519 public key per identity
and rotates it on revocation, but until now nothing verified a signature
against it — the key was registered and never used.

The signature could be checked in the backend before submitting. That is the
same mistake as the enrolment check in ADR-015: a check the contract never
sees is a check a compromised or bypassed backend can skip, and the
endorsement policy attests nothing about it.

Verifying inside the contract raises two mechanical questions.

**What exactly is signed?** If the device and the contract serialise the same
fields differently — key order, number formatting, whitespace — every
signature fails, intermittently and confusingly. `canonicalize()` already
exists for precisely this and is what the seed commitment relies on.

**Can Node verify a raw ed25519 key?** `crypto.verify` handles ed25519, but it
wants a `KeyObject`. Our keys are stored as 32 raw bytes in hex, which is what
a mobile secure element exports. The two are bridged by wrapping the raw key
in the fixed 12-byte SPKI prefix `302a300506032b6570032100` and importing the
result as DER.

## Decision

`markAttendance` verifies an ed25519 signature over the canonical encoding of
the submission, using the public key currently registered for that identity.

The signed payload is built by a single function in `@haazir/shared` that both
the signer and the verifier call, over the fields `claimedNonce`,
`claimedWindow`, `courseID`, `latE7`, `lngE7`, `livenessHash`, `sessionID` and
`studentID`. One definition of "the bytes" rather than two that must agree.

The record stores the public key the signature was verified against. Key
rotation therefore does not invalidate history: an old record remains
checkable against the key that was current when it was written.

## Consequences

**Possession is enforced by consensus.** Both endorsing organisations verify
the same signature over the same bytes. A backend that never saw the device
cannot manufacture a record.

**Signature verification is deterministic.** Ed25519 verification is a fixed
computation over fixed inputs — no randomness, unlike ECDSA signing. Two peers
running it reach the same answer.

**The payload binds the submission to one session, one window and one place.**
Replaying a captured signature into a different session, a later window or
another location fails, because those fields are inside the signed bytes. The
signature is not a bearer token.

**Revocation is what stops a stolen key, and it is not instant.** A device
compromised mid-session signs valid submissions until `revokeAndReissueKey`
lands. The public key stored on each record at least makes the blast radius
enumerable after the fact.

**A software key is still a software key.** Nothing here proves the private
key lives in a secure element rather than in a rooted phone's filesystem.
Hardware-backed attestation is the missing half and is recorded as a
limitation in `docs/threat-model.md`, not solved by this ADR.
