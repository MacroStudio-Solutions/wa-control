import { readFileSync } from "node:fs";
import { readLocalToken } from "../config/token.ts";
import { probeTcpGate } from "../shared/localApiClient.ts";
import type { AppConfig, HealthResponse } from "../shared/types.ts";
import {
  decideSingleInstanceAction,
  inspectProcess,
  readRuntimeFile,
  releaseRuntimeFile,
  type RuntimeFilePayload
} from "./daemonGuard.ts";
import {
  DETACHED_ENV,
  appendDaemonLog,
  closeQuietly,
  daemonLogPath,
  daemonLogSize,
  openDaemonLogForAppend,
  readDaemonLogSince,
  truncateDetail
} from "./daemonLog.ts";
import type { DetachedChild } from "./windowsSpawn.ts";

/**
 * O Studio espera 8s pela resposta da partida destacada; o verbo responde um
 * pouco antes, com o que souber, para a resposta chegar sempre inteira.
 */
export const START_READY_BUDGET_MS = 7_000;

/** O mesmo orcamento que o Studio passa ao fechar. */
export const DEFAULT_STOP_WAIT_MS = 7_500;

const READY_POLL_MS = 100;
const HEALTH_TIMEOUT_MS = 800;
const GATE_TIMEOUT_MS = 200;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 800;
const DEATH_POLL_MS = 50;

export type StartBackgroundResult =
  | { ok: true; ready: boolean }
  | { ok: false; detail: string };

export type StopResult =
  | { ok: true; stopped: true; alreadyStopped: true }
  | {
      ok: true;
      stopped: true;
      alreadyStopped: false;
      graceful: boolean;
      pid: number;
      elapsedMs: number;
    }
  | { ok: false; detail: string };

function isCompiledBinary(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.includes("$bunfs") || entry.includes("~BUN");
}

/**
 * Linha de comando que reexecuta este mesmo programa: o proprio binario
 * compilado, ou o interpretador seguido do script quando roda do codigo-fonte.
 */
export function selfCommand(args: string[]): string[] {
  if (isCompiledBinary()) {
    return [process.execPath, ...args];
  }

  return [process.execPath, process.argv[1] ?? "", ...args];
}

function describeLiveDaemon(file: RuntimeFilePayload): string {
  return `Ja existe um daemon wa-control ativo para este diretorio de dados (pid ${file.pid}, porta ${file.port ?? "desconhecida"}).`;
}

function findLiveRegisteredDaemon(config: AppConfig): RuntimeFilePayload | null {
  const record = readRuntimeFile(config.paths.runtimePath);

  if (record.status !== "readable") {
    return null;
  }

  const decision = decideSingleInstanceAction(record.file, inspectProcess(record.file.pid));
  return decision.action === "refuse" ? record.file : null;
}

async function readHealth(
  host: string,
  port: number,
  deadline: number
): Promise<HealthResponse | null> {
  const remaining = () => Math.max(50, deadline - Date.now());

  if ((await probeTcpGate(host, port, Math.min(GATE_TIMEOUT_MS, remaining()))) === "closed") {
    return null;
  }

  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(Math.min(HEALTH_TIMEOUT_MS, remaining()))
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as HealthResponse;
  } catch {
    return null;
  }
}

/**
 * Motivo da morte de um filho recem-partido: a linha estruturada que o proprio
 * filho escreve no daemon.log (`daemon nao iniciou`, com o pid dele), ou, sem
 * ela, o fim do que o log recebeu desde a partida.
 */
export function describeStartFailure(
  logText: string,
  childPid: number,
  exitCode: number | null
): string {
  const lines = logText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of [...lines].reverse()) {
    const marker = line.indexOf(" ERROR daemon nao iniciou ");
    if (marker === -1) {
      continue;
    }

    try {
      const parsed = JSON.parse(line.slice(line.indexOf("{", marker))) as {
        pid?: number;
        motivo?: string;
      };

      if (parsed.pid === childPid && typeof parsed.motivo === "string" && parsed.motivo) {
        return truncateDetail(parsed.motivo);
      }
    } catch {
      // linha ilegivel: cai no fim do log
    }
  }

  const tail = lines.filter((line) => !line.startsWith("=== ")).slice(-3);

  if (tail.length > 0) {
    return truncateDetail(tail.join(" | "));
  }

  return `O processo do daemon encerrou (codigo ${exitCode ?? "desconhecido"}) sem escrever no daemon.log.`;
}

function spawnDetachedPosix(config: AppConfig): DetachedChild {
  const logDescriptor = openDaemonLogForAppend(config);

  try {
    const child = Bun.spawn(selfCommand(["daemon", "start"]), {
      stdin: "ignore",
      stdout: logDescriptor,
      stderr: logDescriptor,
      env: { ...process.env, [DETACHED_ENV]: "1" },
      detached: true,
      windowsHide: true
    });
    let exitCode: number | null = null;
    void child.exited.then((code) => {
      exitCode = code;
    });

    return {
      pid: child.pid,
      exitCode: () => exitCode,
      release: () => child.unref()
    };
  } finally {
    closeQuietly(logDescriptor);
  }
}

/**
 * No Windows o filho nasce por CreateProcessW com lista explicita de handles
 * (ver windowsSpawn.ts). Se o FFI nao estiver disponivel, cai no spawn comum do
 * Bun e registra o aviso no daemon.log: o daemon sobe, mas pode segurar aberto o
 * pipe de stdout de quem chamou o verbo.
 */
async function spawnDetachedDaemon(config: AppConfig): Promise<DetachedChild> {
  if (process.platform !== "win32") {
    return spawnDetachedPosix(config);
  }

  try {
    const { spawnDetachedWindows } = await import("./windowsSpawn.ts");
    return await spawnDetachedWindows({
      command: selfCommand(["daemon", "start"]),
      env: { ...process.env, [DETACHED_ENV]: "1" } as Record<string, string>,
      logPath: daemonLogPath(config)
    });
  } catch (error) {
    appendDaemonLog(config, "warn", "partida destacada pelo caminho alternativo do Windows", {
      motivo: error instanceof Error ? error.message : "erro inesperado"
    });
    return spawnDetachedPosix(config);
  }
}

/**
 * `daemon start --background`: reexecuta o proprio programa em `daemon start`,
 * destacado deste processo, com a saida acrescentada ao daemon.log. Espera o
 * `/health` DESTE filho responder (pid conferido: um daemon de outra partida
 * respondendo nao conta), o filho morrer ou o orcamento acabar.
 */
export async function startDaemonInBackground(
  config: AppConfig,
  budgetMs: number = START_READY_BUDGET_MS
): Promise<StartBackgroundResult> {
  const live = findLiveRegisteredDaemon(config);

  if (live) {
    return { ok: false, detail: describeLiveDaemon(live) };
  }

  const logOffset = daemonLogSize(config);
  let child: DetachedChild;

  try {
    child = await spawnDetachedDaemon(config);
  } catch (error) {
    return {
      ok: false,
      detail: truncateDetail(
        `Nao foi possivel iniciar o processo do daemon: ${error instanceof Error ? error.message : "erro inesperado"}`
      )
    };
  }

  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    if (child.exitCode() !== null) {
      break;
    }

    const health = await readHealth(config.host, config.port, deadline);

    if (health?.daemon.pid === child.pid) {
      child.release();
      return { ok: true, ready: true };
    }

    await Bun.sleep(READY_POLL_MS);
  }

  const exitCode = child.exitCode();

  if (exitCode !== null) {
    child.release();
    return {
      ok: false,
      detail: describeStartFailure(readDaemonLogSince(config, logOffset), child.pid, exitCode)
    };
  }

  child.release();
  return { ok: true, ready: false };
}

function isZombie(pid: number): boolean {
  if (process.platform !== "linux") {
    return false;
  }

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return false;
  }
}

/**
 * O processo ainda e o daemon: vivo, nao zumbi e nao um pid reaproveitado por
 * outro programa (identidade "other"). Identidade que a plataforma nao consegue
 * ler (Windows) conta como o daemon, como na guarda de partida.
 */
function isDaemonProcessAlive(pid: number): boolean {
  const identity = inspectProcess(pid);
  return identity.alive && identity.classification !== "other" && !isZombie(pid);
}

type ShutdownRequestOutcome = "accepted" | "rejected" | "closed" | "silent";

async function requestShutdown(
  host: string,
  port: number,
  token: string,
  timeoutMs: number
): Promise<ShutdownRequestOutcome> {
  if ((await probeTcpGate(host, port, GATE_TIMEOUT_MS)) === "closed") {
    return "closed";
  }

  try {
    const response = await fetch(`http://${host}:${port}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(Math.max(1, timeoutMs))
    });

    return response.ok ? "accepted" : "rejected";
  } catch {
    return "silent";
  }
}

async function waitForDeath(pid: number, untilMs: number): Promise<boolean> {
  while (isDaemonProcessAlive(pid)) {
    if (Date.now() >= untilMs) {
      return false;
    }

    await Bun.sleep(DEATH_POLL_MS);
  }

  return true;
}

export interface StopOptions {
  waitMs?: number;
}

/**
 * Janela reservada, dentro de `waitMs`, para forcar e confirmar a morte: o
 * orcamento do Studio e o do verbo inteiro, nao so o da espera graciosa.
 */
export function forceReserveMs(waitMs: number): number {
  return Math.min(1_500, Math.max(400, Math.floor(waitMs * 0.2)));
}

async function forceStop(pid: number, reserveMs: number): Promise<"SIGTERM" | "SIGKILL" | "TerminateProcess" | null> {
  const deadline = Date.now() + reserveMs;

  try {
    if (process.platform === "win32") {
      process.kill(pid);
      return (await waitForDeath(pid, deadline)) ? "TerminateProcess" : null;
    }

    process.kill(pid, "SIGTERM");
    if (await waitForDeath(pid, Date.now() + Math.floor(reserveMs / 2))) {
      return "SIGTERM";
    }

    process.kill(pid, "SIGKILL");
    return (await waitForDeath(pid, deadline)) ? "SIGKILL" : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return "SIGKILL";
    }

    return null;
  }
}

/**
 * `daemon stop`: sem processo vivo no registro de partida, ja estava parado.
 * Com processo vivo, pede `POST /shutdown` autenticado (a mesma parada
 * graciosa dos handlers de sinal) e espera a morte; sem token, com a API muda,
 * ou durante a partida (HTTP ainda fechado), o pedido e repetido ate o fim da
 * janela graciosa. Esgotada a janela, forca pelo pid do registro e so responde
 * com a morte confirmada.
 */
export async function stopDaemon(
  config: AppConfig,
  options: StopOptions = {}
): Promise<StopResult> {
  const waitMs = options.waitMs ?? DEFAULT_STOP_WAIT_MS;
  const target = findLiveRegisteredDaemon(config);

  if (!target) {
    return { ok: true, stopped: true, alreadyStopped: true };
  }

  const startedAt = Date.now();
  const reserveMs = forceReserveMs(waitMs);
  const gracefulUntil = startedAt + Math.max(0, waitMs - reserveMs);
  const host = target.host ?? config.host;
  const port = target.port ?? config.port;
  const token = readLocalToken(config);

  let shutdownAccepted = false;
  let canRequest = Boolean(token);
  let reason = token ? "porta-fechada" : "token-ausente";

  while (isDaemonProcessAlive(target.pid) && Date.now() < gracefulUntil) {
    if (canRequest && !shutdownAccepted && token) {
      const outcome = await requestShutdown(
        host,
        port,
        token,
        Math.min(SHUTDOWN_REQUEST_TIMEOUT_MS, gracefulUntil - Date.now())
      );

      if (outcome === "accepted") {
        shutdownAccepted = true;
      } else if (outcome === "rejected") {
        canRequest = false;
        reason = "endpoint-recusou";
      } else {
        reason = outcome === "silent" ? "api-muda" : "porta-fechada";
      }
    }

    await Bun.sleep(DEATH_POLL_MS);
  }

  if (!isDaemonProcessAlive(target.pid)) {
    releaseRuntimeFile(config.paths.runtimePath, target.pid);
    const elapsedMs = Date.now() - startedAt;
    appendDaemonLog(config, "info", "parada graciosa confirmada", {
      pid: target.pid,
      pedidoHttp: shutdownAccepted,
      ms: elapsedMs
    });
    return {
      ok: true,
      stopped: true,
      alreadyStopped: false,
      graceful: true,
      pid: target.pid,
      elapsedMs
    };
  }

  if (shutdownAccepted) {
    reason = "pedido-aceito-sem-encerrar";
  }

  const signal = await forceStop(target.pid, reserveMs);
  const elapsedMs = Date.now() - startedAt;

  if (!signal) {
    return {
      ok: false,
      detail: `Nao foi possivel confirmar a morte do processo ${target.pid} do daemon depois de ${waitMs} ms.`
    };
  }

  releaseRuntimeFile(config.paths.runtimePath, target.pid);
  appendDaemonLog(config, "warn", "parada forcada", {
    pid: target.pid,
    motivo: reason,
    sinal: signal,
    ms: elapsedMs
  });

  return {
    ok: true,
    stopped: true,
    alreadyStopped: false,
    graceful: false,
    pid: target.pid,
    elapsedMs
  };
}
