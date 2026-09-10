# ADR-020: Exemptions Anchor Evidence By CID, And Name Their Own Effect

**Status:** Accepted, implemented

## Context

A student who misses class for a medical reason or on official college duty
must not be penalised. Recording that requires two things the ledger cannot
naively hold.

**The evidence is personal data.** A medical certificate is precisely the
category the privacy architecture exists to keep off chain: it is sensitive,
and it is erasable under DPDP 2023 and GDPR. An immutable chain cannot honour
a deletion request for content it contains.

**The arithmetic differs by institution.** On-duty attendance usually counts
as present. Medical leave usually removes the session from the denominator
instead. Choosing one and hard-coding it would bury a policy decision inside a
contract, where nobody reading the record could see which rule applied.

## Decision

**Evidence is anchored by its IPFS content identifier and nothing else.** A
CID is a hash of the content, so it proves which document was submitted while
containing none of it. Deleting the file leaves the on-chain anchor as a
permanent reference to nothing — erasure without rewriting history. The
contract validates the CID's shape (CIDv0 base58, CIDv1 base32) and rejects
anything else, a URL included, because a URL is a location rather than a hash.

**The effect is a field, not a convention.** Every exemption carries an
`effect` of either `counts_present` or `excluded`, chosen by the exam cell at
grant time and visible on the record. The first adds to the numerator; the
second removes the session from the denominator entirely.

**Revocation preserves the grant.** A withdrawn exemption is marked revoked
rather than deleted, keeping who granted it, when, and against what evidence.

**One exemption per student, per session.** Keyed
`exemption~courseID~studentID~sessionID`, so a student's exemptions for a
course come back in a single range query rather than a read per session.

## Consequences

**The right to erasure survives immutability.** Nothing erasable is on chain;
what is on chain is a hash that becomes meaningless once the file is gone.

**Which rule applied is on the record.** A student contesting a percentage can
see that week three was excused and week four credited, and under which kind.

**A range of dates is several exemptions.** Medical leave is usually granted
for a period, not for one lecture. Expanding a date range into the sessions it
covers is left to the caller, because the contract cannot query a timetable by
date without another index and the expansion is unambiguous outside. A real
ergonomic cost of the simpler on-chain model.

**Nothing verifies that the CID resolves.** The chaincode cannot fetch it —
peers must not make network calls, and an unreachable gateway would fail
endorsement. A well-formed CID for a document that was never uploaded is
accepted, and only an off-chain check will notice.

**An exemption is an unverifiable credit by construction.** It rests on the
exam cell's judgement, not on a cryptographic proof, which is why
`creditedByExemption` is reported separately from `present` rather than folded
into it.
