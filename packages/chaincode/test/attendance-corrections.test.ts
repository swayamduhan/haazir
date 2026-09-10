import { Context } from 'fabric-contract-api';
import { AttendanceIndex, AttendanceRecord, NonceAudit } from '@haazir/shared';
import { nextTx } from './helpers/mock-context';
import {
  addStudent, COURSE, mark, openSession, recorder, roster, SEED,
  SESSION_ID, sessions, START_MS,
} from './helpers/fixtures';

const CORRECT_MS = START_MS + 900_000;

interface View {
  index: AttendanceIndex;
  current: AttendanceRecord;
  history: AttendanceRecord[];
}

const view = async (ctx: Context, studentID: string) =>
  JSON.parse(await recorder().getAttendance(ctx, SESSION_ID, studentID)) as View;

describe('correctAttendance', () => {
  it('appends a superseding record and leaves the original byte-for-byte', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device);
    const before = (await view(marked, studentID)).current;

    const corrected = nextTx(marked, { txId: 'tx-correct', timestampMs: CORRECT_MS });
    await recorder().correctAttendance(
      corrected, SESSION_ID, studentID, 'absent', 'left the hall after marking',
    );

    const after = await view(corrected, studentID);
    expect(after.history).toHaveLength(2);
    expect(after.history[0]).toEqual(before);
    expect(after.current.status).toBe('absent');
    expect(after.current.seq).toBe(1);
    expect(after.current.supersedes).toBe(before.recordID);
    expect(after.current.reason).toBe('left the hall after marking');
  });

  it('moves the index without touching the record it points away from', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device);

    const corrected = nextTx(marked, { txId: 'tx-correct', timestampMs: CORRECT_MS });
    await recorder().correctAttendance(
      corrected, SESSION_ID, studentID, 'absent', 'proxy suspected',
    );

    const after = await view(corrected, studentID);
    expect(after.index.currentSeq).toBe(1);
    expect(after.index.currentStatus).toBe('absent');
    expect(after.index.updatedAt).toBe('2026-09-09T10:15:00.000Z');
    expect(after.history[0].status).toBe('present');
  });

  it('records a student whose device never worked, with no prior record', async () => {
    const { ctx, studentID } = await openSession();

    const corrected = nextTx(ctx, { txId: 'tx-manual', timestampMs: CORRECT_MS });
    const record = JSON.parse(await recorder().correctAttendance(
      corrected, SESSION_ID, studentID, 'present', 'phone battery died, verified in person',
    )) as AttendanceRecord;

    expect(record.seq).toBe(0);
    expect(record.origin).toBe('correction');
    expect(record.supersedes).toBeUndefined();
    expect(record.deviceSignature).toBeUndefined();
  });

  it('chains corrections, each superseding the last', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device);

    const one = nextTx(marked, { txId: 'tx-c1', timestampMs: CORRECT_MS });
    await recorder().correctAttendance(one, SESSION_ID, studentID, 'absent', 'first review');

    const two = nextTx(one, { txId: 'tx-c2', timestampMs: CORRECT_MS + 60_000 });
    await recorder().correctAttendance(two, SESSION_ID, studentID, 'present', 'appeal upheld');

    const after = await view(two, studentID);
    expect(after.history.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(after.history.map((r) => r.status)).toEqual(['present', 'absent', 'present']);
    expect(after.current.supersedes).toBe(after.history[1].recordID);
  });

  it('keeps sequence order past nine, which unpadded keys would not', async () => {
    const fixture = await openSession();
    let current: Context = fixture.ctx;

    for (let i = 0; i < 11; i += 1) {
      current = nextTx(current, { txId: `tx-c${i}`, timestampMs: CORRECT_MS + i * 1000 });
      await recorder().correctAttendance(
        current, SESSION_ID, fixture.studentID,
        i % 2 === 0 ? 'present' : 'absent', `revision ${i}`,
      );
    }

    // Lexically, "10" sorts before "2". Zero-padding is what makes Fabric's
    // key order the same as sequence order.
    const after = await view(current, fixture.studentID);
    expect(after.history.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('correctAttendance, refusals', () => {
  it('refuses a correction that changes nothing', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device);

    const same = nextTx(marked, { txId: 'tx-noop', timestampMs: CORRECT_MS });
    await expect(recorder().correctAttendance(
      same, SESSION_ID, studentID, 'present', 'confirming the record',
    )).rejects.toThrow(/NO_CHANGE/);
  });

  it('refuses a correction with no stated reason', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device);
    const next = nextTx(marked, { txId: 'tx-c', timestampMs: CORRECT_MS });

    // An append-only history whose entries do not say why is not auditable.
    await expect(recorder().correctAttendance(next, SESSION_ID, studentID, 'absent', '   '))
      .rejects.toThrow(/MISSING_REASON/);
  });

  it('refuses a status that is neither present nor absent', async () => {
    const { ctx, studentID } = await openSession();
    const next = nextTx(ctx, { txId: 'tx-c', timestampMs: CORRECT_MS });

    await expect(recorder().correctAttendance(next, SESSION_ID, studentID, 'maybe', 'unsure'))
      .rejects.toThrow(/INVALID_STATUS/);
  });

  it('allows a correction for a dropped student, and refuses one for a stranger', async () => {
    const { ctx } = await openSession();
    const { ctx: withB, studentID: bID } = await addStudent(ctx, 'student-b');

    const dropped = nextTx(withB, { txId: 'tx-drop' });
    await roster().dropStudent(dropped, COURSE, bID);

    // A dropped student keeps their entry, so a correction covering the weeks
    // they were enrolled remains possible. That is the point of not deleting.
    const corrected = nextTx(dropped, { txId: 'tx-c', timestampMs: CORRECT_MS });
    await expect(recorder().correctAttendance(
      corrected, SESSION_ID, bID, 'present', 'attended before dropping',
    )).resolves.toContain('present');

    await expect(recorder().correctAttendance(
      nextTx(corrected, { txId: 'tx-c2' }), SESSION_ID, 'ghost', 'present', 'no such student',
    )).rejects.toThrow(/NOT_ENROLLED/);
  });

  it('refuses an organisation that does not endorse', async () => {
    const { ctx, studentID } = await openSession();
    const audit = nextTx(ctx, { txId: 'tx-audit', mspId: 'AuditMSP' });

    await expect(recorder().correctAttendance(
      audit, SESSION_ID, studentID, 'present', 'audit says so',
    )).rejects.toThrow(/UNAUTHORISED_ORG/);
  });

  it('works after the session has closed, which is when most corrections happen', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device);

    const closed = nextTx(marked, { txId: 'tx-close', timestampMs: START_MS + 600_000 });
    await sessions().closeSession(closed, SESSION_ID, SEED);

    const corrected = nextTx(closed, { txId: 'tx-c', timestampMs: CORRECT_MS });
    await expect(recorder().correctAttendance(
      corrected, SESSION_ID, studentID, 'absent', 'appeal by another student upheld',
    )).resolves.toContain('absent');
  });
});

describe('a correction and the nonce audit', () => {
  it('audits the original claim even after it has been superseded', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: marked } = await mark(ctx, studentID, device);

    const corrected = nextTx(marked, { txId: 'tx-c', timestampMs: START_MS + 120_000 });
    await recorder().correctAttendance(
      corrected, SESSION_ID, studentID, 'absent', 'seen leaving immediately',
    );

    const closed = nextTx(corrected, { txId: 'tx-close', timestampMs: START_MS + 600_000 });
    await sessions().closeSession(closed, SESSION_ID, SEED);

    // What the device claimed is a fact about that instant. A later correction
    // changes the attendance outcome, not what was claimed.
    const a = JSON.parse(await recorder().getNonceAudit(closed, SESSION_ID)) as NonceAudit;
    expect(a.recordsChecked).toBe(1);
    expect(a.verdicts[0].valid).toBe(true);
  });

  it('does not audit a correction, which carries no nonce to check', async () => {
    const { ctx, studentID } = await openSession();

    const corrected = nextTx(ctx, { txId: 'tx-c', timestampMs: START_MS + 120_000 });
    await recorder().correctAttendance(
      corrected, SESSION_ID, studentID, 'present', 'manual attestation',
    );

    const closed = nextTx(corrected, { txId: 'tx-close', timestampMs: START_MS + 600_000 });
    await sessions().closeSession(closed, SESSION_ID, SEED);

    const a = JSON.parse(await recorder().getNonceAudit(closed, SESSION_ID)) as NonceAudit;
    expect(a.recordsChecked).toBe(0);
  });
});

describe('getAttendance', () => {
  it('refuses to invent a record for a student who has none', async () => {
    const { ctx, studentID } = await openSession();

    await expect(recorder().getAttendance(ctx, SESSION_ID, studentID))
      .rejects.toThrow(/ATTENDANCE_NOT_FOUND/);
  });
});
