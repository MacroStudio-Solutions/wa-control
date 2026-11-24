import { describe, expect, it } from "bun:test";
import { nextFreeSessionName } from "./sessionName.ts";

describe("nextFreeSessionName", () => {
  it("nomeia a primeira sessao de principal", () => {
    expect(nextFreeSessionName([])).toBe("principal");
  });

  it("mantem principal quando so existem outros nomes", () => {
    expect(nextFreeSessionName(["vendas", "financeiro"])).toBe("principal");
  });

  it("vai para session-2 quando principal existe", () => {
    expect(nextFreeSessionName(["principal"])).toBe("session-2");
  });

  it("caminha ate o proximo nome livre", () => {
    expect(nextFreeSessionName(["principal", "session-2", "session-3"])).toBe("session-4");
  });

  it("preenche o buraco deixado por uma sessao removida", () => {
    expect(nextFreeSessionName(["principal", "session-3"])).toBe("session-2");
  });

  it("compara o nome inteiro, nunca por prefixo", () => {
    expect(nextFreeSessionName(["principal-2", "session-22"])).toBe("principal");
  });
});
