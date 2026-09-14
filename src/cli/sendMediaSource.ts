import { accessSync, existsSync, statSync, constants as fsConstants } from "node:fs";
import { AppError } from "../shared/errors.ts";
import { mediaDescriptorFromFile, mimeForMediaKind } from "../media/mediaInference.ts";
import {
  assertMediaKindSupported,
  mediaFileUnreadableError,
  type MediaKind
} from "../media/mediaTypes.ts";

export interface SendMediaSource {
  kind: MediaKind;
  mimeType: string;
  buffer: Uint8Array;
}

export interface SendMediaSourceOptions {
  typeOverride?: MediaKind;
  caption?: string;
  ptt?: boolean;
}

/**
 * Classificacao de erros ANTES de qualquer rede: arquivo existe, e legivel, o
 * tipo foi inferido (ou veio por --type) e esta liberado, e caption/ptt so
 * acompanham o tipo que os aceita. O daemon so ve a requisicao quando tudo
 * confere — falha aqui e exit 1 sem transmissao.
 */
export function resolveSendMediaSource(
  filePath: string,
  options: SendMediaSourceOptions = {}
): SendMediaSource {
  assertFileReadable(filePath);

  const descriptor = mediaDescriptorFromFile(filePath, {
    ...(options.typeOverride ? { kindOverride: options.typeOverride } : {}),
    ...(options.ptt ? { ptt: true } : {})
  });

  assertMediaKindSupported(descriptor.kind);
  assertSendMediaFlags(descriptor.kind, options);

  if (descriptor.payload.kind !== "buffer") {
    throw mediaFileUnreadableError(filePath, "conteudo indisponivel");
  }

  return {
    kind: descriptor.kind,
    mimeType: descriptor.mimeType ?? mimeForMediaKind(descriptor.kind),
    buffer: descriptor.payload.buffer
  };
}

function assertFileReadable(filePath: string): void {
  if (!existsSync(filePath)) {
    throw mediaFileUnreadableError(filePath, "arquivo nao encontrado");
  }

  if (!statSync(filePath).isFile()) {
    throw mediaFileUnreadableError(filePath, "caminho nao e um arquivo");
  }

  try {
    accessSync(filePath, fsConstants.R_OK);
  } catch {
    throw mediaFileUnreadableError(filePath, "sem permissao de leitura");
  }
}

export function assertSendMediaFlags(
  kind: MediaKind,
  options: { caption?: string; ptt?: boolean }
): void {
  if (options.caption && kind !== "image") {
    throw new AppError(
      "INVALID_FLAG",
      400,
      `--caption so e suportada para imagem; '${kind}' nao leva legenda.`
    );
  }

  if (options.ptt === true && kind !== "audio") {
    throw new AppError(
      "INVALID_FLAG",
      400,
      `--ptt so e suportado para audio (voice note); '${kind}' nao e audio.`
    );
  }
}
