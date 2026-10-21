import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { hashIdentity } from '@haazir/shared';

/**
 * Personal data, kept off the ledger in PostgreSQL.
 *
 * The ledger stores only SHA-256(canonical{name, enrolmentNo} | salt). That
 * hash links to a person only through the salt held here, so erasing this row
 * — the salt above all — leaves the on-chain hash a permanent reference to
 * nothing. Erasure without rewriting history is the whole design (ADR-005,
 * DPDP Act 2023 s.12).
 */
export interface PiiRecord {
  identityID: string;
  name: string;
  regNo: string;
  salt: string;
  identityHash: string;
  createdAt: string;
}

export interface PiiStore {
  /** Draws a fresh salt and returns the hash to anchor on chain. Nothing is stored yet. */
  prepare(name: string, regNo: string): { salt: string; identityHash: string };
  /** Checked before the chain write, so a duplicate never leaves an orphaned on-chain identity. */
  hasRegNo(regNo: string): Promise<boolean>;
  save(record: Omit<PiiRecord, 'createdAt'>): Promise<void>;
  get(identityID: string): Promise<PiiRecord | { identityID: string; erasedAt: string } | null>;
  /** Deletes the personal data, keeping only a tombstone saying when. */
  erase(identityID: string): Promise<boolean>;
  close(): Promise<void>;
}

export class PostgresPiiStore implements PiiStore {
  private constructor(private readonly pool: Pool) {}

  static async connect(url: string): Promise<PostgresPiiStore> {
    const pool = new Pool({ connectionString: url, max: 5 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS students (
        identity_id   TEXT PRIMARY KEY,
        name          TEXT,
        reg_no        TEXT UNIQUE,
        salt          TEXT,
        identity_hash TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        erased_at     TIMESTAMPTZ
      )`);
    return new PostgresPiiStore(pool);
  }

  prepare(name: string, regNo: string) {
    const salt = randomBytes(16).toString('hex');
    return { salt, identityHash: hashIdentity(name, regNo, salt) };
  }

  async hasRegNo(regNo: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM students WHERE reg_no = $1', [regNo]);
    return (rowCount ?? 0) > 0;
  }

  async save(r: Omit<PiiRecord, 'createdAt'>): Promise<void> {
    await this.pool.query(
      'INSERT INTO students (identity_id, name, reg_no, salt, identity_hash) VALUES ($1, $2, $3, $4, $5)',
      [r.identityID, r.name, r.regNo, r.salt, r.identityHash]);
  }

  async get(identityID: string) {
    const { rows } = await this.pool.query('SELECT * FROM students WHERE identity_id = $1', [identityID]);
    const row = rows[0];
    if (!row) return null;
    if (row.erased_at) return { identityID, erasedAt: new Date(row.erased_at).toISOString() };
    return {
      identityID, name: row.name, regNo: row.reg_no, salt: row.salt,
      identityHash: row.identity_hash, createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async erase(identityID: string): Promise<boolean> {
    // The identity hash goes too: kept beside the name it would let anyone
    // holding a database backup re-link the on-chain record.
    const res = await this.pool.query(
      `UPDATE students SET name = NULL, reg_no = NULL, salt = NULL, identity_hash = NULL, erased_at = now()
        WHERE identity_id = $1 AND erased_at IS NULL`, [identityID]);
    return (res.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** True when a record still holds personal data, as opposed to an erasure tombstone. */
export const isLive = (r: unknown): r is PiiRecord => !!r && typeof r === 'object' && 'salt' in r;
