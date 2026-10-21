import { canonicalize } from './canonical';

/*
 * The signed attendance payload, kept free of any Node import so that the
 * browser client loads the very same function the contract verifies against.
 * It used to live in signing.ts beside node:crypto, which a browser cannot
 * load; copying it into the web client instead would have created the second
 * definition ADR-017 exists to rule out.
 */

/**
 * Everything the device attests to when marking attendance.
 *
 * All eight fields are inside the signed bytes, which is what stops a
 * captured signature being replayed into another session, a later window or
 * a different place: change any of them and the signature no longer verifies.
 * See ADR-017.
 */
export interface AttendanceClaim {
  sessionID: string;
  studentID: string;
  courseID: string;
  claimedWindow: number;
  claimedNonce: string;
  latE7: number;
  lngE7: number;
  livenessHash: string;
}

/**
 * The exact bytes signed by the device and verified by the contract.
 *
 * One function, called by both sides. Two implementations that merely intend
 * to agree eventually disagree over key order or number formatting, and the
 * symptom is "valid signatures are rejected" — expensive to diagnose and
 * indistinguishable from an attack.
 */
export function attendancePayload(claim: AttendanceClaim): string {
  return canonicalize({
    claimedNonce: claim.claimedNonce,
    claimedWindow: claim.claimedWindow,
    courseID: claim.courseID,
    latE7: claim.latE7,
    lngE7: claim.lngE7,
    livenessHash: claim.livenessHash,
    sessionID: claim.sessionID,
    studentID: claim.studentID,
  });
}
