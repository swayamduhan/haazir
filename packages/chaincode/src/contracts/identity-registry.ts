import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import {
  canonicalize, deriveEventId, deriveIdentityId, hashPublicKey,
  Identity, isEd25519PublicKey, isSha256Hex, KeyRevocationEvent,
  REVOCATION_REASONS, RevocationReason, Role, ROLES,
} from '@haazir/shared';
import { fail } from '../lib/errors';
import {
  exists, identityHashIndexKey, identityKey, readJson, revocationKey,
} from '../lib/keys';
import { txTimestampIso } from '../lib/ledger-time';

@Info({
  title: 'IdentityRegistry',
  description: 'Pseudonymous identity enrolment and device key rotation',
})
export class IdentityRegistry extends Contract {
  constructor() {
    super('IdentityRegistry');
  }

  /**
   * Enrols a pseudonymous identity.
   *
   * No PII crosses the network: identityHash is a salted hash computed
   * off-chain and stored opaquely. Spec section 7.1.
   */
  @Transaction()
  @Returns('string')
  public async registerIdentity(
    ctx: Context,
    identityHash: string,
    publicKey: string,
    role: string,
  ): Promise<string> {
    if (!ROLES.includes(role as Role)) {
      fail('INVALID_ROLE', `role must be one of ${ROLES.join(', ')} (got "${role}")`);
    }
    if (!isSha256Hex(identityHash)) {
      fail('INVALID_IDENTITY_HASH', 'identityHash must be a 64-character hex sha256 digest');
    }
    if (!isEd25519PublicKey(publicKey)) {
      fail('INVALID_PUBLIC_KEY', 'publicKey must be a 64-character hex ed25519 key');
    }

    // Composite-key read, so the check is in the read set and MVCC-safe.
    const indexKey = identityHashIndexKey(ctx, identityHash);
    if (await exists(ctx, indexKey)) {
      fail('IDENTITY_HASH_EXISTS', 'an identity is already enrolled for this identity hash');
    }

    const identityID = deriveIdentityId(ctx.stub.getTxID());
    const identity: Identity = {
      identityID,
      identityHash,
      publicKey,
      role: role as Role,
      status: 'active',
      enrolledBy: ctx.clientIdentity.getMSPID(),
      enrolledAt: txTimestampIso(ctx),
    };

    await ctx.stub.putState(identityKey(ctx, identityID), Buffer.from(canonicalize(identity)));
    await ctx.stub.putState(indexKey, Buffer.from(identityID));
    return identityID;
  }

  @Transaction(false)
  @Returns('string')
  public async getIdentityStatus(ctx: Context, identityID: string): Promise<string> {
    const identity = await readJson<Identity>(ctx, identityKey(ctx, identityID));
    if (!identity) fail('IDENTITY_NOT_FOUND', `no identity with id "${identityID}"`);
    return canonicalize(identity);
  }

  /**
   * Rotates an identity's device key and records the event.
   *
   * The identity stays active — this is a rotation, not a revocation of the
   * person. authorizedBy is taken from the transaction's verified credentials
   * rather than a parameter, so it cannot be spoofed. Spec section 7.1.
   */
  @Transaction()
  @Returns('string')
  public async revokeAndReissueKey(
    ctx: Context,
    identityID: string,
    oldPublicKeyHash: string,
    newPublicKey: string,
    reason: string,
  ): Promise<string> {
    if (!REVOCATION_REASONS.includes(reason as RevocationReason)) {
      fail('INVALID_REASON', `reason must be one of ${REVOCATION_REASONS.join(', ')}`);
    }

    const key = identityKey(ctx, identityID);
    const identity = await readJson<Identity>(ctx, key);
    if (!identity) fail('IDENTITY_NOT_FOUND', `no identity with id "${identityID}"`);
    if (identity.status !== 'active') {
      fail('IDENTITY_NOT_ACTIVE', `identity "${identityID}" is ${identity.status}`);
    }
    if (!isEd25519PublicKey(newPublicKey)) {
      fail('INVALID_PUBLIC_KEY', 'newPublicKey must be a 64-character hex ed25519 key');
    }
    // Guards against two rotations racing: the caller must name the key it saw.
    if (hashPublicKey(identity.publicKey) !== oldPublicKeyHash) {
      fail('OLD_KEY_MISMATCH', 'oldPublicKeyHash does not match the currently active key');
    }
    if (newPublicKey === identity.publicKey) {
      fail('KEY_UNCHANGED', 'newPublicKey is identical to the current key');
    }

    const event: KeyRevocationEvent = {
      eventID: deriveEventId(ctx.stub.getTxID()),
      identityID,
      oldPublicKeyHash,
      newPublicKey,
      reason: reason as RevocationReason,
      authorizedBy: ctx.clientIdentity.getID(),
      timestamp: txTimestampIso(ctx),
    };

    identity.publicKey = newPublicKey;
    await ctx.stub.putState(key, Buffer.from(canonicalize(identity)));
    await ctx.stub.putState(revocationKey(ctx, event.eventID), Buffer.from(canonicalize(event)));
    return canonicalize(event);
  }
}
