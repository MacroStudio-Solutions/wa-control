import type { AppDatabase } from "./db.ts";

interface MismatchRow {
  session_id: string;
  chat_jid: string;
  id: string;
  unix_seconds: number | null;
  event_ts: number;
}

/**
 * Correcao unica (idempotente) dos horarios de mensagens gravados errados pelo
 * bug do ack: o Baileys informava a hora do AVISO de entregue/lido em
 * `messageTimestamp`, e o `messages.update` gravava essa hora como se fosse a
 * hora da mensagem — as linhas do mesmo instante empatabam e a ordem da
 * conversa caia no desempate por id. A hora verdadeira de cada linha esta no
 * journal de eventos (`created_at` do `message.received`/`message.sent` do
 * mesmo messageId, o primeiro — o instante em que a mensagem aconteceu), que
 * nunca foi contaminado. Linhas cuja hora ja bate com o journal — ou sem
 * evento correspondente (history-sync, journal ja podado pelo prune) — ficam
 * como estao. So mexe em `unix_seconds`/`timestamp`/`updated_at` de
 * `messages`; nao toca credencial, sessao nem midia. Roda na subida do
 * daemon: rodar de novo nao muda nada, porque nao sobra divergencia.
 */
export function repairMessageTimestampsFromEvents(db: AppDatabase): number {
  const mismatches = db
    .query(`
      WITH event_times AS (
        SELECT session_id,
               json_extract(payload_json, '$.messageId') AS message_id,
               MIN(created_at) AS event_ts
        FROM events
        WHERE event_name IN ('message.received', 'message.sent')
          AND json_extract(payload_json, '$.messageId') IS NOT NULL
        GROUP BY session_id, message_id
      )
      SELECT m.session_id, m.chat_jid, m.id, m.unix_seconds, e.event_ts
      FROM messages m
      JOIN event_times e ON e.session_id = m.session_id AND e.message_id = m.id
      WHERE m.unix_seconds IS NULL OR m.unix_seconds != e.event_ts
    `)
    .all() as MismatchRow[];

  if (mismatches.length === 0) {
    return 0;
  }

  const update = db.query(`
    UPDATE messages
    SET unix_seconds = ?1, timestamp = ?2, updated_at = ?3
    WHERE session_id = ?4 AND chat_jid = ?5 AND id = ?6
  `);

  const repairedAt = new Date().toISOString();

  db.transaction(() => {
    for (const row of mismatches) {
      update.run(
        row.event_ts,
        new Date(row.event_ts * 1000).toISOString(),
        repairedAt,
        row.session_id,
        row.chat_jid,
        row.id
      );
    }
  })();

  return mismatches.length;
}
