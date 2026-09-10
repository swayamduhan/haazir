import { generateKeyPairSync, KeyObject, sign } from 'crypto';
import { AttendanceClaim, attendancePayload } from './signing';

/**
 * The signing half of the device protocol: key generation and submission
 * signing, as the student's phone performs them.
 *
 * NEVER CALLED BY CHAINCODE. Key generation reads the system CSPRNG and is
 * non-deterministic by construction; a contract that invoked it would fail
 * endorsement immediately. It lives here rather than in the backend so that
 * the reference client, the demo and the contract tests all sign with the
 * same code path the contract verifies against.
 *
 * The production client generates its key inside the platform keystore and
 * never exports the private half. This module is the desktop stand-in.
 */

export interface DeviceKeyPair {
  /** The 32-byte raw key, hex, as registered on chain. */
  publicKeyHex: string;
  privateKey: KeyObject;
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });

  // Strip the 12-byte SPKI header to recover the raw key. See ADR-017.
  return { publicKeyHex: spki.subarray(12).toString('hex'), privateKey };
}

export function signAttendance(privateKey: KeyObject, claim: AttendanceClaim): string {
  return sign(null, Buffer.from(attendancePayload(claim), 'utf8'), privateKey)
    .toString('hex');
}
