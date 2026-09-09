import { windowFor, deriveNonce, NONCE_WINDOW_SEC } from '../src';

const START = Date.parse('2026-09-09T10:00:00.000Z');
const SEED = 'ab'.repeat(32);

describe('windowFor', () => {
  it('returns window 0 at the session start instant', () => {
    expect(windowFor(START, START)).toBe(0);
  });
  it('stays in window 0 until the window length elapses', () => {
    expect(windowFor(START + 9_999, START)).toBe(0);
  });
  it('advances to window 1 exactly at the boundary', () => {
    expect(windowFor(START + 10_000, START)).toBe(1);
  });
  it('counts from session start, not the unix epoch', () => {
    const otherStart = START + 3_600_000;
    expect(windowFor(otherStart + 25_000, otherStart)).toBe(2);
  });
  it('rejects a time before the session start', () => {
    expect(() => windowFor(START - 1, START)).toThrow(/before session start/);
  });
  it('uses a ten second window', () => {
    expect(NONCE_WINDOW_SEC).toBe(10);
  });
});

describe('deriveNonce', () => {
  it('is deterministic for the same seed and window', () => {
    expect(deriveNonce(SEED, 5)).toBe(deriveNonce(SEED, 5));
  });
  it('differs between adjacent windows, defeating replay', () => {
    expect(deriveNonce(SEED, 5)).not.toBe(deriveNonce(SEED, 6));
  });
  it('differs between seeds for the same window', () => {
    expect(deriveNonce(SEED, 5)).not.toBe(deriveNonce('cd'.repeat(32), 5));
  });
  it('produces a 64-character hex digest', () => {
    expect(deriveNonce(SEED, 0)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects a negative or non-integer window', () => {
    expect(() => deriveNonce(SEED, -1)).toThrow(/window/);
    expect(() => deriveNonce(SEED, 1.5)).toThrow(/window/);
  });
  it('rejects a malformed seed', () => {
    expect(() => deriveNonce('nothex', 0)).toThrow(/32-byte hex/);
  });
});
