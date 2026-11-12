import { describe, expect, it } from "bun:test";
import { AppError } from "../shared/errors.ts";
import {
  classifyMissingPicture,
  ProfilePictureService,
  profilePictureMime,
  type ProfilePictureSource
} from "./profilePicture.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function boom(code: number, text: string): Error {
  return Object.assign(new Error(text), { data: code, isBoom: true });
}

function source(over: Partial<ProfilePictureSource> = {}) {
  const calls: string[] = [];
  const src: ProfilePictureSource = {
    resolveJid: async (chat) => {
      calls.push(`resolve:${chat}`);
      return chat.includes("@") ? chat : `${chat}@s.whatsapp.net`;
    },
    pictureUrl: async (jid) => {
      calls.push(`url:${jid}`);
      return `https://pps.whatsapp.net/${jid}`;
    },
    download: async (url) => {
      calls.push(`download:${url}`);
      return { buffer: JPEG, contentType: "image/jpeg" };
    },
    ...over
  };
  return { src, calls };
}

describe("ProfilePictureService", () => {
  it("foto achada volta com mime e bytes; a segunda chamada sai do cache sem consultar o WhatsApp", async () => {
    let now = 1_000;
    const { src, calls } = source();
    const service = new ProfilePictureService(src, { now: () => now });
    const first = await service.get("556299990000");
    expect(first).toMatchObject({ found: true, jid: "556299990000@s.whatsapp.net", mimeType: "image/jpeg", cached: false });
    const again = await service.get("556299990000");
    expect(again).toMatchObject({ found: true, cached: true });
    expect(calls.filter((call) => call.startsWith("url:"))).toHaveLength(1);

    now += 7 * 60 * 60 * 1000;
    await service.get("556299990000");
    expect(calls.filter((call) => call.startsWith("url:"))).toHaveLength(2);
  });

  it("sem foto (404 item-not-found) e escondida (401 not-authorized) sao resultado, nunca erro", async () => {
    const missing = new ProfilePictureService(
      source({ pictureUrl: async () => Promise.reject(boom(404, "item-not-found")) }).src
    );
    expect(await missing.get("5562")).toMatchObject({ found: false, reason: "not-found" });

    const hidden = new ProfilePictureService(
      source({ pictureUrl: async () => Promise.reject(boom(401, "not-authorized")) }).src
    );
    expect(await hidden.get("5562")).toMatchObject({ found: false, reason: "not-authorized" });

    const empty = new ProfilePictureService(source({ pictureUrl: async () => undefined }).src);
    expect(await empty.get("5562")).toMatchObject({ found: false, reason: "not-found" });
  });

  it("outra recusa do WhatsApp e erro PROFILE_PICTURE_FAILED e nao fica em cache", async () => {
    let fail = true;
    const service = new ProfilePictureService(
      source({
        pictureUrl: async (jid) => {
          if (fail) {
            throw boom(500, "internal-server-error");
          }
          return `https://pps.whatsapp.net/${jid}`;
        }
      }).src
    );
    await expect(service.get("5562")).rejects.toMatchObject({ code: "PROFILE_PICTURE_FAILED" });
    fail = false;
    expect(await service.get("5562")).toMatchObject({ found: true });
  });

  it("erro tipado da sessao passa como esta (sessao caiu no meio)", async () => {
    const service = new ProfilePictureService(
      source({
        pictureUrl: async () => {
          throw new AppError("SESSION_NOT_CONNECTED", 409, "Sessao nao conectada.");
        }
      }).src
    );
    await expect(service.get("5562")).rejects.toMatchObject({ code: "SESSION_NOT_CONNECTED" });
  });

  it("consultas correm uma de cada vez e pedidos iguais em curso dividem o mesmo resultado", async () => {
    let active = 0;
    let peak = 0;
    const { src, calls } = source({
      pictureUrl: async (jid) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        calls.push(`url:${jid}`);
        return `https://pps.whatsapp.net/${jid}`;
      }
    });
    const service = new ProfilePictureService(src);
    const results = await Promise.all([
      service.get("5562000001"),
      service.get("5562000002"),
      service.get("5562000001"),
      service.get("5562000003")
    ]);
    expect(results.every((result) => result.found)).toBe(true);
    expect(peak).toBe(1);
    expect(calls.filter((call) => call.startsWith("url:"))).toHaveLength(3);
  });

  it("download que nao e imagem ou passa do teto vira erro", async () => {
    const notImage = new ProfilePictureService(
      source({ download: async () => ({ buffer: new Uint8Array([1, 2, 3]), contentType: "text/html" }) }).src
    );
    await expect(notImage.get("5562")).rejects.toMatchObject({ code: "PROFILE_PICTURE_DOWNLOAD_FAILED" });

    const big = new ProfilePictureService(source().src, { maxBytes: 3 });
    await expect(big.get("5562")).rejects.toMatchObject({ code: "PROFILE_PICTURE_TOO_LARGE" });
  });

  it("o cache tem teto de entradas", async () => {
    const { src, calls } = source();
    const service = new ProfilePictureService(src, { maxEntries: 2 });
    await service.get("1");
    await service.get("2");
    await service.get("3");
    await service.get("1");
    expect(calls.filter((call) => call === "url:1@s.whatsapp.net")).toHaveLength(2);
  });
});

describe("classificacao e mime", () => {
  it("so 404/401 viram sem foto", () => {
    expect(classifyMissingPicture(boom(404, "x"))).toBe("not-found");
    expect(classifyMissingPicture(new Error("item-not-found"))).toBe("not-found");
    expect(classifyMissingPicture(boom(401, "x"))).toBe("not-authorized");
    expect(classifyMissingPicture(boom(408, "timeout"))).toBeNull();
  });

  it("mime pelo content-type de imagem; senao pelos bytes", () => {
    expect(profilePictureMime("image/jpeg; charset=binary", JPEG)).toBe("image/jpeg");
    expect(profilePictureMime(null, JPEG)).toBe("image/jpeg");
    expect(profilePictureMime("application/octet-stream", new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(
      "image/png"
    );
    expect(profilePictureMime("text/html", new Uint8Array([1]))).toBeNull();
  });
});
