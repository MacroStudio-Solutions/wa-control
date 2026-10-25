import { AppError } from "../shared/errors.ts";
import { parseEventList } from "../shared/events.ts";
import type { GroupParticipantAction } from "../shared/types.ts";
import { isMediaKind, listSupportedMediaKinds, type MediaKind } from "../media/mediaTypes.ts";

export type CliCommand =
  | { kind: "help" }
  | { kind: "daemon.start" }
  | { kind: "daemon.start.background"; json: boolean }
  | { kind: "daemon.stop"; json: boolean; waitMs?: number }
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
      filename?: string;
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
  | { kind: "typing"; sessionId: string; chat: string; recording: boolean; json: boolean }
  | { kind: "read"; sessionId: string; chat: string; messageId?: string; json: boolean }
  | {
      kind: "react";
      sessionId: string;
      chat: string;
      messageId: string;
      emoji: string;
      json: boolean;
    }
  | { kind: "delete"; sessionId: string; chat: string; messageId: string; json: boolean }
  | {
      kind: "poll";
      sessionId: string;
      chat: string;
      question: string;
      options: string[];
      json: boolean;
    }
  | {
      kind: "group.create";
      sessionId: string;
      subject: string;
      participants: string[];
      json: boolean;
    }
  | { kind: "group.info"; sessionId: string; groupJid: string; json: boolean }
  | {
      kind: "group.participants";
      sessionId: string;
      groupJid: string;
      action: GroupParticipantAction;
      participants: string[];
      json: boolean;
    }
  | { kind: "group.leave"; sessionId: string; groupJid: string; json: boolean }
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

/**
 * Passar string vazia como argumento posicional e contra-intuitivo na maioria
 * dos shells; `.` e o alias documentado para "sem emoji", que a Baileys
 * interpreta como remocao da reacao.
 */
function normalizeEmojiArg(raw: string): string {
  return raw === "." ? "" : raw;
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
      arg !== "--background" &&
      arg !== "--wait-ms" &&
      arg !== "--base64" &&
      arg !== "--ptt" &&
      arg !== "--recording" &&
      arg !== "--limit" &&
      arg !== "--timeout-ms" &&
      arg !== "--max-attempts" &&
      arg !== "--events" &&
      arg !== "--out" &&
      arg !== "--type" &&
      arg !== "--caption" &&
      arg !== "--filename" &&
      arg !== "--message-id" &&
      arg !== "--participants" &&
      source[index - 1] !== "--wait-ms" &&
      source[index - 1] !== "--limit" &&
      source[index - 1] !== "--timeout-ms" &&
      source[index - 1] !== "--max-attempts" &&
      source[index - 1] !== "--events" &&
      source[index - 1] !== "--out" &&
      source[index - 1] !== "--type" &&
      source[index - 1] !== "--caption" &&
      source[index - 1] !== "--filename" &&
      source[index - 1] !== "--message-id" &&
      source[index - 1] !== "--participants"
  );

  if (filtered[0] === "daemon" && filtered[1] === "start") {
    return argv.includes("--background")
      ? { kind: "daemon.start.background", json }
      : { kind: "daemon.start" };
  }

  if (filtered[0] === "daemon" && filtered[1] === "stop") {
    const waitMs = extractNumberFlag(argv, "--wait-ms");

    if (waitMs !== undefined && (!Number.isInteger(waitMs) || waitMs < 0)) {
      throw new AppError("INVALID_FLAG", 400, "Use `--wait-ms` com inteiro maior ou igual a zero.");
    }

    return { kind: "daemon.stop", json, ...(waitMs !== undefined ? { waitMs } : {}) };
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
    const filename = extractStringFlag(argv, "--filename");

    if (typeFlag !== undefined && !isMediaKind(typeFlag)) {
      throw new AppError(
        "INVALID_FLAG",
        400,
        `Valor invalido para --type: '${typeFlag}'. Tipos liberados: ${listSupportedMediaKinds().join(", ")}.`
      );
    }

    return {
      kind: "send-media",
      sessionId: filtered[1],
      to: filtered[2],
      file: filtered[3],
      ...(typeFlag !== undefined ? { type: typeFlag as MediaKind } : {}),
      ...(caption !== undefined ? { caption } : {}),
      ...(filename !== undefined ? { filename } : {}),
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

  if (filtered[0] === "typing" && filtered[1] && filtered[2]) {
    return {
      kind: "typing",
      sessionId: filtered[1],
      chat: filtered[2],
      recording: argv.includes("--recording"),
      json
    };
  }

  if (filtered[0] === "read" && filtered[1] && filtered[2]) {
    const messageId = extractStringFlag(argv, "--message-id");

    return {
      kind: "read",
      sessionId: filtered[1],
      chat: filtered[2],
      ...(messageId !== undefined ? { messageId } : {}),
      json
    };
  }

  if (filtered[0] === "react" && filtered[1] && filtered[2] && filtered[3]) {
    // O emoji e o que vier depois do messageId — string vazia (``) remove a
    // reacao, entao a checagem e por comprimento, nao por veracidade.
    if (filtered.length < 5) {
      throw new AppError(
        "INVALID_COMMAND",
        400,
        "Uso: wa react <sessao> <chat> <messageId> <emoji|.> — emoji vazio ou . remove a reacao."
      );
    }

    const emoji = normalizeEmojiArg(filtered.slice(4).join(" "));

    return {
      kind: "react",
      sessionId: filtered[1],
      chat: filtered[2],
      messageId: filtered[3],
      emoji,
      json
    };
  }

  if (filtered[0] === "delete" && filtered[1] && filtered[2] && filtered[3]) {
    return {
      kind: "delete",
      sessionId: filtered[1],
      chat: filtered[2],
      messageId: filtered[3],
      json
    };
  }

  if (filtered[0] === "poll" && filtered[1] && filtered[2] && filtered[3]) {
    const options = filtered.slice(4);
    // Validacao local ANTES de qualquer rede: enquete com menos de 2 opcoes
    // nunca chega a sair da maquina.
    if (options.length < 2) {
      throw new AppError(
        "INVALID_POLL_OPTIONS",
        400,
        `Enquete precisa de no minimo 2 opcoes (recebido: ${options.length}). Uso: wa poll <sessao> <chat> <pergunta> <opcao1> <opcao2> [...]`
      );
    }

    return {
      kind: "poll",
      sessionId: filtered[1],
      chat: filtered[2],
      question: filtered[3],
      options,
      json
    };
  }

  if (filtered[0] === "group") {
    const GROUP_USAGE =
      "Uso: wa group create <sessao> <assunto> [--participants a,b] | wa group info <sessao> <groupJid> | wa group add|remove|promote|demote <sessao> <groupJid> <numeros...> | wa group leave <sessao> <groupJid>";
    const sub = filtered[1];

    if (sub === "create" && filtered[2]) {
      const subject = filtered.slice(3).join(" ").trim();
      if (!subject) {
        throw new AppError("INVALID_COMMAND", 400, GROUP_USAGE);
      }

      // Numeros vem em lista separada por virgula, no padrao do --events.
      const participantsFlag = extractStringFlag(argv, "--participants");
      const participants = participantsFlag
        ? participantsFlag
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [];

      return {
        kind: "group.create",
        sessionId: filtered[2],
        subject,
        participants,
        json
      };
    }

    if (sub === "info" && filtered[2] && filtered[3]) {
      return {
        kind: "group.info",
        sessionId: filtered[2],
        groupJid: filtered[3],
        json
      };
    }

    const PARTICIPANT_ACTIONS: GroupParticipantAction[] = [
      "add",
      "remove",
      "promote",
      "demote"
    ];
    const action = PARTICIPANT_ACTIONS.find((candidate) => candidate === sub);

    if (action && filtered[2] && filtered[3]) {
      const participants = filtered.slice(4);
      if (participants.length === 0) {
        throw new AppError(
          "INVALID_COMMAND",
          400,
          `Uso: wa group ${action} <sessao> <groupJid> <numero1> [numero2] [...] — informe ao menos um numero ou JID.`
        );
      }

      return {
        kind: "group.participants",
        sessionId: filtered[2],
        groupJid: filtered[3],
        action,
        participants,
        json
      };
    }

    if (sub === "leave" && filtered[2] && filtered[3]) {
      return {
        kind: "group.leave",
        sessionId: filtered[2],
        groupJid: filtered[3],
        json
      };
    }

    throw new AppError("INVALID_COMMAND", 400, GROUP_USAGE);
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
