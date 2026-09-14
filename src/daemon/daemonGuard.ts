import { readFileSync, readlinkSync, rmSync } from "node:fs";
import { AppError } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type { AppConfig } from "../shared/types.ts";

const DELETED_SUFFIX = " (deleted)";
const WA_BINARY_NAMES = new Set(["wa", "wa.exe", "wa-control", "wa-control.exe"]);

/**
 * Conteudo do runtime.json: o pid e obrigatorio; os demais campos sao
 * opcionais para ler tanto o formato legado (pid/startedAt/host/port) quanto
 * os formatos futuros que adicionarem campos novos (version, executable).
 */
export interface RuntimeFilePayload {
  pid: number;
  startedAt?: string;
  host?: string;
  port?: number;
  version?: string;
}

export type RuntimeFileRead =
  | { status: "missing" }
  | { status: "corrupt" }
  | { status: "readable"; file: RuntimeFilePayload };

export function readRuntimeFile(runtimePath: string): RuntimeFileRead {
  let raw: string;
  try {
    raw = readFileSync(runtimePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing" }
      : { status: "corrupt" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupt" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { status: "corrupt" };
  }

  const record = parsed as Record<string, unknown>;
  const { pid } = record;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { status: "corrupt" };
  }

  const file: RuntimeFilePayload = { pid };
  if (typeof record.startedAt === "string") {
    file.startedAt = record.startedAt;
  }
  if (typeof record.host === "string") {
    file.host = record.host;
  }
  if (typeof record.port === "number" && Number.isInteger(record.port) && record.port > 0) {
    file.port = record.port;
  }
  if (typeof record.version === "string") {
    file.version = record.version;
  }

  return { status: "readable", file };
}

export type ProcessClassification = "self" | "other" | "unknown";

export interface ProcessIdentity {
  pid: number;
  alive: boolean;
  classification: ProcessClassification;
  exePath: string | null;
  exeDeleted: boolean;
  cmdline: string | null;
}

/**
 * Deteccao de PID vivo via sinal 0 (multiplataforma, Windows incluido).
 * EPERM significa processo existente sem permissao de sinal: conservadoramente
 * vivo, porque a alternativa e apagar o registro de um daemon real.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function looksLikeWaControl(candidate: string): boolean {
  const normalized = candidate.toLowerCase();
  const base = normalized.split(/[\\/]/).pop() ?? normalized;
  return WA_BINARY_NAMES.has(base) || normalized.includes("wa-control");
}

/**
 * Inspecao best-effort do processo vivo, isolada por plataforma: a leitura de
 * /proc (exe e cmdline) e exclusiva de Linux; nas demais plataformas a
 * identidade permanece "unknown" sem falhar e o guard recusa de forma
 * conservadora. Nunca sinaliza nem mata o processo inspecionado.
 */
export function inspectProcess(pid: number): ProcessIdentity {
  const identity: ProcessIdentity = {
    pid,
    alive: isProcessAlive(pid),
    classification: "unknown",
    exePath: null,
    exeDeleted: false,
    cmdline: null
  };

  if (!identity.alive) {
    return identity;
  }

  if (process.platform === "linux") {
    try {
      const raw = readlinkSync(`/proc/${pid}/exe`);
      if (raw.endsWith(DELETED_SUFFIX)) {
        identity.exeDeleted = true;
        identity.exePath = raw.slice(0, raw.length - DELETED_SUFFIX.length);
      } else {
        identity.exePath = raw;
      }
    } catch {
      identity.exePath = null;
    }

    try {
      identity.cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean)
        .join(" ");
    } catch {
      identity.cmdline = null;
    }
  }

  const exeMatches = identity.exePath !== null && looksLikeWaControl(identity.exePath);
  const cmdlineMatches = identity.cmdline !== null && looksLikeWaControl(identity.cmdline);

  if (pid === process.pid || exeMatches || cmdlineMatches) {
    identity.classification = "self";
  } else if (identity.exePath !== null) {
    identity.classification = "other";
  }

  return identity;
}

export type SingleInstanceDecision =
  | { action: "proceed" }
  | { action: "proceed-cleanup"; reason: "stale-dead-pid" | "foreign-process"; warning: string }
  | { action: "refuse"; error: AppError };

function describeBinary(identity: ProcessIdentity): string {
  if (identity.exeDeleted) {
    return "deletado do disco (processo zumbi sobrevivendo em memoria)";
  }

  if (identity.exePath) {
    const divergent = identity.exePath !== process.execPath;
    return `${identity.exePath}${divergent ? " (diverge do binario atual)" : ""}`;
  }

  return "indisponivel para diagnostico nesta plataforma";
}

function buildAlreadyRunningError(file: RuntimeFilePayload, identity: ProcessIdentity): AppError {
  const lines = [
    "Ja existe um daemon wa-control ativo para este diretorio de dados (runtime.json registra o processo como vivo).",
    `- pid: ${file.pid}`,
    `- porta registrada: ${file.port ?? "desconhecida"}`,
    `- versao registrada: ${file.version ?? "desconhecida (arquivo sem versao)"}`,
    `- binario do processo vivo: ${describeBinary(identity)}`
  ];

  if (identity.classification === "unknown") {
    lines.push(
      `ATENCAO: nao foi possivel confirmar que o processo ${file.pid} e o wa-control (PID possivelmente reusado apos reboot). Confira antes de qualquer acao.`
    );
  }

  lines.push(`Para encerrar a instancia antiga: kill ${file.pid} (nao existe o comando \`wa daemon stop\`).`);
  lines.push(
    "Start recusado: duas instancias no mesmo diretorio de dados causam `database is locked` e disputa de sessao do WhatsApp."
  );

  return new AppError("DAEMON_ALREADY_RUNNING", 409, lines.join("\n"));
}

export function decideSingleInstanceAction(
  file: RuntimeFilePayload,
  identity: ProcessIdentity
): SingleInstanceDecision {
  if (!identity.alive) {
    return {
      action: "proceed-cleanup",
      reason: "stale-dead-pid",
      warning: `runtime.json aponta o PID ${file.pid}, que nao esta mais vivo; registro stale (crash ou kill -9) sera removido e o start prossegue`
    };
  }

  if (identity.classification === "other") {
    return {
      action: "proceed-cleanup",
      reason: "foreign-process",
      warning: `PID ${file.pid} do runtime.json foi reusado por outro processo (nao e o wa-control); registro stale sera removido e o start prossegue`
    };
  }

  return { action: "refuse", error: buildAlreadyRunningError(file, identity) };
}

/**
 * Guard de instancia unica por data dir: le o runtime.json ANTES de qualquer
 * remocao e decide entre prosseguir (arquivo ausente, corrupto, com PID morto
 * ou reusado por processo alheio — limpando o stale com aviso) ou recusar o
 * start (PID vivo do proprio wa-control, ou identidade indeterminavel). O
 * guard nunca mata processo: recusar e instruir e sempre a resposta; matar e
 * acao do operador.
 */
export function enforceSingleInstance(config: AppConfig, logger: Logger): void {
  const read = readRuntimeFile(config.paths.runtimePath);

  if (read.status === "missing") {
    return;
  }

  if (read.status === "corrupt") {
    logger.warn("runtime.json ilegivel ou corrompido; tratando como stale, removendo e prosseguindo", {
      runtimePath: config.paths.runtimePath
    });
    rmSync(config.paths.runtimePath, { force: true });
    return;
  }

  const decision = decideSingleInstanceAction(read.file, inspectProcess(read.file.pid));

  if (decision.action === "refuse") {
    throw decision.error;
  }

  if (decision.action === "proceed-cleanup") {
    logger.warn(decision.warning, { pid: read.file.pid, reason: decision.reason });
    rmSync(config.paths.runtimePath, { force: true });
  }
}
