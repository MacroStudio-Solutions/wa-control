import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { forceReserveMs } from "../daemon/daemonControl.ts";
import { inspectProcess, isProcessAlive } from "../daemon/daemonGuard.ts";
import {
  type CliResult,
  type TestEnvironment,
  cleanupProcessHarness,
  canConnect,
  collect,
  createTestEnvironment,
  isHealthy,
  runCli,
  spawnCli,
  spawnScript,
  waitFor,
  waitForHealth
} from "../test-support/processHarness.ts";

const environments: TestEnvironment[] = [];

async function newEnvironment(): Promise<TestEnvironment> {
  const environment = await createTestEnvironment();
  environments.push(environment);
  return environment;
}

afterEach(async () => {
  for (const environment of environments.splice(0, environments.length)) {
    for (const pid of knownPids(environment)) {
      if (isProcessAlive(pid) && inspectProcess(pid).classification === "self") {
        process.kill(pid, "SIGKILL");
      }
    }
  }

  await cleanupProcessHarness();
});

const HEADER_PATTERN =
  /^=== wa-control daemon \| inicio (\S+) \| versao (\S+) \| pid (\d+) \| porta (\d+) ===$/;

const MUTE_SERVER = `
import { createServer } from "node:net";

const port = Number(process.argv[2]);
const server = createServer((socket) => {
  socket.on("error", () => {});
});
server.listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`;

const OLD_DAEMON_SERVER = `
const port = Number(process.argv[2]);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch() {
    return Response.json({ error: { code: "NOT_FOUND", message: "Rota nao encontrada." } }, { status: 404 });
  }
});
setInterval(() => {}, 1000);
`;

const IDLE_PROCESS = `
setInterval(() => {}, 1000);
`;

function dataPath(environment: TestEnvironment, name: string): string {
  return join(environment.dataDir, name);
}

function readLog(environment: TestEnvironment): string {
  return existsSync(dataPath(environment, "daemon.log"))
    ? readFileSync(dataPath(environment, "daemon.log"), "utf8")
    : "";
}

function headers(environment: TestEnvironment) {
  return readLog(environment)
    .split("\n")
    .map((line) => HEADER_PATTERN.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      startedAt: match[1] ?? "",
      version: match[2] ?? "",
      pid: Number(match[3]),
      port: Number(match[4])
    }));
}

function readRuntimePid(environment: TestEnvironment): number | null {
  try {
    const parsed = JSON.parse(readFileSync(dataPath(environment, "runtime.json"), "utf8"));
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function knownPids(environment: TestEnvironment): number[] {
  const pids = new Set<number>(headers(environment).map((header) => header.pid));
  const registered = readRuntimePid(environment);

  if (registered !== null) {
    pids.add(registered);
  }

  return [...pids];
}

function livePids(environment: TestEnvironment, extra: number[] = []): number[] {
  return [...new Set([...knownPids(environment), ...extra])].filter((pid) => isProcessAlive(pid));
}

function writeRuntimeFile(environment: TestEnvironment, pid: number): void {
  writeFileSync(
    dataPath(environment, "runtime.json"),
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

function writeToken(environment: TestEnvironment): void {
  writeFileSync(dataPath(environment, "token"), "token-de-teste\n", "utf8");
}

function parseJson<T>(result: CliResult): T {
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as T;
}

type StartAnswer = { ok: true; ready: boolean } | { ok: false; detail: string };
type StopAnswer =
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

async function startBackground(environment: TestEnvironment): Promise<StartAnswer> {
  return parseJson<StartAnswer>(await runCli(["daemon", "start", "--background", "--json"], environment));
}

async function stopVerb(environment: TestEnvironment, ...extra: string[]): Promise<StopAnswer> {
  return parseJson<StopAnswer>(await runCli(["daemon", "stop", "--json", ...extra], environment));
}

async function spawnFixture(
  environment: TestEnvironment,
  name: string,
  source: string,
  args: string[] = []
) {
  const scriptPath = dataPath(environment, name);
  writeFileSync(scriptPath, source, "utf8");
  return spawnScript(scriptPath, args, environment);
}

async function statusOf(environment: TestEnvironment): Promise<{ running: boolean; processAlive: boolean }> {
  const result = await runCli(["status", "--json"], environment);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as { running: boolean; processAlive: boolean };
}

async function expectDead(pid: number): Promise<void> {
  expect(await waitFor(() => !isProcessAlive(pid), 3_000)).toBe(true);
}

setDefaultTimeout(60_000);

describe("wa daemon start --background --json", () => {
  it("sobe destacado, responde ready:true com o /health e deixa um unico processo vivo", async () => {
    const environment = await newEnvironment();

    const started = performance.now();
    const answer = await startBackground(environment);
    const elapsedMs = performance.now() - started;

    expect(answer).toEqual({ ok: true, ready: true });
    expect(elapsedMs).toBeLessThan(7_000);
    expect(await isHealthy(environment.port)).toBe(true);

    const registered = readRuntimePid(environment);
    expect(registered).not.toBeNull();
    expect(isProcessAlive(registered ?? 0)).toBe(true);
    expect(livePids(environment)).toEqual([registered ?? 0]);

    expect(await statusOf(environment)).toMatchObject({ running: true, processAlive: true });
  });

  it("CA-08: o daemon.log recebe um cabecalho por partida com data, versao, pid e porta", async () => {
    const environment = await newEnvironment();

    expect(await startBackground(environment)).toEqual({ ok: true, ready: true });

    const [header, ...rest] = headers(environment);
    expect(rest).toHaveLength(0);
    expect(header?.version).toBe(pkg.version);
    expect(header?.port).toBe(environment.port);
    expect(header?.pid).toBe(readRuntimePid(environment) ?? -1);
    expect(Number.isNaN(Date.parse(header?.startedAt ?? ""))).toBe(false);
    expect(readLog(environment)).toContain("daemon iniciado");
  });

  it("segunda partida destacada sobre um daemon vivo recusa com ok:false e detail", async () => {
    const environment = await newEnvironment();
    expect(await startBackground(environment)).toEqual({ ok: true, ready: true });
    const pid = readRuntimePid(environment);

    const second = await startBackground(environment);

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.detail).toContain(String(pid));
    }
    expect(livePids(environment)).toEqual([pid ?? 0]);
    expect(readRuntimePid(environment)).toBe(pid);
  });

  it("registro com pid morto nao impede a partida destacada", async () => {
    const environment = await newEnvironment();
    const dead = Bun.spawn(["bun", "-e", "process.exit(0)"]);
    await dead.exited;
    writeRuntimeFile(environment, dead.pid);

    expect(await startBackground(environment)).toEqual({ ok: true, ready: true });
    expect(readRuntimePid(environment)).not.toBe(dead.pid);
  });

  it("quando o filho morre responde ok:false com o motivo, sem deixar registro nem processo", async () => {
    const environment = await newEnvironment();
    const occupant = Bun.serve({ hostname: "127.0.0.1", port: environment.port, fetch: () => new Response("") });

    try {
      const answer = await startBackground(environment);

      expect(answer.ok).toBe(false);
      if (!answer.ok) {
        expect(answer.detail.length).toBeGreaterThan(0);
        expect(answer.detail).toContain(String(environment.port));
      }
    } finally {
      await occupant.stop(true);
    }

    expect(existsSync(dataPath(environment, "runtime.json"))).toBe(false);
    expect(livePids(environment)).toEqual([]);
    expect(readLog(environment)).toContain("daemon nao iniciou");
  });

  it("CA-03: o daemon.log e acrescentado, nunca truncado, entre partidas", async () => {
    const environment = await newEnvironment();
    writeFileSync(dataPath(environment, "daemon.log"), "linha-anterior-ao-teste\n", "utf8");

    expect(await startBackground(environment)).toEqual({ ok: true, ready: true });
    expect(await stopVerb(environment)).toMatchObject({ ok: true, alreadyStopped: false });
    expect(await startBackground(environment)).toEqual({ ok: true, ready: true });
    expect(await stopVerb(environment)).toMatchObject({ ok: true, alreadyStopped: false });

    const log = readLog(environment);
    expect(log.startsWith("linha-anterior-ao-teste\n")).toBe(true);
    expect(headers(environment)).toHaveLength(2);
    expect(log.match(/parada graciosa confirmada/g)).toHaveLength(2);
  });
});

describe("CA-11: partidas simultaneas", () => {
  it("duas partidas destacadas em paralelo terminam com um processo vivo, um ok:true e um ok:false", async () => {
    const environment = await newEnvironment();

    const [first, second] = await Promise.all([
      runCli(["daemon", "start", "--background", "--json"], environment),
      runCli(["daemon", "start", "--background", "--json"], environment)
    ]);
    const answers = [parseJson<StartAnswer>(first), parseJson<StartAnswer>(second)];

    const accepted = answers.filter((answer) => answer.ok);
    const refused = answers.filter((answer) => !answer.ok);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toEqual({ ok: true, ready: true });
    expect(refused).toHaveLength(1);
    expect(refused[0]?.ok === false && refused[0].detail.length > 0).toBe(true);

    await waitFor(() => livePids(environment).length === 1, 5_000);
    expect(livePids(environment)).toEqual([readRuntimePid(environment) ?? -1]);
    expect(await isHealthy(environment.port)).toBe(true);
  });

  it("a corrida entre partida destacada e primeiro plano termina com uma recusa", async () => {
    const environment = await newEnvironment();

    const foreground = spawnCli(["daemon", "start"], environment);
    const background = await runCli(["daemon", "start", "--background", "--json"], environment);
    const backgroundAnswer = parseJson<StartAnswer>(background);

    const settled = await waitFor(
      async () => (await isHealthy(environment.port)) && readRuntimePid(environment) !== null,
      10_000
    );
    expect(settled).toBe(true);

    const winner = readRuntimePid(environment);
    const foregroundWon = winner === foreground.pid;

    if (foregroundWon) {
      expect(backgroundAnswer.ok).toBe(false);
      if (!backgroundAnswer.ok) {
        expect(backgroundAnswer.detail.length).toBeGreaterThan(0);
      }
    } else {
      expect(backgroundAnswer).toEqual({ ok: true, ready: true });
      const refused = await collect(foreground);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toMatch(/daemon/i);
    }

    expect(await waitFor(() => livePids(environment, [foreground.pid]).length === 1, 5_000)).toBe(true);
    expect(livePids(environment, [foreground.pid])).toEqual([winner ?? -1]);
  });
});

describe("wa daemon stop --json", () => {
  it("sem nenhum registro de partida responde que ja estava parado", async () => {
    const environment = await newEnvironment();

    expect(await stopVerb(environment)).toEqual({ ok: true, stopped: true, alreadyStopped: true });
  });

  it("registro com pid morto tambem ja estava parado", async () => {
    const environment = await newEnvironment();
    const dead = Bun.spawn(["bun", "-e", "process.exit(0)"]);
    await dead.exited;
    writeRuntimeFile(environment, dead.pid);

    expect(await stopVerb(environment)).toEqual({ ok: true, stopped: true, alreadyStopped: true });
  });

  it("com daemon vivo pede POST /shutdown, espera a morte e so responde depois dela (parada graciosa)", async () => {
    const environment = await newEnvironment();
    expect(await startBackground(environment)).toEqual({ ok: true, ready: true });
    const pid = readRuntimePid(environment) ?? -1;

    const answer = await stopVerb(environment);

    expect(answer).toMatchObject({ ok: true, stopped: true, alreadyStopped: false, graceful: true, pid });
    await expectDead(pid);
    expect(await isHealthy(environment.port)).toBe(false);
    expect(existsSync(dataPath(environment, "runtime.json"))).toBe(false);

    const log = readLog(environment);
    expect(log).toContain("encerrando daemon: parada graciosa");
    expect(log).toContain("parada graciosa confirmada");
    expect(log).not.toContain("parada forcada");

    expect(await statusOf(environment)).toMatchObject({ running: false, processAlive: false });
    expect(await stopVerb(environment)).toEqual({ ok: true, stopped: true, alreadyStopped: true });
  });

  it("para tambem um daemon iniciado em primeiro plano, que sai com codigo 0", async () => {
    const environment = await newEnvironment();
    const foreground = spawnCli(["daemon", "start"], environment);
    expect(await waitForHealth(environment.port, 10_000)).toBe(true);

    const answer = await stopVerb(environment);

    expect(answer).toMatchObject({ ok: true, alreadyStopped: false, graceful: true, pid: foreground.pid });
    expect(await foreground.exited).toBe(0);
  });

  it("INV-05: o endpoint recusa token errado e o daemon continua vivo", async () => {
    const environment = await newEnvironment();
    expect(await startBackground(environment)).toEqual({ ok: true, ready: true });

    const anonymous = await fetch(`http://127.0.0.1:${environment.port}/shutdown`, { method: "POST" });
    const wrong = await fetch(`http://127.0.0.1:${environment.port}/shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer errado" }
    });
    await Bun.sleep(300);

    expect(anonymous.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await isHealthy(environment.port)).toBe(true);
  });
});

describe("CA-14: parada com recurso a forca", () => {
  const WAIT_MS = 1_500;

  async function expectForced(
    answer: StopAnswer,
    pid: number,
    environment: TestEnvironment,
    reason: string
  ): Promise<void> {
    expect(answer).toMatchObject({ ok: true, stopped: true, alreadyStopped: false, graceful: false, pid });

    if (!answer.ok || answer.alreadyStopped) {
      return;
    }

    const gracefulWindow = WAIT_MS - forceReserveMs(WAIT_MS);
    expect(answer.elapsedMs).toBeGreaterThanOrEqual(gracefulWindow - 100);
    expect(answer.elapsedMs).toBeLessThanOrEqual(WAIT_MS + 250);
    await expectDead(pid);

    expect(existsSync(dataPath(environment, "runtime.json"))).toBe(false);

    const log = readLog(environment);
    expect(log).toContain("parada forcada");
    expect(log).toContain(`"motivo":"${reason}"`);
    expect(log).not.toContain("parada graciosa confirmada");
  }

  it("token ausente: espera o orcamento, forca pelo pid do registro e so entao responde", async () => {
    const environment = await newEnvironment();
    const fixture = await spawnFixture(environment, "wa-control-idle.ts", IDLE_PROCESS);
    writeRuntimeFile(environment, fixture.pid);

    const answer = await stopVerb(environment, "--wait-ms", String(WAIT_MS));

    await expectForced(answer, fixture.pid, environment, "token-ausente");
  });

  it("API muda: o pedido nao e respondido, espera o orcamento e forca", async () => {
    const environment = await newEnvironment();
    writeToken(environment);
    const fixture = await spawnFixture(environment, "wa-control-mute.ts", MUTE_SERVER, [
      String(environment.port)
    ]);
    writeRuntimeFile(environment, fixture.pid);
    expect(await waitFor(() => canConnect(environment.port), 5_000)).toBe(true);

    const answer = await stopVerb(environment, "--wait-ms", String(WAIT_MS));

    await expectForced(answer, fixture.pid, environment, "api-muda");
  });

  it("durante a partida (HTTP ainda fechado): espera o orcamento e forca", async () => {
    const environment = await newEnvironment();
    writeToken(environment);
    const fixture = await spawnFixture(environment, "wa-control-starting.ts", IDLE_PROCESS);
    writeRuntimeFile(environment, fixture.pid);

    const answer = await stopVerb(environment, "--wait-ms", String(WAIT_MS));

    await expectForced(answer, fixture.pid, environment, "porta-fechada");
  });

  it("daemon sem a rota (anterior a esta versao): o 404 nao e tratado como parada e acaba forcado", async () => {
    const environment = await newEnvironment();
    writeToken(environment);
    const fixture = await spawnFixture(environment, "wa-control-old-daemon.ts", OLD_DAEMON_SERVER, [
      String(environment.port)
    ]);
    writeRuntimeFile(environment, fixture.pid);
    expect(
      await waitFor(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${environment.port}/`)).status === 404;
        } catch {
          return false;
        }
      }, 5_000)
    ).toBe(true);

    const answer = await stopVerb(environment, "--wait-ms", String(WAIT_MS));

    await expectForced(answer, fixture.pid, environment, "endpoint-recusou");
  });

  it("o daemon que o proprio pedido derruba antes do orcamento nao e forcado", async () => {
    const environment = await newEnvironment();
    expect(await startBackground(environment)).toEqual({ ok: true, ready: true });

    const answer = await stopVerb(environment, "--wait-ms", String(WAIT_MS));

    expect(answer).toMatchObject({ ok: true, alreadyStopped: false, graceful: true });
    if (answer.ok && !answer.alreadyStopped) {
      expect(answer.elapsedMs).toBeLessThan(WAIT_MS - forceReserveMs(WAIT_MS));
    }
  });

  it.skipIf(process.platform !== "linux")(
    "pid reaproveitado por outro programa: ja estava parado e o processo alheio nao recebe sinal",
    async () => {
      const environment = await newEnvironment();
      const foreign = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });

      try {
        writeRuntimeFile(environment, foreign.pid);
        writeToken(environment);

        const answer = await stopVerb(environment, "--wait-ms", "500");

        expect(answer).toEqual({ ok: true, stopped: true, alreadyStopped: true });
        expect(isProcessAlive(foreign.pid)).toBe(true);
        expect(readLog(environment)).not.toContain("parada forcada");
      } finally {
        foreign.kill("SIGKILL");
        await foreign.exited;
      }
    }
  );

  it("--wait-ms invalido falha na validacao local sem tocar no daemon", async () => {
    const environment = await newEnvironment();
    expect(await startBackground(environment)).toEqual({ ok: true, ready: true });

    const result = await runCli(["daemon", "stop", "--json", "--wait-ms", "abc"], environment);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("wait-ms");
    expect(await isHealthy(environment.port)).toBe(true);
  });
});
