import { jidNormalizedUser, type WAMessageKey } from "@whiskeysockets/baileys";
import { AppError } from "../shared/errors.ts";
import type { MessageRecord } from "../shared/types.ts";

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 12;

export type ChatOp = "typing" | "read" | "react" | "delete" | "poll";

const CHAT_OP_ERROR_CODES: Record<ChatOp, string> = {
  typing: "TYPING_FAILED",
  read: "READ_FAILED",
  react: "REACT_FAILED",
  delete: "MESSAGE_DELETE_FAILED",
  poll: "POLL_SEND_FAILED"
};

const CHAT_OP_LABELS: Record<ChatOp, string> = {
  typing: "enviar indicador de digitacao",
  read: "marcar como lida",
  react: "reagir a mensagem",
  delete: "apagar mensagem",
  poll: "enviar enquete"
};

export function assertPollOptions(options: string[]): void {
  for (const option of options) {
    if (!option || !option.trim()) {
      throw new AppError(
        "INVALID_POLL_OPTION",
        400,
        "Opcoes da enquete nao podem ser vazias."
      );
    }
  }

  if (options.length < POLL_MIN_OPTIONS) {
    throw new AppError(
      "POLL_OPTIONS_TOO_FEW",
      400,
      `Enquete precisa de no minimo ${POLL_MIN_OPTIONS} opcoes (recebido: ${options.length}).`
    );
  }

  if (options.length > POLL_MAX_OPTIONS) {
    throw new AppError(
      "POLL_OPTIONS_TOO_MANY",
      400,
      `Enquete aceita no maximo ${POLL_MAX_OPTIONS} opcoes (recebido: ${options.length}).`
    );
  }
}

/**
 * Reconstrucao da chave Baileys a partir do registro projetado: remoteJid do
 * chat, id da mensagem, fromMe e participant quando o chat e grupo (o
 * participant difere do chat so em conversa de grupo — em chat direto ele
 * replica o peer e incluiria ruído na chave).
 */
export function buildMessageKeyFromRecord(
  record: MessageRecord,
  remoteJid?: string
): WAMessageKey {
  const chatJid = remoteJid ?? record.chatJid;
  const participant =
    record.participantJid &&
    jidNormalizedUser(record.participantJid) !== jidNormalizedUser(chatJid)
      ? record.participantJid
      : undefined;

  return {
    remoteJid: chatJid,
    id: record.id,
    fromMe: record.fromMe,
    ...(participant ? { participant } : {})
  };
}

function extractStatusCode(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error &&
    "output" in error &&
    typeof error.output === "object" &&
    error.output &&
    "statusCode" in error.output &&
    typeof error.output.statusCode === "number"
  ) {
    return error.output.statusCode;
  }

  return null;
}

/**
 * Mapeamento honesto de falha da Baileys: o erro ganha classe propria por
 * operacao, a mensagem original da lib vai no texto e o statusCode do Boom
 * (quando existe) vai nos detalhes — recusa do WhatsApp NUNCA vira sucesso.
 */
export function mapChatOpError(
  op: ChatOp,
  error: unknown,
  details: Record<string, unknown> = {}
): AppError {
  const cause =
    error instanceof Error ? error.message : "Erro desconhecido na Baileys";
  const waStatusCode = extractStatusCode(error);

  return new AppError(
    CHAT_OP_ERROR_CODES[op],
    502,
    `Falha ao ${CHAT_OP_LABELS[op]}: ${cause}`,
    {
      ...details,
      ...(waStatusCode !== null ? { waStatusCode } : {})
    }
  );
}
