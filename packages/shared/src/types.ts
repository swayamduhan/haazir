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
  | 'verified';        // closed, seed revealed and commitment checked
