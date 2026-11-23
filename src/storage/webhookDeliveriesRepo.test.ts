import { beforeEach, describe, expect, it } from "bun:test";
import { openDatabase } from "./db.ts";
import { WebhookDeliveriesRepo } from "./webhookDeliveriesRepo.ts";
import { WebhooksRepo } from "./webhooksRepo.ts";

const baseInput = {
  sessionId: "principal",
  eventId: "evt-1",
  eventName: "connection.update",
  attempt: 1,
  status: "delivered" as const,
  httpStatus: 200,
  error: null,
  responseBody: "ok"
};

describe("WebhookDeliveriesRepo.create", () => {
  let db: ReturnType<typeof openDatabase>;
  let webhooks: WebhooksRepo;
  let deliveries: WebhookDeliveriesRepo;

  beforeEach(() => {
    db = openDatabase(":memory:");
    webhooks = new WebhooksRepo(db);
    deliveries = new WebhookDeliveriesRepo(db);
  });

  it("stores the attempt of a registered webhook and returns the record", () => {
    const webhook = webhooks.create({
      sessionId: "principal",
      url: "https://bridge.test/hook",
      timeoutMs: 1000,
      maxAttempts: 3
    });

    const record = deliveries.create({ ...baseInput, webhookId: webhook.id });

    expect(record?.webhookId).toBe(webhook.id);
    expect(deliveries.list("principal")).toHaveLength(1);
  });

  it("returns null and stores nothing when the webhook no longer exists", () => {
    const webhook = webhooks.create({
      sessionId: "principal",
      url: "https://bridge.test/hook",
      timeoutMs: 1000,
      maxAttempts: 3
    });
    webhooks.delete(webhook.id);

    expect(deliveries.create({ ...baseInput, webhookId: webhook.id })).toBeNull();
    expect(deliveries.list("principal")).toEqual([]);
  });

  it("removes the history together with the webhook", () => {
    const webhook = webhooks.create({
      sessionId: "principal",
      url: "https://bridge.test/hook",
      timeoutMs: 1000,
      maxAttempts: 3
    });
    deliveries.create({ ...baseInput, webhookId: webhook.id });

    webhooks.delete(webhook.id);

    expect(deliveries.list("principal")).toEqual([]);
  });

  it("keeps the foreign key enforced for writes that bypass the repo", () => {
    expect(() =>
      db
        .query(
          `INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_name, attempt, status, created_at)
           VALUES ('d1', 'inexistente', 'e', 'connection.update', 1, 'failed', '2026-11-22T00:00:00.000Z')`
        )
        .run()
    ).toThrow(/FOREIGN KEY/);
  });
});
