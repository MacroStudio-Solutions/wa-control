import { jidNormalizedUser, type WAMessage } from "@whiskeysockets/baileys";
import { extractMessageContentInfo } from "./messageContent.ts";
import { classifyChatJid, isGroupJid, resolveIdentity } from "../shared/jids.ts";
import type { NormalizedEvent } from "../shared/types.ts";
import { nowUnix } from "../shared/utils.ts";

function toTimestamp(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "object" && value && "toNumber" in value) {
    const maybeToNumber = value.toNumber;
    if (typeof maybeToNumber === "function") {
      return maybeToNumber.call(value) as number;
    }
  }

  return nowUnix();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Normaliza uma mensagem `notify` do Baileys em `message.received`. Mensagem
 * propria (`fromMe`) tambem entra, marcada `fromMe: true`: e o que a loja
 * digita no WhatsApp do aparelho. Envios feitos por este daemon chegam como
 * `append` e nunca passam por aqui; eles ja viram `message.sent`.
 */
export function normalizeIncomingMessage(
  sessionId: string,
  message: WAMessage,
  authDir: string,
  includeRaw = false,
  selfJid: string | null = null
): NormalizedEvent | null {
  const fromMe = Boolean(message.key.fromMe);
  const chatId = message.key.remoteJid;
  if (!chatId) {
    return null;
  }

  const contentInfo = extractMessageContentInfo(message.message);

  // Numa conversa direta o remetente e o proprio chat; num grupo e o participante.
  // O WhatsApp entrega o endereco alternativo (numero, quando o envelope veio por
  // LID) ao lado do principal — e dali que sai o numero do contato.
  const inGroup = isGroupJid(chatId);
  // Mensagem propria numa conversa direta foi enviada pela propria conta, nao
  // pelo contato: o remetente e a conta conectada, sem endereco alternativo.
  const ownSelf = optionalString(selfJid);
  const senderJid =
    optionalString(message.key.participant) ??
    (fromMe && ownSelf ? jidNormalizedUser(ownSelf) : chatId);
  const senderAlt = inGroup
    ? optionalString(message.key.participantAlt)
    : fromMe
      ? null
      : optionalString(message.key.remoteJidAlt);

  const chat = resolveIdentity(
    authDir,
    chatId,
    inGroup ? null : optionalString(message.key.remoteJidAlt)
  );
  const sender = resolveIdentity(authDir, senderJid, senderAlt);

  const event: NormalizedEvent = {
    id: crypto.randomUUID(),
    event: "message.received",
    sessionId,
    timestamp: toTimestamp(message.messageTimestamp),
    messageId: message.key.id ?? crypto.randomUUID(),
    chatId,
    chatType: classifyChatJid(chatId),
    chatLid: inGroup ? null : chat.lid,
    chatPhoneNumber: inGroup ? null : chat.phoneNumber,
    from: sender.jid ?? senderJid,
    fromLid: sender.lid,
    fromPhoneNumber: sender.phoneNumber,
    // Falso quando o WhatsApp nao revelou o numero deste contato e nenhum
    // pareamento anterior foi aprendido. `from` continua util e estavel dentro
    // da sessao, mas nao e o numero que o operador conhece.
    senderResolved: sender.resolved,
    pushName: optionalString(message.pushName),
    fromMe,
    type: contentInfo.type,
    text: contentInfo.text,
    rawMessageType: contentInfo.rawMessageType
  };

  if (includeRaw) {
    event.raw = message as unknown as Record<string, unknown>;
  }

  return event;
}
