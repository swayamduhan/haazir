# ADR-006: Corrections Are Superseding Records, Never Edits

**Status:** Accepted (retained from `HANDOFF.md` §2)

## Context

Attendance records legitimately need correcting — a liveness false negative, a
medical exemption, a faculty error. The naive implementation edits the record
in place.

## Decision

Never edit, never delete. `correctAttendance` writes a new `CorrectionRecord`
and flips the original's status to `superseded`, preserving both.

## Consequences

The full history of any record stays reconstructible, including who authorised
each change and why. A correction and a cover-up become distinguishable, which
is the entire point of putting attendance on a ledger.

Queries must filter for valid status rather than assuming one record per
student-session, and storage grows monotonically.

Implementation lands with `AttendanceRecorder` in Milestone 3.
