import { createHash } from 'crypto';
import { canonicalize } from './canonical';

const HEX_64 = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return HEX_64.test(value);
}

/** An ed25519 public key is 32 bytes, represented as 64 lowercase hex characters. */
export function isEd25519PublicKey(value: string): boolean {
  return HEX_64.test(value);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The commitment stored on-chain at session creation. Hashes the seed's
 * bytes rather than its hex text, so the commitment is over the value and
 * not over an encoding choice. Spec section 5.2.
 */
export function commitSeed(seedHex: string): string {
  if (!HEX_64.test(seedHex)) {
    throw new Error('commitSeed: seed must be 32-byte hex (64 lowercase hex characters)');
  }
  return sha256Hex(Buffer.from(seedHex, 'hex'));
}

export function hashPublicKey(publicKeyHex: string): string {
  return sha256Hex(publicKeyHex);
}

/** Salted hash linking an on-chain identity to its off-chain record. Spec section 6.1. */
export function hashIdentity(name: string, enrolmentNo: string, saltHex: string): string {
  return sha256Hex(`${canonicalize({ enrolmentNo, name })}|${saltHex}`);
}

/**
 * Derives an identity id from the transaction id.
 *
 * A random UUID cannot be used: every endorsing peer executes the
 * transaction independently and must produce byte-identical output, so any
 * randomness fails endorsement. The transaction id is unique, identical
 * across peers, and not predictable by the submitter. Spec section 6.1.
 */
export function deriveIdentityId(txId: string): string {
  const h = sha256Hex(`identity|${txId}`);
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16),
    h.slice(16, 20), h.slice(20, 32)].join('-');
}

/** Derives a revocation event id from the transaction id, for the same reason. */
export function deriveEventId(txId: string): string {
  return sha256Hex(`revocation|${txId}`).slice(0, 32);
}

/** Derives an attendance record id from the transaction id, for the same reason. */
export function deriveRecordId(txId: string): string {
  return sha256Hex(`attendance|${txId}`).slice(0, 32);
}
