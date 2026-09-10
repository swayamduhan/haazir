import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import {
  AttendanceIndex, AttendanceRecord, AttendanceStatus, attendancePayload,
  canonicalize, deriveRecordId, distanceMetres, GeoPoint, Identity,
  isEd25519Signature, isSha256Hex, isWithinRadius, NonceAudit, RosterEntry,
  Session, verifyEd25519, windowFor,
} from '@haazir/shared';
import { assertEndorsingOrg } from '../lib/authorisation';
import { fail } from '../lib/errors';
import {
  ATTENDANCE_INDEX, ATTENDANCE_RECORD, attendanceIndexKey, attendanceRecordKey,
  collectJson, identityKey, nonceAuditKey, readJson, rosterKey, sessionKey,
} from '../lib/keys';
import { txTimestampIso, txTimestampMs } from '../lib/ledger-time';

/**
 * Attendance records: written once, never edited.
 *
 * The four proofs the system claims are checked here, in the contract, so
 * that they survive a compromised or bypassed client. Three of them —
 * possession, proximity, liveness — are decided at marking time. The fourth,
 * freshness, cannot be: the nonce seed is still on the faculty device, so the
 * claim is recorded and adjudicated when `closeSession` reveals the seed.
 * ADR-016 and ADR-017.
 */
@Info({
  title: 'AttendanceRecorder',
  description: 'Device-signed attendance marking and append-only corrections',
})
export class AttendanceRecorder extends Contract {
  constructor() {
    super('AttendanceRecorder');
  }

  /**
   * Records one device-signed claim of presence.
   *
   * Checks run in order of specificity so that a rejection names the reason
   * rather than merely refusing: knowing *which* proof failed is the whole
   * value of the demonstration, and of a dispute.
   */
  @Transaction()
  @Returns('string')
  public async markAttendance(
    ctx: Context,
    sessionID: string,
    studentID: string,
    claimedWindow: number,
    claimedNonce: string,
    latE7: number,
    lngE7: number,
    livenessHash: string,
    deviceSignature: string,
  ): Promise<string> {
    assertEndorsingOrg(ctx);

    const session = await readJson<Session>(ctx, sessionKey(ctx, sessionID));
    if (!session) fail('SESSION_NOT_FOUND', `no session with id "${sessionID}"`);
    if (session.status !== 'open') {
      fail('SESSION_NOT_OPEN', `session "${sessionID}" is ${session.status}`);
    }

    const student = await readJson<Identity>(ctx, identityKey(ctx, studentID));
    if (!student) fail('STUDENT_NOT_FOUND', `no identity with id "${studentID}"`);
    if (student.role !== 'student') {
      fail('NOT_STUDENT', `identity "${studentID}" has role "${student.role}"`);
    }
    if (student.status !== 'active') {
      fail('STUDENT_NOT_ACTIVE', `identity "${studentID}" is ${student.status}`);
    }

    // An exact-key read, so the enrolment is in this transaction's read set
    // and a concurrent drop invalidates the mark at commit. ADR-015.
    const enrolment = await readJson<RosterEntry>(
      ctx, rosterKey(ctx, session.courseID, studentID),
    );
    if (enrolment?.status !== 'enrolled') {
      fail('NOT_ENROLLED', `"${studentID}" is not enrolled in "${session.courseID}"`);
    }

    const indexKey = attendanceIndexKey(ctx, sessionID, studentID);
    if (await readJson<AttendanceIndex>(ctx, indexKey)) {
      fail('DUPLICATE_ATTENDANCE',
        `"${studentID}" already has an attendance record for session "${sessionID}"`);
    }

    const nowMs = txTimestampMs(ctx);
    const startMs = Date.parse(session.startTime);
    if (nowMs < startMs || nowMs > startMs + session.durationSec * 1000) {
      fail('OUTSIDE_SESSION_WINDOW',
        `session "${sessionID}" does not accept marks at ${txTimestampIso(ctx)}`);
    }

    const window = assertWindow(claimedWindow, windowFor(nowMs, startMs));

    if (!isSha256Hex(claimedNonce)) {
      fail('INVALID_NONCE', 'claimedNonce must be a 64-character hex digest');
    }
    if (!isSha256Hex(livenessHash)) {
      fail('INVALID_LIVENESS_ATTESTATION',
        'livenessHash must be a 64-character hex digest of the on-device match result');
    }
    if (!isEd25519Signature(deviceSignature)) {
      fail('INVALID_SIGNATURE',
        'deviceSignature must be a 128-character hex ed25519 signature');
    }

    const location = parseCoordinates(latE7, lngE7);
    if (!isWithinRadius(location, session.geofenceCenter, session.geofenceRadiusM)) {
      fail('OUTSIDE_GEOFENCE',
        `submitted location is ${distanceMetres(location, session.geofenceCenter)} m `
        + `from the geofence centre, limit ${session.geofenceRadiusM} m`);
    }

    // courseID comes from the session, never from the caller: the device must
    // have signed the course it is actually being marked for.
    const payload = attendancePayload({
      sessionID,
      studentID,
      courseID: session.courseID,
      claimedWindow: window,
      claimedNonce,
      latE7: location.latE7,
      lngE7: location.lngE7,
      livenessHash,
    });

    if (!verifyEd25519(student.publicKey, payload, deviceSignature)) {
      fail('INVALID_SIGNATURE',
        `the signature does not verify against the key registered for "${studentID}"`);
    }

    const record: AttendanceRecord = {
      recordID: deriveRecordId(ctx.stub.getTxID()),
      sessionID,
      studentID,
      courseID: session.courseID,
      seq: 0,
      status: 'present',
      origin: 'device',
      markedAt: txTimestampIso(ctx),
      markedBy: ctx.clientIdentity.getID(),
      claimedWindow: window,
      claimedNonce,
      location,
      livenessHash,
      deviceSignature,
      // Captured now, so a later key rotation leaves this record verifiable
      // against the key that was current when it was written. ADR-017.
      devicePublicKey: student.publicKey,
    };

    await this.commit(ctx, record, indexKey);
    return canonicalize(record);
  }

  /**
   * Supersedes a student's attendance without editing what is already there.
   *
   * The prior record stays exactly as written; a new one is appended at the
   * next sequence number carrying `supersedes`. A correction for a student
   * with no record at all is allowed — that is the device-failed case, and
   * it is one of the two reasons corrections exist. ADR-006.
   */
  @Transaction()
  @Returns('string')
  public async correctAttendance(
    ctx: Context,
    sessionID: string,
    studentID: string,
    newStatus: string,
    reason: string,
  ): Promise<string> {
    assertEndorsingOrg(ctx);

    if (newStatus !== 'present' && newStatus !== 'absent') {
      fail('INVALID_STATUS', `newStatus must be "present" or "absent" (got "${newStatus}")`);
    }
    // An append-only history whose entries do not say why is not auditable,
    // which defeats the point of keeping the superseded record at all.
    if (reason.trim().length < 4) {
      fail('MISSING_REASON', 'reason must state why the record is being corrected');
    }

    const session = await readJson<Session>(ctx, sessionKey(ctx, sessionID));
    if (!session) fail('SESSION_NOT_FOUND', `no session with id "${sessionID}"`);

    const enrolment = await readJson<RosterEntry>(
      ctx, rosterKey(ctx, session.courseID, studentID),
    );
    if (!enrolment) {
      fail('NOT_ENROLLED',
        `"${studentID}" has never been enrolled in "${session.courseID}"`);
    }

    const indexKey = attendanceIndexKey(ctx, sessionID, studentID);
    const index = await readJson<AttendanceIndex>(ctx, indexKey);

    if (index && index.currentStatus === newStatus) {
      fail('NO_CHANGE',
        `"${studentID}" is already recorded as ${newStatus} for session "${sessionID}"`);
    }

    const record: AttendanceRecord = {
      recordID: deriveRecordId(ctx.stub.getTxID()),
      sessionID,
      studentID,
      courseID: session.courseID,
      seq: index ? index.currentSeq + 1 : 0,
      status: newStatus as AttendanceStatus,
      origin: 'correction',
      markedAt: txTimestampIso(ctx),
      markedBy: ctx.clientIdentity.getID(),
      supersedes: index?.currentRecordID,
      reason,
    };

    await this.commit(ctx, record, indexKey);
    return canonicalize(record);
  }

  /** The current record for one student, with the full superseded history. */
  @Transaction(false)
  @Returns('string')
  public async getAttendance(
    ctx: Context,
    sessionID: string,
    studentID: string,
  ): Promise<string> {
    const index = await readJson<AttendanceIndex>(
      ctx, attendanceIndexKey(ctx, sessionID, studentID),
    );
    if (!index) {
      fail('ATTENDANCE_NOT_FOUND',
        `"${studentID}" has no attendance record for session "${sessionID}"`);
    }

    const history = await collectJson<AttendanceRecord>(
      ctx, ATTENDANCE_RECORD, [sessionID, studentID],
    );
    const current = history.find((r) => r.recordID === index.currentRecordID);

    return canonicalize({ index, current, history });
  }

  /** Every student's current state for a session, in key order. */
  @Transaction(false)
  @Returns('string')
  public async getSessionAttendance(ctx: Context, sessionID: string): Promise<string> {
    const entries = await collectJson<AttendanceIndex>(ctx, ATTENDANCE_INDEX, [sessionID]);
    return canonicalize({
      sessionID,
      present: entries.filter((e) => e.currentStatus === 'present').length,
      absent: entries.filter((e) => e.currentStatus === 'absent').length,
      entries,
    });
  }

  /**
   * The nonce verdicts, written by `closeSession` when the seed was revealed.
   *
   * Absent until the session closes — which is the honest answer, not a
   * failure: while the session is running nobody, the contract included, can
   * check a nonce. ADR-016.
   */
  @Transaction(false)
  @Returns('string')
  public async getNonceAudit(ctx: Context, sessionID: string): Promise<string> {
    const audit = await readJson<NonceAudit>(ctx, nonceAuditKey(ctx, sessionID));
    if (!audit) {
      fail('NONCE_AUDIT_NOT_FOUND',
        `session "${sessionID}" has not been closed, so no seed has been revealed`);
    }
    return canonicalize(audit);
  }

  /** Writes the immutable record, then moves the index pointer onto it. */
  private async commit(
    ctx: Context,
    record: AttendanceRecord,
    indexKey: string,
  ): Promise<void> {
    const index: AttendanceIndex = {
      sessionID: record.sessionID,
      studentID: record.studentID,
      currentRecordID: record.recordID,
      currentSeq: record.seq,
      currentStatus: record.status,
      updatedAt: record.markedAt,
    };

    await ctx.stub.putState(
      attendanceRecordKey(ctx, record.sessionID, record.studentID, record.seq),
      Buffer.from(canonicalize(record)),
    );
    await ctx.stub.putState(indexKey, Buffer.from(canonicalize(index)));
  }
}

/**
 * The claimed window must be the one the ledger clock is in, give or take a
 * window for skew between the student's device and the ordering service.
 *
 * This is the only part of freshness checkable while the seed is secret: the
 * contract cannot tell whether the nonce is right, but it can tell whether
 * the claim is even about now.
 */
function assertWindow(claimed: number, actual: number): number {
  const window = Number(claimed);
  if (!Number.isInteger(window) || window < 0) {
    fail('INVALID_WINDOW', `claimedWindow must be a non-negative integer (got ${claimed})`);
  }
  if (Math.abs(window - actual) > 1) {
    fail('WINDOW_MISMATCH',
      `claimed window ${window} is not the current window ${actual}; `
      + 'a nonce more than one rotation old is stale');
  }
  return window;
}

function parseCoordinates(latE7: number, lngE7: number): GeoPoint {
  const lat = Number(latE7);
  const lng = Number(lngE7);

  if (!Number.isInteger(lat) || lat < -900_000_000 || lat > 900_000_000) {
    fail('INVALID_LOCATION', `latE7 must be an integer within +/-900000000 (got ${latE7})`);
  }
  if (!Number.isInteger(lng) || lng < -1_800_000_000 || lng > 1_800_000_000) {
    fail('INVALID_LOCATION', `lngE7 must be an integer within +/-1800000000 (got ${lngE7})`);
  }
  return { latE7: lat, lngE7: lng };
}
