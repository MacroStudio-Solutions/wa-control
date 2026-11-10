import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisconnectReason, type ConnectionState } from "@whiskeysockets/baileys";
import type { Logger } from "../shared/logger.ts";
import type { AppConfig, SessionRecord } from "../shared/types.ts";
import { ChatsRepo } from "../storage/chatsRepo.ts";
import { ContactsRepo } from "../storage/contactsRepo.ts";
import { openDatabase } from "../storage/db.ts";
import { EventsRepo } from "../storage/eventsRepo.ts";
import { MessagesRepo } from "../storage/messagesRepo.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import { ReadModelStore } from "../read-model/store.ts";
import { EventBus } from "./eventBus.ts";
import { EventPublisher } from "./eventPublisher.ts";
import { ManagedSession } from "./managedSession.ts";

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

type ManagedSessionInternals = {
  handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void>;
  scheduleReconnect(delay: number): void;
};

function internals(session: ManagedSession): ManagedSessionInternals {
  return session as unknown as ManagedSessionInternals;
}

function streamError(reason: string, statusCode: number): Error {
  return Object.assign(new Error(`Stream Errored (${reason})`), {
    output: { statusCode }
  });
}

function closeError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), {
    output: { statusCode }
  });
}

function createHarness() {
  const rootDir = mkdtempSync(join(tmpdir(), "wa-control-managed-disconnect-"));
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

  const authDir = join(config.paths.sessionsDir, "pessoal", "auth");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, "creds.json"), "{\"me\":null}");

  const db = openDatabase(config.paths.databasePath);
  const eventsRepo = new EventsRepo(db);
  const sessionsRepo = new SessionsRepo(db);
  const publisher = new EventPublisher(eventsRepo, new EventBus(), silentLogger);
  const readModel = new ReadModelStore(
    config,
    new ChatsRepo(db),
    new ContactsRepo(db),
    new MessagesRepo(db)
  );

  const now = new Date().toISOString();
  const record = sessionsRepo.save({
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

  const managed = new ManagedSession(
    config,
    sessionsRepo,
    publisher,
    silentLogger,
    readModel,
    record
  );

  const scheduled: number[] = [];
  internals(managed).scheduleReconnect = (delay: number) => {
    scheduled.push(delay);
  };

  return {
    managed,
    scheduled,
    authDir,
    closeFile: join(authDir, "creds.json"),
    current: () => sessionsRepo.get("pessoal") as SessionRecord
  };
}

async function simulateClose(
  harness: ReturnType<typeof createHarness>,
  error: Error
): Promise<void> {
  await internals(harness.managed).handleConnectionUpdate({
    connection: "close",
    lastDisconnect: { error }
  } as unknown as Partial<ConnectionState>);
}

describe("ManagedSession — fechamento de conexao", () => {
  it("stream error com motivo desconhecido reconecta sem apagar a credencial", async () => {
    const harness = createHarness();

    await simulateClose(harness, streamError("ack", DisconnectReason.badSession));

    expect(harness.scheduled).toEqual([1000]);
    const record = harness.current();
    expect(record.status).toBe("reconnecting");
    expect(record.active).toBe(true);
    expect(record.reconnectAttempts).toBe(1);
    expect(existsSync(harness.closeFile)).toBe(true);
  });

  it("reconecta com backoff limitado e, esgotadas as tentativas sem falha comprovada, mantem a credencial", async () => {
    const harness = createHarness();

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await simulateClose(harness, streamError("ack", DisconnectReason.badSession));
      expect(harness.scheduled.length).toBe(attempt);
    }

    await simulateClose(harness, streamError("ack", DisconnectReason.badSession));

    expect(harness.scheduled.length).toBe(8);
    const record = harness.current();
    expect(record.status).toBe("disconnected");
    expect(record.active).toBe(false);
    expect(existsSync(harness.closeFile)).toBe(true);
  });

  it("esgotadas as tentativas com falha de autenticacao comprovada apaga a credencial", async () => {
    const harness = createHarness();

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await simulateClose(harness, streamError("not-authorized", DisconnectReason.badSession));
    }

    expect(harness.scheduled.length).toBe(8);
    const record = harness.current();
    expect(record.status).toBe("disconnected");
    expect(record.active).toBe(false);
    expect(existsSync(harness.closeFile)).toBe(false);
  });

  it("loggedOut apaga a credencial na hora", async () => {
    const harness = createHarness();

    await simulateClose(harness, closeError("Connection Closed", DisconnectReason.loggedOut));

    expect(harness.scheduled).toEqual([]);
    const record = harness.current();
    expect(record.status).toBe("disconnected");
    expect(record.active).toBe(false);
    expect(existsSync(harness.closeFile)).toBe(false);
  });

  it("connectionReplaced continua terminal sem apagar a credencial", async () => {
    const harness = createHarness();

    await simulateClose(
      harness,
      closeError("Stream Errored (conflict)", DisconnectReason.connectionReplaced)
    );

    expect(harness.scheduled).toEqual([]);
    const record = harness.current();
    expect(record.status).toBe("error");
    expect(record.active).toBe(false);
    expect(existsSync(harness.closeFile)).toBe(true);
  });

  it("multideviceMismatch continua terminal e continua apagando a credencial", async () => {
    const harness = createHarness();

    await simulateClose(
      harness,
      closeError("Connection Closed", DisconnectReason.multideviceMismatch)
    );

    expect(harness.scheduled).toEqual([]);
    const record = harness.current();
    expect(record.status).toBe("disconnected");
    expect(record.active).toBe(false);
    expect(existsSync(harness.closeFile)).toBe(false);
  });

  it("motivos que ja reconectavam continuam reconectando sem limite", async () => {
    const harness = createHarness();

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      await simulateClose(
        harness,
        closeError("Connection Closed", DisconnectReason.restartRequired)
      );
    }

    expect(harness.scheduled.length).toBe(12);
    const record = harness.current();
    expect(record.status).toBe("reconnecting");
    expect(record.active).toBe(true);
    expect(existsSync(harness.closeFile)).toBe(true);
  });
});
