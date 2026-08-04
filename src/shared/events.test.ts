import { describe, expect, it } from "bun:test";
import {
  WEBHOOK_EVENTS,
  buildEventFlags,
  normalizeEventSelection,
  webhookAcceptsEvent
} from "./events.ts";

describe("webhookAcceptsEvent", () => {
  it("delivers everything when nothing was selected", () => {
    expect(webhookAcceptsEvent([], "message.received")).toBe(true);
    expect(webhookAcceptsEvent([], "connection.update")).toBe(true);
  });

  it("delivers only the selection once there is one", () => {
    const selection = ["message.received"];

    expect(webhookAcceptsEvent(selection, "message.received")).toBe(true);
    expect(webhookAcceptsEvent(selection, "connection.update")).toBe(false);
    expect(webhookAcceptsEvent(selection, "session.connected")).toBe(false);
  });
});

describe("normalizeEventSelection", () => {
  it("dedupes and orders by the catalog, so the stored value is stable", () => {
    expect(
      normalizeEventSelection(["session.connected", "message.received", "message.received"])
    ).toEqual(["message.received", "session.connected"]);
  });

  it("collapses `all` and `*` to the empty selection", () => {
    expect(normalizeEventSelection(["all"])).toEqual([]);
    expect(normalizeEventSelection(["*"])).toEqual([]);
    expect(normalizeEventSelection(["message.received", "all"])).toEqual([]);
  });

  it("ignores blanks", () => {
    expect(normalizeEventSelection(["", "  ", "message.sent"])).toEqual(["message.sent"]);
  });

  it("rejects an unknown event", () => {
    expect(() => normalizeEventSelection(["message.arrived"])).toThrow(/Evento desconhecido/);
  });

  it("rejects events the dispatcher can never deliver", () => {
    // daemon.started nao tem sessao e webhook.* geraria recursao de entrega:
    // nenhum dos dois chega a um webhook, entao assinar seria mentira.
    expect(() => normalizeEventSelection(["daemon.started"])).toThrow(/Evento desconhecido/);
    expect(() => normalizeEventSelection(["webhook.delivery_failed"])).toThrow(
      /Evento desconhecido/
    );
  });
});

describe("buildEventFlags", () => {
  it("marks every catalog event as on when the selection is empty", () => {
    const flags = buildEventFlags([]);

    expect(Object.keys(flags)).toHaveLength(WEBHOOK_EVENTS.length);
    expect(Object.values(flags).every(Boolean)).toBe(true);
  });

  it("exposes dot-free keys, addressable by a path-based consumer", () => {
    const flags = buildEventFlags(["message.received"]);

    expect(flags.messageReceived).toBe(true);
    expect(flags.connectionUpdate).toBe(false);
    expect(Object.keys(flags).some((key) => key.includes("."))).toBe(false);
  });
});
