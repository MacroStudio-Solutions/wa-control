import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { isLidJid, isPhoneJid, normalizeJidQuery } from "../shared/jids.ts";
import type { Logger } from "../shared/logger.ts";

export interface LidPnPair {
  lid: string;
  pn: string;
}

/**
 * O Baileys so persiste o par LID<->numero quando a mensagem chega endereçada
 * pelo numero e traz o LID como alternativo. No sentido inverso — que e o
 * padrao desde o rollout de LID — ele entrega o numero no envelope e nao guarda
 * nada. Sem guardar, o numero se perde: nao existe consulta ao servidor que
 * traduza LID de volta para numero depois do fato.
 */
function toPair(primary: unknown, alternate: unknown): LidPnPair | null {
  if (typeof primary !== "string" || typeof alternate !== "string") {
    return null;
  }

  const first = normalizeJidQuery(primary);
  const second = normalizeJidQuery(alternate);
  if (!first || !second) {
    return null;
  }

  if (isLidJid(first) && isPhoneJid(second)) {
    return { lid: first, pn: second };
  }

  if (isPhoneJid(first) && isLidJid(second)) {
    return { lid: second, pn: first };
  }

  return null;
}

function dedupe(pairs: Array<LidPnPair | null>): LidPnPair[] {
  const seen = new Map<string, LidPnPair>();

  for (const pair of pairs) {
    if (pair) {
      seen.set(`${pair.lid}|${pair.pn}`, pair);
    }
  }

  return Array.from(seen.values());
}

export function extractMessageLidPairs(message: WAMessage): LidPnPair[] {
  const key = message.key as Record<string, unknown> | undefined;
  if (!key) {
    return [];
  }

  return dedupe([
    toPair(key.remoteJid, key.remoteJidAlt),
    toPair(key.participant, key.participantAlt)
  ]);
}

export function extractContactLidPairs(contact: Record<string, unknown>): LidPnPair[] {
  return dedupe([toPair(contact.id, contact.lid)]);
}

/**
 * Grava pelo proprio repositorio do Baileys: ele escreve na pasta de auth da
 * sessao, no mesmo formato que a resolucao de JIDs ja le, e sobrevive a restart.
 */
export async function rememberLidPairs(
  sock: WASocket,
  pairs: LidPnPair[],
  logger: Logger
): Promise<void> {
  if (pairs.length === 0) {
    return;
  }

  try {
    await sock.signalRepository.lidMapping.storeLIDPNMappings(pairs);
  } catch (error) {
    logger.warn("falha ao guardar mapeamento LID<->numero", {
      pairs: pairs.length,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
