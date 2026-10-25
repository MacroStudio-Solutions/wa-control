import { Database } from "bun:sqlite";

export type AppDatabase = Database;

interface TableInfoRow {
  name: string;
}

function ensureColumn(db: AppDatabase, table: string, column: string, definition: string): void {
  const columns = db
    .query(`PRAGMA table_info(${table})`)
    .all() as TableInfoRow[];

  if (columns.some((entry) => entry.name === column)) {
    return;
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

export const SQLITE_BUSY_TIMEOUT_MS = 5000;

export interface OpenDatabaseOptions {
  busyTimeoutMs?: number;
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): AppDatabase {
  const db = new Database(path, { create: true });

  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // Pragma por conexao (sem persistencia): daemon e CLI abrem o mesmo
  // app.sqlite; sem isso, escrita cruzada vira SQLITE_BUSY imediato.
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS};`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      phone_number TEXT,
      last_error TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      last_connected_at TEXT,
      reconnect_attempts INTEGER NOT NULL DEFAULT 0,
      qr TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      session_id TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chats (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      lookup_key TEXT,
      lookup_jid TEXT,
      phone_number TEXT,
      name TEXT,
      type TEXT NOT NULL,
      conversation_timestamp INTEGER,
      last_message_recv_timestamp INTEGER,
      unread_count INTEGER NOT NULL DEFAULT 0,
      last_message_id TEXT,
      last_message_type TEXT,
      last_message_text TEXT,
      last_message_timestamp TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    CREATE TABLE IF NOT EXISTS contacts (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      lookup_key TEXT,
      lookup_jid TEXT,
      phone_number TEXT,
      lid TEXT,
      name TEXT,
      notify TEXT,
      verified_name TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      session_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      chat_lookup_key TEXT,
      chat_lookup_jid TEXT,
      chat_phone_number TEXT,
      id TEXT NOT NULL,
      participant_jid TEXT NOT NULL,
      participant_lookup_key TEXT,
      participant_lookup_jid TEXT,
      participant_phone_number TEXT,
      sender_jid TEXT NOT NULL,
      sender_lookup_key TEXT,
      sender_lookup_jid TEXT,
      sender_phone_number TEXT,
      push_name TEXT,
      from_me INTEGER NOT NULL DEFAULT 0,
      upsert_type TEXT NOT NULL,
      message_type TEXT NOT NULL,
      text TEXT,
      status TEXT,
      unix_seconds INTEGER,
      timestamp TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, chat_jid, id)
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      timeout_ms INTEGER NOT NULL DEFAULT 5000,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_status TEXT,
      last_error TEXT,
      events TEXT
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      session_id TEXT,
      event_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      response_body TEXT,
      FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chats_session_sort
      ON chats (session_id, conversation_timestamp DESC, last_message_recv_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_contacts_session_lookup
      ON contacts (session_id, lookup_key);
    CREATE INDEX IF NOT EXISTS idx_messages_session_chat
      ON messages (session_id, chat_jid, unix_seconds DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session_chat_lookup
      ON messages (session_id, chat_lookup_key, unix_seconds DESC);
  `);

  ensureColumn(db, "sessions", "last_connected_at", "TEXT");
  ensureColumn(db, "sessions", "reconnect_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "sessions", "qr", "TEXT");
  // Coluna aditiva do vocabulario normalizado de tipos (forward_only):
  // linhas antigas permanecem como estao, com NULL em raw_message_type.
  ensureColumn(db, "messages", "raw_message_type", "TEXT");
  ensureColumn(db, "webhooks", "updated_at", "TEXT");
  ensureColumn(db, "webhooks", "is_enabled", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "webhooks", "timeout_ms", "INTEGER NOT NULL DEFAULT 5000");
  ensureColumn(db, "webhooks", "max_attempts", "INTEGER NOT NULL DEFAULT 3");
  // NULL preserva o comportamento de quem foi cadastrado antes do filtro existir:
  // sem selecao, o webhook continua recebendo todos os eventos.
  ensureColumn(db, "webhooks", "events", "TEXT");

  return db;
}
