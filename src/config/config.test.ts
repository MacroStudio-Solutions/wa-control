import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import {
  cleanupProcessHarness,
  createTempDataDir,
  createTestEnvironment,
  runCli
} from "../test-support/processHarness.ts";
import { loadAppConfig } from "./config.ts";

const ENV_KEYS = [
  "WA_CONTROL_DATA_DIR",
  "WA_CONTROL_HOST",
  "WA_CONTROL_PORT",
  "WA_CONTROL_LOG_LEVEL"
] as const;

const DEFAULT_TEXT = '{\n  "host": "127.0.0.1",\n  "port": 43119,\n  "logLevel": "info"\n}\n';
const CUSTOM_TEXT = '{\n  "host": "0.0.0.0",\n  "port": 50000,\n  "logLevel": "debug"\n}\n';
const TOP_LEVEL_KEYS = ["running", "processAlive", "daemon", "sessions", "eventCount", "webhookCount"];
const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");

let savedEnv: Record<string, string | undefined>;
let dataDir: string;
let configPath: string;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  dataDir = createTempDataDir();
  configPath = join(dataDir, "config.json");
  process.env.WA_CONTROL_DATA_DIR = dataDir;
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  errorSpy.mockRestore();

  for (const key of ENV_KEYS) {
    const value = savedEnv[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  await cleanupProcessHarness();
});

function warnings(): string[] {
  return errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.includes(" WARN "));
}

function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

function ageConfigFile(path: string): void {
  utimesSync(path, LONG_AGO, LONG_AGO);
}

describe("loadAppConfig: leitura", () => {
  it("sem arquivo: usa os padroes e grava o config.json no formato de sempre", () => {
    const config = loadAppConfig();

    expect(config).toMatchObject({ host: "127.0.0.1", port: 43119, logLevel: "info" });
    expect(config.paths.configPath).toBe(configPath);
    expect(readFileSync(configPath, "utf8")).toBe(DEFAULT_TEXT);
    expect(warnings()).toEqual([]);
    expect(leftovers(dataDir)).toEqual([]);
  });

  it.each([
    ["vazio (0 bytes)", ""],
    ["so com espacos e quebras de linha", "  \r\n\t\n"],
    ["com JSON truncado", '{"host":"127.0.0.1","po'],
    ["com texto que nao e JSON", "isto nao e json"],
    ["com null", "null"],
    ["com uma lista", "[1,2,3]"],
    ["com um numero", "42"]
  ])("arquivo %s cai nos padroes, regrava e avisa sem derrubar o comando", (_label, content) => {
    writeFileSync(configPath, content, "utf8");

    const config = loadAppConfig();

    expect(config).toMatchObject({ host: "127.0.0.1", port: 43119, logLevel: "info" });
    expect(readFileSync(configPath, "utf8")).toBe(DEFAULT_TEXT);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("config.json");
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("o aviso so aparece uma vez: depois da regravacao o arquivo e valido", () => {
    writeFileSync(configPath, "", "utf8");

    loadAppConfig();
    loadAppConfig();
    loadAppConfig();

    expect(warnings()).toHaveLength(1);
  });

  it("arquivo vazio com override de ambiente: o override vence e e o que fica gravado", () => {
    writeFileSync(configPath, "", "utf8");
    process.env.WA_CONTROL_PORT = "47001";

    const config = loadAppConfig();

    expect(config.port).toBe(47001);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      host: "127.0.0.1",
      port: 47001,
      logLevel: "info"
    });
  });

  it("arquivo valido com BOM: respeita os valores e regrava sem o BOM", () => {
    writeFileSync(configPath, `﻿${CUSTOM_TEXT}`, "utf8");

    const config = loadAppConfig();

    expect(config).toMatchObject({ host: "0.0.0.0", port: 50000, logLevel: "debug" });
    expect(readFileSync(configPath, "utf8")).toBe(CUSTOM_TEXT);
    expect(warnings()).toEqual([]);
  });

  it("valores do arquivo e overrides de ambiente continuam valendo (host, porta e nivel de log)", () => {
    writeFileSync(configPath, CUSTOM_TEXT, "utf8");

    expect(loadAppConfig()).toMatchObject({ host: "0.0.0.0", port: 50000, logLevel: "debug" });

    process.env.WA_CONTROL_HOST = "127.0.0.2";
    process.env.WA_CONTROL_PORT = "51000";
    process.env.WA_CONTROL_LOG_LEVEL = "warn";

    const overridden = loadAppConfig();

    expect(overridden).toMatchObject({ host: "127.0.0.2", port: 51000, logLevel: "warn" });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      host: "127.0.0.2",
      port: 51000,
      logLevel: "warn"
    });
  });

  it("porta escrita como texto no arquivo continua sendo convertida em numero", () => {
    writeFileSync(configPath, '{"host":"127.0.0.1","port":"50123","logLevel":"info"}', "utf8");

    expect(loadAppConfig().port).toBe(50123);
  });
});

describe("loadAppConfig: gravacao", () => {
  it("conteudo igual ao que seria gravado: nao regrava (mtime e inode ficam)", () => {
    writeFileSync(configPath, CUSTOM_TEXT, "utf8");
    ageConfigFile(configPath);
    const before = statSync(configPath);

    loadAppConfig();
    loadAppConfig();

    const after = statSync(configPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    expect(readFileSync(configPath, "utf8")).toBe(CUSTOM_TEXT);
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("depois de gravar uma vez, as chamadas seguintes nao tocam mais no arquivo", () => {
    loadAppConfig();
    ageConfigFile(configPath);
    const before = statSync(configPath);

    loadAppConfig();

    const after = statSync(configPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
  });

  it("conteudo diferente do canonico (recuo, ordem, chave extra, sem quebra final): regrava uma vez no formato de sempre", () => {
    writeFileSync(
      configPath,
      '{"logLevel":"debug","extra":true,"port":50000,"host":"0.0.0.0"}',
      "utf8"
    );

    loadAppConfig();

    expect(readFileSync(configPath, "utf8")).toBe(CUSTOM_TEXT);
    expect(warnings()).toEqual([]);
    expect(leftovers(dataDir)).toEqual([]);
  });

  it("a regravacao troca o arquivo por inteiro: nao fica nada do conteudo antigo", () => {
    writeFileSync(configPath, `${CUSTOM_TEXT}${"\n".repeat(4096)}`, "utf8");

    loadAppConfig();

    expect(readFileSync(configPath, "utf8")).toBe(CUSTOM_TEXT);
  });

  const canBlockWrites = process.platform !== "win32" && process.getuid?.() !== 0;

  it.skipIf(!canBlockWrites)(
    "falha ao gravar (diretorio sem escrita): o comando segue, avisa e o arquivo antigo fica intacto",
    () => {
      const original = '{"host":"0.0.0.0","port":50000,"logLevel":"debug"}';
      mkdirSync(join(dataDir, "sessions"), { recursive: true });
      writeFileSync(configPath, original, "utf8");
      chmodSync(dataDir, 0o555);

      try {
        const config = loadAppConfig();

        expect(config).toMatchObject({ host: "0.0.0.0", port: 50000, logLevel: "debug" });
        expect(readFileSync(configPath, "utf8")).toBe(original);
        expect(leftovers(dataDir)).toEqual([]);
        expect(warnings()).toHaveLength(1);
      } finally {
        chmodSync(dataDir, 0o755);
      }
    }
  );
});

describe("wa status --json com config.json danificado", () => {
  async function runStatus(environment: Awaited<ReturnType<typeof createTestEnvironment>>) {
    const result = await runCli(["status", "--json"], environment);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    return { result, status: JSON.parse(lines[0] ?? "") as Record<string, unknown> };
  }

  it("config.json vazio: devolve o envelope normal, regrava o arquivo e avisa uma vez", async () => {
    const environment = await createTestEnvironment();
    const path = join(environment.dataDir, "config.json");
    writeFileSync(path, "", "utf8");

    const { result, status } = await runStatus(environment);

    expect(Object.keys(status)).toEqual(TOP_LEVEL_KEYS);
    expect(status.running).toBe(false);
    expect(status.processAlive).toBe(false);
    expect(status.daemon).toMatchObject({ online: false, host: "127.0.0.1", port: environment.port });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      host: "127.0.0.1",
      port: environment.port,
      logLevel: "info"
    });
    expect(result.stderr.split("\n").filter((line) => line.includes(" WARN "))).toHaveLength(1);
    expect(result.stderr).toContain("config.json");
  }, 30_000);

  it("config.json com JSON invalido: devolve o envelope normal e regrava com os padroes", async () => {
    const environment = await createTestEnvironment();
    const path = join(environment.dataDir, "config.json");
    writeFileSync(path, '{"host":"127.0.0.1","port":', "utf8");

    const { status } = await runStatus(environment);

    expect(Object.keys(status)).toEqual(TOP_LEVEL_KEYS);
    expect(status.running).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ host: "127.0.0.1", logLevel: "info" });
  }, 30_000);

  it("config.json valido: duas sondagens seguidas nao mexem no arquivo", async () => {
    const environment = await createTestEnvironment();
    const path = join(environment.dataDir, "config.json");

    await runStatus(environment);
    ageConfigFile(path);
    const before = statSync(path);

    const { result } = await runStatus(environment);
    await runStatus(environment);

    const after = statSync(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    expect(result.stderr).not.toContain(" WARN ");
  }, 30_000);
});
