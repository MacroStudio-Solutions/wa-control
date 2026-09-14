import { afterEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { EventBus } from "./eventBus.ts";
import { startLocalApiServer } from "./localApi.ts";
import type { Logger } from "../shared/logger.ts";
import type { NormalizedEvent } from "../shared/types.ts";

const host = "127.0.0.1";
const token = "test-token";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0, servers.length)) {
    server.stop(true);
  }
});

function createTestServer(eventBus: EventBus) {
  const runtime = {
    runtimeInfo: {
      pid: 1,
      startedAt: new Date().toISOString(),
      host,
      port: 0,
      version: "test"
    }
  } as never;

  const server = startLocalApiServer({
    runtime,
    token,
    eventBus,
    logger: silentLogger
  });

  servers.push(server);
  return server;
}

async function readSingleLine(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });

  expect(response.ok).toBe(true);
  expect(response.body).not.toBeNull();

  const reader = response.body!.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return Buffer.from(value ?? []).toString("utf8").trim();
}

describe("local API event stream", () => {
  it("omits raw by default", async () => {
    const eventBus = new EventBus();
    const server = createTestServer(eventBus);

    const readPromise = readSingleLine(`http://${host}:${server.port}/events/stream?all=true`);
    await Bun.sleep(25);

    const event: NormalizedEvent = {
      id: "1",
      event: "message.received",
      sessionId: "pessoal",
      timestamp: 1,
      text: "oi",
      raw: {
        bytes: Buffer.from("secret")
      }
    };

    eventBus.publish(event);
    const line = await readPromise;

    expect(line).toContain("\"event\":\"message.received\"");
    expect(line).not.toContain("\"raw\"");
  });

  it("includes raw when requested", async () => {
    const eventBus = new EventBus();
    const server = createTestServer(eventBus);

    const readPromise = readSingleLine(`http://${host}:${server.port}/events/stream?all=true&raw=true`);
    await Bun.sleep(25);

    const event: NormalizedEvent = {
      id: "1",
      event: "message.received",
      sessionId: "pessoal",
      timestamp: 1,
      text: "oi",
      raw: {
        bytes: Buffer.from("secret"),
        count: BigInt(7)
      }
    };

    eventBus.publish(event);
    const line = await readPromise;

    expect(line).toContain("\"raw\"");
    expect(line).toContain("\"type\":\"Buffer\"");
    expect(line).toContain("\"type\":\"BigInt\"");
  });
});

describe("local API send-media route", () => {
  const runtimeInfo = {
    pid: 1,
    startedAt: new Date().toISOString(),
    host,
    port: 0,
    version: "test"
  };

  it("parses the x-media headers, forwards bytes to the runtime and answers JSON", async () => {
    const calls: Array<{ sessionId: string; media: unknown; bytes: number[] }> = [];
    const runtime = {
      runtimeInfo,
      sendMedia: async (
        sessionId: string,
        media: { to: string },
        buffer: Uint8Array
      ) => {
        calls.push({ sessionId, media, bytes: Array.from(buffer) });
        return {
          ok: true,
          sessionId,
          to: media.to,
          jid: `${media.to}@s.whatsapp.net`,
          kind: "image",
          mimeType: "image/jpeg",
          caption: null,
          ptt: false,
          size: buffer.byteLength,
          messageId: "3EB0ROUTE",
          timestamp: 1_785_000_000
        };
      }
    } as never;

    const server = startLocalApiServer({
      runtime,
      token,
      eventBus: new EventBus(),
      logger: silentLogger
    });
    servers.push(server);

    const response = await fetch(`http://${host}:${server.port}/sessions/pessoal/send-media`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-media-to": "556784020665",
        "x-media-kind": "image",
        "x-media-mime": "image/jpeg",
        "x-media-caption": encodeURIComponent("Bom dia")
      },
      body: new Uint8Array([1, 2, 3])
    });

    expect(response.ok).toBe(true);
    const body = (await response.json()) as { ok: boolean; messageId: string };
    expect(body.ok).toBe(true);
    expect(body.messageId).toBe("3EB0ROUTE");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe("pessoal");
    expect(calls[0]?.media).toMatchObject({
      to: "556784020665",
      kind: "image",
      mimeType: "image/jpeg",
      caption: "Bom dia"
    });
    expect(calls[0]?.bytes).toEqual([1, 2, 3]);
  });

  it("missing mandatory headers answers 400 INVALID_REQUEST without touching the runtime", async () => {
    const runtime = { runtimeInfo, sendMedia: async () => ({}) } as never;
    const server = startLocalApiServer({
      runtime,
      token,
      eventBus: new EventBus(),
      logger: silentLogger
    });
    servers.push(server);

    const response = await fetch(`http://${host}:${server.port}/sessions/pessoal/send-media`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-media-to": "556784020665"
      },
      body: new Uint8Array([1])
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });
});
