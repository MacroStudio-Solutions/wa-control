import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRecord } from "../shared/types.ts";
import { ChatsRepo, decodeChatCursor, encodeChatCursor } from "./chatsRepo.ts";
import { openDatabase } from "./db.ts";

const tempDirs: string[] = [];
const T0 = 1_785_849_522;

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function chat(id: string, conversationTimestamp: number | null, over: Partial<ChatRecord> = {}): ChatRecord {
  return {
    sessionId: "loja",
    id,
    lookupKey: null,
    lookupJid: null,
    phoneNumber: null,
    name: null,
    type: "direct",
    conversationTimestamp,
    lastMessageRecvTimestamp: null,
    unreadCount: 0,
    lastMessageId: null,
    lastMessageType: null,
    lastMessageText: null,
    lastMessageTimestamp: null,
    updatedAt: new Date().toISOString(),
    ...over
  };
}

function openRepo() {
  const dir = mkdtempSync(join(tmpdir(), "wa-control-chats-"));
  tempDirs.push(dir);
  const db = openDatabase(join(dir, "app.sqlite"));
  return { db, repo: new ChatsRepo(db) };
}

describe("ChatsRepo.list paginado", () => {
  it("encadeia paginas pelo cursor sem repetir nem pular, na ordem de sempre", () => {
    const { db, repo } = openRepo();
    try {
      for (let i = 0; i < 7; i += 1) {
        repo.upsert(chat(`55629000000${i}@s.whatsapp.net`, T0 - i * 60));
      }
      repo.upsert(chat("empate-b@s.whatsapp.net", T0 - 120));
      repo.upsert(chat("status@broadcast", T0 + 999, { type: "status" }));

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const rows = repo.list("loja", 3, cursor === undefined ? undefined : decodeChatCursor(cursor));
        if (rows.length === 0) {
          break;
        }
        seen.push(...rows.map((row) => row.id));
        cursor = rows.at(-1)?.cursor;
      }

      expect(seen).toEqual(repo.list("loja", 100).map((row) => row.id));
      expect(new Set(seen).size).toBe(8);
      expect(seen).not.toContain("status@broadcast");
      expect(seen.indexOf("556290000002@s.whatsapp.net")).toBeLessThan(seen.indexOf("empate-b@s.whatsapp.net"));
    } finally {
      db.close();
    }
  });

  it("conversa nova no topo entre as paginas nao repete conversa na pagina seguinte", () => {
    const { db, repo } = openRepo();
    try {
      for (let i = 0; i < 6; i += 1) {
        repo.upsert(chat(`c${i}`, T0 - i * 60));
      }
      const first = repo.list("loja", 3);
      repo.upsert(chat("nova", T0 + 600));
      repo.upsert(chat("c0", T0 + 700));
      const second = repo.list("loja", 3, decodeChatCursor(first.at(-1)?.cursor ?? ""));
      expect(second.map((row) => row.id)).toEqual(["c3", "c4", "c5"]);
    } finally {
      db.close();
    }
  });

  it("chat sem instante fica no fim e tambem pagina", () => {
    const { db, repo } = openRepo();
    try {
      repo.upsert(chat("a", T0));
      repo.upsert(chat("b", null));
      repo.upsert(chat("c", null));
      const first = repo.list("loja", 2);
      expect(first.map((row) => row.id)).toEqual(["a", "b"]);
      const second = repo.list("loja", 2, decodeChatCursor(first[1]?.cursor ?? ""));
      expect(second.map((row) => row.id)).toEqual(["c"]);
    } finally {
      db.close();
    }
  });
});

describe("cursor de chats", () => {
  it("ida e volta; forma desconhecida e INVALID_CURSOR", () => {
    const cursor = encodeChatCursor({ sortKey: T0, id: "5562@s.whatsapp.net" });
    expect(decodeChatCursor(cursor)).toEqual({ sortKey: T0, id: "5562@s.whatsapp.net" });
    for (const bad of ["", "offset:10", "c1.", "c1.@@@", `c1.${Buffer.from("[1]").toString("base64url")}`]) {
      expect(() => decodeChatCursor(bad)).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
    }
  });
});
