import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WAMessage } from "@whiskeysockets/baileys";
import { normalizeIncomingMessage } from "../baileys/normalizeMessage.ts";
import { ChatsRepo } from "../storage/chatsRepo.ts";
import { ContactsRepo } from "../storage/contactsRepo.ts";
import { openDatabase } from "../storage/db.ts";
import { MessagesRepo } from "../storage/messagesRepo.ts";
import { ReadModelStore } from "./store.ts";
import type { AppConfig } from "../shared/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});

function createFixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "wa-control-read-model-"));
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
  writeFileSync(join(authDir, "lid-mapping-556784020665.json"), "\"88356755087579\"\n");
  writeFileSync(join(authDir, "lid-mapping-88356755087579_reverse.json"), "\"556784020665\"\n");

  const db = openDatabase(config.paths.databasePath);
  const store = new ReadModelStore(
    config,
    new ChatsRepo(db),
    new ContactsRepo(db),
    new MessagesRepo(db)
  );

  return {
    db,
    store,
    authDir
  };
}

describe("read model store", () => {
  it("projects direct messages using LID mappings", () => {
    const { db, store } = createFixture();

    try {
      const rawMessage = {
        key: {
          remoteJid: "88356755087579@lid",
          fromMe: false,
          id: "msg-1"
        },
        pushName: "Priscila Leite",
        messageTimestamp: 1783506977,
        message: {
          conversation: "Bom dia"
        }
      } as unknown as WAMessage;

      store.upsertSocketMessage("pessoal", rawMessage, "notify");
      store.recordSentTextMessage(
        "pessoal",
        "556784020665@s.whatsapp.net",
        "Resposta",
        "msg-2",
        1783507000
      );

      const contacts = store.listContacts("pessoal", 10);
      const chats = store.listChats("pessoal", 10);
      const messages = store.listMessages("pessoal", "556784020665", 10);

      expect(contacts).toHaveLength(1);
      expect(contacts[0]?.phoneNumber).toBe("556784020665");
      expect(contacts[0]?.notify).toBe("Priscila Leite");

      expect(chats).toHaveLength(1);
      expect(chats[0]?.phoneNumber).toBe("556784020665");
      expect(chats[0]?.lastMessageText).toBe("Resposta");

      expect(messages.map((message) => message.id)).toEqual(["msg-2", "msg-1"]);
      expect(messages[0]?.fromMe).toBe(true);
      expect(messages[1]?.fromMe).toBe(false);
      expect(messages[1]?.text).toBe("Bom dia");
    } finally {
      db.close();
    }
  });

  it("projects history-sync messages with the same vocabulary as the live event", () => {
    const { db, store, authDir } = createFixture();

    try {
      const cases: Array<{
        name: string;
        payload: Record<string, unknown>;
        type: string;
        text: string | null;
        rawMessageType: string | null;
      }> = [
        {
          name: "envelope viewOnce",
          payload: { viewOnceMessage: { message: { conversation: "So da pra ler uma vez" } } },
          type: "text",
          text: "So da pra ler uma vez",
          rawMessageType: "conversation"
        },
        {
          name: "envelope efemero com midia",
          payload: { ephemeralMessage: { message: { imageMessage: { caption: "Efemera" } } } },
          type: "image",
          text: "Efemera",
          rawMessageType: "imageMessage"
        },
        {
          name: "midia sem caption",
          payload: { imageMessage: { mimetype: "image/jpeg" } },
          type: "image",
          text: null,
          rawMessageType: "imageMessage"
        },
        {
          name: "reacao com emoji como conteudo",
          payload: { reactionMessage: { text: "👍", key: { id: "reagida" } } },
          type: "reaction",
          text: "👍",
          rawMessageType: "reactionMessage"
        },
        {
          name: "tipo nao mapeado passa a chave crua",
          payload: { protocolMessage: { type: 15, key: { id: "proto-1" } } },
          type: "protocolMessage",
          text: null,
          rawMessageType: "protocolMessage"
        }
      ];

      cases.forEach((testCase, index) => {
        const rawMessage = {
          key: {
            remoteJid: "556784020665@s.whatsapp.net",
            fromMe: false,
            id: `history-${index}`
          },
          messageTimestamp: 1783506977 + index,
          message: testCase.payload
        } as unknown as WAMessage;

        const event = normalizeIncomingMessage("pessoal", rawMessage, authDir);

        store.upsertSocketMessage("pessoal", rawMessage, "history");

        const stored = store
          .listMessages("pessoal", "556784020665", 50)
          .find((message) => message.id === `history-${index}`);

        expect(stored, testCase.name).toBeDefined();
        expect(stored?.messageType, testCase.name).toBe(testCase.type);
        expect(stored?.text, testCase.name).toBe(testCase.text);
        expect(stored?.rawMessageType, testCase.name).toBe(testCase.rawMessageType);

        expect(event?.type, testCase.name).toBe(stored?.messageType);
        expect(event?.text, testCase.name).toBe(stored?.text);
        expect(event?.rawMessageType, testCase.name).toBe(stored?.rawMessageType);
      });
    } finally {
      db.close();
    }
  });

  it("status ack without content does not clobber the stored message", () => {
    const { db, store } = createFixture();

    try {
      const handlers: Record<string, (payload: unknown) => void> = {};
      const sock = {
        ev: {
          on: (name: string, handler: (payload: never) => void) => {
            handlers[name] = handler as (payload: unknown) => void;
          }
        }
      };
      store.bindSocket("pessoal", sock as unknown as never);

      store.recordSentTextMessage(
        "pessoal",
        "556784746428@s.whatsapp.net",
        "Teste rollout",
        "msg-ack-1",
        1783507100
      );

      const applyUpdate = handlers["messages.update"];
      expect(applyUpdate).toBeDefined();

      applyUpdate?.([
        {
          key: {
            remoteJid: "556784746428@s.whatsapp.net",
            fromMe: true,
            id: "msg-ack-1"
          },
          update: {
            status: 2
          }
        }
      ]);

      const stored = store
        .listMessages("pessoal", "556784746428", 10)
        .find((message) => message.id === "msg-ack-1");

      expect(stored).toBeDefined();
      expect(stored?.messageType).toBe("text");
      expect(stored?.text).toBe("Teste rollout");
      expect(stored?.status).toBe("2");

      applyUpdate?.([
        {
          key: {
            remoteJid: "556784746428@s.whatsapp.net",
            fromMe: true,
            id: "msg-ack-1"
          },
          update: {
            status: 3,
            message: {
              protocolMessage: { type: 15, key: { id: "msg-ack-1" } }
            }
          }
        }
      ]);

      const retracted = store
        .listMessages("pessoal", "556784746428", 10)
        .find((message) => message.id === "msg-ack-1");

      expect(retracted?.messageType).toBe("protocolMessage");
      expect(retracted?.status).toBe("3");
    } finally {
      db.close();
    }
  });

  it("records a sent media message with the media kind and caption as text", () => {
    const { db, store } = createFixture();

    try {
      store.recordSentMediaMessage(
        "pessoal",
        "556784020665@s.whatsapp.net",
        "image",
        "Veja isso",
        "3EB0IMG",
        1_783_507_200
      );

      const stored = store
        .listMessages("pessoal", "556784020665", 10)
        .find((message) => message.id === "3EB0IMG");

      expect(stored).toBeDefined();
      expect(stored?.fromMe).toBe(true);
      expect(stored?.messageType).toBe("image");
      expect(stored?.text).toBe("Veja isso");

      const chat = store.listChats("pessoal", 10)[0];
      expect(chat?.lastMessageId).toBe("3EB0IMG");
      expect(chat?.lastMessageType).toBe("image");
    } finally {
      db.close();
    }
  });

  it("records a sent audio message without caption as null text", () => {
    const { db, store } = createFixture();

    try {
      store.recordSentMediaMessage(
        "pessoal",
        "556784020665@s.whatsapp.net",
        "audio",
        null,
        "3EB0AUD",
        1_783_507_300
      );

      const stored = store
        .listMessages("pessoal", "556784020665", 10)
        .find((message) => message.id === "3EB0AUD");

      expect(stored?.messageType).toBe("audio");
      expect(stored?.text).toBeNull();
    } finally {
      db.close();
    }
  });

  it("replays a message.sent media event back into the read model", () => {
    const { db, store } = createFixture();

    try {
      store.replayEvents([
        {
          id: "evt-1",
          event: "message.sent",
          sessionId: "pessoal",
          timestamp: 1_783_507_400,
          messageId: "3EB0REPLAY",
          chatId: "556784020665@s.whatsapp.net",
          to: "556784020665@s.whatsapp.net",
          kind: "image",
          mimeType: "image/jpeg",
          text: "Legenda da foto"
        }
      ]);

      const stored = store
        .listMessages("pessoal", "556784020665", 10)
        .find((message) => message.id === "3EB0REPLAY");

      expect(stored).toBeDefined();
      expect(stored?.fromMe).toBe(true);
      expect(stored?.messageType).toBe("image");
      expect(stored?.text).toBe("Legenda da foto");
    } finally {
      db.close();
    }
  });

  it("replays a text message.sent event exactly as before", () => {
    const { db, store } = createFixture();

    try {
      store.replayEvents([
        {
          id: "evt-2",
          event: "message.sent",
          sessionId: "pessoal",
          timestamp: 1_783_507_500,
          messageId: "3EB0TXT",
          chatId: "556784020665@s.whatsapp.net",
          to: "556784020665@s.whatsapp.net",
          text: "Texto puro"
        }
      ]);

      const stored = store
        .listMessages("pessoal", "556784020665", 10)
        .find((message) => message.id === "3EB0TXT");

      expect(stored?.messageType).toBe("text");
      expect(stored?.text).toBe("Texto puro");
    } finally {
      db.close();
    }
  });
});
