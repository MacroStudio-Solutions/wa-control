import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "../daemon/daemonGuard.ts";
import {
  type CliResult,
  type TestEnvironment,
  canConnect,
  cleanupProcessHarness,
  collect,
  createTestEnvironment,
  isHealthy,
  runCli,
  spawnCli,
  spawnScript,
  waitFor,
  waitForHealth
} from "../test-support/processHarness.ts";

afterEach(cleanupProcessHarness);

const STATUS_BUDGET_MS = 3_000;
const TOP_LEVEL_KEYS = ["running", "processAlive", "daemon", "sessions", "eventCount", "webhookCount"];
const OFFLINE_DAEMON_KEYS = ["online", "host", "port", "runtimeFilePresent", "stalePid", "tokenPresent"];
const LIVE_DAEMON_KEYS = ["pid", "startedAt", "host", "port", "version"];

const MUTE_SERVER = `
import { createServer } from "node:net";

const port = Number(process.argv[2]);
const server = createServer((socket) => {
  socket.on("error", () => {});
});
server.listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`;

const IDLE_PROCESS = `
setInterval(() => {}, 1000);
`;

function writeRuntimeFile(environment: TestEnvironment, pid: number): void {
  writeFileSync(
    join(environment.dataDir, "runtime.json"),
    JSON.stringify({
      pid,
      startedAt: "2026-10-24T20:00:00.000Z",
      host: "127.0.0.1",
      port: environment.port,
      version: "0.8.0-test",
      executable: process.execPath
    }),
    "utf8"
  );
}

function readRuntimePid(environment: TestEnvironment): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(environment.dataDir, "runtime.json"), "utf8"));
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function parseStatus(result: CliResult): Record<string, unknown> & {
  running: boolean;
  processAlive: boolean;
  daemon: Record<string, unknown>;
} {
  expect(result.exitCode).toBe(0);
  expect(result.elapsedMs).toBeLessThan(STATUS_BUDGET_MS);

  const parsed = JSON.parse(result.stdout);
  expect(typeof parsed).toBe("object");
  expect(Array.isArray(parsed)).toBe(false);
  return parsed;
}

async function spawnHelper(environment: TestEnvironment, name: string, source: string, args: string[]) {
  const scriptPath = join(environment.dataDir, name);
  writeFileSync(scriptPath, source, "utf8");
  return spawnScript(scriptPath, args, environment);
}

async function stopDaemon(child: ReturnType<typeof spawnCli>): Promise<number> {
  child.kill("SIGTERM");
  const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);

  if (exited === null) {
    throw new Error("o daemon nao parou por SIGTERM em 10s");
  }

  return exited;
}

describe("wa status --json em processo real", () => {
  it("nunca iniciado: false/false, um unico objeto JSON em menos de 3s", async () => {
    const environment = await createTestEnvironment();

    const status = parseStatus(await runCli(["status", "--json"], environment));

    expect(status.running).toBe(false);
    expect(status.processAlive).toBe(false);
    expect(Object.keys(status)).toEqual(TOP_LEVEL_KEYS);
    expect(Object.keys(status.daemon)).toEqual(OFFLINE_DAEMON_KEYS);
    expect(status.daemon).toMatchObject({
      online: false,
      port: environment.port,
      runtimeFilePresent: false,
      stalePid: null
    });
  });

  it("registro de uma partida que morreu: false/false com o pid velho em stalePid", async () => {
    const environment = await createTestEnvironment();
    const dead = Bun.spawn(["bun", "-e", "process.exit(0)"]);
    await dead.exited;
    writeRuntimeFile(environment, dead.pid);

    const status = parseStatus(await runCli(["status", "--json"], environment));

    expect(status.running).toBe(false);
    expect(status.processAlive).toBe(false);
    expect(status.daemon).toMatchObject({ online: false, runtimeFilePresent: true, stalePid: dead.pid });
  });

  it("processo vivo ainda iniciando (porta fechada): false/true com o retrato offline", async () => {
    const environment = await createTestEnvironment();
    const starting = await spawnHelper(environment, "starting-fixture.ts", IDLE_PROCESS, []);
    writeRuntimeFile(environment, starting.pid);

    const status = parseStatus(await runCli(["status", "--json"], environment));

    expect(status.running).toBe(false);
    expect(status.processAlive).toBe(true);
    expect(Object.keys(status)).toEqual(TOP_LEVEL_KEYS);
    expect(Object.keys(status.daemon)).toEqual(OFFLINE_DAEMON_KEYS);
    expect(status.daemon).toMatchObject({ online: false, runtimeFilePresent: true, stalePid: null });
  });

  it("CA-12: processo que segura a porta sem responder: false/true dentro de 3s, sem erro nem saida fora do JSON", async () => {
    const environment = await createTestEnvironment();
    writeFileSync(join(environment.dataDir, "token"), "token-de-teste\n", "utf8");
    const mute = await spawnHelper(environment, "mute-server.ts", MUTE_SERVER, [String(environment.port)]);
    expect(await waitFor(() => canConnect(environment.port), 10_000)).toBe(true);
    writeRuntimeFile(environment, mute.pid);

    const result = await runCli(["status", "--json"], environment);
    const status = parseStatus(result);

    expect(status.running).toBe(false);
    expect(status.processAlive).toBe(true);
    expect(Object.keys(status)).toEqual(TOP_LEVEL_KEYS);
    expect(Object.keys(status.daemon)).toEqual(OFFLINE_DAEMON_KEYS);
    expect(status.daemon).toMatchObject({ online: false, runtimeFilePresent: true, tokenPresent: true });
    expect(result.stderr).toBe("");
  });

  it("CA-12 em texto: o daemon vivo e mudo aparece como processo vivo sem responder", async () => {
    const environment = await createTestEnvironment();
    writeFileSync(join(environment.dataDir, "token"), "token-de-teste\n", "utf8");
    const mute = await spawnHelper(environment, "mute-server.ts", MUTE_SERVER, [String(environment.port)]);
    expect(await waitFor(() => canConnect(environment.port), 10_000)).toBe(true);
    writeRuntimeFile(environment, mute.pid);

    const result = await runCli(["status"], environment);

    expect(result.exitCode).toBe(0);
    expect(result.elapsedMs).toBeLessThan(STATUS_BUDGET_MS);
    expect(result.stdout).toContain("daemon: offline");
    expect(result.stdout).toContain("process: alive (not responding)");
  });
});

describe("wa daemon start em primeiro plano", () => {
  it("INV-03 e CA-07: sobe, responde /health, status devolve true/true e para por SIGTERM", async () => {
    const environment = await createTestEnvironment();
    const daemon = spawnCli(["daemon", "start"], environment);

    expect(await waitForHealth(environment.port, 20_000)).toBe(true);
    expect(readRuntimePid(environment)).toBe(daemon.pid);

    const status = parseStatus(await runCli(["status", "--json"], environment));
    expect(status.running).toBe(true);
    expect(status.processAlive).toBe(true);
    expect(Object.keys(status)).toEqual(TOP_LEVEL_KEYS);
    expect(Object.keys(status.daemon)).toEqual(LIVE_DAEMON_KEYS);
    expect(status.daemon).toMatchObject({ pid: daemon.pid, port: environment.port });
    expect(typeof status.sessions).toBe("object");
    expect(typeof status.eventCount).toBe("number");
    expect(typeof status.webhookCount).toBe("number");

    const second = await collect(spawnCli(["daemon", "start"], environment));
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("Ja existe um daemon wa-control ativo");
    expect(readRuntimePid(environment)).toBe(daemon.pid);

    if (process.platform === "win32") {
      daemon.kill();
      await daemon.exited;
      return;
    }

    expect(await stopDaemon(daemon)).toBe(0);
    expect(existsSync(join(environment.dataDir, "runtime.json"))).toBe(false);
    expect(await isHealthy(environment.port)).toBe(false);
  }, 60_000);

  it("INV-01: quatro partidas simultaneas no mesmo diretorio terminam com um processo vivo e tres recusas", async () => {
    const environment = await createTestEnvironment();
    const starters = Array.from({ length: 4 }, () => spawnCli(["daemon", "start"], environment));

    expect(
      await waitFor(() => starters.filter((starter) => starter.exitCode !== null).length === 3, 30_000)
    ).toBe(true);

    const survivors = starters.filter((starter) => starter.exitCode === null);
    expect(survivors).toHaveLength(1);
    const survivor = survivors[0]!;
    expect(await waitForHealth(environment.port, 20_000)).toBe(true);
    expect(readRuntimePid(environment)).toBe(survivor.pid);

    const refused = starters.filter((starter) => starter !== survivor);
    for (const starter of refused) {
      const result = await collect(starter);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(
        /Ja existe um daemon wa-control ativo|Daemon ja esta rodando|Outra partida/
      );
    }

    expect(starters.filter((starter) => isProcessAlive(starter.pid))).toHaveLength(1);

    if (process.platform === "win32") {
      survivor.kill();
      await survivor.exited;
      return;
    }

    expect(await stopDaemon(survivor)).toBe(0);
    expect(existsSync(join(environment.dataDir, "runtime.json"))).toBe(false);
  }, 90_000);
});
