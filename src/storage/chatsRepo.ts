import { AppError } from "../shared/errors.ts";
import type { ChatListItem, ChatRecord } from "../shared/types.ts";
import type { AppDatabase } from "./db.ts";

const CURSOR_PREFIX = "c1.";

export interface ChatCursor {
  sortKey: number;
  id: string;
}

/** Cursor opaco da lista de chats: a chave de ordem e o id da linha. */
export function encodeChatCursor(cursor: ChatCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify([cursor.sortKey, cursor.id]), "utf8").toString("base64url")}`;
}

export function decodeChatCursor(value: string): ChatCursor {
  const invalid = () =>
    new AppError(
      "INVALID_CURSOR",
      400,
      "Cursor de `chats` invalido. Use o `cursor` de uma linha devolvida por `wa chats`."
    );
  if (!value.startsWith(CURSOR_PREFIX) || value.length > 1024) {
    throw invalid();
  }
  const body = value.slice(CURSOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "number" ||
    !Number.isFinite(parsed[0]) ||
    typeof parsed[1] !== "string" ||
    parsed[1].length === 0
  ) {
    throw invalid();
  }
  return { sortKey: parsed[0], id: parsed[1] };
}

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
  sort_key: number;
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

  /**
   * Conversas da mais recente para a mais antiga (id crescente no empate).
   * Com `after`, so as que vem estritamente depois daquela posicao.
   */
  list(sessionId: string, limit = 50, after?: ChatCursor): ChatListItem[] {
    const rows = (
      after
        ? this.db
            .query(`
              SELECT *, COALESCE(conversation_timestamp, last_message_recv_timestamp, 0) AS sort_key
              FROM chats
              WHERE session_id = ?1 AND type != 'status'
                AND (
                  COALESCE(conversation_timestamp, last_message_recv_timestamp, 0) < ?3
                  OR (COALESCE(conversation_timestamp, last_message_recv_timestamp, 0) = ?3 AND id > ?4)
                )
              ORDER BY sort_key DESC, id ASC
              LIMIT ?2
            `)
            .all(sessionId, limit, after.sortKey, after.id)
        : this.db
            .query(`
              SELECT *, COALESCE(conversation_timestamp, last_message_recv_timestamp, 0) AS sort_key
              FROM chats
              WHERE session_id = ?1 AND type != 'status'
              ORDER BY sort_key DESC, id ASC
              LIMIT ?2
            `)
            .all(sessionId, limit)
    ) as ChatRow[];

    return rows.map((row) => ({
      ...mapRow(row),
      cursor: encodeChatCursor({ sortKey: row.sort_key, id: row.id })
    }));
  }

  delete(sessionId: string, id: string): void {
    this.db.query("DELETE FROM chats WHERE session_id = ?1 AND id = ?2").run(sessionId, id);
  }

  deleteSession(sessionId: string): void {
    this.db.query("DELETE FROM chats WHERE session_id = ?1").run(sessionId);
  }
}
