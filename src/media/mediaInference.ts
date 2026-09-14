import { readFileSync } from "node:fs";
import {
  isMediaKind,
  mediaTypeUnresolvedError,
  type MediaDescriptor,
  type MediaKind
} from "./mediaTypes.ts";

const KIND_BY_EXTENSION: Record<string, MediaKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  mp3: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  m4a: "audio",
  aac: "audio",
  amr: "audio",
  wav: "audio",
  mp4: "video",
  "3gp": "video",
  mkv: "video",
  avi: "video",
  mov: "video",
  pdf: "document",
  txt: "document",
  csv: "document",
  doc: "document",
  docx: "document",
  xls: "document",
  xlsx: "document",
  ppt: "document",
  pptx: "document",
  zip: "document"
};

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  amr: "audio/amr",
  wav: "audio/wav",
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip"
};

/**
 * MIME padrao por tipo quando a extensao do arquivo nao e reconhecida. E uma
 * escolha documentada, nao um palpite: o tipo aqui ja veio explicito (--type)
 * ou da tabela, e o padrao e o MIME mais tolerante de cada familia no WhatsApp.
 */
const DEFAULT_MIME_BY_KIND: Record<MediaKind, string> = {
  image: "image/jpeg",
  audio: "audio/mpeg",
  video: "video/mp4",
  document: "application/octet-stream",
  sticker: "image/webp"
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/zip": "zip"
};

export function fileExtension(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }

  return name.slice(dot + 1).toLowerCase();
}

export function inferMediaKindFromFile(filePath: string): MediaKind | null {
  const extension = fileExtension(filePath);
  return KIND_BY_EXTENSION[extension] ?? null;
}

/**
 * Familia de MIME esperada por tipo, nos casos em que a familia e homogenea.
 * Um override de tipo em desacordo com a extensao do arquivo nao deve rotular o
 * envio com um MIME de outra familia — imagem enviada como audio/mpeg seria
 * classificacao mentirosa e quebraria a entrega no WhatsApp. Documento fica de
 * fora de proposito: application/* e text/* sao familia legitima dele.
 */
const MEDIA_MIME_FAMILY_BY_KIND: Partial<Record<MediaKind, string>> = {
  image: "image",
  audio: "audio",
  video: "video",
  sticker: "image"
};

export function inferMimeTypeFromFile(
  filePath: string,
  kind: MediaKind,
  options: { ptt?: boolean } = {}
): string {
  const extension = fileExtension(filePath);
  const family = MEDIA_MIME_FAMILY_BY_KIND[kind];
  const byExtension = MIME_BY_EXTENSION[extension];
  const mimeType =
    byExtension && (!family || byExtension.startsWith(`${family}/`))
      ? byExtension
      : DEFAULT_MIME_BY_KIND[kind];

  // A voice note do WhatsApp e ogg/opus; so rotulamos audio/ogg; codecs=opus
  // quando o arquivo de origem e da familia ogg — rotular mp3 como ogg seria
  // classificacao mentirosa.
  if (kind === "audio" && options.ptt === true && mimeType.startsWith("audio/ogg")) {
    return "audio/ogg; codecs=opus";
  }

  return mimeType;
}

export function mimeForMediaKind(kind: MediaKind): string {
  return DEFAULT_MIME_BY_KIND[kind];
}

export function extensionForMimeType(mimeType: string): string {
  const baseType = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSION_BY_MIME[baseType] ?? "bin";
}

export interface MediaDescriptorFromFileOptions {
  kindOverride?: MediaKind;
  ptt?: boolean;
}

export function mediaDescriptorFromFile(
  filePath: string,
  options: MediaDescriptorFromFileOptions = {}
): MediaDescriptor {
  const kind = options.kindOverride ?? inferMediaKindFromFile(filePath);
  if (!kind || !isMediaKind(kind)) {
    throw mediaTypeUnresolvedError(filePath);
  }

  const mimeType = inferMimeTypeFromFile(filePath, kind, {
    ...(options.ptt !== undefined ? { ptt: options.ptt } : {})
  });

  return {
    kind,
    mimeType,
    payload: { kind: "buffer", buffer: readFileSync(filePath) }
  };
}
