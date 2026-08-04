import type {
  ChatRecord,
  ContactRecord,
  MessageRecord,
  SessionRecord,
  StatusResponse,
  WebhookDeliveryRecord,
  WebhookRecord
} from "../shared/types.ts";
import type { OfflineStatusSnapshot } from "./localStatus.ts";

export function renderHelp(): string {
  return `
wa-control

Uso:
  wa daemon start
  wa status [--json]
  wa sessions [--json]
  wa chats <sessionId> [--limit 50] [--json]
  wa contacts <sessionId> [--limit 100] [--json]
  wa messages <sessionId> <chat|jid|numero> [--limit 50] [--json]
  wa connect <sessionId> [--json]
  wa qr <sessionId> [--json] [--base64]
  wa disconnect <sessionId>
  wa session remove <sessionId> --yes
  wa send <sessionId> <numero> <mensagem>
  wa listen <sessionId> [--raw]
  wa listen --all [--raw]
  wa webhook add <sessionId> <url> [--timeout-ms 5000] [--max-attempts 3]
  wa webhook list <sessionId>
  wa webhook remove <id>
  wa webhook deliveries [sessionId]

Notas:
  connect exibe QR quando necessario e restaura sessoes persistidas.
  qr le o QR corrente sem abrir conexao: ascii no terminal, PNG em base64 com
  --base64 e o data URL pronto para exibir com --json.
`.trim();
}

export function renderStatus(status: StatusResponse): string {
  const connected = status.sessions.filter((session) => session.status === "connected").length;

  return [
    `daemon: online (${status.daemon.pid})`,
    `endpoint: http://${status.daemon.host}:${status.daemon.port}`,
    `startedAt: ${status.daemon.startedAt}`,
    `sessions: ${status.sessions.length} total / ${connected} conectadas`,
    `events: ${status.eventCount}`,
    `webhooks: ${status.webhookCount}`
  ].join("\n");
}

export function renderOfflineStatus(status: OfflineStatusSnapshot): string {
  const stale = status.daemon.stalePid ? `stale-pid=${status.daemon.stalePid}` : "clean";

  return [
    "daemon: offline",
    `endpoint: http://${status.daemon.host}:${status.daemon.port}`,
    `runtime: ${status.daemon.runtimeFilePresent ? stale : "absent"}`,
    `token: ${status.daemon.tokenPresent ? "present" : "missing"}`,
    `sessions: ${status.sessions.length} conhecidas`,
    `events: ${status.eventCount}`,
    `webhooks: ${status.webhookCount}`
  ].join("\n");
}

export function renderSessions(sessions: SessionRecord[]): string {
  if (sessions.length === 0) {
    return "Nenhuma sessao registrada.";
  }

  return sessions
    .map((session) => {
      const suffix = session.active ? "active" : "inactive";
      const phone = session.phoneNumber ?? "-";
      const reconnect = session.reconnectAttempts > 0 ? `\tretries=${session.reconnectAttempts}` : "";
      return `${session.id}\t${session.status}\t${suffix}\t${phone}${reconnect}`;
    })
    .join("\n");
}

export function renderChats(chats: ChatRecord[]): string {
  if (chats.length === 0) {
    return "Nenhum chat projetado.";
  }

  return chats
    .map((chat) => {
      const name = chat.name ?? "-";
      const unread = chat.unreadCount > 0 ? ` unread=${chat.unreadCount}` : "";
      const last = chat.lastMessageText ? ` ${chat.lastMessageText}` : "";
      return `${name}\t${chat.id}\t${chat.type}${unread}${last}`;
    })
    .join("\n");
}

export function renderContacts(contacts: ContactRecord[]): string {
  if (contacts.length === 0) {
    return "Nenhum contato projetado.";
  }

  return contacts
    .map((contact) => {
      const name = contact.notify ?? contact.name ?? contact.verifiedName ?? "-";
      const phone = contact.phoneNumber ?? "-";
      return `${name}\t${phone}\t${contact.id}`;
    })
    .join("\n");
}

export function renderMessages(messages: MessageRecord[]): string {
  if (messages.length === 0) {
    return "Nenhuma mensagem projetada para este chat.";
  }

  return messages
    .map((message) => {
      const direction = message.fromMe ? "me" : "in";
      const text = message.text ?? `[${message.messageType}]`;
      return `${message.timestamp}\t${direction}\t${text}`;
    })
    .join("\n");
}

export function renderWebhooks(webhooks: WebhookRecord[]): string {
  if (webhooks.length === 0) {
    return "Nenhum webhook cadastrado.";
  }

  return webhooks
    .map((webhook) => {
      const status = webhook.lastStatus ?? "never";
      return `${webhook.id}\t${webhook.sessionId}\t${webhook.url}\t${status}`;
    })
    .join("\n");
}

export function renderWebhookDeliveries(deliveries: WebhookDeliveryRecord[]): string {
  if (deliveries.length === 0) {
    return "Nenhuma entrega registrada.";
  }

  return deliveries
    .map((delivery) => {
      const httpStatus = delivery.httpStatus ?? "-";
      return `${delivery.createdAt}\t${delivery.eventName}\t${delivery.status}\t${httpStatus}\t${delivery.webhookId}`;
    })
    .join("\n");
}
