import { createApp } from './api/app';
import { OrgName, ORGS } from './config';
import { connect } from './gateway';
import { IpfsEvidenceStore } from './offchain/evidence';
import { PostgresPiiStore } from './offchain/pii';

const PII_URL = process.env.PII_DATABASE_URL
  ?? 'postgres://registrar:registrar-dev-only@127.0.0.1:5432/haazir_pii';
const IPFS_API = process.env.IPFS_API ?? 'http://127.0.0.1:5001';

/** The off-chain stores are optional: without them the ledger routes still work. */
async function optional<T>(label: string, open: () => Promise<T>): Promise<T | undefined> {
  try {
    return await open();
  } catch (err) {
    console.warn(`${label} unavailable (${err instanceof Error ? err.message : err}); its routes will answer 503`);
    return undefined;
  }
}

/**
 * Runs the REST API against the live network.
 *
 *   HAAZIR_ORG   organisation whose admin identity signs submissions (default: registrar)
 *   PORT         listening port (default: 3000)
 *   CORS_ORIGIN  allowed browser origin (default: *, development only)
 *
 * Whichever organisation the server connects as, every write is still sent to
 * both endorsing peers and needs both signatures, so choosing an organisation
 * here grants no ability to write alone.
 */
async function main(): Promise<void> {
  const org = (process.env.HAAZIR_ORG ?? 'registrar') as OrgName;
  if (!(org in ORGS)) throw new Error(`HAAZIR_ORG must be one of ${Object.keys(ORGS).join(', ')}`);
  const port = Number(process.env.PORT ?? 3000);

  const gateway = await connect(org);
  const pii = await optional('personal-data store', () => PostgresPiiStore.connect(PII_URL));
  const evidence = await optional('evidence store', () => IpfsEvidenceStore.connect(IPFS_API));
  const app = createApp(gateway, { corsOrigin: process.env.CORS_ORIGIN, pii, evidence });
  const server = app.listen(port, () => {
    console.log(`haazir api listening on :${port} as ${ORGS[org].mspId}`
      + ` (pii: ${pii ? 'postgres' : 'off'}, evidence: ${evidence ? 'ipfs' : 'off'})`);
  });

  const shutdown = () => {
    server.close(() => { gateway.close(); void pii?.close(); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('api failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
