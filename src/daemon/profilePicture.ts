import { AppError, isAppError } from "../shared/errors.ts";

/**
 * Foto de perfil de um contato (miniatura `preview` do WhatsApp), so leitura.
 *
 * - O resultado fica so em memoria, por sessao: foto achada vale por
 *   `foundTtlMs`, "sem foto" por `noneTtlMs`. Nada vai a disco nem a banco.
 * - As consultas ao WhatsApp correm uma de cada vez (o WhatsApp limita a
 *   frequencia dessa consulta); pedidos iguais em curso esperam o mesmo
 *   resultado.
 * - Contato sem foto (`item-not-found`/404) ou com a foto escondida pela
 *   privacidade (`not-authorized`/401) e resposta "sem foto", nunca erro.
 */

export type ProfilePictureMissingReason = "not-found" | "not-authorized";

export type ProfilePictureResult =
  | {
      found: true;
      jid: string;
      mimeType: string;
      buffer: Uint8Array;
      fetchedAt: string;
      cached: boolean;
    }
  | {
      found: false;
      jid: string;
      reason: ProfilePictureMissingReason;
      fetchedAt: string;
      cached: boolean;
    };

export interface ProfilePictureSource {
  resolveJid(chat: string): Promise<string>;
  /** URL da miniatura no WhatsApp; `undefined` quando nao ha foto. */
  pictureUrl(jid: string): Promise<string | undefined>;
  download(url: string): Promise<{ buffer: Uint8Array; contentType: string | null }>;
}

export interface ProfilePictureOptions {
  foundTtlMs?: number;
  noneTtlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
}

export const PROFILE_PICTURE_FOUND_TTL_MS = 6 * 60 * 60 * 1000;
export const PROFILE_PICTURE_NONE_TTL_MS = 60 * 60 * 1000;
export const PROFILE_PICTURE_MAX_ENTRIES = 1000;
export const PROFILE_PICTURE_MAX_BYTES = 2 * 1024 * 1024;

type CacheEntry = { result: ProfilePictureResult; expiresAt: number };

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const record = error as { data?: unknown; output?: { statusCode?: unknown } };
  if (typeof record.data === "number") {
    return record.data;
  }
  const status = record.output?.statusCode;
  return typeof status === "number" ? status : null;
}

/** Recusa do WhatsApp que significa "sem foto": nao existe ou esta escondida. */
export function classifyMissingPicture(error: unknown): ProfilePictureMissingReason | null {
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : "";
  if (status === 404 || /item-not-found/i.test(message)) {
    return "not-found";
  }
  if (status === 401 || /not-authorized/i.test(message)) {
    return "not-authorized";
  }
  return null;
}

function sniffImageMime(buffer: Uint8Array): string | null {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45
  ) {
    return "image/webp";
  }
  return null;
}

/** MIME da miniatura: o `content-type` quando e imagem; senao, pelos primeiros bytes. */
export function profilePictureMime(contentType: string | null, buffer: Uint8Array): string | null {
  const base = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (/^image\/[a-z0-9.+-]+$/.test(base)) {
    return base;
  }
  return sniffImageMime(buffer);
}

export class ProfilePictureService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ProfilePictureResult>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly foundTtlMs: number;
  private readonly noneTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(
    private readonly source: ProfilePictureSource,
    options: ProfilePictureOptions = {}
  ) {
    this.foundTtlMs = options.foundTtlMs ?? PROFILE_PICTURE_FOUND_TTL_MS;
    this.noneTtlMs = options.noneTtlMs ?? PROFILE_PICTURE_NONE_TTL_MS;
    this.maxEntries = options.maxEntries ?? PROFILE_PICTURE_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? PROFILE_PICTURE_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  async get(chat: string): Promise<ProfilePictureResult> {
    const key = chat.trim();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return { ...cached.result, cached: true };
    }
    if (cached) {
      this.cache.delete(key);
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
    const run = this.queue.then(() => this.fetch(key));
    this.queue = run.catch(() => undefined);
    this.inFlight.set(key, run);
    try {
      const result = await run;
      this.remember(key, result);
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  private remember(key: string, result: ProfilePictureResult): void {
    const ttl = result.found ? this.foundTtlMs : this.noneTtlMs;
    this.cache.delete(key);
    this.cache.set(key, { result, expiresAt: this.now() + ttl });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
  }

  private async fetch(chat: string): Promise<ProfilePictureResult> {
    const jid = await this.source.resolveJid(chat);
    const fetchedAt = new Date(this.now()).toISOString();
    let url: string | undefined;
    try {
      url = await this.source.pictureUrl(jid);
    } catch (error) {
      if (isAppError(error)) {
        throw error;
      }
      const reason = classifyMissingPicture(error);
      if (reason) {
        return { found: false, jid, reason, fetchedAt, cached: false };
      }
      throw new AppError(
        "PROFILE_PICTURE_FAILED",
        502,
        `Falha ao consultar a foto de perfil: ${error instanceof Error ? error.message : "erro desconhecido"}`,
        { jid }
      );
    }
    if (!url) {
      return { found: false, jid, reason: "not-found", fetchedAt, cached: false };
    }
    let downloaded: { buffer: Uint8Array; contentType: string | null };
    try {
      downloaded = await this.source.download(url);
    } catch (error) {
      throw new AppError(
        "PROFILE_PICTURE_DOWNLOAD_FAILED",
        502,
        `Falha ao baixar a foto de perfil: ${error instanceof Error ? error.message : "erro desconhecido"}`,
        { jid }
      );
    }
    if (downloaded.buffer.byteLength === 0) {
      throw new AppError("PROFILE_PICTURE_DOWNLOAD_FAILED", 502, "A foto de perfil veio vazia.", { jid });
    }
    if (downloaded.buffer.byteLength > this.maxBytes) {
      throw new AppError(
        "PROFILE_PICTURE_TOO_LARGE",
        502,
        `A foto de perfil passou de ${this.maxBytes} bytes.`,
        { jid, size: downloaded.buffer.byteLength }
      );
    }
    const mimeType = profilePictureMime(downloaded.contentType, downloaded.buffer);
    if (!mimeType) {
      throw new AppError(
        "PROFILE_PICTURE_DOWNLOAD_FAILED",
        502,
        "A foto de perfil nao veio como imagem.",
        { jid }
      );
    }
    return { found: true, jid, mimeType, buffer: downloaded.buffer, fetchedAt, cached: false };
  }
}

/** Download da miniatura pela URL do WhatsApp, com prazo. */
export async function downloadProfilePicture(
  url: string,
  timeoutMs = 15_000
): Promise<{ buffer: Uint8Array; contentType: string | null }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return {
    buffer: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type")
  };
}
