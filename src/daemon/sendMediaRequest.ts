import { AppError } from "../shared/errors.ts";
import { isMediaKind, type MediaKind } from "../media/mediaTypes.ts";

export interface ParsedSendMediaRequest {
  to: string;
  kind: MediaKind;
  mimeType: string;
  caption?: string;
  ptt?: boolean;
}

/**
 * Metadados do envio de midia chegam em headers x-media-*; os bytes, no corpo.
 * A validacao aqui e de forma (presenca e vocabulario) — a whitelist de tipos
 * liberados e aplicada pelo pipeline (MEDIA_TYPE_NOT_SUPPORTED_YET), nao por
 * este parser.
 */
export function parseSendMediaRequest(request: Request): ParsedSendMediaRequest {
  const header = (name: string): string | null => request.headers.get(name);
  const to = header("x-media-to");
  const kindRaw = header("x-media-kind");
  const mimeType = header("x-media-mime");

  if (!to || !kindRaw || !mimeType) {
    throw new AppError(
      "INVALID_REQUEST",
      400,
      "Headers x-media-to, x-media-kind e x-media-mime sao obrigatorios."
    );
  }

  if (!isMediaKind(kindRaw)) {
    throw new AppError(
      "INVALID_REQUEST",
      400,
      `Tipo de midia '${kindRaw}' invalido no header x-media-kind.`,
      { kind: kindRaw }
    );
  }

  const captionRaw = header("x-media-caption");

  return {
    to,
    kind: kindRaw,
    mimeType,
    ...(captionRaw ? { caption: decodeURIComponent(captionRaw) } : {}),
    ...(header("x-media-ptt") === "1" ? { ptt: true } : {})
  };
}
