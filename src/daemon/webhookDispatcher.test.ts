import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Logger } from "../shared/logger.ts";
import type { NormalizedEvent } from "../shared/types.ts";
import { openDatabase } from "../storage/db.ts";
import { WebhookDeliveriesRepo } from "../storage/webhookDeliveriesRepo.ts";
import { WebhooksRepo } from "../storage/webhooksRepo.ts";
import { EventBus } from "./eventBus.ts";
import { EventPublisher } from "./eventPublisher.ts";
import { WebhookDispatcher } from "./webhookDispatcher.ts";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

const originalFetch = globalThis.fetch;

/** URLs que receberam POST, na ordem. */
let delivered: string[] = [];

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    delivered.push(typeof input === "string" ? input : input.toString());
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
}

function publish(eventBus: EventBus, event: string, sessionId: string | null): void {
  eventBus.publish({
    id: `${event}-${delivered.length}`,
    event,
    sessionId,
    timestamp: 1
  } satisfies NormalizedEvent);
}

describe("WebhookDispatcher event filtering", () => {
  let db: ReturnType<typeof openDatabase>;
  let webhooks: WebhooksRepo;
  let eventBus: EventBus;
  let dispatcher: WebhookDispatcher;

  beforeEach(() => {
    delivered = [];
    stubFetch();

    db = openDatabase(":memory:");
    webhooks = new WebhooksRepo(db);
    const deliveries = new WebhookDeliveriesRepo(db);
    eventBus = new EventBus();

    dispatcher = new WebhookDispatcher(
      webhooks,
      deliveries,
      new EventPublisher(
        { append() {} } as never,
        eventBus,
        silentLogger
      ),
      silentLogger
    );

    dispatcher.start(eventBus);
  });

  afterEach(() => {
    dispatcher.stop();
    globalThis.fetch = originalFetch;
  });

  function register(url: string, events?: string[]) {
    return webhooks.create({
      sessionId: "principal",
      url,
      timeoutMs: 1000,
      maxAttempts: 1,
      ...(events ? { events } : {})
    });
  }

  it("delivers only the selected event", async () => {
    register("https://hook.test/only-messages", ["message.received"]);

    publish(eventBus, "message.received", "principal");
    publish(eventBus, "connection.update", "principal");
    publish(eventBus, "session.connected", "principal");
    await Bun.sleep(25);

    expect(delivered).toEqual(["https://hook.test/only-messages"]);
  });

  it("delivers everything when no selection was made", async () => {
    register("https://hook.test/all");

    publish(eventBus, "message.received", "principal");
    publish(eventBus, "connection.update", "principal");
    await Bun.sleep(25);

    expect(delivered).toHaveLength(2);
  });

  it("routes each event to the webhook that asked for it", async () => {
    register("https://hook.test/messages", ["message.received"]);
    register("https://hook.test/connection", ["connection.update"]);

    publish(eventBus, "message.received", "principal");
    await Bun.sleep(25);

    expect(delivered).toEqual(["https://hook.test/messages"]);
  });

  it("skips a disabled webhook regardless of its selection", async () => {
    const webhook = register("https://hook.test/off", ["message.received"]);
    webhooks.setEnabled(webhook.id, false);

    publish(eventBus, "message.received", "principal");
    await Bun.sleep(25);

    expect(delivered).toEqual([]);
  });

  it("never delivers to another session's webhook", async () => {
    register("https://hook.test/principal");

    publish(eventBus, "message.received", "outra");
    await Bun.sleep(25);

    expect(delivered).toEqual([]);
  });

  it("ignores events without a session and webhook events", async () => {
    register("https://hook.test/all");

    publish(eventBus, "daemon.started", null);
    publish(eventBus, "webhook.delivery_failed", "principal");
    await Bun.sleep(25);

    expect(delivered).toEqual([]);
  });
});

describe("WebhookDispatcher when the webhook disappears during delivery", () => {
  let db: ReturnType<typeof openDatabase>;
  let webhooks: WebhooksRepo;
  let deliveries: WebhookDeliveriesRepo;
  let eventBus: EventBus;
  let dispatcher: WebhookDispatcher;
  let unhandled: unknown[];
  let warnings: string[];
  let infos: string[];
  let calls: string[];

  const collectUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    calls = [];
    unhandled = [];
    warnings = [];
    infos = [];
    process.on("unhandledRejection", collectUnhandled);

    db = openDatabase(":memory:");
    webhooks = new WebhooksRepo(db);
    deliveries = new WebhookDeliveriesRepo(db);
    eventBus = new EventBus();

    const logger: Logger = {
      debug() {},
      info(message) {
        infos.push(message);
      },
      warn(message) {
        warnings.push(message);
      },
      error() {}
    };

    dispatcher = new WebhookDispatcher(
      webhooks,
      deliveries,
      new EventPublisher({ append() {} } as never, eventBus, silentLogger),
      logger
    );

    dispatcher.start(eventBus);
  });

  afterEach(() => {
    dispatcher.stop();
    globalThis.fetch = originalFetch;
    process.off("unhandledRejection", collectUnhandled);
  });

  function publishConnectionUpdate(id: string): void {
    eventBus.publish({
      id,
      event: "connection.update",
      sessionId: "principal",
      timestamp: 1
    } satisfies NormalizedEvent);
  }

  it("does not violate the foreign key when the webhook is replaced while the request is in flight", async () => {
    const stale = webhooks.create({
      sessionId: "principal",
      url: "https://old-bridge.test/hook",
      timeoutMs: 1000,
      maxAttempts: 3
    });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);

      if (url === "https://old-bridge.test/hook") {
        webhooks.delete(stale.id);
        webhooks.create({
          sessionId: "principal",
          url: "https://new-bridge.test/hook",
          timeoutMs: 1000,
          maxAttempts: 3
        });
        return new Response("not found", { status: 404 });
      }

      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    publishConnectionUpdate("boot-1");
    await Bun.sleep(60);

    expect(unhandled).toEqual([]);
    expect(deliveries.list("principal").filter((row) => row.webhookId === stale.id)).toEqual([]);
    expect(infos).toContain("webhook removido durante a entrega; tentativa descartada");
    expect(warnings).toContain("falha ao entregar webhook");

    publishConnectionUpdate("boot-2");
    await Bun.sleep(60);

    expect(calls.filter((url) => url === "https://new-bridge.test/hook")).toHaveLength(1);
    expect(deliveries.list("principal")).toHaveLength(1);
    expect(deliveries.list("principal")[0]?.status).toBe("delivered");
    expect(unhandled).toEqual([]);
  });

  it("drops the record of a successful delivery when the webhook was removed meanwhile", async () => {
    const stale = webhooks.create({
      sessionId: "principal",
      url: "https://old-bridge.test/hook",
      timeoutMs: 1000,
      maxAttempts: 3
    });

    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(typeof input === "string" ? input : input.toString());
      webhooks.delete(stale.id);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    publishConnectionUpdate("boot-1");
    await Bun.sleep(60);

    expect(unhandled).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(deliveries.list("principal")).toEqual([]);
    expect(infos).toContain("webhook removido durante a entrega; tentativa descartada");
  });

  it("stops retrying a webhook that was removed between attempts", async () => {
    const stale = webhooks.create({
      sessionId: "principal",
      url: "https://old-bridge.test/hook",
      timeoutMs: 1000,
      maxAttempts: 3
    });

    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    publishConnectionUpdate("boot-1");
    await Bun.sleep(60);

    expect(calls).toHaveLength(1);
    expect(deliveries.list("principal")).toHaveLength(1);

    webhooks.delete(stale.id);
    await Bun.sleep(1100);

    expect(unhandled).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(deliveries.list("principal")).toEqual([]);
    expect(infos).toContain("webhook removido durante a entrega; tentativa descartada");
  });

  it("keeps recording failed attempts and retrying while the webhook exists", async () => {
    const webhook = webhooks.create({
      sessionId: "principal",
      url: "https://bridge.test/hook",
      timeoutMs: 1000,
      maxAttempts: 2
    });

    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    publishConnectionUpdate("boot-1");
    await Bun.sleep(1200);

    const rows = deliveries.list("principal");
    expect(unhandled).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(rows.map((row) => row.attempt).sort()).toEqual([1, 2]);
    expect(rows.every((row) => row.status === "failed" && row.httpStatus === 404)).toBe(true);
    expect(rows.every((row) => row.webhookId === webhook.id)).toBe(true);
    expect(webhooks.get(webhook.id)?.lastStatus).toBe("failed");
  });
});
