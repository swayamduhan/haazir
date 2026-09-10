import { Context } from 'fabric-contract-api';
import {
  commitSeed, deriveNonce, DeviceKeyPair, generateDeviceKeyPair, GeoPoint,
  sha256Hex, signAttendance, toE7, windowFor,
} from '@haazir/shared';

import { AttendanceRecorder } from '../../src/contracts/attendance-recorder';
import { CourseRoster } from '../../src/contracts/course-roster';
import { PolicyEngine } from '../../src/contracts/policy-engine';
import { IdentityRegistry } from '../../src/contracts/identity-registry';
import { SessionManager } from '../../src/contracts/session-manager';
import { makeContext, nextTx } from './mock-context';

export const SEED = 'ab'.repeat(32);
export const SEED_HASH = commitSeed(SEED);
export const START = '2026-09-09T10:00:00.000Z';
export const START_MS = Date.parse(START);
export const COURSE = 'CS101';
export const SESSION_ID = 'S1';
export const RADIUS_M = 50;
export const LIVENESS = sha256Hex('liveness-match-ok');

export const CENTRE: GeoPoint = { latE7: toE7(12.9716), lngE7: toE7(77.5946) };
export const GEOFENCE_JSON = JSON.stringify({ lat: 12.9716, lng: 77.5946 });

/** A point `metres` due north of the geofence centre. 1e-7 degree is 11.132 mm. */
export const northOf = (metres: number): GeoPoint => ({
  latE7: CENTRE.latE7 + Math.round((metres * 1000) / 11.132),
  lngE7: CENTRE.lngE7,
});

export const registry = () => new IdentityRegistry();
export const sessions = () => new SessionManager();
export const roster = () => new CourseRoster();
export const recorder = () => new AttendanceRecorder();
export const policy = () => new PolicyEngine();

export interface Fixture {
  ctx: Context;
  facultyID: string;
  studentID: string;
  device: DeviceKeyPair;
}

/**
 * A faculty member, one enrolled student holding a device key, and an open
 * session — the minimum state in which marking attendance is meaningful.
 */
export async function openSession(): Promise<Fixture> {
  let ctx = makeContext({ txId: 'tx-faculty', timestampMs: START_MS });
  const facultyID = await registry()
    .registerIdentity(ctx, sha256Hex('faculty-1'), 'a'.repeat(64), 'faculty');

  const device = generateDeviceKeyPair();
  ctx = nextTx(ctx, { txId: 'tx-student', timestampMs: START_MS });
  const studentID = await registry()
    .registerIdentity(ctx, sha256Hex('student-1'), device.publicKeyHex, 'student');

  ctx = nextTx(ctx, { txId: 'tx-enrol', timestampMs: START_MS });
  await roster().enrolStudent(ctx, COURSE, studentID);

  ctx = nextTx(ctx, { txId: 'tx-session', timestampMs: START_MS });
  await sessions().createSession(
    ctx, SESSION_ID, COURSE, facultyID, 'LH-3', START,
    3600, 900, GEOFENCE_JSON, RADIUS_M, SEED_HASH,
  );

  return { ctx, facultyID, studentID, device };
}

/** Enrols an extra student with their own device key. */
export async function addStudent(
  base: Context,
  label: string,
): Promise<{ ctx: Context; studentID: string; device: DeviceKeyPair }> {
  const device = generateDeviceKeyPair();
  let ctx = nextTx(base, { txId: `tx-id-${label}`, timestampMs: START_MS });
  const studentID = await registry()
    .registerIdentity(ctx, sha256Hex(label), device.publicKeyHex, 'student');

  ctx = nextTx(ctx, { txId: `tx-enrol-${label}`, timestampMs: START_MS });
  await roster().enrolStudent(ctx, COURSE, studentID);

  return { ctx, studentID, device };
}

export interface MarkOptions {
  txId?: string;
  atMs?: number;
  sessionID?: string;
  courseID?: string;
  location?: GeoPoint;
  livenessHash?: string;
  /** Overrides the window the device claims, without changing the clock. */
  claimedWindow?: number;
  /** Overrides the nonce the device claims, leaving the signature consistent. */
  claimedNonce?: string;
  /** The seed backing this session's nonces. Defaults to the fixture's. */
  seed?: string;
  /** The session's scheduled start, which anchors the window epoch. */
  sessionStartMs?: number;
  /** Signs with this key instead of the student's registered one. */
  signWith?: DeviceKeyPair;
  /** Replaces the signature after it is produced. */
  signature?: string;
}

/**
 * Signs and submits one attendance mark, defaulting every field to a valid
 * value so a test can vary exactly one of them.
 */
export async function mark(
  base: Context,
  studentID: string,
  device: DeviceKeyPair,
  options: MarkOptions = {},
): Promise<{ ctx: Context; result: string }> {
  const {
    txId = `tx-mark-${studentID}`,
    atMs = START_MS + 70_000,
    sessionID = SESSION_ID,
    courseID = COURSE,
    location = northOf(20),
    livenessHash = LIVENESS,
    seed = SEED,
    sessionStartMs = START_MS,
    signWith = device,
  } = options;

  const window = options.claimedWindow ?? windowFor(atMs, sessionStartMs);
  const claimedNonce = options.claimedNonce ?? deriveNonce(seed, window);

  const signature = options.signature ?? signAttendance(signWith.privateKey, {
    sessionID,
    studentID,
    courseID,
    claimedWindow: window,
    claimedNonce,
    latE7: location.latE7,
    lngE7: location.lngE7,
    livenessHash,
  });

  const ctx = nextTx(base, { txId, timestampMs: atMs });
  const result = await recorder().markAttendance(
    ctx, sessionID, studentID, window, claimedNonce,
    location.latE7, location.lngE7, livenessHash, signature,
  );
  return { ctx, result };
}

/** Each session gets its own seed, derived from its id so tests stay readable. */
export const seedFor = (sessionID: string): string => sha256Hex(`seed-${sessionID}`);

export interface Attendee {
  studentID: string;
  device: DeviceKeyPair;
  /** Claims a nonce the seed will not produce, to be caught by the sweep. */
  forge?: boolean;
}

export interface SessionRun {
  id: string;
  startMs: number;
  attend?: Attendee[];
  /** How the session ends. `open` leaves it running. */
  conclude?: 'close' | 'expire' | 'open';
}

/**
 * Opens a course session, marks the given students, and concludes it — one
 * class meeting, as eligibility arithmetic sees it.
 */
export async function runSession(
  base: Context,
  facultyID: string,
  run: SessionRun,
): Promise<Context> {
  const { id, startMs, attend = [], conclude = 'close' } = run;
  const seed = seedFor(id);

  let ctx = nextTx(base, { txId: `tx-open-${id}`, timestampMs: startMs });
  await sessions().createSession(
    ctx, id, COURSE, facultyID, 'LH-3', new Date(startMs).toISOString(),
    3600, 900, GEOFENCE_JSON, RADIUS_M, commitSeed(seed),
  );

  const atMs = startMs + 70_000;
  for (const a of attend) {
    ({ ctx } = await mark(ctx, a.studentID, a.device, {
      txId: `tx-mark-${id}-${a.studentID}`,
      atMs,
      sessionID: id,
      seed,
      sessionStartMs: startMs,
      claimedNonce: a.forge ? 'de'.repeat(32) : undefined,
    }));
  }

  if (conclude === 'close') {
    ctx = nextTx(ctx, { txId: `tx-close-${id}`, timestampMs: startMs + 600_000 });
    await sessions().closeSession(ctx, id, seed);
  } else if (conclude === 'expire') {
    ctx = nextTx(ctx, { txId: `tx-expire-${id}`, timestampMs: startMs + 5_000_000 });
    await sessions().expireSession(ctx, id);
  }

  return ctx;
}
