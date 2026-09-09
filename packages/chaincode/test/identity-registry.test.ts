import { IdentityRegistry } from '../src/contracts/identity-registry';
import { makeContext, nextTx } from './helpers/mock-context';
import { Identity, KeyRevocationEvent, hashPublicKey, sha256Hex } from '@haazir/shared';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const HASH = sha256Hex('student-1');

const cc = () => new IdentityRegistry();

describe('registerIdentity', () => {
  it('returns a deterministic UUID-shaped identity id', async () => {
    const id = await cc().registerIdentity(
      makeContext({ txId: 'tx-1' }), HASH, PK_A, 'student');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('stores the identity as active with the ledger timestamp', async () => {
    const ctx = makeContext({ timestampMs: Date.parse('2026-09-09T10:00:00.000Z') });
    const id = await cc().registerIdentity(ctx, HASH, PK_A, 'student');
    const stored: Identity = JSON.parse(await cc().getIdentityStatus(nextTx(ctx), id));
    expect(stored.status).toBe('active');
    expect(stored.role).toBe('student');
    expect(stored.publicKey).toBe(PK_A);
    expect(stored.enrolledAt).toBe('2026-09-09T10:00:00.000Z');
  });

  it('records the enrolling organisation from the client identity', async () => {
    const ctx = makeContext({ mspId: 'RegistrarMSP' });
    const id = await cc().registerIdentity(ctx, HASH, PK_A, 'faculty');
    const stored: Identity = JSON.parse(await cc().getIdentityStatus(nextTx(ctx), id));
    expect(stored.enrolledBy).toContain('RegistrarMSP');
  });

  it('rejects an unknown role', async () => {
    await expect(cc().registerIdentity(makeContext(), HASH, PK_A, 'janitor'))
      .rejects.toThrow(/INVALID_ROLE/);
  });

  it('rejects a malformed public key', async () => {
    await expect(cc().registerIdentity(makeContext(), HASH, 'short', 'student'))
      .rejects.toThrow(/INVALID_PUBLIC_KEY/);
  });

  it('rejects a malformed identity hash', async () => {
    await expect(cc().registerIdentity(makeContext(), 'nothex', PK_A, 'student'))
      .rejects.toThrow(/INVALID_IDENTITY_HASH/);
  });

  it('rejects a duplicate enrolment for the same identity hash', async () => {
    const ctx = makeContext({ txId: 'tx-1' });
    await cc().registerIdentity(ctx, HASH, PK_A, 'student');
    await expect(
      cc().registerIdentity(nextTx(ctx, { txId: 'tx-2' }), HASH, PK_B, 'student'),
    ).rejects.toThrow(/IDENTITY_HASH_EXISTS/);
  });

  it('allows different students to enrol independently', async () => {
    const ctx = makeContext({ txId: 'tx-1' });
    await cc().registerIdentity(ctx, HASH, PK_A, 'student');
    const other = sha256Hex('student-2');
    await expect(
      cc().registerIdentity(nextTx(ctx, { txId: 'tx-2' }), other, PK_B, 'student'),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('getIdentityStatus', () => {
  it('rejects an unknown identity id', async () => {
    await expect(cc().getIdentityStatus(makeContext(), 'nope'))
      .rejects.toThrow(/IDENTITY_NOT_FOUND/);
  });
});

describe('revokeAndReissueKey', () => {
  const enrol = async () => {
    const ctx = makeContext({ txId: 'tx-1' });
    const id = await cc().registerIdentity(ctx, HASH, PK_A, 'student');
    return { ctx, id };
  };

  it('replaces the active public key', async () => {
    const { ctx, id } = await enrol();
    const ctx2 = nextTx(ctx, { txId: 'tx-2' });
    await cc().revokeAndReissueKey(ctx2, id, hashPublicKey(PK_A), PK_B, 'lost_device');
    const stored: Identity = JSON.parse(await cc().getIdentityStatus(nextTx(ctx2), id));
    expect(stored.publicKey).toBe(PK_B);
    expect(stored.status).toBe('active');
  });

  it('writes a revocation event naming the authorising client', async () => {
    const { ctx, id } = await enrol();
    const ctx2 = nextTx(ctx, { txId: 'tx-2', clientId: 'x509::CN=registrar-admin' });
    const raw = await cc().revokeAndReissueKey(
      ctx2, id, hashPublicKey(PK_A), PK_B, 'compromise');
    const event: KeyRevocationEvent = JSON.parse(raw);
    expect(event.oldPublicKeyHash).toBe(hashPublicKey(PK_A));
    expect(event.newPublicKey).toBe(PK_B);
    expect(event.reason).toBe('compromise');
    expect(event.authorizedBy).toBe('x509::CN=registrar-admin');
  });

  it('rejects a stale old key hash, preventing a rotation race', async () => {
    const { ctx, id } = await enrol();
    await expect(
      cc().revokeAndReissueKey(
        nextTx(ctx, { txId: 'tx-2' }), id, hashPublicKey(PK_B), PK_B, 'lost_device'),
    ).rejects.toThrow(/OLD_KEY_MISMATCH/);
  });

  it('rejects reissuing the same key', async () => {
    const { ctx, id } = await enrol();
    await expect(
      cc().revokeAndReissueKey(
        nextTx(ctx, { txId: 'tx-2' }), id, hashPublicKey(PK_A), PK_A, 'lost_device'),
    ).rejects.toThrow(/KEY_UNCHANGED/);
  });

  it('rejects an unknown revocation reason', async () => {
    const { ctx, id } = await enrol();
    await expect(
      cc().revokeAndReissueKey(
        nextTx(ctx, { txId: 'tx-2' }), id, hashPublicKey(PK_A), PK_B, 'bored'),
    ).rejects.toThrow(/INVALID_REASON/);
  });

  it('rejects an unknown identity', async () => {
    await expect(
      cc().revokeAndReissueKey(
        makeContext(), 'nope', hashPublicKey(PK_A), PK_B, 'lost_device'),
    ).rejects.toThrow(/IDENTITY_NOT_FOUND/);
  });
});
