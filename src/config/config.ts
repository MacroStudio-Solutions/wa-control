import { readFileSync } from "node:fs";
import { z } from "zod";
import { DEFAULT_HOST, DEFAULT_PORT, ensureAppDirectories, getAppPaths } from "./paths.ts";
import { writeFileAtomically } from "../shared/atomicFile.ts";
import { createLogger } from "../shared/logger.ts";
import type { AppConfig } from "../shared/types.ts";

const fileSchema = z.object({
  host: z.string().default(DEFAULT_HOST),
  port: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info")
});

type RawConfig = Record<string, unknown>;

interface ConfigFileRead {
  text: string | null;
  raw: RawConfig;
  problem: "vazio" | "com JSON invalido" | null;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "erro inesperado";
}

/**
 * Arquivo ausente e valido (comeca dos padroes). Arquivo vazio, truncado ou
 * com algo que nao e um objeto JSON cai nos padroes em vez de derrubar a
 * chamada: o config.json e regravavel e nao guarda nada que o programa nao
 * saiba refazer. Qualquer outra falha de leitura continua lancando, para uma
 * leitura que falhou de passagem nunca virar regravacao com os padroes.
 */
function readConfigFile(configPath: string): ConfigFileRead {
  let text: string;

  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { text: null, raw: {}, problem: null };
    }

    throw error;
  }

  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  if (content.trim() === "") {
    return { text, raw: {}, problem: "vazio" };
  }

  try {
    const value: unknown = JSON.parse(content);

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { text, raw: value as RawConfig, problem: null };
    }
  } catch {
    // cai no retorno abaixo
  }

  return { text, raw: {}, problem: "com JSON invalido" };
}

export function loadAppConfig(): AppConfig {
  const paths = getAppPaths();
  ensureAppDirectories(paths);

  const file = readConfigFile(paths.configPath);
  const rawConfig = file.raw;

  const parsed = fileSchema.parse({
    ...rawConfig,
    host: process.env.WA_CONTROL_HOST ?? rawConfig.host,
    port: process.env.WA_CONTROL_PORT ?? rawConfig.port,
    logLevel: process.env.WA_CONTROL_LOG_LEVEL ?? rawConfig.logLevel
  });

  const config: AppConfig = {
    ...parsed,
    paths
  };

  const logger = createLogger(parsed);
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;

  if (file.problem) {
    logger.warn(`config.json ${file.problem}: usando os padroes e regravando o arquivo`, {
      path: paths.configPath
    });
  }

  // O config.json e consultado em toda chamada (inclusive na sonda do status), entao
  // so e gravado quando o conteudo muda, e sempre por troca atomica: uma chamada
  // morta no meio da gravacao nunca mais deixa o arquivo vazio. Falha ao gravar nao
  // derruba o comando: os valores ja estao resolvidos em memoria.
  if (file.text !== serialized) {
    try {
      writeFileAtomically(paths.configPath, serialized);
    } catch (error) {
      logger.warn("nao foi possivel gravar o config.json; seguindo com os valores em memoria", {
        path: paths.configPath,
        error: errorMessage(error)
      });
    }
  }

  return config;
}
