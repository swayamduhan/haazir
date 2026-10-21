/**
 * The browser implementation against the Node implementation the contract uses.
 *
 * A mismatch here would surface in production as "valid submissions are
 * rejected" — indistinguishable from an attack and expensive to diagnose. So
 * every pair is run against the other, on many inputs, rather than trusted.
 */
import { describe, expect, it } from 'vitest';
import * as shared from '@haazir/shared';
import {
  commitSeed, decodeQr, deriveNonce, encodeQr, generateDeviceKey, hashIdentity,
  randomSeed, signClaim, toE7, verifyClaim, windowFor,
} from '../src/protocol';

const claimFor = (studentID: string, seed: string, w: number) => ({
  sessionID: 'S-web', studentID, courseID: 'BCSE329L', claimedWindow: w,
  claimedNonce: deriveNonce(seed, w), latE7: toE7(12.9692), lngE7: toE7(79.1559),
  livenessHash: 'ab'.repeat(32),
});

describe('browser crypto agrees with the contract’s', () => {
  it('commits to a seed exactly as the contract checks it', () => {
    for (let i = 0; i < 50; i += 1) {
      const seed = randomSeed();
      expect(commitSeed(seed)).toBe(shared.commitSeed(seed));
    }
  });

  it('derives every window’s nonce exactly as the close-time sweep recomputes it', () => {
    const seed = randomSeed();
    for (let w = 0; w < 400; w += 1) {
      expect(deriveNonce(seed, w)).toBe(shared.deriveNonce(seed, w));
    }
  });

  it('counts windows from the session start, as the contract does', () => {
    const start = Date.parse('2026-10-21T10:00:00.000Z');
    for (const offset of [0, 9_999, 10_000, 65_432, 3_599_999]) {
      expect(windowFor(start + offset, start)).toBe(shared.windowFor(start + offset, start));
    }
  });

  it('hashes an identity exactly as enrolment expects', () => {
    expect(hashIdentity('Swayam Duhan', '23BKT0085', 'cd'.repeat(16)))
      .toBe(shared.hashIdentity('Swayam Duhan', '23BKT0085', 'cd'.repeat(16)));
  });

  it('converts coordinates to microdegrees identically', () => {
    for (const d of [12.9692, 79.1559, -33.8688, 0, 89.9999999]) expect(toE7(d)).toBe(shared.toE7(d));
  });
});

describe('signatures cross the implementation boundary', () => {
  it('a browser signature verifies with node:crypto, as the contract verifies it', () => {
    for (let i = 0; i < 20; i += 1) {
      const key = generateDeviceKey();
      const claim = claimFor(`stu-${i}`, randomSeed(), i);
      const sig = signClaim(key.secretKeyHex, claim);
      expect(shared.verifyEd25519(key.publicKeyHex, shared.attendancePayload(claim), sig)).toBe(true);
    }
  });

  it('a node signature verifies in the browser, as the public verifier checks it', () => {
    const device = shared.generateDeviceKeyPair();
    const claim = claimFor('stu-node', randomSeed(), 3);
    const sig = shared.signAttendance(device.privateKey, claim);
    expect(verifyClaim(device.publicKeyHex, claim, sig)).toBe(true);
  });

  it('rejects a signature over a different window', () => {
    const key = generateDeviceKey();
    const seed = randomSeed();
    const sig = signClaim(key.secretKeyHex, claimFor('stu', seed, 4));
    expect(verifyClaim(key.publicKeyHex, claimFor('stu', seed, 5), sig)).toBe(false);
  });

  it('returns false rather than throwing on garbage', () => {
    expect(verifyClaim('zz', claimFor('stu', randomSeed(), 1), 'nope')).toBe(false);
  });
});

describe('the QR payload', () => {
  it('round-trips', () => {
    const n = deriveNonce(randomSeed(), 2);
    expect(decodeQr(encodeQr({ s: 'S1', c: 'BCSE329L', w: 2, n }))).toEqual({ v: 1, s: 'S1', c: 'BCSE329L', w: 2, n });
  });

  it('carries the nonce for one window and never the seed', () => {
    const seed = randomSeed();
    const text = encodeQr({ s: 'S1', c: 'C', w: 7, n: deriveNonce(seed, 7) });
    expect(text).not.toContain(seed);
  });

  it('ignores QR codes that are not ours', () => {
    expect(decodeQr('https://example.com')).toBeNull();
    expect(decodeQr('{"v":1,"s":"S","c":"C","w":1.5,"n":"x"}')).toBeNull();
  });
});
