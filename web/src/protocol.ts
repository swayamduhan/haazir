/**
 * The device side of the attendance protocol, running in the browser.
 *
 * Every function here has a Node counterpart in @haazir/shared that the
 * contract relies on. They must agree byte for byte, so test/protocol.test.ts
 * runs each pair against the other rather than trusting that two
 * implementations of the same idea will match. The pure pieces — canonical
 * encoding, the signed payload, the geofence arithmetic — are not
 * reimplemented at all: they are imported from the shared package's source.
 */
import * as ed from '@noble/ed25519';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalize } from '@shared/canonical';
import { NONCE_WINDOW_SEC } from '@shared/config';
import { AttendanceClaim, attendancePayload } from '@shared/payload';

export { attendancePayload, NONCE_WINDOW_SEC };
export type { AttendanceClaim };
export { distanceMetres, isWithinRadius } from '@shared/geo';

ed.hashes.sha512 = sha512;

const HEX_64 = /^[0-9a-f]{64}$/;

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** A fresh 256-bit session seed. It never leaves the faculty device until close. */
export function randomSeed(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** SHA-256 over the seed's bytes, not its hex text. Matches shared/hashing.commitSeed. */
export function commitSeed(seedHex: string): string {
  if (!HEX_64.test(seedHex)) throw new Error('seed must be 32-byte hex');
  return bytesToHex(sha256(hexToBytes(seedHex)));
}

/** HMAC-SHA256(seed, decimal string of w). Matches shared/nonce.deriveNonce. */
export function deriveNonce(seedHex: string, window: number): string {
  if (!Number.isInteger(window) || window < 0) throw new Error('window must be a non-negative integer');
  if (!HEX_64.test(seedHex)) throw new Error('seed must be 32-byte hex');
  return bytesToHex(hmac(sha256, hexToBytes(seedHex), utf8ToBytes(String(window))));
}

/** Windows are counted from the session start, not the Unix epoch. */
export function windowFor(nowMs: number, startMs: number, windowSec = NONCE_WINDOW_SEC): number {
  if (nowMs < startMs) throw new Error('time is before session start');
  return Math.floor((nowMs - startMs) / (windowSec * 1000));
}

export const toE7 = (degrees: number): number => Math.round(degrees * 1e7);

/** Matches shared/hashing.hashIdentity: the name and number never leave the device. */
export function hashIdentity(name: string, enrolmentNo: string, saltHex: string): string {
  return sha256Hex(`${canonicalize({ enrolmentNo, name })}|${saltHex}`);
}

export interface DeviceKey {
  secretKeyHex: string;
  publicKeyHex: string;
}

/**
 * An ed25519 key held by the browser.
 *
 * Stated plainly: a browser key is software, kept in local storage. It proves
 * possession of this browser profile, not of a secure element. The native
 * client this stands in for would generate the key in the platform keystore.
 * See docs/threat-model.md, row 11.
 */
export function generateDeviceKey(): DeviceKey {
  const secret = ed.utils.randomSecretKey();
  return { secretKeyHex: bytesToHex(secret), publicKeyHex: bytesToHex(ed.getPublicKey(secret)) };
}

export function signClaim(secretKeyHex: string, claim: AttendanceClaim): string {
  return bytesToHex(ed.sign(utf8ToBytes(attendancePayload(claim)), hexToBytes(secretKeyHex)));
}

export function verifyClaim(publicKeyHex: string, claim: AttendanceClaim, signatureHex: string): boolean {
  try {
    return ed.verify(hexToBytes(signatureHex), utf8ToBytes(attendancePayload(claim)), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

/** What the faculty QR code carries: enough to sign a claim, nothing secret. */
export interface QrPayload {
  v: 1;
  s: string;   // sessionID
  c: string;   // courseID
  w: number;   // window
  n: string;   // nonce for that window
}

export function encodeQr(p: Omit<QrPayload, 'v'>): string {
  return JSON.stringify({ v: 1, ...p });
}

export function decodeQr(text: string): QrPayload | null {
  try {
    const p = JSON.parse(text);
    if (p?.v === 1 && typeof p.s === 'string' && typeof p.c === 'string'
      && Number.isInteger(p.w) && HEX_64.test(p.n)) return p as QrPayload;
  } catch { /* not ours */ }
  return null;
}
