import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { generateDeviceKeyPair, hashPublicKey, windowFor } from '@haazir/shared';
import { createApp } from '../api/app';
import {
  attempt, hex, ledger, markArgs, newFaculty, newStudent, openSession, Outcome,
} from './common';

/**
 * Executes every row of docs/threat-model.md that can be executed, against
 * the live three-organisation network, and records what actually happened.
 *
 *   npm run attacks --workspace @haazir/backend
 *
 * An attack "passes" when the system responds as the threat model claims:
 * rejected with the named code, or accepted-then-detected where that is the
 * design. Rows that cannot be exercised in software are listed as open,
 * because leaving them out would overstate what has been tested.
 */
interface Row {
  row: string;
  attack: string;
  expected: string;
  observed: string;
  pass: boolean | null;
}

const rows: Row[] = [];
const record = (row: string, attack: string, expected: string, o: Outcome | string, pass?: boolean) => {
  const observed = typeof o === 'string' ? o : o.code;
  const ok = pass ?? observed === expected;
  rows.push({ row, attack, expected, observed, pass: ok });
  console.log(`  ${ok ? '[pass]' : '[FAIL]'} ${row.padEnd(4)} ${attack}\n         expected ${expected}, observed ${observed}`);
};

async function main(): Promise<void> {
  const l = await ledger('registrar');
  const course = `ATK-${hex(2)}`;
  console.log(`Attack suite against the live network, course ${course}\n`);

  const faculty = await newFaculty(l);
  const [alice, bob, mallory, carol] = await Promise.all(
    [1, 2, 3, 4].map(() => newStudent(l, course)));

  // A session opened a minute ago, so a code from window 2 is genuinely stale.
  const s = await openSession(l, faculty, course, { startMs: Date.now() - 60_000 });
  // Same start, so a claim replayed into it is in a valid window and only the
  // signature binding can reject it. A different start would let the window
  // check fire first and prove nothing about the signature.
  const twin = await openSession(l, faculty, course, { startMs: s.startMs });
  // Starts after enrolment, as a real class does, so it counts toward eligibility.
  const fresh = await openSession(l, faculty, course);

  // ---- Row 1: a screenshot of the QR, used after it rotated -----------------
  record('1', 'Replay a genuine code from an earlier window (forwarded screenshot)', 'WINDOW_MISMATCH',
    await attempt(() => l.attendance.submit('markAttendance', ...markArgs(s, alice, { window: 2 }))));

  // ---- Row 5: duplicate and cross-session replay ---------------------------
  const first = await attempt(() => l.attendance.submit('markAttendance', ...markArgs(s, alice)));
  record('5', 'Legitimate mark (control)', 'ACCEPTED', first);
  record('5', 'Submit a second mark for the same student and session', 'DUPLICATE_ATTENDANCE',
    await attempt(() => l.attendance.submit('markAttendance', ...markArgs(s, alice))));
  record('5', 'Replay a valid signed claim into a different session', 'INVALID_SIGNATURE',
    await attempt(() => l.attendance.submit('markAttendance', ...markArgs(s, bob, { submitTo: twin.id }))));

  // ---- Row 1/14: a code the session never displayed -------------------------
  record('1', 'Forge a code for the current window (accepted at marking by design)', 'ACCEPTED',
    await attempt(() => l.attendance.submit('markAttendance', ...markArgs(fresh, mallory, { nonce: 'de'.repeat(32) }))));

  // ---- Row 7: location ------------------------------------------------------
  record('7', 'Submit from 400 m outside the geofence', 'OUTSIDE_GEOFENCE',
    await attempt(() => l.attendance.submit('markAttendance', ...markArgs(s, bob, { metres: 400 }))));
  record('7', 'Spoofed GPS reporting a point inside the fence (residual risk)', 'ACCEPTED',
    await attempt(() => l.attendance.submit('markAttendance', ...markArgs(s, bob, { metres: 10 }))));

  // ---- Row 11: a stolen key after the student rotates it -----------------
  const stolen = carol.device;
  const replacement = generateDeviceKeyPair();
  await l.identities.submit('revokeAndReissueKey', carol.id, hashPublicKey(stolen.publicKeyHex),
    replacement.publicKeyHex, 'compromise');
  record('11', 'Sign with a key that has since been rotated out', 'INVALID_SIGNATURE',
    await attempt(() => l.attendance.submit('markAttendance', ...markArgs(s, carol, { signWith: stolen }))));
  record('11', 'Sign with another student’s device key', 'INVALID_SIGNATURE',
    await attempt(() => l.attendance.submit('markAttendance', ...markArgs(twin, carol, { signWith: alice.device }))));

  // ---- Row 12: Sybil -------------------------------------------------------
  record('12', 'Enrol a second identity for the same person (same identity hash)', 'IDENTITY_HASH_EXISTS',
    await attempt(() => l.identities.submit('registerIdentity', alice.identityHash, hex(32), 'student')));

  // ---- Row 13: not on the roster -----------------------------------------
  const outsider = await newStudent(l, `OTHER-${hex(2)}`);
  record('13', 'Mark attendance in a course the student is not enrolled in', 'NOT_ENROLLED',
    await attempt(() => l.attendance.submit('markAttendance', ...markArgs(s, outsider))));

  // ---- Row 4: one organisation writing alone ------------------------------
  const lone = await ledger('registrar', { endorsingOrgs: ['registrar'] });
  record('4', 'Registrar alone rewrites a record (one endorsement only)', 'ENDORSEMENT_POLICY_FAILURE',
    await attempt(() => lone.attendance.submit('correctAttendance', s.id, alice.id, 'absent', 'insider edit')));
  lone.gw.close();
  const still = JSON.parse(await l.attendance.evaluate('getAttendance', s.id, alice.id));
  record('4', 'The record after the attempt is unchanged', 'present', still.current.status);

  const audit = await ledger('audit');
  record('4', 'The Audit organisation tries to write', 'UNAUTHORISED_ORG',
    await attempt(() => audit.attendance.submit('correctAttendance', s.id, alice.id, 'absent', 'audit edit')));
  audit.gw.close();

  // ---- Row 2: the faculty retrofits a seed --------------------------------
  record('2', 'Close the session revealing a different seed than was committed', 'SEED_COMMITMENT_MISMATCH',
    await attempt(() => l.sessions.submit('closeSession', fresh.id, hex(32))));

  const closed = await attempt(() => l.sessions.submit('closeSession', fresh.id, fresh.seed));
  record('2', 'Close with the committed seed (control)', 'ACCEPTED', closed);
  const audited = JSON.parse(await l.attendance.evaluate('getNonceAudit', fresh.id));
  const forged = audited.verdicts.find((v: any) => v.studentID === mallory.id);
  record('1', 'The forged code is exposed at close by both organisations', 'invalid',
    forged ? (forged.valid ? 'valid' : 'invalid') : 'missing');
  const state = JSON.parse(await l.sessions.evaluate('getSession', fresh.id)).verificationState;
  record('1', 'The session reports what it can prove', 'disputed', state);

  const elig = JSON.parse(await l.policy.evaluate('computeEligibility', course, mallory.id));
  record('14', 'The forged mark earns no eligibility credit', 'rejectedForNonce=1, present=0',
    `rejectedForNonce=${elig.rejectedForNonce}, present=${elig.present}`);

  // ---- Row 3: the faculty never reveals ----------------------------------
  const abandoned = await openSession(l, faculty, course,
    { startMs: Date.now() - 2 * 3600_000, durationSec: 60, graceSec: 0 });
  record('3', 'Reveal the seed after the grace period has elapsed', 'GRACE_PERIOD_ELAPSED',
    await attempt(() => l.sessions.submit('closeSession', abandoned.id, abandoned.seed)));
  record('3', 'Anyone records the expiry as an attributable sanction', 'ACCEPTED',
    await attempt(() => l.sessions.submit('expireSession', abandoned.id)));
  const abandonedState = JSON.parse(await l.sessions.evaluate('getSession', abandoned.id)).verificationState;
  record('3', 'An unrevealed session never reads as healthy', 'unverified', abandonedState);

  // ---- API rule: the seed must not reach the server while open ------------
  const server = createApp(l.gw).listen(0);
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionID: 'X', seed: hex(32) }),
  });
  server.close();
  record('API', 'Send the session seed to the server at open', 'SEED_MUST_NOT_BE_SENT',
    ((await res.json()) as any).error.code);

  // ---- Rows that software cannot exercise --------------------------------
  for (const [row, attack] of [
    ['6', 'Lend the phone to a friend (defeated on the device by liveness, not on chain)'],
    ['8', 'Relay the classroom’s proximity signal to a remote accomplice'],
    ['9', 'A present friend performs the liveness check for an absent student'],
    ['10', 'Inject a deepfake through a virtual camera driver'],
  ]) {
    rows.push({ row, attack, expected: 'open', observed: 'not executable in software', pass: null });
  }

  l.gw.close();

  const executed = rows.filter((r) => r.pass !== null);
  const passed = executed.filter((r) => r.pass).length;
  console.log(`\n${passed} of ${executed.length} executed checks behaved as the threat model claims; `
    + `${rows.length - executed.length} rows remain open and are reported as such.`);

  const out = path.join(__dirname, '../../../docs/evidence/eval');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'attacks.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), passed, executed: executed.length, rows }, null, 2));
  process.exitCode = passed === executed.length ? 0 : 1;
}

main().catch((err) => {
  console.error('attack suite could not run:', err instanceof Error ? err.message : err);
  process.exit(1);
});
