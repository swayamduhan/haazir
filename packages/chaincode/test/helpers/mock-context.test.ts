import { makeContext, nextTx } from './mock-context';
import { txTimestampIso, txTimestampMs } from '../../src/lib/ledger-time';

describe('mock context', () => {
  it('stores and retrieves state', async () => {
    const ctx = makeContext();
    await ctx.stub.putState('k', Buffer.from('v'));
    expect((await ctx.stub.getState('k')).toString()).toBe('v');
  });

  it('returns an empty buffer for a missing key, as Fabric does', async () => {
    const ctx = makeContext();
    expect((await ctx.stub.getState('missing')).length).toBe(0);
  });

  it('exposes a stable transaction id', () => {
    const ctx = makeContext({ txId: 'tx-1' });
    expect(ctx.stub.getTxID()).toBe('tx-1');
  });

  it('converts the ledger timestamp to milliseconds and ISO form', () => {
    const ms = Date.parse('2026-09-09T10:00:00.000Z');
    const ctx = makeContext({ timestampMs: ms });
    expect(txTimestampMs(ctx)).toBe(ms);
    expect(txTimestampIso(ctx)).toBe('2026-09-09T10:00:00.000Z');
  });

  it('exposes the caller MSP and identity', () => {
    const ctx = makeContext({ mspId: 'RegistrarMSP', clientId: 'x509::admin' });
    expect(ctx.clientIdentity.getMSPID()).toBe('RegistrarMSP');
    expect(ctx.clientIdentity.getID()).toBe('x509::admin');
  });

  it('isolates state between contexts', async () => {
    const a = makeContext();
    await a.stub.putState('k', Buffer.from('v'));
    expect((await makeContext().stub.getState('k')).length).toBe(0);
  });

  it('carries state forward through nextTx, as a later transaction would', async () => {
    const first = makeContext({ txId: 'tx-1' });
    await first.stub.putState('k', Buffer.from('v'));
    const second = nextTx(first, { txId: 'tx-2' });
    expect((await second.stub.getState('k')).toString()).toBe('v');
    expect(second.stub.getTxID()).toBe('tx-2');
  });

  it('does not leak writes from a later transaction back to the earlier one', async () => {
    const first = makeContext();
    const second = nextTx(first);
    await second.stub.putState('new', Buffer.from('v'));
    expect((await first.stub.getState('new')).length).toBe(0);
  });
});
