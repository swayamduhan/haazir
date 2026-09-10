# ADR-015: The Course Roster Lives On Chain

**Status:** Accepted, implemented
**Supersedes:** the enrolment check described in `HANDOFF.md` §7 step 6

## Context

`markAttendance` must reject a student who is not enrolled in the course being
taught. `HANDOFF.md` §7 places this check in the backend: look the student up
in the institutional SIS, then invoke the chaincode only if the lookup passes.

That cannot work, for two separate reasons.

**It is not enforceable.** A check performed before `invoke` is a check the
chaincode never sees. Anyone able to reach a peer can submit `markAttendance`
directly and skip it. The endorsement policy proves that Registrar and Exam
Cell both ran the contract; it says nothing about what a client did first.
Every other proof in this system is validated inside the contract precisely so
that it survives a compromised client — enrolment would have been the single
exception, and the easiest one to abuse.

**It cannot be moved inside without breaking determinism.** The obvious repair
is to have the chaincode query the SIS. Chaincode may not make network calls:
peers execute independently, an external service can answer differently to
each, and endorsement then fails with no peer being wrong. This is the general
prohibition in `docs/determinism-checklist.md`, not a special case.

## Decision

Enrolment is ledger state.

`CourseRoster` maintains one entry per `(courseID, studentID)` under the
composite key `roster~courseID~studentID`. Writes are restricted to the
endorsing organisations. `markAttendance` checks membership with a single
`getState` on that exact key.

Dropping a student sets `status: "dropped"` rather than deleting the entry, so
the roster carries its own history and a later audit can see that the student
was once enrolled.

## Consequences

**The check is enforced by consensus.** Two organisations independently
confirm the student was on the roster at the instant of the transaction. A
compromised backend cannot mark attendance for a student who is not enrolled.

**The check is MVCC-safe.** A composite-key `getState` enters the read set, so
a concurrent `dropStudent` against the same key invalidates the marking
transaction at commit. A CouchDB rich query would not have this property —
rich-query results are not revalidated, which is the defect recorded as C6.

**The SIS becomes an upstream source, not an authority.** Enrolment now has to
be synchronised into the ledger — a nightly or event-driven push from the SIS
to `enrolStudent` / `dropStudent`. That is real integration work this project
does not otherwise need, and it is the honest cost of the decision.

**Roster state grows with enrolment, not with attendance.** One entry per
student per course, written once. At a department scale of 2,000 students and
6 courses each, that is 12,000 small entries — insignificant next to the
attendance records themselves.

**A drop is not retroactive.** Records marked while the student was enrolled
remain valid; the roster's history makes that visible rather than confusing.
