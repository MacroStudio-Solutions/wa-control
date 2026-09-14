import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import { normalizeIncomingMessage } from "../baileys/normalizeMessage.ts";
import { readOrCreateLocalToken } from "../config/token.ts";
import type { Logger } from "../shared/logger.ts";
import type { AppConfig } from "../shared/types.ts";
import { ChatsRepo } from "../storage/chatsRepo.ts";
import { ContactsRepo } from "../storage/contactsRepo.ts";
import { openDatabase } from "../storage/db.ts";
import { EventsRepo } from "../storage/eventsRepo.ts";
import { MessagesRepo } from "../storage/messagesRepo.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import { WebhookDeliveriesRepo } from "../storage/webhookDeliveriesRepo.ts";
import { WebhooksRepo } from "../storage/webhooksRepo.ts";
import { DaemonRuntime } from "../daemon/daemonRuntime.ts";
import { EventBus } from "../daemon/eventBus.ts";
import { startLocalApiServer } from "../daemon/localApi.ts";
import { ReadModelStore } from "../read-model/store.ts";

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

interface TestDaemon {
  dataDir: string;
  port: number;
  server: ReturnType<typeof startLocalApiServer>;
  db: ReturnType<typeof openDatabase>;
  fetchCalls: () => number;
}

async function startTestDaemon(
  fetchMedia: (message: WAMessage) => Promise<Uint8Array>
): Promise<TestDaemon> {
  const dataDir = mkdtempSync(join(tmpdir(), "wa-control-cli-media-"));
  tempDirs.push(dataDir);

  const sessionsDir = join(dataDir, "sessions");
  const authDir = join(sessionsDir, "pessoal", "auth");
  mkdirSync(authDir, { recursive: true });

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = 43_200 + Math.floor(Math.random() * 20_000);
    const config: AppConfig = {
      host: "127.0.0.1",
      port,
      logLevel: "info",
      paths: {
        rootDir: dataDir,
        configPath: join(dataDir, "config.json"),
        databasePath: join(dataDir, "app.sqlite"),
        runtimePath: join(dataDir, "runtime.json"),
        sessionsDir,
        tokenPath: join(dataDir, "token")
      }
    };

    const db = openDatabase(config.paths.databasePath);
    const store = new ReadModelStore(
      config,
      new ChatsRepo(db),
      new ContactsRepo(db),
      new MessagesRepo(db)
    );
    const eventsRepo = new EventsRepo(db);
    const sessionsRepo = new SessionsRepo(db);

    const now = new Date().toISOString();
    sessionsRepo.save({
      id: "pessoal",
      status: "connected",
      createdAt: now,
      updatedAt: now,
      phoneNumber: "556784020665",
      lastError: null,
      active: true,
      lastConnectedAt: now,
      reconnectAttempts: 0,
      qr: null
    });

    let fetchCount = 0;
    const runtime = new DaemonRuntime(
      config,
      eventsRepo,
      new WebhooksRepo(db),
      new WebhookDeliveriesRepo(db),
      new EventBus(),
      silentLogger,
      sessionsRepo,
      store,
      async (message) => {
        fetchCount++;
        return fetchMedia(message);
      }
    );

    const token = readOrCreateLocalToken(config);

    try {
      const server = startLocalApiServer({
        runtime,
        token,
        eventBus: runtime.bus,
        logger: silentLogger
      });

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      if (!health.ok) {
        throw new Error(`health check falhou com HTTP ${health.status}`);
      }

      return {
        dataDir,
        port,
        server,
        db,
        fetchCalls: () => fetchCount
      };
    } catch (error) {
      lastError = error;
      db.close();
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("nao foi possivel iniciar o daemon de teste");
}

function rawImageMessage(id: string): WAMessage {
  return {
    key: {
      remoteJid: "556784020665@s.whatsapp.net",
      fromMe: false,
      id
    },
    pushName: "Priscila",
    messageTimestamp: 1_783_506_977,
    message: {
      imageMessage: {
        mimetype: "image/jpeg",
        caption: "olha isso",
        fileLength: 42
      }
    }
  } as unknown as WAMessage;
}

function rawTextMessage(id: string): WAMessage {
  return {
    key: {
      remoteJid: "556784020665@s.whatsapp.net",
      fromMe: false,
      id
    },
    pushName: "Priscila",
    messageTimestamp: 1_783_506_977,
    message: { conversation: "Bom dia" }
  } as unknown as WAMessage;
}

function seedLiveMessage(daemon: TestDaemon, db: ReturnType<typeof openDatabase>, raw: WAMessage): void {
  const config: AppConfig = {
    host: "127.0.0.1",
    port: daemon.port,
    logLevel: "info",
    paths: {
      rootDir: daemon.dataDir,
      configPath: join(daemon.dataDir, "config.json"),
      databasePath: join(daemon.dataDir, "app.sqlite"),
      runtimePath: join(daemon.dataDir, "runtime.json"),
      sessionsDir: join(daemon.dataDir, "sessions"),
      tokenPath: join(daemon.dataDir, "token")
    }
  };
  const store = new ReadModelStore(
    config,
    new ChatsRepo(db),
    new ContactsRepo(db),
    new MessagesRepo(db)
  );
  const eventsRepo = new EventsRepo(db);

  store.upsertSocketMessage("pessoal", raw, "notify");
  const event = normalizeIncomingMessage(
    "pessoal",
    raw,
    join(daemon.dataDir, "sessions", "pessoal", "auth"),
    true
  );
  if (event) {
    eventsRepo.append(event);
  }
}

async function runCli(args: string[], daemon: TestDaemon) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/main.ts"), ...args], {
    cwd: daemon.dataDir,
    env: {
      ...process.env,
      WA_CONTROL_DATA_DIR: daemon.dataDir,
      WA_CONTROL_PORT: String(daemon.port)
    },
    stdout: "pipe",
    stderr: "pipe"
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { exitCode, stdout, stderr };
}

describe("download-media no CLI (ponta a ponta com daemon real)", () => {
  it(
    "NOT_MEDIA: mensagem de texto sai com exit 1 ANTES do fetch, sem arquivo escrito",
    async () => {
      const daemon = await startTestDaemon(async () => {
        throw new Error("fetch nao deveria ser acionado");
      });
      const db = daemon.db;
      try {
        seedLiveMessage(daemon, db, rawTextMessage("3EB0CLI-TXT"));

        const outPath = join(daemon.dataDir, "saida.txt");
        const { exitCode, stdout, stderr } = await runCli(
          [
            "download-media",
            "pessoal",
            "556784020665",
            "3EB0CLI-TXT",
            "--out",
            outPath
          ],
          daemon
        );

        expect(exitCode).toBe(1);
        expect(stderr).toContain("nao e midia");
        expect(stdout).not.toContain("Midia baixada");
        expect(daemon.fetchCalls()).toBe(0);
        expect(existsSync(outPath)).toBe(false);
      } finally {
        daemon.server.stop(true);
        db.close();
      }
    },
    20_000
  );

  it(
    "DOWNLOAD_FAILED: fetch upstream falhando sai com exit 1, UMA unica tentativa e orientacao de midia expirada",
    async () => {
      const daemon = await startTestDaemon(async () => {
        throw new Error("410 Gone");
      });
      const db = daemon.db;
      try {
        seedLiveMessage(daemon, db, rawImageMessage("3EB0CLI-OLD"));

        const outPath = join(daemon.dataDir, "saida.jpg");
        const { exitCode, stdout, stderr } = await runCli(
          [
            "download-media",
            "pessoal",
            "556784020665",
            "3EB0CLI-OLD",
            "--out",
            outPath
          ],
          daemon
        );

        expect(exitCode).toBe(1);
        expect(stderr).toContain("410 Gone");
        expect(stderr).toContain("expirado");
        expect(stdout).not.toContain("Midia baixada");
        expect(daemon.fetchCalls()).toBe(1);
        expect(existsSync(outPath)).toBe(false);
      } finally {
        daemon.server.stop(true);
        db.close();
      }
    },
    20_000
  );

  it(
    "caminho feliz: exit 0, arquivo gravado em --out e stdout confirmando tipo, MIME e tamanho",
    async () => {
      const daemon = await startTestDaemon(async () => new Uint8Array([1, 2, 3, 4]));
      const db = daemon.db;
      try {
        seedLiveMessage(daemon, db, rawImageMessage("3EB0CLI-OK"));

        const outPath = join(daemon.dataDir, "foto.jpg");
        const { exitCode, stdout, stderr } = await runCli(
          [
            "download-media",
            "pessoal",
            "556784020665",
            "3EB0CLI-OK",
            "--out",
            outPath
          ],
          daemon
        );

        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
        expect(stdout).toContain("image (image/jpeg)");
        expect(stdout).toContain("4 bytes");
        expect(stdout).toContain(outPath);
        expect(existsSync(outPath)).toBe(true);
      } finally {
        daemon.server.stop(true);
        db.close();
      }
    },
    20_000
  );
});


