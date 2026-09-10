import { Context } from 'fabric-contract-api';
import { fail } from './errors';

/**
 * Organisations permitted to write. Audit is deliberately absent: it commits
 * and reads every block, and endorses nothing. Spec section 3.
 *
 * Authorisation is organisation-level throughout this milestone. Binding an
 * on-chain identity id to the X.509 identity that submitted the transaction
 * is unspecified and deferred; see ADR-013.
 */
export const ENDORSING_MSPS = ['RegistrarMSP', 'ExamCellMSP'];

export function assertEndorsingOrg(ctx: Context): void {
  const msp = ctx.clientIdentity.getMSPID();
  if (!ENDORSING_MSPS.includes(msp)) {
    fail('UNAUTHORISED_ORG', `organisation "${msp}" may not perform this operation`);
  }
}
