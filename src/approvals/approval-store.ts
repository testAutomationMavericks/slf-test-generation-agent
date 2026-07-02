/**
 * src/approvals/approval-store.ts
 *
 * Approval storage abstraction.
 * - LocalApprovalStore  → approvals.json  (Phase 1, default)
 * - PgApprovalStore     → PostgreSQL table (Phase 2, when DATABASE_URL set)
 *
 * Both implement IApprovalStore — server.ts uses the interface only.
 * Switch is automatic: if DATABASE_URL is configured, Postgres is used.
 */

import * as fs from 'fs';
import * as path from 'path';
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
  backend: 'local' | 'postgres';
}

// ─── Local JSON store (Phase 1 default) ──────────────────────────────────────

export class LocalApprovalStore implements IApprovalStore {
  readonly backend = 'local' as const;
  private filePath: string;
  private cache: Record<string, ApprovalRequest> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private read(): Record<string, ApprovalRequest> {
    if (this.cache) return this.cache;
    if (fs.existsSync(this.filePath)) {
      try {
        this.cache = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        return this.cache!;
      } catch { /* fall through */ }
    }
    this.cache = {};
    return this.cache;
  }

  private write(data: Record<string, ApprovalRequest>) {
    this.cache = data;
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  async load(id: string): Promise<ApprovalRequest | null> {
    return this.read()[id] ?? null;
  }

  async loadAll(): Promise<ApprovalRequest[]> {
    return Object.values(this.read()).sort(
      (a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()
    );
  }

  async save(approval: ApprovalRequest): Promise<void> {
    const data = this.read();
    data[approval.id] = approval;
    this.write(data);
  }

  async delete(id: string): Promise<void> {
    const data = this.read();
    delete data[id];
    this.write(data);
  }
}

// ─── PostgreSQL store (Phase 2) ───────────────────────────────────────────────
// Falls back to LocalApprovalStore automatically when postgres is unreachable,
// so approvals are never silently lost while EC2 is not yet available.

export class PgApprovalStore implements IApprovalStore {
  readonly backend = 'postgres' as const;
  private sql: any = null;
  private fallback: LocalApprovalStore;

  constructor(private connectionUrl: string, fallbackPath: string) {
    this.fallback = new LocalApprovalStore(fallbackPath);
    this.connect();
  }

  private async connect() {
    try {
      const { default: postgres } = await import('postgres');
      this.sql = postgres(this.connectionUrl, {
        ssl: 'require',
        max: 5,
        idle_timeout: 30,
        connect_timeout: 10,
        onnotice: () => {},
      });
      // Ensure table exists
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
      logger.warn('PgApprovalStore: EC2 not reachable, using local approvals.json until reconnected —', e);
      this.sql = null;
    }
  }

  private get connected(): boolean {
    return this.sql !== null;
  }

  async load(id: string): Promise<ApprovalRequest | null> {
    if (!this.connected) { return this.fallback.load(id); }
    const rows = await this.sql`SELECT data FROM approvals WHERE id = ${id}`;
    return rows[0]?.data ?? null;
  }

  async loadAll(): Promise<ApprovalRequest[]> {
    if (!this.connected) { return this.fallback.loadAll(); }
    const rows = await this.sql`SELECT data FROM approvals ORDER BY created_at DESC`;
    return rows.map((r: any) => r.data as ApprovalRequest);
  }

  async save(approval: ApprovalRequest): Promise<void> {
    if (!this.connected) {
      logger.warn(`PgApprovalStore: EC2 not reachable — saving "${approval.id}" to local approvals.json`);
      return this.fallback.save(approval);
    }
    await this.sql`
      INSERT INTO approvals (id, data, status)
      VALUES (${approval.id}, ${JSON.stringify(approval)}::jsonb, ${approval.status})
      ON CONFLICT (id) DO UPDATE SET
        data       = ${JSON.stringify(approval)}::jsonb,
        status     = ${approval.status},
        updated_at = NOW()
    `;
    logger.info(`PgApprovalStore: saved approval ${approval.id} (${approval.status})`);
  }

  async delete(id: string): Promise<void> {
    if (!this.connected) { return this.fallback.delete(id); }
    await this.sql`DELETE FROM approvals WHERE id = ${id}`;
    logger.info(`PgApprovalStore: deleted approval ${id}`);
  }

  async disconnect() {
    if (this.sql) await this.sql.end();
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createApprovalStore(opts: {
  filePath: string;
  databaseUrl?: string;
}): IApprovalStore {
  if (opts.databaseUrl) {
    logger.info('Approval store: PostgreSQL (EC2) with local fallback');
    return new PgApprovalStore(opts.databaseUrl, opts.filePath);
  }
  logger.info('Approval store: local JSON');
  return new LocalApprovalStore(opts.filePath);
}
