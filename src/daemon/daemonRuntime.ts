import { existsSync, rmSync, writeFileSync } from "node:fs";
import { AppError } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type {
  AppConfig,
  ChatRecord,
  ContactRecord,
  CreateWebhookRequest,
  DaemonRuntimeInfo,
  MessageRecord,
  StatusResponse,
  WebhookRecord
} from "../shared/types.ts";
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
    readModel: ReadModelStore
  ) {
    this.runtimeInfo = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: config.host,
      port: config.port,
      version: "0.2.0"
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
      maxAttempts: input.maxAttempts ?? 3
    });
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
          port: this.runtimeInfo.port
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}
