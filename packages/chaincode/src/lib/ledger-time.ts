import { Context } from 'fabric-contract-api';

/**
 * Time comes from the ledger, never from the system clock or a parameter.
 *
 * Date.now() would differ between endorsing peers and fail endorsement; a
 * client-supplied timestamp is a claim and permits backdating. Spec section
 * 2.1, defect C4.
 *
 * Note new Date(ms) with an explicit argument is deterministic and allowed;
 * the determinism rule prohibits READING the clock, not formatting a known
 * instant. Spec section 10.3.
 */
export function txTimestampMs(ctx: Context): number {
  const ts = ctx.stub.getTxTimestamp();
  return Number(ts.seconds) * 1000 + Math.round(ts.nanos / 1e6);
}

export function txTimestampIso(ctx: Context): string {
  return new Date(txTimestampMs(ctx)).toISOString();
}
