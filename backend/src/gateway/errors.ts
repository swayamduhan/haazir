export interface FabricFailure {
  code: string;
  detail: string;
  raw: string;
}

interface ErrorDetail {
  address?: string;
  mspId?: string;
  message?: string;
}

/**
 * Peers report chaincode rejections as:
 *   "chaincode response 500, SEED_COMMITMENT_MISMATCH: the revealed seed ..."
 */
const CHAINCODE_ERROR = /chaincode response \d+,\s*([A-Z][A-Z0-9_]{3,}):\s*(.+)/;

/**
 * gRPC status names look exactly like our chaincode error codes and appear
 * EARLIER in the flattened message ("10 ABORTED: failed to collect enough
 * transaction endorsements"). Matching one of these instead of the real
 * reason is the specific bug this set exists to prevent.
 */
const GRPC_STATUSES = new Set([
  'OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED',
  'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED',
  'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
]);

/**
 * Extracts the reason a submission was actually rejected.
 *
 * Fabric wraps chaincode failures in a gRPC status whose message says only
 * that endorsement could not be collected. The reason lives in the per-peer
 * `details`. Surfacing it is what makes the demo's negative cases
 * convincing — "rejected: SEED_COMMITMENT_MISMATCH" states which check
 * fired, where "failed to collect enough endorsements" does not.
 * Spec sections 7 and 9.1.
 */
export function translateFabricError(err: unknown): FabricFailure {
  const raw = err instanceof Error ? err.message : String(err);
  const details: ErrorDetail[] = (err as { details?: ErrorDetail[] })?.details ?? [];
  const messages = details.map((d) => d.message ?? '').filter(Boolean);
  const combined = [raw, ...messages].join(' | ');

  // 1. The chaincode's own code, from the per-peer details. Checked first
  //    because it is the most specific answer available.
  for (const message of messages) {
    const m = message.match(CHAINCODE_ERROR);
    if (m) return { code: m[1], detail: m[2].trim(), raw: combined };
  }

  // 2. A policy rejection, which produces no chaincode response at all.
  if (/ENDORSEMENT_POLICY_FAILURE|endorsement policy failure|did not satisfy policy/i
    .test(combined)) {
    return {
      code: 'ENDORSEMENT_POLICY_FAILURE',
      detail: 'the endorsement policy was not satisfied — one organisation cannot write alone',
      raw: combined,
    };
  }

  // 3. Any remaining CODE: message pair, ignoring gRPC status names.
  for (const m of combined.matchAll(/([A-Z][A-Z0-9_]{3,}):\s*([^|]+)/g)) {
    if (!GRPC_STATUSES.has(m[1])) {
      return { code: m[1], detail: m[2].trim(), raw: combined };
    }
  }

  return { code: 'UNKNOWN', detail: raw, raw: combined };
}
