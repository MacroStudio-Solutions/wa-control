import { extractMessageContent, getContentType } from "@whiskeysockets/baileys";
import type { WAMessage } from "@whiskeysockets/baileys";
import { classifyChatJid, isGroupJid, resolveIdentity } from "../shared/jids.ts";
import type { NormalizedEvent } from "../shared/types.ts";
import { nowUnix } from "../shared/utils.ts";

function parseText(contentType: string | undefined, content: ReturnType<typeof extractMessageContent>): string | null {
  if (!content || !contentType) {
    return null;
  }

  switch (contentType) {
    case "conversation":
      return typeof content.conversation === "string" ? content.conversation : null;
    case "extendedTextMessage":
      return content.extendedTextMessage?.text ?? null;
    case "imageMessage":
      return content.imageMessage?.caption ?? null;
    case "videoMessage":
      return content.videoMessage?.caption ?? null;
    case "documentMessage":
      return content.documentMessage?.caption ?? null;
    case "buttonsResponseMessage":
      return content.buttonsResponseMessage?.selectedDisplayText ?? null;
    case "listResponseMessage":
      return content.listResponseMessage?.title ?? null;
    default:
      return null;
  }
}

function mapMessageType(contentType: string | undefined): string {
  switch (contentType) {
    case "conversation":
    case "extendedTextMessage":
      return "text";
    case "imageMessage":
      return "image";
    case "videoMessage":
      return "video";
    case "audioMessage":
      return "audio";
    case "documentMessage":
      return "document";
    case "stickerMessage":
      return "sticker";
    default:
      return contentType ?? "unknown";
  }
}

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

export function normalizeIncomingMessage(
  sessionId: string,
  message: WAMessage,
  authDir: string,
  includeRaw = false
): NormalizedEvent | null {
  if (message.key.fromMe) {
    return null;
  }

  const chatId = message.key.remoteJid;
  if (!chatId) {
    return null;
  }

  const content = extractMessageContent(message.message);
  const contentType = getContentType(content);

  // Numa conversa direta o remetente e o proprio chat; num grupo e o participante.
  // O WhatsApp entrega o endereco alternativo (numero, quando o envelope veio por
  // LID) ao lado do principal — e dali que sai o numero do contato.
  const inGroup = isGroupJid(chatId);
  const senderJid = optionalString(message.key.participant) ?? chatId;
  const senderAlt = inGroup
    ? optionalString(message.key.participantAlt)
    : optionalString(message.key.remoteJidAlt);

  const chat = resolveIdentity(authDir, chatId, inGroup ? null : senderAlt);
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
    fromMe: false,
    type: mapMessageType(contentType),
    text: parseText(contentType, content)
  };

  if (includeRaw) {
    event.raw = message as unknown as Record<string, unknown>;
  }

  return event;
}
