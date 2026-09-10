import { translateFabricError } from '../src/gateway/errors';

/** Mirrors the shape fabric-gateway's EndorseError actually has. */
function endorseError(message: string, details: string[]): Error {
  return Object.assign(new Error(message), {
    name: 'EndorseError',
    details: details.map((m, i) => ({
      address: `peer${i}:7051`, mspId: 'RegistrarMSP', message: m,
    })),
  });
}

describe('translateFabricError', () => {
  it('extracts the chaincode code from the per-peer details', () => {
    const err = endorseError(
      '10 ABORTED: failed to collect enough transaction endorsements, see attached details',
      ['chaincode response 500, SEED_COMMITMENT_MISMATCH: the revealed seed does not match'],
    );
    const f = translateFabricError(err);
    expect(f.code).toBe('SEED_COMMITMENT_MISMATCH');
    expect(f.detail).toMatch(/revealed seed does not match/);
  });

  it('does not mistake the gRPC status for the chaincode code', () => {
    // "ABORTED:" appears earlier in the message than the real reason, and a
    // naive first-match regex picks it. That was a real bug.
    const err = endorseError(
      '10 ABORTED: failed to collect enough transaction endorsements',
      ['chaincode response 500, SESSION_NOT_FOUND: no session with id "S1"'],
    );
    expect(translateFabricError(err).code).toBe('SESSION_NOT_FOUND');
  });

  it('reports an endorsement policy failure distinctly', () => {
    const err = endorseError('failed', [
      'transaction invalidated: signature set did not satisfy policy',
    ]);
    const f = translateFabricError(err);
    expect(f.code).toBe('ENDORSEMENT_POLICY_FAILURE');
    expect(f.detail).toMatch(/one organisation cannot write alone/);
  });

  it('handles an error with no details at all', () => {
    const f = translateFabricError(new Error('connection refused'));
    expect(f.code).toBe('UNKNOWN');
    expect(f.detail).toBe('connection refused');
  });

  it('handles a non-Error value', () => {
    expect(translateFabricError('boom').code).toBe('UNKNOWN');
  });

  it('falls back to a bare CODE: message pair when there is no chaincode prefix', () => {
    const f = translateFabricError(new Error('INVALID_ROLE: role must be one of student'));
    expect(f.code).toBe('INVALID_ROLE');
  });

  it('prefers the first peer that reported a chaincode error', () => {
    const err = endorseError('10 ABORTED: failed', [
      'chaincode response 500, INVALID_SEED: revealedSeed must be 32-byte hex',
      'chaincode response 500, INVALID_SEED: revealedSeed must be 32-byte hex',
    ]);
    expect(translateFabricError(err).code).toBe('INVALID_SEED');
  });

  it('always preserves the raw text for diagnosis', () => {
    const err = endorseError('10 ABORTED: failed', ['chaincode response 500, X_CODE: detail']);
    expect(translateFabricError(err).raw).toContain('ABORTED');
    expect(translateFabricError(err).raw).toContain('X_CODE');
  });
});
