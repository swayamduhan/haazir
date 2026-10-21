import { createHash } from 'crypto';
import * as fs from 'fs';
import { AddressInfo } from 'net';
import * as path from 'path';
import { generateDeviceKeyPair, hashIdentity } from '@haazir/shared';
import { createApp } from '../api/app';
import { IpfsEvidenceStore } from '../offchain/evidence';
import { isLive, PostgresPiiStore } from '../offchain/pii';
import { hex, ledger, newFaculty, openSession } from './common';

/**
 * The privacy architecture, demonstrated end to end on the real stores:
 * personal data in PostgreSQL, evidence on a private IPFS node, only hashes
 * and content identifiers on the ledger — and erasure of both without
 * touching the chain.
 *
 *   ./network/scripts/offchain-up.sh
 *   npm run offchain --workspace @haazir/backend
 */
const PII_URL = process.env.PII_DATABASE_URL ?? 'postgres://registrar:registrar-dev-only@127.0.0.1:5432/haazir_pii';
const IPFS_API = process.env.IPFS_API ?? 'http://127.0.0.1:5001';

const checks: { check: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  checks.push({ check: name, pass, detail });
  console.log(`  ${pass ? '[ok]  ' : '[FAIL]'} ${name}${detail ? `  (${detail})` : ''}`);
};

async function main(): Promise<void> {
  const l = await ledger('registrar');
  const pii = await PostgresPiiStore.connect(PII_URL);
  const evidence = await IpfsEvidenceStore.connect(IPFS_API);
  const server = createApp(l.gw, { pii, evidence }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown, raw?: Buffer) => {
    const res = await fetch(base + p, {
      method,
      headers: raw ? { 'Content-Type': 'application/pdf', 'X-Filename': 'certificate.pdf' }
        : body ? { 'Content-Type': 'application/json' } : undefined,
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.includes('json') ? await res.json() as any : Buffer.from(await res.arrayBuffer()) };
  };

  console.log('Off-chain stores, end to end\n');
  const name = 'Demo Student';
  const regNo = `23BKT${Math.floor(1000 + Math.random() * 8999)}`;
  const course = `PRIV-${hex(2)}`;

  // 1. Registration at the Registrar's desk.
  const reg = await call('POST', '/registrar/students', { name, regNo, publicKey: generateDeviceKeyPair().publicKeyHex });
  check('register a student through the Registrar desk', reg.status === 201, `HTTP ${reg.status}`);
  const id: string = reg.body.identityID;

  const onChain = JSON.parse(await l.identities.evaluate('getIdentityStatus', id));
  check('the ledger holds no name and no registration number',
    !JSON.stringify(onChain).includes(name) && !JSON.stringify(onChain).includes(regNo));
  const held = await pii.get(id);
  check('the PII store holds the person', isLive(held) && held.name === name);
  check('with the salt, the on-chain hash links to exactly this person',
    isLive(held) && hashIdentity(name, regNo, held.salt) === onChain.identityHash);

  // 2. An exemption backed by a document on IPFS.
  await l.roster.submit('enrolStudent', course, id);
  const faculty = await newFaculty(l);
  const s = await openSession(l, faculty, course);
  const doc = Buffer.from(`%PDF-1.7\nMedical certificate for ${regNo}, ${new Date().toISOString()}\n`);
  const up = await call('POST', '/evidence', undefined, doc);
  check('upload the certificate to the private IPFS node', up.status === 201, up.body.cid);
  const cid: string = up.body.cid;

  const ex = await call('POST', `/courses/${course}/students/${id}/exemptions`,
    { sessionID: s.id, kind: 'medical', effect: 'excluded', evidenceCID: cid, reason: 'hospital admission' });
  check('the exemption is accepted on chain with the CID as its evidence', ex.status === 201);
  const stored = JSON.parse(await l.policy.evaluate('getExemption', course, id, s.id));
  check('the ledger stores the CID, not the document',
    stored.evidenceCID === cid && !JSON.stringify(stored).includes('Medical certificate'));
  const fetched = await call('GET', `/evidence/${cid}`);
  check('the document fetched by CID is byte-identical to what was filed',
    Buffer.isBuffer(fetched.body) && createHash('sha256').update(fetched.body).digest('hex')
      === createHash('sha256').update(doc).digest('hex'));

  // 3. Erasure, as DPDP 2023 requires — without rewriting the ledger.
  const erase = await call('DELETE', `/registrar/students/${id}/pii`);
  check('erase the student’s personal data', erase.status === 200);
  const after = await pii.get(id);
  check('the PII store now holds only a tombstone', !!after && !isLive(after));
  const stillThere = JSON.parse(await l.identities.evaluate('getIdentityStatus', id));
  check('the on-chain identity and its history are untouched', stillThere.identityHash === onChain.identityHash);
  // Unlinkability rests on the salt: 128 random bits, now deleted. Someone who
  // knows the name and number would have to search 2^128 salts to match the
  // on-chain hash. What can be checked is that no copy of the salt survives.
  const stored2 = JSON.stringify(after);
  check('the 128-bit salt is gone, so the hash can no longer be recomputed from a name',
    isLive(held) && !stored2.includes(held.salt) && !stored2.includes(regNo), 'tombstone holds no salt or number');

  const del = await call('DELETE', `/evidence/${cid}`);
  check('delete the certificate from the IPFS node', del.status === 204);
  const gone = await call('GET', `/evidence/${cid}`);
  check('the CID no longer resolves on this node', gone.status === 404);
  const exAfter = JSON.parse(await l.policy.evaluate('getExemption', course, id, s.id));
  check('the on-chain exemption still records which document was filed', exAfter.evidenceCID === cid,
    'a permanent reference to nothing');

  server.close();
  l.gw.close();
  await pii.close();

  const passed = checks.filter((c) => c.pass).length;
  console.log(`\n${passed} of ${checks.length} checks passed.`);
  const out = path.join(__dirname, '../../../docs/evidence/eval');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'offchain.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), passed, total: checks.length, checks }, null, 2));
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((err) => {
  console.error('off-chain check could not run:', err instanceof Error ? err.message : err);
  process.exit(1);
});
