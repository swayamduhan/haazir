import { randomBytes } from 'crypto';
import {
  attendancePayload, commitSeed, deriveNonce, DeviceKeyPair, EligibilityReport,
  generateDeviceKeyPair, hashPublicKey, NonceAudit, sha256Hex, signAttendance,
  toE7, windowFor,
} from '@haazir/shared';
import { ContractHandle, GatewayHandle } from '../gateway';
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
  courseId?: string;
  location?: { latE7: number; lngE7: number };
}

/** Signs on the "device", then submits exactly what the device produced. */
function markArgs(a: MarkArgs): string[] {
  const location = a.location ?? CENTRE;
  const livenessHash = sha256Hex(`liveness-${a.studentId}-${a.sessionId}`);
  const claim = {
    sessionID: a.sessionId,
    studentID: a.studentId,
    courseID: a.courseId ?? COURSE,
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
  const policy = gw.contract('PolicyEngine');

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

    rule(4, 'Enrol faculty, and put the student on the course roster');
    const facultyId = await identities.submit(
      'registerIdentity', sha256Hex(`faculty-${hex(8)}`), hex(32), 'faculty');
    ok(`facultyID = ${facultyId}`);

    await roster.submit('enrolStudent', COURSE, studentId);
    ok(`isEnrolled = ${await roster.evaluate('isEnrolled', COURSE, studentId)}`);
    info('On chain, not in an SIS lookup: a check the contract never sees is a');
    info('check a bypassed client skips. ADR-015.');
    info('Enrolment comes first, because sessions that ran before a student');
    info('joined are not theirs to attend and do not count against them.');

    rule(5, 'Open a session, committing to a seed without revealing it');
    // The seed never leaves this process. Only its hash goes on chain.
    const seed = hex(32);
    const seedHash = commitSeed(seed);
    const sessionId = `S-${hex(4)}`;
    const startTime = new Date().toISOString();
    const startMs = Date.parse(startTime);

    await sessions.submit('createSession', sessionId, COURSE, facultyId, 'LH-3',
      startTime, '3600', '900', JSON.stringify({ lat: 12.9716, lng: 77.5946 }),
      '50', seedHash);
    ok(`session ${sessionId} open`);
    info(`committed seed hash = ${seedHash}`);
    info('The seed itself has not been transmitted.');

    rule(6, 'Derive rotating nonces locally — no ledger interaction');
    for (const each of [0, 1, 2]) {
      info(`window ${each}: ${deriveNonce(seed, each).slice(0, 40)}...`);
    }
    info(`current window = ${windowFor(Date.now(), startMs)}`);
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

    await term(gw, identities, roster, sessions, attendance, policy, facultyId);

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

const TERM_COURSE = 'CS102';
const GEOFENCE = JSON.stringify({ lat: 12.9716, lng: 77.5946 });

/** Opens one class meeting, marks the given students, and closes it. */
async function meeting(
  sessions: ContractHandle,
  attendance: ContractHandle,
  facultyId: string,
  id: string,
  attendees: { studentId: string; device: DeviceKeyPair }[],
): Promise<void> {
  const seed = hex(32);
  const startTime = new Date().toISOString();

  await sessions.submit('createSession', id, TERM_COURSE, facultyId, 'LH-7',
    startTime, '3600', '900', GEOFENCE, '50', commitSeed(seed));

  for (const a of attendees) {
    const window = windowFor(Date.now(), Date.parse(startTime));
    await attendance.submit('markAttendance', ...markArgs({
      sessionId: id, studentId: a.studentId, device: a.device,
      courseId: TERM_COURSE, window, nonce: deriveNonce(seed, window),
    }));
  }

  await sessions.submit('closeSession', id, seed);
}

function showReport(r: EligibilityReport): void {
  const pct = (r.attendancePercentBp / 100).toFixed(2);
  info(`sessions held        ${r.sessionsHeld}`);
  info(`counted (denominator)${String(r.sessionsCounted).padStart(2)}`);
  info(`present              ${r.present}   (verified by nonce: ${r.presentVerified})`);
  info(`credited by exemption${String(r.creditedByExemption).padStart(2)}`);
  info(`excused from total   ${r.exempted}`);
  info(`voided, forged nonce ${r.rejectedForNonce}`);
  info(`attendance           ${pct}%  (${r.attendancePercentBp} basis points)`);
}

/**
 * A term's worth of meetings, and the number that decides whether the student
 * sits the examination.
 */
async function term(
  _gw: GatewayHandle,
  identities: ContractHandle,
  roster: ContractHandle,
  sessions: ContractHandle,
  attendance: ContractHandle,
  policy: ContractHandle,
  facultyId: string,
): Promise<void> {
  rule(18, `A full term of ${TERM_COURSE}: four meetings, two attended`);
  const device = generateDeviceKeyPair();
  const studentId = await identities.submit(
    'registerIdentity', sha256Hex(`term-${hex(8)}`), device.publicKeyHex, 'student');
  await roster.submit('enrolStudent', TERM_COURSE, studentId);
  ok(`student ${studentId} enrolled in ${TERM_COURSE}`);

  const ids = [1, 2, 3, 4].map((n) => `W${n}-${hex(3)}`);
  for (const [n, id] of ids.entries()) {
    await meeting(sessions, attendance, facultyId, id,
      n < 2 ? [{ studentId, device }] : []);
    info(`${id}: closed, student ${n < 2 ? 'present' : 'absent'}`);
  }

  rule(19, 'Eligibility, computed by the contract and not reported to it');
  const before: EligibilityReport = JSON.parse(
    await policy.evaluate('computeEligibility', TERM_COURSE, studentId));
  showReport(before);
  if (before.eligible) {
    bad('two of four should not clear a 75% threshold');
    process.exitCode = 1;
  } else {
    ok(`eligible = false, threshold ${before.thresholdBp / 100}%`);
  }
  info('Basis points, not a float: a percentage is exactly the value that');
  info('arrives as 74.99999999999999, and canonical encoding refuses it.');

  rule(20, 'The exam cell grants on-duty leave for the third meeting');
  const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  await policy.submit('applyExemption', TERM_COURSE, studentId, ids[2],
    'official_duty', 'counts_present', cid,
    'represented the college at an inter-collegiate fixture');
  ok(`exemption anchored to ${cid}`);
  info('The letter itself is not on chain. A CID is a hash of the content, so');
  info('it proves which document was filed while containing none of it —');
  info('delete the file and the anchor points at nothing. ADR-020.');

  rule(21, 'The same computation, one exemption later');
  const after: EligibilityReport = JSON.parse(
    await policy.evaluate('computeEligibility', TERM_COURSE, studentId));
  showReport(after);
  if (!after.eligible) {
    bad('three of four should clear a 75% threshold');
    process.exitCode = 1;
  } else {
    ok('eligible = true');
  }
  info('The credit is an exemption, not an attendance record: nothing was');
  info('written into the attendance history to make the arithmetic work, and');
  info('presentVerified still counts only what the nonce sweep confirmed.');
}
