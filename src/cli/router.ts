import { AppError } from "../shared/errors.ts";
import { parseEventList } from "../shared/events.ts";
import { isMediaKind, type MediaKind } from "../media/mediaTypes.ts";

export type CliCommand =
  | { kind: "help" }
  | { kind: "daemon.start" }
  | { kind: "status"; json: boolean }
  | { kind: "sessions"; json: boolean }
  | { kind: "chats"; sessionId: string; limit: number; json: boolean }
  | { kind: "contacts"; sessionId: string; limit: number; json: boolean }
  | { kind: "messages"; sessionId: string; chat: string; limit: number; json: boolean }
  | { kind: "connect"; sessionId: string; json: boolean }
  | { kind: "qr"; sessionId: string; json: boolean; base64: boolean }
  | { kind: "disconnect"; sessionId: string }
  | { kind: "session.remove"; sessionId: string; yes: boolean }
  | { kind: "send"; sessionId: string; to: string; text: string }
  | {
      kind: "send-media";
      sessionId: string;
      to: string;
      file: string;
      type?: MediaKind;
      caption?: string;
      ptt: boolean;
      json: boolean;
    }
  | {
      kind: "download-media";
      sessionId: string;
      chat: string;
      messageId: string;
      out?: string;
      json: boolean;
    }
  | { kind: "listen"; sessionId: string | null; all: boolean; raw: boolean }
  | {
      kind: "webhook.add";
      sessionId: string;
      url: string;
      timeoutMs?: number;
      maxAttempts?: number;
      events?: string[];
    }
  | { kind: "webhook.list"; sessionId?: string; json: boolean }
  | { kind: "webhook.remove"; id: string; sessionId?: string }
  | { kind: "webhook.set-events"; id: string; events: string[] }
  | { kind: "webhook.toggle-event"; id: string; event: string; enabled: boolean }
  | { kind: "webhook.set-enabled"; id: string; enabled: boolean }
  | { kind: "webhook.deliveries"; sessionId?: string; json: boolean }
  | { kind: "events"; json: boolean };

function extractNumberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = Number(args[index + 1]);
  if (!Number.isFinite(value)) {
    throw new AppError("INVALID_FLAG", 400, `Valor invalido para ${flag}.`);
  }

  return value;
}

function extractStringFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new AppError("INVALID_FLAG", 400, `Valor invalido para ${flag}.`);
  }

  return value;
}

export function parseCliCommand(argv: string[]): CliCommand {
  if (
    argv.length === 0 ||
    argv[0] === "help" ||
    argv[0] === "--help" ||
    argv.includes("--help")
  ) {
    return { kind: "help" };
  }

  const json = argv.includes("--json");
  const raw = argv.includes("--raw");
  const filtered = argv.filter(
    (arg, index, source) =>
      arg !== "--json" &&
      arg !== "--raw" &&
      arg !== "--yes" &&
      arg !== "--base64" &&
      arg !== "--ptt" &&
      arg !== "--limit" &&
      arg !== "--timeout-ms" &&
      arg !== "--max-attempts" &&
      arg !== "--events" &&
      arg !== "--out" &&
      arg !== "--type" &&
      arg !== "--caption" &&
      source[index - 1] !== "--limit" &&
      source[index - 1] !== "--timeout-ms" &&
      source[index - 1] !== "--max-attempts" &&
      source[index - 1] !== "--events" &&
      source[index - 1] !== "--out" &&
      source[index - 1] !== "--type" &&
      source[index - 1] !== "--caption"
  );

  if (filtered[0] === "daemon" && filtered[1] === "start") {
    return { kind: "daemon.start" };
  }

  if (filtered[0] === "status") {
    return { kind: "status", json };
  }

  if (filtered[0] === "sessions") {
    return { kind: "sessions", json };
  }

  if (filtered[0] === "events") {
    return { kind: "events", json };
  }

  if (filtered[0] === "chats" && filtered[1]) {
    return {
      kind: "chats",
      sessionId: filtered[1],
      limit: extractNumberFlag(argv, "--limit") ?? 50,
      json
    };
  }

  if (filtered[0] === "contacts" && filtered[1]) {
    return {
      kind: "contacts",
      sessionId: filtered[1],
      limit: extractNumberFlag(argv, "--limit") ?? 100,
      json
    };
  }

  if (filtered[0] === "messages" && filtered[1] && filtered[2]) {
    return {
      kind: "messages",
      sessionId: filtered[1],
      chat: filtered[2],
      limit: extractNumberFlag(argv, "--limit") ?? 50,
      json
    };
  }

  if (filtered[0] === "connect" && filtered[1]) {
    return { kind: "connect", sessionId: filtered[1], json };
  }

  if (filtered[0] === "qr" && filtered[1]) {
    return {
      kind: "qr",
      sessionId: filtered[1],
      json,
      base64: argv.includes("--base64")
    };
  }

  if (filtered[0] === "disconnect" && filtered[1]) {
    return { kind: "disconnect", sessionId: filtered[1] };
  }

  if (filtered[0] === "session" && filtered[1] === "remove" && filtered[2]) {
    return {
      kind: "session.remove",
      sessionId: filtered[2],
      yes: argv.includes("--yes")
    };
  }

  if (filtered[0] === "send" && filtered[1] && filtered[2] && filtered[3]) {
    return {
      kind: "send",
      sessionId: filtered[1],
      to: filtered[2],
      text: filtered.slice(3).join(" ")
    };
  }

  if (filtered[0] === "send-media" && filtered[1] && filtered[2] && filtered[3]) {
    const typeFlag = extractStringFlag(argv, "--type");
    const caption = extractStringFlag(argv, "--caption");

    if (typeFlag !== undefined && !isMediaKind(typeFlag)) {
      throw new AppError(
        "INVALID_FLAG",
        400,
        `Valor invalido para --type: '${typeFlag}'. Use image ou audio.`
      );
    }

    return {
      kind: "send-media",
      sessionId: filtered[1],
      to: filtered[2],
      file: filtered[3],
      ...(typeFlag !== undefined ? { type: typeFlag as MediaKind } : {}),
      ...(caption !== undefined ? { caption } : {}),
      ptt: argv.includes("--ptt"),
      json
    };
  }

  if (filtered[0] === "download-media" && filtered[1] && filtered[2] && filtered[3]) {
    const out = extractStringFlag(argv, "--out");

    return {
      kind: "download-media",
      sessionId: filtered[1],
      chat: filtered[2],
      messageId: filtered[3],
      ...(out !== undefined ? { out } : {}),
      json
    };
  }

  if (filtered[0] === "listen") {
    if (filtered.includes("--all")) {
      return {
        kind: "listen",
        sessionId: null,
        all: true,
        raw
      };
    }

    if (filtered[1]) {
      return {
        kind: "listen",
        sessionId: filtered[1],
        all: false,
        raw
      };
    }
  }

  if (filtered[0] === "webhook" && filtered[1] === "add" && filtered[2] && filtered[3]) {
    const timeoutMs = extractNumberFlag(argv, "--timeout-ms");
    const maxAttempts = extractNumberFlag(argv, "--max-attempts");
    const events = extractStringFlag(argv, "--events");

    return {
      kind: "webhook.add",
      sessionId: filtered[2],
      url: filtered[3],
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      ...(events !== undefined ? { events: parseEventList(events) } : {})
    };
  }

  if (filtered[0] === "webhook" && filtered[1] === "list") {
    const sessionId = filtered[2];

    return {
      kind: "webhook.list",
      json,
      ...(sessionId ? { sessionId } : {})
    };
  }

  if (filtered[0] === "webhook" && filtered[1] === "set-events" && filtered[2] && filtered[3]) {
    return {
      kind: "webhook.set-events",
      id: filtered[2],
      events: parseEventList(filtered.slice(3).join(","))
    };
  }

  if (
    filtered[0] === "webhook" &&
    (filtered[1] === "enable-event" || filtered[1] === "disable-event") &&
    filtered[2] &&
    filtered[3]
  ) {
    return {
      kind: "webhook.toggle-event",
      id: filtered[2],
      event: filtered[3],
      enabled: filtered[1] === "enable-event"
    };
  }

  if (
    filtered[0] === "webhook" &&
    (filtered[1] === "enable" || filtered[1] === "disable") &&
    filtered[2]
  ) {
    return {
      kind: "webhook.set-enabled",
      id: filtered[2],
      enabled: filtered[1] === "enable"
    };
  }

  if (filtered[0] === "webhook" && filtered[1] === "remove" && filtered[2]) {
    if (filtered[3]) {
      return {
        kind: "webhook.remove",
        sessionId: filtered[2],
        id: filtered[3]
      };
    }

    return {
      kind: "webhook.remove",
      id: filtered[2]
    };
  }

  if (filtered[0] === "webhook" && filtered[1] === "deliveries") {
    const sessionId = filtered[2];

    return {
      kind: "webhook.deliveries",
      json,
      ...(sessionId ? { sessionId } : {})
    };
  }

  throw new AppError("INVALID_COMMAND", 400, "Comando invalido. Use `wa help`.");
}
