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
  wa send-media <sessionId> <numero|jid> <arquivo> [--type image|audio] [--caption texto] [--ptt] [--json]
  wa download-media <sessionId> <chat|jid|numero> <messageId> [--out <caminho>] [--json]
  wa listen <sessionId> [--raw]
  wa listen --all [--raw]
  wa events [--json]
  wa webhook add <sessionId> <url> [--events a,b] [--timeout-ms 5000] [--max-attempts 3]
  wa webhook list [sessionId] [--json]
  wa webhook set-events <id> <a,b|all>
  wa webhook enable-event <id> <evento>
  wa webhook disable-event <id> <evento>
  wa webhook enable <id>
  wa webhook disable <id>
  wa webhook remove <id>
  wa webhook deliveries [sessionId] [--json]

Notas:
  connect exibe QR quando necessario e restaura sessoes persistidas.
  qr le o QR corrente sem abrir conexao: ascii no terminal, PNG em base64 com
  --base64 e o data URL pronto para exibir com --json.
  send-media envia imagem e audio: o tipo e inferido da extensao e --type
  sobrepoe; caption so em imagem; --ptt envia audio como voice note (a voice
  note ogg/opus carrega mimetype audio/ogg; codecs=opus). Upload tem timeout
  proprio de 60s e herda a semantica de exit codes do send: 0 entregue; 1
  falha sem transmissao (daemon parado ou erro classificado); 2 resultado
  incerto — a midia PODE ter sido enviada; conferir \`wa messages <sessionId>
  <numero>\` antes de reenviar para nao duplicar. Tipos fora da whitelist
  (video/documento/sticker) respondem MEDIA_TYPE_NOT_SUPPORTED_YET.
  download-media grava a midia de uma mensagem recebida (a mesma referencia
  chat + messageId que messages e o webhook entregam). Com --out grava no
  caminho dado; sem --out, no diretorio corrente como <messageId>.<extensao
  pelo MIME>. Midia de history-sync nao tem payload bruto guardado e responde
  MEDIA_PAYLOAD_UNAVAILABLE — peca o reenvio do arquivo; midia expirada
  responde DOWNLOAD_FAILED, sem retry automatico. Download e read-only: nada
  e transmitido ao WhatsApp; exit 0/1.
  webhook sem selecao de eventos recebe todos, inclusive os que forem criados
  depois; use --events ou set-events para restringir, e 'all' para voltar.
  webhook list sem sessao lista todos, que e como um webhook orfao — de uma
  sessao ja removida — aparece.
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
      const fallback =
        message.messageType === "unknown" && message.rawMessageType
          ? `[unknown:${message.rawMessageType}]`
          : `[${message.messageType}]`;
      const text = message.text ?? fallback;
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
      const state = webhook.enabled ? status : "disabled";
      return `${webhook.id}\t${webhook.sessionId}\t${webhook.url}\t${state}\t${webhook.eventsLabel}`;
    })
    .join("\n");
}

export function renderEventCatalog(catalog: Array<{ event: string; key: string }>): string {
  return catalog.map((entry) => `${entry.event}\t${entry.key}`).join("\n");
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
