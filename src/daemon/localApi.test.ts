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
