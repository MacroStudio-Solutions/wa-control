import { downloadMediaMessage } from "@whiskeysockets/baileys";
import type { WAMessage } from "@whiskeysockets/baileys";
import type { MessageRecord } from "../shared/types.ts";
import { isAppError } from "../shared/errors.ts";
import { describeIncomingMedia } from "./mediaContent.ts";
import { mimeForMediaKind } from "./mediaInference.ts";
import {
  assertMediaKindSupported,
  downloadFailedError,
  mediaPayloadUnavailableError,
  notMediaError,
  type MediaKind
} from "./mediaTypes.ts";

export type MediaFetcher = (message: WAMessage) => Promise<Uint8Array>;

export interface IncomingMediaDownload {
  kind: MediaKind;
  mimeType: string;
  size: number;
  buffer: Uint8Array;
  fileName: string | null;
}

export interface DownloadIncomingMediaInput {
  record: MessageRecord;
  /** Payload bruto do Baileys; ausente em midia de history-sync. */
  raw: WAMessage | null;
  fetchMedia: MediaFetcher;
}

function payloadUnavailableReason(record: MessageRecord): string {
  return record.upsertType === "history"
    ? "history-sync"
    : "mensagem sem payload bruto guardado";
}

/**
 * Caminho de download do pipeline de midia: classificacao ANTES do fetch
 * (payload ausente, nao-midia, tipo nao liberado) e so entao o fetch — que
 * classifica a propria falha (timeout, midia expirada) via createMediaFetcher.
 */
export async function downloadIncomingMedia(
  input: DownloadIncomingMediaInput
): Promise<IncomingMediaDownload> {
  if (!input.raw) {
    throw mediaPayloadUnavailableError(payloadUnavailableReason(input.record));
  }

  const info = describeIncomingMedia(input.raw);
  if (!info) {
    throw notMediaError(input.record.rawMessageType);
  }

  assertMediaKindSupported(info.kind);

  let buffer: Uint8Array;
  try {
    buffer = await input.fetchMedia(input.raw);
  } catch (error) {
    if (isAppError(error)) {
      throw error;
    }

    throw downloadFailedError(
      error instanceof Error ? error.message : "erro desconhecido no fetch"
    );
  }

  return {
    kind: info.kind,
    mimeType: info.mimeType ?? mimeForMediaKind(info.kind),
    size: buffer.byteLength,
    buffer,
    fileName: info.fileName
  };
}

class MediaFetchTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MediaFetchTimeout()), timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function defaultDownload(message: WAMessage): Promise<Buffer> {
  // Sem ctx de reupload: midia expirada NAO tem retry automatico — falha
  // classificada vale mais que segundas tentativas invisiveis.
  return downloadMediaMessage(message, "buffer", {});
}

/**
 * Embrulha o download do Baileys com o timeout dedicado de midia e a
 * classificacao DOWNLOAD_FAILED — timeout de midia nunca e "daemon parado",
 * e falha upstream (midia expirada) vem com orientacao, nao erro seco.
 */
export function createMediaFetcher(
  timeoutMs: number,
  download: (message: WAMessage) => Promise<Uint8Array> = defaultDownload
): MediaFetcher {
  return async (message) => {
    try {
      return await withTimeout(download(message), timeoutMs);
    } catch (error) {
      if (isAppError(error)) {
        throw error;
      }

      if (error instanceof MediaFetchTimeout) {
        throw downloadFailedError(
          `timeout de ${Math.round(timeoutMs / 1000)}s excedido (rede lenta ou arquivo grande)`
        );
      }

      throw downloadFailedError(
        error instanceof Error ? error.message : "erro desconhecido no fetch"
      );
    }
  };
}
