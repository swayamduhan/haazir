import { Context } from 'fabric-contract-api';

/**
 * All lookups use composite keys and plain state reads.
 *
 * Rich queries are deliberately avoided for existence checks: Fabric does
 * not include rich-query results in a transaction's read set, so they are
 * not revalidated at commit and two concurrent writes can both succeed.
 * A composite-key getState IS in the read set and is protected by MVCC.
 * Spec section 2.2, defect C6.
 */
export const IDENTITY = 'identity';
export const IDENTITY_HASH_INDEX = 'identityHash~id';
export const SESSION = 'session';
export const REVOCATION = 'revocation';

export const identityKey = (ctx: Context, identityID: string): string =>
  ctx.stub.createCompositeKey(IDENTITY, [identityID]);

export const identityHashIndexKey = (ctx: Context, identityHash: string): string =>
  ctx.stub.createCompositeKey(IDENTITY_HASH_INDEX, [identityHash]);

export const sessionKey = (ctx: Context, sessionID: string): string =>
  ctx.stub.createCompositeKey(SESSION, [sessionID]);

export const revocationKey = (ctx: Context, eventID: string): string =>
  ctx.stub.createCompositeKey(REVOCATION, [eventID]);

export async function exists(ctx: Context, key: string): Promise<boolean> {
  return (await ctx.stub.getState(key)).length > 0;
}

export async function readJson<T>(ctx: Context, key: string): Promise<T | undefined> {
  const bytes = await ctx.stub.getState(key);
  return bytes.length === 0 ? undefined : (JSON.parse(bytes.toString()) as T);
}

export const ROSTER = 'roster';
export const ATTENDANCE_INDEX = 'attendance';
export const ATTENDANCE_RECORD = 'attRec';
export const NONCE_AUDIT = 'nonceAudit';

export const rosterKey = (ctx: Context, courseID: string, studentID: string): string =>
  ctx.stub.createCompositeKey(ROSTER, [courseID, studentID]);

/**
 * One student's current attendance state in one session.
 *
 * Kept apart from the records so the duplicate check is a single getState on
 * an exact key rather than a scan — in the read set, and so protected by MVCC.
 */
export const attendanceIndexKey = (
  ctx: Context, sessionID: string, studentID: string,
): string => ctx.stub.createCompositeKey(ATTENDANCE_INDEX, [sessionID, studentID]);

/**
 * Sequence numbers are zero-padded so that Fabric's lexical key ordering is
 * also numeric ordering. Unpadded, "10" would sort before "2".
 */
export const seqOf = (seq: number): string => String(seq).padStart(6, '0');

export const attendanceRecordKey = (
  ctx: Context, sessionID: string, studentID: string, seq: number,
): string => ctx.stub.createCompositeKey(
  ATTENDANCE_RECORD, [sessionID, studentID, seqOf(seq)],
);

export const nonceAuditKey = (ctx: Context, sessionID: string): string =>
  ctx.stub.createCompositeKey(NONCE_AUDIT, [sessionID]);

/**
 * Every entry under a partial composite key, in Fabric's lexical key order.
 *
 * Range queries are recorded in the read-write set as RangeQueryInfo and
 * revalidated by the committer, so a record inserted concurrently invalidates
 * this transaction rather than escaping it. A CouchDB rich query carries no
 * such record and would make any sweep built on it silently incomplete —
 * defect C6, which is why rich queries appear nowhere in this codebase.
 */
export async function collectJson<T>(
  ctx: Context,
  objectType: string,
  attributes: string[],
): Promise<T[]> {
  const iterator = await ctx.stub.getStateByPartialCompositeKey(objectType, attributes);
  const results: T[] = [];
  try {
    let entry = await iterator.next();
    while (!entry.done) {
      const bytes = entry.value?.value;
      if (bytes && bytes.length > 0) results.push(JSON.parse(bytes.toString()) as T);
      entry = await iterator.next();
    }
  } finally {
    await iterator.close();
  }
  return results;
}

export const COURSE_SESSION = 'courseSession';
export const EXEMPTION = 'exemption';

/**
 * One course's sessions, enumerable by range query.
 *
 * Without it, counting a course's sessions would mean scanning every session
 * on the ledger and filtering — unbounded, and growing for the life of the
 * institution. With it the scan is bounded by one course's timetable.
 */
export const courseSessionKey = (
  ctx: Context, courseID: string, sessionID: string,
): string => ctx.stub.createCompositeKey(COURSE_SESSION, [courseID, sessionID]);

/**
 * Ordered course, student, session so that one student's exemptions for one
 * course come back in a single range query rather than a read per session.
 */
export const exemptionKey = (
  ctx: Context, courseID: string, studentID: string, sessionID: string,
): string => ctx.stub.createCompositeKey(EXEMPTION, [courseID, studentID, sessionID]);
