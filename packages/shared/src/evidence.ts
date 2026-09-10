/**
 * Exemption evidence is anchored by its IPFS content identifier and never
 * stored on chain.
 *
 * A medical certificate is exactly the class of document the privacy
 * architecture exists to keep off the ledger: it is personal data, it is
 * erasable under DPDP 2023, and an immutable chain cannot honour a deletion
 * request. A CID is a hash of the content, so it proves which document was
 * submitted without containing any of it — and deleting the file leaves the
 * on-chain anchor as a permanent reference to nothing.
 */

/** CIDv0: base58btc-encoded multihash, always 46 characters beginning "Qm". */
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

/** CIDv1: lowercase base32 with the multibase prefix "b". */
const CID_V1 = /^b[a-z2-7]{58,110}$/;

export function isContentIdentifier(value: string): boolean {
  return CID_V0.test(value) || CID_V1.test(value);
}
