import { describe, expect, it } from "bun:test";
import { extractMessageContentInfo } from "./messageContent.ts";

type WAMessagePayload = Record<string, unknown>;

const CASES: Array<{
  name: string;
  payload: WAMessagePayload | undefined;
  expected: { type: string; text: string | null; rawMessageType: string | null };
}> = [
  {
    name: "texto puro (conversation)",
    payload: { conversation: "Bom dia" },
    expected: { type: "text", text: "Bom dia", rawMessageType: "conversation" }
  },
  {
    name: "texto estendido (extendedTextMessage)",
    payload: { extendedTextMessage: { text: "Veja isto: https://exemplo.com" } },
    expected: { type: "text", text: "Veja isto: https://exemplo.com", rawMessageType: "extendedTextMessage" }
  },
  {
    name: "imagem com caption",
    payload: { imageMessage: { caption: "Foto do documento" } },
    expected: { type: "image", text: "Foto do documento", rawMessageType: "imageMessage" }
  },
  {
    name: "imagem sem caption",
    payload: { imageMessage: { mimetype: "image/jpeg" } },
    expected: { type: "image", text: null, rawMessageType: "imageMessage" }
  },
  {
    name: "video com caption",
    payload: { videoMessage: { caption: "Olha isso" } },
    expected: { type: "video", text: "Olha isso", rawMessageType: "videoMessage" }
  },
  {
    name: "audio sem caption (text nulo aceitavel)",
    payload: { audioMessage: { mimetype: "audio/ogg" } },
    expected: { type: "audio", text: null, rawMessageType: "audioMessage" }
  },
  {
    name: "documento com caption",
    payload: { documentMessage: { caption: "Contrato", fileName: "contrato.pdf" } },
    expected: { type: "document", text: "Contrato", rawMessageType: "documentMessage" }
  },
  {
    name: "sticker",
    payload: { stickerMessage: { mimetype: "image/webp" } },
    expected: { type: "sticker", text: null, rawMessageType: "stickerMessage" }
  },
  {
    name: "reacao expoe o emoji como conteudo",
    payload: { reactionMessage: { text: "👍", key: { id: "reagida" } } },
    expected: { type: "reaction", text: "👍", rawMessageType: "reactionMessage" }
  },
  {
    name: "envelope viewOnceMessage desembrulhado",
    payload: { viewOnceMessage: { message: { conversation: "So da pra ler uma vez" } } },
    expected: { type: "text", text: "So da pra ler uma vez", rawMessageType: "conversation" }
  },
  {
    name: "envelope ephemeralMessage com midia dentro",
    payload: { ephemeralMessage: { message: { imageMessage: { caption: "Efemera" } } } },
    expected: { type: "image", text: "Efemera", rawMessageType: "imageMessage" }
  },
  {
    name: "envelope duplo (ephemeral dentro de viewOnce)",
    payload: {
      viewOnceMessage: { message: { ephemeralMessage: { message: { conversation: "Aninhado" } } } }
    },
    expected: { type: "text", text: "Aninhado", rawMessageType: "conversation" }
  },
  {
    name: "tipo nao mapeado passa a chave crua explicita (nunca unknown seco)",
    payload: { protocolMessage: { type: 15, key: { id: "proto-1" } } },
    expected: { type: "protocolMessage", text: null, rawMessageType: "protocolMessage" }
  },
  {
    name: "payload vazio",
    payload: undefined,
    expected: { type: "unknown", text: null, rawMessageType: null }
  },
  {
    name: "payload sem nenhuma chave com valor",
    payload: { conversation: null },
    expected: { type: "unknown", text: null, rawMessageType: "conversation" }
  }
];

describe("extractMessageContentInfo", () => {
  for (const testCase of CASES) {
    it(`classifica: ${testCase.name}`, () => {
      expect(extractMessageContentInfo(testCase.payload)).toEqual(testCase.expected);
    });
  }

  it("nunca devolve unknown sem indicar a chave crua encontrada", () => {
    const envelopes: WAMessagePayload[] = [
      { ephemeralMessage: null },
      { viewOnceMessageV2: {} }
    ];

    for (const payload of envelopes) {
      const info = extractMessageContentInfo(payload);
      if (info.type === "unknown") {
        expect(info.rawMessageType).not.toBeNull();
      }
    }
  });
});
