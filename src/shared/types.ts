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
}

export interface CreateWebhookRequest {
  sessionId: string;
  url: string;
  timeoutMs?: number;
  maxAttempts?: number;
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
  status: string | null;
  unixSeconds: number | null;
  timestamp: string;
  updatedAt: string;
}
