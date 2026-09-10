import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import {
  canonicalize, commitSeed, GeoPoint, Identity, isSha256Hex,
  MAX_SESSION_DURATION_SEC, Session, toE7, VerificationState,
} from '@haazir/shared';
import { assertEndorsingOrg } from '../lib/authorisation';
import { fail } from '../lib/errors';
import { exists, identityKey, readJson, sessionKey } from '../lib/keys';
import { txTimestampIso, txTimestampMs } from '../lib/ledger-time';
import { sweepSessionNonces } from '../lib/nonce-sweep';

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

  /**
   * Closes a session by revealing the nonce seed.
   *
   * The hash comparison is the load-bearing check: presenting a seed other
   * than the one committed at creation is an attempt to retrofit nonces
   * after seeing submissions, and must be rejected. Once revealed, anyone
   * holding only the ledger can recompute every window's nonce and verify
   * any record without trusting a server. Spec sections 5.2 and 5.3.
   *
   * Caller authorisation is organisation-level for this milestone: binding
   * on-chain identity ids to X.509 client identities is unspecified and
   * deferred to Milestone 3. See ADR-013.
   */
  @Transaction()
  @Returns('string')
  public async closeSession(
    ctx: Context,
    sessionID: string,
    revealedSeed: string,
  ): Promise<string> {
    assertEndorsingOrg(ctx);

    const session = await this.load(ctx, sessionID);
    if (session.status !== 'open') {
      fail('SESSION_NOT_OPEN', `session "${sessionID}" is ${session.status}`);
    }

    let commitment: string;
    try {
      commitment = commitSeed(revealedSeed);
    } catch {
      fail('INVALID_SEED', 'revealedSeed must be 32-byte hex (64 lowercase hex characters)');
    }
    if (commitment !== session.nonceSeedHash) {
      fail('SEED_COMMITMENT_MISMATCH',
        'the revealed seed does not match the commitment made at session creation');
    }

    const nowMs = txTimestampMs(ctx);
    if (nowMs > deadlineOf(session)) {
      fail('GRACE_PERIOD_ELAPSED', `the reveal window for session "${sessionID}" has closed`);
    }

    session.revealedSeed = revealedSeed;
    session.status = 'closed';
    session.closedAt = txTimestampIso(ctx);
    session.closedBy = ctx.clientIdentity.getID();

    // Adjudicated here, in the same transaction as the reveal, so a session
    // cannot be closed without its nonce claims being checked — and both
    // endorsing organisations must agree on every verdict for it to commit.
    // This is the first and only moment the contract can do it: until now the
    // seed was on the faculty device. ADR-016.
    const audit = await sweepSessionNonces(ctx, session, revealedSeed);
    session.nonceAudit = {
      recordsChecked: audit.recordsChecked,
      validCount: audit.validCount,
      invalidCount: audit.invalidCount,
    };

    await ctx.stub.putState(sessionKey(ctx, sessionID), Buffer.from(canonicalize(session)));
    return canonicalize(session);
  }

  /**
   * Marks a session expired after its grace period elapsed with no valid
   * reveal, converting a silent forgery risk into an attributable failure.
   *
   * No caller restriction beyond the grace-period check is imposed. Ideally
   * the Audit organisation would invoke this alone, since it is the sanction
   * against the two interested parties; that requires per-function
   * endorsement and is deferred to Milestone 3. Spec section 5.4.
   */
  @Transaction()
  @Returns('string')
  public async expireSession(ctx: Context, sessionID: string): Promise<string> {
    const session = await this.load(ctx, sessionID);
    if (session.status !== 'open') {
      fail('SESSION_NOT_OPEN', `session "${sessionID}" is ${session.status}`);
    }

    const nowMs = txTimestampMs(ctx);
    if (nowMs <= deadlineOf(session)) {
      fail('GRACE_PERIOD_NOT_ELAPSED',
        `session "${sessionID}" may still be closed by revealing its seed`);
    }

    session.status = 'expired';
    session.expiredAt = txTimestampIso(ctx);
    session.expiredBy = ctx.clientIdentity.getID();

    await ctx.stub.putState(sessionKey(ctx, sessionID), Buffer.from(canonicalize(session)));
    return canonicalize(session);
  }

  protected async load(ctx: Context, sessionID: string): Promise<Session> {
    const session = await readJson<Session>(ctx, sessionKey(ctx, sessionID));
    if (!session) fail('SESSION_NOT_FOUND', `no session with id "${sessionID}"`);
    return session;
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
  if (session.status === 'closed') {
    // A revealed seed proves the faculty committed honestly. It does not
    // prove the submissions were fresh — that is what the sweep decided, and
    // reporting a session with failed nonce claims as "verified" would be the
    // single most misleading thing this contract could say.
    return (session.nonceAudit?.invalidCount ?? 0) > 0 ? 'disputed' : 'verified';
  }
  // A stored expiry is a fact and outranks the clock. Deriving this from time
  // alone was enough while sessions were only ever read after their deadline,
  // but it reported an already-expired session as in_progress to any reader
  // whose transaction carried an earlier timestamp.
  if (session.status === 'expired') return 'unverified';
  if (nowMs > deadlineOf(session)) return 'unverified';
  if (nowMs > Date.parse(session.startTime) + session.durationSec * 1000) {
    return 'awaiting_reveal';
  }
  return 'in_progress';
}
