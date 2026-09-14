import { describe, expect, it } from "bun:test";
import type { WAMessage } from "@whiskeysockets/baileys";
import { isAppError } from "../shared/errors.ts";
import { buildMediaMessageContent } from "./mediaContent.ts";
import { describeIncomingMedia } from "./mediaContent.ts";
import type { MediaDescriptor } from "./mediaTypes.ts";

function messageWithContent(content: Record<string, unknown>): WAMessage {
  return {
    key: { remoteJid: "55678@lid", id: "3EB0ABC", fromMe: false },
    message: content
  } as unknown as WAMessage;
}

function bufferDescriptor(kind: MediaDescriptor["kind"], mimeType: string | null): MediaDescriptor {
  return {
    kind,
    mimeType,
    payload: { kind: "buffer", buffer: new Uint8Array([1, 2, 3]) }
  };
}

describe("describeIncomingMedia", () => {
  it("imagem com mimetype e caption", () => {
    const info = describeIncomingMedia(
      messageWithContent({ imageMessage: { mimetype: "image/jpeg", caption: "Foto" } })
    );

    expect(info).toEqual({
      kind: "image",
      rawMessageType: "imageMessage",
      mimeType: "image/jpeg",
      fileName: null,
      fileLength: null
    });
  });

  it("audio de voice note", () => {
    const info = describeIncomingMedia(
      messageWithContent({ audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } })
    );

    expect(info?.kind).toBe("audio");
    expect(info?.mimeType).toBe("audio/ogg; codecs=opus");
  });

  it("documento expõe fileName e tamanho", () => {
    const info = describeIncomingMedia(
      messageWithContent({
        documentMessage: { mimetype: "application/pdf", fileName: "contrato.pdf", fileLength: 1234 }
      })
    );

    expect(info?.kind).toBe("document");
    expect(info?.mimeType).toBe("application/pdf");
    expect(info?.fileName).toBe("contrato.pdf");
    expect(info?.fileLength).toBe(1234);
  });

  it("video e sticker classificam pelo conteudo", () => {
    expect(describeIncomingMedia(messageWithContent({ videoMessage: {} }))?.kind).toBe("video");
    expect(
      describeIncomingMedia(messageWithContent({ stickerMessage: { mimetype: "image/webp" } }))
        ?.kind
    ).toBe("sticker");
  });

  it("envelope ephemeral com midia dentro e desembrulhado", () => {
    const info = describeIncomingMedia(
      messageWithContent({
        ephemeralMessage: { message: { imageMessage: { mimetype: "image/png" } } }
      })
    );

    expect(info?.kind).toBe("image");
    expect(info?.mimeType).toBe("image/png");
  });

  it("mensagem de texto nao e midia", () => {
    expect(describeIncomingMedia(messageWithContent({ conversation: "Bom dia" }))).toBeNull();
  });

  it("mensagem nula ou sem conteudo nao e midia", () => {
    expect(describeIncomingMedia(null)).toBeNull();
    expect(describeIncomingMedia(messageWithContent({}))).toBeNull();
  });
});

describe("buildMediaMessageContent", () => {
  it("imagem com caption e mimetype", () => {
    const content = buildMediaMessageContent(bufferDescriptor("image", "image/png"), {
      caption: "Veja isso"
    });

    expect(content).toMatchObject({
      image: expect.any(Buffer),
      caption: "Veja isso",
      mimetype: "image/png"
    });
  });

  it("imagem sem caption omite o campo", () => {
    const content = buildMediaMessageContent(bufferDescriptor("image", "image/jpeg"));

    expect(content).not.toHaveProperty("caption");
  });

  it("audio como anexo por padrao", () => {
    const content = buildMediaMessageContent(bufferDescriptor("audio", "audio/mpeg"));

    expect(content).toMatchObject({ audio: expect.any(Buffer), ptt: false });
  });

  it("audio com ptt vira voice note", () => {
    const content = buildMediaMessageContent(
      bufferDescriptor("audio", "audio/ogg; codecs=opus"),
      { ptt: true }
    );

    expect(content).toMatchObject({ audio: expect.any(Buffer), ptt: true });
  });

  it("caption em audio e recusada", () => {
    try {
      buildMediaMessageContent(bufferDescriptor("audio", "audio/mpeg"), { caption: "x" });
      throw new Error("deveria ter rejeitado");
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe("INVALID_FLAG");
      }
    }
  });

  it("tipo nao liberado e recusado pela tabela", () => {
    for (const kind of ["video", "document", "sticker"] as const) {
      try {
        buildMediaMessageContent(bufferDescriptor(kind, null));
        throw new Error(`deveria ter rejeitado ${kind}`);
      } catch (error) {
        expect(isAppError(error)).toBe(true);
        if (isAppError(error)) {
          expect(error.code).toBe("MEDIA_TYPE_NOT_SUPPORTED_YET");
        }
      }
    }
  });

  it("payload por referencia nao serve para envio", () => {
    const descriptor: MediaDescriptor = {
      kind: "image",
      mimeType: "image/jpeg",
      payload: { kind: "reference", chatJid: "55678@lid", messageId: "3EB0ABC" }
    };

    try {
      buildMediaMessageContent(descriptor);
      throw new Error("deveria ter rejeitado");
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe("MEDIA_PAYLOAD_UNAVAILABLE");
      }
    }
  });
});
