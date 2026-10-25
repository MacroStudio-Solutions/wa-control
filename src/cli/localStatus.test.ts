import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { AppError } from "../shared/errors.ts";
import type { AppConfig, SessionRecord, StatusResponse } from "../shared/types.ts";
import { openDatabase } from "../storage/db.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import { cleanupProcessHarness, createTempDataDir } from "../test-support/processHarness.ts";
import { collectStatusReport, readProcessAlive } from "./localStatus.ts";

afterEach(cleanupProcessHarness);

function createConfig(): AppConfig {
  const rootDir = createTempDataDir();

  return {
    host: "127.0.0.1",
    port: 43777,
    logLevel: "info",
    paths: {
      rootDir,
      configPath: join(rootDir, "config.json"),
      databasePath: join(rootDir, "app.sqlite"),
      runtimePath: join(rootDir, "runtime.json"),
      sessionsDir: join(rootDir, "sessions"),
      tokenPath: join(rootDir, "token")
    }
  };
}

function writeRuntime(config: AppConfig, payload: unknown): void {
  writeFileSync(config.paths.runtimePath, JSON.stringify(payload), "utf8");
}

function runtimePayload(pid: number) {
  return {
    pid,
    startedAt: "2026-10-24T20:00:00.000Z",
    host: "127.0.0.1",
    port: 43777,
    version: "0.8.0-test"
  };
}

function seedSession(config: AppConfig): SessionRecord {
  const now = new Date().toISOString();
  const session: SessionRecord = {
    id: "pessoal",
    status: "connected",
    createdAt: now,
    updatedAt: now,
    phoneNumber: "556700000000",
    lastError: null,
    active: true,
    lastConnectedAt: now,
    reconnectAttempts: 0,
    qr: null
  };
  const db = openDatabase(config.paths.databasePath);
  new SessionsRepo(db).save(session);
  db.close();
  return session;
}

async function spawnExitedProcess(): Promise<number> {
  const proc = Bun.spawn(["bun", "-e", "process.exit(0)"]);
  await proc.exited;
  return proc.pid;
}

const liveStatus: StatusResponse = {
  daemon: {
    pid: 4242,
    startedAt: "2026-10-24T20:00:00.000Z",
    host: "127.0.0.1",
    port: 43777,
    version: "0.8.0-test"
  },
  sessions: [],
  eventCount: 3,
  webhookCount: 1
};

function fakeClient(options: {
  gate?: "open" | "closed";
  status?: () => Promise<StatusResponse>;
}) {
  let statusCalls = 0;

  return {
    client: {
      probeDaemonGate: async () => options.gate ?? "open",
      status: async () => {
        statusCalls += 1;
        return (options.status ?? (async () => liveStatus))();
      }
    },
    statusCalls: () => statusCalls
  };
}

const TOP_LEVEL_KEYS = ["running", "processAlive", "daemon", "sessions", "eventCount", "webhookCount"];

describe("collectStatusReport", () => {
  it("daemon respondendo: running e processAlive verdadeiros e os campos atuais intactos", async () => {
    const config = createConfig();
    const { client } = fakeClient({});

    const report = await collectStatusReport(client, config);

    expect(report.running).toBe(true);
    expect(report.processAlive).toBe(true);
    expect(Object.keys(report)).toEqual(TOP_LEVEL_KEYS);
    expect(Object.keys(report.daemon)).toEqual(["pid", "startedAt", "host", "port", "version"]);
    expect(report).toMatchObject(liveStatus);
  });

  it("porta fechada: retrato offline sem consultar a API e running falso", async () => {
    const config = createConfig();
    const { client, statusCalls } = fakeClient({ gate: "closed" });

    const report = await collectStatusReport(client, config);

    expect(report.running).toBe(false);
    expect(statusCalls()).toBe(0);
  });

  it("nunca iniciado: false/false com o retrato offline na forma de sempre", async () => {
    const config = createConfig();
    const { client } = fakeClient({ gate: "closed" });

    const report = await collectStatusReport(client, config);

    expect(report).toEqual({
      running: false,
      processAlive: false,
      daemon: {
        online: false,
        host: "127.0.0.1",
        port: 43777,
        runtimeFilePresent: false,
        stalePid: null,
        tokenPresent: false
      },
      sessions: [],
      eventCount: 0,
      webhookCount: 0
    });
    expect(Object.keys(report)).toEqual(TOP_LEVEL_KEYS);
  });

  it("tempo esgotado com o daemon vivo e mudo: false/true com o retrato offline e as sessoes do banco", async () => {
    const config = createConfig();
    const session = seedSession(config);
    writeRuntime(config, runtimePayload(process.pid));
    const { client } = fakeClient({
      status: async () => {
        throw new AppError("DAEMON_UNAVAILABLE", 503, "Daemon local nao esta rodando.");
      }
    });

    const report = await collectStatusReport(client, config);

    expect(report.running).toBe(false);
    expect(report.processAlive).toBe(true);
    expect(report.daemon).toEqual({
      online: false,
      host: "127.0.0.1",
      port: 43777,
      runtimeFilePresent: true,
      stalePid: null,
      tokenPresent: false
    });
    expect(report.sessions).toEqual([session]);
    expect(Object.keys(report)).toEqual(TOP_LEVEL_KEYS);
  });

  it("registro com pid morto: false/false e stalePid preenchido", async () => {
    const config = createConfig();
    const deadPid = await spawnExitedProcess();
    writeRuntime(config, runtimePayload(deadPid));
    const { client } = fakeClient({ gate: "closed" });

    const report = await collectStatusReport(client, config);

    expect(report.running).toBe(false);
    expect(report.processAlive).toBe(false);
    expect(report.daemon).toMatchObject({ online: false, runtimeFilePresent: true, stalePid: deadPid });
  });

  it("qualquer falha inesperada do cliente cai no retrato offline e vai para o stderr", async () => {
    const config = createConfig();
    const { client } = fakeClient({
      status: async () => {
        throw new AppError("HTTP_ERROR", 500, "Falha HTTP 500");
      }
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});

    try {
      const report = await collectStatusReport(client, config);

      expect(report.running).toBe(false);
      expect(Object.keys(report)).toEqual(TOP_LEVEL_KEYS);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("erro que nao e AppError tambem cai no retrato offline", async () => {
    const config = createConfig();
    const { client } = fakeClient({
      status: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      }
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});

    try {
      const report = await collectStatusReport(client, config);

      expect(report.running).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it("os codigos esperados de daemon parado nao poluem o stderr", async () => {
    const config = createConfig();
    const errors = spyOn(console, "error").mockImplementation(() => {});

    try {
      for (const code of ["DAEMON_UNAVAILABLE", "TOKEN_NOT_FOUND"]) {
        const { client } = fakeClient({
          status: async () => {
            throw new AppError(code, 503, "daemon parado");
          }
        });
        await collectStatusReport(client, config);
      }

      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("banco ilegivel nao quebra a saida: zeros no retrato e aviso no stderr", async () => {
    const config = createConfig();
    writeFileSync(config.paths.databasePath, "isto nao e um banco sqlite, e so texto repetido ".repeat(50), "utf8");
    const { client } = fakeClient({ gate: "closed" });
    const errors = spyOn(console, "error").mockImplementation(() => {});

    try {
      const report = await collectStatusReport(client, config);

      expect(report.running).toBe(false);
      expect(report.sessions).toEqual([]);
      expect(report.eventCount).toBe(0);
      expect(report.webhookCount).toBe(0);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("readProcessAlive", () => {
  it("sem runtime.json o processo nao esta vivo", () => {
    expect(readProcessAlive(createConfig())).toBe(false);
  });

  it("runtime.json corrompido nao conta como vivo", () => {
    const config = createConfig();
    writeFileSync(config.paths.runtimePath, "isto nao e json", "utf8");

    expect(readProcessAlive(config)).toBe(false);
  });

  it("pid morto nao conta como vivo", async () => {
    const config = createConfig();
    writeRuntime(config, runtimePayload(await spawnExitedProcess()));

    expect(readProcessAlive(config)).toBe(false);
  });

  it("pid vivo do wa-control conta como vivo", () => {
    const config = createConfig();
    writeRuntime(config, runtimePayload(process.pid));

    expect(readProcessAlive(config)).toBe(true);
  });

  it("pid reusado por outro processo nao conta como vivo", async () => {
    if (process.platform !== "linux") {
      return;
    }

    const config = createConfig();
    const foreign = Bun.spawn(["sleep", "5"]);

    try {
      writeRuntime(config, runtimePayload(foreign.pid));

      expect(readProcessAlive(config)).toBe(false);
    } finally {
      foreign.kill();
      await foreign.exited;
    }
  });
});
