import { rmSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type {
  AppConfig,
  SendMessageResponse,
  SessionQrResponse,
  SessionRecord
} from "../shared/types.ts";
import { dataUrlToBase64, renderQrDataUrl, renderQrTerminal } from "../baileys/qr.ts";
import { nowIso } from "../shared/utils.ts";
import { ReadModelStore } from "../read-model/store.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import { EventPublisher } from "./eventPublisher.ts";
import { ManagedSession } from "./managedSession.ts";

const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{1,62}$/i;

export class SessionManager {
  private readonly controllers = new Map<string, ManagedSession>();

  constructor(
    private readonly config: AppConfig,
    private readonly sessionsRepo: SessionsRepo,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
    private readonly readModel: ReadModelStore
  ) {}

  listSessions(): SessionRecord[] {
    return this.sessionsRepo.list();
  }

  requireSession(sessionId: string): SessionRecord {
    const normalizedSessionId = this.assertSessionId(sessionId);
    const session = this.sessionsRepo.get(normalizedSessionId);

    if (!session) {
      throw new AppError("SESSION_NOT_FOUND", 404, `Sessao '${normalizedSessionId}' nao encontrada.`);
    }

    return session;
  }

  async restoreActiveSessions(): Promise<void> {
    for (const session of this.sessionsRepo.listActive()) {
      const controller = this.getControllerFromRecord(session);
      try {
        await controller.restore();
      } catch (error) {
        this.logger.error("falha ao restaurar sessao ativa", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : "Unexpected error"
        });
      }
    }
  }

  async connect(sessionId: string) {
    const controller = this.getOrCreateController(sessionId);
    return controller.connect();
  }

  async disconnect(sessionId: string): Promise<SessionRecord> {
    const controller = this.getExistingController(sessionId);
    return controller.disconnect();
  }

  /**
   * Leitura pura do QR corrente. Nao abre socket nem muda estado, entao pode ser
   * consultada em intervalo curto enquanto alguem espera para escanear.
   */
  async readQr(sessionId: string): Promise<SessionQrResponse> {
    const session = this.requireSession(sessionId);

    if (!session.qr) {
      throw new AppError(
        "QR_NOT_AVAILABLE",
        409,
        `Sessao '${session.id}' nao tem QR disponivel agora (status '${session.status}'). Use \`wa connect ${session.id}\` para solicitar um.`
      );
    }

    const [ascii, dataUrl] = await Promise.all([
      renderQrTerminal(session.qr),
      renderQrDataUrl(session.qr)
    ]);

    return {
      sessionId: session.id,
      status: session.status,
      qr: session.qr,
      ascii,
      base64: dataUrlToBase64(dataUrl),
      dataUrl
    };
  }

  async remove(sessionId: string): Promise<void> {
    const controller = this.getExistingController(sessionId);
    await controller.remove();

    const deleted = this.sessionsRepo.delete(controller.current.id);
    if (!deleted) {
      throw new AppError("SESSION_NOT_FOUND", 404, `Sessao '${controller.current.id}' nao encontrada.`);
    }

    this.controllers.delete(controller.current.id);
    this.readModel.deleteSession(controller.current.id);
    rmSync(join(this.config.paths.sessionsDir, controller.current.id), {
      recursive: true,
      force: true
    });

    this.publisher.create("session.removed", controller.current.id, {});
  }

  async sendTextMessage(sessionId: string, to: string, text: string): Promise<SendMessageResponse> {
    const controller = this.getExistingController(sessionId);
    return controller.sendTextMessage(to, text);
  }

  private getOrCreateController(sessionId: string): ManagedSession {
    const normalizedSessionId = this.assertSessionId(sessionId);
    const existingController = this.controllers.get(normalizedSessionId);
    if (existingController) {
      return existingController;
    }

    const record =
      this.sessionsRepo.get(normalizedSessionId) ??
      this.sessionsRepo.save({
        id: normalizedSessionId,
        status: "disconnected",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        phoneNumber: null,
        lastError: null,
        active: false,
        lastConnectedAt: null,
        reconnectAttempts: 0,
        qr: null
      });

    return this.getControllerFromRecord(record);
  }

  private getExistingController(sessionId: string): ManagedSession {
    const record = this.requireSession(sessionId);
    return this.getControllerFromRecord(record);
  }

  private getControllerFromRecord(record: SessionRecord): ManagedSession {
    const existing = this.controllers.get(record.id);
    if (existing) {
      return existing;
    }

    const controller = new ManagedSession(
      this.config,
      this.sessionsRepo,
      this.publisher,
      this.logger,
      this.readModel,
      record
    );

    this.controllers.set(record.id, controller);
    return controller;
  }

  private assertSessionId(sessionId: string): string {
    const trimmed = sessionId.trim();

    if (!SESSION_ID_PATTERN.test(trimmed)) {
      throw new AppError(
        "INVALID_SESSION_ID",
        400,
        "Session ID invalido. Use apenas letras, numeros, hifen e underscore."
      );
    }

    return trimmed;
  }
}
