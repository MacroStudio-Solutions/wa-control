import type { MessageRecord } from "../shared/types.ts";
import type { AppDatabase } from "./db.ts";

interface MessageRow {
  session_id: string;
  chat_jid: string;
  chat_lookup_key: string | null;
  chat_lookup_jid: string | null;
  chat_phone_number: string | null;
  id: string;
  participant_jid: string;
  participant_lookup_key: string | null;
  participant_lookup_jid: string | null;
  participant_phone_number: string | null;
  sender_jid: string;
  sender_lookup_key: string | null;
  sender_lookup_jid: string | null;
  sender_phone_number: string | null;
  push_name: string | null;
  from_me: number;
  upsert_type: string;
  message_type: string;
  text: string | null;
  status: string | null;
  unix_seconds: number | null;
  timestamp: string;
  updated_at: string;
}

function mapRow(row: MessageRow): MessageRecord {
  return {
    sessionId: row.session_id,
    chatJid: row.chat_jid,
    chatLookupKey: row.chat_lookup_key,
    chatLookupJid: row.chat_lookup_jid,
    chatPhoneNumber: row.chat_phone_number,
    id: row.id,
    participantJid: row.participant_jid,
    participantLookupKey: row.participant_lookup_key,
    participantLookupJid: row.participant_lookup_jid,
    participantPhoneNumber: row.participant_phone_number,
    senderJid: row.sender_jid,
    senderLookupKey: row.sender_lookup_key,
    senderLookupJid: row.sender_lookup_jid,
    senderPhoneNumber: row.sender_phone_number,
    pushName: row.push_name,
    fromMe: Boolean(row.from_me),
    upsertType: row.upsert_type,
    messageType: row.message_type,
    text: row.text,
    status: row.status,
    unixSeconds: row.unix_seconds,
    timestamp: row.timestamp,
    updatedAt: row.updated_at
  };
}

function placeholders(count: number, startAt: number): string {
  return Array.from({ length: count }, (_, index) => `?${startAt + index}`).join(", ");
}

export class MessagesRepo {
  constructor(private readonly db: AppDatabase) {}

  count(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS total FROM messages")
      .get() as { total: number };

    return row.total;
  }

  upsert(message: MessageRecord): MessageRecord {
    this.db
      .query(`
        INSERT INTO messages (
          session_id,
          chat_jid,
          chat_lookup_key,
          chat_lookup_jid,
          chat_phone_number,
          id,
          participant_jid,
          participant_lookup_key,
          participant_lookup_jid,
          participant_phone_number,
          sender_jid,
          sender_lookup_key,
          sender_lookup_jid,
          sender_phone_number,
          push_name,
          from_me,
          upsert_type,
          message_type,
          text,
          status,
          unix_seconds,
          timestamp,
          updated_at
        )
        VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
        )
        ON CONFLICT(session_id, chat_jid, id) DO UPDATE SET
          chat_lookup_key = excluded.chat_lookup_key,
          chat_lookup_jid = excluded.chat_lookup_jid,
          chat_phone_number = excluded.chat_phone_number,
          participant_jid = excluded.participant_jid,
          participant_lookup_key = excluded.participant_lookup_key,
          participant_lookup_jid = excluded.participant_lookup_jid,
          participant_phone_number = excluded.participant_phone_number,
          sender_jid = excluded.sender_jid,
          sender_lookup_key = excluded.sender_lookup_key,
          sender_lookup_jid = excluded.sender_lookup_jid,
          sender_phone_number = excluded.sender_phone_number,
          push_name = excluded.push_name,
          from_me = excluded.from_me,
          upsert_type = excluded.upsert_type,
          message_type = excluded.message_type,
          text = excluded.text,
          status = excluded.status,
          unix_seconds = excluded.unix_seconds,
          timestamp = excluded.timestamp,
          updated_at = excluded.updated_at
      `)
      .run(
        message.sessionId,
        message.chatJid,
        message.chatLookupKey,
        message.chatLookupJid,
        message.chatPhoneNumber,
        message.id,
        message.participantJid,
        message.participantLookupKey,
        message.participantLookupJid,
        message.participantPhoneNumber,
        message.senderJid,
        message.senderLookupKey,
        message.senderLookupJid,
        message.senderPhoneNumber,
        message.pushName,
        message.fromMe ? 1 : 0,
        message.upsertType,
        message.messageType,
        message.text,
        message.status,
        message.unixSeconds,
        message.timestamp,
        message.updatedAt
      );

    return message;
  }

  get(sessionId: string, chatJid: string, id: string): MessageRecord | null {
    const row = this.db
      .query("SELECT * FROM messages WHERE session_id = ?1 AND chat_jid = ?2 AND id = ?3")
      .get(sessionId, chatJid, id) as MessageRow | null;

    return row ? mapRow(row) : null;
  }

  list(sessionId: string, exactJids: string[], lookupKeys: string[], limit = 50): MessageRecord[] {
    if (exactJids.length === 0 && lookupKeys.length === 0) {
      return [];
    }

    const conditions: string[] = [];
    const values: Array<number | string> = [sessionId];
    let nextIndex = 2;

    if (exactJids.length > 0) {
      const directPlaceholders = placeholders(exactJids.length, nextIndex);
      values.push(...exactJids);
      nextIndex += exactJids.length;

      const lookupJidPlaceholders = placeholders(exactJids.length, nextIndex);
      values.push(...exactJids);
      nextIndex += exactJids.length;

      conditions.push(
        `(chat_jid IN (${directPlaceholders}) OR chat_lookup_jid IN (${lookupJidPlaceholders}))`
      );
    }

    if (lookupKeys.length > 0) {
      const lookupKeyPlaceholders = placeholders(lookupKeys.length, nextIndex);
      values.push(...lookupKeys);
      nextIndex += lookupKeys.length;
      conditions.push(`chat_lookup_key IN (${lookupKeyPlaceholders})`);
    }

    values.push(limit);
    const sql = `
      SELECT *
      FROM messages
      WHERE session_id = ?1 AND (${conditions.join(" OR ")})
      ORDER BY COALESCE(unix_seconds, 0) DESC, id DESC
      LIMIT ?${nextIndex}
    `;

    const rows = this.db.query(sql).all(...values) as MessageRow[];
    return rows.map(mapRow);
  }

  delete(sessionId: string, chatJid: string, id: string): void {
    this.db
      .query("DELETE FROM messages WHERE session_id = ?1 AND chat_jid = ?2 AND id = ?3")
      .run(sessionId, chatJid, id);
  }

  deleteChat(sessionId: string, chatJid: string): void {
    this.db.query("DELETE FROM messages WHERE session_id = ?1 AND chat_jid = ?2").run(sessionId, chatJid);
  }

  deleteSession(sessionId: string): void {
    this.db.query("DELETE FROM messages WHERE session_id = ?1").run(sessionId);
  }
}
