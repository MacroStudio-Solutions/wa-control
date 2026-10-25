import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isAppError } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type { AppConfig } from "../shared/types.ts";
import {
  GUARD_PATH,
  cleanupProcessHarness,
  collect,
  createTempDataDir,
  createTestEnvironment,
  spawnScript
} from "../test-support/processHarness.ts";
import {
  acquireRuntimeFile,
  claimRuntimeFile,
  createFileExclusivelyWithoutLink,
  readRuntimeFile,
  releaseRuntimeFile,
  writeRuntimeFileAtomically,
  type RuntimeFileRecord
} from "./daemonGuard.ts";

afterEach(cleanupProcessHarness);

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

function createConfig(): AppConfig {
  const rootDir = createTempDataDir();

  return {
    host: "127.0.0.1",
    port: 43119,
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

function recordFor(pid: number, overrides: Partial<RuntimeFileRecord> = {}): RuntimeFileRecord {
  return {
    pid,
    startedAt: "2026-10-24T20:00:00.000Z",
    host: "127.0.0.1",
    port: 43119,
    version: "0.8.0-test",
    executable: "/usr/local/bin/wa",
    ...overrides
  };
}

function readRaw(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function filesIn(config: AppConfig): string[] {
  return readdirSync(config.paths.rootDir).sort();
}

async function spawnExitedProcess(): Promise<number> {
  const proc = Bun.spawn(["bun", "-e", "process.exit(0)"]);
  await proc.exited;
  return proc.pid;
}

describe("claimRuntimeFile", () => {
  it("cria o runtime.json com o registro completo quando ele nao existe", () => {
    const config = createConfig();
    const record = recordFor(4242);

    expect(claimRuntimeFile(config.paths.runtimePath, record)).toBe(true);

    expect(readRaw(config.paths.runtimePath)).toEqual(record);
    expect(filesIn(config)).toEqual(["runtime.json"]);
  });

  it("falha sem tocar no registro quando o runtime.json ja existe", () => {
    const config = createConfig();
    const first = recordFor(111);

    expect(claimRuntimeFile(config.paths.runtimePath, first)).toBe(true);
    expect(claimRuntimeFile(config.paths.runtimePath, recordFor(222))).toBe(false);

    expect(readRaw(config.paths.runtimePath)).toEqual(first);
    expect(filesIn(config)).toEqual(["runtime.json"]);
  });

  it("a criacao exclusiva sem link duro tambem falha quando o arquivo existe", () => {
    const config = createConfig();
    const target = join(config.paths.rootDir, "exclusivo.txt");

    expect(createFileExclusivelyWithoutLink(target, "primeiro")).toBe(true);
    expect(createFileExclusivelyWithoutLink(target, "segundo")).toBe(false);

    expect(readFileSync(target, "utf8")).toBe("primeiro");
  });

  it("grava os mesmos campos de hoje e o arquivo continua legivel pela guarda e pelo schema do 0.7.0", () => {
    const config = createConfig();
    claimRuntimeFile(config.paths.runtimePath, recordFor(4242));

    const raw = readRaw(config.paths.runtimePath) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(
      ["executable", "host", "pid", "port", "startedAt", "version"].sort()
    );

    const read = readRuntimeFile(config.paths.runtimePath);
    expect(read.status).toBe("readable");

    const schema0_7_0 = z.object({
      pid: z.number().int().positive(),
      startedAt: z.string(),
      host: z.string(),
      port: z.number().int().positive()
    });
    expect(schema0_7_0.parse(raw)).toEqual({
      pid: 4242,
      startedAt: "2026-10-24T20:00:00.000Z",
      host: "127.0.0.1",
      port: 43119
    });
  });
});

describe("writeRuntimeFileAtomically", () => {
  it("substitui o registro existente sem deixar arquivo temporario", () => {
    const config = createConfig();
    claimRuntimeFile(config.paths.runtimePath, recordFor(4242, { startedAt: "2026-10-24T20:00:00.000Z" }));

    const updated = recordFor(4242, { startedAt: "2026-10-24T20:00:05.000Z" });
    writeRuntimeFileAtomically(config.paths.runtimePath, updated);

    expect(readRaw(config.paths.runtimePath)).toEqual(updated);
    expect(filesIn(config)).toEqual(["runtime.json"]);
  });

  it("cria o registro quando ele nao existe", () => {
    const config = createConfig();
    const record = recordFor(4242);

    writeRuntimeFileAtomically(config.paths.runtimePath, record);

    expect(readRaw(config.paths.runtimePath)).toEqual(record);
  });
});

describe("releaseRuntimeFile", () => {
  it("remove o registro quando o pid e o informado", () => {
    const config = createConfig();
    claimRuntimeFile(config.paths.runtimePath, recordFor(4242));

    releaseRuntimeFile(config.paths.runtimePath, 4242);

    expect(existsSync(config.paths.runtimePath)).toBe(false);
    expect(filesIn(config)).toEqual([]);
  });

  it("devolve intacto o registro de outra partida", () => {
    const config = createConfig();
    const other = recordFor(111);
    claimRuntimeFile(config.paths.runtimePath, other);

    releaseRuntimeFile(config.paths.runtimePath, 4242);

    expect(readRaw(config.paths.runtimePath)).toEqual(other);
    expect(filesIn(config)).toEqual(["runtime.json"]);
  });

  it("sem registro nao faz nada", () => {
    const config = createConfig();

    expect(() => releaseRuntimeFile(config.paths.runtimePath, 4242)).not.toThrow();
    expect(filesIn(config)).toEqual([]);
  });
});

describe("acquireRuntimeFile", () => {
  it("sem registro cria o runtime.json antes de qualquer outra coisa", () => {
    const config = createConfig();
    const record = recordFor(process.pid);

    acquireRuntimeFile(config, silentLogger, record);

    expect(readRaw(config.paths.runtimePath)).toEqual(record);
  });

  it("registro com pid morto e removido e a partida segue com o novo registro", async () => {
    const config = createConfig();
    const deadPid = await spawnExitedProcess();
    writeFileSync(config.paths.runtimePath, JSON.stringify({ pid: deadPid }), "utf8");
    const record = recordFor(process.pid);

    acquireRuntimeFile(config, silentLogger, record);

    expect(readRaw(config.paths.runtimePath)).toEqual(record);
    expect(filesIn(config)).toEqual(["runtime.json"]);
  });

  it("registro corrompido e removido e a partida segue com o novo registro", () => {
    const config = createConfig();
    writeFileSync(config.paths.runtimePath, "isto nao e json", "utf8");
    const record = recordFor(process.pid);

    acquireRuntimeFile(config, silentLogger, record);

    expect(readRaw(config.paths.runtimePath)).toEqual(record);
  });

  it("libera a trava de partida depois de assumir o registro", () => {
    const config = createConfig();

    acquireRuntimeFile(config, silentLogger, recordFor(process.pid));

    expect(filesIn(config)).toEqual(["runtime.json"]);
  });

  it("libera a trava de partida quando a guarda recusa", () => {
    const config = createConfig();
    claimRuntimeFile(config.paths.runtimePath, recordFor(process.pid));

    expect(() => acquireRuntimeFile(config, silentLogger, recordFor(4242))).toThrow();

    expect(filesIn(config)).toEqual(["runtime.json"]);
  });

  it("trava de partida de um processo que morreu dentro dela e removida e a partida segue", () => {
    const config = createConfig();
    const lockPath = `${config.paths.runtimePath}.lock`;
    writeFileSync(lockPath, "999999\n", "utf8");
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);
    const record = recordFor(process.pid);

    acquireRuntimeFile(config, silentLogger, record);

    expect(readRaw(config.paths.runtimePath)).toEqual(record);
    expect(filesIn(config)).toEqual(["runtime.json"]);
  });

  it("trava de partida recente de outra partida recusa depois do tempo de espera sem apagar a trava", () => {
    const config = createConfig();
    const lockPath = `${config.paths.runtimePath}.lock`;
    writeFileSync(lockPath, "999999\n", "utf8");

    let thrown: unknown;
    try {
      acquireRuntimeFile(config, silentLogger, recordFor(process.pid), { waitMs: 120 });
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown)).toBe(true);
    if (isAppError(thrown)) {
      expect(thrown.code).toBe("DAEMON_ALREADY_RUNNING");
    }
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(config.paths.runtimePath)).toBe(false);
  });

  it("registro com pid vivo recusa com DAEMON_ALREADY_RUNNING e preserva o registro", () => {
    const config = createConfig();
    const alive = recordFor(process.pid, { port: 44999 });
    claimRuntimeFile(config.paths.runtimePath, alive);

    let thrown: unknown;
    try {
      acquireRuntimeFile(config, silentLogger, recordFor(4242));
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown)).toBe(true);
    if (isAppError(thrown)) {
      expect(thrown.code).toBe("DAEMON_ALREADY_RUNNING");
      expect(thrown.status).toBe(409);
    }
    expect(readRaw(config.paths.runtimePath)).toEqual(alive);
  });
});

const CLAIM_FIXTURE = `
import { join } from "node:path";
import { acquireRuntimeFile } from ${JSON.stringify(GUARD_PATH)};

const [dataDir, startAt, endAt] = process.argv.slice(2);
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  host: "127.0.0.1",
  port: 1,
  logLevel: "error",
  paths: {
    rootDir: dataDir,
    configPath: join(dataDir, "config.json"),
    databasePath: join(dataDir, "app.sqlite"),
    runtimePath: join(dataDir, "runtime.json"),
    sessionsDir: join(dataDir, "sessions"),
    tokenPath: join(dataDir, "token")
  }
};
const record = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  host: "127.0.0.1",
  port: 1,
  version: "test",
  executable: process.execPath
};

while (Date.now() < Number(startAt)) {}

let outcome = "claimed";
try {
  acquireRuntimeFile(config, silent, record);
} catch (error) {
  outcome = error && error.code ? error.code : "error: " + String(error);
}

console.log(JSON.stringify({ pid: process.pid, outcome }));

while (Date.now() < Number(endAt)) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
`;

async function raceClaimers(count: number, prepare?: (config: AppConfig) => void) {
  const environment = await createTestEnvironment();
  const config: AppConfig = {
    host: "127.0.0.1",
    port: environment.port,
    logLevel: "error",
    paths: {
      rootDir: environment.dataDir,
      configPath: join(environment.dataDir, "config.json"),
      databasePath: join(environment.dataDir, "app.sqlite"),
      runtimePath: join(environment.dataDir, "runtime.json"),
      sessionsDir: join(environment.dataDir, "sessions"),
      tokenPath: join(environment.dataDir, "token")
    }
  };
  prepare?.(config);

  const fixturePath = join(environment.dataDir, "claim-fixture.ts");
  writeFileSync(fixturePath, CLAIM_FIXTURE, "utf8");

  const startAt = Date.now() + 2_000;
  const endAt = startAt + 3_000;
  const children = Array.from({ length: count }, () =>
    spawnScript(fixturePath, [environment.dataDir, String(startAt), String(endAt)], environment)
  );
  const results = await Promise.all(children.map(collect));

  const outcomes = results.map((result) => {
    const line = result.stdout.trim().split("\n").pop() ?? "";
    return JSON.parse(line) as { pid: number; outcome: string };
  });

  return { config, outcomes };
}

describe("partidas simultaneas no mesmo diretorio de dados", () => {
  it("seis processos disputando um diretorio sem registro: um assume e cinco recusam", async () => {
    const { config, outcomes } = await raceClaimers(6);

    const claimed = outcomes.filter((entry) => entry.outcome === "claimed");
    const refused = outcomes.filter((entry) => entry.outcome === "DAEMON_ALREADY_RUNNING");

    expect(claimed).toHaveLength(1);
    expect(refused).toHaveLength(5);

    const read = readRuntimeFile(config.paths.runtimePath);
    expect(read.status).toBe("readable");
    if (read.status === "readable") {
      expect(read.file.pid).toBe(claimed[0]?.pid ?? -1);
    }
    expect(filesIn(config).filter((name) => name !== "claim-fixture.ts")).toEqual(["runtime.json"]);
  }, 30_000);

  it("dezesseis processos disputando um diretorio com registro de pid morto: um assume e quinze recusam", async () => {
    const deadPid = await spawnExitedProcess();
    const { config, outcomes } = await raceClaimers(16, (prepared) => {
      writeFileSync(
        prepared.paths.runtimePath,
        JSON.stringify({ pid: deadPid, startedAt: "2026-10-24T20:00:00.000Z", host: "127.0.0.1", port: 1 }),
        "utf8"
      );
    });

    const claimed = outcomes.filter((entry) => entry.outcome === "claimed");
    const refused = outcomes.filter((entry) => entry.outcome === "DAEMON_ALREADY_RUNNING");

    expect(claimed).toHaveLength(1);
    expect(refused).toHaveLength(15);

    const read = readRuntimeFile(config.paths.runtimePath);
    expect(read.status).toBe("readable");
    if (read.status === "readable") {
      expect(read.file.pid).toBe(claimed[0]?.pid ?? -1);
    }
  }, 30_000);
});
