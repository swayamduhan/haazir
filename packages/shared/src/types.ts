export type Role = 'student' | 'faculty' | 'admin';
export type IdentityStatus = 'active' | 'revoked';
export type SessionStatus = 'open' | 'closed' | 'expired';
export type RevocationReason =
  'lost_device' | 'graduation' | 'compromise' | 'factory_reset';

export const ROLES: readonly Role[] = ['student', 'faculty', 'admin'];
export const REVOCATION_REASONS: readonly RevocationReason[] =
  ['lost_device', 'graduation', 'compromise', 'factory_reset'];

export interface Identity {
  identityID: string;
  /** Salted hash of off-chain PII. The chaincode never sees the underlying values. */
  identityHash: string;
  /** The currently active device public key. Rotation replaces it. */
  publicKey: string;
  role: Role;
  status: IdentityStatus;
  enrolledBy: string;
  enrolledAt: string;
}

/**
 * Coordinates as integer 1e-7 degrees ("microdegrees"), the standard
 * geodetic integer convention. Floats are not stored on-chain: their string
 * formatting is not portable, and canonical encoding rejects them by design.
 */
export interface GeoPoint {
  latE7: number;
  lngE7: number;
}

export const toE7 = (degrees: number): number => Math.round(degrees * 1e7);
export const fromE7 = (e7: number): number => e7 / 1e7;

export interface Session {
  sessionID: string;
  courseID: string;
  facultyID: string;
  room: string;
  /** Scheduled start; anchors the nonce window epoch. Spec section 6.2. */
  startTime: string;
  /** Ledger timestamp of the creating transaction. */
  createdAt: string;
  durationSec: number;
  gracePeriodSec: number;
  geofenceCenter: GeoPoint;
  geofenceRadiusM: number;
  /** SHA-256 of the seed, committed at creation. Never modified. */
  nonceSeedHash: string;
  /**
   * Written by closeSession in the same transaction as the reveal. Its
   * absence on a closed session would mean the sweep did not run, which
   * cannot happen; its presence with a non-zero invalidCount is what makes
   * the session derive as `disputed` rather than `verified`. ADR-016.
   */
  nonceAudit?: NonceAuditSummary;
  /** Absent until closeSession reveals it. Spec section 5.2. */
  revealedSeed?: string;
  status: SessionStatus;
  closedAt?: string;
  closedBy?: string;
  expiredAt?: string;
  expiredBy?: string;
}

export interface KeyRevocationEvent {
  eventID: string;
  identityID: string;
  oldPublicKeyHash: string;
  newPublicKey: string;
  reason: RevocationReason;
  authorizedBy: string;
  timestamp: string;
}

/**
 * Verification state derived at read time, so a session past its grace
 * period is never reported as healthy merely because nobody has swept it.
 * Spec section 5.4.
 */
export type VerificationState =
  | 'in_progress'      // open, within its window
  | 'awaiting_reveal'  // open, past nominal end but inside the grace period
  | 'unverified'       // past the grace period; seed never revealed
  | 'disputed'         // closed and swept, but one or more nonce claims failed
  | 'verified';        // closed, seed revealed, every nonce claim recomputed and matched

/** The headline of a nonce sweep, small enough to carry on the session itself. */
export interface NonceAuditSummary {
  recordsChecked: number;
  validCount: number;
  invalidCount: number;
}

export type RosterStatus = 'enrolled' | 'dropped';

/**
 * Enrolment as ledger state rather than an SIS lookup.
 *
 * A dropped student keeps their entry with a changed status: deleting it
 * would erase the fact that they were once enrolled, which is exactly what an
 * audit of a disputed record needs to see. Spec section 6.4, ADR-015.
 */
export interface RosterEntry {
  courseID: string;
  studentID: string;
  status: RosterStatus;
  enrolledBy: string;
  enrolledAt: string;
  droppedBy?: string;
  droppedAt?: string;
}

export type AttendanceStatus = 'present' | 'absent';

/** How a record came to exist: signed by a device, or written by a correction. */
export type RecordOrigin = 'device' | 'correction';

/**
 * One immutable attendance record. Never rewritten after it is stored —
 * not by a correction, and not by the nonce sweep at session close.
 *
 * A correction appends a new record at the next sequence number carrying
 * `supersedes`; the nonce sweep writes its verdicts into a separate audit
 * document. The ledger would preserve an overwrite as history anyway, but
 * only the state database is queryable, so append-only in state is what makes
 * the history readable. Spec section 6.5, ADR-006.
 */
export interface AttendanceRecord {
  recordID: string;
  sessionID: string;
  studentID: string;
  courseID: string;
  /** 0 for the device mark; each correction takes the next number. */
  seq: number;
  status: AttendanceStatus;
  origin: RecordOrigin;
  markedAt: string;
  /** X.509 identity of the submitting organisation, not of the student. */
  markedBy: string;

  // Present on device-marked records only.
  claimedWindow?: number;
  claimedNonce?: string;
  location?: GeoPoint;
  livenessHash?: string;
  deviceSignature?: string;
  /**
   * The key the signature was verified against, captured at marking time so
   * a later key rotation does not make old records unverifiable. ADR-017.
   */
  devicePublicKey?: string;

  // Present on corrections only.
  supersedes?: string;
  reason?: string;
}

/**
 * The current state of one student's attendance in one session.
 *
 * Kept separate from the records so the duplicate check in `markAttendance`
 * is a single `getState` on an exact composite key — in the read set, and
 * therefore protected by MVCC. Defect C6.
 */
export interface AttendanceIndex {
  sessionID: string;
  studentID: string;
  currentRecordID: string;
  currentSeq: number;
  currentStatus: AttendanceStatus;
  updatedAt: string;
}

export interface NonceVerdict {
  studentID: string;
  recordID: string;
  claimedWindow: number;
  claimedNonce: string;
  expectedNonce: string;
  valid: boolean;
}

/**
 * The result of recomputing every claimed nonce once the seed is revealed.
 *
 * Written by `closeSession` in the same transaction as the reveal, so a
 * session cannot be closed without its nonces being adjudicated by both
 * endorsing organisations. Spec section 5.5, ADR-016.
 */
export interface NonceAudit extends NonceAuditSummary {
  sessionID: string;
  checkedAt: string;
  verdicts: NonceVerdict[];
}
