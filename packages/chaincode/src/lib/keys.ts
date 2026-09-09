import { Context } from 'fabric-contract-api';

/**
 * All lookups use composite keys and plain state reads.
 *
 * Rich queries are deliberately avoided for existence checks: Fabric does
 * not include rich-query results in a transaction's read set, so they are
 * not revalidated at commit and two concurrent writes can both succeed.
 * A composite-key getState IS in the read set and is protected by MVCC.
 * Spec section 2.2, defect C6.
 */
export const IDENTITY = 'identity';
export const IDENTITY_HASH_INDEX = 'identityHash~id';
export const SESSION = 'session';
export const REVOCATION = 'revocation';

export const identityKey = (ctx: Context, identityID: string): string =>
  ctx.stub.createCompositeKey(IDENTITY, [identityID]);

export const identityHashIndexKey = (ctx: Context, identityHash: string): string =>
  ctx.stub.createCompositeKey(IDENTITY_HASH_INDEX, [identityHash]);

export const sessionKey = (ctx: Context, sessionID: string): string =>
  ctx.stub.createCompositeKey(SESSION, [sessionID]);

export const revocationKey = (ctx: Context, eventID: string): string =>
  ctx.stub.createCompositeKey(REVOCATION, [eventID]);

export async function exists(ctx: Context, key: string): Promise<boolean> {
  return (await ctx.stub.getState(key)).length > 0;
}

export async function readJson<T>(ctx: Context, key: string): Promise<T | undefined> {
  const bytes = await ctx.stub.getState(key);
  return bytes.length === 0 ? undefined : (JSON.parse(bytes.toString()) as T);
}
