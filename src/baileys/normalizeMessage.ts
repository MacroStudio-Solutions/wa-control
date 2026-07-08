import { extractMessageContent, getContentType } from "@whiskeysockets/baileys";
import type { WAMessage } from "@whiskeysockets/baileys";
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

export function normalizeIncomingMessage(
  sessionId: string,
  message: WAMessage,
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

  const event: NormalizedEvent = {
    id: crypto.randomUUID(),
    event: "message.received",
    sessionId,
    timestamp: toTimestamp(message.messageTimestamp),
    messageId: message.key.id ?? crypto.randomUUID(),
    chatId,
    from: message.key.participant ?? chatId,
    fromMe: false,
    type: mapMessageType(contentType),
    text: parseText(contentType, content)
  };

  if (includeRaw) {
    event.raw = message as unknown as Record<string, unknown>;
  }

  return event;
}
