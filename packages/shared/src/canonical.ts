/**
 * Deterministic serialization for anything hashed or signed.
 *
 * Object keys are sorted lexicographically; arrays keep their order because
 * it is semantic; undefined properties are omitted. Numbers must be safe
 * integers — floating-point formatting is not portable across platforms,
 * and a mismatch here surfaces as "valid signatures are rejected", which is
 * expensive to diagnose. See spec section 8.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalize: non-finite number (${value})`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(`canonicalize: number must be a safe integer (${value})`);
    }
    return value;
  }

  if (typeof value === 'string' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) return value.map(normalize);

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      result[key] = normalize(source[key]);
    }
    return result;
  }

  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}
