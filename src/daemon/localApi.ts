import { AppError, isAppError, toApiErrorBody } from "../shared/errors.ts";
import { stringifyEvent, stripRawFromEvent } from "../shared/eventSerde.ts";
import type { Logger } from "../shared/logger.ts";
import type {
  ChatRecord,
  ContactRecord,
  CreateWebhookRequest,
  MessageRecord,
  SendMessageRequest,
  SessionCommandResponse,
  UpdateWebhookRequest
} from "../shared/types.ts";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_KEYS } from "../shared/events.ts";
import { DaemonRuntime } from "./daemonRuntime.ts";
import { EventBus } from "./eventBus.ts";
import { parseSendMediaRequest } from "./sendMediaRequest.ts";

interface LocalApiOptions {
  runtime: DaemonRuntime;
  token: string;
  eventBus: EventBus;
  logger: Logger;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(error: unknown): Response {
  const body = toApiErrorBody(error);
  const status = isAppError(error) ? error.status : 500;
  return json(body, status);
}

function assertAuthorized(request: Request, token: string): void {
  const header = request.headers.get("authorization");

  if (header !== `Bearer ${token}`) {
    throw new AppError("UNAUTHORIZED", 401, "Token local invalido.");
  }
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new AppError("INVALID_JSON", 400, "Corpo JSON invalido.");
  }
}

function createStreamResponse(
  request: Request,
  eventBus: EventBus,
  sessionId: string | null,
  includeRaw: boolean,
  logger: Logger
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const unsubscribe = eventBus.subscribe(sessionId, (event) => {
        const serialized = includeRaw ? event : stripRawFromEvent(event);
        controller.enqueue(encoder.encode(`${stringifyEvent(serialized)}\n`));
      });

      request.signal.addEventListener(
        "abort",
        () => {
          unsubscribe();
          controller.close();
        },
        { once: true }
      );

      logger.info("cliente conectado ao stream de eventos", {
        sessionId: sessionId ?? "all",
        includeRaw
      });
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    }
  });
}

function pathParts(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

function parseLimit(url: URL, fallback: number): number {
  const raw = url.searchParams.get("limit");
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError("INVALID_LIMIT", 400, "Use `limit` com inteiro positivo.");
  }

  return parsed;
}

function asSessionResponse(
  result: Awaited<ReturnType<DaemonRuntime["sessions"]["connect"]>>
): SessionCommandResponse {
  return {
    ok: true,
    session: result.session,
    ...(result.note ? { note: result.note } : {}),
    ...(result.qr ? { qr: result.qr } : {}),
    ...(result.qrTerminal ? { qrTerminal: result.qrTerminal } : {})
  };
}

export function startLocalApiServer({
  runtime,
  token,
  eventBus,
  logger
}: LocalApiOptions) {
  return Bun.serve({
    hostname: runtime.runtimeInfo.host,
    port: runtime.runtimeInfo.port,
    async fetch(request) {
      const url = new URL(request.url);
      const parts = pathParts(url);

      try {
        if (request.method === "GET" && url.pathname === "/health") {
          return json({
            ok: true,
            daemon: runtime.runtimeInfo
          });
        }

        assertAuthorized(request, token);

        if (request.method === "GET" && url.pathname === "/status") {
          return json(runtime.getStatus());
        }

        if (request.method === "GET" && url.pathname === "/sessions") {
          return json(runtime.sessions.listSessions());
        }

        if (request.method === "GET" && url.pathname === "/events/stream") {
          const all = url.searchParams.get("all") === "true";
          const sessionId = all ? null : url.searchParams.get("sessionId");
          const includeRaw = url.searchParams.get("raw") === "true";
          return createStreamResponse(request, eventBus, sessionId, includeRaw, logger);
        }

        if (request.method === "GET" && url.pathname === "/events/catalog") {
          return json(
            WEBHOOK_EVENTS.map((event) => ({
              event,
              key: WEBHOOK_EVENT_KEYS[event]
            }))
          );
        }

        if (request.method === "GET" && url.pathname === "/webhooks") {
          const sessionId = url.searchParams.get("sessionId") ?? undefined;
          return json(runtime.listWebhooks(sessionId));
        }

        if (request.method === "GET" && url.pathname === "/webhooks/deliveries") {
          const sessionId = url.searchParams.get("sessionId") ?? undefined;
          return json(runtime.listWebhookDeliveries(sessionId));
        }

        if (request.method === "POST" && url.pathname === "/webhooks") {
          const body = await parseJsonBody<CreateWebhookRequest>(request);
          return json(runtime.addWebhook(body), 201);
        }

        // `parts.length === 2` importa: sem isso um DELETE em
        // /webhooks/<id>/events/<evento> cairia aqui e apagaria o webhook
        // inteiro em vez de desligar um evento dele.
        if (
          parts[0] === "webhooks" &&
          parts[1] &&
          parts.length === 2 &&
          request.method === "DELETE"
        ) {
          runtime.removeWebhook(decodeURIComponent(parts[1]));
          return new Response(null, { status: 204 });
        }

        if (
          parts[0] === "webhooks" &&
          parts[1] &&
          parts.length === 2 &&
          request.method === "PATCH"
        ) {
          const webhookId = decodeURIComponent(parts[1]);
          const body = await parseJsonBody<UpdateWebhookRequest>(request);

          if (body.events !== undefined) {
            return json(runtime.setWebhookEvents(webhookId, body.events));
          }

          if (body.enabled !== undefined) {
            return json(runtime.setWebhookEnabled(webhookId, body.enabled));
          }

          throw new AppError(
            "NOTHING_TO_UPDATE",
            400,
            "Informe `events` ou `enabled` no corpo da requisicao."
          );
        }

        if (
          parts[0] === "webhooks" &&
          parts[1] &&
          parts[2] === "events" &&
          parts[3] &&
          (request.method === "PUT" || request.method === "DELETE")
        ) {
          const webhookId = decodeURIComponent(parts[1]);
          const eventName = decodeURIComponent(parts[3]);

          return json(
            request.method === "PUT"
              ? runtime.enableWebhookEvent(webhookId, eventName)
              : runtime.disableWebhookEvent(webhookId, eventName)
          );
        }

        if (parts[0] === "sessions" && parts[1]) {
          const sessionId = decodeURIComponent(parts[1]);

          if (request.method === "POST" && parts[2] === "connect") {
            return json(asSessionResponse(await runtime.sessions.connect(sessionId)));
          }

          if (request.method === "GET" && parts[2] === "qr") {
            return json(await runtime.sessions.readQr(sessionId));
          }

          if (request.method === "GET" && parts[2] === "chats") {
            return json(runtime.listChats(sessionId, parseLimit(url, 50)) satisfies ChatRecord[]);
          }

          if (request.method === "GET" && parts[2] === "contacts") {
            return json(runtime.listContacts(sessionId, parseLimit(url, 100)) satisfies ContactRecord[]);
          }

          if (request.method === "GET" && parts[2] === "messages") {
            const chat = url.searchParams.get("chat");
            if (!chat) {
              throw new AppError("CHAT_REQUIRED", 400, "Parametro `chat` obrigatorio.");
            }

            return json(
              runtime.listMessages(sessionId, chat, parseLimit(url, 50)) satisfies MessageRecord[]
            );
          }

          if (request.method === "GET" && parts[2] === "download-media") {
            const chat = url.searchParams.get("chat");
            const messageId = url.searchParams.get("messageId");
            if (!chat || !messageId) {
              throw new AppError(
                "INVALID_REQUEST",
                400,
                "Parametros `chat` e `messageId` obrigatorios."
              );
            }

            const { record, download } = await runtime.downloadMedia(sessionId, chat, messageId);
            return new Response(Buffer.from(download.buffer), {
              headers: {
                "content-type": "application/octet-stream",
                "x-media-kind": download.kind,
                "x-media-mime": download.mimeType,
                "x-media-size": String(download.size),
                "x-media-file-name": download.fileName
                  ? encodeURIComponent(download.fileName)
                  : "",
                "x-media-chat-jid": record.chatJid,
                "x-media-message-id": record.id
              }
            });
          }

          if (request.method === "POST" && parts[2] === "disconnect") {
            const session = await runtime.sessions.disconnect(sessionId);
            return json({
              ok: true,
              session
            });
          }

          if (request.method === "DELETE" && parts.length === 2) {
            await runtime.sessions.remove(sessionId);
            return new Response(null, { status: 204 });
          }

          if (request.method === "POST" && parts[2] === "send") {
            const body = await parseJsonBody<SendMessageRequest>(request);
            return json(await runtime.sessions.sendTextMessage(sessionId, body.to, body.text));
          }

          // Metadados em headers x-media-*, bytes no corpo. A validacao de
          // forma acontece ANTES de consumir o corpo: header faltante ou tipo
          // fora do vocabulario e 400 sem ler o upload.
          if (request.method === "POST" && parts[2] === "send-media") {
            const media = parseSendMediaRequest(request);
            const buffer = new Uint8Array(await request.arrayBuffer());
            return json(await runtime.sendMedia(sessionId, media, buffer));
          }
        }

        throw new AppError("NOT_FOUND", 404, "Rota nao encontrada.");
      } catch (error) {
        logger.error("erro na API local", {
          url: request.url,
          method: request.method,
          error: isAppError(error)
            ? { code: error.code, message: error.message }
            : { message: error instanceof Error ? error.message : "Unexpected error" }
        });

        return errorResponse(error);
      }
    }
  });
}
