import { hashPublicKey, RosterEntry } from '@haazir/shared';
import { IdentityRegistry } from '../src/contracts/identity-registry';
import { nextTx } from './helpers/mock-context';
import { addStudent, COURSE, openSession, roster, START_MS } from './helpers/fixtures';

const parse = (json: string) => JSON.parse(json) as RosterEntry;

describe('enrolStudent', () => {
  it('records the enrolment against the enrolling identity and ledger clock', async () => {
    const { ctx, studentID } = await openSession();
    const entry = parse(await roster().getEnrolment(ctx, COURSE, studentID));

    expect(entry).toMatchObject({
      courseID: COURSE,
      studentID,
      status: 'enrolled',
      enrolledBy: 'x509::CN=admin',
      enrolledAt: '2026-09-09T10:00:00.000Z',
    });
  });

  it('refuses a second enrolment rather than silently rewriting the entry', async () => {
    const { ctx, studentID } = await openSession();
    const again = nextTx(ctx, { txId: 'tx-again' });

    await expect(roster().enrolStudent(again, COURSE, studentID))
      .rejects.toThrow(/ALREADY_ENROLLED/);
  });

  it('refuses an identity that is not a student', async () => {
    const { ctx, facultyID } = await openSession();
    const next = nextTx(ctx, { txId: 'tx-fac-enrol' });

    await expect(roster().enrolStudent(next, COURSE, facultyID))
      .rejects.toThrow(/NOT_STUDENT/);
  });

  it('refuses an unknown identity', async () => {
    const { ctx } = await openSession();
    const next = nextTx(ctx, { txId: 'tx-ghost' });

    await expect(roster().enrolStudent(next, COURSE, 'nobody'))
      .rejects.toThrow(/STUDENT_NOT_FOUND/);
  });

  it('survives a key rotation, which does not disturb enrolment', async () => {
    const { ctx, studentID, device } = await openSession();

    const rotated = nextTx(ctx, { txId: 'tx-rotate', timestampMs: START_MS + 60_000 });
    await new IdentityRegistry().revokeAndReissueKey(
      rotated, studentID, hashPublicKey(device.publicKeyHex), 'c'.repeat(64), 'lost_device',
    );

    // Rotation replaces the key and leaves the identity active. Enrolment is
    // a separate fact and is untouched by it.
    expect(await roster().isEnrolled(rotated, COURSE, studentID)).toBe('true');
  });

  it('refuses an organisation that does not endorse', async () => {
    const { ctx, studentID } = await openSession();
    const audit = nextTx(ctx, { txId: 'tx-audit', mspId: 'AuditMSP' });

    await expect(roster().enrolStudent(audit, 'CS999', studentID))
      .rejects.toThrow(/UNAUTHORISED_ORG/);
  });

  it('refuses a course id that would collide with the composite key delimiter', async () => {
    const { ctx, studentID } = await openSession();
    const next = nextTx(ctx, { txId: 'tx-nul' });

    await expect(roster().enrolStudent(next, `CS${String.fromCharCode(0)}101`, studentID))
      .rejects.toThrow(/INVALID_COURSE_ID/);
    await expect(roster().enrolStudent(next, '', studentID))
      .rejects.toThrow(/INVALID_COURSE_ID/);
  });
});

describe('dropStudent', () => {
  it('keeps the entry and marks it dropped rather than deleting it', async () => {
    const { ctx, studentID } = await openSession();
    const dropped = nextTx(ctx, { txId: 'tx-drop', timestampMs: START_MS + 60_000 });
    await roster().dropStudent(dropped, COURSE, studentID);

    const entry = parse(await roster().getEnrolment(dropped, COURSE, studentID));
    expect(entry.status).toBe('dropped');
    expect(entry.droppedAt).toBe('2026-09-09T10:01:00.000Z');
    // The fact of the original enrolment survives, which is what an audit of a
    // disputed record needs to see.
    expect(entry.enrolledAt).toBe('2026-09-09T10:00:00.000Z');
  });

  it('reports a dropped student as not enrolled', async () => {
    const { ctx, studentID } = await openSession();
    expect(await roster().isEnrolled(ctx, COURSE, studentID)).toBe('true');

    const dropped = nextTx(ctx, { txId: 'tx-drop' });
    await roster().dropStudent(dropped, COURSE, studentID);
    expect(await roster().isEnrolled(dropped, COURSE, studentID)).toBe('false');
  });

  it('allows re-enrolment on the same key', async () => {
    const { ctx, studentID } = await openSession();
    const dropped = nextTx(ctx, { txId: 'tx-drop' });
    await roster().dropStudent(dropped, COURSE, studentID);

    const back = nextTx(dropped, { txId: 'tx-re', timestampMs: START_MS + 120_000 });
    const entry = parse(await roster().enrolStudent(back, COURSE, studentID));

    expect(entry.status).toBe('enrolled');
    expect(entry.droppedAt).toBeUndefined();
  });

  it('refuses to drop a student who was never enrolled', async () => {
    const { ctx, studentID } = await openSession();
    const next = nextTx(ctx, { txId: 'tx-drop-other' });

    await expect(roster().dropStudent(next, 'CS999', studentID))
      .rejects.toThrow(/NOT_ENROLLED/);
  });

  it('refuses a second drop', async () => {
    const { ctx, studentID } = await openSession();
    const dropped = nextTx(ctx, { txId: 'tx-drop' });
    await roster().dropStudent(dropped, COURSE, studentID);

    await expect(roster().dropStudent(nextTx(dropped, { txId: 'tx-d2' }), COURSE, studentID))
      .rejects.toThrow(/NOT_ENROLLED/);
  });
});

describe('getRoster', () => {
  it('returns the course roster in key order with a count of the enrolled', async () => {
    const { ctx } = await openSession();
    const { ctx: withB } = await addStudent(ctx, 'student-b');

    const view = JSON.parse(await roster().getRoster(withB, COURSE)) as {
      courseID: string; enrolled: number; entries: RosterEntry[];
    };

    expect(view.courseID).toBe(COURSE);
    expect(view.enrolled).toBe(2);
    expect(view.entries).toHaveLength(2);

    const ids = view.entries.map((e) => e.studentID);
    expect([...ids].sort()).toEqual(ids);
  });

  it('counts dropped students in the entries but not in the enrolled total', async () => {
    const { ctx, studentID } = await openSession();
    const dropped = nextTx(ctx, { txId: 'tx-drop' });
    await roster().dropStudent(dropped, COURSE, studentID);

    const view = JSON.parse(await roster().getRoster(dropped, COURSE)) as {
      enrolled: number; entries: RosterEntry[];
    };
    expect(view.enrolled).toBe(0);
    expect(view.entries).toHaveLength(1);
  });

  it('does not leak entries from another course', async () => {
    const { ctx, studentID } = await openSession();
    const other = nextTx(ctx, { txId: 'tx-other' });
    await roster().enrolStudent(other, 'CS102', studentID);

    const view = JSON.parse(await roster().getRoster(other, COURSE)) as {
      entries: RosterEntry[];
    };
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0].courseID).toBe(COURSE);
  });
});
