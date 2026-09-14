import type { GroupMetadata, GroupParticipant, ParticipantAction } from "@whiskeysockets/baileys";
import { AppError } from "../shared/errors.ts";
import type {
  GroupInfoResponse,
  GroupParticipantAction,
  GroupParticipantSummary
} from "../shared/types.ts";

export type GroupOp =
  | "create"
  | "info"
  | "add"
  | "remove"
  | "promote"
  | "demote"
  | "leave";

const GROUP_OP_ERROR_CODES: Record<GroupOp, string> = {
  create: "GROUP_CREATE_FAILED",
  info: "GROUP_INFO_FAILED",
  add: "GROUP_ADD_FAILED",
  remove: "GROUP_REMOVE_FAILED",
  promote: "GROUP_PROMOTE_FAILED",
  demote: "GROUP_DEMOTE_FAILED",
  leave: "GROUP_LEAVE_FAILED"
};

const GROUP_OP_LABELS: Record<GroupOp, string> = {
  create: "criar grupo",
  info: "ler metadados do grupo",
  add: "adicionar participante",
  remove: "remover participante",
  promote: "promover a admin",
  demote: "rebaixar a membro",
  leave: "sair do grupo"
};

const PARTICIPANT_ACTIONS: GroupParticipantAction[] = [
  "add",
  "remove",
  "promote",
  "demote"
];

export function isGroupParticipantAction(value: unknown): value is GroupParticipantAction {
  return (
    typeof value === "string" && PARTICIPANT_ACTIONS.includes(value as GroupParticipantAction)
  );
}

export function toBaileysParticipantAction(action: GroupParticipantAction): ParticipantAction {
  return action;
}

export function assertGroupSubject(subject: string): void {
  if (!subject || !subject.trim()) {
    throw new AppError("INVALID_GROUP_SUBJECT", 400, "Informe o assunto do grupo.");
  }
}

/**
 * Participantes aceitos: numero com DDI+DDD (a pontuacao e ignorada) ou um JID
 * completo ja resolvido. A normalizacao e local e acontece ANTES de qualquer
 * contato com a rede — entrada malformada nunca chega ao socket.
 */
export function normalizeParticipantInputs(inputs: string[]): string[] {
  if (inputs.length === 0) {
    throw new AppError(
      "INVALID_PARTICIPANT",
      400,
      "Informe ao menos um participante (numero com DDI+DDD ou JID completo)."
    );
  }

  return inputs.map((raw) => {
    const trimmed = raw.trim();

    if (!trimmed) {
      throw new AppError(
        "INVALID_PARTICIPANT",
        400,
        `Participante invalido: '${raw}'. Use numero com DDI+DDD (ex.: 556784020665) ou um JID completo.`
      );
    }

    if (trimmed.includes("@")) {
      return trimmed;
    }

    const digits = trimmed.replace(/\D/g, "");
    if (digits.length < 8) {
      throw new AppError(
        "INVALID_PARTICIPANT",
        400,
        `Participante invalido: '${raw}'. Use numero com DDI+DDD (ex.: 556784020665) ou um JID completo.`
      );
    }

    return `${digits}@s.whatsapp.net`;
  });
}

/**
 * O JID de grupo nao tem forma recuperavel a partir de um nome curto: sem "@"
 * nao ha como consultar metadados, e o erro local aponta o caminho (`wa chats`).
 */
export function assertGroupJid(groupJid: string): void {
  if (!groupJid || !groupJid.includes("@")) {
    throw new AppError(
      "GROUP_JID_INVALID",
      400,
      `JID de grupo invalido: '${groupJid}'. Grupos terminam em @g.us — ache o JID com 'wa chats <sessao>'.`
    );
  }
}

function extractStatusCode(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error &&
    "output" in error &&
    typeof error.output === "object" &&
    error.output &&
    "statusCode" in error.output &&
    typeof error.output.statusCode === "number"
  ) {
    return error.output.statusCode;
  }

  return null;
}

function extractPayloadMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error &&
    "output" in error &&
    typeof error.output === "object" &&
    error.output &&
    "payload" in error.output &&
    typeof error.output.payload === "object" &&
    error.output.payload &&
    "message" in error.output.payload &&
    typeof error.output.payload.message === "string"
  ) {
    return error.output.payload.message;
  }

  return "";
}

/**
 * Mapeamento honesto de falha da Baileys por operacao: as classes conhecidas
 * do protocolo (item-not-found, forbidden) ganham classe e mensagem acionavel
 * proprias; o resto cai na classe da operacao com a causa original no texto.
 * Recusa do WhatsApp NUNCA vira sucesso.
 */
export function mapGroupOpError(
  op: GroupOp,
  error: unknown,
  details: Record<string, unknown> = {}
): AppError {
  const cause = error instanceof Error ? error.message : "Erro desconhecido na Baileys";
  const waStatusCode = extractStatusCode(error);
  const payloadMessage = extractPayloadMessage(error);
  const haystack = `${cause} ${payloadMessage}`.toLowerCase();
  const context = {
    op,
    ...details,
    ...(waStatusCode !== null ? { waStatusCode } : {})
  };

  if (waStatusCode === 404 || haystack.includes("item-not-found")) {
    const groupJid = typeof details.groupJid === "string" ? details.groupJid : "";
    return new AppError(
      "GROUP_NOT_FOUND",
      404,
      `Grupo nao encontrado${groupJid ? ` ('${groupJid}')` : ""}. Confira o JID — grupos terminam em @g.us; use 'wa chats <sessao>' para achar o JID certo.`,
      context
    );
  }

  if (waStatusCode === 403 || haystack.includes("forbidden") || haystack.includes("not-authorized")) {
    const hint =
      op === "info"
        ? "o bot precisa participar do grupo para ler os metadados"
        : "o bot precisa ser admin do grupo para esta operacao";
    return new AppError(
      "GROUP_NOT_ALLOWED",
      403,
      `Sem permissao para ${GROUP_OP_LABELS[op]}: ${hint}.`,
      context
    );
  }

  return new AppError(
    GROUP_OP_ERROR_CODES[op],
    502,
    `Falha ao ${GROUP_OP_LABELS[op]}: ${cause}`,
    context
  );
}

/**
 * Status por participante que o WhatsApp devolve no groupParticipantsUpdate.
 * As mensagens sao acionaveis: dizem o que fazer, nao apenas o codigo.
 */
export function explainParticipantStatus(
  action: GroupParticipantAction,
  status: string
): string {
  if (action === "add" && status === "409") {
    return "ja participa do grupo (conflito)";
  }

  if (action === "add" && status === "408") {
    return "saiu ou foi removido ha pouco; o WhatsApp exige um novo convite para re-adicionar";
  }

  if (status === "403") {
    return action === "add"
      ? "o WhatsApp recusou (403): a privacidade do numero nao permite adicionar por contato; convide pelo link do grupo"
      : "o WhatsApp recusou (403): sem permissao para esta operacao (o bot precisa ser admin)";
  }

  if (status === "409") {
    return "conflito com o estado atual do participante; confira com 'wa group info'";
  }

  if (status === "500") {
    return "o servidor do WhatsApp falhou ao aplicar; tente novamente";
  }

  return `o WhatsApp respondeu status ${status}`;
}

export interface ParticipantUpdateFailure {
  jid: string | null;
  status: string;
  reason: string;
}

export interface ParticipantUpdateSummary {
  updated: string[];
  failures: ParticipantUpdateFailure[];
}

export function summarizeParticipantUpdate(
  action: GroupParticipantAction,
  results: Array<{ status: string; jid: string | undefined }>
): ParticipantUpdateSummary {
  const updated: string[] = [];
  const failures: ParticipantUpdateFailure[] = [];

  for (const result of results) {
    if (result.status === "200") {
      if (result.jid) {
        updated.push(result.jid);
      }
      continue;
    }

    failures.push({
      jid: result.jid ?? null,
      status: result.status,
      reason: explainParticipantStatus(action, result.status)
    });
  }

  return { updated, failures };
}

export function participantRejectionMessage(
  action: GroupParticipantAction,
  failures: ParticipantUpdateFailure[]
): string {
  const label = GROUP_OP_LABELS[action];
  const listing = failures
    .map((failure) => `${failure.jid ?? "(jid nao informado)"} — ${failure.reason}`)
    .join("; ");

  return `${label}: ${failures.length} participante(s) recusado(s) pelo WhatsApp — ${listing}.`;
}

function toParticipantSummary(participant: GroupParticipant): GroupParticipantSummary {
  return {
    jid: participant.id,
    ...(participant.lid ? { lid: participant.lid } : {}),
    name: participant.notify ?? participant.name ?? participant.verifiedName ?? null,
    isAdmin:
      participant.admin === "admin" ||
      participant.admin === "superadmin" ||
      participant.isAdmin === true,
    isSuperAdmin: participant.admin === "superadmin" || participant.isSuperAdmin === true
  };
}

/**
 * A forma plana e estavel da CLI: o GroupMetadata cru da Baileys fica do lado
 * do daemon; o cliente ve um contrato proprio, sem tipos da lib vazando.
 */
export function serializeGroupSnapshot(
  sessionId: string,
  metadata: GroupMetadata
): GroupInfoResponse {
  const participants = Array.isArray(metadata.participants)
    ? metadata.participants.map(toParticipantSummary)
    : [];

  return {
    ok: true,
    sessionId,
    jid: metadata.id,
    subject: metadata.subject,
    owner: metadata.owner ?? null,
    description: metadata.desc ?? null,
    creation: metadata.creation ?? null,
    size: participants.length,
    participants
  };
}
