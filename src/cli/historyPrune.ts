import { loadAppConfig } from "../config/config.ts";
import type { AppConfig } from "../shared/types.ts";
import { openDatabase } from "../storage/db.ts";
import { EventsRepo } from "../storage/eventsRepo.ts";
import { MessagesRepo } from "../storage/messagesRepo.ts";

export const HISTORY_DAY_SECONDS = 86_400;

/**
 * Contrato do verbo `wa history prune` — fixado com o chamador (rotina do
 * Studio): campos `ok`, `removed` e `olderThan`, nada mais. `removed` conta
 * mensagens; o journal de payloads (a midia local) sai junto, sem entrar na
 * contagem.
 */
export interface HistoryPruneResult {
  ok: true;
  removed: number;
  olderThan: string;
}

export interface HistoryPruneOptions {
  /** Idade maxima em dias; inteiro >= 1 (validado na borda do CLI). */
  olderThanDays: number;
  /** Instante de referencia em ms; injetavel para teste. */
  now?: number;
}

/**
 * Apaga o historico local de conversas anterior ao corte, em todas as
 * sessoes: as linhas de `messages` e o journal `message.*` de `events`, onde
 * o payload bruto (a midia local) vive. Nao toca em credencial, estado de
 * sessao, contatos, chats, webhooks nem eventos de sessao. Idempotente: uma
 * segunda passada sobre o mesmo corte nao acha mais nada.
 */
export function pruneHistory(
  options: HistoryPruneOptions,
  config: AppConfig = loadAppConfig()
): HistoryPruneResult {
  const cutoffSeconds =
    Math.floor((options.now ?? Date.now()) / 1000) - options.olderThanDays * HISTORY_DAY_SECONDS;
  const olderThan = new Date(cutoffSeconds * 1000).toISOString();

  const db = openDatabase(config.paths.databasePath);
  try {
    // As duas remocoes ou juntas ou nem acontecem: meio prune deixaria o
    // journal recriando mensagens na proxima reidratacao.
    const removed = db.transaction(() => {
      const messagesRemoved = new MessagesRepo(db).deleteBefore(cutoffSeconds, olderThan);
      new EventsRepo(db).deleteMessageHistoryBefore(cutoffSeconds);
      return messagesRemoved;
    })();

    return { ok: true, removed, olderThan };
  } finally {
    db.close();
  }
}
