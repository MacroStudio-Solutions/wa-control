import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageRecord, NormalizedEvent } from "../shared/types.ts";
import { openDatabase } from "./db.ts";
import { EventsRepo } from "./eventsRepo.ts";
import { MessagesRepo } from "./messagesRepo.ts";
import { repairMessageTimestampsFromEvents } from "./timestampRepair.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SESSION = "loja";
const CHAT = "556784020665@s.whatsapp.net";

// O caso real do defeito: foto, audio, texto e menu do robo enviados em
// minutos diferentes (18:48:43, 18:48:57, 18:49:09, 18:53:18) e uma mensagem
// do cliente, todos gravados com a hora do mesmo aviso de lido (18:54:34).
const foto = 1_794_782_923;
const audio = foto + 14;
const texto = foto + 26;
const menu = foto + 275;
const cliente = foto + 60;
const avisoDeLido = foto + 351;

function isoAt(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function messageRecord(id: string, unixSeconds: number, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    sessionId: SESSION,
    chatJid: CHAT,
    chatLookupKey: null,
    chatLookupJid: null,
    chatPhoneNumber: null,
    id,
    participantJid: CHAT,
    participantLookupKey: null,
    participantLookupJid: null,
    participantPhoneNumber: null,
    senderJid: CHAT,
    senderLookupKey: null,
    senderLookupJid: null,
    senderPhoneNumber: null,
    pushName: null,
    fromMe: true,
    upsertType: "append",
    messageType: "text",
    text: "ola",
    rawMessageType: null,
    status: "4",
    unixSeconds,
    timestamp: isoAt(unixSeconds),
    updatedAt: isoAt(unixSeconds),
    ...overrides
  };
}

function messageSentEvent(messageId: string, timestamp: number): NormalizedEvent {
  return {
    id: crypto.randomUUID(),
    event: "message.sent",
    sessionId: SESSION,
    timestamp,
    messageId,
    chatId: CHAT,
    to: CHAT,
    text: "ola"
  };
}

function messageReceivedEvent(messageId: string, timestamp: number): NormalizedEvent {
  return {
    id: crypto.randomUUID(),
    event: "message.received",
    sessionId: SESSION,
    timestamp,
    messageId,
    chatId: CHAT,
    from: CHAT
  };
}

function createFixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "wa-control-timestamp-repair-"));
  tempDirs.push(rootDir);
  return openDatabase(join(rootDir, "app.sqlite"));
}

describe("repairMessageTimestampsFromEvents", () => {
  it("acerta as linhas empatadas a partir do journal de eventos e e idempotente", () => {
    const db = createFixture();

    try {
      const eventsRepo = new EventsRepo(db);
      const messagesRepo = new MessagesRepo(db);

      for (const [messageId, timestamp] of [
        ["ZZZ1", foto],
        ["YYY2", audio],
        ["XXX3", texto],
        ["WWW4", menu]
      ] as const) {
        eventsRepo.append(messageSentEvent(messageId, timestamp));
      }
      eventsRepo.append(messageReceivedEvent("CLIENT1", cliente));

      // Todas gravadas com a hora do aviso de lido — o bug.
      for (const id of ["ZZZ1", "YYY2", "XXX3", "WWW4", "CLIENT1"]) {
        messagesRepo.upsert(messageRecord(id, avisoDeLido, id === "CLIENT1" ? { fromMe: false } : {}));
      }

      expect(repairMessageTimestampsFromEvents(db)).toBe(5);

      const repaired = messagesRepo.list(SESSION, [CHAT], [], 10);
      expect(repaired.map((message) => message.id)).toEqual(["WWW4", "CLIENT1", "XXX3", "YYY2", "ZZZ1"]);
      expect(repaired.map((message) => message.unixSeconds)).toEqual([
        menu,
        cliente,
        texto,
        audio,
        foto
      ]);
      for (const message of repaired) {
        expect(message.timestamp).toBe(isoAt(message.unixSeconds as number));
      }

      // Rodar de novo nao muda nada: nao sobrou divergencia.
      expect(repairMessageTimestampsFromEvents(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("nao mexe em linha sem evento (history-sync, journal podado) nem em linha ja certa", () => {
    const db = createFixture();

    try {
      const eventsRepo = new EventsRepo(db);
      const messagesRepo = new MessagesRepo(db);

      eventsRepo.append(messageSentEvent("CERTA1", texto));
      messagesRepo.upsert(messageRecord("CERTA1", texto));
      // Linha de history-sync: nao gera evento, entao nao tem fonte de correcao.
      messagesRepo.upsert(messageRecord("HIST1", avisoDeLido, { upsertType: "history" }));

      expect(repairMessageTimestampsFromEvents(db)).toBe(0);

      const rows = messagesRepo.list(SESSION, [CHAT], [], 10);
      expect(rows.find((message) => message.id === "CERTA1")?.unixSeconds).toBe(texto);
      expect(rows.find((message) => message.id === "HIST1")?.unixSeconds).toBe(avisoDeLido);
    } finally {
      db.close();
    }
  });

  it("preenche o horario de linha gravada sem hora quando o evento tem", () => {
    const db = createFixture();

    try {
      const eventsRepo = new EventsRepo(db);
      const messagesRepo = new MessagesRepo(db);

      eventsRepo.append(messageSentEvent("SEM-HORA", menu));
      messagesRepo.upsert(messageRecord("SEM-HORA", avisoDeLido, { unixSeconds: null }));

      expect(repairMessageTimestampsFromEvents(db)).toBe(1);

      const row = messagesRepo.list(SESSION, [CHAT], [], 10)[0];
      expect(row?.unixSeconds).toBe(menu);
      expect(row?.timestamp).toBe(isoAt(menu));

      expect(repairMessageTimestampsFromEvents(db)).toBe(0);
    } finally {
      db.close();
    }
  });
});
