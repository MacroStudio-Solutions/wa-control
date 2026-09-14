import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import { normalizeIncomingMessage } from "../baileys/normalizeMessage.ts";
import { isAppError } from "../shared/errors.ts";
import type { AppConfig } from "../shared/types.ts";
import { ChatsRepo } from "../storage/chatsRepo.ts";
import { ContactsRepo } from "../storage/contactsRepo.ts";
import { openDatabase } from "../storage/db.ts";
import { EventsRepo } from "../storage/eventsRepo.ts";
import { MessagesRepo } from "../storage/messagesRepo.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import { WebhookDeliveriesRepo } from "../storage/webhookDeliveriesRepo.ts";
import { WebhooksRepo } from "../storage/webhooksRepo.ts";
import { EventBus } from "./eventBus.ts";
import { DaemonRuntime } from "./daemonRuntime.ts";
import { ReadModelStore } from "../read-model/store.ts";
import type { Logger } from "../shared/logger.ts";

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

function createRuntime(options: { fetchMedia?: (message: WAMessage) => Promise<Uint8Array> } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "wa-control-daemon-media-"));
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

  const db = openDatabase(config.paths.databasePath);
  const store = new ReadModelStore(
    config,
    new ChatsRepo(db),
    new ContactsRepo(db),
    new MessagesRepo(db)
  );
  const eventsRepo = new EventsRepo(db);
  const sessionsRepo = new SessionsRepo(db);

  const runtime = new DaemonRuntime(
    config,
    eventsRepo,
    new WebhooksRepo(db),
    new WebhookDeliveriesRepo(db),
    new EventBus(),
    silentLogger,
    sessionsRepo,
    store,
    options.fetchMedia ?? (async () => new Uint8Array([1, 2, 3]))
  );

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

  return { db, runtime, store, eventsRepo, authDir };
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

function seedLiveMessage(fixture: ReturnType<typeof createRuntime>, raw: WAMessage): void {
  fixture.store.upsertSocketMessage("pessoal", raw, "notify");
  const event = normalizeIncomingMessage("pessoal", raw, fixture.authDir, true);
  if (event) {
    fixture.eventsRepo.append(event);
  }
}

async function captureError(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }

  throw new Error("esperava que a operacao falhasse");
}

describe("DaemonRuntime.downloadMedia", () => {
  it("resolve mensagem ao vivo por chat+messageId, baixa e devolve metadados", async () => {
    const fixture = createRuntime();
    try {
      seedLiveMessage(fixture, rawImageMessage("3EB0IMG"));

      const result = await fixture.runtime.downloadMedia("pessoal", "556784020665", "3EB0IMG");

      expect(result.record.id).toBe("3EB0IMG");
      expect(result.download.kind).toBe("image");
      expect(result.download.mimeType).toBe("image/jpeg");
      expect(result.download.size).toBe(3);
      expect(Array.from(result.download.buffer)).toEqual([1, 2, 3]);
    } finally {
      fixture.db.close();
    }
  });

  it("aceita numero e jid como referencia de chat, como messages faz", async () => {
    const fixture = createRuntime();
    try {
      seedLiveMessage(fixture, rawImageMessage("3EB0IMG"));

      const byNumber = await fixture.runtime.downloadMedia("pessoal", "556784020665", "3EB0IMG");
      const byJid = await fixture.runtime.downloadMedia(
        "pessoal",
        "556784020665@s.whatsapp.net",
        "3EB0IMG"
      );

      expect(byNumber.record.id).toBe("3EB0IMG");
      expect(byJid.record.id).toBe("3EB0IMG");
    } finally {
      fixture.db.close();
    }
  });

  it("mensagem inexistente no chat vira MESSAGE_NOT_FOUND antes do fetch", async () => {
    const fixture = createRuntime();
    try {
      const error = (await captureError(
        fixture.runtime.downloadMedia("pessoal", "556784020665", "NAO-EXISTE")
      )) as Error;

      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe("MESSAGE_NOT_FOUND");
      }
    } finally {
      fixture.db.close();
    }
  });

  it("mensagem de history-sync sem payload bruto vira MEDIA_PAYLOAD_UNAVAILABLE com orientacao de reenvio", async () => {
    const fixture = createRuntime();
    try {
      fixture.store.upsertSocketMessage("pessoal", rawImageMessage("3EB0HIST"), "history");

      const error = (await captureError(
        fixture.runtime.downloadMedia("pessoal", "556784020665", "3EB0HIST")
      )) as Error;

      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe("MEDIA_PAYLOAD_UNAVAILABLE");
        expect(error.message).toContain("history-sync");
        expect(error.message).toContain("Peca o reenvio");
      }
    } finally {
      fixture.db.close();
    }
  });

  it("mensagem de texto com payload bruto vira NOT_MEDIA antes do fetch", async () => {
    const fixture = createRuntime();
    try {
      seedLiveMessage(fixture, {
        key: { remoteJid: "556784020665@s.whatsapp.net", fromMe: false, id: "3EB0TXT" },
        pushName: "Priscila",
        messageTimestamp: 1_783_506_977,
        message: { conversation: "Bom dia" }
      } as unknown as WAMessage);

      const error = (await captureError(
        fixture.runtime.downloadMedia("pessoal", "556784020665", "3EB0TXT")
      )) as Error;

      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe("NOT_MEDIA");
      }
    } finally {
      fixture.db.close();
    }
  });

  it("tipo nao liberado vira MEDIA_TYPE_NOT_SUPPORTED_YET antes do fetch", async () => {
    const fixture = createRuntime();
    try {
      seedLiveMessage(fixture, {
        key: { remoteJid: "556784020665@s.whatsapp.net", fromMe: false, id: "3EB0VID" },
        pushName: "Priscila",
        messageTimestamp: 1_783_506_977,
        message: { videoMessage: { mimetype: "video/mp4" } }
      } as unknown as WAMessage);

      const error = (await captureError(
        fixture.runtime.downloadMedia("pessoal", "556784020665", "3EB0VID")
      )) as Error;

      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe("MEDIA_TYPE_NOT_SUPPORTED_YET");
      }
    } finally {
      fixture.db.close();
    }
  });

  it("falha do fetch upstream vira DOWNLOAD_FAILED, sem retry automatico", async () => {
    const fixture = createRuntime({
      fetchMedia: async () => {
        throw new Error("410 Gone");
      }
    });
    try {
      seedLiveMessage(fixture, rawImageMessage("3EB0OLD"));

      const error = (await captureError(
        fixture.runtime.downloadMedia("pessoal", "556784020665", "3EB0OLD")
      )) as Error;

      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe("DOWNLOAD_FAILED");
        expect(error.message).toContain("410 Gone");
        expect(error.message).toContain("expirado");
      }
    } finally {
      fixture.db.close();
    }
  });

  it("sessao desconhecida vira SESSION_NOT_FOUND", async () => {
    const fixture = createRuntime();
    try {
      const error = (await captureError(
        fixture.runtime.downloadMedia("fantasma", "556784020665", "3EB0IMG")
      )) as Error;

      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe("SESSION_NOT_FOUND");
      }
    } finally {
      fixture.db.close();
    }
  });
});
