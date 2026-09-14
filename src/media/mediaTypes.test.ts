import { describe, expect, it } from "bun:test";
import { AppError, isAppError } from "../shared/errors.ts";
import {
  assertMediaKindSupported,
  downloadFailedError,
  isMediaKind,
  isMediaKindSupported,
  listSupportedMediaKinds,
  MEDIA_ERROR_CODES,
  MEDIA_KINDS,
  mediaPayloadUnavailableError,
  mediaTypeNotSupportedYetError,
  messageNotFoundError,
  notMediaError,
  type MediaDescriptor,
  type MediaKind
} from "./mediaTypes.ts";

describe("tabela de tipos suportados", () => {
  it("libera image e audio", () => {
    expect(isMediaKindSupported("image")).toBe(true);
    expect(isMediaKindSupported("audio")).toBe(true);
  });

  it("nao libera video, document e sticker", () => {
    expect(isMediaKindSupported("video")).toBe(false);
    expect(isMediaKindSupported("document")).toBe(false);
    expect(isMediaKindSupported("sticker")).toBe(false);
  });

  it("lista os tipos liberados na ordem do catalogo", () => {
    expect(listSupportedMediaKinds()).toEqual(["image", "audio"]);
  });

  it("cobre todos os tipos do catalogo na tabela", () => {
    for (const kind of MEDIA_KINDS) {
      expect(typeof isMediaKindSupported(kind)).toBe("boolean");
    }
  });
});

describe("assertMediaKindSupported", () => {
  it("passa para os tipos liberados", () => {
    expect(() => assertMediaKindSupported("image")).not.toThrow();
    expect(() => assertMediaKindSupported("audio")).not.toThrow();
  });

  it("rejeita os tipos ainda nao liberados com MEDIA_TYPE_NOT_SUPPORTED_YET", () => {
    const blocked: MediaKind[] = ["video", "document", "sticker"];

    for (const kind of blocked) {
      try {
        assertMediaKindSupported(kind);
        throw new Error(`deveria ter rejeitado ${kind}`);
      } catch (error) {
        expect(isAppError(error)).toBe(true);
        if (!isAppError(error)) {
          continue;
        }
        expect(error.code).toBe("MEDIA_TYPE_NOT_SUPPORTED_YET");
        expect(error.message).toContain(kind);
        expect(error.message).toContain("image, audio");
      }
    }
  });
});

describe("erros de midia", () => {
  it("MESSAGE_NOT_FOUND aponta chat e mensagem", () => {
    const error = messageNotFoundError("55678@lid", "3EB0ABC");
    expect(error.code).toBe("MESSAGE_NOT_FOUND");
    expect(error.status).toBe(404);
    expect(error.message).toContain("55678@lid");
    expect(error.message).toContain("3EB0ABC");
  });

  it("NOT_MEDIA carrega o tipo cru quando existe", () => {
    const error = notMediaError("conversation");
    expect(error.code).toBe("NOT_MEDIA");
    expect(error.status).toBe(400);
    expect(error.message).toContain("conversation");
  });

  it("MEDIA_PAYLOAD_UNAVAILABLE explica que o bruto nao esta guardado", () => {
    const error = mediaPayloadUnavailableError("history-sync");
    expect(error.code).toBe("MEDIA_PAYLOAD_UNAVAILABLE");
    expect(error.status).toBe(409);
    expect(error.message).toContain("history-sync");
  });

  it("DOWNLOAD_FAILED classifica falha do fetch como erro upstream", () => {
    const error = downloadFailedError("no url");
    expect(error.code).toBe("DOWNLOAD_FAILED");
    expect(error.status).toBe(502);
    expect(error.message).toContain("no url");
  });

  it("todos os codigos de midia usam exit 1, preservando o 2 so para send incerto", () => {
    const errors = [
      mediaTypeNotSupportedYetError("video"),
      messageNotFoundError("chat", "id"),
      notMediaError(null),
      mediaPayloadUnavailableError("x"),
      downloadFailedError("y")
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(AppError);
      expect(MEDIA_ERROR_CODES).toHaveProperty(error.code === "MEDIA_TYPE_NOT_SUPPORTED_YET" ? "typeNotSupportedYet" : error.code === "MEDIA_PAYLOAD_UNAVAILABLE" ? "payloadUnavailable" : error.code === "DOWNLOAD_FAILED" ? "downloadFailed" : error.code === "MESSAGE_NOT_FOUND" ? "messageNotFound" : "notMedia");
    }
  });
});

describe("descritor de midia", () => {
  it("aceita payload em buffer", () => {
    const descriptor: MediaDescriptor = {
      kind: "image",
      mimeType: "image/jpeg",
      payload: { kind: "buffer", buffer: new Uint8Array([1, 2, 3]) }
    };

    expect(descriptor.payload.kind).toBe("buffer");
  });

  it("aceita payload por referencia (chat + messageId)", () => {
    const descriptor: MediaDescriptor = {
      kind: "audio",
      mimeType: "audio/ogg; codecs=opus",
      payload: { kind: "reference", chatJid: "55678@lid", messageId: "3EB0ABC" }
    };

    expect(descriptor.payload.kind).toBe("reference");
  });
});

describe("isMediaKind", () => {
  it("reconhece os tipos do catalogo e rejeita o resto", () => {
    for (const kind of MEDIA_KINDS) {
      expect(isMediaKind(kind)).toBe(true);
    }

    expect(isMediaKind("photo")).toBe(false);
    expect(isMediaKind("")).toBe(false);
  });
});
