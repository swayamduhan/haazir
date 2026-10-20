/**
 * Maps a chaincode rejection code to an HTTP status.
 *
 * The chaincode is the authority on whether a request is valid; this layer
 * only translates its verdict. The code itself always travels in the response
 * body too, because "422" says that something was wrong and
 * "OUTSIDE_GEOFENCE" says what.
 */

/** The request contradicts current ledger state rather than being malformed. */
const CONFLICT = new Set([
  'ALREADY_ENROLLED',
  'DUPLICATE_ATTENDANCE',
  'EXEMPTION_EXISTS',
  'EXEMPTION_NOT_ACTIVE',
  'FACULTY_NOT_ACTIVE',
  'GRACE_PERIOD_ELAPSED',
  'GRACE_PERIOD_NOT_ELAPSED',
  'IDENTITY_HASH_EXISTS',
  'IDENTITY_NOT_ACTIVE',
  'KEY_UNCHANGED',
  'NO_CHANGE',
  'OLD_KEY_MISMATCH',
  'SESSION_EXISTS',
  'SESSION_NOT_OPEN',
  'STUDENT_NOT_ACTIVE',
]);

/**
 * Failures of the ledger itself rather than of the request. An endorsement
 * policy failure means this server is misconfigured — it did not gather both
 * endorsements — which is never the caller's fault.
 */
const UPSTREAM = new Set(['ENDORSEMENT_POLICY_FAILURE', 'UNKNOWN']);

export function httpStatusFor(code: string): number {
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (code === 'UNAUTHORISED_ORG') return 403;
  if (CONFLICT.has(code)) return 409;
  if (UPSTREAM.has(code)) return 502;
  // Every other chaincode code is a well-formed request the contract refused:
  // a bad signature, a location outside the geofence, a stale window.
  return 422;
}
