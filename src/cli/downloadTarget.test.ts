import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isAppError } from "../shared/errors.ts";
import {
  assertDirectoryWritable,
  assertConcreteDestination,
  destinationPathFor,
  resolveDownloadTarget,
  sanitizeMessageIdForFile
} from "./downloadTarget.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wa-control-download-"));
  tempDirs.push(dir);
  return dir;
}

function captureError(action: () => void): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }

  throw new Error("esperava que a validacao falhasse");
}

describe("resolveDownloadTarget", () => {
  it("sem --out usa o diretorio corrente e deriva o nome depois do MIME", () => {
    const target = resolveDownloadTarget(undefined, "3EB0MEDIA");

    expect(target.fileName).toBeNull();
    expect(target.directory).toBe(process.cwd());
  });

  it("com --out separa diretorio e nome de arquivo", () => {
    const target = resolveDownloadTarget("/tmp/fotos/foto.jpg", "3EB0MEDIA");

    expect(target.directory).toBe(resolve("/tmp/fotos"));
    expect(target.fileName).toBe("foto.jpg");
  });

  it("--out terminando em separador e rejeitado como diretorio, nao arquivo", () => {
    const error = captureError(() => resolveDownloadTarget("/tmp/fotos/", "3EB0MEDIA"));

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("INVALID_OUTPUT");
    }
  });
});

describe("assertDirectoryWritable", () => {
  it("aceita um diretorio existente", () => {
    expect(() => assertDirectoryWritable(tempDir())).not.toThrow();
  });

  it("rejeita diretorio inexistente antes do fetch", () => {
    const error = captureError(() => assertDirectoryWritable(join(tempDir(), "nao-existe")));

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("INVALID_OUTPUT");
    }
  });

  it("rejeita caminho que existe mas nao e diretorio", () => {
    const dir = tempDir();
    const filePath = join(dir, "arquivo.txt");
    writeFileSync(filePath, "x");

    const error = captureError(() => assertDirectoryWritable(filePath));

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("INVALID_OUTPUT");
    }
  });
});

describe("assertConcreteDestination", () => {
  it("rejeita --out apontando para um diretorio existente", () => {
    const dir = tempDir();
    const target = resolveDownloadTarget(dir, "3EB0MEDIA");

    const error = captureError(() => assertConcreteDestination(target));

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("INVALID_OUTPUT");
    }
  });

  it("destino concreto inexistente passa na pre-validacao", () => {
    const dir = tempDir();
    const target = resolveDownloadTarget(join(dir, "foto.jpg"), "3EB0MEDIA");

    expect(() => assertConcreteDestination(target)).not.toThrow();
  });

  it("sem --out nao ha destino concreto para validar", () => {
    const target = resolveDownloadTarget(undefined, "3EB0MEDIA");

    expect(() => assertConcreteDestination(target)).not.toThrow();
  });
});

describe("destinationPathFor", () => {
  it("usa o nome de --out quando dado", () => {
    const target = resolveDownloadTarget("/tmp/fotos/foto.jpg", "3EB0MEDIA");

    expect(destinationPathFor(target, "image/png", "3EB0MEDIA")).toBe(
      resolve("/tmp/fotos/foto.jpg")
    );
  });

  it("sem --out deriva <messageId>.<ext pelo MIME> no diretorio alvo", () => {
    const dir = tempDir();
    const target = { directory: dir, fileName: null };

    expect(destinationPathFor(target, "image/jpeg", "3EB0MEDIA")).toBe(join(dir, "3EB0MEDIA.jpg"));
  });

  it("voice note ogg vira extensao .ogg", () => {
    const dir = tempDir();
    const target = { directory: dir, fileName: null };

    expect(destinationPathFor(target, "audio/ogg; codecs=opus", "3EB0MEDIA")).toBe(
      join(dir, "3EB0MEDIA.ogg")
    );
  });
});

describe("sanitizeMessageIdForFile", () => {
  it("mantem caracteres seguros", () => {
    expect(sanitizeMessageIdForFile("3EB0ABC-123_DEF.9")).toBe("3EB0ABC-123_DEF.9");
  });

  it("substitui separadores de caminho e caracteres arriscados", () => {
    expect(sanitizeMessageIdForFile("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeMessageIdForFile("id com espaco")).toBe("id_com_espaco");
  });

  it("id vazio ou inutil tem fallback", () => {
    expect(sanitizeMessageIdForFile("")).toBe("media");
    expect(sanitizeMessageIdForFile("///")).toBe("media");
  });
});
