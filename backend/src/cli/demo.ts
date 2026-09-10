import { randomBytes } from 'crypto';
import {
  commitSeed, deriveNonce, hashPublicKey, sha256Hex, windowFor,
} from '@haazir/shared';
import { connect } from '../gateway';

const line = (s = '') => console.log(s);
const rule = (n: number, title: string) => {
  line();
  line('='.repeat(68));
  line(`  ${n}. ${title}`);
  line('='.repeat(68));
};
const ok = (s: string) => line(`  [ok]   ${s}`);
const bad = (s: string) => line(`  [FAIL] ${s}`);
const info = (s: string) => line(`         ${s}`);

const hex = (n: number) => randomBytes(n).toString('hex');

async function main(): Promise<void> {
  const gw = await connect('registrar');
  const identities = gw.contract('IdentityRegistry');
  const sessions = gw.contract('SessionManager');

  try {
    rule(1, 'Enrol a student identity');
    const studentPk = hex(32);
    const studentId = await identities.submit(
      'registerIdentity', sha256Hex(`student-${hex(8)}`), studentPk, 'student');
    ok(`identityID = ${studentId}`);
    info('Derived from the transaction id, not randomly: every endorsing peer');
    info('executes independently and must produce byte-identical output.');

    rule(2, 'Read the identity back from the ledger');
    info(await identities.evaluate('getIdentityStatus', studentId));
    info('No PII on chain — identityHash is a salted hash computed off-chain.');

    rule(3, 'Rotate the student device key');
    const newPk = hex(32);
    const event = await identities.submit(
      'revokeAndReissueKey', studentId, hashPublicKey(studentPk), newPk, 'lost_device');
    ok('revocation event recorded');
    info(event);

    rule(4, 'Enrol faculty and open a session');
    const facultyId = await identities.submit(
      'registerIdentity', sha256Hex(`faculty-${hex(8)}`), hex(32), 'faculty');
    ok(`facultyID = ${facultyId}`);

    // The seed never leaves this process. Only its hash goes on-chain.
    const seed = hex(32);
    const seedHash = commitSeed(seed);
    const sessionId = `S-${hex(4)}`;
    const startTime = new Date(Date.now() - 60_000).toISOString();

    await sessions.submit('createSession', sessionId, 'CS101', facultyId, 'LH-3',
      startTime, '3600', '900', JSON.stringify({ lat: 12.9716, lng: 77.5946 }),
      '50', seedHash);
    ok(`session ${sessionId} open`);
    info(`committed seed hash = ${seedHash}`);
    info('The seed itself has not been transmitted.');

    rule(5, 'Read the session back');
    const stored = JSON.parse(await sessions.evaluate('getSession', sessionId));
    info(`status            = ${stored.status}`);
    info(`verificationState = ${stored.verificationState}`);
    info(`revealedSeed      = ${stored.revealedSeed ?? '(not yet revealed)'}`);

    rule(6, 'Derive rotating nonces locally — no ledger interaction');
    const startMs = Date.parse(startTime);
    for (const w of [0, 1, 2]) {
      info(`window ${w}: ${deriveNonce(seed, w).slice(0, 40)}...`);
    }
    info(`current window = ${windowFor(Date.now(), startMs)}`);
    info('Rotation costs zero transactions. A screenshot expires in 10 seconds.');

    rule(7, 'NEGATIVE — close the session with the WRONG seed');
    try {
      await sessions.submit('closeSession', sessionId, hex(32));
      bad('accepted a seed that did not match the commitment');
      process.exitCode = 1;
    } catch (err) {
      ok(`rejected: ${(err as Error).message}`);
      info('The faculty cannot retrofit a seed after seeing submissions.');
    }

    rule(8, 'Close the session with the CORRECT seed');
    await sessions.submit('closeSession', sessionId, seed);
    const closed = JSON.parse(await sessions.evaluate('getSession', sessionId));
    ok(`status = ${closed.status}, verificationState = ${closed.verificationState}`);
    info(`revealed seed = ${closed.revealedSeed}`);

    rule(9, 'Anyone can now verify every nonce from the ledger alone');
    const w = 7;
    const fromLedger = deriveNonce(closed.revealedSeed, w);
    info(`recomputed window ${w} = ${fromLedger.slice(0, 40)}...`);
    if (fromLedger === deriveNonce(seed, w)) {
      ok('matches the faculty device — verification needs no trusted server');
    } else {
      bad('MISMATCH');
      process.exitCode = 1;
    }

    line();
    line('='.repeat(68));
    line('  Demo complete.');
    line('='.repeat(68));
  } finally {
    gw.close();
  }
}

main().catch((err) => {
  console.error('\nDemo failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
