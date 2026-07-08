import { BufferJSON } from "@whiskeysockets/baileys";
import type { NormalizedEvent } from "./types.ts";

interface BigIntMarker {
  type: "BigInt";
  data: string;
}

function isBigIntMarker(value: unknown): value is BigIntMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "data" in value &&
    value.type === "BigInt" &&
    typeof value.data === "string"
  );
}

export function stripRawFromEvent(event: NormalizedEvent): NormalizedEvent {
  if (!("raw" in event)) {
    return event;
  }

  const { raw: _raw, ...rest } = event;
  return rest as NormalizedEvent;
}

export function stringifyEvent(event: NormalizedEvent): string {
  return JSON.stringify(event, (_key, value) => {
    if (typeof value === "bigint") {
      return {
        type: "BigInt",
        data: value.toString()
      } satisfies BigIntMarker;
    }

    return BufferJSON.replacer("", value);
  });
}

export function parseEventJson(json: string): NormalizedEvent {
  return JSON.parse(json, (_key, value) => {
    if (isBigIntMarker(value)) {
      return BigInt(value.data);
    }

    return BufferJSON.reviver("", value);
  }) as NormalizedEvent;
}
