import type { ContactRecord } from "../shared/types.ts";
import type { AppDatabase } from "./db.ts";

interface ContactRow {
  session_id: string;
  id: string;
  lookup_key: string | null;
  lookup_jid: string | null;
  phone_number: string | null;
  lid: string | null;
  name: string | null;
  notify: string | null;
  verified_name: string | null;
  updated_at: string;
}

function mapRow(row: ContactRow): ContactRecord {
  return {
    sessionId: row.session_id,
    id: row.id,
    lookupKey: row.lookup_key,
    lookupJid: row.lookup_jid,
    phoneNumber: row.phone_number,
    lid: row.lid,
    name: row.name,
    notify: row.notify,
    verifiedName: row.verified_name,
    updatedAt: row.updated_at
  };
}

export class ContactsRepo {
  constructor(private readonly db: AppDatabase) {}

  upsert(contact: ContactRecord): ContactRecord {
    this.db
      .query(`
        INSERT INTO contacts (
          session_id,
          id,
          lookup_key,
          lookup_jid,
          phone_number,
          lid,
          name,
          notify,
          verified_name,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(session_id, id) DO UPDATE SET
          lookup_key = excluded.lookup_key,
          lookup_jid = excluded.lookup_jid,
          phone_number = excluded.phone_number,
          lid = excluded.lid,
          name = excluded.name,
          notify = excluded.notify,
          verified_name = excluded.verified_name,
          updated_at = excluded.updated_at
      `)
      .run(
        contact.sessionId,
        contact.id,
        contact.lookupKey,
        contact.lookupJid,
        contact.phoneNumber,
        contact.lid,
        contact.name,
        contact.notify,
        contact.verifiedName,
        contact.updatedAt
      );

    return contact;
  }

  list(sessionId: string, limit = 100): ContactRecord[] {
    const rows = this.db
      .query(`
        SELECT *
        FROM contacts
        WHERE session_id = ?1
        ORDER BY COALESCE(notify, name, verified_name, id) COLLATE NOCASE ASC
        LIMIT ?2
      `)
      .all(sessionId, limit) as ContactRow[];

    return rows.map(mapRow);
  }

  deleteSession(sessionId: string): void {
    this.db.query("DELETE FROM contacts WHERE session_id = ?1").run(sessionId);
  }
}
