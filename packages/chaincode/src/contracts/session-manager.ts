import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import {
  canonicalize, GeoPoint, Identity, isSha256Hex, MAX_SESSION_DURATION_SEC,
  Session, toE7, VerificationState,
} from '@haazir/shared';
import { fail } from '../lib/errors';
import { exists, identityKey, readJson, sessionKey } from '../lib/keys';
import { txTimestampIso, txTimestampMs } from '../lib/ledger-time';

/**
 * Organizations permitted to write. Audit is deliberately absent: it commits
 * and reads, but endorses nothing. Spec section 3.
 */
const ENDORSING_MSPS = ['RegistrarMSP', 'ExamCellMSP'];

@Info({
  title: 'SessionManager',
  description: 'Class session lifecycle and nonce seed commitment',
})
export class SessionManager extends Contract {
  constructor() {
    super('SessionManager');
  }

  /**
   * Opens a session, committing to a nonce seed without revealing it.
   *
   * Only SHA-256(seed) crosses the network. The faculty is now bound to a
   * seed chosen before any submission is seen and cannot substitute another
   * at reveal time. Spec section 5.2.
   */
  @Transaction()
  @Returns('string')
  public async createSession(
    ctx: Context,
    sessionID: string,
    courseID: string,
    facultyID: string,
    room: string,
    startTime: string,
    durationSec: number,
    gracePeriodSec: number,
    geofenceCenter: string,
    geofenceRadiusM: number,
    nonceSeedHash: string,
  ): Promise<string> {
    const key = sessionKey(ctx, sessionID);
    if (await exists(ctx, key)) {
      fail('SESSION_EXISTS', `a session with id "${sessionID}" already exists`);
    }

    const faculty = await readJson<Identity>(ctx, identityKey(ctx, facultyID));
    if (!faculty) fail('FACULTY_NOT_FOUND', `no identity with id "${facultyID}"`);
    if (faculty.status !== 'active') {
      fail('FACULTY_NOT_ACTIVE', `identity "${facultyID}" is ${faculty.status}`);
    }
    if (faculty.role !== 'faculty') {
      fail('NOT_FACULTY', `identity "${facultyID}" has role "${faculty.role}"`);
    }

    const startMs = Date.parse(startTime);
    if (Number.isNaN(startMs)) {
      fail('INVALID_START_TIME', `startTime must be an ISO-8601 instant (got "${startTime}")`);
    }

    const duration = Number(durationSec);
    if (!Number.isInteger(duration) || duration <= 0 || duration > MAX_SESSION_DURATION_SEC) {
      fail('INVALID_DURATION',
        `durationSec must be an integer in 1..${MAX_SESSION_DURATION_SEC} (got ${durationSec})`);
    }

    const grace = Number(gracePeriodSec);
    if (!Number.isInteger(grace) || grace < 0) {
      fail('INVALID_GRACE_PERIOD', 'gracePeriodSec must be a non-negative integer');
    }

    if (!isSha256Hex(nonceSeedHash)) {
      fail('INVALID_SEED_HASH', 'nonceSeedHash must be a 64-character hex sha256 digest');
    }

    const geo = parseGeofence(geofenceCenter);
    const radius = Number(geofenceRadiusM);
    if (!Number.isInteger(radius) || radius <= 0) {
      fail('INVALID_GEOFENCE', 'geofenceRadiusM must be a positive integer');
    }

    const session: Session = {
      sessionID,
      courseID,
      facultyID,
      room,
      startTime: new Date(startMs).toISOString(),
      createdAt: txTimestampIso(ctx),
      durationSec: duration,
      gracePeriodSec: grace,
      geofenceCenter: geo,
      geofenceRadiusM: radius,
      nonceSeedHash,
      status: 'open',
    };

    await ctx.stub.putState(key, Buffer.from(canonicalize(session)));
    return canonicalize(session);
  }

  /**
   * Returns the session with a verification state derived at read time, so a
   * session past its grace period is never reported as healthy merely
   * because nobody has invoked expireSession. Spec section 5.4.
   */
  @Transaction(false)
  @Returns('string')
  public async getSession(ctx: Context, sessionID: string): Promise<string> {
    const session = await this.load(ctx, sessionID);
    return canonicalize({
      ...session,
      verificationState: verificationStateOf(session, txTimestampMs(ctx)),
    });
  }

  protected async load(ctx: Context, sessionID: string): Promise<Session> {
    const session = await readJson<Session>(ctx, sessionKey(ctx, sessionID));
    if (!session) fail('SESSION_NOT_FOUND', `no session with id "${sessionID}"`);
    return session;
  }

  protected assertEndorsingOrg(ctx: Context): void {
    const msp = ctx.clientIdentity.getMSPID();
    if (!ENDORSING_MSPS.includes(msp)) {
      fail('UNAUTHORISED_ORG', `organisation "${msp}" may not perform this operation`);
    }
  }
}

function parseGeofence(raw: string): GeoPoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('INVALID_GEOFENCE', 'geofenceCenter must be JSON of the form {"lat":..,"lng":..}');
  }

  const point = parsed as Partial<{ lat: number; lng: number }>;
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    fail('INVALID_GEOFENCE', `lat must be within -90..90 (got ${point?.lat})`);
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    fail('INVALID_GEOFENCE', `lng must be within -180..180 (got ${point?.lng})`);
  }

  // Stored as integer microdegrees: canonical encoding rejects floats,
  // whose string formatting is not portable across platforms.
  return { latE7: toE7(lat), lngE7: toE7(lng) };
}

/** The instant after which a session can no longer be closed by revealing its seed. */
export function deadlineOf(session: Session): number {
  return Date.parse(session.startTime)
    + session.durationSec * 1000
    + session.gracePeriodSec * 1000;
}

export function verificationStateOf(session: Session, nowMs: number): VerificationState {
  if (session.status === 'closed') return 'verified';
  if (nowMs > deadlineOf(session)) return 'unverified';
  if (nowMs > Date.parse(session.startTime) + session.durationSec * 1000) {
    return 'awaiting_reveal';
  }
  return 'in_progress';
}
