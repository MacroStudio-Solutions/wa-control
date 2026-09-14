import { describe, expect, it } from "bun:test";
import { isAppError } from "../shared/errors.ts";
import { parseSendMediaRequest } from "./sendMediaRequest.ts";

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:43119/sessions/pessoal/send-media", {
    method: "POST",
    headers
  });
}

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }

  throw new Error("esperava que a operacao falhasse");
}

describe("parseSendMediaRequest", () => {
  it("le os metadados dos headers e decodifica a caption", () => {
    const parsed = parseSendMediaRequest(
      requestWithHeaders({
        "x-media-to": "556784020665",
        "x-media-kind": "image",
        "x-media-mime": "image/jpeg",
        "x-media-caption": encodeURIComponent("Bom dia")
      })
    );

    expect(parsed).toEqual({
      to: "556784020665",
      kind: "image",
      mimeType: "image/jpeg",
      caption: "Bom dia"
    });
  });

  it("audio com ptt marcado", () => {
    const parsed = parseSendMediaRequest(
      requestWithHeaders({
        "x-media-to": "556784020665@s.whatsapp.net",
        "x-media-kind": "audio",
        "x-media-mime": "audio/ogg; codecs=opus",
        "x-media-ptt": "1"
      })
    );

    expect(parsed.kind).toBe("audio");
    expect(parsed.ptt).toBe(true);
    expect(parsed.caption).toBeUndefined();
  });

  it("header faltante vira INVALID_REQUEST antes de tocar o corpo", () => {
    for (const headers of [
      { "x-media-kind": "image", "x-media-mime": "image/jpeg" },
      { "x-media-to": "556784020665", "x-media-mime": "image/jpeg" },
      { "x-media-to": "556784020665", "x-media-kind": "image" }
    ]) {
      const error = captureError(() => parseSendMediaRequest(requestWithHeaders(headers)));

      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) {
        expect(error.code).toBe("INVALID_REQUEST");
      }
    }
  });

  it("tipo fora do vocabulario vira INVALID_REQUEST", () => {
    const error = captureError(() =>
      parseSendMediaRequest(
        requestWithHeaders({
          "x-media-to": "556784020665",
          "x-media-kind": "figura",
          "x-media-mime": "image/jpeg"
        })
      )
    );

    expect(isAppError(error)).toBe(true);
    if (isAppError(error)) {
      expect(error.code).toBe("INVALID_REQUEST");
      expect(error.message).toContain("figura");
    }
  });
});
