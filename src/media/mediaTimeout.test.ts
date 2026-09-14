import { describe, expect, it } from "bun:test";
import { DEFAULT_TIMEOUTS } from "../shared/localApiClient.ts";

describe("timeout dedicado de midia", () => {
  it("midia tem 60s", () => {
    expect(DEFAULT_TIMEOUTS.mediaTimeoutMs).toBe(60_000);
  });

  it("e distinto da leitura (1,5s) e do send-texto (15s)", () => {
    expect(DEFAULT_TIMEOUTS.requestTimeoutMs).toBe(1_500);
    expect(DEFAULT_TIMEOUTS.sendTimeoutMs).toBe(15_000);
    expect(DEFAULT_TIMEOUTS.mediaTimeoutMs).not.toBe(DEFAULT_TIMEOUTS.requestTimeoutMs);
    expect(DEFAULT_TIMEOUTS.mediaTimeoutMs).not.toBe(DEFAULT_TIMEOUTS.sendTimeoutMs);
    expect(DEFAULT_TIMEOUTS.mediaTimeoutMs).not.toBe(DEFAULT_TIMEOUTS.connectTimeoutMs);
  });
});
