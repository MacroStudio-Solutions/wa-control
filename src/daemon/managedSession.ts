import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import makeWASocket, {
  type BaileysEventMap,
  Browsers,
  DisconnectReason,
  jidNormalizedUser,
  useMultiFileAuthState,
  type ConnectionState,
  type WASocket
} from "@whiskeysockets/baileys";
import pino from "pino";
import { normalizeIncomingMessage } from "../baileys/normalizeMessage.ts";
import { ReadModelStore } from "../read-model/store.ts";
import { renderQrTerminal } from "../baileys/qr.ts";
import { AppError } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type {
  AppConfig,
  SendMessageResponse,
  SessionRecord,
  SessionStatus
} from "../shared/types.ts";
import { nowIso, nowUnix } from "../shared/utils.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import { EventPublisher } from "./eventPublisher.ts";

interface ConnectResult {
  session: SessionRecord;
  note?: string;
  qr?: string;
  qrTerminal?: string;
}

function extractPhoneNumberFromJid(jid: string | undefined): string | null {
  if (!jid) {
    return null;
  }

  const [user] = jidNormalizedUser(jid).split("@");
  return user ?? null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Erro desconhecido";
}

function extractStatusCode(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error &&
    "output" in error &&
    typeof error.output === "object" &&
    error.output &&
    "statusCode" in error.output &&
    typeof error.output.statusCode === "number"
  ) {
    return error.output.statusCode;
  }

  return null;
}

function shouldReconnect(statusCode: number | null): boolean {
  return ![
    DisconnectReason.loggedOut,
    DisconnectReason.badSession,
    DisconnectReason.connectionReplaced,
    DisconnectReason.multideviceMismatch
  ].includes(statusCode ?? -1);
}

function reconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);
}

function normalizeDestinationForLookup(input: string): string {
  return input.replace(/\D/g, "");
}

export class ManagedSession {
  private socket: WASocket | null = null;
  private startPromise: Promise<void> | null = null;
  private reconnectTimer: Timer | null = null;
  private manualDisconnect = false;
  private qrTerminal: string | null = null;
  private readonly waiters = new Set<(result: ConnectResult) => void>();

  constructor(
    private readonly config: AppConfig,
    private readonly sessionsRepo: SessionsRepo,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
    private readonly readModel: ReadModelStore,
    private session: SessionRecord
  ) {}

  get current(): SessionRecord {
    return this.session;
  }

  async connect(waitMs = 15_000): Promise<ConnectResult> {
    this.publisher.create("session.connect_requested", this.session.id, {
      status: this.session.status
    });

    if (this.session.status === "connected" && this.socket) {
      return {
        session: this.session,
        note: "Sessao ja esta conectada."
      };
    }

    this.manualDisconnect = false;
    this.clearReconnectTimer();

    await this.persist({
      active: true,
      lastError: null
    });

    void this.ensureSocket().catch((error) => {
      void this.handleStartFailure(error);
    });

    if (this.session.status === "awaiting_qr" && this.session.qr) {
      return {
        session: this.session,
        note: "Escaneie o QR Code no WhatsApp.",
        qr: this.session.qr,
        qrTerminal: this.qrTerminal ?? (await renderQrTerminal(this.session.qr))
      };
    }

    return this.waitForResult(waitMs);
  }

  async restore(): Promise<void> {
    if (!this.session.active) {
      return;
    }

    this.manualDisconnect = false;
    try {
      await this.ensureSocket();
    } catch (error) {
      await this.handleStartFailure(error);
    }
  }

  async disconnect(): Promise<SessionRecord> {
    this.manualDisconnect = true;
    this.clearReconnectTimer();

    const sock = this.socket;
    this.socket = null;

    await this.persist({
      status: "disconnected",
      active: false,
      lastError: null,
      qr: null
    });

    if (sock) {
      try {
        await sock.end(undefined);
      } catch (error) {
        this.logger.warn("falha ao encerrar sessao", {
          sessionId: this.session.id,
          error: errorMessage(error)
        });
      }
    }

    this.publisher.create("session.disconnected", this.session.id, {
      reason: "manual",
      reconnecting: false
    });

    this.resolveWaiters({
      session: this.session,
      note: "Sessao desconectada."
    });

    return this.session;
  }

  async remove(): Promise<void> {
    await this.disconnect();
    rmSync(join(this.config.paths.sessionsDir, this.session.id), {
      recursive: true,
      force: true
    });
  }

  async sendTextMessage(to: string, text: string): Promise<SendMessageResponse> {
    if (!this.socket || this.session.status !== "connected") {
      throw new AppError(
        "SESSION_NOT_CONNECTED",
        409,
        `Sessao '${this.session.id}' nao esta conectada.`
      );
    }

    const jid = await this.resolveRecipientJid(to);

    try {
      const sent = await this.socket.sendMessage(jid, { text });
      const response: SendMessageResponse = {
        ok: true,
        sessionId: this.session.id,
        to,
        jid,
        text,
        messageId: sent?.key.id ?? null,
        timestamp: nowUnix()
      };

      this.publisher.create("message.sent", this.session.id, {
        messageId: response.messageId,
        chatId: jid,
        to: jid,
        text
      });
      this.readModel.recordSentTextMessage(
        this.session.id,
        jid,
        text,
        response.messageId,
        response.timestamp
      );

      return response;
    } catch (error) {
      this.publisher.create("message.error", this.session.id, {
        to,
        text,
        error: errorMessage(error)
      });

      throw new AppError(
        "MESSAGE_SEND_FAILED",
        502,
        `Falha ao enviar mensagem: ${errorMessage(error)}`
      );
    }
  }

  private async ensureSocket(): Promise<void> {
    if (this.socket || this.startPromise) {
      return this.startPromise ?? Promise.resolve();
    }

    this.startPromise = this.startSocket().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  private async startSocket(): Promise<void> {
    const authDir = this.getAuthDir();
    mkdirSync(authDir, { recursive: true });

    await this.persist({
      status: this.session.reconnectAttempts > 0 ? "reconnecting" : "connecting",
      active: true,
      lastError: null
    });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu("wa-control"),
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    this.socket = sock;
    this.readModel.bindSocket(this.session.id, sock);

    sock.ev.on("creds.update", () => {
      void saveCreds();
    });

    sock.ev.on("connection.update", (update) => {
      void this.handleConnectionUpdate(update);
    });

    sock.ev.on("messages.upsert", (upsert) => {
      void this.handleMessagesUpsert(upsert);
    });
  }

  private async handleMessagesUpsert(upsert: BaileysEventMap["messages.upsert"]): Promise<void> {
    if (upsert.type !== "notify") {
      return;
    }

    for (const message of upsert.messages) {
      const normalized = normalizeIncomingMessage(this.session.id, message, true);
      if (!normalized) {
        continue;
      }

      this.publisher.publish(normalized);
    }
  }

  private async handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const statusCode = extractStatusCode(update.lastDisconnect?.error);
    const disconnectMessage = errorMessage(update.lastDisconnect?.error);

    this.publisher.create("connection.update", this.session.id, {
      connection: update.connection ?? this.session.status,
      qrAvailable: Boolean(update.qr),
      reason: statusCode,
      error: update.lastDisconnect?.error ? disconnectMessage : null
    });

    if (update.qr) {
      this.qrTerminal = await renderQrTerminal(update.qr);

      await this.persist({
        status: "awaiting_qr",
        active: true,
        lastError: null,
        qr: update.qr
      });

      this.publisher.create("session.qr", this.session.id, {
        qr: update.qr,
        qrTerminal: this.qrTerminal
      });

      this.resolveWaiters({
        session: this.session,
        note: "Escaneie o QR Code no WhatsApp.",
        qr: update.qr,
        qrTerminal: this.qrTerminal
      });
    }

    if (update.connection === "open") {
      const phoneNumber = extractPhoneNumberFromJid(this.socket?.user?.id);

      await this.persist({
        status: "connected",
        active: true,
        lastError: null,
        qr: null,
        phoneNumber,
        lastConnectedAt: nowIso(),
        reconnectAttempts: 0
      });

      this.publisher.create("session.connected", this.session.id, {
        phoneNumber
      });

      this.resolveWaiters({
        session: this.session,
        note: "Sessao conectada."
      });
      return;
    }

    if (update.connection !== "close") {
      return;
    }

    const reconnecting =
      !this.manualDisconnect &&
      this.session.active &&
      shouldReconnect(statusCode);

    this.socket = null;
    this.qrTerminal = null;

    if (this.manualDisconnect) {
      this.manualDisconnect = false;
      return;
    }

    if (reconnecting) {
      const attempts = this.session.reconnectAttempts + 1;
      const delay = reconnectDelay(attempts);

      await this.persist({
        status: "reconnecting",
        active: true,
        lastError: disconnectMessage,
        qr: null,
        reconnectAttempts: attempts
      });

      this.publisher.create("session.disconnected", this.session.id, {
        reason: statusCode,
        reconnecting: true,
        reconnectInMs: delay,
        error: disconnectMessage
      });

      this.scheduleReconnect(delay);
      return;
    }

    if (
      statusCode === DisconnectReason.loggedOut ||
      statusCode === DisconnectReason.badSession ||
      statusCode === DisconnectReason.multideviceMismatch
    ) {
      rmSync(this.getAuthDir(), { recursive: true, force: true });
    }

    await this.persist({
      status: statusCode === DisconnectReason.connectionReplaced ? "error" : "disconnected",
      active: false,
      lastError: disconnectMessage,
      qr: null
    });

    this.publisher.create("session.disconnected", this.session.id, {
      reason: statusCode,
      reconnecting: false,
      error: disconnectMessage
    });

    this.resolveWaiters({
      session: this.session,
      note: "Sessao encerrada antes de concluir a conexao."
    });
  }

  private async resolveRecipientJid(input: string): Promise<string> {
    if (!this.socket) {
      throw new AppError("SESSION_NOT_CONNECTED", 409, "Sessao nao conectada.");
    }

    if (input.includes("@")) {
      return jidNormalizedUser(input);
    }

    const normalized = normalizeDestinationForLookup(input);
    if (normalized.length < 8) {
      throw new AppError("INVALID_DESTINATION", 400, "Destino invalido.");
    }

    const lookup = await this.socket.onWhatsApp(normalized);
    const match = lookup?.find((entry) => entry.exists);

    if (!match?.jid) {
      throw new AppError(
        "DESTINATION_NOT_FOUND",
        404,
        `Numero '${input}' nao existe no WhatsApp.`
      );
    }

    return match.jid;
  }

  private async persist(patch: Partial<SessionRecord>): Promise<SessionRecord> {
    this.session = this.sessionsRepo.save({
      ...this.session,
      ...patch,
      updatedAt: nowIso()
    });

    return this.session;
  }

  private getAuthDir(): string {
    return join(this.config.paths.sessionsDir, this.session.id, "auth");
  }

  private scheduleReconnect(delay: number): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      void this.ensureSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async handleStartFailure(error: unknown): Promise<void> {
    this.socket = null;
    this.qrTerminal = null;

    const message = errorMessage(error);
    await this.persist({
      status: "error",
      active: false,
      lastError: message,
      qr: null
    });

    this.publisher.create("session.disconnected", this.session.id, {
      reconnecting: false,
      error: message
    });

    this.resolveWaiters({
      session: this.session,
      note: `Falha ao iniciar a sessao: ${message}`
    });
  }

  private async waitForResult(waitMs: number): Promise<ConnectResult> {
    if (this.session.status === "connected") {
      return {
        session: this.session,
        note: "Sessao conectada."
      };
    }

    if (this.session.status === "awaiting_qr" && this.session.qr) {
      return {
        session: this.session,
        note: "Escaneie o QR Code no WhatsApp.",
        qr: this.session.qr,
        qrTerminal: this.qrTerminal ?? (await renderQrTerminal(this.session.qr))
      };
    }

    return new Promise((resolve) => {
      const waiter = (result: ConnectResult) => {
        clearTimeout(timeout);
        this.waiters.delete(waiter);
        resolve(result);
      };

      const timeout = setTimeout(() => {
        this.waiters.delete(waiter);
        void this.currentResult("Aguardando QR Code ou restauracao da sessao.").then(resolve);
      }, waitMs);

      this.waiters.add(waiter);
    });
  }

  private async currentResult(note: string): Promise<ConnectResult> {
    const qr = this.session.qr;
    const qrTerminal = qr
      ? this.qrTerminal ?? (await renderQrTerminal(qr))
      : undefined;

    return {
      session: this.session,
      note,
      ...(qr ? { qr, ...(qrTerminal ? { qrTerminal } : {}) } : {})
    };
  }

  private resolveWaiters(result: ConnectResult): void {
    for (const waiter of this.waiters) {
      waiter(result);
    }

    this.waiters.clear();
  }
}
