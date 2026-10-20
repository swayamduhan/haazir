import { createApp } from './api/app';
import { OrgName, ORGS } from './config';
import { connect } from './gateway';

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
  const app = createApp(gateway, { corsOrigin: process.env.CORS_ORIGIN });
  const server = app.listen(port, () => {
    console.log(`haazir api listening on :${port} as ${ORGS[org].mspId}`);
  });

  const shutdown = () => {
    server.close(() => gateway.close());
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('api failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
