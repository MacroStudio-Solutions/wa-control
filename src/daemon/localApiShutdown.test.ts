import { afterEach, describe, expect, it } from "bun:test";
import { EventBus } from "./eventBus.ts";
import { startLocalApiServer } from "./localApi.ts";
import type { Logger } from "../shared/logger.ts";

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

function createTestServer(onShutdown?: () => void) {
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
    eventBus: new EventBus(),
    logger: silentLogger,
    ...(onShutdown ? { onShutdown } : {})
  });

  servers.push(server);
  return server;
}

describe("POST /shutdown", () => {
  it("exige o mesmo bearer token das demais rotas", async () => {
    let calls = 0;
    const server = createTestServer(() => {
      calls += 1;
    });
    const url = `http://${host}:${server.port}/shutdown`;

    const anonymous = await fetch(url, { method: "POST" });
    const wrong = await fetch(url, { method: "POST", headers: { authorization: "Bearer outro" } });
    await Bun.sleep(120);

    expect(anonymous.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("responde antes de executar a parada e a executa uma vez por pedido", async () => {
    const order: string[] = [];
    const server = createTestServer(() => {
      order.push("parada");
    });

    const response = await fetch(`http://${host}:${server.port}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    order.push("resposta");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, shuttingDown: true });
    expect(order).toEqual(["resposta"]);

    await Bun.sleep(200);
    expect(order).toEqual(["resposta", "parada"]);
  });

  it("so existe como POST: GET devolve a rota nao encontrada de sempre", async () => {
    const server = createTestServer(() => undefined);

    const response = await fetch(`http://${host}:${server.port}/shutdown`, {
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("sem o gancho de parada a rota nao existe, como num daemon anterior a ela", async () => {
    const server = createTestServer();

    const response = await fetch(`http://${host}:${server.port}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
