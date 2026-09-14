import { describe, expect, it } from "bun:test";
import type { MessageRecord } from "../shared/types.ts";
import {
  assertPollOptions,
  buildMessageKeyFromRecord,
  mapChatOpError,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS
} from "./chatOps.ts";

function messageRecord(patch: Partial<MessageRecord> = {}): MessageRecord {
  return {
    sessionId: "pessoal",
    chatJid: "556784020665@s.whatsapp.net",
    chatLookupKey: null,
    chatLookupJid: null,
    chatPhoneNumber: "556784020665",
    id: "3EB0CHATOP",
    participantJid: "556784020665@s.whatsapp.net",
    participantLookupKey: null,
    participantLookupJid: null,
    participantPhoneNumber: "556784020665",
    senderJid: "556784020665@s.whatsapp.net",
    senderLookupKey: null,
    senderLookupJid: null,
    senderPhoneNumber: "556784020665",
    pushName: null,
    fromMe: false,
    upsertType: "notify",
    messageType: "text",
    text: "oi",
    rawMessageType: null,
    status: null,
    unixSeconds: 1_785_000_000,
    timestamp: new Date(1_785_000_000 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch
  };
}

describe("assertPollOptions", () => {
  it("accepts the minimum viable poll", () => {
    expect(() => assertPollOptions(["A", "B"])).not.toThrow();
  });

  it("rejects fewer than two options before any network contact", () => {
    expect(() => assertPollOptions(["A"])).toThrow(/no minimo 2 opcoes/);
    expect(() => assertPollOptions([])).toThrow(/no minimo 2 opcoes/);
  });

  it("rejects more than the WhatsApp limit", () => {
    const options = Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_, i) => `o${i}`);
    expect(() => assertPollOptions(options)).toThrow(/no maximo 12 opcoes/);
  });

  it("rejects blank options", () => {
    expect(() => assertPollOptions(["A", "   "])).toThrow(/nao podem ser vazias/);
    expect(() => assertPollOptions(["", "A"])).toThrow(/nao podem ser vazias/);
  });
});

describe("buildMessageKeyFromRecord", () => {
  it("builds a direct-chat key without participant", () => {
    const key = buildMessageKeyFromRecord(messageRecord());

    expect(key).toEqual({
      remoteJid: "556784020665@s.whatsapp.net",
      id: "3EB0CHATOP",
      fromMe: false
    });
  });

  it("marks own messages with fromMe", () => {
    const key = buildMessageKeyFromRecord(messageRecord({ fromMe: true }));

    expect(key.fromMe).toBe(true);
    expect(key.participant).toBeUndefined();
  });

  it("includes the participant for group messages from others", () => {
    const key = buildMessageKeyFromRecord(
      messageRecord({
        chatJid: "1203456789@g.us",
        participantJid: "556784020665@s.whatsapp.net"
      })
    );

    expect(key.remoteJid).toBe("1203456789@g.us");
    expect(key.participant).toBe("556784020665@s.whatsapp.net");
  });

  it("includes the participant for own group messages too", () => {
    const key = buildMessageKeyFromRecord(
      messageRecord({
        chatJid: "1203456789@g.us",
        participantJid: "5599888777@s.whatsapp.net",
        fromMe: true
      })
    );

    expect(key.fromMe).toBe(true);
    expect(key.participant).toBe("5599888777@s.whatsapp.net");
  });

  it("prefers the resolved remote jid over the stored chat jid", () => {
    const key = buildMessageKeyFromRecord(
      messageRecord(),
      "556784020665:11@s.whatsapp.net"
    );

    expect(key.remoteJid).toBe("556784020665:11@s.whatsapp.net");
  });
});

describe("mapChatOpError", () => {
  it("maps each operation to its own error class at 502", () => {
    const boom = new Error("Connection Closed");

    expect(mapChatOpError("typing", boom).code).toBe("TYPING_FAILED");
    expect(mapChatOpError("read", boom).code).toBe("READ_FAILED");
    expect(mapChatOpError("react", boom).code).toBe("REACT_FAILED");
    expect(mapChatOpError("delete", boom).code).toBe("MESSAGE_DELETE_FAILED");
    expect(mapChatOpError("poll", boom).code).toBe("POLL_SEND_FAILED");
    expect(mapChatOpError("poll", boom).status).toBe(502);
  });

  it("keeps the Baileys message as the cause in the text", () => {
    const error = mapChatOpError("delete", new Error("conflict"));

    expect(error.message).toContain("apagar mensagem");
    expect(error.message).toContain("conflict");
  });

  it("extracts the Boom statusCode into details for honest degradation", () => {
    const refusal = Object.assign(new Error("forbidden"), {
      output: { statusCode: 403 }
    });
    const error = mapChatOpError("delete", refusal, { messageId: "3EB0X" });

    expect(error.details).toMatchObject({ messageId: "3EB0X", waStatusCode: 403 });
  });

  it("omits waStatusCode when the error has no Boom shape", () => {
    const error = mapChatOpError("react", new Error("timeout"));

    expect(error.details).toEqual({});
  });

  it("survives non-error throwables", () => {
    const error = mapChatOpError("poll", "boom");

    expect(error.message).toContain("Erro desconhecido na Baileys");
  });
});
