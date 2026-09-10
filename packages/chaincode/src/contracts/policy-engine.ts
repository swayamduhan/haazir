import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import {
  AttendanceIndex, ATTENDANCE_THRESHOLD_BP, canonicalize, CourseSessionIndex,
  deriveExemptionId, EligibilityReport, ExemptionEffect, ExemptionKind,
  ExemptionRecord, isContentIdentifier, NonceAudit, RosterEntry, Session,
} from '@haazir/shared';
import { assertEndorsingOrg } from '../lib/authorisation';
import { fail } from '../lib/errors';
import {
  attendanceIndexKey, collectJson, COURSE_SESSION, courseSessionKey, EXEMPTION,
  exemptionKey, nonceAuditKey, readJson, rosterKey, sessionKey,
} from '../lib/keys';
import { txTimestampIso } from '../lib/ledger-time';

const KINDS: ExemptionKind[] = ['medical', 'official_duty', 'institutional'];
const EFFECTS: ExemptionEffect[] = ['counts_present', 'excluded'];

/**
 * Eligibility, computed from the ledger rather than reported to it.
 *
 * The alternative — a backend that totals attendance and writes the verdict —
 * would put the one number that decides whether a student sits an exam in the
 * hands of a single server, with the chain reduced to storing its conclusion.
 * Every input to the number is already on chain; the arithmetic belongs there
 * too, where two organisations execute it independently. ADR-019.
 */
@Info({
  title: 'PolicyEngine',
  description: 'Attendance eligibility and exemptions',
})
export class PolicyEngine extends Contract {
  constructor() {
    super('PolicyEngine');
  }

  /**
   * Excuses one student from one session, anchoring the evidence by its CID.
   *
   * The certificate itself never reaches the ledger. It is personal data,
   * erasable under DPDP 2023, and an immutable chain cannot honour a deletion
   * request; a CID is a hash of the content, so it proves which document was
   * submitted while containing none of it. ADR-020.
   */
  @Transaction()
  @Returns('string')
  public async applyExemption(
    ctx: Context,
    courseID: string,
    studentID: string,
    sessionID: string,
    kind: string,
    effect: string,
    evidenceCID: string,
    reason: string,
  ): Promise<string> {
    assertEndorsingOrg(ctx);

    if (!KINDS.includes(kind as ExemptionKind)) {
      fail('INVALID_EXEMPTION_KIND', `kind must be one of ${KINDS.join(', ')}`);
    }
    if (!EFFECTS.includes(effect as ExemptionEffect)) {
      fail('INVALID_EXEMPTION_EFFECT', `effect must be one of ${EFFECTS.join(', ')}`);
    }
    if (!isContentIdentifier(evidenceCID)) {
      fail('INVALID_EVIDENCE_CID',
        'evidenceCID must be an IPFS content identifier (CIDv0 or CIDv1)');
    }
    if (reason.trim().length < 4) {
      fail('MISSING_REASON', 'reason must state why the exemption is being granted');
    }

    const enrolment = await readJson<RosterEntry>(ctx, rosterKey(ctx, courseID, studentID));
    if (!enrolment) {
      fail('NOT_ENROLLED', `"${studentID}" has no enrolment record for "${courseID}"`);
    }

    const session = await readJson<Session>(ctx, sessionKey(ctx, sessionID));
    if (!session) fail('SESSION_NOT_FOUND', `no session with id "${sessionID}"`);
    if (session.courseID !== courseID) {
      fail('COURSE_MISMATCH',
        `session "${sessionID}" belongs to "${session.courseID}", not "${courseID}"`);
    }

    const key = exemptionKey(ctx, courseID, studentID, sessionID);
    const existing = await readJson<ExemptionRecord>(ctx, key);
    if (existing?.status === 'active') {
      fail('EXEMPTION_EXISTS',
        `"${studentID}" already has an active exemption for session "${sessionID}"`);
    }

    const record: ExemptionRecord = {
      exemptionID: deriveExemptionId(ctx.stub.getTxID()),
      courseID,
      studentID,
      sessionID,
      kind: kind as ExemptionKind,
      effect: effect as ExemptionEffect,
      evidenceCID,
      reason,
      status: 'active',
      grantedBy: ctx.clientIdentity.getID(),
      grantedAt: txTimestampIso(ctx),
    };

    await ctx.stub.putState(key, Buffer.from(canonicalize(record)));
    return canonicalize(record);
  }

  /** Withdraws an exemption, keeping the record so the grant stays visible. */
  @Transaction()
  @Returns('string')
  public async revokeExemption(
    ctx: Context,
    courseID: string,
    studentID: string,
    sessionID: string,
    reason: string,
  ): Promise<string> {
    assertEndorsingOrg(ctx);

    if (reason.trim().length < 4) {
      fail('MISSING_REASON', 'reason must state why the exemption is being withdrawn');
    }

    const key = exemptionKey(ctx, courseID, studentID, sessionID);
    const record = await readJson<ExemptionRecord>(ctx, key);
    if (!record) {
      fail('EXEMPTION_NOT_FOUND',
        `"${studentID}" has no exemption for session "${sessionID}"`);
    }
    if (record.status !== 'active') {
      fail('EXEMPTION_NOT_ACTIVE', `the exemption for session "${sessionID}" is already revoked`);
    }

    record.status = 'revoked';
    record.reason = reason;
    record.revokedBy = ctx.clientIdentity.getID();
    record.revokedAt = txTimestampIso(ctx);

    await ctx.stub.putState(key, Buffer.from(canonicalize(record)));
    return canonicalize(record);
  }

  @Transaction(false)
  @Returns('string')
  public async getExemption(
    ctx: Context,
    courseID: string,
    studentID: string,
    sessionID: string,
  ): Promise<string> {
    const record = await readJson<ExemptionRecord>(
      ctx, exemptionKey(ctx, courseID, studentID, sessionID),
    );
    if (!record) {
      fail('EXEMPTION_NOT_FOUND',
        `"${studentID}" has no exemption for session "${sessionID}"`);
    }
    return canonicalize(record);
  }

  @Transaction(false)
  @Returns('string')
  public async listExemptions(
    ctx: Context,
    courseID: string,
    studentID: string,
  ): Promise<string> {
    const records = await collectJson<ExemptionRecord>(
      ctx, EXEMPTION, [courseID, studentID],
    );
    return canonicalize({
      courseID,
      studentID,
      active: records.filter((r) => r.status === 'active').length,
      records,
    });
  }

  /** The course timetable as the ledger knows it, in session-id order. */
  @Transaction(false)
  @Returns('string')
  public async getCourseSessions(ctx: Context, courseID: string): Promise<string> {
    const indexes = await collectJson<CourseSessionIndex>(ctx, COURSE_SESSION, [courseID]);
    return canonicalize({ courseID, sessions: indexes.length, indexes });
  }

  /**
   * Computes one student's eligibility for one course, itemising every input.
   *
   * A bare percentage invites the dispute this system exists to settle, so
   * the report says where each session went: counted, excused, or credited
   * and then voided because its nonce did not survive the sweep.
   *
   * Cost is bounded by the course timetable, not by the ledger: one range
   * query for the sessions, one for the exemptions, then at most three point
   * reads per concluded session. For a course meeting three times a week over
   * fifteen weeks that is roughly 135 local reads in a query that reaches no
   * consensus — cheap, and bounded by a number an institution controls.
   */
  @Transaction(false)
  @Returns('string')
  public async computeEligibility(
    ctx: Context,
    courseID: string,
    studentID: string,
  ): Promise<string> {
    const enrolment = await readJson<RosterEntry>(ctx, rosterKey(ctx, courseID, studentID));
    if (!enrolment) {
      fail('NOT_ENROLLED', `"${studentID}" has no enrolment record for "${courseID}"`);
    }

    const indexes = await collectJson<CourseSessionIndex>(ctx, COURSE_SESSION, [courseID]);
    const exemptions = new Map<string, ExemptionRecord>();
    for (const e of await collectJson<ExemptionRecord>(ctx, EXEMPTION, [courseID, studentID])) {
      if (e.status === 'active') exemptions.set(e.sessionID, e);
    }

    const enrolledAtMs = Date.parse(enrolment.enrolledAt);
    let sessionsHeld = 0;
    let sessionsCounted = 0;
    let present = 0;
    let presentVerified = 0;
    let exempted = 0;
    let creditedByExemption = 0;
    let rejectedForNonce = 0;

    for (const index of indexes) {
      // Sessions that ran before the student joined are not theirs to attend.
      // Skipped without reading the session at all, which is why the index
      // carries the one immutable field that makes the decision.
      if (Date.parse(index.startTime) < enrolledAtMs) continue;

      const session = await readJson<Session>(ctx, sessionKey(ctx, index.sessionID));
      // An open session is still running. Counting it would mark every
      // student absent for a class that has not finished.
      if (!session || session.status === 'open') continue;

      sessionsHeld += 1;

      const exemption = exemptions.get(index.sessionID);
      if (exemption?.effect === 'excluded') {
        exempted += 1;
        continue;
      }

      sessionsCounted += 1;

      if (exemption?.effect === 'counts_present') {
        creditedByExemption += 1;
        continue;
      }

      const attendance = await readJson<AttendanceIndex>(
        ctx, attendanceIndexKey(ctx, index.sessionID, studentID),
      );
      if (attendance?.currentStatus !== 'present') continue;

      // The nonce sweep is only meaningful if its verdict reaches the number
      // that decides whether a student sits the exam. A record whose nonce was
      // forged does not become attendance merely because it was written.
      const audit = await readJson<NonceAudit>(ctx, nonceAuditKey(ctx, index.sessionID));
      const verdict = audit?.verdicts.find((v) => v.recordID === attendance.currentRecordID);
      if (verdict && !verdict.valid) {
        rejectedForNonce += 1;
        continue;
      }

      present += 1;
      // No verdict is not the same as a passing one. An expired session was
      // never swept, and a correction carries no nonce to check; both are
      // credit resting on attestation. Counted, and counted separately.
      if (verdict?.valid) presentVerified += 1;
    }

    const credited = present + creditedByExemption;
    // Basis points, computed by integer division. A percentage as a float
    // would be rejected by canonical encoding, and rightly: its string form
    // is not portable, and this is a number a student may contest.
    const attendancePercentBp = sessionsCounted === 0
      ? 10_000
      : Math.floor((credited * 10_000) / sessionsCounted);

    const report: EligibilityReport = {
      courseID,
      studentID,
      sessionsHeld,
      sessionsCounted,
      present,
      presentVerified,
      exempted,
      creditedByExemption,
      rejectedForNonce,
      attendancePercentBp,
      thresholdBp: ATTENDANCE_THRESHOLD_BP,
      eligible: attendancePercentBp >= ATTENDANCE_THRESHOLD_BP,
      computedAt: txTimestampIso(ctx),
    };

    return canonicalize(report);
  }
}
