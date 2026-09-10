import { randomBytes } from 'crypto';
import {
  attendancePayload, commitSeed, deriveNonce, DeviceKeyPair, generateDeviceKeyPair,
  hashPublicKey, NonceAudit, sha256Hex, signAttendance, toE7, windowFor,
} from '@haazir/shared';
import { connect } from '../gateway';

const line = (s = '') => console.log(s);
const rule = (n: number, title: string) => {
  line();
  line('='.repeat(72));
  line(`  ${n}. ${title}`);
  line('='.repeat(72));
};
const ok = (s: string) => line(`  [ok]   ${s}`);
const bad = (s: string) => line(`  [FAIL] ${s}`);
const info = (s: string) => line(`         ${s}`);

const hex = (n: number) => randomBytes(n).toString('hex');

const CENTRE = { latE7: toE7(12.9716), lngE7: toE7(77.5946) };
const COURSE = 'CS101';

/** A point `metres` due north of the centre. 1e-7 degree of latitude is 11.132 mm. */
const northOf = (metres: number) => ({
  latE7: CENTRE.latE7 + Math.round((metres * 1000) / 11.132),
  lngE7: CENTRE.lngE7,
});

interface MarkArgs {
  sessionId: string;
  studentId: string;
  device: DeviceKeyPair;
  window: number;
  nonce: string;
  location?: { latE7: number; lngE7: number };
}

/** Signs on the "device", then submits exactly what the device produced. */
function markArgs(a: MarkArgs): string[] {
  const location = a.location ?? CENTRE;
  const livenessHash = sha256Hex(`liveness-${a.studentId}`);
  const claim = {
    sessionID: a.sessionId,
    studentID: a.studentId,
    courseID: COURSE,
    claimedWindow: a.window,
    claimedNonce: a.nonce,
    latE7: location.latE7,
    lngE7: location.lngE7,
    livenessHash,
  };
  // Proof the payload is one definition, not two that intend to agree.
  void attendancePayload(claim);

  return [
    a.sessionId, a.studentId, String(a.window), a.nonce,
    String(location.latE7), String(location.lngE7), livenessHash,
    signAttendance(a.device.privateKey, claim),
  ];
}

async function main(): Promise<void> {
  const gw = await connect('registrar');
  const identities = gw.contract('IdentityRegistry');
  const sessions = gw.contract('SessionManager');
  const roster = gw.contract('CourseRoster');
  const attendance = gw.contract('AttendanceRecorder');

  try {
    rule(1, 'Enrol a student, holding a real ed25519 device key');
    const lostPhone = generateDeviceKeyPair();
    const studentId = await identities.submit(
      'registerIdentity', sha256Hex(`student-${hex(8)}`), lostPhone.publicKeyHex, 'student');
    ok(`identityID = ${studentId}`);
    info('Derived from the transaction id, not randomly: every endorsing peer');
    info('executes independently and must produce byte-identical output.');

    rule(2, 'Read the identity back from the ledger');
    info(await identities.evaluate('getIdentityStatus', studentId));
    info('No PII on chain — identityHash is a salted hash computed off-chain.');

    rule(3, 'The phone is lost. Rotate to a new device key');
    const phone = generateDeviceKeyPair();
    await identities.submit('revokeAndReissueKey', studentId,
      hashPublicKey(lostPhone.publicKeyHex), phone.publicKeyHex, 'lost_device');
    ok('revocation event recorded; the old key is no longer the active one');

    rule(4, 'Enrol faculty and open a session');
    const facultyId = await identities.submit(
      'registerIdentity', sha256Hex(`faculty-${hex(8)}`), hex(32), 'faculty');
    ok(`facultyID = ${facultyId}`);

    // The seed never leaves this process. Only its hash goes on chain.
    const seed = hex(32);
    const seedHash = commitSeed(seed);
    const sessionId = `S-${hex(4)}`;
    const startTime = new Date(Date.now() - 60_000).toISOString();
    const startMs = Date.parse(startTime);

    await sessions.submit('createSession', sessionId, COURSE, facultyId, 'LH-3',
      startTime, '3600', '900', JSON.stringify({ lat: 12.9716, lng: 77.5946 }),
      '50', seedHash);
    ok(`session ${sessionId} open`);
    info(`committed seed hash = ${seedHash}`);
    info('The seed itself has not been transmitted.');

    rule(5, 'Put the student on the course roster');
    await roster.submit('enrolStudent', COURSE, studentId);
    ok(`isEnrolled = ${await roster.evaluate('isEnrolled', COURSE, studentId)}`);
    info('On chain, not in an SIS lookup: a check the contract never sees is a');
    info('check a bypassed client skips. ADR-015.');

    rule(6, 'Derive rotating nonces locally — no ledger interaction');
    const w = windowFor(Date.now(), startMs);
    for (const each of [w - 1, w, w + 1]) {
      info(`window ${each}: ${deriveNonce(seed, each).slice(0, 40)}...`);
    }
    info('Rotation costs zero transactions. A screenshot expires in 10 seconds.');

    rule(7, 'NEGATIVE — mark attendance from outside the geofence');
    try {
      await attendance.submit('markAttendance', ...markArgs({
        sessionId, studentId, device: phone,
        window: windowFor(Date.now(), startMs),
        nonce: deriveNonce(seed, windowFor(Date.now(), startMs)),
        location: northOf(300),
      }));
      bad('accepted a submission from 300 m away');
      process.exitCode = 1;
    } catch (err) {
      ok(`rejected: ${(err as Error).message}`);
      info('Distance is computed in integers. Haversine calls Math.sin/cos, which');
      info('ECMAScript leaves implementation-approximated — two peers could');
      info('legitimately disagree at the boundary. ADR-018.');
    }

    rule(8, 'NEGATIVE — mark attendance signed by the LOST phone');
    try {
      await attendance.submit('markAttendance', ...markArgs({
        sessionId, studentId, device: lostPhone,
        window: windowFor(Date.now(), startMs),
        nonce: deriveNonce(seed, windowFor(Date.now(), startMs)),
      }));
      bad('accepted a signature from a revoked key');
      process.exitCode = 1;
    } catch (err) {
      ok(`rejected: ${(err as Error).message}`);
      info('The stolen device can still sign. The registry no longer trusts it.');
    }

    rule(9, 'Mark attendance from the enrolled device, inside the geofence');
    const markWindow = windowFor(Date.now(), startMs);
    const record = JSON.parse(await attendance.submit('markAttendance', ...markArgs({
      sessionId, studentId, device: phone,
      window: markWindow, nonce: deriveNonce(seed, markWindow),
    })));
    ok(`recordID = ${record.recordID}, status = ${record.status}`);
    info(`claimed window ${record.claimedWindow}, nonce ${record.claimedNonce.slice(0, 24)}...`);
    info('The nonce is RECORDED, not verified: the seed is still secret. The');
    info('contract has nothing to compare against until the session closes.');

    rule(10, 'NEGATIVE — mark a second time in the same session');
    try {
      const again = windowFor(Date.now(), startMs);
      await attendance.submit('markAttendance', ...markArgs({
        sessionId, studentId, device: phone, window: again, nonce: deriveNonce(seed, again),
      }));
      bad('accepted a duplicate');
      process.exitCode = 1;
    } catch (err) {
      ok(`rejected: ${(err as Error).message}`);
      info('An exact-key read, so it is in the read set and MVCC protects it.');
      info('A CouchDB rich query would not be revalidated at commit. Defect C6.');
    }

    rule(11, 'A second student forges a nonce, and it is accepted');
    const cheatPhone = generateDeviceKeyPair();
    const cheatId = await identities.submit(
      'registerIdentity', sha256Hex(`student-${hex(8)}`), cheatPhone.publicKeyHex, 'student');
    await roster.submit('enrolStudent', COURSE, cheatId);

    const forged = 'de'.repeat(32);
    const cheatWindow = windowFor(Date.now(), startMs);
    await attendance.submit('markAttendance', ...markArgs({
      sessionId, studentId: cheatId, device: cheatPhone,
      window: cheatWindow, nonce: forged,
    }));
    ok(`${cheatId} marked present with a nonce it invented`);
    info('Nothing on chain can detect this yet. That is not a gap being hidden —');
    info('it is the cost of keeping the seed off chain, and it is about to be paid.');

    rule(12, 'Correct a record — append-only, never an edit');
    await attendance.submit('correctAttendance', sessionId, studentId,
      'absent', 'demo: left the hall immediately after marking');
    const view = JSON.parse(await attendance.evaluate('getAttendance', sessionId, studentId));
    ok(`current status = ${view.current.status} (seq ${view.current.seq})`);
    info(`history: ${view.history.map((r: any) => `${r.seq}:${r.status}`).join(' -> ')}`);
    info(`seq 0 still reads "${view.history[0].status}" and still carries its signature.`);
    info('The original was not touched. ADR-006.');

    rule(13, 'NEGATIVE — close the session with the WRONG seed');
    try {
      await sessions.submit('closeSession', sessionId, hex(32));
      bad('accepted a seed that did not match the commitment');
      process.exitCode = 1;
    } catch (err) {
      ok(`rejected: ${(err as Error).message}`);
      info('The faculty cannot retrofit a seed after seeing submissions.');
    }

    rule(14, 'Close with the CORRECT seed — nonces are adjudicated here');
    const closed = JSON.parse(await sessions.submit('closeSession', sessionId, seed));
    ok(`status = ${closed.status}`);
    info(`revealed seed = ${closed.revealedSeed}`);
    info(`sweep: ${JSON.stringify(closed.nonceAudit)}`);

    rule(15, 'The forged nonce is now exposed, by consensus');
    const audit: NonceAudit = JSON.parse(
      await attendance.evaluate('getNonceAudit', sessionId));
    for (const v of audit.verdicts) {
      // Not bad(): a detected forgery is the demo succeeding, not failing.
      const mark = v.valid ? '[ok]    ' : '[caught]';
      line(`  ${mark} ${v.studentID}  window ${v.claimedWindow}  `
        + `${v.valid ? 'nonce matched' : 'NONCE FORGED'}`);
      if (!v.valid) {
        info(`  claimed  ${v.claimedNonce.slice(0, 48)}...`);
        info(`  expected ${v.expectedNonce.slice(0, 48)}...`);
      }
    }
    if (audit.invalidCount !== 1) {
      bad(`expected exactly one forged claim, found ${audit.invalidCount}`);
      process.exitCode = 1;
    }

    rule(16, 'The session reports what it can actually prove');
    const finalState = JSON.parse(await sessions.evaluate('getSession', sessionId));
    ok(`verificationState = ${finalState.verificationState}`);
    if (finalState.verificationState !== 'disputed') {
      bad('a session containing a forged claim must not read as verified');
      process.exitCode = 1;
    }
    info('"verified" would have been a lie: the seed was revealed honestly, but');
    info('one submission was not fresh. Both facts are on the ledger.');

    rule(17, 'Anyone can recheck all of it, holding only the ledger');
    const recomputed = deriveNonce(finalState.revealedSeed, markWindow);
    if (recomputed === deriveNonce(seed, markWindow)) {
      ok('recomputed the nonce from the revealed seed — no trusted server needed');
    } else {
      bad('MISMATCH');
      process.exitCode = 1;
    }

    line();
    line('='.repeat(72));
    line('  Demo complete.');
    line('='.repeat(72));
  } finally {
    gw.close();
  }
}

main().catch((err) => {
  console.error('\nDemo failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
