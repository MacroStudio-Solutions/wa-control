import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addTransactionCapability,
  DEFAULT_CONNECTION_CONFIG,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import pino from "pino";
import { resolveLidJid, resolvePhoneJid } from "../shared/jids.ts";
import { extractMessageLidPairs, rememberLidPairs } from "./lidDirectory.ts";
import { normalizeIncomingMessage } from "./normalizeMessage.ts";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import type { Logger } from "../shared/logger.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
} as unknown as Logger;

/**
 * Monta o repositorio de sinal do jeito que o socket real monta, para que o teste
 * exercite o formato de gravacao do Baileys — e nao uma imitacao dele.
 */
async function createSocketLike(): Promise<{ sock: WASocket; authDir: string }> {
  const authDir = mkdtempSync(join(tmpdir(), "wa-control-lid-"));
  tempDirs.push(authDir);

  const { state } = await useMultiFileAuthState(authDir);
  const logger = pino({ level: "silent" });
  const keys = addTransactionCapability(state.keys, logger, {
    maxCommitRetries: 10,
    delayBetweenTriesMs: 10
  });
  const signalRepository = DEFAULT_CONNECTION_CONFIG.makeSignalRepository(
    { creds: state.creds, keys },
    logger
  );

  return { sock: { signalRepository } as unknown as WASocket, authDir };
}

describe("lid directory persistence", () => {
  it("stores the pairing where JID resolution reads it back", async () => {
    const { sock, authDir } = await createSocketLike();

    await rememberLidPairs(
      sock,
      [{ lid: "88356755087579@lid", pn: "556784020665@s.whatsapp.net" }],
      silentLogger
    );

    expect(resolvePhoneJid(authDir, "88356755087579@lid")).toBe("556784020665@s.whatsapp.net");
    expect(resolveLidJid(authDir, "556784020665@s.whatsapp.net")).toBe("88356755087579@lid");
  });

  it("keeps resolving the contact after the envelope stops carrying the number", async () => {
    const { sock, authDir } = await createSocketLike();

    const first = {
      key: {
        remoteJid: "88356755087579@lid",
        remoteJidAlt: "556784020665@s.whatsapp.net",
        fromMe: false,
        id: "msg-1"
      },
      messageTimestamp: 1783506977,
      message: { conversation: "Bom dia" }
    } as unknown as WAMessage;

    await rememberLidPairs(sock, extractMessageLidPairs(first), silentLogger);

    const later = {
      key: { remoteJid: "88356755087579@lid", fromMe: false, id: "msg-2" },
      messageTimestamp: 1783506999,
      message: { conversation: "Tudo certo?" }
    } as unknown as WAMessage;

    const event = normalizeIncomingMessage("pessoal", later, authDir);

    expect(event?.fromPhoneNumber).toBe("556784020665");
    expect(event?.senderResolved).toBe(true);
  });

  it("survives a repository that rejects, without dropping the message", async () => {
    const failing = {
      signalRepository: {
        lidMapping: {
          storeLIDPNMappings: () => Promise.reject(new Error("disco cheio"))
        }
      }
    } as unknown as WASocket;

    await expect(
      rememberLidPairs(
        failing,
        [{ lid: "88356755087579@lid", pn: "556784020665@s.whatsapp.net" }],
        silentLogger
      )
    ).resolves.toBeUndefined();
  });
});
