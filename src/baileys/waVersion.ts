import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion
} from "@whiskeysockets/baileys";
import type { Logger } from "../shared/logger.ts";
import type { AppConfig } from "../shared/types.ts";

export type WAVersion = [number, number, number];

/**
 * O WhatsApp recusa o handshake com 405 quando a versao do WhatsApp Web
 * anunciada pelo cliente esta velha demais, e nesse caso nem QR e emitido. A
 * versao embutida no Baileys congela na data do release, entao ela envelhece
 * sozinha: o unico jeito de continuar pareando e perguntar a versao corrente
 * antes de abrir o socket.
 */
const CACHE_FILE = "wa-web-version.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

type CacheFile = {
  version: WAVersion;
  fetchedAt: number;
  source: string;
};

let memoryCache: CacheFile | null = null;

function cachePath(config: AppConfig): string {
  return join(config.paths.rootDir, CACHE_FILE);
}

function isVersion(value: unknown): value is WAVersion {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((part) => typeof part === "number" && Number.isFinite(part))
  );
}

function readCache(config: AppConfig): CacheFile | null {
  if (memoryCache) {
    return memoryCache;
  }

  const target = cachePath(config);
  if (!existsSync(target)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as Partial<CacheFile>;
    if (!isVersion(parsed.version) || typeof parsed.fetchedAt !== "number") {
      return null;
    }

    memoryCache = {
      version: parsed.version,
      fetchedAt: parsed.fetchedAt,
      source: typeof parsed.source === "string" ? parsed.source : "cache"
    };
    return memoryCache;
  } catch {
    return null;
  }
}

function writeCache(config: AppConfig, entry: CacheFile): void {
  memoryCache = entry;

  try {
    writeFileSync(cachePath(config), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  } catch {
    // cache em disco e otimizacao, nao requisito
  }
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), FETCH_TIMEOUT_MS);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function fetchVersion(): Promise<{ version: WAVersion; source: string } | null> {
  try {
    const result = await withTimeout(fetchLatestWaWebVersion({}));
    if (isVersion(result.version)) {
      return { version: result.version, source: "wa-web" };
    }
  } catch {
    // cai para o proximo
  }

  try {
    const result = await withTimeout(fetchLatestBaileysVersion({}));
    if (isVersion(result.version)) {
      return { version: result.version, source: "baileys" };
    }
  } catch {
    // sem rede: quem chama decide o fallback
  }

  return null;
}

/**
 * Resolve a versao a anunciar. Um cache quente responde sem rede; um cache frio
 * tenta a rede e, se ela falhar, ainda prefere a ultima versao conhecida a
 * versao embutida — envelhecida, mas mais nova que a do build.
 */
export async function resolveWaWebVersion(
  config: AppConfig,
  logger?: Logger
): Promise<WAVersion | undefined> {
  const cached = readCache(config);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.version;
  }

  const fetched = await fetchVersion();

  if (fetched) {
    writeCache(config, {
      version: fetched.version,
      fetchedAt: now,
      source: fetched.source
    });
    logger?.info("versao do WhatsApp Web resolvida", {
      version: fetched.version.join("."),
      source: fetched.source
    });
    return fetched.version;
  }

  if (cached) {
    logger?.warn("falha ao consultar versao do WhatsApp Web; usando cache", {
      version: cached.version.join("."),
      ageMs: now - cached.fetchedAt
    });
    return cached.version;
  }

  logger?.warn(
    "falha ao consultar versao do WhatsApp Web e sem cache; usando a versao embutida no Baileys"
  );
  return undefined;
}
