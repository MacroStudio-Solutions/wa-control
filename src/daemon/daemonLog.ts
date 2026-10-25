import { appendFileSync, closeSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatLogLine, type Level } from "../shared/logger.ts";
import type { AppConfig } from "../shared/types.ts";

export const DETACHED_ENV = "WA_CONTROL_DETACHED";

const MAX_DETAIL_LENGTH = 400;

export function truncateDetail(text: string): string {
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 3)}...` : text;
}

/** Primeira linha de uma recusa, que e o motivo; o texto inteiro fica no log. */
export function firstLineOf(message: string): string {
  const line = message
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return truncateDetail(line ?? message.trim());
}

export function daemonLogPath(config: Pick<AppConfig, "paths">): string {
  return join(config.paths.rootDir, "daemon.log");
}

/**
 * Cabecalho de partida: uma linha por partida destacada, com data, versao, pid
 * e porta. O filho a escreve na propria saida, que ja e o daemon.log, antes de
 * qualquer recusa da guarda, entao uma partida recusada tambem deixa rastro.
 */
export function formatStartHeader(info: {
  startedAt: string;
  version: string;
  pid: number;
  port: number;
}): string {
  return `=== wa-control daemon | inicio ${info.startedAt} | versao ${info.version} | pid ${info.pid} | porta ${info.port} ===`;
}

/**
 * Acrescenta uma linha ao daemon.log sem nunca truncar nem reescrever o
 * arquivo. Falha de escrita no log nao pode derrubar um verbo.
 */
export function appendDaemonLog(
  config: Pick<AppConfig, "paths">,
  level: Level,
  message: string,
  details?: unknown
): void {
  try {
    appendFileSync(daemonLogPath(config), `${formatLogLine(level, message, details)}\n`, "utf8");
  } catch {
    // o log e diagnostico: sem ele o verbo ainda cumpre o contrato
  }
}

/**
 * Descritor aberto em modo de acrescimo (O_APPEND), entregue ao filho como
 * stdout e stderr: o que o daemon escrever vai sempre para o fim do arquivo.
 */
export function openDaemonLogForAppend(config: Pick<AppConfig, "paths">): number {
  return openSync(daemonLogPath(config), "a");
}

export function daemonLogSize(config: Pick<AppConfig, "paths">): number {
  try {
    return statSync(daemonLogPath(config)).size;
  } catch {
    return 0;
  }
}

export function readDaemonLogSince(config: Pick<AppConfig, "paths">, offset: number): string {
  try {
    const raw = readFileSync(daemonLogPath(config));
    return raw.subarray(Math.min(offset, raw.length)).toString("utf8");
  } catch {
    return "";
  }
}

export function closeQuietly(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // ja fechado
  }
}
