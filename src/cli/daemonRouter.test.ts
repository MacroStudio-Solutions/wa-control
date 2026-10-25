import { describe, expect, it } from "bun:test";
import { renderHelp } from "./render.ts";
import { parseCliCommand } from "./router.ts";

describe("parseCliCommand: daemon start e daemon stop", () => {
  it("daemon start em primeiro plano continua igual, com ou sem --json", () => {
    expect(parseCliCommand(["daemon", "start"])).toEqual({ kind: "daemon.start" });
    expect(parseCliCommand(["daemon", "start", "--json"])).toEqual({ kind: "daemon.start" });
  });

  it("daemon start --background escolhe a partida destacada", () => {
    expect(parseCliCommand(["daemon", "start", "--background"])).toEqual({
      kind: "daemon.start.background",
      json: false
    });
    expect(parseCliCommand(["daemon", "start", "--background", "--json"])).toEqual({
      kind: "daemon.start.background",
      json: true
    });
    expect(parseCliCommand(["daemon", "start", "--json", "--background"])).toEqual({
      kind: "daemon.start.background",
      json: true
    });
  });

  it("daemon stop sem flags nao fixa o orcamento", () => {
    expect(parseCliCommand(["daemon", "stop"])).toEqual({ kind: "daemon.stop", json: false });
    expect(parseCliCommand(["daemon", "stop", "--json"])).toEqual({ kind: "daemon.stop", json: true });
  });

  it("daemon stop aceita --wait-ms antes ou depois de --json", () => {
    expect(parseCliCommand(["daemon", "stop", "--json", "--wait-ms", "7500"])).toEqual({
      kind: "daemon.stop",
      json: true,
      waitMs: 7500
    });
    expect(parseCliCommand(["daemon", "stop", "--wait-ms", "0"])).toEqual({
      kind: "daemon.stop",
      json: false,
      waitMs: 0
    });
  });

  it("daemon stop recusa --wait-ms invalido", () => {
    for (const value of ["abc", "-1", "1.5"]) {
      expect(() => parseCliCommand(["daemon", "stop", "--wait-ms", value])).toThrow(/wait-ms/);
    }

    expect(() => parseCliCommand(["daemon", "stop", "--wait-ms"])).toThrow(/wait-ms/);
  });

  it("a ajuda lista os dois verbos e a flag de orcamento", () => {
    const help = renderHelp();

    expect(help).toContain("wa daemon start [--background [--json]]");
    expect(help).toContain("wa daemon stop [--wait-ms 7500] [--json]");
    expect(help).toContain("POST /shutdown");
  });
});
