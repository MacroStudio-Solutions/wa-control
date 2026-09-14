import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAppError } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type { AppConfig } from "../shared/types.ts";
import {
  decideSingleInstanceAction,
  enforceSingleInstance,
  inspectProcess,
  readRuntimeFile
} from "./daemonGuard.ts";
import type { ProcessIdentity } from "./daemonGuard.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

function createConfig(): AppConfig {
  const rootDir = mkdtempSync(join(tmpdir(), "wa-control-daemon-guard-"));
  tempDirs.push(rootDir);

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

function writeRuntimeFile(config: AppConfig, payload: unknown): void {
  writeFileSync(config.paths.runtimePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function identityFor(pid: number, overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return {
    pid,
    alive: true,
    classification: "self",
    exePath: null,
    exeDeleted: false,
    cmdline: null,
    ...overrides
  };
}

async function spawnExitedProcess(): Promise<number> {
  const proc = Bun.spawn(["bun", "-e", "process.exit(0)"]);
  await proc.exited;
  return proc.pid;
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error("esperava que a operacao falhasse");
}

describe("readRuntimeFile", () => {
  it("arquivo inexistente vira missing", () => {
    const config = createConfig();

    expect(readRuntimeFile(config.paths.runtimePath)).toEqual({ status: "missing" });
  });

  it("json invalido vira corrupt", () => {
    const config = createConfig();
    writeFileSync(config.paths.runtimePath, "{nao sou json", "utf8");

    expect(readRuntimeFile(config.paths.runtimePath)).toEqual({ status: "corrupt" });
  });

  it("json valido sem pid (ou com pid invalido) vira corrupt", () => {
    const config = createConfig();

    writeRuntimeFile(config, { startedAt: "2026-09-01T20:00:00.000Z" });
    expect(readRuntimeFile(config.paths.runtimePath)).toEqual({ status: "corrupt" });

    writeRuntimeFile(config, { pid: "oito" });
    expect(readRuntimeFile(config.paths.runtimePath)).toEqual({ status: "corrupt" });

    writeRuntimeFile(config, { pid: -1 });
    expect(readRuntimeFile(config.paths.runtimePath)).toEqual({ status: "corrupt" });
  });

  it("arquivo legado sem version e lido com os campos opcionais preenchidos", () => {
    const config = createConfig();
    writeRuntimeFile(config, {
      pid: 820739,
      startedAt: "2026-09-01T20:00:00.000Z",
      host: "127.0.0.1",
      port: 44999
    });

    const read = readRuntimeFile(config.paths.runtimePath);

    expect(read.status).toBe("readable");
    if (read.status === "readable") {
      expect(read.file.pid).toBe(820739);
      expect(read.file.port).toBe(44999);
      expect(read.file.version).toBeUndefined();
    }
  });

  it("campo version novo e preservado na leitura", () => {
    const config = createConfig();
    writeRuntimeFile(config, { pid: 1, version: "0.6.1" });

    const read = readRuntimeFile(config.paths.runtimePath);

    expect(read.status).toBe("readable");
    if (read.status === "readable") {
      expect(read.file.version).toBe("0.6.1");
    }
  });
});

describe("decideSingleInstanceAction", () => {
  const file = { pid: 820739, port: 44999, version: "0.6.0" };

  it("PID vivo do proprio wa-control recusa com DAEMON_ALREADY_RUNNING 409", () => {
    const decision = decideSingleInstanceAction(file, identityFor(file.pid));

    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(isAppError(decision.error)).toBe(true);
      expect(decision.error.code).toBe("DAEMON_ALREADY_RUNNING");
      expect(decision.error.status).toBe(409);
      expect(decision.error.message).toContain("820739");
      expect(decision.error.message).toContain("44999");
      expect(decision.error.message).toContain("0.6.0");
      expect(decision.error.message).toContain(`kill 820739`);
      expect(decision.error.message).toContain("daemon stop");
    }
  });

  it("mensagem de recusa cita versao desconhecida quando o arquivo nao tem version", () => {
    const decision = decideSingleInstanceAction({ pid: 820739 }, identityFor(820739));

    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.error.message).toContain("desconhecida");
    }
  });

  it("mensagem de recusa denuncia binario deletado do disco (zumbi)", () => {
    const decision = decideSingleInstanceAction(
      file,
      identityFor(file.pid, { exePath: "/usr/local/bin/wa", exeDeleted: true })
    );

    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.error.message).toContain("deletado");
    }
  });

  it("mensagem de recusa denuncia binario divergente do atual", () => {
    const decision = decideSingleInstanceAction(
      file,
      identityFor(file.pid, { exePath: "/caminho/antigo/wa-0.5.1" })
    );

    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.error.message).toContain("diverge");
      expect(decision.error.message).toContain("/caminho/antigo/wa-0.5.1");
    }
  });

  it("PID vivo de outro processo (reusado) e tratado como stale: limpar e prosseguir", () => {
    const decision = decideSingleInstanceAction(file, identityFor(file.pid, { classification: "other" }));

    expect(decision.action).toBe("proceed-cleanup");
    if (decision.action === "proceed-cleanup") {
      expect(decision.reason).toBe("foreign-process");
    }
  });

  it("PID morto e tratado como stale: limpar e prosseguir", () => {
    const decision = decideSingleInstanceAction(file, identityFor(file.pid, { alive: false }));

    expect(decision.action).toBe("proceed-cleanup");
    if (decision.action === "proceed-cleanup") {
      expect(decision.reason).toBe("stale-dead-pid");
    }
  });

  it("identidade indeterminavel recusa de forma conservadora avisando sobre PID possivelmente reusado", () => {
    const decision = decideSingleInstanceAction(
      file,
      identityFor(file.pid, { classification: "unknown" })
    );

    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.error.code).toBe("DAEMON_ALREADY_RUNNING");
      expect(decision.error.message).toContain("reusado");
    }
  });

  it("identidade unknown nunca vira limpeza automatica do registro", () => {
    const decision = decideSingleInstanceAction(
      file,
      identityFor(file.pid, { classification: "unknown", exePath: null })
    );

    expect(decision.action).not.toBe("proceed-cleanup");
  });
});

describe("inspectProcess", () => {
  it("PID do proprio processo e classificado como self mesmo sem /proc", () => {
    const identity = inspectProcess(process.pid);

    expect(identity.alive).toBe(true);
    expect(identity.classification).toBe("self");
  });

  it("PID morto vem alive=false sem classificar", async () => {
    const pid = await spawnExitedProcess();
    const identity = inspectProcess(pid);

    expect(identity.alive).toBe(false);
    expect(identity.classification).toBe("unknown");
  });

  it("processo vivo claramente alheio (sleep) e classificado como other", async () => {
    const proc = Bun.spawn(["sleep", "5"]);
    try {
      const identity = inspectProcess(proc.pid);

      expect(identity.alive).toBe(true);
      expect(identity.classification).toBe("other");
    } finally {
      proc.kill();
    }
  });
});

describe("enforceSingleInstance", () => {
  it("sem runtime.json o start prossegue e nada e criado", () => {
    const config = createConfig();

    expect(() => enforceSingleInstance(config, silentLogger)).not.toThrow();
    expect(existsSync(config.paths.runtimePath)).toBe(false);
  });

  it("PID vivo do proprio wa-control recusa e NUNCA apaga o runtime.json", () => {
    const config = createConfig();
    writeRuntimeFile(config, { pid: process.pid, port: 44999 });

    const error = captureError(() => enforceSingleInstance(config, silentLogger));

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("DAEMON_ALREADY_RUNNING");
    }
    expect(existsSync(config.paths.runtimePath)).toBe(true);
  });

  it("PID morto e removido com aviso e o start prossegue", async () => {
    const config = createConfig();
    const pid = await spawnExitedProcess();
    writeRuntimeFile(config, { pid });

    expect(() => enforceSingleInstance(config, silentLogger)).not.toThrow();
    expect(existsSync(config.paths.runtimePath)).toBe(false);
  });

  it("PID vivo de processo alheio (reusado) e removido e o start prossegue", async () => {
    const config = createConfig();
    const proc = Bun.spawn(["sleep", "5"]);
    try {
      writeRuntimeFile(config, { pid: proc.pid });

      expect(() => enforceSingleInstance(config, silentLogger)).not.toThrow();
      expect(existsSync(config.paths.runtimePath)).toBe(false);
    } finally {
      proc.kill();
    }
  });

  it("runtime.json corrupto e removido com aviso e o start prossegue", () => {
    const config = createConfig();
    writeFileSync(config.paths.runtimePath, "isto nao e json", "utf8");

    expect(() => enforceSingleInstance(config, silentLogger)).not.toThrow();
    expect(existsSync(config.paths.runtimePath)).toBe(false);
  });

  it("runtime.json sem pid legivel e tratado como stale", () => {
    const config = createConfig();
    writeRuntimeFile(config, { startedAt: "2026-09-01T20:00:00.000Z" });

    expect(() => enforceSingleInstance(config, silentLogger)).not.toThrow();
    expect(existsSync(config.paths.runtimePath)).toBe(false);
  });
});
