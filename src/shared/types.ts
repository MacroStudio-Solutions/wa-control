import type { MediaKind } from "../media/mediaTypes.ts";

export const SESSION_STATUSES = [
  "disconnected",
  "connecting",
  "awaiting_qr",
  "connected",
  "reconnecting",
  "error"
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface SessionRecord {
  id: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  phoneNumber: string | null;
  lastError: string | null;
  active: boolean;
  lastConnectedAt: string | null;
  reconnectAttempts: number;
  qr: string | null;
}

export interface AppPaths {
  rootDir: string;
  configPath: string;
  databasePath: string;
  runtimePath: string;
  sessionsDir: string;
  tokenPath: string;
}

export interface AppConfig {
  host: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  paths: AppPaths;
}

export interface DaemonRuntimeInfo {
  pid: number;
  startedAt: string;
  host: string;
  port: number;
  version: string;
}

export interface HealthResponse {
  ok: true;
  daemon: DaemonRuntimeInfo;
}

export interface StatusResponse {
  daemon: DaemonRuntimeInfo;
  sessions: SessionRecord[];
  eventCount: number;
  webhookCount: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface SendMessageRequest {
  to: string;
  text: string;
}

export interface SendMessageResponse {
  ok: true;
  sessionId: string;
  to: string;
  jid: string;
  text: string;
  messageId: string | null;
  timestamp: number;
}

export interface SendMediaRequest {
  to: string;
  kind: MediaKind;
  mimeType: string;
  caption?: string;
  fileName?: string;
  ptt?: boolean;
}

export interface SendMediaResponse {
  ok: true;
  sessionId: string;
  to: string;
  jid: string;
  kind: MediaKind;
  mimeType: string;
  caption: string | null;
  fileName: string | null;
  ptt: boolean;
  size: number;
  messageId: string | null;
  timestamp: number;
}

export interface DownloadMediaResponse {
  kind: string;
  mimeType: string;
  size: number;
  fileName: string | null;
  chatJid: string;
  messageId: string;
  buffer: Uint8Array;
}

export interface TypingRequest {
  chat: string;
  recording?: boolean;
}

export interface TypingResponse {
  ok: true;
  sessionId: string;
  chat: string;
  jid: string;
  recording: boolean;
  /** Aviso explicito (ex.: chat sem conversa projetada localmente). */
  note?: string;
}

export interface ReadRequest {
  chat: string;
  messageId?: string;
}

export interface ReadResponse {
  ok: true;
  sessionId: string;
  chat: string;
  jid: string;
  messageIds: string[];
}

export interface ReactRequest {
  chat: string;
  messageId: string;
  /** Emoji da reacao; string vazia remove a reacao. */
  emoji: string;
}

export interface ReactResponse {
  ok: true;
  sessionId: string;
  chat: string;
  jid: string;
  messageId: string;
  emoji: string;
  /** true quando o emoji vazio removeu a reacao. */
  removed: boolean;
}

export interface DeleteMessageRequest {
  chat: string;
  messageId: string;
}

export interface DeleteMessageResponse {
  ok: true;
  sessionId: string;
  chat: string;
  jid: string;
  messageId: string;
  /** true quando a mensagem apagada foi propria (revoke para todos). */
  fromMe: boolean;
}

export interface PollRequest {
  chat: string;
  question: string;
  options: string[];
}

export interface PollResponse {
  ok: true;
  sessionId: string;
  chat: string;
  jid: string;
  question: string;
  options: string[];
  messageId: string | null;
  timestamp: number;
}

export type GroupParticipantAction = "add" | "remove" | "promote" | "demote";

export interface GroupCreateRequest {
  subject: string;
  participants?: string[];
}

export interface GroupParticipantSummary {
  jid: string;
  lid?: string;
  name: string | null;
  /** true para admin e superadmin. */
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface GroupInfoResponse {
  ok: true;
  sessionId: string;
  jid: string;
  subject: string;
  owner: string | null;
  description: string | null;
  /** Unix timestamp da criacao do grupo, quando o WhatsApp informa. */
  creation: number | null;
  size: number;
  participants: GroupParticipantSummary[];
}

export type GroupCreateResponse = GroupInfoResponse;

export interface GroupParticipantsRequest {
  groupJid: string;
  action: GroupParticipantAction;
  participants: string[];
}

export interface GroupParticipantsResponse {
  ok: true;
  sessionId: string;
  jid: string;
  action: GroupParticipantAction;
  /** JIDs efetivamente atualizados (status 200 do WhatsApp). */
  updated: string[];
}

export interface GroupLeaveResponse {
  ok: true;
  sessionId: string;
  jid: string;
}

export interface NormalizedEvent {
  id: string;
  event: string;
  sessionId: string | null;
  timestamp: number;
  raw?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SessionCommandResponse {
  ok: true;
  session: SessionRecord;
  note?: string;
  qr?: string;
  qrTerminal?: string;
}

export interface SessionQrResponse {
  sessionId: string;
  status: SessionStatus;
  /** Payload cru do QR, o mesmo que o WhatsApp emite. */
  qr: string;
  /** Desenho em blocos, para terminal. */
  ascii: string;
  /** PNG em base64, sem o prefixo de data URL. */
  base64: string;
  /** PNG pronto para o atributo src de uma imagem. */
  dataUrl: string;
}

export interface WebhookRecord {
  id: string;
  sessionId: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  timeoutMs: number;
  maxAttempts: number;
  lastStatus: string | null;
  lastError: string | null;
  /** Eventos assinados. Vazio significa todos. */
  events: string[];
  /** Rotulo curto da assinatura, pronto para exibicao. */
  eventsLabel: string;
  /** Assinatura por evento, endereçavel por chave sem ponto. */
  eventFlags: Record<string, boolean>;
}

export interface CreateWebhookRequest {
  sessionId: string;
  url: string;
  timeoutMs?: number;
  maxAttempts?: number;
  events?: string[];
}

export interface UpdateWebhookRequest {
  events?: string[];
  enabled?: boolean;
}

export interface WebhookDeliveryRecord {
  id: string;
  webhookId: string;
  sessionId: string | null;
  eventId: string;
  eventName: string;
  attempt: number;
  status: "delivered" | "failed";
  httpStatus: number | null;
  error: string | null;
  createdAt: string;
  responseBody: string | null;
}

export type ChatType = "direct" | "group" | "broadcast" | "status" | "unknown";

export interface ChatRecord {
  sessionId: string;
  id: string;
  lookupKey: string | null;
  lookupJid: string | null;
  phoneNumber: string | null;
  name: string | null;
  type: ChatType;
  conversationTimestamp: number | null;
  lastMessageRecvTimestamp: number | null;
  unreadCount: number;
  lastMessageId: string | null;
  lastMessageType: string | null;
  lastMessageText: string | null;
  lastMessageTimestamp: string | null;
  updatedAt: string;
}

export interface ContactRecord {
  sessionId: string;
  id: string;
  lookupKey: string | null;
  lookupJid: string | null;
  phoneNumber: string | null;
  lid: string | null;
  name: string | null;
  notify: string | null;
  verifiedName: string | null;
  updatedAt: string;
}

export interface MessageRecord {
  sessionId: string;
  chatJid: string;
  chatLookupKey: string | null;
  chatLookupJid: string | null;
  chatPhoneNumber: string | null;
  id: string;
  participantJid: string;
  participantLookupKey: string | null;
  participantLookupJid: string | null;
  participantPhoneNumber: string | null;
  senderJid: string;
  senderLookupKey: string | null;
  senderLookupJid: string | null;
  senderPhoneNumber: string | null;
  pushName: string | null;
  fromMe: boolean;
  upsertType: string;
  messageType: string;
  text: string | null;
  rawMessageType: string | null;
  status: string | null;
  unixSeconds: number | null;
  timestamp: string;
  updatedAt: string;
}
