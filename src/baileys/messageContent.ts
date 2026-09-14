import { extractMessageContent, getContentType } from "@whiskeysockets/baileys";
import type { WAMessage } from "@whiskeysockets/baileys";

export interface MessageContentInfo {
  type: string;
  text: string | null;
  rawMessageType: string | null;
}

const NORMALIZED_TYPES: Record<string, string> = {
  conversation: "text",
  extendedTextMessage: "text",
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "sticker",
  reactionMessage: "reaction"
};

type MessageContent = NonNullable<WAMessage["message"]>;

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readText(
  contentType: string,
  content: ReturnType<typeof extractMessageContent>
): string | null {
  if (!content) {
    return null;
  }

  switch (contentType) {
    case "conversation":
      return readString(content.conversation);
    case "extendedTextMessage":
      return readString(content.extendedTextMessage?.text);
    case "imageMessage":
      return readString(content.imageMessage?.caption);
    case "videoMessage":
      return readString(content.videoMessage?.caption);
    case "documentMessage":
      return readString(content.documentMessage?.caption);
    case "reactionMessage":
      return readString(content.reactionMessage?.text);
    case "buttonsResponseMessage":
      return readString(content.buttonsResponseMessage?.selectedDisplayText);
    case "listResponseMessage":
      return (
        readString(content.listResponseMessage?.title) ??
        readString(content.listResponseMessage?.singleSelectReply?.selectedRowId)
      );
    default:
      return null;
  }
}

function firstRawKey(message: object | null | undefined): string | null {
  if (!message) {
    return null;
  }

  for (const [key, value] of Object.entries(message)) {
    if (value) {
      return key;
    }
  }

  return Object.keys(message)[0] ?? null;
}

export function extractMessageContentInfo(
  message: WAMessage["message"] | Record<string, unknown> | null | undefined
): MessageContentInfo {
  const content = extractMessageContent(message as MessageContent | null | undefined);
  const contentType = getContentType(content);

  if (!contentType || !(content as Record<string, unknown> | undefined)?.[contentType]) {
    return {
      type: "unknown",
      text: null,
      rawMessageType: firstRawKey(message)
    };
  }

  return {
    type: NORMALIZED_TYPES[contentType] ?? contentType,
    text: readText(contentType, content),
    rawMessageType: contentType
  };
}
