import { Context } from 'fabric-contract-api';

export interface MockContextOptions {
  txId?: string;
  timestampMs?: number;
  mspId?: string;
  clientId?: string;
}

/**
 * An in-memory stand-in for the Fabric chaincode stub, so contract logic can
 * be tested without a running network. Spec section 10.1 relies on this: it
 * decouples contract development from network bring-up, which is the
 * schedule risk.
 */
class MockStub {
  public readonly state = new Map<string, Buffer>();

  constructor(
    private readonly txId: string,
    private readonly timestampMs: number,
  ) {}

  /**
   * Mirrors Fabric's composite key format, which delimits with U+0000.
   * Built via fromCharCode rather than a literal so the source file stays
   * free of embedded NUL bytes, which editors and diffs mangle.
   */
  createCompositeKey(objectType: string, attributes: string[]): string {
    const NUL = String.fromCharCode(0);
    return `${NUL}${objectType}${NUL}${attributes.join(NUL)}${NUL}`;
  }

  async getState(key: string): Promise<Buffer> {
    return this.state.get(key) ?? Buffer.alloc(0);
  }

  async putState(key: string, value: Buffer): Promise<void> {
    this.state.set(key, Buffer.from(value));
  }

  async deleteState(key: string): Promise<void> {
    this.state.delete(key);
  }

  /**
   * Mirrors Fabric's range query: every key under the partial composite key,
   * in lexical key order.
   *
   * The ordering is not a convenience — the nonce sweep and the correction
   * history depend on it, which is why sequence numbers are zero-padded. A
   * mock that returned insertion order would let a test pass against
   * behaviour the real peer does not have.
   */
  async getStateByPartialCompositeKey(
    objectType: string,
    attributes: string[],
  ): Promise<MockIterator> {
    const NUL = String.fromCharCode(0);
    const prefix = attributes.length === 0
      ? `${NUL}${objectType}${NUL}`
      : `${NUL}${objectType}${NUL}${attributes.join(NUL)}${NUL}`;

    const matched = [...this.state.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => ({ key, value }));

    return new MockIterator(matched);
  }

  getTxID(): string {
    return this.txId;
  }

  getTxTimestamp(): { seconds: number; nanos: number } {
    return {
      seconds: Math.floor(this.timestampMs / 1000),
      nanos: (this.timestampMs % 1000) * 1_000_000,
    };
  }
}

interface MockQueryResult {
  key: string;
  value: Buffer;
}

class MockIterator {
  private cursor = 0;
  public closed = false;

  constructor(private readonly entries: MockQueryResult[]) {}

  async next(): Promise<{ done: boolean; value?: MockQueryResult }> {
    if (this.cursor >= this.entries.length) return { done: true };
    const value = this.entries[this.cursor];
    this.cursor += 1;
    return { done: false, value };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MockClientIdentity {
  constructor(
    private readonly mspId: string,
    private readonly clientId: string,
  ) {}

  getMSPID(): string {
    return this.mspId;
  }

  getID(): string {
    return this.clientId;
  }
}

export function makeContext(options: MockContextOptions = {}): Context {
  const {
    txId = 'tx-default',
    timestampMs = Date.parse('2026-09-09T10:00:00.000Z'),
    mspId = 'RegistrarMSP',
    clientId = 'x509::CN=admin',
  } = options;

  return {
    stub: new MockStub(txId, timestampMs),
    clientIdentity: new MockClientIdentity(mspId, clientId),
  } as unknown as Context;
}

/**
 * Continues against existing state, as a later transaction would. State is
 * copied rather than shared, so writes in the new transaction do not leak
 * back into the earlier one.
 */
export function nextTx(previous: Context, options: MockContextOptions = {}): Context {
  const ctx = makeContext(options);
  const source = (previous.stub as unknown as MockStub).state;
  const target = (ctx.stub as unknown as MockStub).state;
  for (const [k, v] of source) target.set(k, v);
  return ctx;
}
