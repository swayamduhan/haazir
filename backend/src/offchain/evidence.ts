/**
 * Exemption evidence — medical certificates, on-duty letters — on a private
 * IPFS node.
 *
 * The ledger stores only each document's content identifier, which is a hash
 * of the content: it proves which document was filed while containing none
 * of it (ADR-020). The node runs offline, so a document is never announced to
 * the public IPFS network, where it could not be recalled.
 */
export interface EvidenceStore {
  add(content: Buffer, filename: string): Promise<string>;
  get(cid: string): Promise<Buffer | null>;
  /** Unpins and garbage-collects. Only this node is in scope; see the note on remove(). */
  remove(cid: string): Promise<void>;
}

export class IpfsEvidenceStore implements EvidenceStore {
  constructor(private readonly api: string) {}

  static async connect(api: string): Promise<IpfsEvidenceStore> {
    const res = await fetch(`${api}/api/v0/id`, { method: 'POST' });
    if (!res.ok) throw new Error(`IPFS API at ${api} answered ${res.status}`);
    return new IpfsEvidenceStore(api);
  }

  async add(content: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([content]), filename);
    // CIDv1: base32, the form the chaincode's validator and modern tooling expect.
    const res = await fetch(`${this.api}/api/v0/add?cid-version=1&pin=true`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`IPFS add failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { Hash: string }).Hash;
  }

  async get(cid: string): Promise<Buffer | null> {
    const res = await fetch(`${this.api}/api/v0/cat?arg=${encodeURIComponent(cid)}&offline=true`, { method: 'POST' });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Erasure, honestly scoped: this removes the document from this node. It
   * cannot reach copies someone else made, which is exactly why the node is
   * offline and the document is never published in the first place.
   */
  async remove(cid: string): Promise<void> {
    await fetch(`${this.api}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`, { method: 'POST' });
    await fetch(`${this.api}/api/v0/repo/gc`, { method: 'POST' });
  }
}
