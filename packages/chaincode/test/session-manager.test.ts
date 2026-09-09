import { Context } from 'fabric-contract-api';
import { SessionManager } from '../src/contracts/session-manager';
import { IdentityRegistry } from '../src/contracts/identity-registry';
import { makeContext, nextTx } from './helpers/mock-context';
import {
  commitSeed, deriveNonce, sha256Hex, Session, VerificationState,
} from '@haazir/shared';

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

describe('closeSession — commit-reveal', () => {
  const setup = async () => {
    const { ctx, facultyID } = await withFaculty();
    return createDefaultSession(ctx, facultyID);
  };

  it('accepts the seed whose hash was committed at creation', async () => {
    const after = await setup();
    const closing = nextTx(after, { txId: 'tx-close', timestampMs: START_MS + 3_600_000 });
    await sm().closeSession(closing, 'S1', SEED);
    const s = await read(nextTx(closing));
    expect(s.status).toBe('closed');
    expect(s.revealedSeed).toBe(SEED);
    expect(s.verificationState).toBe('verified');
  });

  it('rejects any other seed, blocking a retrofitted commitment', async () => {
    const after = await setup();
    await expect(
      sm().closeSession(nextTx(after, { timestampMs: START_MS + 3_600_000 }),
        'S1', 'cd'.repeat(32)),
    ).rejects.toThrow(/SEED_COMMITMENT_MISMATCH/);
  });

  it('leaves the session open when the reveal is rejected', async () => {
    const after = await setup();
    const bad = nextTx(after, { timestampMs: START_MS + 3_600_000 });
    await expect(sm().closeSession(bad, 'S1', 'cd'.repeat(32))).rejects.toThrow();
    expect((await read(nextTx(bad))).status).toBe('open');
  });

  it('records who closed it and when, from the ledger', async () => {
    const after = await setup();
    const closing = nextTx(after, {
      txId: 'tx-close', timestampMs: START_MS + 3_600_000, clientId: 'x509::CN=faculty-a',
    });
    await sm().closeSession(closing, 'S1', SEED);
    const s = await read(nextTx(closing));
    expect(s.closedBy).toBe('x509::CN=faculty-a');
    expect(s.closedAt).toBe('2026-09-09T11:00:00.000Z');
  });

  it('rejects a reveal after the grace period has elapsed', async () => {
    const after = await setup();
    await expect(
      sm().closeSession(nextTx(after, { timestampMs: START_MS + 9_000_000 }), 'S1', SEED),
    ).rejects.toThrow(/GRACE_PERIOD_ELAPSED/);
  });

  it('rejects closing a session twice', async () => {
    const after = await setup();
    const closing = nextTx(after, { timestampMs: START_MS + 3_600_000 });
    await sm().closeSession(closing, 'S1', SEED);
    await expect(
      sm().closeSession(nextTx(closing, { timestampMs: START_MS + 3_610_000 }), 'S1', SEED),
    ).rejects.toThrow(/SESSION_NOT_OPEN/);
  });

  it('rejects a caller from a non-endorsing organisation', async () => {
    const after = await setup();
    await expect(
      sm().closeSession(
        nextTx(after, { timestampMs: START_MS + 3_600_000, mspId: 'AuditMSP' }), 'S1', SEED),
    ).rejects.toThrow(/UNAUTHORISED_ORG/);
  });

  it('rejects a malformed seed', async () => {
    const after = await setup();
    await expect(
      sm().closeSession(nextTx(after, { timestampMs: START_MS + 3_600_000 }), 'S1', 'nothex'),
    ).rejects.toThrow(/INVALID_SEED/);
  });

  it('makes every window independently verifiable once revealed', async () => {
    const after = await setup();
    const closing = nextTx(after, { timestampMs: START_MS + 3_600_000 });
    await sm().closeSession(closing, 'S1', SEED);
    const s = await read(nextTx(closing));
    // Anyone holding only the ledger can now recompute any window's nonce.
    expect(deriveNonce(s.revealedSeed!, 7)).toBe(deriveNonce(SEED, 7));
  });
});

describe('expireSession', () => {
  const setup = async () => {
    const { ctx, facultyID } = await withFaculty();
    return createDefaultSession(ctx, facultyID);
  };

  it('rejects expiry before the grace period has elapsed', async () => {
    const after = await setup();
    await expect(
      sm().expireSession(nextTx(after, { timestampMs: START_MS + 3_600_000 }), 'S1'),
    ).rejects.toThrow(/GRACE_PERIOD_NOT_ELAPSED/);
  });

  it('marks the session expired once the grace period has passed', async () => {
    const after = await setup();
    const exp = nextTx(after, { txId: 'tx-exp', timestampMs: START_MS + 9_000_000 });
    await sm().expireSession(exp, 'S1');
    const s = await read(nextTx(exp, { timestampMs: START_MS + 9_100_000 }));
    expect(s.status).toBe('expired');
    expect(s.verificationState).toBe('unverified');
    expect(s.expiredBy).toBeDefined();
  });

  it('rejects expiring a closed session', async () => {
    const after = await setup();
    const closing = nextTx(after, { timestampMs: START_MS + 3_600_000 });
    await sm().closeSession(closing, 'S1', SEED);
    await expect(
      sm().expireSession(nextTx(closing, { timestampMs: START_MS + 9_000_000 }), 'S1'),
    ).rejects.toThrow(/SESSION_NOT_OPEN/);
  });
});
