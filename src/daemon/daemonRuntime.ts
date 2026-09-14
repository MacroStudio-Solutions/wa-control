import { existsSync, rmSync, writeFileSync } from "node:fs";
import type { WAMessage } from "@whiskeysockets/baileys";
import pkg from "../../package.json" with { type: "json" };
import { AppError } from "../shared/errors.ts";
import { DEFAULT_TIMEOUTS } from "../shared/localApiClient.ts";
import type { Logger } from "../shared/logger.ts";
import type {
  AppConfig,
  ChatRecord,
  ContactRecord,
  CreateWebhookRequest,
  DaemonRuntimeInfo,
  MessageRecord,
  SendMediaRequest,
  SendMediaResponse,
  StatusResponse,
  WebhookRecord
} from "../shared/types.ts";
import {
  createMediaFetcher,
  downloadIncomingMedia,
  type IncomingMediaDownload,
  type MediaFetcher
} from "../media/mediaDownload.ts";
import { messageNotFoundError } from "../media/mediaTypes.ts";
import { ReadModelStore } from "../read-model/store.ts";
import { EventsRepo } from "../storage/eventsRepo.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import { WebhookDeliveriesRepo } from "../storage/webhookDeliveriesRepo.ts";
import { WebhooksRepo } from "../storage/webhooksRepo.ts";
import { EventBus } from "./eventBus.ts";
import { EventPublisher } from "./eventPublisher.ts";
import { SessionManager } from "./sessionManager.ts";
import { WebhookDispatcher } from "./webhookDispatcher.ts";

export class DaemonRuntime {
  readonly runtimeInfo: DaemonRuntimeInfo;
  readonly sessions: SessionManager;
  readonly publisher: EventPublisher;
  readonly webhooks: WebhooksRepo;
  readonly webhookDispatcher: WebhookDispatcher;
  readonly readModel: ReadModelStore;

  constructor(
    private readonly config: AppConfig,
    private readonly eventsRepo: EventsRepo,
    webhooksRepo: WebhooksRepo,
    webhookDeliveriesRepo: WebhookDeliveriesRepo,
    private readonly eventBus: EventBus,
    logger: Logger,
    sessionsRepo: SessionsRepo,
    readModel: ReadModelStore,
    private readonly mediaFetcher: MediaFetcher = createMediaFetcher(
      DEFAULT_TIMEOUTS.mediaTimeoutMs
    )
  ) {
    this.runtimeInfo = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: config.host,
      port: config.port,
      version: pkg.version
    };

    this.publisher = new EventPublisher(eventsRepo, eventBus, logger);
    this.readModel = readModel;
    this.sessions = new SessionManager(config, sessionsRepo, this.publisher, logger, readModel);
    this.webhooks = webhooksRepo;
    this.webhookDispatcher = new WebhookDispatcher(
      webhooksRepo,
      webhookDeliveriesRepo,
      this.publisher,
      logger
    );
  }

  async bootstrap(): Promise<void> {
    this.writeRuntimeFile();
    this.webhookDispatcher.start(this.eventBus);
    this.publisher.create("daemon.started", null, {
      pid: this.runtimeInfo.pid,
      endpoint: this.endpoint
    });
    if (!this.readModel.hasMessages()) {
      this.readModel.replayEvents(this.eventsRepo.forReadModelHydration());
    }
    await this.sessions.restoreActiveSessions();
  }

  async shutdown(): Promise<void> {
    this.webhookDispatcher.stop();

    if (existsSync(this.config.paths.runtimePath)) {
      rmSync(this.config.paths.runtimePath, { force: true });
    }
  }

  get endpoint(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  get bus(): EventBus {
    return this.eventBus;
  }

  getStatus(): StatusResponse {
    return {
      daemon: this.runtimeInfo,
      sessions: this.sessions.listSessions(),
      eventCount: this.eventsRepo.count(),
      webhookCount: this.webhooks.count()
    };
  }

  listWebhooks(sessionId?: string): WebhookRecord[] {
    return this.webhooks.list(sessionId);
  }

  addWebhook(input: CreateWebhookRequest): WebhookRecord {
    this.sessions.requireSession(input.sessionId);

    return this.webhooks.create({
      sessionId: input.sessionId,
      url: input.url,
      timeoutMs: input.timeoutMs ?? 5000,
      maxAttempts: input.maxAttempts ?? 3,
      ...(input.events ? { events: input.events } : {})
    });
  }

  setWebhookEvents(id: string, events: readonly string[]): WebhookRecord {
    return this.webhooks.setEvents(id, events);
  }

  enableWebhookEvent(id: string, event: string): WebhookRecord {
    return this.webhooks.enableEvent(id, event);
  }

  disableWebhookEvent(id: string, event: string): WebhookRecord {
    return this.webhooks.disableEvent(id, event);
  }

  setWebhookEnabled(id: string, enabled: boolean): WebhookRecord {
    return this.webhooks.setEnabled(id, enabled);
  }

  removeWebhook(id: string): void {
    const deleted = this.webhooks.delete(id);
    if (!deleted) {
      throw new AppError("WEBHOOK_NOT_FOUND", 404, `Webhook '${id}' nao encontrado.`);
    }
  }

  listWebhookDeliveries(sessionId?: string) {
    return this.webhookDispatcher.listDeliveries(sessionId);
  }

  listChats(sessionId: string, limit = 50): ChatRecord[] {
    this.sessions.requireSession(sessionId);
    return this.readModel.listChats(sessionId, limit);
  }

  listContacts(sessionId: string, limit = 100): ContactRecord[] {
    this.sessions.requireSession(sessionId);
    return this.readModel.listContacts(sessionId, limit);
  }

  listMessages(sessionId: string, chat: string, limit = 50): MessageRecord[] {
    this.sessions.requireSession(sessionId);
    return this.readModel.listMessages(sessionId, chat, limit);
  }

  /**
   * Envio de midia: delega a sessao gerenciada, que aplica a mesma disciplina
   * do send-texto (checagem de conexao, resolucao de JID, evento e read model).
   */
  sendMedia(
    sessionId: string,
    media: SendMediaRequest,
    buffer: Uint8Array
  ): Promise<SendMediaResponse> {
    return this.sessions.sendMediaMessage(sessionId, media, buffer);
  }

  /**
   * Download de midia (read-only, nao transmite nada ao WhatsApp): resolve a
   * mensagem no read model por chat+messageId, recupera o payload bruto
   * guardado pelos eventos ao vivo e delega a classificacao e o fetch ao
   * pipeline de midia.
   */
  async downloadMedia(
    sessionId: string,
    chat: string,
    messageId: string
  ): Promise<{ record: MessageRecord; download: IncomingMediaDownload }> {
    this.sessions.requireSession(sessionId);

    const record = this.readModel.findMessage(sessionId, chat, messageId);
    if (!record) {
      throw messageNotFoundError(chat, messageId);
    }

    const event = this.eventsRepo.findMessageRawPayload(sessionId, messageId);
    const raw = (event?.raw ?? null) as unknown as WAMessage | null;

    const download = await downloadIncomingMedia({
      record,
      raw,
      fetchMedia: this.mediaFetcher
    });

    return { record, download };
  }

  assertDaemonCanStart(): void {
    if (existsSync(this.config.paths.runtimePath)) {
      throw new AppError(
        "DAEMON_RUNTIME_FILE_EXISTS",
        409,
        "Runtime anterior ainda esta registrado. Rode `wa status` para validar e remova o runtime stale se necessario."
      );
    }
  }

  private writeRuntimeFile(): void {
    writeFileSync(
      this.config.paths.runtimePath,
      `${JSON.stringify(
        {
          pid: this.runtimeInfo.pid,
          startedAt: this.runtimeInfo.startedAt,
          host: this.runtimeInfo.host,
          port: this.runtimeInfo.port,
          version: this.runtimeInfo.version,
          executable: process.execPath
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}
