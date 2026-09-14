import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAppError } from "../shared/errors.ts";
import { resolveSendMediaSource } from "./sendMediaSource.ts";

const tempDirs: string[] = [];

function tempFile(name: string, bytes: number[] = [1, 2, 3]): string {
  const dir = mkdtempSync(join(tmpdir(), "wa-control-send-media-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, new Uint8Array(bytes));
  return path;
}

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }

  throw new Error("esperava que a operacao falhasse");
}

describe("resolveSendMediaSource", () => {
  it("inferindo imagem: le o arquivo e devolve kind, MIME e buffer", () => {
    const bytes = [9, 8, 7];
    const path = tempFile("foto.jpg", bytes);

    const source = resolveSendMediaSource(path, {});

    expect(source.kind).toBe("image");
    expect(source.mimeType).toBe("image/jpeg");
    expect(Array.from(source.buffer)).toEqual(bytes);
  });

  it("override --type resolve extensao desconhecida", () => {
    const path = tempFile("arquivo.xyz");

    const source = resolveSendMediaSource(path, { typeOverride: "audio" });

    expect(source.kind).toBe("audio");
    expect(source.mimeType).toBe("audio/mpeg");
  });

  it("ptt em ogg rotula audio/ogg; codecs=opus", () => {
    const path = tempFile("nota.ogg");

    const source = resolveSendMediaSource(path, { ptt: true });

    expect(source.kind).toBe("audio");
    expect(source.mimeType).toBe("audio/ogg; codecs=opus");
  });

  it("arquivo inexistente vira MEDIA_FILE_UNREADABLE antes de qualquer rede", () => {
    const error = captureError(() =>
      resolveSendMediaSource("/caminho/que/nao/existe/foto.jpg", {})
    );

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("MEDIA_FILE_UNREADABLE");
    }
  });

  it("arquivo sem permissao de leitura vira MEDIA_FILE_UNREADABLE", () => {
    if (process.platform === "win32") {
      return;
    }

    const path = tempFile("protegido.jpg");
    chmodSync(path, 0o000);

    try {
      const error = captureError(() => resolveSendMediaSource(path, {}));

      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe("MEDIA_FILE_UNREADABLE");
        expect(error.message).toContain("permissao");
      }
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("tipo nao liberado (video por override) vira MEDIA_TYPE_NOT_SUPPORTED_YET", () => {
    const path = tempFile("clip.mp4");

    const error = captureError(() => resolveSendMediaSource(path, {}));

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("MEDIA_TYPE_NOT_SUPPORTED_YET");
      expect(error.message).toContain("Tipos liberados");
    }
  });

  it("caption em audio e recusada com INVALID_FLAG antes do POST", () => {
    const path = tempFile("nota.ogg");

    const error = captureError(() =>
      resolveSendMediaSource(path, { caption: "legenda" })
    );

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("INVALID_FLAG");
      expect(error.message).toContain("--caption");
    }
  });

  it("caption em imagem e aceita", () => {
    const path = tempFile("foto.png");

    const source = resolveSendMediaSource(path, { caption: "Veja isso" });

    expect(source.kind).toBe("image");
  });

  it("--ptt em imagem e recusado com INVALID_FLAG", () => {
    const path = tempFile("foto.png");

    const error = captureError(() => resolveSendMediaSource(path, { ptt: true }));

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("INVALID_FLAG");
      expect(error.message).toContain("--ptt");
    }
  });

  it("override para audio com --ptt e aceito mesmo com extensao estranha", () => {
    const path = tempFile("voz");

    const source = resolveSendMediaSource(path, { typeOverride: "audio", ptt: true });

    expect(source.kind).toBe("audio");
    expect(source.mimeType).toBe("audio/mpeg");
  });
});
