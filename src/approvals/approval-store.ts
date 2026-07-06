/**
 * src/approvals/approval-store.ts
 *
 * Approval storage — PostgreSQL (EC2) required.
 * Table is auto-created on first connect (CREATE TABLE IF NOT EXISTS).
 * When the DB is not yet reachable, operations log a warning and are no-ops
 * (loadAll/load return empty; save/delete are skipped) rather than crashing.
 */

import { logger } from '../logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApprovalTestCase {
  id: number;
  name: string;
  type: string;
  priority: string;
  precondition: string;
  steps: Array<{ description: string; expectedResult: string }>;
  content: string;
  outcome: string;
  approved?: boolean;
  rejected?: boolean;
  approverComment?: string;
}

export interface ApprovalRequest {
  id: string;
  issueKey: string;
  issueSummary: string;
  projectKey: string;
  folder: string;
  requestedBy: string;
  requestedAt: string;
  testCases: ApprovalTestCase[];
  status: 'pending' | 'approved' | 'rejected' | 'partial' | 'uploaded';
  approvedBy?: string;
  approvedAt?: string;
  uploadedAt?: string;
  zephyrKeys?: string[];
}

export interface IApprovalStore {
  load(id: string): Promise<ApprovalRequest | null>;
  loadAll(): Promise<ApprovalRequest[]>;
  save(approval: ApprovalRequest): Promise<void>;
  delete(id: string): Promise<void>;
  backend: 'postgres';
}

// ─── PostgreSQL store ─────────────────────────────────────────────────────────

export class PgApprovalStore implements IApprovalStore {
  readonly backend = 'postgres' as const;
  private sql: any = null;

  constructor(private connectionUrl: string) {
    this.connect();
  }

  private async connect() {
    if (!this.connectionUrl || this.connectionUrl === 'unconfigured') {
      logger.warn('PgApprovalStore: DATABASE_URL not configured — approval features unavailable');
      return;
    }
    try {
      const { default: postgres } = await import('postgres');
      const ssl = /neon\.tech|sslmode=require/i.test(this.connectionUrl) || process.env.DB_SSL === 'require'
      this.sql = postgres(this.connectionUrl, {
        ssl: ssl ? 'require' : false,
        max: 5,
        idle_timeout: 30,
        connect_timeout: 10,
        onnotice: () => {},
      });
      await this.sql`
        CREATE TABLE IF NOT EXISTS approvals (
          id         TEXT PRIMARY KEY,
          data       JSONB NOT NULL,
          status     TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      await this.sql`
        CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals (status)
      `;
      logger.info('PgApprovalStore: connected to PostgreSQL');
    } catch (e) {
      logger.warn('PgApprovalStore: EC2 not reachable —', e);
      this.sql = null;
    }
  }

  private get connected(): boolean {
    return this.sql !== null;
  }

  async load(id: string): Promise<ApprovalRequest | null> {
    if (!this.connected) { logger.warn('PgApprovalStore: not connected, cannot load approval'); return null; }
    try {
      const rows = await this.sql`SELECT data FROM approvals WHERE id = ${id}`;
      const raw = rows[0]?.data;
      if (!raw) return null;
      // postgres.js returns JSONB as a parsed object; guard against rare string case
      if (typeof raw === 'string') {
        logger.warn(`PgApprovalStore: data for "${id}" was a string, parsing manually`);
        return JSON.parse(raw) as ApprovalRequest;
      }
      if (typeof raw === 'object' && !Array.isArray(raw) && !(raw as any).testCases) {
        logger.warn(`PgApprovalStore: approval "${id}" loaded but testCases is missing — keys: ${Object.keys(raw).join(', ')}`);
      }
      return raw as ApprovalRequest;
    } catch (e) {
      logger.warn(`PgApprovalStore: error loading approval "${id}":`, e);
      return null;
    }
  }

  async loadAll(): Promise<ApprovalRequest[]> {
    if (!this.connected) { logger.warn('PgApprovalStore: not connected, returning empty list'); return []; }
    try {
      const rows = await this.sql`SELECT data FROM approvals ORDER BY created_at DESC`;
      return rows.map((r: any) => {
        const raw = r.data;
        if (!raw) return null;
        if (typeof raw === 'string') { try { return JSON.parse(raw) as ApprovalRequest; } catch { return null; } }
        return raw as ApprovalRequest;
      }).filter(Boolean) as ApprovalRequest[];
    } catch (e) {
      logger.warn('PgApprovalStore: error loading approvals:', e);
      return [];
    }
  }

  async save(approval: ApprovalRequest): Promise<void> {
    if (!this.connected) { logger.warn(`PgApprovalStore: not connected, cannot save "${approval.id}"`); return; }
    try {
      await this.sql`
        INSERT INTO approvals (id, data, status)
        VALUES (${approval.id}, ${JSON.stringify(approval)}::jsonb, ${approval.status})
        ON CONFLICT (id) DO UPDATE SET
          data       = ${JSON.stringify(approval)}::jsonb,
          status     = ${approval.status},
          updated_at = NOW()
      `;
      logger.info(`PgApprovalStore: saved approval ${approval.id} (${approval.status})`);
    } catch (e) {
      logger.warn(`PgApprovalStore: error saving approval "${approval.id}":`, e);
      throw e;
    }
  }

  async delete(id: string): Promise<void> {
    if (!this.connected) { logger.warn(`PgApprovalStore: not connected, cannot delete "${id}"`); return; }
    try {
      await this.sql`DELETE FROM approvals WHERE id = ${id}`;
      logger.info(`PgApprovalStore: deleted approval ${id}`);
    } catch (e) {
      logger.warn(`PgApprovalStore: error deleting approval "${id}":`, e);
      throw e;
    }
  }

  async disconnect() {
    if (this.sql) await this.sql.end();
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createApprovalStore(connectionUrl?: string): IApprovalStore {
  if (!connectionUrl) {
    logger.warn('Approval store: DATABASE_URL not configured — approval features unavailable until EC2 is set up');
  } else {
    logger.info('Approval store: PostgreSQL (EC2)');
  }
  return new PgApprovalStore(connectionUrl ?? 'unconfigured');
}
