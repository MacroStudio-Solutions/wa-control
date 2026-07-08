import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WAMessage } from "@whiskeysockets/baileys";
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
    store
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
});
