import { Context } from 'fabric-contract-api';
import {
  AttendanceRecord, canonicalize, deriveNonce, NonceAudit, NonceVerdict, Session,
} from '@haazir/shared';
import { ATTENDANCE_RECORD, collectJson, nonceAuditKey } from './keys';
import { txTimestampIso } from './ledger-time';

/**
 * Recomputes every nonce claimed during a session, once the seed is known.
 *
 * Called from `closeSession` in the same transaction as the reveal, so a
 * session cannot be closed without its claims being adjudicated — and both
 * endorsing organisations must reach identical verdicts for the close to
 * commit. During the session itself this is impossible: the seed is on the
 * faculty device and the contract has nothing to compare against. ADR-016.
 *
 * Superseded records are audited too. A nonce claim is a fact about what the
 * device asserted at that instant; a later correction changes the attendance
 * outcome, not what was claimed.
 *
 * Cost is O(n) in the number of records, bounded by the course roster rather
 * than by elapsed time. At a class size of 60 that is 60 reads and one write.
 */
export async function sweepSessionNonces(
  ctx: Context,
  session: Session,
  revealedSeed: string,
): Promise<NonceAudit> {
  // Range query, not a rich query: range results are recorded as
  // RangeQueryInfo and revalidated at commit, so a record inserted
  // concurrently invalidates this close instead of escaping the sweep.
  // Results arrive in lexical key order — sessionID, studentID, seq — which
  // is why the sequence number is zero-padded. Defect C6.
  const records = await collectJson<AttendanceRecord>(
    ctx, ATTENDANCE_RECORD, [session.sessionID],
  );

  const verdicts: NonceVerdict[] = [];
  for (const record of records) {
    if (record.origin !== 'device') continue;
    if (record.claimedNonce === undefined || record.claimedWindow === undefined) continue;

    const expectedNonce = deriveNonce(revealedSeed, record.claimedWindow);
    verdicts.push({
      studentID: record.studentID,
      recordID: record.recordID,
      claimedWindow: record.claimedWindow,
      claimedNonce: record.claimedNonce,
      expectedNonce,
      valid: record.claimedNonce === expectedNonce,
    });
  }

  const validCount = verdicts.filter((v) => v.valid).length;
  const audit: NonceAudit = {
    sessionID: session.sessionID,
    checkedAt: txTimestampIso(ctx),
    recordsChecked: verdicts.length,
    validCount,
    invalidCount: verdicts.length - validCount,
    verdicts,
  };

  await ctx.stub.putState(
    nonceAuditKey(ctx, session.sessionID), Buffer.from(canonicalize(audit)),
  );
  return audit;
}
