import { randomUUID } from "node:crypto";
import {
  linkSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  closeSync
} from "node:fs";
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

/**
 * Registro de partida completo, como gravado em runtime.json. Campos novos so
 * podem ser acrescentados: o schema do 0.7.0 ignora campos extras, entao o
 * arquivo continua legivel ao voltar para um runtime antigo.
 */
export interface RuntimeFileRecord {
  pid: number;
  startedAt: string;
  host: string;
  port: number;
  version: string;
  executable: string;
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

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function serializeRuntimeRecord(record: RuntimeFileRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Criacao exclusiva sem publicacao atomica, para sistemas de arquivos que nao
 * suportam link duro. Garante a exclusividade (falha com EEXIST), mas um leitor
 * concorrente pode enxergar o arquivo ainda vazio.
 */
export function createFileExclusivelyWithoutLink(targetPath: string, body: string): boolean {
  let descriptor: number;

  try {
    descriptor = openSync(targetPath, "wx");
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return false;
    }

    throw error;
  }

  try {
    writeSync(descriptor, body);
  } finally {
    closeSync(descriptor);
  }

  return true;
}

/**
 * Criacao exclusiva e atomica: o conteudo completo e gravado num arquivo
 * temporario e publicado por link duro, que falha com EEXIST quando o destino
 * ja existe. Nenhum leitor enxerga um arquivo vazio ou parcial. Retorna false
 * quando o destino ja existe.
 */
export function createFileExclusively(targetPath: string, body: string): boolean {
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, body, "utf8");

  try {
    linkSync(tempPath, targetPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return false;
    }

    return createFileExclusivelyWithoutLink(targetPath, body);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/**
 * Registro de partida exclusivo: cria o runtime.json somente se ele nao
 * existir. Dois processos simultaneos nunca ganham os dois, e a guarda de
 * outra partida nunca le um registro vazio ou parcial e o trata como
 * corrompido. Retorna false quando outra partida ja detem o registro.
 */
export function claimRuntimeFile(runtimePath: string, record: RuntimeFileRecord): boolean {
  return createFileExclusively(runtimePath, serializeRuntimeRecord(record));
}

/**
 * Atualiza o runtime.json por substituicao atomica (rename sobre o destino):
 * quem le durante a atualizacao ve o registro antigo ou o novo, nunca um
 * arquivo truncado.
 */
export function writeRuntimeFileAtomically(runtimePath: string, record: RuntimeFileRecord): void {
  const body = serializeRuntimeRecord(record);
  const tempPath = `${runtimePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, body, "utf8");

  try {
    renameSync(tempPath, runtimePath);
  } catch {
    // o Windows pode recusar o rename sobre um arquivo aberto por outro processo:
    // cai na escrita direta de antes em vez de abortar a partida
    writeFileSync(runtimePath, body, "utf8");
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/**
 * Devolve o registro de partida deste processo: remove o runtime.json somente
 * se o pid gravado for o informado, nunca o registro de outra partida.
 */
export function releaseRuntimeFile(runtimePath: string, pid: number): void {
  const current = readRuntimeFile(runtimePath);

  if (current.status === "readable" && current.file.pid === pid) {
    rmSync(runtimePath, { force: true });
  }
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

  lines.push(
    `Para encerrar a instancia antiga: \`wa daemon stop\` (ou, se ele nao resolver, kill ${file.pid}).`
  );
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

const CLAIM_ATTEMPTS = 3;

export interface RuntimeLockOptions {
  waitMs?: number;
  staleAfterMs?: number;
}

const DEFAULT_LOCK_WAIT_MS = 3_000;
const DEFAULT_LOCK_STALE_AFTER_MS = 5_000;
const LOCK_POLL_MS = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isOlderThan(path: string, ageMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > ageMs;
  } catch {
    return false;
  }
}

/**
 * Trava curta (runtime.json.lock, criada de forma exclusiva) que serializa a
 * secao critica de uma partida: avaliar a guarda, limpar um registro velho e
 * criar o registro novo. Sem ela, duas partidas que leem o mesmo registro
 * velho podem, uma depois da outra, apagar o registro recem-criado da outra.
 * A secao dura microssegundos; uma trava mais velha que `staleAfterMs` e de um
 * processo que morreu dentro dela e e removida.
 */
function withRuntimeLock<T>(
  runtimePath: string,
  options: RuntimeLockOptions,
  action: () => T
): T {
  const lockPath = `${runtimePath}.lock`;
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;
  const deadline = Date.now() + waitMs;

  while (!createFileExclusively(lockPath, `${process.pid}\n`)) {
    if (isOlderThan(lockPath, staleAfterMs)) {
      rmSync(lockPath, { force: true });
      continue;
    }

    if (Date.now() >= deadline) {
      throw new AppError(
        "DAEMON_ALREADY_RUNNING",
        409,
        "Outra partida do daemon esta em andamento neste diretorio de dados (runtime.json.lock). Start recusado: duas instancias no mesmo diretorio de dados causam `database is locked` e disputa de sessao do WhatsApp."
      );
    }

    sleepSync(LOCK_POLL_MS);
  }

  try {
    return action();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/**
 * Registro de partida deste processo: avalia a guarda e cria o runtime.json de
 * forma exclusiva logo em seguida, antes de abrir o banco, tudo sob a trava de
 * partida. Registro vivo recusa com a recusa da guarda; registro com pid morto
 * ou corrompido e limpo e a partida segue. Perder a criacao para uma partida
 * que nao respeita a trava (um 0.7.0) recusa pela guarda ou tenta de novo.
 */
export function acquireRuntimeFile(
  config: AppConfig,
  logger: Logger,
  record: RuntimeFileRecord,
  lockOptions: RuntimeLockOptions = {}
): void {
  withRuntimeLock(config.paths.runtimePath, lockOptions, () => {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      enforceSingleInstance(config, logger);

      if (claimRuntimeFile(config.paths.runtimePath, record)) {
        return;
      }
    }

    throw new AppError(
      "DAEMON_ALREADY_RUNNING",
      409,
      "Outra partida disputou o runtime.json deste diretorio de dados e nao foi possivel assumir o registro. Start recusado: duas instancias no mesmo diretorio de dados causam `database is locked` e disputa de sessao do WhatsApp."
    );
  });
}
