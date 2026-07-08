import type { AppDatabase } from "./db.ts";
import type { SessionRecord, SessionStatus } from "../shared/types.ts";

interface SessionRow {
  id: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  phone_number: string | null;
  last_error: string | null;
  is_active: number;
  last_connected_at: string | null;
  reconnect_attempts: number;
  qr: string | null;
}

function mapRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    phoneNumber: row.phone_number,
    lastError: row.last_error,
    active: Boolean(row.is_active),
    lastConnectedAt: row.last_connected_at,
    reconnectAttempts: row.reconnect_attempts,
    qr: row.qr
  };
}

export class SessionsRepo {
  constructor(private readonly db: AppDatabase) {}

  list(): SessionRecord[] {
    const rows = this.db
      .query("SELECT * FROM sessions ORDER BY id ASC")
      .all() as SessionRow[];

    return rows.map(mapRow);
  }

  listActive(): SessionRecord[] {
    const rows = this.db
      .query("SELECT * FROM sessions WHERE is_active = 1 ORDER BY id ASC")
      .all() as SessionRow[];

    return rows.map(mapRow);
  }

  get(id: string): SessionRecord | null {
    const row = this.db
      .query("SELECT * FROM sessions WHERE id = ?1")
      .get(id) as SessionRow | null;

    return row ? mapRow(row) : null;
  }

  save(session: SessionRecord): SessionRecord {
    this.db
      .query(`
        INSERT INTO sessions (
          id,
          status,
          created_at,
          updated_at,
          phone_number,
          last_error,
          is_active,
          last_connected_at,
          reconnect_attempts,
          qr
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at,
          phone_number = excluded.phone_number,
          last_error = excluded.last_error,
          is_active = excluded.is_active,
          last_connected_at = excluded.last_connected_at,
          reconnect_attempts = excluded.reconnect_attempts,
          qr = excluded.qr
      `)
      .run(
        session.id,
        session.status,
        session.createdAt,
        session.updatedAt,
        session.phoneNumber,
        session.lastError,
        session.active ? 1 : 0,
        session.lastConnectedAt,
        session.reconnectAttempts,
        session.qr
      );

    return session;
  }

  delete(id: string): boolean {
    const result = this.db.query("DELETE FROM sessions WHERE id = ?1").run(id);
    return result.changes > 0;
  }
}
