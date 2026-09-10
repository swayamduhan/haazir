import {
  AttendanceRecord, deriveNonce, generateDeviceKeyPair, hashPublicKey,
  sha256Hex, toE7, windowFor,
} from '@haazir/shared';
import { IdentityRegistry } from '../src/contracts/identity-registry';
import { nextTx } from './helpers/mock-context';
import {
  addStudent, CENTRE, COURSE, LIVENESS, mark, northOf, openSession,
  recorder, roster, SEED, SESSION_ID, sessions, START_MS,
} from './helpers/fixtures';

const parse = (json: string) => JSON.parse(json) as AttendanceRecord;

/** 70 s past the start, so the nominal window is 7. */
const AT_MS = START_MS + 70_000;

describe('markAttendance, on a valid submission', () => {
  it('stores the claim with the ledger clock and the submitting organisation', async () => {
    const { ctx, studentID, device } = await openSession();
    const record = parse((await mark(ctx, studentID, device)).result);

    expect(record).toMatchObject({
      sessionID: SESSION_ID,
      studentID,
      courseID: COURSE,
      seq: 0,
      status: 'present',
      origin: 'device',
      markedAt: '2026-09-09T10:01:10.000Z',
      markedBy: 'x509::CN=admin',
      claimedWindow: 7,
      claimedNonce: deriveNonce(SEED, 7),
      livenessHash: LIVENESS,
    });
  });

  it('captures the key the signature verified against, not just that it did', async () => {
    const { ctx, studentID, device } = await openSession();
    const record = parse((await mark(ctx, studentID, device)).result);

    // A later rotation must not make this record unverifiable. ADR-017.
    expect(record.devicePublicKey).toBe(device.publicKeyHex);
  });

  it('derives the record id from the transaction, never at random', async () => {
    const { ctx, studentID, device } = await openSession();
    const a = parse((await mark(ctx, studentID, device, { txId: 'tx-same' })).result);
    const b = parse((await mark(ctx, studentID, device, { txId: 'tx-same' })).result);

    // Every endorsing peer runs this independently and must agree byte for
    // byte. A UUID would differ per peer and fail endorsement outright.
    expect(a.recordID).toBe(b.recordID);
    expect(a.recordID).toMatch(/^[0-9a-f]{32}$/);
  });

  it('takes the course from the session, so the device must sign the right one', async () => {
    const { ctx, studentID, device } = await openSession();

    await expect(mark(ctx, studentID, device, { courseID: 'CS999' }))
      .rejects.toThrow(/INVALID_SIGNATURE/);
  });
});

describe('markAttendance, possession', () => {
  it('rejects a signature made by another device', async () => {
    const { ctx, studentID, device } = await openSession();
    const attacker = generateDeviceKeyPair();

    await expect(mark(ctx, studentID, device, { signWith: attacker }))
      .rejects.toThrow(/INVALID_SIGNATURE/);
  });

  it('rejects a malformed signature before attempting to verify it', async () => {
    const { ctx, studentID, device } = await openSession();

    await expect(mark(ctx, studentID, device, { signature: 'ff' }))
      .rejects.toThrow(/INVALID_SIGNATURE/);
  });

  it('rejects a signature that was valid before the key was rotated', async () => {
    const { ctx, studentID, device } = await openSession();

    const rotated = nextTx(ctx, { txId: 'tx-rotate', timestampMs: START_MS + 10_000 });
    await new IdentityRegistry().revokeAndReissueKey(
      rotated, studentID, hashPublicKey(device.publicKeyHex),
      generateDeviceKeyPair().publicKeyHex, 'compromise',
    );

    // The stolen device can still sign; the registry no longer trusts it.
    await expect(mark(rotated, studentID, device)).rejects.toThrow(/INVALID_SIGNATURE/);
  });
});

describe('markAttendance, proximity', () => {
  it('accepts a location inside the geofence', async () => {
    const { ctx, studentID, device } = await openSession();
    const record = parse((await mark(ctx, studentID, device, {
      location: northOf(45),
    })).result);
    expect(record.location).toEqual(northOf(45));
  });

  it('rejects a location outside it, naming the distance', async () => {
    const { ctx, studentID, device } = await openSession();

    await expect(mark(ctx, studentID, device, { location: northOf(200) }))
      .rejects.toThrow(/OUTSIDE_GEOFENCE.*200 m.*limit 50 m/);
  });

  it('rejects coordinates that are not integer microdegrees', async () => {
    const { ctx, studentID, device } = await openSession();

    await expect(mark(ctx, studentID, device, {
      location: { latE7: CENTRE.latE7 + 0.5, lngE7: CENTRE.lngE7 },
    })).rejects.toThrow(/safe integer|INVALID_LOCATION/);
  });

  it('rejects a latitude outside the possible range', async () => {
    const { ctx, studentID, device } = await openSession();

    await expect(mark(ctx, studentID, device, {
      location: { latE7: toE7(91), lngE7: 0 },
    })).rejects.toThrow(/INVALID_LOCATION/);
  });
});

describe('markAttendance, freshness', () => {
  it('rejects a window more than one rotation from the ledger clock', async () => {
    const { ctx, studentID, device } = await openSession();

    // The seed is secret, so the nonce itself cannot be checked here. That the
    // claim is even about now can be. ADR-016.
    await expect(mark(ctx, studentID, device, { claimedWindow: 2 }))
      .rejects.toThrow(/WINDOW_MISMATCH.*claimed window 2.*current window 7/);
  });

  it('allows one window of skew between the device and the ordering service', async () => {
    const { ctx, studentID, device } = await openSession();
    const record = parse((await mark(ctx, studentID, device, {
      claimedWindow: 6,
    })).result);
    expect(record.claimedWindow).toBe(6);
  });

  it('accepts a nonce it cannot yet verify, and says so by storing the claim', async () => {
    const { ctx, studentID, device } = await openSession();
    const record = parse((await mark(ctx, studentID, device, {
      claimedNonce: 'de'.repeat(32),
    })).result);

    // Deliberately not a rejection: the contract has nothing to compare
    // against until closeSession reveals the seed. The forgery is exposed
    // there, not here.
    expect(record.claimedNonce).toBe('de'.repeat(32));
  });

  it('rejects a nonce that is not a 256-bit digest at all', async () => {
    const { ctx, studentID, device } = await openSession();

    await expect(mark(ctx, studentID, device, { claimedNonce: 'nope' }))
      .rejects.toThrow(/INVALID_NONCE/);
  });

  it('rejects a mark submitted after the session has run its length', async () => {
    const { ctx, studentID, device } = await openSession();
    const late = START_MS + 3_601_000;

    await expect(mark(ctx, studentID, device, {
      atMs: late, claimedWindow: windowFor(late, START_MS),
    })).rejects.toThrow(/OUTSIDE_SESSION_WINDOW/);
  });
});

describe('markAttendance, liveness', () => {
  it('rejects an attestation that is not a digest', async () => {
    const { ctx, studentID, device } = await openSession();

    await expect(mark(ctx, studentID, device, { livenessHash: 'trust-me' }))
      .rejects.toThrow(/INVALID_LIVENESS_ATTESTATION/);
  });

  it('stores only the hash, never anything derived from a face', async () => {
    const { ctx, studentID, device } = await openSession();
    const record = parse((await mark(ctx, studentID, device)).result);

    expect(record.livenessHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain('embedding');
  });
});

describe('markAttendance, eligibility', () => {
  it('rejects a student who is not enrolled in the course', async () => {
    const { ctx } = await openSession();
    const outsider = generateDeviceKeyPair();
    const idCtx = nextTx(ctx, { txId: 'tx-outsider', timestampMs: START_MS });
    const outsiderID = await new IdentityRegistry()
      .registerIdentity(idCtx, sha256Hex('outsider'), outsider.publicKeyHex, 'student');

    await expect(mark(idCtx, outsiderID, outsider)).rejects.toThrow(/NOT_ENROLLED/);
  });

  it('rejects a student dropped from the course since the session opened', async () => {
    const { ctx, studentID, device } = await openSession();
    const dropped = nextTx(ctx, { txId: 'tx-drop', timestampMs: START_MS + 30_000 });
    await roster().dropStudent(dropped, COURSE, studentID);

    await expect(mark(dropped, studentID, device)).rejects.toThrow(/NOT_ENROLLED/);
  });

  it('rejects a second mark for the same student in the same session', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: after } = await mark(ctx, studentID, device);

    await expect(mark(after, studentID, device, { txId: 'tx-again' }))
      .rejects.toThrow(/DUPLICATE_ATTENDANCE/);
  });

  it('rejects a mark on a session that is not open', async () => {
    const { ctx, studentID, device } = await openSession();
    const closed = nextTx(ctx, { txId: 'tx-close', timestampMs: START_MS + 60_000 });
    await sessions().closeSession(closed, SESSION_ID, SEED);

    await expect(mark(closed, studentID, device)).rejects.toThrow(/SESSION_NOT_OPEN/);
  });

  it('rejects an organisation that does not endorse', async () => {
    const { ctx, studentID, device } = await openSession();
    const audit = nextTx(ctx, { txId: 'tx-audit', mspId: 'AuditMSP', timestampMs: AT_MS });

    await expect(recorder().markAttendance(
      audit, SESSION_ID, studentID, 7, deriveNonce(SEED, 7),
      CENTRE.latE7, CENTRE.lngE7, LIVENESS, 'ab'.repeat(64),
    )).rejects.toThrow(/UNAUTHORISED_ORG/);
    expect(device.publicKeyHex).toHaveLength(64);
  });
});

describe('getSessionAttendance', () => {
  it('returns every student in key order with a present count', async () => {
    const { ctx, studentID, device } = await openSession();
    const { ctx: withB, studentID: bID, device: bDevice } = await addStudent(ctx, 'student-b');

    const { ctx: a } = await mark(withB, studentID, device);
    const { ctx: b } = await mark(a, bID, bDevice);

    const view = JSON.parse(await recorder().getSessionAttendance(b, SESSION_ID)) as {
      present: number; absent: number; entries: { studentID: string }[];
    };

    expect(view.present).toBe(2);
    expect(view.absent).toBe(0);
    const ids = view.entries.map((e) => e.studentID);
    expect([...ids].sort()).toEqual(ids);
  });
});
