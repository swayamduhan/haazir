import { Context } from 'fabric-contract-api';
import { SessionManager } from '../src/contracts/session-manager';
import { IdentityRegistry } from '../src/contracts/identity-registry';
import { makeContext, nextTx } from './helpers/mock-context';
import { commitSeed, sha256Hex, Session, VerificationState } from '@haazir/shared';

const SEED = 'ab'.repeat(32);
const SEED_HASH = commitSeed(SEED);
const GEO = JSON.stringify({ lat: 12.9716, lng: 77.5946 });
const START = '2026-09-09T10:00:00.000Z';
const START_MS = Date.parse(START);
const PK = 'a'.repeat(64);

const sm = () => new SessionManager();

/** Enrols a faculty identity and returns a context carrying that state. */
async function withFaculty(): Promise<{ ctx: Context; facultyID: string }> {
  const ctx = makeContext({ txId: 'tx-fac', timestampMs: START_MS });
  const facultyID = await new IdentityRegistry()
    .registerIdentity(ctx, sha256Hex('faculty-1'), PK, 'faculty');
  return { ctx, facultyID };
}

async function createDefaultSession(base: Context, facultyID: string, id = 'S1') {
  const ctx = nextTx(base, { txId: `tx-${id}`, timestampMs: START_MS });
  await sm().createSession(ctx, id, 'CS101', facultyID, 'LH-3',
    START, 3600, 900, GEO, 50, SEED_HASH);
  return ctx;
}

const read = async (ctx: Context, id = 'S1') =>
  JSON.parse(await sm().getSession(ctx, id)) as Session & {
    verificationState: VerificationState;
  };

describe('createSession', () => {
  it('stores the session as open with the seed hash and no seed', async () => {
    const { ctx, facultyID } = await withFaculty();
    const after = await createDefaultSession(ctx, facultyID);
    const s = await read(nextTx(after));
    expect(s.status).toBe('open');
    expect(s.nonceSeedHash).toBe(SEED_HASH);
    expect(s.revealedSeed).toBeUndefined();
  });

  it('records createdAt from the ledger, separate from the scheduled startTime', async () => {
    const { ctx, facultyID } = await withFaculty();
    const later = nextTx(ctx, { txId: 'tx-S9', timestampMs: START_MS + 60_000 });
    await sm().createSession(later, 'S9', 'CS101', facultyID, 'LH-3',
      START, 3600, 900, GEO, 50, SEED_HASH);
    const s = await read(nextTx(later), 'S9');
    expect(s.startTime).toBe(START);
    expect(s.createdAt).toBe('2026-09-09T10:01:00.000Z');
  });

  it('stores geofence coordinates as integer microdegrees', async () => {
    const { ctx, facultyID } = await withFaculty();
    const after = await createDefaultSession(ctx, facultyID);
    const s = await read(nextTx(after));
    expect(s.geofenceCenter.latE7).toBe(129716000);
    expect(s.geofenceCenter.lngE7).toBe(775946000);
  });

  it('rejects a duplicate session id', async () => {
    const { ctx, facultyID } = await withFaculty();
    const after = await createDefaultSession(ctx, facultyID);
    await expect(
      sm().createSession(nextTx(after, { txId: 'tx-dup' }), 'S1', 'CS101', facultyID,
        'LH-3', START, 3600, 900, GEO, 50, SEED_HASH),
    ).rejects.toThrow(/SESSION_EXISTS/);
  });

  it('rejects an unknown faculty identity', async () => {
    const { ctx } = await withFaculty();
    await expect(
      sm().createSession(nextTx(ctx), 'S2', 'CS101', 'no-such-id', 'LH-3',
        START, 3600, 900, GEO, 50, SEED_HASH),
    ).rejects.toThrow(/FACULTY_NOT_FOUND/);
  });

  it('rejects an identity that is not faculty', async () => {
    const ctx = makeContext({ txId: 'tx-stu', timestampMs: START_MS });
    const studentID = await new IdentityRegistry()
      .registerIdentity(ctx, sha256Hex('student-9'), PK, 'student');
    await expect(
      sm().createSession(nextTx(ctx), 'S3', 'CS101', studentID, 'LH-3',
        START, 3600, 900, GEO, 50, SEED_HASH),
    ).rejects.toThrow(/NOT_FACULTY/);
  });

  it('rejects a non-positive or excessive duration', async () => {
    const { ctx, facultyID } = await withFaculty();
    await expect(
      sm().createSession(nextTx(ctx), 'S4', 'CS101', facultyID, 'LH-3',
        START, 0, 900, GEO, 50, SEED_HASH),
    ).rejects.toThrow(/INVALID_DURATION/);
    await expect(
      sm().createSession(nextTx(ctx), 'S5', 'CS101', facultyID, 'LH-3',
        START, 99_999, 900, GEO, 50, SEED_HASH),
    ).rejects.toThrow(/INVALID_DURATION/);
  });

  it('rejects a malformed seed commitment', async () => {
    const { ctx, facultyID } = await withFaculty();
    await expect(
      sm().createSession(nextTx(ctx), 'S6', 'CS101', facultyID, 'LH-3',
        START, 3600, 900, GEO, 50, 'nothex'),
    ).rejects.toThrow(/INVALID_SEED_HASH/);
  });

  it('rejects out-of-range geofence coordinates', async () => {
    const { ctx, facultyID } = await withFaculty();
    await expect(
      sm().createSession(nextTx(ctx), 'S7', 'CS101', facultyID, 'LH-3', START, 3600, 900,
        JSON.stringify({ lat: 200, lng: 77 }), 50, SEED_HASH),
    ).rejects.toThrow(/INVALID_GEOFENCE/);
  });

  it('rejects a malformed startTime', async () => {
    const { ctx, facultyID } = await withFaculty();
    await expect(
      sm().createSession(nextTx(ctx), 'S8', 'CS101', facultyID, 'LH-3',
        'not-a-time', 3600, 900, GEO, 50, SEED_HASH),
    ).rejects.toThrow(/INVALID_START_TIME/);
  });
});

describe('getSession', () => {
  it('rejects an unknown session id', async () => {
    await expect(sm().getSession(makeContext(), 'nope')).rejects.toThrow(/SESSION_NOT_FOUND/);
  });

  it('reports in_progress while the session is running', async () => {
    const { ctx, facultyID } = await withFaculty();
    const after = await createDefaultSession(ctx, facultyID);
    const s = await read(nextTx(after, { timestampMs: START_MS + 60_000 }));
    expect(s.verificationState).toBe('in_progress');
  });

  it('reports awaiting_reveal after nominal end but inside the grace period', async () => {
    const { ctx, facultyID } = await withFaculty();
    const after = await createDefaultSession(ctx, facultyID);
    const s = await read(nextTx(after, { timestampMs: START_MS + 3_700_000 }));
    expect(s.verificationState).toBe('awaiting_reveal');
  });

  it('reports unverified past the grace period even though nobody has swept it', async () => {
    const { ctx, facultyID } = await withFaculty();
    const after = await createDefaultSession(ctx, facultyID);
    const s = await read(nextTx(after, { timestampMs: START_MS + 9_000_000 }));
    expect(s.status).toBe('open');
    expect(s.verificationState).toBe('unverified');
  });
});
