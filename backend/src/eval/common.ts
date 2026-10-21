import { randomBytes } from 'crypto';
import {
  commitSeed, deriveNonce, DeviceKeyPair, generateDeviceKeyPair, sha256Hex,
  signAttendance, toE7, windowFor,
} from '@haazir/shared';
import { OrgName } from '../config';
import { connect, ConnectOptions, ContractHandle, FabricFailure, GatewayHandle } from '../gateway';

export const CENTRE = { lat: 12.9692, lng: 79.1559 };
export const hex = (n: number) => randomBytes(n).toString('hex');

export interface Ledger {
  gw: GatewayHandle;
  identities: ContractHandle;
  sessions: ContractHandle;
  roster: ContractHandle;
  attendance: ContractHandle;
  policy: ContractHandle;
}

export async function ledger(org: OrgName = 'registrar', options: ConnectOptions = {}): Promise<Ledger> {
  const gw = await connect(org, options);
  return {
    gw,
    identities: gw.contract('IdentityRegistry'),
    sessions: gw.contract('SessionManager'),
    roster: gw.contract('CourseRoster'),
    attendance: gw.contract('AttendanceRecorder'),
    policy: gw.contract('PolicyEngine'),
  };
}

export async function newFaculty(l: Ledger): Promise<string> {
  return l.identities.submit('registerIdentity', sha256Hex(`eval-fac-${hex(8)}`), hex(32), 'faculty');
}

export interface Student { id: string; device: DeviceKeyPair; identityHash: string }

export async function newStudent(l: Ledger, course: string): Promise<Student> {
  const device = generateDeviceKeyPair();
  const identityHash = sha256Hex(`eval-stu-${hex(8)}`);
  const id = await l.identities.submit('registerIdentity', identityHash, device.publicKeyHex, 'student');
  await l.roster.submit('enrolStudent', course, id);
  return { id, device, identityHash };
}

export interface Session { id: string; course: string; seed: string; startMs: number }

export async function openSession(
  l: Ledger, facultyId: string, course: string,
  { startMs = Date.now(), durationSec = 3600, graceSec = 900, radiusM = 50 } = {},
): Promise<Session> {
  const s: Session = { id: `E-${hex(4)}`, course, seed: hex(32), startMs };
  await l.sessions.submit('createSession', s.id, course, facultyId, 'EVAL', new Date(startMs).toISOString(),
    String(durationSec), String(graceSec), JSON.stringify(CENTRE), String(radiusM), commitSeed(s.seed));
  return s;
}

export interface MarkOptions {
  window?: number;
  nonce?: string;
  /** Metres north of the geofence centre. */
  metres?: number;
  /** Sign with a different key than the student's own. */
  signWith?: DeviceKeyPair;
  /** Submit the (validly signed) claim to a different session id. */
  submitTo?: string;
}

/** Arguments for markAttendance, signed the way a phone signs them. */
export function markArgs(s: Session, st: Student, o: MarkOptions = {}): string[] {
  // Clamped: WSL2 occasionally steps its clock backwards when it resyncs with
  // the host, which would otherwise put 'now' before a session just opened.
  const window = o.window ?? windowFor(Math.max(Date.now(), s.startMs), s.startMs);
  const claim = {
    sessionID: s.id, studentID: st.id, courseID: s.course, claimedWindow: window,
    claimedNonce: o.nonce ?? deriveNonce(s.seed, window),
    latE7: toE7(CENTRE.lat + (o.metres ?? 5) / 111_320), lngE7: toE7(CENTRE.lng),
    livenessHash: sha256Hex(`liveness-${st.id}-${s.id}`),
  };
  const sig = signAttendance((o.signWith ?? st.device).privateKey, claim);
  return [o.submitTo ?? s.id, st.id, String(window), claim.claimedNonce,
    String(claim.latE7), String(claim.lngE7), claim.livenessHash, sig];
}

export interface Outcome { accepted: boolean; code: string; result?: string }

/** Runs a ledger call and reports what happened instead of throwing. */
export async function attempt(fn: () => Promise<string>): Promise<Outcome> {
  try {
    return { accepted: true, code: 'ACCEPTED', result: await fn() };
  } catch (err) {
    const f = (err as { fabric?: FabricFailure }).fabric;
    return { accepted: false, code: f?.code ?? 'ERROR', result: f?.detail ?? (err as Error).message };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
