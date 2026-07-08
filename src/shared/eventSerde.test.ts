import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { parseEventJson, stringifyEvent, stripRawFromEvent } from "./eventSerde.ts";
import type { NormalizedEvent } from "./types.ts";

describe("eventSerde", () => {
  it("serializes and restores raw payloads safely", () => {
    const event: NormalizedEvent = {
      id: "1",
      event: "message.received",
      sessionId: "pessoal",
      timestamp: 123,
      raw: {
        bytes: Buffer.from("abc"),
        nested: {
          value: BigInt(7)
        }
      }
    };

    const parsed = parseEventJson(stringifyEvent(event));

    expect(Buffer.isBuffer(parsed.raw?.bytes)).toBe(true);
    expect((parsed.raw?.bytes as Buffer).toString("utf8")).toBe("abc");
    expect(parsed.raw?.nested).toEqual({ value: BigInt(7) });
  });

  it("can strip raw before external output", () => {
    const event: NormalizedEvent = {
      id: "1",
      event: "message.received",
      sessionId: "pessoal",
      timestamp: 123,
      raw: {
        token: "secret"
      },
      text: "oi"
    };

    expect(stripRawFromEvent(event)).toEqual({
      id: "1",
      event: "message.received",
      sessionId: "pessoal",
      timestamp: 123,
      text: "oi"
    });
  });
});
