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

  it("video e liberado: clip.mp4 resolve kind e MIME sem override", () => {
    const path = tempFile("clip.mp4");

    const source = resolveSendMediaSource(path, {});

    expect(source.kind).toBe("video");
    expect(source.mimeType).toBe("video/mp4");
    expect(source.fileName).toBe("clip.mp4");
  });

  it("documento e liberado: relatorio.pdf resolve e carrega o nome inferido", () => {
    const path = tempFile("relatorio.pdf");

    const source = resolveSendMediaSource(path, {});

    expect(source.kind).toBe("document");
    expect(source.mimeType).toBe("application/pdf");
    expect(source.fileName).toBe("relatorio.pdf");
  });

  it("documento com --filename sobrepoe o nome inferido", () => {
    const path = tempFile("relatorio-final-v2.pdf");

    const source = resolveSendMediaSource(path, { fileName: "Relatorio.pdf" });

    expect(source.kind).toBe("document");
    expect(source.fileName).toBe("Relatorio.pdf");
  });

  it("sticker por override vira MEDIA_TYPE_NOT_SUPPORTED_YET com a lista atualizada", () => {
    const path = tempFile("figurinha.webp");
    const error = captureError(() => resolveSendMediaSource(path, { typeOverride: "sticker" }));

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("MEDIA_TYPE_NOT_SUPPORTED_YET");
      expect(error.message).toContain("Tipos liberados");
      expect(error.message).toContain("image, audio, video, document");
    }
  });

  it("arquivo sem extensao reconhecida sem --type vira MEDIA_TYPE_UNRESOLVED, nunca tipo errado", () => {
    const path = tempFile("clip");

    const error = captureError(() => resolveSendMediaSource(path, {}));

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("MEDIA_TYPE_UNRESOLVED");
      expect(error.message).toContain("--type");
    }
  });

  it("arquivo sem extensao com --type document resolve com MIME padrao de documento", () => {
    const path = tempFile("arquivo");

    const source = resolveSendMediaSource(path, { typeOverride: "document" });

    expect(source.kind).toBe("document");
    expect(source.mimeType).toBe("application/octet-stream");
    expect(source.fileName).toBe("arquivo");
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

  it("caption em video e aceita", () => {
    const path = tempFile("clip.mp4");

    const source = resolveSendMediaSource(path, { caption: "Olha o clipe" });

    expect(source.kind).toBe("video");
  });

  it("caption em documento e recusada com INVALID_FLAG", () => {
    const path = tempFile("relatorio.pdf");

    const error = captureError(() =>
      resolveSendMediaSource(path, { caption: "legenda" })
    );

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("INVALID_FLAG");
      expect(error.message).toContain("--caption");
    }
  });

  it("--filename em imagem e recusado com INVALID_FLAG", () => {
    const path = tempFile("foto.png");

    const error = captureError(() =>
      resolveSendMediaSource(path, { fileName: "foto.png" })
    );

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("INVALID_FLAG");
      expect(error.message).toContain("--filename");
    }
  });

  it("--filename em audio e recusado com INVALID_FLAG", () => {
    const path = tempFile("nota.ogg");

    const error = captureError(() =>
      resolveSendMediaSource(path, { fileName: "nota.ogg" })
    );

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("INVALID_FLAG");
    }
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
