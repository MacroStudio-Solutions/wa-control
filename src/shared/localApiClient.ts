import { AppError } from "./errors.ts";
import { loadAppConfig } from "../config/config.ts";
import { readLocalToken } from "../config/token.ts";
import type {
  ApiErrorBody,
  ChatRecord,
  ContactRecord,
  CreateWebhookRequest,
  HealthResponse,
  MessageRecord,
  SendMessageRequest,
  SendMessageResponse,
  SessionCommandResponse,
  SessionRecord,
  StatusResponse,
  WebhookDeliveryRecord,
  WebhookRecord
} from "./types.ts";

async function parseError(response: Response): Promise<never> {
  let body: ApiErrorBody | null = null;

  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // ignored
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
  private readonly requestTimeoutMs = 1500;

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

  private async safeFetch(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutError = new AppError(
      "DAEMON_UNAVAILABLE",
      503,
      "Daemon local nao esta rodando. Inicie com `wa daemon start`.",
      {
        url,
        cause: "Request timed out"
      }
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, this.requestTimeoutMs);

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

      throw new AppError(
        "DAEMON_UNAVAILABLE",
        503,
        "Daemon local nao esta rodando. Inicie com `wa daemon start`.",
        {
          url,
          cause: error instanceof Error ? error.message : "Unexpected error"
        }
      );
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

  async connect(sessionId: string): Promise<SessionCommandResponse> {
    return this.requestJson<SessionCommandResponse>(`/sessions/${encodeURIComponent(sessionId)}/connect`, {
      method: "POST"
    });
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
    return this.requestJson(
      `/sessions/${encodeURIComponent(sessionId)}/send`,
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      true
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
    includeJson = false
  ): Promise<T> {
    const response = await this.safeFetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.buildHeaders(includeJson)
    });

    if (!response.ok) {
      await parseError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}
