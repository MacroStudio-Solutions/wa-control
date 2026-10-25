import { describe, expect, it } from "bun:test";
import { describeStartFailure, forceReserveMs, selfCommand } from "./daemonControl.ts";
import { firstLineOf, formatStartHeader, truncateDetail } from "./daemonLog.ts";
import { formatLogLine } from "../shared/logger.ts";

describe("formatStartHeader", () => {
  it("traz data, versao, pid e porta em uma linha so", () => {
    const header = formatStartHeader({
      startedAt: "2026-10-24T20:00:00.000Z",
      version: "0.8.0",
      pid: 4321,
      port: 43990
    });

    expect(header).not.toContain("\n");
    expect(header).toContain("2026-10-24T20:00:00.000Z");
    expect(header).toContain("versao 0.8.0");
    expect(header).toContain("pid 4321");
    expect(header).toContain("porta 43990");
  });
});

describe("describeStartFailure", () => {
  it("usa a linha estruturada do proprio filho, nao a de outra partida", () => {
    const log = [
      "=== wa-control daemon | inicio x | versao 0.8.0 | pid 11 | porta 1 ===",
      formatLogLine("info", "daemon iniciado", { pid: 11 }),
      "=== wa-control daemon | inicio x | versao 0.8.0 | pid 22 | porta 1 ===",
      formatLogLine("error", "daemon nao iniciou", { pid: 99, motivo: "de outro filho" }),
      formatLogLine("error", "daemon nao iniciou", { pid: 22, motivo: "Ja existe um daemon vivo." })
    ].join("\n");

    expect(describeStartFailure(log, 22, 1)).toBe("Ja existe um daemon vivo.");
  });

  it("sem linha estruturada devolve o fim do log, sem o cabecalho", () => {
    const log = [
      "=== wa-control daemon | inicio x | versao 0.8.0 | pid 7 | porta 1 ===",
      "Failed to start server. Is port 43990 in use?"
    ].join("\n");

    expect(describeStartFailure(log, 7, 1)).toBe("Failed to start server. Is port 43990 in use?");
  });

  it("sem nenhuma saida cita o codigo de saida", () => {
    expect(describeStartFailure("", 7, 3)).toContain("codigo 3");
  });

  it("limita o tamanho do motivo", () => {
    const motivo = "x".repeat(2000);
    const log = formatLogLine("error", "daemon nao iniciou", { pid: 5, motivo });

    expect(describeStartFailure(log, 5, 1).length).toBeLessThanOrEqual(400);
  });
});

describe("textos de motivo", () => {
  it("firstLineOf fica com a primeira linha nao vazia", () => {
    expect(firstLineOf("\n  primeira  \nsegunda")).toBe("primeira");
    expect(truncateDetail("a".repeat(500))).toHaveLength(400);
  });
});

describe("forceReserveMs", () => {
  it("reserva uma parte do orcamento para forcar, entre 400 ms e 1,5 s", () => {
    expect(forceReserveMs(0)).toBe(400);
    expect(forceReserveMs(1500)).toBe(400);
    expect(forceReserveMs(5000)).toBe(1000);
    expect(forceReserveMs(7500)).toBe(1500);
    expect(forceReserveMs(60_000)).toBe(1500);
  });
});

describe("selfCommand", () => {
  it("reexecuta o mesmo interpretador e o mesmo script, acrescentando os argumentos", () => {
    const command = selfCommand(["daemon", "start"]);

    expect(command[0]).toBe(process.execPath);
    expect(command.slice(-2)).toEqual(["daemon", "start"]);
    expect(command).toContain(process.argv[1] ?? "");
  });
});
