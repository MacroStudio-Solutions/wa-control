import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./db.ts";
import type { WebhookDeliveryRecord } from "../shared/types.ts";

interface DeliveryRow {
  id: string;
  webhook_id: string;
  session_id: string | null;
  event_id: string;
  event_name: string;
  attempt: number;
  status: "delivered" | "failed";
  http_status: number | null;
  error: string | null;
  created_at: string;
  response_body: string | null;
}

function mapRow(row: DeliveryRow): WebhookDeliveryRecord {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    sessionId: row.session_id,
    eventId: row.event_id,
    eventName: row.event_name,
    attempt: row.attempt,
    status: row.status,
    httpStatus: row.http_status,
    error: row.error,
    createdAt: row.created_at,
    responseBody: row.response_body
  };
}

export class WebhookDeliveriesRepo {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Grava uma tentativa de entrega. Devolve null, sem gravar, quando o webhook
   * ja foi removido: a ponte troca o webhook a cada partida e o historico some
   * junto (ON DELETE CASCADE), entao uma tentativa tardia nao tem a quem
   * pertencer. O EXISTS roda no mesmo comando do INSERT, sem janela entre a
   * checagem e a gravacao, e a chave estrangeira continua valendo para o resto.
   */
  create(input: Omit<WebhookDeliveryRecord, "id" | "createdAt">): WebhookDeliveryRecord | null {
    const record: WebhookDeliveryRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input
    };

    const result = this.db
      .query(`
        INSERT INTO webhook_deliveries (
          id,
          webhook_id,
          session_id,
          event_id,
          event_name,
          attempt,
          status,
          http_status,
          error,
          created_at,
          response_body
        )
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
        WHERE EXISTS (SELECT 1 FROM webhooks WHERE id = ?2)
      `)
      .run(
        record.id,
        record.webhookId,
        record.sessionId,
        record.eventId,
        record.eventName,
        record.attempt,
        record.status,
        record.httpStatus,
        record.error,
        record.createdAt,
        record.responseBody
      );

    return result.changes > 0 ? record : null;
  }

  list(sessionId?: string, limit = 50): WebhookDeliveryRecord[] {
    const rows = sessionId
      ? (this.db
          .query(`
            SELECT *
            FROM webhook_deliveries
            WHERE session_id = ?1
            ORDER BY created_at DESC
            LIMIT ?2
          `)
          .all(sessionId, limit) as DeliveryRow[])
      : (this.db
          .query("SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?1")
          .all(limit) as DeliveryRow[]);

    return rows.map(mapRow);
  }
}
