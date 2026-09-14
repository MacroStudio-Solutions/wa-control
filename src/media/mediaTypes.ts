import { AppError } from "../shared/errors.ts";

export const MEDIA_KINDS = ["image", "audio", "video", "document", "sticker"] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_ERROR_CODES = {
  typeNotSupportedYet: "MEDIA_TYPE_NOT_SUPPORTED_YET",
  typeUnresolved: "MEDIA_TYPE_UNRESOLVED",
  fileUnreadable: "MEDIA_FILE_UNREADABLE",
  messageNotFound: "MESSAGE_NOT_FOUND",
  notMedia: "NOT_MEDIA",
  payloadUnavailable: "MEDIA_PAYLOAD_UNAVAILABLE",
  downloadFailed: "DOWNLOAD_FAILED"
} as const;

/**
 * Tabela de tipos liberados. Os comandos de midia so aceitam um tipo quando ele
 * esta `true` aqui; liberar um tipo novo e uma linha na tabela, e o pipeline
 * (descritor, inferencia, classificacao de erros) ja nasce pronto para ele.
 * Tipos fora da tabela devolvem MEDIA_TYPE_NOT_SUPPORTED_YET — nunca erro seco.
 */
export const SUPPORTED_MEDIA_KINDS: Record<MediaKind, boolean> = {
  image: true,
  audio: true,
  video: true,
  document: true,
  sticker: false
};

export type MediaPayload =
  | { kind: "buffer"; buffer: Uint8Array }
  | { kind: "reference"; chatJid: string; messageId: string };

/**
 * Descritor unico de midia servindo send e download: o tipo normalizado, o MIME
 * resolvido (null quando o MIME verdadeiro nao e conhecido) e o payload, seja
 * em buffer (caminho de envio) seja por referencia (chat + messageId, caminho de
 * download).
 */
export interface MediaDescriptor {
  kind: MediaKind;
  mimeType: string | null;
  payload: MediaPayload;
}

export interface IncomingMediaInfo {
  kind: MediaKind;
  rawMessageType: string;
  mimeType: string | null;
  fileName: string | null;
  fileLength: number | null;
}

export function isMediaKind(value: string): value is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(value);
}

export function listSupportedMediaKinds(): MediaKind[] {
  return MEDIA_KINDS.filter((kind) => SUPPORTED_MEDIA_KINDS[kind]);
}

export function isMediaKindSupported(kind: MediaKind): boolean {
  return SUPPORTED_MEDIA_KINDS[kind];
}

export function mediaTypeNotSupportedYetError(kind: MediaKind): AppError {
  return new AppError(
    MEDIA_ERROR_CODES.typeNotSupportedYet,
    400,
    `Tipo de midia '${kind}' ainda nao e suportado. Tipos liberados: ${listSupportedMediaKinds().join(", ")}.`,
    { kind }
  );
}

export function assertMediaKindSupported(kind: MediaKind): void {
  if (!isMediaKindSupported(kind)) {
    throw mediaTypeNotSupportedYetError(kind);
  }
}

export function mediaTypeUnresolvedError(filePath: string): AppError {
  return new AppError(
    MEDIA_ERROR_CODES.typeUnresolved,
    400,
    `Nao foi possivel inferir o tipo de midia de '${filePath}'. Informe o tipo explicitamente com --type.`,
    { filePath }
  );
}

export function mediaFileUnreadableError(filePath: string, reason: string): AppError {
  return new AppError(
    MEDIA_ERROR_CODES.fileUnreadable,
    400,
    `Nao foi possivel ler o arquivo de midia '${filePath}' (${reason}).`,
    { filePath, reason }
  );
}

export function messageNotFoundError(chat: string, messageId: string): AppError {
  return new AppError(
    MEDIA_ERROR_CODES.messageNotFound,
    404,
    `Mensagem '${messageId}' nao encontrada no chat '${chat}'.`,
    { chat, messageId }
  );
}

export function notMediaError(rawMessageType: string | null): AppError {
  const detail = rawMessageType ? ` (conteudo cru: ${rawMessageType})` : "";
  return new AppError(
    MEDIA_ERROR_CODES.notMedia,
    400,
    `A mensagem referenciada nao e midia${detail}.`,
    { rawMessageType }
  );
}

export function mediaPayloadUnavailableError(reason: string): AppError {
  return new AppError(
    MEDIA_ERROR_CODES.payloadUnavailable,
    409,
    `O payload bruto desta mensagem nao esta guardado (${reason}), entao a midia nao pode ser baixada. Peca o reenvio do arquivo.`,
    { reason }
  );
}

export function downloadFailedError(cause: string): AppError {
  return new AppError(
    MEDIA_ERROR_CODES.downloadFailed,
    502,
    `Falha ao baixar a midia do WhatsApp: ${cause}. A midia pode ter expirado nos servidores.`,
    { cause }
  );
}
