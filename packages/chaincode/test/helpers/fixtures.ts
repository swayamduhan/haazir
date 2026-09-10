import { Context } from 'fabric-contract-api';
import {
  commitSeed, deriveNonce, DeviceKeyPair, generateDeviceKeyPair, GeoPoint,
  sha256Hex, signAttendance, toE7, windowFor,
} from '@haazir/shared';
import { AttendanceRecorder } from '../../src/contracts/attendance-recorder';
import { CourseRoster } from '../../src/contracts/course-roster';
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
    signWith = device,
  } = options;

  const window = options.claimedWindow ?? windowFor(atMs, START_MS);
  const claimedNonce = options.claimedNonce ?? deriveNonce(SEED, window);

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
