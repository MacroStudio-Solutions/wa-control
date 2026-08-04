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
