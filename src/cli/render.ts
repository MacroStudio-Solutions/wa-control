import type {
  ChatRecord,
  ContactRecord,
  DeleteMessageResponse,
  GroupInfoResponse,
  GroupParticipantsResponse,
  MessageRecord,
  PollResponse,
  ReactResponse,
  ReadResponse,
  SessionRecord,
  StatusResponse,
  TypingResponse,
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
  wa send-media <sessionId> <numero|jid> <arquivo> [--type image|audio|video|document] [--caption texto] [--filename nome] [--ptt] [--json]
  wa download-media <sessionId> <chat|jid|numero> <messageId> [--out <caminho>] [--json]
  wa typing <sessionId> <chat|jid|numero> [--recording] [--json]
  wa read <sessionId> <chat|jid|numero> [--message-id <id>] [--json]
  wa react <sessionId> <chat|jid|numero> <messageId> <emoji|.> [--json]
  wa delete <sessionId> <chat|jid|numero> <messageId> [--json]
  wa poll <sessionId> <chat|jid|numero> <pergunta> <opcao1> <opcao2> [...] [--json]
  wa group create <sessionId> <assunto> [--participants 5567...,5511...] [--json]
  wa group info <sessionId> <groupJid> [--json]
  wa group add <sessionId> <groupJid> <numero1> [numero2] [...] [--json]
  wa group remove <sessionId> <groupJid> <numero1> [...] [--json]
  wa group promote <sessionId> <groupJid> <numero1> [...] [--json]
  wa group demote <sessionId> <groupJid> <numero1> [...] [--json]
  wa group leave <sessionId> <groupJid> [--json]
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
  send-media envia imagem, audio, video e documento: o tipo e inferido da
  extensao e --type sobrepoe — e obrigatorio quando a extensao nao e
  reconhecida (a inferencia e honesta, sem tipo errado silencioso); caption
  em imagem e video; --filename sobrepoe o nome do documento (sem ele, o
  nome do arquivo e usado); --ptt envia audio como voice note (a voice
  note ogg/opus carrega mimetype audio/ogg; codecs=opus). Upload tem timeout
  proprio de 60s e herda a semantica de exit codes do send: 0 entregue; 1
  falha sem transmissao (daemon parado ou erro classificado); 2 resultado
  incerto — a midia PODE ter sido enviada; conferir \`wa messages <sessionId>
  <numero>\` antes de reenviar para nao duplicar. Tipos fora da whitelist
  (sticker) respondem MEDIA_TYPE_NOT_SUPPORTED_YET com os tipos liberados.
  download-media grava a midia de uma mensagem recebida (a mesma referencia
  chat + messageId que messages e o webhook entregam). Com --out grava no
  caminho dado; sem --out, no diretorio corrente como <messageId>.<extensao
  pelo MIME> — video mp4 baixa como .mp4. Midia de history-sync nao tem
  payload bruto guardado e responde
   MEDIA_PAYLOAD_UNAVAILABLE — peca o reenvio do arquivo; midia expirada
   responde DOWNLOAD_FAILED, sem retry automatico. Download e read-only: nada
   e transmitido ao WhatsApp; exit 0/1.
   typing envia o indicador de digitacao uma unica vez; --recording troca para
   o indicador de gravacao de audio. read marca como lida a mensagem mais
   recente do chat; com --message-id marca aquela mensagem. Chat sem conversa
   local: typing responde com aviso explicito e read sem mensagem recente
   falha (READ_NO_RECENT_MESSAGE) — nunca sucesso mentiroso.
   react reage a mensagem; emoji "." (ou string vazia) REMOVE a reacao. A
   mensagem e referenciada pelo mesmo chat + messageId que messages e o
   webhook entregam; inexistente no historico local sai 404.
   delete apaga a mensagem: revoke para todos quando propria; recusa do
   WhatsApp (mensagem antiga, sem admin em grupo) sai como erro classificado
   com o statusCode da Baileys — degradacao honesta, exit 1.
   poll envia enquete de 2 a 12 opcoes, validadas localmente ANTES do envio
   (POLL_OPTIONS_TOO_FEW / POLL_OPTIONS_TOO_MANY); leitura de votos nao e
   exposta. Todos herdam a semantica de exit codes do send: em react, delete
   e poll, timeout depois de o daemon aceitar a operacao sai 2 — resultado
   incerto, confira antes de repetir.
   group gerencia grupos: create cria (o bot vira dono/superadmin; numeros em
   --participants separados por virgula); info le metadados completos
   (assunto, dono, descricao, criacao, participantes com admin); add/remove/
   promote/demote atualizam participantes (recusa por participante sai com o
   motivo acionavel — ja participa, privacidade, sem admin — e exit 1);
   leave sai do grupo (irreversivel sem convite). JID de grupo termina em
   @g.us; sem @ o comando falha na validacao local. Erros de classe conhecida
   do WhatsApp tem codigo proprio: GROUP_NOT_FOUND (JID inexistente) e
   GROUP_NOT_ALLOWED (sem permissao/admin). create/add/remove/promote/demote/
   leave herdam a semantica do send: timeout depois de o daemon aceitar sai 2
   — resultado incerto, confira com \`wa group info\` antes de repetir.
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

export function renderTyping(result: TypingResponse): string {
  const mode = result.recording ? "gravacao de audio" : "digitacao";
  const note = result.note ? ` ${result.note}` : "";
  return `Indicador de ${mode} enviado para ${result.jid}.${note}`;
}

export function renderRead(result: ReadResponse): string {
  return `Mensagem marcada como lida em ${result.jid}: ${result.messageIds.join(", ")}`;
}

export function renderReact(result: ReactResponse): string {
  if (result.removed) {
    return `Reacao removida da mensagem ${result.messageId} em ${result.jid}.`;
  }

  return `Reacao ${result.emoji} enviada para a mensagem ${result.messageId} em ${result.jid}.`;
}

export function renderDelete(result: DeleteMessageResponse): string {
  const scope = result.fromMe ? "apagada para todos" : "apagada";
  return `Mensagem ${result.messageId} ${scope} em ${result.jid}.`;
}

export function renderPoll(result: PollResponse): string {
  const id = result.messageId ? ` (${result.messageId})` : "";
  return `Enquete "${result.question}" enviada para ${result.jid} com ${result.options.length} opcoes${id}.`;
}

export function renderGroupInfo(result: GroupInfoResponse): string {
  const creation = result.creation
    ? new Date(result.creation * 1000).toISOString().slice(0, 10)
    : null;
  const header = [
    `Grupo: ${result.subject}`,
    `jid: ${result.jid}`,
    `tamanho: ${result.size}`,
    result.owner ? `dono: ${result.owner}` : null,
    result.description ? `descricao: ${result.description}` : null,
    creation ? `criacao: ${creation}` : null
  ]
    .filter(Boolean)
    .join("\n");

  if (result.participants.length === 0) {
    return header;
  }

  const participants = result.participants
    .map((participant) => {
      const name = participant.name ?? "-";
      const role = participant.isSuperAdmin
        ? "\tsuperadmin"
        : participant.isAdmin
          ? "\tadmin"
          : "";
      return `${name}\t${participant.jid}${role}`;
    })
    .join("\n");

  return `${header}\nparticipantes:\n${participants}`;
}

export function renderGroupCreate(result: GroupInfoResponse): string {
  return `Grupo "${result.subject}" criado: ${result.jid} (${result.size} participante(s), incluindo o bot como superadmin).`;
}

export function renderGroupParticipants(result: GroupParticipantsResponse): string {
  const verb = {
    add: "adicionado(s)",
    remove: "removido(s)",
    promote: "promovido(s) a admin",
    demote: "rebaixado(s) a membro"
  }[result.action];
  const list = result.updated.join(", ");

  return `Participante(s) ${verb} em ${result.jid}: ${list}`;
}

export function renderGroupLeave(result: { jid: string }): string {
  return `Bot saiu do grupo ${result.jid}.`;
}
