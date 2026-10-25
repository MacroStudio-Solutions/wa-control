import { connect as netConnect } from "node:net";
import { AppError } from "./errors.ts";
import { loadAppConfig } from "../config/config.ts";
import { readLocalToken } from "../config/token.ts";
import type {
  ApiErrorBody,
  ChatRecord,
  ContactRecord,
  CreateWebhookRequest,
  DeleteMessageRequest,
  DeleteMessageResponse,
  DownloadMediaResponse,
  GroupCreateRequest,
  GroupCreateResponse,
  GroupInfoResponse,
  GroupLeaveResponse,
  GroupParticipantsRequest,
  GroupParticipantsResponse,
  HealthResponse,
  MessageRecord,
  PollRequest,
  PollResponse,
  ReactRequest,
  ReactResponse,
  ReadRequest,
  ReadResponse,
  SendMediaRequest,
  SendMediaResponse,
  SendMessageRequest,
  SendMessageResponse,
  SessionCommandResponse,
  SessionQrResponse,
  SessionRecord,
  StatusResponse,
  TypingRequest,
  TypingResponse,
  WebhookDeliveryRecord,
  WebhookRecord
} from "./types.ts";

const DAEMON_STOPPED_MESSAGE = "Daemon local nao esta rodando. Inicie com `wa daemon start`.";

function uncertainOutcomeFor(url: string, outcomeDescription: string): () => AppError {
  return () =>
    new AppError(
      "SEND_RESULT_UNCERTAIN",
      504,
      `Resultado incerto: o daemon aceitou a conexao, mas ${outcomeDescription}.`,
      {
        url,
        cause: "Chat operation outcome unknown"
      }
    );
}

export const DEFAULT_TIMEOUTS = {
  requestTimeoutMs: 1_500,
  connectTimeoutMs: 25_000,
  sendTimeoutMs: 15_000,
  probeTimeoutMs: 400,
  /**
   * Midia (fetch de download e upload de envio) varia com rede e tamanho do
   * arquivo; 60s e o teto proprio dela, distinto da leitura (1,5s) e do
   * send-texto (15s). O timeout estourado numa operacao de midia NUNCA deve ser
   * lido como "daemon parado" — a licao 0.5.0 e que classificacao mentirosa de
   * timeout vira falso negativo e reenvio duplicado.
   */
  mediaTimeoutMs: 60_000
} as const;

export interface LocalApiClientTimeouts {
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  sendTimeoutMs?: number;
  probeTimeoutMs?: number;
  mediaTimeoutMs?: number;
}

export type DaemonGate = "open" | "closed";

/**
 * Sonda TCP curta: abre o socket e devolve "open" quando algo aceita conexao e
 * "closed" quando recusa ou nao responde dentro do limite.
 */
export function probeTcpGate(host: string, port: number, timeoutMs: number): Promise<DaemonGate> {
  return new Promise<DaemonGate>((resolve) => {
    const socket = netConnect({ host, port });
    let settled = false;

    const settle = (gate: DaemonGate) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(gate);
    };

    socket.on("connect", () => settle("open"));
    socket.on("error", () => settle("closed"));

    const timer = setTimeout(() => settle("closed"), timeoutMs);
    timer.unref?.();
  });
}

const CONNECTION_REFUSAL_MARKERS = [
  "econnrefused",
  "connectionrefused",
  "connection refused",
  "unable to connect",
  "ehostunreach",
  "no route to host",
  "enetunreach",
  "network is unreachable",
  "eaddrnotavail",
  "address not available"
];

/**
 * Recusa de conexao e a familia de erros em que a requisicao com certeza nao
 * saiu da maquina: nada aceitando na porta ou sem rota ate ela. O timeout e o
 * reset de socket no meio do voo NAO sao recusa — a requisicao pode ter sido
 * entregue.
 */
export function isConnectionRefusal(error: unknown): boolean {
  const fragments: string[] = [];
  let current: unknown = error;

  while (current instanceof Error) {
    fragments.push(current.message);

    const code = (current as { code?: string }).code;
    if (code) {
      fragments.push(code);
    }

    current = (current as { cause?: unknown }).cause;
  }

  const text = fragments.join(" ").toLowerCase();
  return CONNECTION_REFUSAL_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Rota ausente no daemon em execucao e a assinatura da janela de upgrade: CLI
 * nova chamando rota aditiva que o daemon velho ainda nao conhece. O fallback
 * do daemon responde exatamente { code: "NOT_FOUND" } com 404; 404s de dominio
 * (SESSION_NOT_FOUND, WEBHOOK_NOT_FOUND, GROUP_NOT_FOUND, ...) carregam codigo
 * proprio e nunca caem aqui — e 404 sem corpo JSON nao e o daemon local.
 */
function isRouteMissingOnDaemon(response: Response, body: ApiErrorBody | null): boolean {
  return response.status === 404 && body?.error.code === "NOT_FOUND";
}

async function parseError(response: Response): Promise<never> {
  let body: ApiErrorBody | null = null;

  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // ignored
  }

  if (isRouteMissingOnDaemon(response, body)) {
    throw new AppError(
      "DAEMON_VERSION_MISMATCH",
      404,
      "Comando nao existe no daemon em execucao: a CLI esta mais nova que o daemon ativo (janela de upgrade). Reinicie o daemon para carregar a versao atual (pare o processo e rode `wa daemon start`); se o daemon no disco tambem estiver velho, atualize o runtime do wa-control.",
      {
        url: response.url,
        cause: "Route not found on running daemon (older daemon version)"
      }
    );
  }

  throw new AppError(
    body?.error.code ?? "HTTP_ERROR",
    response.status,
    body?.error.message ?? `Falha HTTP ${response.status}`
  );
}

export class LocalApiClient {
  private readonly config = loadAppConfig();
  private readonly token = readLocalToken(this.config);
  private readonly baseUrl = `http://${this.config.host}:${this.config.port}`;
  /**
   * Leituras respondem na hora, entao um limite curto e o que separa "daemon
   * fora do ar" de "daemon lento". `connect` e a excecao: ele segura a resposta
   * ate o WhatsApp emitir o QR, e com o limite curto toda tentativa de parear
   * morria aqui e aparecia como daemon parado.
   *
   * `send` e a outra excecao — e nao idempotente. Se o timeout estoura depois
   * que o daemon aceitou a conexao, a mensagem PODE ter sido entregue: abortar
   * cedo so esconde o resultado real e induz o reenvio duplicado. Por isso o
   * send espera bem mais e, quando ainda assim estoura, reporta resultado
   * incerto em vez de daemon parado.
   */
  private requestTimeoutMs: number = DEFAULT_TIMEOUTS.requestTimeoutMs;
  private connectTimeoutMs: number = DEFAULT_TIMEOUTS.connectTimeoutMs;
  private sendTimeoutMs: number = DEFAULT_TIMEOUTS.sendTimeoutMs;
  private probeTimeoutMs: number = DEFAULT_TIMEOUTS.probeTimeoutMs;
  private mediaTimeoutMs: number = DEFAULT_TIMEOUTS.mediaTimeoutMs;

  constructor(timeouts: LocalApiClientTimeouts = {}) {
    if (timeouts.requestTimeoutMs !== undefined) {
      this.requestTimeoutMs = timeouts.requestTimeoutMs;
    }

    if (timeouts.connectTimeoutMs !== undefined) {
      this.connectTimeoutMs = timeouts.connectTimeoutMs;
    }

    if (timeouts.sendTimeoutMs !== undefined) {
      this.sendTimeoutMs = timeouts.sendTimeoutMs;
    }

    if (timeouts.probeTimeoutMs !== undefined) {
      this.probeTimeoutMs = timeouts.probeTimeoutMs;
    }

    if (timeouts.mediaTimeoutMs !== undefined) {
      this.mediaTimeoutMs = timeouts.mediaTimeoutMs;
    }
  }

  private buildHeaders(includeJson = false): HeadersInit {
    if (!this.token) {
      throw new AppError(
        "TOKEN_NOT_FOUND",
        400,
        "Token local nao encontrado. Inicie o daemon primeiro."
      );
    }

    return {
      authorization: `Bearer ${this.token}`,
      ...(includeJson ? { "content-type": "application/json" } : {})
    };
  }

  /**
   * Sonda TCP curta que distingue "nada aceitando conexoes na porta" (daemon
   * parado ou inalcancavel) de "porta aceitando". O `fetch` do Bun nao rejeita
   * conexao recusada: ele reentra em silencio e so solta timeout no abort, o
   * que tornaria impossivel classificar recusa de forma imediata por ele
   * mesmo. Abrir o socket e o unico sinal confiavel — e instantaneo quando a
   * recusa vem com RST, como na maquina do operador.
   */
  probeDaemonGate(): Promise<DaemonGate> {
    const url = new URL(this.baseUrl);
    return probeTcpGate(url.hostname, Number(url.port), this.probeTimeoutMs);
  }

  private async safeFetch(
    url: string,
    init?: RequestInit,
    timeoutMs = this.requestTimeoutMs,
    timeoutErrorFactory?: () => AppError
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutError = timeoutErrorFactory
      ? timeoutErrorFactory()
      : new AppError("DAEMON_UNAVAILABLE", 503, DAEMON_STOPPED_MESSAGE, {
          url,
          cause: "Request timed out"
        });

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, timeoutMs);

      timeout.unref?.();
    });

    try {
      return await Promise.race([
        fetch(url, {
          ...init,
          signal: controller.signal
        }),
        timeoutPromise
      ]);
    } catch (error) {
      if (error === timeoutError) {
        throw error;
      }

      /**
       * Operacao com desfecho incerto (send): qualquer falha de rede que nao
       * seja recusa de conexao deixou a requisicao em voo — o resultado real
       * e desconhecido e reportar daemon parado seria mentira.
       */
      if (timeoutErrorFactory && !isConnectionRefusal(error)) {
        throw timeoutErrorFactory();
      }

      throw new AppError("DAEMON_UNAVAILABLE", 503, DAEMON_STOPPED_MESSAGE, {
        url,
        cause: error instanceof Error ? error.message : "Unexpected error"
      });
    }
  }

  async health(): Promise<HealthResponse> {
    const response = await this.safeFetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      await parseError(response);
    }

    return (await response.json()) as HealthResponse;
  }

  async status(): Promise<StatusResponse> {
    return this.requestJson<StatusResponse>("/status");
  }

  async sessions(): Promise<SessionRecord[]> {
    return this.requestJson<SessionRecord[]>("/sessions");
  }

  async chats(sessionId: string, limit = 50): Promise<ChatRecord[]> {
    return this.requestJson<ChatRecord[]>(
      `/sessions/${encodeURIComponent(sessionId)}/chats?limit=${encodeURIComponent(String(limit))}`
    );
  }

  async contacts(sessionId: string, limit = 100): Promise<ContactRecord[]> {
    return this.requestJson<ContactRecord[]>(
      `/sessions/${encodeURIComponent(sessionId)}/contacts?limit=${encodeURIComponent(String(limit))}`
    );
  }

  async messages(sessionId: string, chat: string, limit = 50): Promise<MessageRecord[]> {
    const query = new URLSearchParams({
      chat,
      limit: String(limit)
    });

    return this.requestJson<MessageRecord[]>(
      `/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`
    );
  }

  /**
   * Download de midia: o daemon busca do WhatsApp e devolve os bytes com os
   * metadados em headers. Usa o timeout dedicado de midia (60s) e, quando ele
   * estoura, NUNCA le como daemon parado — a resposta pode estar a caminho de
   * um arquivo grande numa rede lenta.
   */
  async downloadMedia(
    sessionId: string,
    chat: string,
    messageId: string
  ): Promise<DownloadMediaResponse> {
    const query = new URLSearchParams({
      chat,
      messageId
    });
    const mediaTimeout = () =>
      new AppError(
        "MEDIA_TIMEOUT",
        504,
        `O download da midia nao terminou em ${Math.round(this.mediaTimeoutMs / 1000)}s (rede lenta ou arquivo grande). Tente novamente.`,
        {
          sessionId,
          chat,
          messageId,
          cause: "Media request timed out"
        }
      );

    const response = await this.safeFetch(
      `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/download-media?${query.toString()}`,
      {
        headers: this.buildHeaders()
      },
      this.mediaTimeoutMs,
      mediaTimeout
    );

    if (!response.ok) {
      await parseError(response);
    }

    const header = (name: string): string | null => response.headers.get(name);
    const declaredSize = Number(header("x-media-size"));
    const buffer = new Uint8Array(await response.arrayBuffer());
    const encodedFileName = header("x-media-file-name");

    return {
      kind: header("x-media-kind") ?? "unknown",
      mimeType: header("x-media-mime") ?? "application/octet-stream",
      size: Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : buffer.byteLength,
      fileName: encodedFileName ? decodeURIComponent(encodedFileName) : null,
      chatJid: header("x-media-chat-jid") ?? "",
      messageId: header("x-media-message-id") ?? messageId,
      buffer
    };
  }

  async connect(sessionId: string): Promise<SessionCommandResponse> {
    return this.requestJson<SessionCommandResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/connect`,
      { method: "POST" },
      false,
      this.connectTimeoutMs
    );
  }

  async qr(sessionId: string): Promise<SessionQrResponse> {
    return this.requestJson<SessionQrResponse>(`/sessions/${encodeURIComponent(sessionId)}/qr`);
  }

  async disconnect(sessionId: string): Promise<SessionCommandResponse> {
    return this.requestJson<SessionCommandResponse>(`/sessions/${encodeURIComponent(sessionId)}/disconnect`, {
      method: "POST"
    });
  }

  async remove(sessionId: string): Promise<void> {
    const response = await this.safeFetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: this.buildHeaders()
    });

    if (!response.ok && response.status !== 204) {
      await parseError(response);
    }
  }

  async send(sessionId: string, payload: SendMessageRequest): Promise<SendMessageResponse> {
    const sendUrl = `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/send`;
    const uncertainOutcome = () =>
      new AppError(
        "SEND_RESULT_UNCERTAIN",
        504,
        `Resultado incerto: o daemon aceitou a conexao, mas a resposta do envio nao chegou em tempo e a mensagem PODE ter sido enviada. Confira o historico com \`wa messages ${sessionId} ${payload.to}\` antes de reenviar para nao duplicar.`,
        {
          url: sendUrl,
          cause: "Send request outcome unknown"
        }
      );

    const gate = await this.probeDaemonGate();

    if (gate === "closed") {
      throw new AppError("DAEMON_UNAVAILABLE", 503, DAEMON_STOPPED_MESSAGE, {
        url: sendUrl,
        cause: "Connection refused"
      });
    }

    return this.requestJson<SendMessageResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/send`,
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      true,
      this.sendTimeoutMs,
      uncertainOutcome
    );
  }

  /**
   * Envio de midia: mesma disciplina do send-texto — sonda TCP antes do POST
   * (recusa = daemon parado, exit 1) e, depois de a conexao ser aceita, timeout
   * proprio de midia (60s, upload varia com rede e tamanho). Estourado o
   * timeout, o resultado e SEND_RESULT_UNCERTAIN (exit 2): a midia PODE ter
   * sido entregue e conferir `messages` antes de reenviar e obrigatorio.
   * Bytes viajam no corpo; metadados em headers x-media-*.
   */
  async sendMedia(
    sessionId: string,
    request: SendMediaRequest,
    buffer: Uint8Array
  ): Promise<SendMediaResponse> {
    const sendUrl = `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/send-media`;
    const uncertainOutcome = () =>
      new AppError(
        "SEND_RESULT_UNCERTAIN",
        504,
        `Resultado incerto: o daemon aceitou a conexao, mas o upload da midia nao terminou em ${Math.round(
          this.mediaTimeoutMs / 1000
        )}s e a midia PODE ter sido enviada. Confira o historico com \`wa messages ${sessionId} ${request.to}\` antes de reenviar para nao duplicar.`,
        {
          url: sendUrl,
          cause: "Media send outcome unknown"
        }
      );

    const gate = await this.probeDaemonGate();

    if (gate === "closed") {
      throw new AppError("DAEMON_UNAVAILABLE", 503, DAEMON_STOPPED_MESSAGE, {
        url: sendUrl,
        cause: "Connection refused"
      });
    }

    const response = await this.safeFetch(
      sendUrl,
      {
        method: "POST",
        headers: {
          ...this.buildHeaders(),
          "content-type": "application/octet-stream",
          "x-media-to": request.to,
          "x-media-kind": request.kind,
          "x-media-mime": request.mimeType,
          ...(request.caption ? { "x-media-caption": encodeURIComponent(request.caption) } : {}),
          ...(request.fileName
            ? { "x-media-file-name": encodeURIComponent(request.fileName) }
            : {}),
          ...(request.ptt ? { "x-media-ptt": "1" } : {})
        },
        body: Buffer.from(buffer)
      },
      this.mediaTimeoutMs,
      uncertainOutcome
    );

    if (!response.ok) {
      await parseError(response);
    }

    return (await response.json()) as SendMediaResponse;
  }

  /**
   * Operacoes de chat (typing/read): transmitem pela sessao, mas sem estado
   * duravel verificavel — timeout classificado como falha (exit 1), pois
   * reexecutar e o fluxo natural e seguro. Usam o timeout de send (15s) e nao
   * o de leitura (1,5s), porque esperam ida e volta do socket do WhatsApp.
   */
  async typing(
    sessionId: string,
    request: TypingRequest
  ): Promise<TypingResponse> {
    return this.requestJson<TypingResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/typing`,
      {
        method: "POST",
        body: JSON.stringify(request)
      },
      true,
      this.sendTimeoutMs
    );
  }

  async markRead(sessionId: string, request: ReadRequest): Promise<ReadResponse> {
    return this.requestJson<ReadResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/read`,
      {
        method: "POST",
        body: JSON.stringify(request)
      },
      true,
      this.sendTimeoutMs
    );
  }

  /**
   * React/delete/poll: mutacoes com resposta nao-garantida. Depois de o
   * daemon aceitar a conexao, timeout sai como SEND_RESULT_UNCERTAIN (exit 2)
   * — a operacao PODE ter surtido efeito; conferir antes de repetir.
   */
  async react(sessionId: string, request: ReactRequest): Promise<ReactResponse> {
    const opUrl = `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/react`;
    return this.requestJson<ReactResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/react`,
      {
        method: "POST",
        body: JSON.stringify(request)
      },
      true,
      this.sendTimeoutMs,
      uncertainOutcomeFor(opUrl, `a resposta da reacao em ${request.messageId} nao chegou em tempo e a reacao PODE ter sido aplicada`)
    );
  }

  async deleteMessage(
    sessionId: string,
    request: DeleteMessageRequest
  ): Promise<DeleteMessageResponse> {
    const opUrl = `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/delete`;
    return this.requestJson<DeleteMessageResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/delete`,
      {
        method: "POST",
        body: JSON.stringify(request)
      },
      true,
      this.sendTimeoutMs,
      uncertainOutcomeFor(opUrl, `a resposta do delete de ${request.messageId} nao chegou em tempo e a mensagem PODE ter sido apagada`)
    );
  }

  async sendPoll(sessionId: string, request: PollRequest): Promise<PollResponse> {
    const opUrl = `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/poll`;
    return this.requestJson<PollResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/poll`,
      {
        method: "POST",
        body: JSON.stringify(request)
      },
      true,
      this.sendTimeoutMs,
      uncertainOutcomeFor(opUrl, `a resposta do envio da enquete nao chegou em tempo e a enquete PODE ter sido enviada. Confira o historico com \`wa messages ${sessionId} ${request.chat}\` antes de reenviar para nao duplicar`)
    );
  }

  /**
   * Operacoes de grupo (create/add/remove/promote/demote/leave): mutacoes nao
   * idempotentes sobre a sessao. Depois de o daemon aceitar a conexao, timeout
   * sai como SEND_RESULT_UNCERTAIN (exit 2) — o grupo PODE ter sido criado, a
   * atualizacao PODE ter sido aplicada, o bot PODE ter saido; conferir com
   * `wa group info` antes de repetir para nao duplicar. `info` e leitura
   * idempotente: timeout classificado como falha (exit 1).
   */
  async createGroup(
    sessionId: string,
    request: GroupCreateRequest
  ): Promise<GroupCreateResponse> {
    const opUrl = `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/groups`;
    return this.requestJson<GroupCreateResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/groups`,
      {
        method: "POST",
        body: JSON.stringify(request)
      },
      true,
      this.sendTimeoutMs,
      uncertainOutcomeFor(
        opUrl,
        "a resposta da criacao do grupo nao chegou em tempo e o grupo PODE ter sido criado. Confira com `wa group info` ou `wa chats` antes de recriar para nao duplicar"
      )
    );
  }

  async groupInfo(sessionId: string, groupJid: string): Promise<GroupInfoResponse> {
    return this.requestJson<GroupInfoResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(groupJid)}`,
      { headers: this.buildHeaders() },
      false,
      this.sendTimeoutMs
    );
  }

  async updateGroupParticipants(
    sessionId: string,
    request: GroupParticipantsRequest
  ): Promise<GroupParticipantsResponse> {
    const path = `sessions/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(
      request.groupJid
    )}/participants`;
    return this.requestJson<GroupParticipantsResponse>(
      `/${path}`,
      {
        method: "POST",
        body: JSON.stringify({
          action: request.action,
          participants: request.participants
        })
      },
      true,
      this.sendTimeoutMs,
      uncertainOutcomeFor(
        `${this.baseUrl}/${path}`,
        `a resposta da atualizacao (${request.action}) nao chegou em tempo e ela PODE ter sido aplicada. Confira com \`wa group info ${request.groupJid}\` antes de repetir`
      )
    );
  }

  async leaveGroup(sessionId: string, groupJid: string): Promise<GroupLeaveResponse> {
    const path = `sessions/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(
      groupJid
    )}/leave`;
    return this.requestJson<GroupLeaveResponse>(
      `/${path}`,
      { method: "POST" },
      true,
      this.sendTimeoutMs,
      uncertainOutcomeFor(
        `${this.baseUrl}/${path}`,
        "a resposta da saida nao chegou em tempo e o bot PODE ter saido do grupo. Confira com `wa chats` antes de repetir"
      )
    );
  }

  async stream(sessionId: string | null, all: boolean, raw = false): Promise<Response> {
    const query = new URLSearchParams();
    if (all) {
      query.set("all", "true");
    }
    if (sessionId) {
      query.set("sessionId", sessionId);
    }
    if (raw) {
      query.set("raw", "true");
    }

    const response = await this.safeFetch(`${this.baseUrl}/events/stream?${query.toString()}`, {
      headers: this.buildHeaders()
    });

    if (!response.ok) {
      await parseError(response);
    }

    return response;
  }

  async addWebhook(input: CreateWebhookRequest): Promise<WebhookRecord> {
    return this.requestJson<WebhookRecord>(
      "/webhooks",
      {
        method: "POST",
        body: JSON.stringify(input)
      },
      true
    );
  }

  async listWebhooks(sessionId?: string): Promise<WebhookRecord[]> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return this.requestJson<WebhookRecord[]>(`/webhooks${query}`);
  }

  async setWebhookEvents(id: string, events: readonly string[]): Promise<WebhookRecord> {
    return this.requestJson<WebhookRecord>(
      `/webhooks/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ events })
      },
      true
    );
  }

  async setWebhookEnabled(id: string, enabled: boolean): Promise<WebhookRecord> {
    return this.requestJson<WebhookRecord>(
      `/webhooks/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled })
      },
      true
    );
  }

  async toggleWebhookEvent(
    id: string,
    event: string,
    enabled: boolean
  ): Promise<WebhookRecord> {
    return this.requestJson<WebhookRecord>(
      `/webhooks/${encodeURIComponent(id)}/events/${encodeURIComponent(event)}`,
      { method: enabled ? "PUT" : "DELETE" }
    );
  }

  async eventCatalog(): Promise<Array<{ event: string; key: string }>> {
    return this.requestJson<Array<{ event: string; key: string }>>("/events/catalog");
  }

  async removeWebhook(id: string): Promise<void> {
    const response = await this.safeFetch(`${this.baseUrl}/webhooks/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.buildHeaders()
    });

    if (!response.ok && response.status !== 204) {
      await parseError(response);
    }
  }

  async listWebhookDeliveries(sessionId?: string): Promise<WebhookDeliveryRecord[]> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return this.requestJson<WebhookDeliveryRecord[]>(`/webhooks/deliveries${query}`);
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit = {},
    includeJson = false,
    timeoutMs = this.requestTimeoutMs,
    timeoutErrorFactory?: () => AppError
  ): Promise<T> {
    const response = await this.safeFetch(
      `${this.baseUrl}${path}`,
      {
        ...init,
        headers: this.buildHeaders(includeJson)
      },
      timeoutMs,
      timeoutErrorFactory
    );

    if (!response.ok) {
      await parseError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}
