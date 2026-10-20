import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { createApp, Ledger } from '../src/api/app';
import { httpStatusFor } from '../src/api/http-status';

interface Call {
  contract: string;
  kind: 'submit' | 'evaluate';
  fn: string;
  args: string[];
}

/** A rejection shaped exactly as the real gateway throws it. */
const rejected = (code: string, detail = 'detail') =>
  Object.assign(new Error(`${code}: ${detail}`), {
    fabric: { code, detail, raw: `peer0.org1.example.com:7051 internal ${code}` },
  });

/** Records every call; `respond` decides what each one returns or throws. */
function fake(respond: (c: Call) => string | Error = () => '{"ok":true}') {
  const calls: Call[] = [];
  const ledger: Ledger = {
    contract: (contract) => {
      const handle = (kind: Call['kind']) => async (fn: string, ...args: string[]) => {
        const call = { contract, kind, fn, args };
        calls.push(call);
        const out = respond(call);
        if (out instanceof Error) throw out;
        return out;
      };
      return { submit: handle('submit'), evaluate: handle('evaluate') };
    },
  };
  return { calls, app: createApp(ledger) };
}

const SESSION = {
  sessionID: 'S1', courseID: 'CS101', facultyID: 'fac-1', room: 'LH-3',
  startTime: '2026-10-21T10:00:00.000Z', durationSec: 3600, gracePeriodSec: 900,
  geofenceCenter: { lat: 12.9716, lng: 77.5946 }, geofenceRadiusM: 50,
  nonceSeedHash: 'ab'.repeat(32),
};

const MARK = {
  studentID: 'stu-1', claimedWindow: 7, claimedNonce: 'cd'.repeat(32),
  latE7: 129716000, lngE7: 775946000, livenessHash: 'ef'.repeat(32),
  deviceSignature: '12'.repeat(64),
};

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('routing to the ledger', () => {
  it('reports health without touching the ledger', async () => {
    const { app, calls } = fake();
    await request(app).get('/health').expect(200, { status: 'ok' });
    expect(calls).toHaveLength(0);
  });

  it('registers an identity through a submit, returning the derived id', async () => {
    const { app, calls } = fake(() => 'b7f1c2d4-0000-4000-8000-000000000001');
    const res = await request(app).post('/identities')
      .send({ identityHash: 'aa'.repeat(32), publicKey: 'bb'.repeat(32), role: 'student' })
      .expect(201);

    expect(res.body).toEqual({ identityID: 'b7f1c2d4-0000-4000-8000-000000000001' });
    expect(calls).toEqual([{
      contract: 'IdentityRegistry', kind: 'submit', fn: 'registerIdentity',
      args: ['aa'.repeat(32), 'bb'.repeat(32), 'student'],
    }]);
  });

  it('sends reads to evaluate, which writes nothing', async () => {
    const { app, calls } = fake(() => '{"eligible":true}');
    const res = await request(app).get('/courses/CS101/students/stu-1/eligibility').expect(200);

    expect(res.body).toEqual({ eligible: true });
    expect(calls[0]).toMatchObject({
      contract: 'PolicyEngine', kind: 'evaluate', fn: 'computeEligibility', args: ['CS101', 'stu-1'],
    });
  });

  it('opens a session with the geofence as JSON and every argument as a string', async () => {
    const { app, calls } = fake();
    await request(app).post('/sessions').send(SESSION).expect(201);

    expect(calls[0]).toMatchObject({ contract: 'SessionManager', kind: 'submit', fn: 'createSession' });
    expect(calls[0].args).toEqual([
      'S1', 'CS101', 'fac-1', 'LH-3', '2026-10-21T10:00:00.000Z', '3600', '900',
      '{"lat":12.9716,"lng":77.5946}', '50', 'ab'.repeat(32),
    ]);
  });

  it('relays a device submission in the exact order the contract signs it', async () => {
    const { app, calls } = fake();
    await request(app).post('/sessions/S1/attendance').send(MARK).expect(201);

    expect(calls[0]).toMatchObject({ contract: 'AttendanceRecorder', kind: 'submit', fn: 'markAttendance' });
    expect(calls[0].args).toEqual([
      'S1', 'stu-1', '7', 'cd'.repeat(32), '129716000', '775946000', 'ef'.repeat(32), '12'.repeat(64),
    ]);
  });

  it('closes a session by revealing the seed', async () => {
    const { app, calls } = fake();
    await request(app).post('/sessions/S1/close').send({ revealedSeed: '9a'.repeat(32) }).expect(200);
    expect(calls[0]).toMatchObject({ fn: 'closeSession', args: ['S1', '9a'.repeat(32)] });
  });

  it('routes corrections and exemptions to their contracts', async () => {
    const { app, calls } = fake();
    await request(app).post('/sessions/S1/attendance/stu-1/corrections')
      .send({ newStatus: 'absent', reason: 'left early' }).expect(201);
    await request(app).post('/courses/CS101/students/stu-1/exemptions/W3/revoke')
      .send({ reason: 'withdrawn' }).expect(200);

    expect(calls.map((c) => `${c.contract}.${c.fn}`)).toEqual([
      'AttendanceRecorder.correctAttendance', 'PolicyEngine.revokeExemption',
    ]);
    expect(calls[1].args).toEqual(['CS101', 'stu-1', 'W3', 'withdrawn']);
  });
});

describe('what the API refuses on its own', () => {
  it('refuses to open a session if the client sends the seed itself', async () => {
    const { app, calls } = fake();
    const res = await request(app).post('/sessions')
      .send({ ...SESSION, seed: '9a'.repeat(32) }).expect(400);

    // A server that has seen the seed can mint codes for absent students.
    // The request must fail before anything reaches the ledger. ADR-007.
    expect(res.body.error.code).toBe('SEED_MUST_NOT_BE_SENT');
    expect(calls).toHaveLength(0);
  });

  it('names every missing field and does not call the ledger', async () => {
    const { app, calls } = fake();
    const res = await request(app).post('/identities').send({ role: 'student' }).expect(400);

    expect(res.body.error).toEqual({ code: 'MISSING_FIELD', detail: 'required: identityHash, publicKey' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a structured value where the contract expects a scalar', async () => {
    const { app } = fake();
    const res = await request(app).post('/sessions/S1/close')
      .send({ revealedSeed: { value: 'x' } }).expect(400);
    expect(res.body.error.code).toBe('INVALID_FIELD');
  });

  it('refuses a session with no geofence centre', async () => {
    const { app } = fake();
    const { geofenceCenter: _, ...noCentre } = SESSION;
    const res = await request(app).post('/sessions').send(noCentre).expect(400);
    expect(res.body.error.detail).toMatch(/geofenceCenter/);
  });

  it('answers malformed JSON with a 400, not a crash', async () => {
    const { app } = fake();
    const res = await request(app).post('/identities')
      .set('Content-Type', 'application/json').send('{"identityHash": ').expect(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('answers an unknown route with a 404 in the same error shape', async () => {
    const { app } = fake();
    const res = await request(app).get('/nowhere').expect(404);
    expect(res.body.error.code).toBe('NO_SUCH_ROUTE');
  });
});

describe('translating chaincode rejections', () => {
  it.each([
    ['OUTSIDE_GEOFENCE', 422],
    ['INVALID_SIGNATURE', 422],
    ['WINDOW_MISMATCH', 422],
    ['NOT_ENROLLED', 422],
    ['DUPLICATE_ATTENDANCE', 409],
    ['SESSION_NOT_OPEN', 409],
    ['SESSION_NOT_FOUND', 404],
    ['UNAUTHORISED_ORG', 403],
  ])('%s becomes %i, keeping the chaincode code in the body', async (code, status) => {
    const { app } = fake(() => rejected(code, 'the contract said no'));
    const res = await request(app).post('/sessions/S1/attendance').send(MARK).expect(status);
    expect(res.body).toEqual({ error: { code, detail: 'the contract said no' } });
  });

  it('treats an endorsement policy failure as a server fault, and does not leak peer detail', async () => {
    const { app } = fake(() => rejected('ENDORSEMENT_POLICY_FAILURE'));
    const res = await request(app).post('/sessions/S1/attendance').send(MARK).expect(502);

    expect(res.body.error.code).toBe('ENDORSEMENT_POLICY_FAILURE');
    expect(JSON.stringify(res.body)).not.toContain('peer0.org1');
  });

  it('answers an unexpected error with a generic 500', async () => {
    const { app } = fake(() => new Error('socket hang up'));
    const res = await request(app).get('/sessions/S1').expect(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL', detail: 'unexpected server error' } });
  });

  it('maps every rejection code in the chaincode to a 4xx, never a server error', () => {
    // Read the codes straight from the contract source, so a code added to the
    // chaincode later cannot silently surface to clients as a 5xx.
    const dir = path.join(__dirname, '../../packages/chaincode/src');
    const codes = new Set<string>();
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/fail\('([A-Z_]+)'/g)) codes.add(m[1]);
      }
    });
    walk(dir);

    expect(codes.size).toBeGreaterThan(40);
    const serverErrors = [...codes].filter((c) => httpStatusFor(c) >= 500);
    expect(serverErrors).toEqual([]);
  });
});

describe('browser access', () => {
  it('answers a CORS preflight so the web clients can call it', async () => {
    const { app, calls } = fake();
    const res = await request(app).options('/sessions').expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(calls).toHaveLength(0);
  });
});
