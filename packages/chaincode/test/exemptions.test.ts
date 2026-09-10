import { Context } from 'fabric-contract-api';
import { EligibilityReport, ExemptionRecord } from '@haazir/shared';
import { nextTx } from './helpers/mock-context';
import {
  Attendee, COURSE, openSession, policy, roster, runSession, START_MS,
} from './helpers/fixtures';

const WEEK = 7 * 24 * 3600 * 1000;
const meeting = (n: number) => START_MS + WEEK * n;

/** A real CIDv0: base58btc, 46 characters, beginning "Qm". */
const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const CID_V1 = `b${'a'.repeat(58)}`;

const report = async (ctx: Context, studentID: string) =>
  JSON.parse(await policy().computeEligibility(ctx, COURSE, studentID)) as EligibilityReport;

/** A course of `total` meetings the student attends the first `attended` of. */
async function course(total: number, attended: number) {
  const f = await openSession();
  const me: Attendee = { studentID: f.studentID, device: f.device };
  let ctx = f.ctx;

  for (let n = 1; n <= total; n += 1) {
    ctx = await runSession(ctx, f.facultyID, {
      id: `W${n}`, startMs: meeting(n), attend: n <= attended ? [me] : [],
    });
  }
  return { ...f, ctx };
}

describe('applyExemption', () => {
  it('anchors the evidence by CID and never stores the document', async () => {
    const { ctx, studentID } = await course(1, 0);
    const granted = nextTx(ctx, { txId: 'tx-ex', timestampMs: meeting(2) });

    const record = JSON.parse(await policy().applyExemption(
      granted, COURSE, studentID, 'W1', 'medical', 'excluded', CID,
      'hospital admission, certificate on file',
    )) as ExemptionRecord;

    expect(record).toMatchObject({
      courseID: COURSE, studentID, sessionID: 'W1',
      kind: 'medical', effect: 'excluded', evidenceCID: CID,
      status: 'active', grantedBy: 'x509::CN=admin',
    });
    expect(record.exemptionID).toMatch(/^[0-9a-f]{32}$/);
    // The ledger holds a hash of the certificate, not the certificate. Delete
    // the file and the anchor becomes a reference to nothing — erasure
    // without rewriting history.
    expect(JSON.stringify(record)).not.toMatch(/diagnosis|patient/i);
  });

  it('accepts a CIDv1 as well as a CIDv0', async () => {
    const { ctx, studentID } = await course(1, 0);
    const granted = nextTx(ctx, { txId: 'tx-ex' });

    await expect(policy().applyExemption(
      granted, COURSE, studentID, 'W1', 'official_duty', 'counts_present', CID_V1,
      'inter-college fixture',
    )).resolves.toContain('counts_present');
  });

  it('refuses evidence that is not a content identifier', async () => {
    const { ctx, studentID } = await course(1, 0);
    const granted = nextTx(ctx, { txId: 'tx-ex' });

    for (const bad of ['', 'https://drive.example.com/doc', 'Qm-too-short']) {
      await expect(policy().applyExemption(
        granted, COURSE, studentID, 'W1', 'medical', 'excluded', bad, 'a reason',
      )).rejects.toThrow(/INVALID_EVIDENCE_CID/);
    }
  });

  it('refuses an unknown kind or effect', async () => {
    const { ctx, studentID } = await course(1, 0);
    const granted = nextTx(ctx, { txId: 'tx-ex' });

    await expect(policy().applyExemption(
      granted, COURSE, studentID, 'W1', 'holiday', 'excluded', CID, 'a reason',
    )).rejects.toThrow(/INVALID_EXEMPTION_KIND/);

    await expect(policy().applyExemption(
      granted, COURSE, studentID, 'W1', 'medical', 'ignore', CID, 'a reason',
    )).rejects.toThrow(/INVALID_EXEMPTION_EFFECT/);
  });

  it('refuses a session belonging to a different course', async () => {
    const { ctx, studentID } = await course(1, 0);

    // Enrolled in a second course, so the roster check passes and the
    // mismatch is what actually rejects — otherwise this test would prove
    // only that the earlier check fires first.
    let other = nextTx(ctx, { txId: 'tx-enrol2' });
    await roster().enrolStudent(other, 'CS102', studentID);

    other = nextTx(other, { txId: 'tx-ex' });
    await expect(policy().applyExemption(
      other, 'CS102', studentID, 'W1', 'medical', 'excluded', CID, 'a reason',
    )).rejects.toThrow(/COURSE_MISMATCH.*belongs to "CS101"/);
  });

  it('refuses a student with no enrolment record for the course', async () => {
    const { ctx, studentID } = await course(1, 0);
    const granted = nextTx(ctx, { txId: 'tx-ex' });

    await expect(policy().applyExemption(
      granted, 'CS999', studentID, 'W1', 'medical', 'excluded', CID, 'a reason',
    )).rejects.toThrow(/NOT_ENROLLED/);
  });

  it('refuses a session that does not exist', async () => {
    const { ctx, studentID } = await course(1, 0);
    const granted = nextTx(ctx, { txId: 'tx-ex' });

    await expect(policy().applyExemption(
      granted, COURSE, studentID, 'W99', 'medical', 'excluded', CID, 'a reason',
    )).rejects.toThrow(/SESSION_NOT_FOUND/);
  });

  it('refuses a second active exemption for the same session', async () => {
    const { ctx, studentID } = await course(1, 0);
    let granted = nextTx(ctx, { txId: 'tx-ex1' });
    await policy().applyExemption(
      granted, COURSE, studentID, 'W1', 'medical', 'excluded', CID, 'first grant');

    granted = nextTx(granted, { txId: 'tx-ex2' });
    await expect(policy().applyExemption(
      granted, COURSE, studentID, 'W1', 'medical', 'excluded', CID, 'second grant',
    )).rejects.toThrow(/EXEMPTION_EXISTS/);
  });

  it('refuses an organisation that does not endorse', async () => {
    const { ctx, studentID } = await course(1, 0);
    const audit = nextTx(ctx, { txId: 'tx-audit', mspId: 'AuditMSP' });

    await expect(policy().applyExemption(
      audit, COURSE, studentID, 'W1', 'medical', 'excluded', CID, 'a reason',
    )).rejects.toThrow(/UNAUTHORISED_ORG/);
  });
});

describe('an exemption and the arithmetic', () => {
  it('removes an excluded session from the denominator', async () => {
    const { ctx, studentID } = await course(4, 2);
    expect((await report(ctx, studentID)).attendancePercentBp).toBe(5_000);

    let granted = nextTx(ctx, { txId: 'tx-ex1', timestampMs: meeting(5) });
    await policy().applyExemption(
      granted, COURSE, studentID, 'W3', 'medical', 'excluded', CID, 'admitted to hospital');
    granted = nextTx(granted, { txId: 'tx-ex2', timestampMs: meeting(5) });
    await policy().applyExemption(
      granted, COURSE, studentID, 'W4', 'medical', 'excluded', CID, 'still admitted');

    const r = await report(granted, studentID);
    expect(r.sessionsHeld).toBe(4);
    expect(r.exempted).toBe(2);
    expect(r.sessionsCounted).toBe(2);
    expect(r.present).toBe(2);
    expect(r.attendancePercentBp).toBe(10_000);
    expect(r.eligible).toBe(true);
  });

  it('credits an on-duty session as present without inventing a record', async () => {
    const { ctx, studentID } = await course(4, 2);

    const granted = nextTx(ctx, { txId: 'tx-ex', timestampMs: meeting(5) });
    await policy().applyExemption(
      granted, COURSE, studentID, 'W3', 'official_duty', 'counts_present', CID,
      'representing the college at a fixture');

    const r = await report(granted, studentID);
    expect(r.sessionsCounted).toBe(4);
    expect(r.creditedByExemption).toBe(1);
    expect(r.present).toBe(2);
    expect(r.attendancePercentBp).toBe(7_500);
    expect(r.eligible).toBe(true);

    // The credit is an exemption, not an attendance record. Nothing was
    // written into the attendance history to make the arithmetic work.
    expect(r.presentVerified).toBe(2);
  });

  it('stops counting once the exemption is revoked', async () => {
    const { ctx, studentID } = await course(4, 2);

    let granted = nextTx(ctx, { txId: 'tx-ex', timestampMs: meeting(5) });
    await policy().applyExemption(
      granted, COURSE, studentID, 'W3', 'official_duty', 'counts_present', CID, 'fixture');
    expect((await report(granted, studentID)).attendancePercentBp).toBe(7_500);

    granted = nextTx(granted, { txId: 'tx-rev', timestampMs: meeting(6) });
    await policy().revokeExemption(
      granted, COURSE, studentID, 'W3', 'the fixture was cancelled');

    const r = await report(granted, studentID);
    expect(r.creditedByExemption).toBe(0);
    expect(r.attendancePercentBp).toBe(5_000);
    expect(r.eligible).toBe(false);
  });

  it('keeps the revoked record so the original grant stays visible', async () => {
    const { ctx, studentID } = await course(1, 0);
    let granted = nextTx(ctx, { txId: 'tx-ex', timestampMs: meeting(2) });
    await policy().applyExemption(
      granted, COURSE, studentID, 'W1', 'medical', 'excluded', CID, 'certificate submitted');

    granted = nextTx(granted, { txId: 'tx-rev', timestampMs: meeting(3) });
    await policy().revokeExemption(
      granted, COURSE, studentID, 'W1', 'certificate could not be verified');

    const record = JSON.parse(
      await policy().getExemption(granted, COURSE, studentID, 'W1')) as ExemptionRecord;
    expect(record.status).toBe('revoked');
    expect(record.grantedAt).toBeDefined();
    expect(record.revokedBy).toBe('x509::CN=admin');
    expect(record.evidenceCID).toBe(CID);
  });

  it('allows a fresh grant after a revocation', async () => {
    const { ctx, studentID } = await course(1, 0);
    let granted = nextTx(ctx, { txId: 'tx-ex' });
    await policy().applyExemption(
      granted, COURSE, studentID, 'W1', 'medical', 'excluded', CID, 'first');
    granted = nextTx(granted, { txId: 'tx-rev' });
    await policy().revokeExemption(granted, COURSE, studentID, 'W1', 'withdrawn');

    granted = nextTx(granted, { txId: 'tx-ex2' });
    await expect(policy().applyExemption(
      granted, COURSE, studentID, 'W1', 'medical', 'excluded', CID, 'resubmitted',
    )).resolves.toContain('active');
  });

  it('refuses to revoke an exemption that does not exist or is already revoked', async () => {
    const { ctx, studentID } = await course(1, 0);
    await expect(policy().revokeExemption(ctx, COURSE, studentID, 'W1', 'a reason'))
      .rejects.toThrow(/EXEMPTION_NOT_FOUND/);

    let granted = nextTx(ctx, { txId: 'tx-ex' });
    await policy().applyExemption(
      granted, COURSE, studentID, 'W1', 'medical', 'excluded', CID, 'granted');
    granted = nextTx(granted, { txId: 'tx-rev' });
    await policy().revokeExemption(granted, COURSE, studentID, 'W1', 'withdrawn');

    await expect(policy().revokeExemption(
      nextTx(granted, { txId: 'tx-rev2' }), COURSE, studentID, 'W1', 'again',
    )).rejects.toThrow(/EXEMPTION_NOT_ACTIVE/);
  });
});

describe('listExemptions', () => {
  it('returns one student and course only, in session-id order', async () => {
    const { ctx, studentID } = await course(3, 0);
    let granted = nextTx(ctx, { txId: 'tx-a' });
    await policy().applyExemption(
      granted, COURSE, studentID, 'W2', 'medical', 'excluded', CID, 'week two');
    granted = nextTx(granted, { txId: 'tx-b' });
    await policy().applyExemption(
      granted, COURSE, studentID, 'W1', 'medical', 'excluded', CID, 'week one');
    granted = nextTx(granted, { txId: 'tx-c' });
    await policy().revokeExemption(granted, COURSE, studentID, 'W1', 'withdrawn');

    const view = JSON.parse(await policy().listExemptions(granted, COURSE, studentID)) as {
      active: number; records: ExemptionRecord[];
    };
    expect(view.records.map((r) => r.sessionID)).toEqual(['W1', 'W2']);
    expect(view.active).toBe(1);
  });
});
