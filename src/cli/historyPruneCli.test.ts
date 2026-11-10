import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageRecord, NormalizedEvent, SessionRecord } from "../shared/types.ts";
import { openDatabase } from "../storage/db.ts";
import { EventsRepo } from "../storage/eventsRepo.ts";
import { MessagesRepo } from "../storage/messagesRepo.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import {
  type TestEnvironment,
  cleanupProcessHarness,
  createTestEnvironment,
  runCli
} from "../test-support/processHarness.ts";

afterEach(cleanupProcessHarness);

const DAY_SECONDS = 86_400;
const OLDER_THAN_DAYS = 5;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isoAt(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function messageRecord(
  sessionId: string,
  id: string,
  unixSeconds: number,
  overrides: Partial<MessageRecord> = {}
): MessageRecord {
  const chatJid = "556784020665@s.whatsapp.net";

  return {
    sessionId,
    chatJid,
    chatLookupKey: null,
    chatLookupJid: null,
    chatPhoneNumber: null,
    id,
    participantJid: chatJid,
    participantLookupKey: null,
    participantLookupJid: null,
    participantPhoneNumber: null,
    senderJid: chatJid,
    senderLookupKey: null,
    senderLookupJid: null,
    senderPhoneNumber: null,
    pushName: null,
    fromMe: false,
    upsertType: "notify",
    messageType: "text",
    text: "ola",
    rawMessageType: null,
    status: null,
    unixSeconds,
    timestamp: isoAt(unixSeconds),
    updatedAt: isoAt(unixSeconds),
    ...overrides
  };
}

function messageEvent(
  id: string,
  messageId: string,
  unixSeconds: number
): NormalizedEvent {
  return {
    id,
    event: "message.received",
    sessionId: "loja",
    timestamp: unixSeconds,
    messageId,
    chatId: "556784020665@s.whatsapp.net",
    raw: { marcador: "payload-bruto-com-midia" }
  };
}

function seedMessages(environment: TestEnvironment, records: MessageRecord[]): void {
  const db = openDatabase(join(environment.dataDir, "app.sqlite"));
  try {
    const repo = new MessagesRepo(db);
    for (const record of records) {
      repo.upsert(record);
    }
  } finally {
    db.close();
  }
}

function seedEvents(environment: TestEnvironment, events: NormalizedEvent[]): void {
  const db = openDatabase(join(environment.dataDir, "app.sqlite"));
  try {
    const repo = new EventsRepo(db);
    for (const event of events) {
      repo.append(event);
    }
  } finally {
    db.close();
  }
}

function seedSession(environment: TestEnvironment, session: SessionRecord): void {
  const db = openDatabase(join(environment.dataDir, "app.sqlite"));
  try {
    new SessionsRepo(db).save(session);
  } finally {
    db.close();
  }
}

function inspectDb(environment: TestEnvironment) {
  const db = openDatabase(join(environment.dataDir, "app.sqlite"));
  return {
    messages: new MessagesRepo(db),
    events: new EventsRepo(db),
    sessions: new SessionsRepo(db),
    countMessages: () =>
      (db.query("SELECT COUNT(*) AS total FROM messages").get() as { total: number }).total,
    countEvents: (eventName: string) =>
      (
        db
          .query("SELECT COUNT(*) AS total FROM events WHERE event_name = ?1")
          .get(eventName) as { total: number }
      ).total,
    close: () => db.close()
  };
}

async function prune(environment: TestEnvironment, args: string[] = []) {
  return runCli(["history", "prune", ...args], environment);
}

function parseSingleLineJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
}

describe("wa history prune (ponta a ponta, sem daemon)", () => {
  it("corte por data: apaga mensagens e midia local antes do corte, em todas as sessoes, e mantem o resto", async () => {
    const environment = await createTestEnvironment();
    const now = nowSeconds();

    seedMessages(environment, [
      // Copia do pareamento (history-sync), sessao pessoal: entra no corte.
      messageRecord("pessoal", "OLD-HISTORY", now - 6 * DAY_SECONDS, {
        upsertType: "history",
        text: "copiada no pareamento"
      }),
      // Mensagem de midia na sessao loja: entra no corte, junto do payload.
      messageRecord("loja", "OLD-MIDIA", now - 6 * DAY_SECONDS, {
        messageType: "image",
        text: null
      }),
      messageRecord("loja", "NEW-TEXTO", now - DAY_SECONDS)
    ]);
    seedEvents(environment, [
      messageEvent("evt-old-midia", "OLD-MIDIA", now - 6 * DAY_SECONDS),
      messageEvent("evt-new-midia", "NEW-MIDIA", now - DAY_SECONDS)
    ]);

    const result = await prune(environment, [
      "--older-than-days",
      String(OLDER_THAN_DAYS),
      "--json"
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = parseSingleLineJson(result.stdout);
    expect(Object.keys(parsed)).toEqual(["ok", "removed", "olderThan"]);
    expect(parsed.ok).toBe(true);
    expect(parsed.removed).toBe(2);
    expect(typeof parsed.olderThan).toBe("string");

    const cutoffMs = Date.parse(parsed.olderThan as string);
    expect(Math.abs(cutoffMs - (now - OLDER_THAN_DAYS * DAY_SECONDS) * 1000)).toBeLessThan(60_000);

    const db = inspectDb(environment);
    try {
      expect(db.countMessages()).toBe(1);
      expect(db.messages.get("loja", "556784020665@s.whatsapp.net", "NEW-TEXTO")).not.toBeNull();
      expect(
        db.messages.get("pessoal", "556784020665@s.whatsapp.net", "OLD-HISTORY")
      ).toBeNull();
      expect(db.messages.get("loja", "556784020665@s.whatsapp.net", "OLD-MIDIA")).toBeNull();

      // A midia local vive no payload bruto do journal: sem ele, o download
      // nao tem mais o que recuperar.
      expect(db.events.findMessageRawPayload("loja", "OLD-MIDIA")).toBeNull();
      expect(db.events.findMessageRawPayload("loja", "NEW-MIDIA")).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("idempotente: a segunda passada com o mesmo corte nao apaga mais nada", async () => {
    const environment = await createTestEnvironment();
    const now = nowSeconds();

    seedMessages(environment, [
      messageRecord("pessoal", "OLD-1", now - 10 * DAY_SECONDS),
      messageRecord("loja", "OLD-2", now - 8 * DAY_SECONDS),
      messageRecord("loja", "OLD-3", now - 6 * DAY_SECONDS)
    ]);
    seedEvents(environment, [messageEvent("evt-old-1", "OLD-1", now - 10 * DAY_SECONDS)]);

    const first = await prune(environment, ["--older-than-days", String(OLDER_THAN_DAYS), "--json"]);
    expect(first.exitCode).toBe(0);
    expect(parseSingleLineJson(first.stdout).removed).toBe(3);

    const second = await prune(environment, ["--older-than-days", String(OLDER_THAN_DAYS), "--json"]);
    expect(second.exitCode).toBe(0);
    const parsed = parseSingleLineJson(second.stdout);
    expect(parsed).toMatchObject({ ok: true, removed: 0 });
    expect(Date.parse(parsed.olderThan as string)).toBeGreaterThan(0);

    const db = inspectDb(environment);
    try {
      expect(db.countMessages()).toBe(0);
      expect(db.countEvents("message.received")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("nao toca em credencial nem em estado de sessao", async () => {
    const environment = await createTestEnvironment();
    const now = nowSeconds();

    const authDir = join(environment.dataDir, "sessions", "pessoal", "auth");
    mkdirSync(authDir, { recursive: true });
    const credsContent = '{"me":null}';
    const lidContent = '"88356755087579"\n';
    writeFileSync(join(authDir, "creds.json"), credsContent, "utf8");
    writeFileSync(join(authDir, "lid-mapping-556784020665.json"), lidContent, "utf8");
    const tokenContent = "token-secreto-de-teste\n";
    writeFileSync(join(environment.dataDir, "token"), tokenContent, "utf8");

    seedSession(environment, {
      id: "pessoal",
      status: "connected",
      createdAt: isoAt(now - 30 * DAY_SECONDS),
      updatedAt: isoAt(now),
      phoneNumber: "556784020665",
      lastError: null,
      active: true,
      lastConnectedAt: isoAt(now),
      reconnectAttempts: 0,
      qr: null
    });
    seedMessages(environment, [messageRecord("pessoal", "OLD-1", now - 6 * DAY_SECONDS)]);
    seedEvents(environment, [
      messageEvent("evt-old-1", "OLD-1", now - 6 * DAY_SECONDS),
      // Evento de sessao anterior ao corte: estado de sessao, fora do prazo
      // de conversa — precisa sobreviver.
      {
        id: "evt-sessao",
        event: "session.connected",
        sessionId: "pessoal",
        timestamp: now - 6 * DAY_SECONDS
      }
    ]);

    const result = await prune(environment, ["--older-than-days", String(OLDER_THAN_DAYS), "--json"]);
    expect(result.exitCode).toBe(0);
    expect(parseSingleLineJson(result.stdout)).toMatchObject({ ok: true, removed: 1 });

    expect(readFileSync(join(authDir, "creds.json"), "utf8")).toBe(credsContent);
    expect(readFileSync(join(authDir, "lid-mapping-556784020665.json"), "utf8")).toBe(lidContent);
    expect(readFileSync(join(environment.dataDir, "token"), "utf8")).toBe(tokenContent);
    expect(existsSync(join(environment.dataDir, "sessions", "pessoal"))).toBe(true);

    const db = inspectDb(environment);
    try {
      const session = db.sessions.get("pessoal");
      expect(session).not.toBeNull();
      expect(session?.status).toBe("connected");
      expect(session?.active).toBe(true);
      expect(session?.phoneNumber).toBe("556784020665");
      expect(db.countEvents("session.connected")).toBe(1);
      expect(db.countEvents("message.received")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("contrato JSON: sucesso em uma linha e erro tipado com ok false", async () => {
    const environment = await createTestEnvironment();

    const success = await prune(environment, ["--older-than-days", "1", "--json"]);
    expect(success.exitCode).toBe(0);
    const ok = parseSingleLineJson(success.stdout);
    expect(Object.keys(ok)).toEqual(["ok", "removed", "olderThan"]);
    expect(ok.ok).toBe(true);
    expect(ok.removed).toBe(0);
    expect(typeof ok.olderThan).toBe("string");

    for (const args of [
      ["--older-than-days", "0", "--json"],
      ["--older-than-days", "2.5", "--json"],
      ["--json"]
    ]) {
      const failure = await prune(environment, args);
      expect(failure.exitCode).toBe(1);
      const parsed = parseSingleLineJson(failure.stdout);
      expect(Object.keys(parsed)).toEqual(["ok", "code", "message"]);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("INVALID_FLAG");
      expect(typeof parsed.message).toBe("string");
    }
  });
});
