import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatType } from "./types.ts";

const PHONE_JID_SUFFIX = "@s.whatsapp.net";
const LID_JID_SUFFIX = "@lid";
const GROUP_JID_SUFFIX = "@g.us";
const BROADCAST_JID_SUFFIX = "@broadcast";
const STATUS_JID = "status@broadcast";

export interface ProjectedAddress {
  jid: string | null;
  lookupJid: string | null;
  lookupKey: string | null;
  phoneNumber: string | null;
  aliases: string[];
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

export function normalizeDigits(value: string): string {
  return value.replace(/\D/g, "");
}

export function normalizeJidQuery(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  if (normalized.includes("@")) {
    return stripDevice(normalized);
  }

  const digits = normalizeDigits(normalized);
  return digits ? `${digits}${PHONE_JID_SUFFIX}` : normalized;
}

/**
 * O WhatsApp anexa o dispositivo ao usuario do JID (`5511999:12@s.whatsapp.net`).
 * Para identidade de contato o dispositivo e ruido: ele quebra a leitura do
 * mapeamento LID<->numero e vaza para dentro do numero projetado.
 */
function stripDevice(jid: string): string {
  const separator = jid.indexOf("@");
  if (separator < 0) {
    return jid;
  }

  const user = jid.slice(0, separator);
  const domain = jid.slice(separator);
  const device = user.indexOf(":");

  return device < 0 ? jid : `${user.slice(0, device)}${domain}`;
}

export function isPhoneJid(jid: string): boolean {
  return jid.endsWith(PHONE_JID_SUFFIX);
}

export function isLidJid(jid: string): boolean {
  return jid.endsWith(LID_JID_SUFFIX);
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith(GROUP_JID_SUFFIX);
}

export function isBroadcastJid(jid: string): boolean {
  return jid.endsWith(BROADCAST_JID_SUFFIX);
}

export function classifyChatJid(jid: string): ChatType {
  if (jid === STATUS_JID) {
    return "status";
  }

  if (isGroupJid(jid)) {
    return "group";
  }

  if (isPhoneJid(jid) || isLidJid(jid)) {
    return "direct";
  }

  if (isBroadcastJid(jid)) {
    return "broadcast";
  }

  return "unknown";
}

export function phoneNumberFromJid(jid: string): string | null {
  if (!isPhoneJid(jid)) {
    return null;
  }

  const [user] = jid.split("@");
  return user || null;
}

function readMapping(authDir: string, fileName: string): string | null {
  const filePath = join(authDir, fileName);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return normalizeText(parsed) || null;
  } catch {
    return null;
  }
}

export function resolvePhoneJid(authDir: string, jid: string): string | null {
  const normalized = normalizeText(jid);
  if (!normalized) {
    return null;
  }

  if (isPhoneJid(normalized)) {
    return normalized;
  }

  if (!isLidJid(normalized)) {
    return null;
  }

  const [user] = normalized.split("@");
  if (!user) {
    return null;
  }

  const mapped = readMapping(authDir, `lid-mapping-${user}_reverse.json`);
  return mapped ? `${mapped}${PHONE_JID_SUFFIX}` : null;
}

export function resolveLidJid(authDir: string, jid: string): string | null {
  const normalized = normalizeText(jid);
  if (!normalized) {
    return null;
  }

  if (isLidJid(normalized)) {
    return normalized;
  }

  if (!isPhoneJid(normalized)) {
    return null;
  }

  const digits = phoneNumberFromJid(normalized);
  if (!digits) {
    return null;
  }

  const mapped = readMapping(authDir, `lid-mapping-${digits}.json`);
  return mapped ? `${mapped}${LID_JID_SUFFIX}` : null;
}

export function expandJidAliases(authDir: string, ...candidates: Array<string | null | undefined>): string[] {
  const normalizedCandidates = candidates
    .map((candidate) => normalizeJidQuery(candidate ?? ""))
    .filter(Boolean);

  const aliases = new Set<string>();
  for (const candidate of normalizedCandidates) {
    aliases.add(candidate);

    const phoneJid = resolvePhoneJid(authDir, candidate);
    if (phoneJid) {
      aliases.add(phoneJid);
    }

    const lidJid = resolveLidJid(authDir, candidate);
    if (lidJid) {
      aliases.add(lidJid);
    }
  }

  return Array.from(aliases);
}

function chooseLookupJid(authDir: string, aliases: string[]): string | null {
  for (const alias of aliases) {
    if (isPhoneJid(alias)) {
      return alias;
    }
  }

  for (const alias of aliases) {
    const resolved = resolvePhoneJid(authDir, alias);
    if (resolved) {
      return resolved;
    }
  }

  return aliases[0] ?? null;
}

export function projectAddress(
  authDir: string,
  preferred: string | null | undefined,
  alternatives: Array<string | null | undefined> = []
): ProjectedAddress {
  const baseJid = normalizeJidQuery(preferred ?? "");
  const aliases = expandJidAliases(authDir, preferred, ...alternatives);
  const lookupJid = chooseLookupJid(authDir, aliases);
  const phoneNumber = lookupJid && isPhoneJid(lookupJid) ? phoneNumberFromJid(lookupJid) : null;
  const lookupKey = phoneNumber ?? lookupJid ?? null;

  return {
    jid: baseJid || aliases[0] || null,
    lookupJid,
    lookupKey,
    phoneNumber,
    aliases
  };
}

/**
 * Identidade de um interlocutor, do jeito que um consumidor externo precisa dela:
 * o numero quando ele e conhecido, o identificador opaco sempre, e um sinal
 * explicito de resolucao — nunca um campo vazio.
 */
export interface ResolvedIdentity {
  jid: string | null;
  phoneJid: string | null;
  phoneNumber: string | null;
  lid: string | null;
  resolved: boolean;
}

export function resolveIdentity(
  authDir: string,
  preferred: string | null | undefined,
  alternate?: string | null
): ResolvedIdentity {
  const address = projectAddress(authDir, preferred, alternate ? [alternate] : []);
  const phoneJid = address.lookupJid && isPhoneJid(address.lookupJid) ? address.lookupJid : null;
  const lid = address.aliases.find((alias) => isLidJid(alias)) ?? null;

  return {
    jid: phoneJid ?? lid ?? address.jid,
    phoneJid,
    phoneNumber: address.phoneNumber,
    lid,
    resolved: Boolean(address.phoneNumber)
  };
}

export function buildQueryCandidates(authDir: string, input: string): {
  exactJids: string[];
  lookupKeys: string[];
} {
  const normalized = normalizeJidQuery(input);
  if (!normalized) {
    return {
      exactJids: [],
      lookupKeys: []
    };
  }

  const exactJids = unique([normalized, ...expandJidAliases(authDir, normalized)]);
  const lookupKeys = unique(
    exactJids.map((jid) => {
      if (isPhoneJid(jid)) {
        return phoneNumberFromJid(jid);
      }

      return resolvePhoneJid(authDir, jid) ? phoneNumberFromJid(resolvePhoneJid(authDir, jid)!) : jid;
    })
  );

  return {
    exactJids,
    lookupKeys
  };
}
