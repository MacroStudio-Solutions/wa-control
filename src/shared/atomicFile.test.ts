import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProcessHarness, createTempDataDir } from "../test-support/processHarness.ts";
import { writeFileAtomically } from "./atomicFile.ts";

afterEach(cleanupProcessHarness);

const BODY_SIZE = 512 * 1024;

function bodyOf(letter: string): string {
  return `${letter.repeat(BODY_SIZE)}\n`;
}

const WRITER = `
const [modulePath, target, rounds] = process.argv.slice(2);
const { writeFileAtomically } = await import(modulePath);
const bodyA = "A".repeat(${BODY_SIZE}) + "\\n";
const bodyB = "B".repeat(${BODY_SIZE}) + "\\n";

for (let index = 0; index < Number(rounds); index += 1) {
  writeFileAtomically(target, index % 2 === 0 ? bodyB : bodyA);
}
`;

function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

describe("writeFileAtomically", () => {
  it("grava o conteudo completo num arquivo novo e nao deixa temporario", () => {
    const dir = createTempDataDir();
    const target = join(dir, "config.json");

    writeFileAtomically(target, '{"a":1}\n');

    expect(readFileSync(target, "utf8")).toBe('{"a":1}\n');
    expect(leftovers(dir)).toEqual([]);
  });

  it("substitui o conteudo de um arquivo existente", () => {
    const dir = createTempDataDir();
    const target = join(dir, "config.json");
    writeFileSync(target, "antigo muito mais comprido do que o novo\n", "utf8");

    writeFileAtomically(target, "novo\n");

    expect(readFileSync(target, "utf8")).toBe("novo\n");
    expect(leftovers(dir)).toEqual([]);
  });

  it("falha na troca: o destino fica como estava e o temporario some", () => {
    const dir = createTempDataDir();
    const target = join(dir, "config.json");
    mkdirSync(target);
    writeFileSync(join(target, "dentro.txt"), "intacto", "utf8");

    expect(() => writeFileAtomically(target, "novo\n")).toThrow();

    expect(statSync(target).isDirectory()).toBe(true);
    expect(readFileSync(join(target, "dentro.txt"), "utf8")).toBe("intacto");
    expect(leftovers(dir)).toEqual([]);
  });

  it("falha ao criar o temporario: o destino existente continua com o conteudo antigo", () => {
    const dir = createTempDataDir();
    const target = join(dir, "faltando", "config.json");

    expect(() => writeFileAtomically(target, "novo\n")).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it("um leitor concorrente nunca ve o arquivo vazio nem parcial", async () => {
    const dir = createTempDataDir();
    const target = join(dir, "config.json");
    const scriptPath = join(dir, "writer.ts");
    const bodyA = bodyOf("A");
    const bodyB = bodyOf("B");
    writeFileSync(scriptPath, WRITER, "utf8");
    writeFileSync(target, bodyA, "utf8");

    const writer = Bun.spawn(
      ["bun", scriptPath, join(import.meta.dir, "atomicFile.ts"), target, "150"],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" }
    );
    let finished = false;
    void writer.exited.then(() => {
      finished = true;
    });

    let samples = 0;
    const invalid: number[] = [];

    while (!finished) {
      let text: string | null = null;

      try {
        text = readFileSync(target, "utf8");
      } catch {
        // o Windows pode recusar a leitura no instante exato da troca; so conta conteudo lido
      }

      if (text !== null) {
        samples += 1;

        if (text !== bodyA && text !== bodyB) {
          invalid.push(text.length);
        }
      }

      await Bun.sleep(0);
    }

    expect(await writer.exited).toBe(0);
    expect(samples).toBeGreaterThan(0);
    expect(invalid).toEqual([]);
    expect(leftovers(dir)).toEqual([]);
  }, 60_000);
});
