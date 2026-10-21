import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import { createHash } from 'crypto';
import { ContractHandle, FabricFailure } from '../gateway';
import { EvidenceStore } from '../offchain/evidence';
import { PiiStore } from '../offchain/pii';
import { httpStatusFor } from './http-status';

/** Anything that can hand out contract handles: the real gateway, or a test fake. */
export interface Ledger {
  contract(name: string): ContractHandle;
}

export interface AppOptions {
  /** Value for Access-Control-Allow-Origin. The browser clients need it. */
  corsOrigin?: string;
  /** Personal data store. Without it the registrar routes answer 503. */
  pii?: PiiStore;
  /** Exemption evidence store. Without it the evidence routes answer 503. */
  evidence?: EvidenceStore;
}

/**
 * A rejection the API raises itself, before the ledger is involved. Kept to
 * the minimum: presence of fields and one protocol rule. Everything about
 * whether a value is *valid* is the chaincode's decision, made by two
 * organisations; duplicating that logic here would create a second, weaker
 * authority that could drift from the first.
 */
class RequestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { handler(req, res).catch(next); };

/** Reads required body fields as strings, which is what chaincode arguments are. */
function fields(body: Record<string, unknown> | undefined, names: string[]): string[] {
  const missing = names.filter((n) => body?.[n] === undefined || body?.[n] === null);
  if (missing.length > 0) {
    throw new RequestError('MISSING_FIELD', `required: ${missing.join(', ')}`);
  }
  return names.map((n) => {
    const v = body![n];
    if (typeof v === 'object') {
      throw new RequestError('INVALID_FIELD', `"${n}" must be a string or a number`);
    }
    return String(v);
  });
}

/** Chaincode returns canonical JSON for records and bare strings for ids and flags. */
function parse(result: string): unknown {
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

/**
 * The HTTP face of the ledger.
 *
 * Thin by design: each route names one chaincode function and passes its
 * arguments through. Writes go through `submit`, which collects endorsements
 * from both Registrar and Exam Cell; reads go through `evaluate`, which asks
 * one peer and writes nothing.
 */
export function createApp(ledger: Ledger, options: AppOptions = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', options.corsOrigin ?? '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  const identities = () => ledger.contract('IdentityRegistry');
  const sessions = () => ledger.contract('SessionManager');
  const roster = () => ledger.contract('CourseRoster');
  const attendance = () => ledger.contract('AttendanceRecorder');
  const policy = () => ledger.contract('PolicyEngine');

  const send = (res: Response, result: string, status = 200) =>
    void res.status(status).json(parse(result));

  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });

  // ------------------------------------------------------------ identities
  app.post('/identities', route(async (req, res) => {
    const [identityHash, publicKey, role] =
      fields(req.body, ['identityHash', 'publicKey', 'role']);
    const identityID = await identities().submit('registerIdentity', identityHash, publicKey, role);
    res.status(201).json({ identityID });
  }));

  app.get('/identities/:id', route(async (req, res) => {
    send(res, await identities().evaluate('getIdentityStatus', req.params.id));
  }));

  app.post('/identities/:id/rotate-key', route(async (req, res) => {
    const [oldPublicKeyHash, newPublicKey, reason] =
      fields(req.body, ['oldPublicKeyHash', 'newPublicKey', 'reason']);
    send(res, await identities().submit(
      'revokeAndReissueKey', req.params.id, oldPublicKeyHash, newPublicKey, reason));
  }));

  // ---------------------------------------------------------------- roster
  app.post('/courses/:courseID/roster', route(async (req, res) => {
    const [studentID] = fields(req.body, ['studentID']);
    send(res, await roster().submit('enrolStudent', req.params.courseID, studentID), 201);
  }));

  app.delete('/courses/:courseID/roster/:studentID', route(async (req, res) => {
    send(res, await roster().submit('dropStudent', req.params.courseID, req.params.studentID));
  }));

  app.get('/courses/:courseID/roster', route(async (req, res) => {
    send(res, await roster().evaluate('getRoster', req.params.courseID));
  }));

  app.get('/courses/:courseID/sessions', route(async (req, res) => {
    send(res, await policy().evaluate('getCourseSessions', req.params.courseID));
  }));

  // -------------------------------------------------------------- sessions
  app.post('/sessions', route(async (req, res) => {
    // The one rule enforced here rather than in the contract: the seed itself
    // must never reach this server while the session is open. A server that
    // has seen the seed can mint valid codes for absent students, which is
    // exactly what commit-reveal exists to prevent. Refusing the field makes a
    // client bug loud instead of silently weakening the protocol. ADR-007.
    for (const forbidden of ['seed', 'nonceSeed', 'revealedSeed']) {
      if (req.body && forbidden in req.body) {
        throw new RequestError('SEED_MUST_NOT_BE_SENT',
          'send only nonceSeedHash; the seed stays on the faculty device until close');
      }
    }
    const [sessionID, courseID, facultyID, room, startTime, durationSec,
      gracePeriodSec, geofenceRadiusM, nonceSeedHash] = fields(req.body, [
      'sessionID', 'courseID', 'facultyID', 'room', 'startTime', 'durationSec',
      'gracePeriodSec', 'geofenceRadiusM', 'nonceSeedHash',
    ]);
    const centre = req.body.geofenceCenter;
    if (typeof centre !== 'object' || centre === null || !('lat' in centre) || !('lng' in centre)) {
      throw new RequestError('MISSING_FIELD', 'required: geofenceCenter {lat, lng}');
    }
    send(res, await sessions().submit(
      'createSession', sessionID, courseID, facultyID, room, startTime, durationSec,
      gracePeriodSec, JSON.stringify({ lat: centre.lat, lng: centre.lng }),
      geofenceRadiusM, nonceSeedHash,
    ), 201);
  }));

  app.get('/sessions/:id', route(async (req, res) => {
    send(res, await sessions().evaluate('getSession', req.params.id));
  }));

  app.post('/sessions/:id/close', route(async (req, res) => {
    const [revealedSeed] = fields(req.body, ['revealedSeed']);
    send(res, await sessions().submit('closeSession', req.params.id, revealedSeed));
  }));

  app.post('/sessions/:id/expire', route(async (req, res) => {
    send(res, await sessions().submit('expireSession', req.params.id));
  }));

  app.get('/sessions/:id/nonce-audit', route(async (req, res) => {
    send(res, await attendance().evaluate('getNonceAudit', req.params.id));
  }));

  // ------------------------------------------------------------ attendance
  app.post('/sessions/:id/attendance', route(async (req, res) => {
    // Relayed exactly as the device produced it. This server cannot forge a
    // submission: the contract verifies the device signature over every
    // field, against the key the Registrar enrolled.
    const [studentID, claimedWindow, claimedNonce, latE7, lngE7, livenessHash,
      deviceSignature] = fields(req.body, [
      'studentID', 'claimedWindow', 'claimedNonce', 'latE7', 'lngE7',
      'livenessHash', 'deviceSignature',
    ]);
    send(res, await attendance().submit(
      'markAttendance', req.params.id, studentID, claimedWindow, claimedNonce,
      latE7, lngE7, livenessHash, deviceSignature,
    ), 201);
  }));

  app.get('/sessions/:id/attendance', route(async (req, res) => {
    send(res, await attendance().evaluate('getSessionAttendance', req.params.id));
  }));

  app.get('/sessions/:id/attendance/:studentID', route(async (req, res) => {
    send(res, await attendance().evaluate('getAttendance', req.params.id, req.params.studentID));
  }));

  app.post('/sessions/:id/attendance/:studentID/corrections', route(async (req, res) => {
    const [newStatus, reason] = fields(req.body, ['newStatus', 'reason']);
    send(res, await attendance().submit(
      'correctAttendance', req.params.id, req.params.studentID, newStatus, reason), 201);
  }));

  // ---------------------------------------------------------------- policy
  const student = '/courses/:courseID/students/:studentID';

  app.get(`${student}/eligibility`, route(async (req, res) => {
    send(res, await policy().evaluate(
      'computeEligibility', req.params.courseID, req.params.studentID));
  }));

  app.get(`${student}/exemptions`, route(async (req, res) => {
    send(res, await policy().evaluate(
      'listExemptions', req.params.courseID, req.params.studentID));
  }));

  app.post(`${student}/exemptions`, route(async (req, res) => {
    const [sessionID, kind, effect, evidenceCID, reason] =
      fields(req.body, ['sessionID', 'kind', 'effect', 'evidenceCID', 'reason']);
    send(res, await policy().submit(
      'applyExemption', req.params.courseID, req.params.studentID, sessionID,
      kind, effect, evidenceCID, reason,
    ), 201);
  }));

  app.post(`${student}/exemptions/:sessionID/revoke`, route(async (req, res) => {
    const [reason] = fields(req.body, ['reason']);
    send(res, await policy().submit(
      'revokeExemption', req.params.courseID, req.params.studentID,
      req.params.sessionID, reason));
  }));

  // ------------------------------------------------------- registrar desk
  // Personal data goes to PostgreSQL; only a salted hash reaches the ledger.
  const pii = () => {
    if (!options.pii) throw new RequestError('OFFCHAIN_UNAVAILABLE', 'the personal-data store is not configured');
    return options.pii;
  };
  const evidence = () => {
    if (!options.evidence) throw new RequestError('OFFCHAIN_UNAVAILABLE', 'the evidence store is not configured');
    return options.evidence;
  };

  app.post('/registrar/students', route(async (req, res) => {
    const [name, regNo, publicKey] = fields(req.body, ['name', 'regNo', 'publicKey']);
    const role = req.body.role === 'faculty' ? 'faculty' : 'student';
    const store = pii();
    if (await store.hasRegNo(regNo)) {
      throw new RequestError('REG_NO_EXISTS', `"${regNo}" is already registered`);
    }
    const { salt, identityHash } = store.prepare(name, regNo);
    const identityID = await identities().submit('registerIdentity', identityHash, publicKey, role);
    await store.save({ identityID, name, regNo, salt, identityHash });
    res.status(201).json({ identityID, identityHash });
  }));

  app.get('/registrar/students/:id', route(async (req, res) => {
    const record = await pii().get(req.params.id);
    if (!record) throw new RequestError('PII_NOT_FOUND', 'no personal data held for this identity');
    res.json(record);
  }));

  app.delete('/registrar/students/:id/pii', route(async (req, res) => {
    if (!(await pii().erase(req.params.id))) {
      throw new RequestError('PII_NOT_FOUND', 'no personal data held for this identity');
    }
    // The on-chain identity is untouched, and now unlinkable: its hash cannot
    // be recomputed without the salt that was just deleted.
    res.json({ identityID: req.params.id, erased: true });
  }));

  // -------------------------------------------------------------- evidence
  app.post('/evidence', express.raw({ type: () => true, limit: '10mb' }), route(async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new RequestError('MISSING_FIELD', 'send the document as the request body');
    }
    const name = String(req.header('X-Filename') ?? 'evidence').slice(0, 120);
    const cid = await evidence().add(body, name);
    res.status(201).json({ cid, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  }));

  app.get('/evidence/:cid', route(async (req, res) => {
    const doc = await evidence().get(req.params.cid);
    if (!doc) throw new RequestError('EVIDENCE_NOT_FOUND', 'no such document on this node');
    res.type('application/octet-stream').send(doc);
  }));

  app.delete('/evidence/:cid', route(async (req, res) => {
    await evidence().remove(req.params.cid);
    res.status(204).end();
  }));

  // ---------------------------------------------------------------- errors
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NO_SUCH_ROUTE', detail: 'no such endpoint' } });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof RequestError) {
      const status = err.code.endsWith('_NOT_FOUND') ? 404
        : err.code === 'REG_NO_EXISTS' ? 409
          : err.code === 'OFFCHAIN_UNAVAILABLE' ? 503 : 400;
      res.status(status).json({ error: { code: err.code, detail: err.message } });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: { code: 'INVALID_JSON', detail: 'request body is not valid JSON' } });
      return;
    }
    const fabric = (err as { fabric?: FabricFailure })?.fabric;
    if (fabric) {
      // The raw Fabric text stays in the server log, not the response: it
      // carries peer addresses and internal detail a client does not need.
      if (httpStatusFor(fabric.code) >= 500) console.error('[ledger]', fabric.raw);
      res.status(httpStatusFor(fabric.code))
        .json({ error: { code: fabric.code, detail: fabric.detail } });
      return;
    }
    console.error('[api]', err);
    res.status(500).json({ error: { code: 'INTERNAL', detail: 'unexpected server error' } });
  });

  return app;
}
