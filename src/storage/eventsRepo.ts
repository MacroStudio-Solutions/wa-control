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
}
