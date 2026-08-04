import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import { extractContactLidPairs, extractMessageLidPairs } from "./lidDirectory.ts";
import { normalizeIncomingMessage } from "./normalizeMessage.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createAuthDir(withMapping = false): string {
  const authDir = mkdtempSync(join(tmpdir(), "wa-control-normalize-"));
  tempDirs.push(authDir);

  if (withMapping) {
    writeFileSync(join(authDir, "lid-mapping-556784020665.json"), "\"88356755087579\"\n");
    writeFileSync(join(authDir, "lid-mapping-88356755087579_reverse.json"), "\"556784020665\"\n");
  }

  return authDir;
}

function directMessage(key: Record<string, unknown>): WAMessage {
  return {
    key: { fromMe: false, id: "msg-1", ...key },
    pushName: "Priscila Leite",
    messageTimestamp: 1783506977,
    message: { conversation: "Bom dia" }
  } as unknown as WAMessage;
}

describe("normalizeIncomingMessage", () => {
  it("delivers the phone number carried alongside the LID envelope", () => {
    const event = normalizeIncomingMessage(
      "pessoal",
      directMessage({
        remoteJid: "88356755087579@lid",
        remoteJidAlt: "556784020665@s.whatsapp.net"
      }),
      createAuthDir()
    );

    expect(event).not.toBeNull();
    expect(event?.chatId).toBe("88356755087579@lid");
    expect(event?.chatType).toBe("direct");
    expect(event?.chatPhoneNumber).toBe("556784020665");
    expect(event?.from).toBe("556784020665@s.whatsapp.net");
    expect(event?.fromPhoneNumber).toBe("556784020665");
    expect(event?.fromLid).toBe("88356755087579@lid");
    expect(event?.senderResolved).toBe(true);
    expect(event?.pushName).toBe("Priscila Leite");
    expect(event?.text).toBe("Bom dia");
  });

  it("falls back to the stored pairing when the envelope omits the number", () => {
    const event = normalizeIncomingMessage(
      "pessoal",
      directMessage({ remoteJid: "88356755087579@lid" }),
      createAuthDir(true)
    );

    expect(event?.fromPhoneNumber).toBe("556784020665");
    expect(event?.from).toBe("556784020665@s.whatsapp.net");
    expect(event?.senderResolved).toBe(true);
  });

  it("never emits an empty sender, and flags an unresolved contact", () => {
    const event = normalizeIncomingMessage(
      "pessoal",
      directMessage({ remoteJid: "88356755087579@lid" }),
      createAuthDir()
    );

    expect(event?.from).toBe("88356755087579@lid");
    expect(event?.fromLid).toBe("88356755087579@lid");
    expect(event?.fromPhoneNumber).toBeNull();
    expect(event?.senderResolved).toBe(false);
  });

  it("strips the device suffix from the resolved number", () => {
    const event = normalizeIncomingMessage(
      "pessoal",
      directMessage({
        remoteJid: "88356755087579@lid",
        remoteJidAlt: "556784020665:12@s.whatsapp.net"
      }),
      createAuthDir()
    );

    expect(event?.fromPhoneNumber).toBe("556784020665");
    expect(event?.from).toBe("556784020665@s.whatsapp.net");
  });

  it("resolves the participant, not the group, as the sender", () => {
    const event = normalizeIncomingMessage(
      "pessoal",
      directMessage({
        remoteJid: "120363000000000000@g.us",
        participant: "88356755087579@lid",
        participantAlt: "556784020665@s.whatsapp.net"
      }),
      createAuthDir()
    );

    expect(event?.chatId).toBe("120363000000000000@g.us");
    expect(event?.chatType).toBe("group");
    expect(event?.chatPhoneNumber).toBeNull();
    expect(event?.from).toBe("556784020665@s.whatsapp.net");
    expect(event?.fromPhoneNumber).toBe("556784020665");
    expect(event?.senderResolved).toBe(true);
  });

  it("ignores outbound messages", () => {
    const message = directMessage({ remoteJid: "88356755087579@lid" });
    message.key.fromMe = true;

    expect(normalizeIncomingMessage("pessoal", message, createAuthDir())).toBeNull();
  });
});

describe("lid directory extraction", () => {
  it("pairs the LID with the number in either direction", () => {
    expect(
      extractMessageLidPairs(
        directMessage({
          remoteJid: "88356755087579@lid",
          remoteJidAlt: "556784020665@s.whatsapp.net"
        })
      )
    ).toEqual([{ lid: "88356755087579@lid", pn: "556784020665@s.whatsapp.net" }]);

    expect(
      extractMessageLidPairs(
        directMessage({
          remoteJid: "556784020665@s.whatsapp.net",
          remoteJidAlt: "88356755087579@lid"
        })
      )
    ).toEqual([{ lid: "88356755087579@lid", pn: "556784020665@s.whatsapp.net" }]);
  });

  it("yields nothing when there is no counterpart to learn", () => {
    expect(extractMessageLidPairs(directMessage({ remoteJid: "88356755087579@lid" }))).toEqual([]);
    expect(extractContactLidPairs({ id: "556784020665@s.whatsapp.net" })).toEqual([]);
  });

  it("learns from contacts that carry both addresses", () => {
    expect(
      extractContactLidPairs({
        id: "556784020665@s.whatsapp.net",
        lid: "88356755087579@lid"
      })
    ).toEqual([{ lid: "88356755087579@lid", pn: "556784020665@s.whatsapp.net" }]);
  });
});
