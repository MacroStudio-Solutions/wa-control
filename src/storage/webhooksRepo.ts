import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./db.ts";
import type { WebhookRecord } from "../shared/types.ts";
import { AppError } from "../shared/errors.ts";
import {
  WEBHOOK_EVENTS,
  buildEventFlags,
  normalizeEventSelection
} from "../shared/events.ts";

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
  events: string | null;
}

function parseEvents(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function serializeEvents(events: readonly string[]): string | null {
  return events.length === 0 ? null : JSON.stringify(events);
}

function decorate(base: Omit<WebhookRecord, "eventsLabel" | "eventFlags">): WebhookRecord {
  return {
    ...base,
    eventsLabel: base.events.length === 0 ? "todos os eventos" : base.events.join(", "),
    eventFlags: buildEventFlags(base.events)
  };
}

function mapRow(row: WebhookRow): WebhookRecord {
  return decorate({
    id: row.id,
    sessionId: row.session_id,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    enabled: Boolean(row.is_enabled),
    timeoutMs: row.timeout_ms,
    maxAttempts: row.max_attempts,
    lastStatus: row.last_status,
    lastError: row.last_error,
    events: parseEvents(row.events)
  });
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
    events?: readonly string[];
  }): WebhookRecord {
    const now = new Date().toISOString();
    const record = decorate({
      id: randomUUID(),
      sessionId: input.sessionId,
      url: input.url,
      createdAt: now,
      updatedAt: now,
      enabled: true,
      timeoutMs: input.timeoutMs,
      maxAttempts: input.maxAttempts,
      lastStatus: null,
      lastError: null,
      events: normalizeEventSelection(input.events ?? [])
    });

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
          last_error,
          events
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
        record.lastError,
        serializeEvents(record.events)
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

  private require(id: string): WebhookRecord {
    const webhook = this.get(id);

    if (!webhook) {
      throw new AppError("WEBHOOK_NOT_FOUND", 404, `Webhook '${id}' nao encontrado.`);
    }

    return webhook;
  }

  /** Substitui a selecao inteira. Lista vazia volta a assinar todos os eventos. */
  setEvents(id: string, events: readonly string[]): WebhookRecord {
    this.require(id);

    this.db
      .query("UPDATE webhooks SET updated_at = ?2, events = ?3 WHERE id = ?1")
      .run(id, new Date().toISOString(), serializeEvents(normalizeEventSelection(events)));

    return this.require(id);
  }

  setEnabled(id: string, enabled: boolean): WebhookRecord {
    this.require(id);

    this.db
      .query("UPDATE webhooks SET updated_at = ?2, is_enabled = ?3 WHERE id = ?1")
      .run(id, new Date().toISOString(), enabled ? 1 : 0);

    return this.require(id);
  }

  /**
   * Liga um evento. Quem assina todos ja recebe o evento, entao ligar ali nao
   * muda nada — materializar a lista seria trocar "tudo, inclusive o que vier
   * depois" por uma selecao congelada, o que reduz a assinatura em vez de
   * ampliar.
   */
  enableEvent(id: string, event: string): WebhookRecord {
    const current = this.require(id);

    if (current.events.length === 0) {
      return current;
    }

    return this.setEvents(id, [...current.events, event]);
  }

  /**
   * Desliga um evento. Em quem assina todos, isso materializa a lista completa
   * menos o evento desligado, que e a unica forma de expressar a intencao.
   */
  disableEvent(id: string, event: string): WebhookRecord {
    const current = this.require(id);
    const base = current.events.length === 0 ? [...WEBHOOK_EVENTS] : current.events;
    const next = base.filter((entry) => entry !== event);

    // Selecao vazia significa "todos", entao gravar vazio aqui reativaria a
    // assinatura inteira — o oposto do que foi pedido.
    if (next.length === 0) {
      throw new AppError(
        "WEBHOOK_EVENTS_EMPTY",
        400,
        `Isso deixaria o webhook sem nenhum evento. Use \`wa webhook disable ${id}\` para desliga-lo.`
      );
    }

    return this.setEvents(id, next);
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
