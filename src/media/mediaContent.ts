import { extractMessageContent, getContentType } from "@whiskeysockets/baileys";
import type { AnyMediaMessageContent, WAMessage } from "@whiskeysockets/baileys";
import { AppError } from "../shared/errors.ts";
import { mimeForMediaKind } from "./mediaInference.ts";
import {
  assertMediaKindSupported,
  MEDIA_ERROR_CODES,
  type IncomingMediaInfo,
  type MediaDescriptor
} from "./mediaTypes.ts";

const KIND_BY_CONTENT_TYPE: Record<string, IncomingMediaInfo["kind"]> = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "sticker"
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function readNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (value && typeof value === "object" && "toNumber" in value) {
    const maybeToNumber = value.toNumber;
    if (typeof maybeToNumber === "function") {
      const parsed = Number(maybeToNumber.call(value));
      return Number.isFinite(parsed) ? parsed : null;
    }
  }

  return null;
}

/**
 * Classifica a midia de uma mensagem recebida a partir do conteudo cru do
 * Baileys — o mesmo caminho de desembrulhar envelopes usado pelo triplo
 * normalizado. Devolve null quando a mensagem nao e midia; a decisao de virar
 * NOT_MEDIA e de quem chama.
 */
export function describeIncomingMedia(
  message: WAMessage | null | undefined
): IncomingMediaInfo | null {
  const content = extractMessageContent(message?.message);
  const contentType = getContentType(content);
  if (!contentType || !content) {
    return null;
  }

  const kind = KIND_BY_CONTENT_TYPE[contentType];
  if (!kind) {
    return null;
  }

  const mediaContent = (content as Record<string, unknown>)[contentType] as
    | Record<string, unknown>
    | undefined;
  if (!mediaContent) {
    return null;
  }

  return {
    kind,
    rawMessageType: contentType,
    mimeType: readString(mediaContent.mimetype),
    fileName: readString(mediaContent.fileName),
    fileLength: readNumberLike(mediaContent.fileLength)
  };
}

export interface SendMediaOptions {
  caption?: string;
  fileName?: string;
  ptt?: boolean;
}

/**
 * Monta o AnyMediaMessageContent do Baileys a partir do descritor. Envio exige
 * payload em buffer; caption existe em imagem e video (audio e documento nao
 * levam legenda); --filename da o nome do documento (o WhatsApp so o aceita
 * nesse tipo); --ptt e o que decide voice note versus anexo.
 */
export function buildMediaMessageContent(
  descriptor: MediaDescriptor,
  options: SendMediaOptions = {}
): AnyMediaMessageContent {
  assertMediaKindSupported(descriptor.kind);

  if (descriptor.payload.kind !== "buffer") {
    throw new AppError(
      MEDIA_ERROR_CODES.payloadUnavailable,
      409,
      "Envio de midia exige o conteudo em buffer; payload por referencia so serve para download.",
      { payloadKind: descriptor.payload.kind }
    );
  }

  const buffer = Buffer.from(descriptor.payload.buffer);
  const mimetype = descriptor.mimeType ?? undefined;

  switch (descriptor.kind) {
    case "image":
      return {
        image: buffer,
        ...(options.caption ? { caption: options.caption } : {}),
        ...(mimetype ? { mimetype } : {})
      };

    case "video":
      return {
        video: buffer,
        ...(options.caption ? { caption: options.caption } : {}),
        ...(mimetype ? { mimetype } : {})
      };

    case "audio":
      if (options.caption) {
        throw new AppError(
          "INVALID_FLAG",
          400,
          "Caption nao e suportada para audio; use texto na mensagem seguinte."
        );
      }

      return {
        audio: buffer,
        ptt: options.ptt === true,
        ...(mimetype ? { mimetype } : {})
      };

    case "document":
      if (options.caption) {
        throw new AppError(
          "INVALID_FLAG",
          400,
          "Caption nao e suportada para documento; o nome do arquivo vai em --filename."
        );
      }

      if (!options.fileName) {
        throw new AppError(
          "INVALID_FLAG",
          400,
          "Envio de documento exige um nome de arquivo; informe --filename."
        );
      }

      return {
        document: buffer,
        mimetype: descriptor.mimeType ?? mimeForMediaKind("document"),
        fileName: options.fileName
      };

    default:
      throw new AppError(
        MEDIA_ERROR_CODES.typeNotSupportedYet,
        400,
        `Tipo de midia '${descriptor.kind}' ainda nao e suportado para envio.`,
        { kind: descriptor.kind }
      );
  }
}
