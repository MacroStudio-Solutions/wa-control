import { describe, expect, it } from "bun:test";
import { parseCliCommand } from "./router.ts";

describe("parseCliCommand", () => {
  it("parses daemon start", () => {
    expect(parseCliCommand(["daemon", "start"])).toEqual({
      kind: "daemon.start"
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
});
