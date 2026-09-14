import { describe, expect, it } from "bun:test";
import type { WAMessage } from "@whiskeysockets/baileys";
import { isAppError } from "../shared/errors.ts";
import type { MessageRecord } from "../shared/types.ts";
import { createMediaFetcher, downloadIncomingMedia } from "./mediaDownload.ts";

function makeRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  const now = new Date().toISOString();

  return {
    sessionId: "pessoal",
    chatJid: "556784020665@s.whatsapp.net",
    chatLookupKey: "556784020665",
    chatLookupJid: "556784020665@s.whatsapp.net",
    chatPhoneNumber: "556784020665",
    id: "3EB0MEDIA",
    participantJid: "556784020665@s.whatsapp.net",
    participantLookupKey: null,
    participantLookupJid: null,
    participantPhoneNumber: "556784020665",
    senderJid: "556784020665@s.whatsapp.net",
    senderLookupKey: null,
    senderLookupJid: null,
    senderPhoneNumber: "556784020665",
    pushName: "Priscila",
    fromMe: false,
    upsertType: "notify",
    messageType: "image",
    text: null,
    rawMessageType: "imageMessage",
    status: null,
    unixSeconds: 1_785_000_000,
    timestamp: now,
    updatedAt: now,
    ...overrides
  };
}

function makeRawMessage(content: Record<string, unknown>): WAMessage {
  return {
    key: {
      remoteJid: "556784020665@s.whatsapp.net",
      fromMe: false,
      id: "3EB0MEDIA"
    },
    messageTimestamp: 1_785_000_000,
    message: content
  } as unknown as WAMessage;
}

async function captureError(action: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error("esperava que a operacao falhasse");
}

describe("downloadIncomingMedia", () => {
  it("baixa midia de imagem e devolve o descritor com MIME e tamanho", async () => {
    const raw = makeRawMessage({
      imageMessage: {
        mimetype: "image/jpeg",
        fileLength: 3,
        jpegThumbnail: undefined
      }
    });
    const bytes = new Uint8Array([1, 2, 3]);

    const result = await downloadIncomingMedia({
      record: makeRecord(),
      raw,
      fetchMedia: async () => bytes
    });

    expect(result.kind).toBe("image");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.size).toBe(3);
    expect(result.buffer).toBe(bytes);
    expect(result.fileName).toBeNull();
  });

  it("sem mimetype no conteudo, cai no MIME padrao do tipo", async () => {
    const raw = makeRawMessage({
      audioMessage: { fileLength: 2, ptt: true }
    });

    const result = await downloadIncomingMedia({
      record: makeRecord({ messageType: "audio", rawMessageType: "audioMessage" }),
      raw,
      fetchMedia: async () => new Uint8Array([9, 9])
    });

    expect(result.kind).toBe("audio");
    expect(result.mimeType).toBe("audio/mpeg");
  });

  it("preserva o nome de arquivo original de documento quando existe", async () => {
    const raw = makeRawMessage({
      audioMessage: { mimetype: "audio/ogg; codecs=opus", fileName: "nota.ogg" }
    });

    const result = await downloadIncomingMedia({
      record: makeRecord({ messageType: "audio", rawMessageType: "audioMessage" }),
      raw,
      fetchMedia: async () => new Uint8Array([1])
    });

    expect(result.fileName).toBe("nota.ogg");
  });

  it("mensagem de history-sync sem payload bruto vira MEDIA_PAYLOAD_UNAVAILABLE com orientacao de reenvio", async () => {
    const error = await captureError(() =>
      downloadIncomingMedia({
        record: makeRecord(),
        raw: null,
        fetchMedia: async () => new Uint8Array([1])
      })
    );

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("MEDIA_PAYLOAD_UNAVAILABLE");
      expect(error.message).toContain("Peca o reenvio");
    }
  });

  it("mensagem de texto vira NOT_MEDIA antes do fetch", async () => {
    const raw = makeRawMessage({ conversation: "Bom dia" });

    const error = await captureError(() =>
      downloadIncomingMedia({
        record: makeRecord({ messageType: "text", rawMessageType: "conversation", text: "Bom dia" }),
        raw,
        fetchMedia: async () => {
          throw new Error("nao deveria buscar");
        }
      })
    );

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("NOT_MEDIA");
    }
  });

  it("tipo nao liberado (video) vira MEDIA_TYPE_NOT_SUPPORTED_YET antes do fetch", async () => {
    const raw = makeRawMessage({
      videoMessage: { mimetype: "video/mp4" }
    });

    const error = await captureError(() =>
      downloadIncomingMedia({
        record: makeRecord({ messageType: "video", rawMessageType: "videoMessage" }),
        raw,
        fetchMedia: async () => {
          throw new Error("nao deveria buscar");
        }
      })
    );

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("MEDIA_TYPE_NOT_SUPPORTED_YET");
    }
  });

  it("falha do fetch vira DOWNLOAD_FAILED, nunca erro seco", async () => {
    const raw = makeRawMessage({
      imageMessage: { mimetype: "image/jpeg" }
    });

    const error = await captureError(() =>
      downloadIncomingMedia({
        record: makeRecord(),
        raw,
        fetchMedia: async () => {
          throw new Error("410 Gone");
        }
      })
    );

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("DOWNLOAD_FAILED");
      expect(error.message).toContain("410 Gone");
      expect(error.message).toContain("expirado");
    }
  });
});

describe("createMediaFetcher", () => {
  it("devolve o buffer quando o download do Baileys resolve", async () => {
    const fetcher = createMediaFetcher(1_000, async () => new Uint8Array([7, 8]));
    const raw = makeRawMessage({ imageMessage: { mimetype: "image/jpeg" } });

    const buffer = await fetcher(raw);

    expect(Array.from(buffer)).toEqual([7, 8]);
  });

  it("estourar o timeout dedicado vira DOWNLOAD_FAILED com mensagem distinta de daemon parado", async () => {
    const fetcher = createMediaFetcher(30, () => new Promise<Uint8Array>(() => {}));
    const raw = makeRawMessage({ imageMessage: { mimetype: "image/jpeg" } });

    const error = await captureError(() => fetcher(raw));

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("DOWNLOAD_FAILED");
      expect(error.message).toContain("timeout");
      expect(error.message).not.toContain("daemon");
    }
  });
});
