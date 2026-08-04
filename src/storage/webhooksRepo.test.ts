import { beforeEach, describe, expect, it } from "bun:test";
import { WEBHOOK_EVENTS } from "../shared/events.ts";
import { openDatabase } from "./db.ts";
import { WebhooksRepo } from "./webhooksRepo.ts";

function createRepo(): WebhooksRepo {
  return new WebhooksRepo(openDatabase(":memory:"));
}

describe("WebhooksRepo", () => {
  let repo: WebhooksRepo;

  beforeEach(() => {
    repo = createRepo();
  });

  function create(events?: string[]) {
    return repo.create({
      sessionId: "principal",
      url: "https://example.com/hook",
      timeoutMs: 5000,
      maxAttempts: 3,
      ...(events ? { events } : {})
    });
  }

  it("defaults to the empty selection, which means every event", () => {
    const webhook = create();

    expect(webhook.events).toEqual([]);
    expect(webhook.eventsLabel).toBe("todos os eventos");
    expect(webhook.eventFlags.messageReceived).toBe(true);
    expect(webhook.eventFlags.connectionUpdate).toBe(true);
  });

  it("round-trips a selection through storage", () => {
    const created = create(["message.received"]);
    const read = repo.get(created.id);

    expect(read?.events).toEqual(["message.received"]);
    expect(read?.eventFlags.messageReceived).toBe(true);
    expect(read?.eventFlags.messageSent).toBe(false);
  });

  it("replaces the whole selection with setEvents", () => {
    const webhook = create(["message.received"]);
    const updated = repo.setEvents(webhook.id, ["session.connected", "session.disconnected"]);

    expect(updated.events).toEqual(["session.connected", "session.disconnected"]);
    expect(updated.eventFlags.messageReceived).toBe(false);
  });

  it("goes back to everything when the selection is cleared", () => {
    const webhook = create(["message.received"]);

    expect(repo.setEvents(webhook.id, []).events).toEqual([]);
    expect(repo.setEvents(webhook.id, ["all"]).events).toEqual([]);
  });

  it("leaves a subscribe-all webhook alone when enabling an event", () => {
    // Materializar a lista aqui trocaria "tudo, inclusive o que vier depois"
    // por uma selecao congelada — reduziria a assinatura em vez de ampliar.
    const webhook = create();
    const updated = repo.enableEvent(webhook.id, "message.sent");

    expect(updated.events).toEqual([]);
  });

  it("adds to an explicit selection when enabling an event", () => {
    const webhook = create(["message.received"]);
    const updated = repo.enableEvent(webhook.id, "message.sent");

    expect(updated.events).toEqual(["message.received", "message.sent"]);
  });

  it("materializes the full catalog minus one when disabling on subscribe-all", () => {
    const webhook = create();
    const updated = repo.disableEvent(webhook.id, "connection.update");

    expect(updated.events).toEqual(
      WEBHOOK_EVENTS.filter((event) => event !== "connection.update")
    );
    expect(updated.eventFlags.connectionUpdate).toBe(false);
  });

  it("refuses to empty the selection, which would silently re-subscribe to all", () => {
    const webhook = create(["message.received"]);

    expect(() => repo.disableEvent(webhook.id, "message.received")).toThrow(
      /sem nenhum evento/
    );
    expect(repo.get(webhook.id)?.events).toEqual(["message.received"]);
  });

  it("toggles the enabled flag without touching the selection", () => {
    const webhook = create(["message.received"]);
    const disabled = repo.setEnabled(webhook.id, false);

    expect(disabled.enabled).toBe(false);
    expect(disabled.events).toEqual(["message.received"]);
  });

  it("lists across sessions when no session is given, so orphans surface", () => {
    create();
    repo.create({
      sessionId: "removida",
      url: "https://example.com/orphan",
      timeoutMs: 5000,
      maxAttempts: 3
    });

    expect(repo.list("principal")).toHaveLength(1);
    expect(repo.list()).toHaveLength(2);
  });
});
