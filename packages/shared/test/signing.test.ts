import {
  AttendanceClaim, attendancePayload, deriveNonce, generateDeviceKeyPair,
  isEd25519Signature, sha256Hex, signAttendance, toE7, verifyEd25519,
} from '../src';

const SEED = 'ab'.repeat(32);

const claim = (overrides: Partial<AttendanceClaim> = {}): AttendanceClaim => ({
  sessionID: 'S1',
  studentID: 'stu-1',
  courseID: 'CS101',
  claimedWindow: 7,
  claimedNonce: deriveNonce(SEED, 7),
  latE7: toE7(12.9716),
  lngE7: toE7(77.5946),
  livenessHash: sha256Hex('liveness'),
  ...overrides,
});

describe('attendancePayload', () => {
  it('emits keys in canonical order regardless of the input order', () => {
    const a = claim();
    const reordered: AttendanceClaim = {
      livenessHash: a.livenessHash,
      studentID: a.studentID,
      lngE7: a.lngE7,
      claimedWindow: a.claimedWindow,
      sessionID: a.sessionID,
      latE7: a.latE7,
      courseID: a.courseID,
      claimedNonce: a.claimedNonce,
    };
    expect(attendancePayload(reordered)).toBe(attendancePayload(a));
    expect(attendancePayload(a).startsWith('{"claimedNonce"')).toBe(true);
  });

  it('refuses a fractional coordinate rather than signing an unportable number', () => {
    expect(() => attendancePayload(claim({ latE7: 129_716_000.5 }))).toThrow(/safe integer/);
  });
});

describe('verifyEd25519', () => {
  it('verifies a signature the device produced', () => {
    const { publicKeyHex, privateKey } = generateDeviceKeyPair();
    const c = claim();
    const signature = signAttendance(privateKey, c);

    expect(isEd25519Signature(signature)).toBe(true);
    expect(verifyEd25519(publicKeyHex, attendancePayload(c), signature)).toBe(true);
  });

  it('exports a public key in the 32-byte form the registry stores', () => {
    expect(generateDeviceKeyPair().publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['session', { sessionID: 'S2' }],
    ['student', { studentID: 'stu-2' }],
    ['course', { courseID: 'CS102' }],
    ['window', { claimedWindow: 8 }],
    ['nonce', { claimedNonce: deriveNonce(SEED, 9) }],
    ['latitude', { latE7: toE7(12.98) }],
    ['longitude', { lngE7: toE7(77.6) }],
    ['liveness attestation', { livenessHash: sha256Hex('other') }],
  ])('rejects a signature replayed with a different %s', (_label, override) => {
    const { publicKeyHex, privateKey } = generateDeviceKeyPair();
    const signature = signAttendance(privateKey, claim());

    expect(verifyEd25519(publicKeyHex, attendancePayload(claim(override)), signature))
      .toBe(false);
  });

  it('rejects a signature made by a different device', () => {
    const victim = generateDeviceKeyPair();
    const attacker = generateDeviceKeyPair();
    const signature = signAttendance(attacker.privateKey, claim());

    expect(verifyEd25519(victim.publicKeyHex, attendancePayload(claim()), signature))
      .toBe(false);
  });

  it('returns false rather than throwing on malformed input', () => {
    const { publicKeyHex } = generateDeviceKeyPair();
    const payload = attendancePayload(claim());

    expect(verifyEd25519(publicKeyHex, payload, 'not-hex')).toBe(false);
    expect(verifyEd25519(publicKeyHex, payload, 'ff'.repeat(64))).toBe(false);
    expect(verifyEd25519('zz'.repeat(32), payload, 'ab'.repeat(64))).toBe(false);
  });
});
