import { randomBytes } from 'crypto';
import {
  commitSeed, deriveNonce, DeviceKeyPair, generateDeviceKeyPair, sha256Hex,
  signAttendance, toE7, windowFor,
} from '@haazir/shared';

/**
 * End-to-end check of the REST API against the live network, through HTTP
 * alone: what a browser or mobile client would actually see.
 *
 *   API=http://localhost:3000 npm run smoke --workspace @haazir/backend
 */
const BASE = process.env.API ?? 'http://localhost:3000';
const COURSE = `CS-${randomBytes(2).toString('hex')}`;
const CENTRE = { lat: 12.9716, lng: 77.5946 };
const hex = (n: number) => randomBytes(n).toString('hex');

let failures = 0;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

function check(label: string, actual: number, expected: number, code?: string, got?: string) {
  const ok = actual === expected && (code === undefined || code === got);
  if (!ok) failures += 1;
  const tail = code ? `  ${got ?? ''}` : '';
  console.log(`  ${ok ? '[ok]  ' : '[FAIL]'} ${String(actual).padEnd(4)} ${label}${tail}`
    + (ok ? '' : `   (expected ${expected}${code ? ` ${code}` : ''})`));
}

async function enrolStudent(): Promise<{ id: string; device: DeviceKeyPair }> {
  const device = generateDeviceKeyPair();
  const r = await call('POST', '/identities', {
    identityHash: sha256Hex(`api-smoke-${hex(8)}`), publicKey: device.publicKeyHex, role: 'student',
  });
  await call('POST', `/courses/${COURSE}/roster`, { studentID: r.body.identityID });
  return { id: r.body.identityID, device };
}

function signedMark(
  sessionID: string, studentID: string, device: DeviceKeyPair,
  seed: string, startMs: number, location = { lat: CENTRE.lat, lng: CENTRE.lng },
) {
  const claimedWindow = windowFor(Date.now(), startMs);
  const claim = {
    sessionID, studentID, courseID: COURSE, claimedWindow,
    claimedNonce: deriveNonce(seed, claimedWindow),
    latE7: toE7(location.lat), lngE7: toE7(location.lng),
    livenessHash: sha256Hex(`liveness-${studentID}`),
  };
  return {
    studentID, claimedWindow, claimedNonce: claim.claimedNonce,
    latE7: claim.latE7, lngE7: claim.lngE7, livenessHash: claim.livenessHash,
    deviceSignature: signAttendance(device.privateKey, claim),
  };
}

async function main(): Promise<void> {
  console.log(`API smoke test against ${BASE}, course ${COURSE}\n`);

  const health = await call('GET', '/health');
  check('GET /health', health.status, 200);

  const faculty = await call('POST', '/identities', {
    identityHash: sha256Hex(`api-smoke-fac-${hex(8)}`), publicKey: hex(32), role: 'faculty',
  });
  check('register a faculty identity', faculty.status, 201);

  const alice = await enrolStudent();
  const bob = await enrolStudent();
  const read = await call('GET', `/identities/${alice.id}`);
  check('read an identity back', read.status, 200);

  const seed = hex(32);
  const startTime = new Date().toISOString();
  const startMs = Date.parse(startTime);
  const sessionID = `S-${hex(4)}`;
  const session = {
    sessionID, courseID: COURSE, facultyID: faculty.body.identityID, room: 'LH-3',
    startTime, durationSec: 3600, gracePeriodSec: 900,
    geofenceCenter: CENTRE, geofenceRadiusM: 50, nonceSeedHash: commitSeed(seed),
  };

  const leaky = await call('POST', '/sessions', { ...session, seed });
  check('refuse a session request that carries the seed', leaky.status, 400,
    'SEED_MUST_NOT_BE_SENT', leaky.body?.error?.code);

  const opened = await call('POST', '/sessions', session);
  check('open a session with the seed hash only', opened.status, 201);

  const marked = await call('POST', `/sessions/${sessionID}/attendance`,
    signedMark(sessionID, alice.id, alice.device, seed, startMs));
  check('mark attendance with a device-signed claim', marked.status, 201);

  const again = await call('POST', `/sessions/${sessionID}/attendance`,
    signedMark(sessionID, alice.id, alice.device, seed, startMs));
  check('refuse a second mark', again.status, 409, 'DUPLICATE_ATTENDANCE', again.body?.error?.code);

  const far = await call('POST', `/sessions/${sessionID}/attendance`,
    signedMark(sessionID, bob.id, bob.device, seed, startMs, { lat: CENTRE.lat + 0.003, lng: CENTRE.lng }));
  check('refuse a mark from outside the geofence', far.status, 422,
    'OUTSIDE_GEOFENCE', far.body?.error?.code);

  const forged = await call('POST', `/sessions/${sessionID}/attendance`,
    { ...signedMark(sessionID, bob.id, alice.device, seed, startMs) });
  check('refuse a mark signed by someone else’s device', forged.status, 422,
    'INVALID_SIGNATURE', forged.body?.error?.code);

  const wrongSeed = await call('POST', `/sessions/${sessionID}/close`, { revealedSeed: hex(32) });
  check('refuse to close with the wrong seed', wrongSeed.status, 422,
    'SEED_COMMITMENT_MISMATCH', wrongSeed.body?.error?.code);

  const closed = await call('POST', `/sessions/${sessionID}/close`, { revealedSeed: seed });
  check('close with the committed seed', closed.status, 200);

  const audit = await call('GET', `/sessions/${sessionID}/nonce-audit`);
  check('read the nonce audit written at close', audit.status, 200);
  if (audit.body?.validCount !== 1) {
    failures += 1;
    console.log(`  [FAIL]      expected one verified claim, audit says ${JSON.stringify(audit.body)}`);
  }

  const eligibility = await call('GET', `/courses/${COURSE}/students/${alice.id}/eligibility`);
  check('compute eligibility on chain', eligibility.status, 200);

  const missing = await call('GET', '/sessions/does-not-exist');
  check('report a missing session as 404', missing.status, 404,
    'SESSION_NOT_FOUND', missing.body?.error?.code);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('smoke test could not run:', err instanceof Error ? err.message : err);
  process.exit(1);
});
