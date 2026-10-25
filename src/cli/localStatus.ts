import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { loadAppConfig } from "../config/config.ts";
import { readLocalToken } from "../config/token.ts";
import {
  decideSingleInstanceAction,
  inspectProcess,
  readRuntimeFile as readRuntimeRecord
} from "../daemon/daemonGuard.ts";
import { isAppError } from "../shared/errors.ts";
import type { LocalApiClient } from "../shared/localApiClient.ts";
import { openDatabase } from "../storage/db.ts";
import { EventsRepo } from "../storage/eventsRepo.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import { WebhooksRepo } from "../storage/webhooksRepo.ts";
import type { AppConfig, SessionRecord, StatusResponse } from "../shared/types.ts";

/**
 * O status inteiro responde em menos de 3s (orcamento do vigia do Studio). A
 * sondagem da API local e a leitura do banco ficam bem abaixo disso, somadas
 * ao tempo de partida do processo.
 */
export const STATUS_PROBE_TIMEOUT_MS = 800;
export const STATUS_DATABASE_BUSY_TIMEOUT_MS = 500;

const runtimeFileSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string(),
  host: z.string(),
  port: z.number().int().positive()
});

export interface OfflineStatusSnapshot {
  daemon: {
    online: false;
    host: string;
    port: number;
    runtimeFilePresent: boolean;
    stalePid: number | null;
    tokenPresent: boolean;
  };
  sessions: SessionRecord[];
  eventCount: number;
  webhookCount: number;
}

function readRuntimeFile(path: string): z.infer<typeof runtimeFileSchema> | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return runtimeFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readOfflineStatusSnapshot(config: AppConfig = loadAppConfig()): OfflineStatusSnapshot {
  const runtime = readRuntimeFile(config.paths.runtimePath);
  const tokenPresent = Boolean(readLocalToken(config));

  let sessions: SessionRecord[] = [];
  let eventCount = 0;
  let webhookCount = 0;

  if (existsSync(config.paths.databasePath)) {
    try {
      const db = openDatabase(config.paths.databasePath, {
        busyTimeoutMs: STATUS_DATABASE_BUSY_TIMEOUT_MS
      });

      try {
        sessions = new SessionsRepo(db).list();
        eventCount = new EventsRepo(db).count();
        webhookCount = new WebhooksRepo(db).count();
      } finally {
        db.close();
      }
    } catch (error) {
      console.error(
        `status: banco indisponivel para o retrato offline (${error instanceof Error ? error.message : "erro inesperado"})`
      );
    }
  }

  return {
    daemon: {
      online: false,
      host: config.host,
      port: config.port,
      runtimeFilePresent: Boolean(runtime),
      stalePid: runtime && !isPidAlive(runtime.pid) ? runtime.pid : null,
      tokenPresent
    },
    sessions,
    eventCount,
    webhookCount
  };
}

export type LiveStatusReport = StatusResponse & { running: true; processAlive: true };
export type OfflineStatusReport = OfflineStatusSnapshot & { running: false; processAlive: boolean };
export type StatusReport = LiveStatusReport | OfflineStatusReport;

/**
 * O pid do runtime.json existe e e do wa-control: a mesma verificacao de
 * identidade da guarda de instancia unica, entao um pid reusado por outro
 * processo (ou um registro ausente, corrompido ou morto) nao conta como vivo.
 */
export function readProcessAlive(config: AppConfig): boolean {
  const record = readRuntimeRecord(config.paths.runtimePath);

  if (record.status !== "readable") {
    return false;
  }

  return (
    decideSingleInstanceAction(record.file, inspectProcess(record.file.pid)).action === "refuse"
  );
}

const EXPECTED_OFFLINE_CODES = new Set(["DAEMON_UNAVAILABLE", "TOKEN_NOT_FOUND"]);

type StatusProbe = Pick<LocalApiClient, "status" | "probeDaemonGate">;

/**
 * Sempre devolve um retrato: `running` diz que o daemon respondeu a API local
 * nesta chamada e `processAlive` que o processo do registro de partida existe,
 * respondendo ou nao. Qualquer falha do cliente (inclusive tempo esgotado com o
 * daemon vivo e mudo) cai no retrato offline, para a saida continuar sendo JSON.
 */
export async function collectStatusReport(
  client: StatusProbe,
  config: AppConfig = loadAppConfig()
): Promise<StatusReport> {
  let live: StatusResponse | null = null;

  try {
    if ((await client.probeDaemonGate()) === "open") {
      live = await client.status();
    }
  } catch (error) {
    if (!isAppError(error) || !EXPECTED_OFFLINE_CODES.has(error.code)) {
      console.error(
        `status: falha inesperada ao consultar o daemon local (${error instanceof Error ? error.message : "erro inesperado"})`
      );
    }
  }

  if (live) {
    return { running: true, processAlive: true, ...live };
  }

  return offlineReport(config);
}

function offlineReport(config: AppConfig): OfflineStatusReport {
  return {
    running: false,
    processAlive: readProcessAlive(config),
    ...readOfflineStatusSnapshot(config)
  };
}
