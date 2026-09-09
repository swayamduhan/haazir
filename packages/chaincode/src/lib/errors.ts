/**
 * Every rejection carries a machine-readable code. Spec section 7 requires
 * fail-fast with a specific reason: the demo's value lies in showing which
 * check rejected a submission, not merely that one did.
 */
export class ChaincodeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ChaincodeError';
  }
}

export function fail(code: string, message: string): never {
  throw new ChaincodeError(code, message);
}
