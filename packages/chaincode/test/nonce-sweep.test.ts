import { Context } from 'fabric-contract-api';
import { commitSeed, NonceAudit, Session, VerificationState } from '@haazir/shared';
import { nextTx } from './helpers/mock-context';
import {
  addStudent, GEOFENCE_JSON, mark, openSession, recorder, SEED, SESSION_ID,
  sessions, START, START_MS,
} from './helpers/fixtures';

const FORGED = 'de'.repeat(32);
const CLOSE_MS = START_MS + 600_000;

const audit = async (ctx: Context) =>
  JSON.parse(await recorder().getNonceAudit(ctx, SESSION_ID)) as NonceAudit;

const session = async (ctx: Context) =>
  JSON.parse(await sessions().getSession(ctx, SESSION_ID)) as Session & {
    verificationState: VerificationState;
  };

describe('the nonce sweep at closeSession', () => {
  it('recomputes every claim and records both the claim and the expectation', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device);

    const closed = nextTx(marked, { txId: 'tx-close', timestampMs: CLOSE_MS });
    await sessions().closeSession(closed, SESSION_ID, SEED);

    const a = await audit(closed);
    expect(a.recordsChecked).toBe(1);
    expect(a.validCount).toBe(1);
    expect(a.invalidCount).toBe(0);
    expect(a.checkedAt).toBe('2026-09-09T10:10:00.000Z');
    expect(a.verdicts[0]).toMatchObject({
      studentID, claimedWindow: 7, valid: true,
    });
    expect(a.verdicts[0].claimedNonce).toBe(a.verdicts[0].expectedNonce);
  });

  it('exposes a forged nonce that marking had to accept', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device, { claimedNonce: FORGED });

    const closed = nextTx(marked, { txId: 'tx-close', timestampMs: CLOSE_MS });
    await sessions().closeSession(closed, SESSION_ID, SEED);

    const a = await audit(closed);
    expect(a.invalidCount).toBe(1);
    expect(a.verdicts[0].valid).toBe(false);
    expect(a.verdicts[0].claimedNonce).toBe(FORGED);
    expect(a.verdicts[0].expectedNonce).not.toBe(FORGED);
  });

  it('separates the honest from the forged in one session', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: withB, studentID: bID, device: bDevice } = await addStudent(ctx, 'student-b');

    const { ctx: one } = await mark(withB, studentID, device);
    const { ctx: two } = await mark(one, bID, bDevice, { claimedNonce: FORGED });

    const closed = nextTx(two, { txId: 'tx-close', timestampMs: CLOSE_MS });
    await sessions().closeSession(closed, SESSION_ID, SEED);

    const a = await audit(closed);
    expect(a.recordsChecked).toBe(2);
    expect(a.validCount).toBe(1);
    expect(a.invalidCount).toBe(1);
    expect(a.verdicts.find((v) => v.studentID === bID)?.valid).toBe(false);
  });

  it('reports a session with a failed claim as disputed, not verified', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device, { claimedNonce: FORGED });

    const closed = nextTx(marked, { txId: 'tx-close', timestampMs: CLOSE_MS });
    await sessions().closeSession(closed, SESSION_ID, SEED);

    // A revealed seed proves the faculty committed honestly. It says nothing
    // about whether the submissions were fresh, and calling this "verified"
    // would be the most misleading thing the contract could report.
    const s = await session(nextTx(closed, { txId: 'tx-read' }));
    expect(s.verificationState).toBe('disputed');
    expect(s.nonceAudit).toEqual({ recordsChecked: 1, validCount: 0, invalidCount: 1 });
  });

  it('reports a clean session as verified', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device);

    const closed = nextTx(marked, { txId: 'tx-close', timestampMs: CLOSE_MS });
    await sessions().closeSession(closed, SESSION_ID, SEED);

    const s = await session(nextTx(closed, { txId: 'tx-read' }));
    expect(s.verificationState).toBe('verified');
  });

  it('runs even when nobody marked, so a closed session always carries a verdict', async () => {
    const { ctx } = await openSession();
    const closed = nextTx(ctx, { txId: 'tx-close', timestampMs: CLOSE_MS });
    await sessions().closeSession(closed, SESSION_ID, SEED);

    expect((await audit(closed)).recordsChecked).toBe(0);
    expect((await session(nextTx(closed, { txId: 'r' }))).verificationState).toBe('verified');
  });

  it('does not run when the revealed seed fails its commitment', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device);

    const wrong = nextTx(marked, { txId: 'tx-wrong', timestampMs: CLOSE_MS });
    await expect(sessions().closeSession(wrong, SESSION_ID, 'cd'.repeat(32)))
      .rejects.toThrow(/SEED_COMMITMENT_MISMATCH/);

    // The rejected close changed nothing: no audit, session still open.
    await expect(recorder().getNonceAudit(wrong, SESSION_ID))
      .rejects.toThrow(/NONCE_AUDIT_NOT_FOUND/);
  });

  it('leaves an expired session unadjudicated, because no seed ever appears', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device);

    const late = nextTx(marked, { txId: 'tx-expire', timestampMs: START_MS + 5_000_000 });
    await sessions().expireSession(late, SESSION_ID);

    await expect(recorder().getNonceAudit(late, SESSION_ID))
      .rejects.toThrow(/NONCE_AUDIT_NOT_FOUND/);

    // Read at a clock earlier than the deadline: the stored expiry must still
    // win, or a reader could make an unverifiable session look healthy simply
    // by asking early.
    const early = nextTx(late, { txId: 'tx-read', timestampMs: START_MS + 1_000 });
    expect((await session(early)).verificationState).toBe('unverified');
  });

  it('does not sweep records belonging to another session', async () => {
    const { ctx, facultyID, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device);

    const second = nextTx(marked, { txId: 'tx-s2', timestampMs: START_MS });
    await sessions().createSession(
      second, 'S2', 'CS101', facultyID, 'LH-4', START,
      3600, 900, GEOFENCE_JSON, 50, commitSeed('cd'.repeat(32)),
    );

    const closed = nextTx(second, { txId: 'tx-close-2', timestampMs: CLOSE_MS });
    await sessions().closeSession(closed, 'S2', 'cd'.repeat(32));

    const a = JSON.parse(await recorder().getNonceAudit(closed, 'S2')) as NonceAudit;
    expect(a.recordsChecked).toBe(0);
  });
});
