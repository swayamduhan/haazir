import { canonicalize } from '../src/canonical';

describe('canonicalize', () => {
  it('produces identical output regardless of key insertion order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('sorts keys lexicographically', () => {
    expect(canonicalize({ zebra: 1, apple: 2 })).toBe('{"apple":2,"zebra":1}');
  });

  it('sorts keys in nested objects', () => {
    expect(canonicalize({ outer: { b: 1, a: 2 } })).toBe('{"outer":{"a":2,"b":1}}');
  });

  it('preserves array order, which is semantic', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined properties rather than emitting them', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('round-trips through JSON.parse', () => {
    const original = { session: 'S1', windows: [0, 1, 2], nested: { ok: true } };
    expect(JSON.parse(canonicalize(original))).toEqual(original);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ a: NaN })).toThrow(/non-finite/);
    expect(() => canonicalize({ a: Infinity })).toThrow(/non-finite/);
  });

  it('rejects non-integer numbers, whose formatting is not portable', () => {
    expect(() => canonicalize({ a: 1.5 })).toThrow(/integer/);
  });

  it('rejects integers beyond safe range', () => {
    expect(() => canonicalize({ a: Number.MAX_SAFE_INTEGER + 2 })).toThrow(/integer/);
  });
});
