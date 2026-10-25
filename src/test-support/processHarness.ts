import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "../daemon/daemonGuard.ts";

export const MAIN_PATH = join(import.meta.dir, "..", "main.ts");
export const GUARD_PATH = join(import.meta.dir, "..", "daemon", "daemonGuard.ts");

/**
 * Todo processo de teste roda com diretorio de dados temporario e porta de
 * teste: nada aqui le ou escreve no diretorio real do operador nem usa a porta
 * padrao 43119. O prefixo do diretorio contem "wa-control" de proposito: a
 * guarda reconhece o processo como wa-control pela linha de comando, e os
 * fixtures de teste moram dentro dele.
 */
export interface TestEnvironment {
  dataDir: string;
  port: number;
}

const tempDirs: string[] = [];
const spawned: Bun.Subprocess[] = [];

export function createTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wa-control-test-"));
  tempDirs.push(dir);
  return dir;
}

export async function findFreePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const { port } = probe;
  await probe.stop(true);

  if (port === undefined || port === 43119) {
    throw new Error("nao foi possivel reservar uma porta de teste");
  }

  return port;
}

export async function createTestEnvironment(): Promise<TestEnvironment> {
  return { dataDir: createTempDataDir(), port: await findFreePort() };
}

function childEnv(environment: TestEnvironment): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("WA_CONTROL_")) {
      env[key] = value;
    }
  }

  env.WA_CONTROL_DATA_DIR = environment.dataDir;
  env.WA_CONTROL_PORT = String(environment.port);
  return env;
}

export function spawnCli(args: string[], environment: TestEnvironment): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const child = Bun.spawn(["bun", "run", MAIN_PATH, ...args], {
    env: childEnv(environment),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  spawned.push(child);
  return child;
}

export function spawnScript(
  scriptPath: string,
  args: string[],
  environment: TestEnvironment
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const child = Bun.spawn(["bun", scriptPath, ...args], {
    env: childEnv(environment),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  spawned.push(child);
  return child;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

export async function collect(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<CliResult> {
  const started = performance.now();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);

  return { exitCode, stdout, stderr, elapsedMs: performance.now() - started };
}

export async function runCli(args: string[], environment: TestEnvironment): Promise<CliResult> {
  const started = performance.now();
  const result = await collect(spawnCli(args, environment));
  return { ...result, elapsedMs: performance.now() - started };
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }

    await Bun.sleep(intervalMs);
  }

  return condition();
}

export async function isHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function canConnect(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };

    socket.on("connect", () => settle(true));
    socket.on("error", () => settle(false));
    setTimeout(() => settle(false), 500).unref?.();
  });
}

export function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  return waitFor(() => isHealthy(port), timeoutMs, 100);
}

/**
 * Encerra somente os processos que o proprio teste iniciou, pelo pid, e remove
 * os diretorios temporarios.
 */
export async function cleanupProcessHarness(): Promise<void> {
  for (const child of spawned.splice(0, spawned.length)) {
    if (isProcessAlive(child.pid)) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }

  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
