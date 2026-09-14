import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import type { AppConfig } from "../shared/types.ts";
import type { Logger } from "../shared/logger.ts";
import { ChatsRepo } from "../storage/chatsRepo.ts";
import { ContactsRepo } from "../storage/contactsRepo.ts";
import { openDatabase } from "../storage/db.ts";
import { EventsRepo } from "../storage/eventsRepo.ts";
import { MessagesRepo } from "../storage/messagesRepo.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import { WebhookDeliveriesRepo } from "../storage/webhookDeliveriesRepo.ts";
import { WebhooksRepo } from "../storage/webhooksRepo.ts";
import { ReadModelStore } from "../read-model/store.ts";
import { readRuntimeFile } from "./daemonGuard.ts";
import { DaemonRuntime } from "./daemonRuntime.ts";
import { EventBus } from "./eventBus.ts";

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

function createRuntime() {
  const rootDir = mkdtempSync(join(tmpdir(), "wa-control-runtime-file-"));
  tempDirs.push(rootDir);

  const config: AppConfig = {
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

  const db = openDatabase(config.paths.databasePath);
  const eventsRepo = new EventsRepo(db);
  const store = new ReadModelStore(
    config,
    new ChatsRepo(db),
    new ContactsRepo(db),
    new MessagesRepo(db)
  );

  const runtime = new DaemonRuntime(
    config,
    eventsRepo,
    new WebhooksRepo(db),
    new WebhookDeliveriesRepo(db),
    new EventBus(),
    silentLogger,
    new SessionsRepo(db),
    store
  );

  return { config, runtime };
}

describe("DaemonRuntime writeRuntimeFile", () => {
  it("grava version e executable junto de pid/startedAt/host/port", async () => {
    const { config, runtime } = createRuntime();

    await runtime.bootstrap();

    const file = JSON.parse(readFileSync(config.paths.runtimePath, "utf8"));
    expect(file).toEqual({
      pid: process.pid,
      startedAt: expect.any(String),
      host: "127.0.0.1",
      port: 43119,
      version: pkg.version,
      executable: process.execPath
    });
  });

  it("mantem o runtime file legivel pelo guard legado", async () => {
    const { config, runtime } = createRuntime();

    await runtime.bootstrap();

    const read = readRuntimeFile(config.paths.runtimePath);
    expect(read.status).toBe("readable");
    if (read.status === "readable") {
      expect(read.file.pid).toBe(process.pid);
      expect(read.file.version).toBe(pkg.version);
    }
  });
});
