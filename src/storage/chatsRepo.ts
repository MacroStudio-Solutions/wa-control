import type { ChatRecord } from "../shared/types.ts";
import type { AppDatabase } from "./db.ts";

interface ChatRow {
  session_id: string;
  id: string;
  lookup_key: string | null;
  lookup_jid: string | null;
  phone_number: string | null;
  name: string | null;
  type: ChatRecord["type"];
  conversation_timestamp: number | null;
  last_message_recv_timestamp: number | null;
  unread_count: number;
  last_message_id: string | null;
  last_message_type: string | null;
  last_message_text: string | null;
  last_message_timestamp: string | null;
  updated_at: string;
}

function mapRow(row: ChatRow): ChatRecord {
  return {
    sessionId: row.session_id,
    id: row.id,
    lookupKey: row.lookup_key,
    lookupJid: row.lookup_jid,
    phoneNumber: row.phone_number,
    name: row.name,
    type: row.type,
    conversationTimestamp: row.conversation_timestamp,
    lastMessageRecvTimestamp: row.last_message_recv_timestamp,
    unreadCount: row.unread_count,
    lastMessageId: row.last_message_id,
    lastMessageType: row.last_message_type,
    lastMessageText: row.last_message_text,
    lastMessageTimestamp: row.last_message_timestamp,
    updatedAt: row.updated_at
  };
}

export class ChatsRepo {
  constructor(private readonly db: AppDatabase) {}

  upsert(chat: ChatRecord): ChatRecord {
    this.db
      .query(`
        INSERT INTO chats (
          session_id,
          id,
          lookup_key,
          lookup_jid,
          phone_number,
          name,
          type,
          conversation_timestamp,
          last_message_recv_timestamp,
          unread_count,
          last_message_id,
          last_message_type,
          last_message_text,
          last_message_timestamp,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        ON CONFLICT(session_id, id) DO UPDATE SET
          lookup_key = excluded.lookup_key,
          lookup_jid = excluded.lookup_jid,
          phone_number = excluded.phone_number,
          name = excluded.name,
          type = excluded.type,
          conversation_timestamp = excluded.conversation_timestamp,
          last_message_recv_timestamp = excluded.last_message_recv_timestamp,
          unread_count = excluded.unread_count,
          last_message_id = excluded.last_message_id,
          last_message_type = excluded.last_message_type,
          last_message_text = excluded.last_message_text,
          last_message_timestamp = excluded.last_message_timestamp,
          updated_at = excluded.updated_at
      `)
      .run(
        chat.sessionId,
        chat.id,
        chat.lookupKey,
        chat.lookupJid,
        chat.phoneNumber,
        chat.name,
        chat.type,
        chat.conversationTimestamp,
        chat.lastMessageRecvTimestamp,
        chat.unreadCount,
        chat.lastMessageId,
        chat.lastMessageType,
        chat.lastMessageText,
        chat.lastMessageTimestamp,
        chat.updatedAt
      );

    return chat;
  }

  get(sessionId: string, id: string): ChatRecord | null {
    const row = this.db
      .query("SELECT * FROM chats WHERE session_id = ?1 AND id = ?2")
      .get(sessionId, id) as ChatRow | null;

    return row ? mapRow(row) : null;
  }

  list(sessionId: string, limit = 50): ChatRecord[] {
    const rows = this.db
      .query(`
        SELECT *
        FROM chats
        WHERE session_id = ?1 AND type != 'status'
        ORDER BY COALESCE(conversation_timestamp, last_message_recv_timestamp, 0) DESC, id ASC
        LIMIT ?2
      `)
      .all(sessionId, limit) as ChatRow[];

    return rows.map(mapRow);
  }

  delete(sessionId: string, id: string): void {
    this.db.query("DELETE FROM chats WHERE session_id = ?1 AND id = ?2").run(sessionId, id);
  }

  deleteSession(sessionId: string): void {
    this.db.query("DELETE FROM chats WHERE session_id = ?1").run(sessionId);
  }
}
