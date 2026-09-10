import { Context } from 'fabric-contract-api';
import { EligibilityReport } from '@haazir/shared';
import { nextTx } from './helpers/mock-context';
import {
  Attendee, COURSE, openSession, policy, roster, runSession, SESSION_ID, START_MS,
} from './helpers/fixtures';

/** Class meetings a week apart, well clear of the fixture session's window. */
const WEEK = 7 * 24 * 3600 * 1000;
const meeting = (n: number) => START_MS + WEEK * n;

const report = async (ctx: Context, studentID: string) =>
  JSON.parse(await policy().computeEligibility(ctx, COURSE, studentID)) as EligibilityReport;

/**
 * A course of `total` meetings in which the student attends the first
 * `attended`. The fixture's own session S1 is left open and must not count.
 */
async function course(total: number, attended: number, forgeAt: number[] = []) {
  const f = await openSession();
  const me: Attendee = { studentID: f.studentID, device: f.device };
  let ctx = f.ctx;

  for (let n = 1; n <= total; n += 1) {
    const attend = n <= attended
      ? [{ ...me, forge: forgeAt.includes(n) }]
      : [];
    ctx = await runSession(ctx, f.facultyID, { id: `W${n}`, startMs: meeting(n), attend });
  }
  return { ...f, ctx };
}

describe('computeEligibility', () => {
  it('counts concluded sessions and reports the percentage in basis points', async () => {
    const { ctx, studentID } = await course(4, 3);
    const r = await report(ctx, studentID);

    expect(r.sessionsHeld).toBe(4);
    expect(r.sessionsCounted).toBe(4);
    expect(r.present).toBe(3);
    expect(r.presentVerified).toBe(3);
    expect(r.attendancePercentBp).toBe(7_500);
    expect(r.thresholdBp).toBe(7_500);
    expect(r.eligible).toBe(true);
  });

  it('is not eligible below the threshold', async () => {
    const { ctx, studentID } = await course(4, 2);
    const r = await report(ctx, studentID);

    expect(r.attendancePercentBp).toBe(5_000);
    expect(r.eligible).toBe(false);
  });

  it('never returns a fractional percentage', async () => {
    // 2 of 3 is 66.666...%, the case that would arrive as a float and be
    // rejected by canonical encoding.
    const { ctx, studentID } = await course(3, 2);
    const r = await report(ctx, studentID);

    expect(r.attendancePercentBp).toBe(6_666);
    expect(Number.isSafeInteger(r.attendancePercentBp)).toBe(true);
  });

  it('excludes a session that is still running', async () => {
    const { ctx, studentID } = await course(2, 2);

    // The fixture's S1 is open, and two more are closed.
    expect((await report(ctx, studentID)).sessionsHeld).toBe(2);

    const still = nextTx(ctx, { txId: 'tx-check' });
    const view = JSON.parse(await policy().getCourseSessions(still, COURSE)) as {
      sessions: number;
    };
    // It is indexed — it simply does not count until it concludes.
    expect(view.sessions).toBe(3);
    expect(view.sessions).toBeGreaterThan((await report(still, studentID)).sessionsHeld);
  });

  it('credits an expired session but does not call the credit verified', async () => {
    const f = await openSession();
    let ctx = await runSession(f.ctx, f.facultyID, {
      id: 'W1', startMs: meeting(1), attend: [{ studentID: f.studentID, device: f.device }],
      conclude: 'expire',
    });
    ctx = nextTx(ctx, { txId: 'tx-read' });

    const r = await report(ctx, f.studentID);
    // The student marked in good faith; the faculty never revealed the seed.
    // Withholding the credit would punish the student for someone else's
    // failure, and granting it silently would let that failure launder
    // unverifiable attendance. It is granted, and counted apart.
    expect(r.sessionsHeld).toBe(1);
    expect(r.present).toBe(1);
    expect(r.presentVerified).toBe(0);
  });

  it('refuses to compute for a student with no enrolment record', async () => {
    const { ctx } = await openSession();
    await expect(policy().computeEligibility(ctx, COURSE, 'ghost'))
      .rejects.toThrow(/NOT_ENROLLED/);
  });

  it('reports full attendance when no session has concluded', async () => {
    const { ctx, studentID } = await openSession();
    const r = await report(ctx, studentID);

    expect(r.sessionsHeld).toBe(0);
    expect(r.attendancePercentBp).toBe(10_000);
    expect(r.eligible).toBe(true);
  });

  it('ignores sessions that ran before the student enrolled', async () => {
    const f = await openSession();
    const { ctx: withB, studentID: bID, device: bDevice } = await (
      await import('./helpers/fixtures')
    ).addStudent(f.ctx, 'late-joiner');

    // Both students are enrolled at START_MS in this fixture, so instead drop
    // and re-enrol B after the first meeting to move their enrolledAt forward.
    let ctx = await runSession(withB, f.facultyID, { id: 'W1', startMs: meeting(1) });
    ctx = nextTx(ctx, { txId: 'tx-drop', timestampMs: meeting(2) - 1000 });
    await roster().dropStudent(ctx, COURSE, bID);
    ctx = nextTx(ctx, { txId: 'tx-rejoin', timestampMs: meeting(2) - 500 });
    await roster().enrolStudent(ctx, COURSE, bID);

    ctx = await runSession(ctx, f.facultyID, {
      id: 'W2', startMs: meeting(2), attend: [{ studentID: bID, device: bDevice }],
    });

    const r = await report(nextTx(ctx, { txId: 'tx-read' }), bID);
    expect(r.sessionsHeld).toBe(1);
    expect(r.present).toBe(1);
    expect(r.eligible).toBe(true);
  });
});

describe('computeEligibility and the nonce sweep', () => {
  it('voids a present record whose nonce the sweep rejected', async () => {
    const { ctx, studentID } = await course(4, 4, [2]);
    const r = await report(ctx, studentID);

    // Four marks accepted at the time; one did not survive the reveal.
    expect(r.sessionsHeld).toBe(4);
    expect(r.rejectedForNonce).toBe(1);
    expect(r.present).toBe(3);
    expect(r.attendancePercentBp).toBe(7_500);
  });

  it('drops a student below the threshold on the strength of the verdict alone', async () => {
    const { ctx, studentID } = await course(4, 3, [1]);
    const r = await report(ctx, studentID);

    // Three marks, one forged: 2 of 4. Without the sweep feeding eligibility
    // this would read 75% and the forgery would have bought a pass.
    expect(r.present).toBe(2);
    expect(r.rejectedForNonce).toBe(1);
    expect(r.attendancePercentBp).toBe(5_000);
    expect(r.eligible).toBe(false);
  });

  it('leaves a correction untouched, since it carries no nonce to reject', async () => {
    const f = await openSession();
    let ctx = await runSession(f.ctx, f.facultyID, { id: 'W1', startMs: meeting(1) });

    ctx = nextTx(ctx, { txId: 'tx-manual', timestampMs: meeting(1) + 900_000 });
    await (await import('./helpers/fixtures')).recorder().correctAttendance(
      ctx, 'W1', f.studentID, 'present', 'device failed, verified in person',
    );

    const r = await report(nextTx(ctx, { txId: 'tx-read' }), f.studentID);
    expect(r.present).toBe(1);
    expect(r.rejectedForNonce).toBe(0);
    // A faculty attestation is credit, but it is not cryptographic proof, and
    // the report does not let the two be confused.
    expect(r.presentVerified).toBe(0);
    expect(SESSION_ID).toBe('S1');
  });
});
