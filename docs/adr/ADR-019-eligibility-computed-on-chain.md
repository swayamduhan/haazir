# ADR-019: Eligibility Is Computed On Chain, In Integers

**Status:** Accepted, implemented

## Context

The number that decides whether a student sits an examination is their
attendance percentage. Every input to it is already on the ledger: the course
timetable, each student's records, the nonce verdicts, the exemptions.

The obvious implementation is a backend that reads those inputs, totals them,
and either writes the verdict on chain or serves it over an API. That would
put the single most consequential number in the system back in the hands of
one server — the arrangement the multi-organisation design exists to avoid. A
chain that stores a conclusion it did not reach is a database with extra
steps.

Two mechanical problems stood in the way of computing it in the contract.

**Counting a course's sessions.** Sessions are keyed by session id. Totalling
one course's meetings would mean scanning every session on the ledger and
filtering — unbounded, and growing for the institution's lifetime.

**Percentages are floating point.** `canonicalize` rejects non-integers by
design, because a float's decimal form is not portable across platforms. A
percentage is exactly the value that arrives as 74.99999999999999.

## Decision

`PolicyEngine.computeEligibility` computes the verdict inside the contract.

- **`createSession` writes a course index** at `courseSession~courseID~sessionID`,
  carrying only immutable fields — the session id and its scheduled start.
  Mutable state such as `status` is deliberately not copied: it is read from
  the session itself, so there is no second place for it to be wrong.
- **The percentage is basis points**, an integer, where 7500 is 75.00%. No
  float ever enters the record.
- **Only concluded sessions count.** An open session is still running;
  counting it would mark every student absent for a class that has not
  finished.
- **The report itemises every input** — sessions held, sessions counted,
  present, verified, exempted, credited by exemption, rejected for a failed
  nonce. A bare percentage invites the dispute this system exists to settle.

Cost is bounded by the course timetable rather than by the ledger: two range
queries, then at most three point reads per concluded session. A course
meeting three times a week for fifteen weeks costs roughly 135 local reads, in
a query that reaches no consensus.

## Consequences

**The verdict is reached by consensus, not reported to it.** Both endorsing
organisations execute the same arithmetic over the same state.

**A failed nonce costs the credit.** A record the sweep rejected does not
count as attendance. This is what makes ADR-016 matter: a forgery that is
detected but still counts is a forgery that succeeded.

**Credit that rests on trust is labelled as such.** `presentVerified` counts
only records backed by a nonce the sweep matched. A faculty correction, or a
session that expired before anyone revealed its seed, still earns credit — but
the report says how much of the total is not cryptographically backed. The
alternative readings were both worse: refusing the credit punishes students
for a faculty member's failure to close a session, and granting it silently
lets that failure launder unverifiable attendance.

**The index is a schema migration.** Sessions created before this change carry
no course index and are invisible to eligibility. Acceptable on a development
ledger; a production deployment would need a backfill.

**Enrolment date is taken from the current roster entry.** Sessions that ran
before it do not count against the student. A student who dropped and
re-enrolled has only the later date, so their first period silently vanishes
from the denominator. Doing better needs per-period roster history, which this
milestone does not have. Stated here rather than discovered later.

**A course of zero concluded sessions reports 100%.** There is no honest
alternative to a division with no denominator, and sessionsHeld sits at zero
beside it in the report.
