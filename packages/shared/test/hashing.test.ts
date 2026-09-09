import {
  sha256Hex, commitSeed, hashPublicKey, hashIdentity, deriveIdentityId, deriveEventId,
  isEd25519PublicKey, isSha256Hex, toE7, fromE7, canonicalize,
} from '../src';

describe('sha256Hex', () => {
  it('matches the known digest of the empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('is deterministic across calls', () => {
    expect(sha256Hex('haazir')).toBe(sha256Hex('haazir'));
  });
});

describe('commitSeed', () => {
  const seed = 'a'.repeat(64);

  it('produces a 64-character hex digest', () => {
    expect(commitSeed(seed)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('hashes the seed bytes, not the hex text', () => {
    expect(commitSeed(seed)).toBe(sha256Hex(Buffer.from(seed, 'hex')));
  });
  it('differs for different seeds', () => {
    expect(commitSeed(seed)).not.toBe(commitSeed('b'.repeat(64)));
  });
  it('rejects a malformed seed', () => {
    expect(() => commitSeed('nothex')).toThrow(/32-byte hex/);
  });
});

describe('deriveIdentityId', () => {
  it('is deterministic for the same transaction id', () => {
    expect(deriveIdentityId('tx-abc')).toBe(deriveIdentityId('tx-abc'));
  });
  it('differs for different transaction ids', () => {
    expect(deriveIdentityId('tx-abc')).not.toBe(deriveIdentityId('tx-def'));
  });
  it('has UUID shape', () => {
    expect(deriveIdentityId('tx-abc')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('deriveEventId', () => {
  it('is deterministic and distinct from the identity id for the same tx', () => {
    expect(deriveEventId('tx-abc')).toBe(deriveEventId('tx-abc'));
    expect(deriveEventId('tx-abc')).not.toBe(deriveIdentityId('tx-abc'));
  });
});

describe('validators', () => {
  it('accepts a 64-char hex ed25519 public key', () => {
    expect(isEd25519PublicKey('c'.repeat(64))).toBe(true);
  });
  it('rejects wrong length or non-hex', () => {
    expect(isEd25519PublicKey('c'.repeat(63))).toBe(false);
    expect(isEd25519PublicKey('z'.repeat(64))).toBe(false);
  });
  it('recognises a sha256 hex digest', () => {
    expect(isSha256Hex(sha256Hex('x'))).toBe(true);
    expect(isSha256Hex('abc')).toBe(false);
  });
});

describe('hashPublicKey', () => {
  it('produces a sha256 digest of the key', () => {
    const pk = 'c'.repeat(64);
    expect(hashPublicKey(pk)).toBe(sha256Hex(pk));
  });
});

describe('hashIdentity', () => {
  it('is stable for the same inputs', () => {
    expect(hashIdentity('Asha', 'ENR-1', 'ff'.repeat(16)))
      .toBe(hashIdentity('Asha', 'ENR-1', 'ff'.repeat(16)));
  });
  it('changes with the salt, so the same person is unlinkable across salts', () => {
    expect(hashIdentity('Asha', 'ENR-1', 'ff'.repeat(16)))
      .not.toBe(hashIdentity('Asha', 'ENR-1', 'ee'.repeat(16)));
  });
  it('changes with the enrolment number', () => {
    expect(hashIdentity('Asha', 'ENR-1', 'ff'.repeat(16)))
      .not.toBe(hashIdentity('Asha', 'ENR-2', 'ff'.repeat(16)));
  });
});

describe('coordinate scaling', () => {
  it('round-trips a coordinate through integer microdegrees', () => {
    expect(fromE7(toE7(12.9716))).toBeCloseTo(12.9716, 6);
  });
  it('produces an integer, which canonical encoding accepts', () => {
    expect(Number.isInteger(toE7(77.5946))).toBe(true);
    expect(() => canonicalize({ lngE7: toE7(77.5946) })).not.toThrow();
  });
  it('handles negative coordinates', () => {
    expect(fromE7(toE7(-33.8688))).toBeCloseTo(-33.8688, 6);
  });
});
