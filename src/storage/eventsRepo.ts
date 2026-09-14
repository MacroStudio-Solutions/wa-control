import type { AppDatabase } from "./db.ts";
import { parseEventJson, stringifyEvent } from "../shared/eventSerde.ts";
import type { NormalizedEvent } from "../shared/types.ts";

interface EventRow {
  id: string;
  event_name: string;
  session_id: string | null;
  payload_json: string;
  created_at: number;
}

export class EventsRepo {
  constructor(private readonly db: AppDatabase) {}

  append(event: NormalizedEvent): void {
    this.db
      .query(`
        INSERT INTO events (id, event_name, session_id, payload_json, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
      `)
      .run(
        event.id,
        event.event,
        event.sessionId,
        stringifyEvent(event),
        event.timestamp
      );
  }

  count(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS total FROM events")
      .get() as { total: number };

    return row.total;
  }

  recent(limit = 20): NormalizedEvent[] {
    const rows = this.db
      .query("SELECT * FROM events ORDER BY created_at DESC LIMIT ?1")
      .all(limit) as EventRow[];

    return rows.map((row) => ({
      ...parseEventJson(row.payload_json),
      id: row.id,
      event: row.event_name,
      sessionId: row.session_id,
      timestamp: row.created_at
    }));
  }

  forReadModelHydration(): NormalizedEvent[] {
    const rows = this.db
      .query(`
        SELECT *
        FROM events
        WHERE event_name IN ('message.received', 'message.sent')
        ORDER BY created_at ASC, id ASC
      `)
      .all() as EventRow[];

    return rows.map((row) => ({
      ...parseEventJson(row.payload_json),
      id: row.id,
      event: row.event_name,
      sessionId: row.session_id,
      timestamp: row.created_at
    }));
  }

  /**
   * Eventos `message.received` ao vivo guardam o payload bruto do Baileys;
   * midia de history-sync nao gera evento — para ela devolvemos null e o
   * pipeline de download classifica MEDIA_PAYLOAD_UNAVAILABLE.
   */
  findMessageRawPayload(sessionId: string, messageId: string): NormalizedEvent | null {
    const row = this.db
      .query(`
        SELECT *
        FROM events
        WHERE event_name = 'message.received'
          AND session_id = ?1
          AND json_extract(payload_json, '$.messageId') = ?2
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .get(sessionId, messageId) as EventRow | null;

    if (!row) {
      return null;
    }

    return {
      ...parseEventJson(row.payload_json),
      id: row.id,
      event: row.event_name,
      sessionId: row.session_id,
      timestamp: row.created_at
    };
  }
}
