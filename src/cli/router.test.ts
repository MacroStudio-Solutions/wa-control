import { describe, expect, it } from "bun:test";
import { parseCliCommand } from "./router.ts";

describe("parseCliCommand", () => {
  it("parses daemon start", () => {
    expect(parseCliCommand(["daemon", "start"])).toEqual({
      kind: "daemon.start"
    });
  });

  it("parses qr with output flags", () => {
    expect(parseCliCommand(["qr", "pessoal", "--base64"])).toEqual({
      kind: "qr",
      sessionId: "pessoal",
      json: false,
      base64: true
    });

    expect(parseCliCommand(["qr", "pessoal", "--json"])).toEqual({
      kind: "qr",
      sessionId: "pessoal",
      json: true,
      base64: false
    });
  });

  it("parses connect with json", () => {
    expect(parseCliCommand(["connect", "pessoal", "--json"])).toEqual({
      kind: "connect",
      sessionId: "pessoal",
      json: true
    });
  });

  it("parses listen --all", () => {
    expect(parseCliCommand(["listen", "--all"])).toEqual({
      kind: "listen",
      sessionId: null,
      all: true,
      raw: false
    });
  });

  it("parses send preserving spaced text", () => {
    expect(parseCliCommand(["send", "pessoal", "5511999999999", "ola", "mundo"])).toEqual({
      kind: "send",
      sessionId: "pessoal",
      to: "5511999999999",
      text: "ola mundo"
    });
  });

  it("parses chats with explicit limit", () => {
    expect(parseCliCommand(["chats", "pessoal", "--limit", "25", "--json"])).toEqual({
      kind: "chats",
      sessionId: "pessoal",
      limit: 25,
      json: true
    });
  });

  it("parses messages query", () => {
    expect(parseCliCommand(["messages", "pessoal", "556784020665", "--limit", "10"])).toEqual({
      kind: "messages",
      sessionId: "pessoal",
      chat: "556784020665",
      limit: 10,
      json: false
    });
  });

  it("parses webhook add with retry flags", () => {
    expect(
      parseCliCommand([
        "webhook",
        "add",
        "pessoal",
        "https://example.com/hook",
        "--timeout-ms",
        "8000",
        "--max-attempts",
        "5"
      ])
    ).toEqual({
      kind: "webhook.add",
      sessionId: "pessoal",
      url: "https://example.com/hook",
      timeoutMs: 8000,
      maxAttempts: 5
    });
  });

  it("parses session remove confirmation", () => {
    expect(parseCliCommand(["session", "remove", "pessoal", "--yes"])).toEqual({
      kind: "session.remove",
      sessionId: "pessoal",
      yes: true
    });
  });

  it("parses webhook remove with optional session id", () => {
    expect(parseCliCommand(["webhook", "remove", "pessoal", "abc"])).toEqual({
      kind: "webhook.remove",
      sessionId: "pessoal",
      id: "abc"
    });
  });

  it("parses the event selection on webhook add", () => {
    expect(
      parseCliCommand([
        "webhook",
        "add",
        "pessoal",
        "https://example.com/hook",
        "--events",
        "message.received,session.connected"
      ])
    ).toEqual({
      kind: "webhook.add",
      sessionId: "pessoal",
      url: "https://example.com/hook",
      events: ["message.received", "session.connected"]
    });
  });

  it("treats `all` as the empty selection, which subscribes to everything", () => {
    expect(
      parseCliCommand(["webhook", "add", "pessoal", "https://example.com/hook", "--events", "all"])
    ).toEqual({
      kind: "webhook.add",
      sessionId: "pessoal",
      url: "https://example.com/hook",
      events: []
    });
  });

  it("rejects an unknown event instead of silently dropping it", () => {
    expect(() =>
      parseCliCommand([
        "webhook",
        "add",
        "pessoal",
        "https://example.com/hook",
        "--events",
        "message.recieved"
      ])
    ).toThrow(/Evento desconhecido/);
  });

  it("keeps the session optional on webhook list, so orphans are reachable", () => {
    expect(parseCliCommand(["webhook", "list", "--json"])).toEqual({
      kind: "webhook.list",
      json: true
    });

    expect(parseCliCommand(["webhook", "list", "pessoal", "--json"])).toEqual({
      kind: "webhook.list",
      sessionId: "pessoal",
      json: true
    });
  });

  it("parses the per-event toggles", () => {
    expect(parseCliCommand(["webhook", "enable-event", "abc", "message.sent"])).toEqual({
      kind: "webhook.toggle-event",
      id: "abc",
      event: "message.sent",
      enabled: true
    });

    expect(parseCliCommand(["webhook", "disable-event", "abc", "connection.update"])).toEqual({
      kind: "webhook.toggle-event",
      id: "abc",
      event: "connection.update",
      enabled: false
    });
  });

  it("does not confuse `disable-event` with `disable`", () => {
    expect(parseCliCommand(["webhook", "disable", "abc"])).toEqual({
      kind: "webhook.set-enabled",
      id: "abc",
      enabled: false
    });
  });

  it("parses set-events", () => {
    expect(parseCliCommand(["webhook", "set-events", "abc", "message.received"])).toEqual({
      kind: "webhook.set-events",
      id: "abc",
      events: ["message.received"]
    });
  });

  it("parses the event catalog command", () => {
    expect(parseCliCommand(["events", "--json"])).toEqual({
      kind: "events",
      json: true
    });
  });

  it("parses download-media with optional --out", () => {
    expect(parseCliCommand(["download-media", "pessoal", "556784020665", "3EB0MEDIA"])).toEqual({
      kind: "download-media",
      sessionId: "pessoal",
      chat: "556784020665",
      messageId: "3EB0MEDIA",
      json: false
    });

    expect(
      parseCliCommand([
        "download-media",
        "pessoal",
        "556784020665",
        "3EB0MEDIA",
        "--out",
        "/tmp/foto.jpg",
        "--json"
      ])
    ).toEqual({
      kind: "download-media",
      sessionId: "pessoal",
      chat: "556784020665",
      messageId: "3EB0MEDIA",
      out: "/tmp/foto.jpg",
      json: true
    });
  });

  it("rejects download-media without all three references", () => {
    expect(() => parseCliCommand(["download-media", "pessoal", "556784020665"])).toThrow(
      /Comando invalido/
    );
    expect(() => parseCliCommand(["download-media"])).toThrow(/Comando invalido/);
  });

  it("parses send-media with all flags", () => {
    expect(
      parseCliCommand([
        "send-media",
        "pessoal",
        "556784020665",
        "./foto.jpg",
        "--type",
        "image",
        "--caption",
        "Bom dia",
        "--ptt",
        "--json"
      ])
    ).toEqual({
      kind: "send-media",
      sessionId: "pessoal",
      to: "556784020665",
      file: "./foto.jpg",
      type: "image",
      caption: "Bom dia",
      ptt: true,
      json: true
    });
  });

  it("parses send-media with defaults: sem tipo, sem caption, sem ptt", () => {
    expect(parseCliCommand(["send-media", "pessoal", "556784020665", "./audio.ogg"])).toEqual({
      kind: "send-media",
      sessionId: "pessoal",
      to: "556784020665",
      file: "./audio.ogg",
      ptt: false,
      json: false
    });
  });

  it("parses send-media with audio override and ptt", () => {
    expect(
      parseCliCommand(["send-media", "pessoal", "556784020665", "./voz", "--type", "audio", "--ptt"])
    ).toEqual({
      kind: "send-media",
      sessionId: "pessoal",
      to: "556784020665",
      file: "./voz",
      type: "audio",
      ptt: true,
      json: false
    });
  });

  it("accepts a media kind in --type even when not released yet, so the pipeline classifies it", () => {
    expect(
      parseCliCommand(["send-media", "pessoal", "556784020665", "./clip", "--type", "video"])
    ).toEqual({
      kind: "send-media",
      sessionId: "pessoal",
      to: "556784020665",
      file: "./clip",
      type: "video",
      ptt: false,
      json: false
    });
  });

  it("rejects send-media with a value that is not a media kind in --type", () => {
    expect(() =>
      parseCliCommand(["send-media", "pessoal", "556784020665", "./foto", "--type", "gif"])
    ).toThrow(/--type/);
  });

  it("rejects send-media without session, destination and file", () => {
    expect(() => parseCliCommand(["send-media", "pessoal"])).toThrow(/Comando invalido/);
    expect(() => parseCliCommand(["send-media", "pessoal", "556784020665"])).toThrow(
      /Comando invalido/
    );
  });
});
