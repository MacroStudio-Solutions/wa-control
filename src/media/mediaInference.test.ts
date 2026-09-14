import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAppError } from "../shared/errors.ts";
import {
  extensionForMimeType,
  fileExtension,
  inferMediaKindFromFile,
  inferMimeTypeFromFile,
  mediaDescriptorFromFile,
  mimeForMediaKind
} from "./mediaInference.ts";

function tempFile(name: string, bytes: number[] = [1, 2, 3]): string {
  const dir = mkdtempSync(join(tmpdir(), "wa-control-media-"));
  const path = join(dir, name);
  writeFileSync(path, new Uint8Array(bytes));
  return path;
}

describe("fileExtension", () => {
  it("extrai a extensao em minusculas", () => {
    expect(fileExtension("/tmp/FOTO.JPG")).toBe("jpg");
    expect(fileExtension("audio.OGG")).toBe("ogg");
    expect(fileExtension("sem-extensao")).toBe("");
    expect(fileExtension("arquivo.tar.gz")).toBe("gz");
  });
});

describe("inferMediaKindFromFile", () => {
  it("mapeia extensoes de imagem", () => {
    expect(inferMediaKindFromFile("foto.jpg")).toBe("image");
    expect(inferMediaKindFromFile("foto.jpeg")).toBe("image");
    expect(inferMediaKindFromFile("foto.png")).toBe("image");
    expect(inferMediaKindFromFile("figurinha.webp")).toBe("image");
  });

  it("mapeia extensoes de audio", () => {
    expect(inferMediaKindFromFile("nota.ogg")).toBe("audio");
    expect(inferMediaKindFromFile("nota.opus")).toBe("audio");
    expect(inferMediaKindFromFile("musica.mp3")).toBe("audio");
    expect(inferMediaKindFromFile("voz.m4a")).toBe("audio");
  });

  it("mapeia extensoes de video e documento", () => {
    expect(inferMediaKindFromFile("clip.mp4")).toBe("video");
    expect(inferMediaKindFromFile("relatorio.pdf")).toBe("document");
  });

  it("devolve null quando a extensao nao e reconhecida", () => {
    expect(inferMediaKindFromFile("arquivo.xyz")).toBeNull();
    expect(inferMediaKindFromFile("sem-extensao")).toBeNull();
  });
});

describe("inferMimeTypeFromFile", () => {
  it("deriva o MIME da extensao", () => {
    expect(inferMimeTypeFromFile("foto.jpg", "image")).toBe("image/jpeg");
    expect(inferMimeTypeFromFile("foto.png", "image")).toBe("image/png");
    expect(inferMimeTypeFromFile("figurinha.webp", "image")).toBe("image/webp");
    expect(inferMimeTypeFromFile("musica.mp3", "audio")).toBe("audio/mpeg");
    expect(inferMimeTypeFromFile("clip.mp4", "video")).toBe("video/mp4");
    expect(inferMimeTypeFromFile("relatorio.pdf", "document")).toBe("application/pdf");
  });

  it("audio/ogg sem ptt fica audio/ogg puro", () => {
    expect(inferMimeTypeFromFile("nota.ogg", "audio")).toBe("audio/ogg");
  });

  it("ptt em arquivo ogg/opus usa audio/ogg; codecs=opus", () => {
    expect(inferMimeTypeFromFile("nota.ogg", "audio", { ptt: true })).toBe(
      "audio/ogg; codecs=opus"
    );
    expect(inferMimeTypeFromFile("nota.opus", "audio", { ptt: true })).toBe(
      "audio/ogg; codecs=opus"
    );
  });

  it("ptt em arquivo nao-ogg mantem o MIME verdadeiro do arquivo", () => {
    expect(inferMimeTypeFromFile("musica.mp3", "audio", { ptt: true })).toBe("audio/mpeg");
  });

  it("extensao desconhecida cai no MIME padrao do tipo", () => {
    expect(inferMimeTypeFromFile("arquivo.xyz", "image")).toBe("image/jpeg");
    expect(inferMimeTypeFromFile("arquivo.xyz", "audio")).toBe("audio/mpeg");
    expect(inferMimeTypeFromFile("arquivo.xyz", "video")).toBe("video/mp4");
    expect(inferMimeTypeFromFile("arquivo.xyz", "document")).toBe("application/octet-stream");
    expect(inferMimeTypeFromFile("arquivo.xyz", "sticker")).toBe("image/webp");
  });

  it("override de tipo em desacordo com a extensao nao mente no MIME", () => {
    expect(inferMimeTypeFromFile("musica.mp3", "image")).toBe("image/jpeg");
    expect(inferMimeTypeFromFile("foto.jpg", "audio")).toBe("audio/mpeg");
    expect(inferMimeTypeFromFile("nota.ogg", "image")).toBe("image/jpeg");
    expect(inferMimeTypeFromFile("musica.mp3", "video")).toBe("video/mp4");
  });

  it("override em desacordo nao afeta documento, cuja familia de MIME e heterogenea", () => {
    expect(inferMimeTypeFromFile("relatorio.pdf", "document")).toBe("application/pdf");
    expect(inferMimeTypeFromFile("notas.txt", "document")).toBe("text/plain");
  });
});

describe("mimeForMediaKind", () => {
  it("devolve o MIME padrao de cada tipo", () => {
    expect(mimeForMediaKind("image")).toBe("image/jpeg");
    expect(mimeForMediaKind("audio")).toBe("audio/mpeg");
    expect(mimeForMediaKind("video")).toBe("video/mp4");
    expect(mimeForMediaKind("document")).toBe("application/octet-stream");
    expect(mimeForMediaKind("sticker")).toBe("image/webp");
  });
});

describe("extensionForMimeType", () => {
  it("deriva a extensao do MIME base", () => {
    expect(extensionForMimeType("image/jpeg")).toBe("jpg");
    expect(extensionForMimeType("image/png")).toBe("png");
    expect(extensionForMimeType("audio/mpeg")).toBe("mp3");
    expect(extensionForMimeType("application/pdf")).toBe("pdf");
  });

  it("ignora parametros do MIME", () => {
    expect(extensionForMimeType("audio/ogg; codecs=opus")).toBe("ogg");
  });

  it("MIME desconhecido cai em bin", () => {
    expect(extensionForMimeType("application/x-futuro")).toBe("bin");
  });
});

describe("mediaDescriptorFromFile", () => {
  it("monta o descritor com kind, MIME e buffer do arquivo", () => {
    const bytes = [10, 20, 30, 40];
    const path = tempFile("foto.jpg", bytes);

    const descriptor = mediaDescriptorFromFile(path);

    expect(descriptor.kind).toBe("image");
    expect(descriptor.mimeType).toBe("image/jpeg");
    expect(descriptor.payload.kind).toBe("buffer");
    if (descriptor.payload.kind === "buffer") {
      expect(Array.from(descriptor.payload.buffer)).toEqual(bytes);
    }
  });

  it("override de tipo vale para extensao desconhecida", () => {
    const path = tempFile("arquivo.xyz");

    const descriptor = mediaDescriptorFromFile(path, { kindOverride: "audio", ptt: true });

    expect(descriptor.kind).toBe("audio");
    expect(descriptor.mimeType).toBe("audio/mpeg");
  });

  it("override de tipo em desacordo com a extensao mantem o MIME na familia do tipo", () => {
    const path = tempFile("musica.mp3");

    const descriptor = mediaDescriptorFromFile(path, { kindOverride: "image" });

    expect(descriptor.kind).toBe("image");
    expect(descriptor.mimeType).toBe("image/jpeg");
  });

  it("sem tipo inferivel nem override, rejeita com MEDIA_TYPE_UNRESOLVED", () => {
    const path = tempFile("arquivo.xyz");

    try {
      mediaDescriptorFromFile(path);
      throw new Error("deveria ter rejeitado");
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe("MEDIA_TYPE_UNRESOLVED");
        expect(error.message).toContain("--type");
      }
    }
  });

  it("arquivo de audio ogg com ptt carrega o MIME de voice note", () => {
    const path = tempFile("nota.ogg");

    const descriptor = mediaDescriptorFromFile(path, { ptt: true });

    expect(descriptor.kind).toBe("audio");
    expect(descriptor.mimeType).toBe("audio/ogg; codecs=opus");
  });
});
