import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import { downloadIncomingMedia } from "../media/mediaDownload.ts";
import type { Logger } from "../shared/logger.ts";
import type { AppConfig, MessageRecord } from "../shared/types.ts";
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

/** O que o `sendMessage` do Baileys devolve para o envio: o WebMessageInfo enviado. */
function sentProto(id: string, content: Record<string, unknown>): WAMessage {
  return {
    key: {
      remoteJid: "556784020665@s.whatsapp.net",
      fromMe: true,
      id
    },
    messageTimestamp: 1_783_507_500,
    message: content
  } as unknown as WAMessage;
}

function createHarness(sendResult: WAMessage) {
  const rootDir = mkdtempSync(join(tmpdir(), "wa-control-managed-send-"));
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

  (managed as unknown as { socket: unknown }).socket = {
    sendMessage: async () => sendResult
  };

  return { db, managed, eventsRepo, readModel };
}

function requireMessage(find: () => MessageRecord | null): MessageRecord {
  const record = find();
  if (!record) {
    throw new Error("esperava a mensagem projetada no read model");
  }

  return record;
}

describe("ManagedSession — envio guarda o conteudo devolvido pelo sendMessage", () => {
  it("midia enviada: o evento message.sent carrega o payload bruto e ele baixa depois", async () => {
    const raw = sentProto("3EB0SENTIMG", {
      imageMessage: {
        mimetype: "image/jpeg",
        caption: "olha isso",
        fileLength: 3,
        mediaKey: new Uint8Array([9, 8, 7]),
        directPath: "/v/t62.sent"
      }
    });
    const harness = createHarness(raw);

    try {
      const response = await harness.managed.sendMediaMessage(
        { to: "556784020665@s.whatsapp.net", kind: "image", mimeType: "image/jpeg" },
        new Uint8Array([1, 2, 3])
      );
      expect(response.messageId).toBe("3EB0SENTIMG");

      const event = harness.eventsRepo.findMessageRawPayload("pessoal", "3EB0SENTIMG");
      expect(event).not.toBeNull();
      expect(event?.event).toBe("message.sent");

      const rawStored = event?.raw as unknown as WAMessage;
      const content = rawStored.message as Record<string, Record<string, unknown>>;
      expect(content.imageMessage?.mimetype).toBe("image/jpeg");
      expect(Array.from(content.imageMessage?.mediaKey as Uint8Array)).toEqual([9, 8, 7]);

      const record = requireMessage(() =>
        harness.readModel.findMessage("pessoal", "556784020665", "3EB0SENTIMG")
      );
      expect(record.fromMe).toBe(true);

      const download = await downloadIncomingMedia({
        record,
        raw: rawStored,
        fetchMedia: async () => new Uint8Array([1, 2, 3])
      });

      expect(download.kind).toBe("image");
      expect(download.mimeType).toBe("image/jpeg");
      expect(download.size).toBe(3);
    } finally {
      harness.db.close();
    }
  });

  it("texto enviado tambem guarda o conteudo devolvido no evento message.sent", async () => {
    const harness = createHarness(sentProto("3EB0SENTTXT", { conversation: "Bom dia" }));

    try {
      const response = await harness.managed.sendTextMessage("556784020665@s.whatsapp.net", "Bom dia");
      expect(response.messageId).toBe("3EB0SENTTXT");

      const event = harness.eventsRepo.findMessageRawPayload("pessoal", "3EB0SENTTXT");
      expect(event).not.toBeNull();

      const rawStored = event?.raw as unknown as WAMessage;
      expect(rawStored.message).toEqual({ conversation: "Bom dia" });
    } finally {
      harness.db.close();
    }
  });
});
