import { createPublicKey, KeyObject, verify } from 'crypto';
export { AttendanceClaim, attendancePayload } from './payload';

/** An ed25519 signature is 64 bytes, represented as 128 lowercase hex characters. */
const HEX_128 = /^[0-9a-f]{128}$/;

export function isEd25519Signature(value: string): boolean {
  return HEX_128.test(value);
}

/**
 * The fixed DER prefix for an ed25519 SubjectPublicKeyInfo.
 *
 * Keys are stored on chain as 32 raw bytes in hex, which is what a mobile
 * secure element exports; Node's crypto wants a KeyObject. Wrapping the raw
 * key in this 12-byte header and importing it as DER bridges the two without
 * a dependency.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function ed25519PublicKeyFromHex(publicKeyHex: string): KeyObject {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) {
    throw new Error('ed25519PublicKeyFromHex: key must be 32-byte hex');
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Verifies an ed25519 signature over `message`.
 *
 * Deterministic, and therefore safe to run inside chaincode: ed25519
 * verification is a fixed computation over fixed inputs, with none of the
 * randomness ECDSA signing carries. A malformed key or signature is a
 * rejection, not an exception — the caller decides what to say about it.
 */
export function verifyEd25519(
  publicKeyHex: string,
  message: string,
  signatureHex: string,
): boolean {
  if (!isEd25519Signature(signatureHex)) return false;
  try {
    return verify(
      null,
      Buffer.from(message, 'utf8'),
      ed25519PublicKeyFromHex(publicKeyHex),
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}
