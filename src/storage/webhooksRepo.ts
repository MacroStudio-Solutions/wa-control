import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./db.ts";
import type { WebhookRecord } from "../shared/types.ts";

interface WebhookRow {
  id: string;
  session_id: string;
  url: string;
  created_at: string;
  updated_at: string;
  is_enabled: number;
  timeout_ms: number;
  max_attempts: number;
  last_status: string | null;
  last_error: string | null;
}

function mapRow(row: WebhookRow): WebhookRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    enabled: Boolean(row.is_enabled),
    timeoutMs: row.timeout_ms,
    maxAttempts: row.max_attempts,
    lastStatus: row.last_status,
    lastError: row.last_error
  };
}

export class WebhooksRepo {
  constructor(private readonly db: AppDatabase) {}

  count(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS total FROM webhooks")
      .get() as { total: number };

    return row.total;
  }

  create(input: {
    sessionId: string;
    url: string;
    timeoutMs: number;
    maxAttempts: number;
  }): WebhookRecord {
    const now = new Date().toISOString();
    const record: WebhookRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      url: input.url,
      createdAt: now,
      updatedAt: now,
      enabled: true,
      timeoutMs: input.timeoutMs,
      maxAttempts: input.maxAttempts,
      lastStatus: null,
      lastError: null
    };

    this.db
      .query(`
        INSERT INTO webhooks (
          id,
          session_id,
          url,
          created_at,
          updated_at,
          is_enabled,
          timeout_ms,
          max_attempts,
          last_status,
          last_error
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      `)
      .run(
        record.id,
        record.sessionId,
        record.url,
        record.createdAt,
        record.updatedAt,
        record.enabled ? 1 : 0,
        record.timeoutMs,
        record.maxAttempts,
        record.lastStatus,
        record.lastError
      );

    return record;
  }

  list(sessionId?: string): WebhookRecord[] {
    const rows = sessionId
      ? (this.db
          .query("SELECT * FROM webhooks WHERE session_id = ?1 ORDER BY created_at ASC")
          .all(sessionId) as WebhookRow[])
      : (this.db.query("SELECT * FROM webhooks ORDER BY created_at ASC").all() as WebhookRow[]);

    return rows.map(mapRow);
  }

  get(id: string): WebhookRecord | null {
    const row = this.db
      .query("SELECT * FROM webhooks WHERE id = ?1")
      .get(id) as WebhookRow | null;

    return row ? mapRow(row) : null;
  }

  delete(id: string): boolean {
    const result = this.db.query("DELETE FROM webhooks WHERE id = ?1").run(id);
    return result.changes > 0;
  }

  markAttemptResult(
    id: string,
    status: "delivered" | "failed",
    error: string | null
  ): void {
    this.db
      .query(`
        UPDATE webhooks
        SET
          updated_at = ?2,
          last_status = ?3,
          last_error = ?4
        WHERE id = ?1
      `)
      .run(id, new Date().toISOString(), status, error);
  }
}
