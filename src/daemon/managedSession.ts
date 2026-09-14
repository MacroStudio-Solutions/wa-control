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
import {
  extractContactLidPairs,
  extractMessageLidPairs,
  rememberLidPairs
} from "../baileys/lidDirectory.ts";
import { normalizeIncomingMessage } from "../baileys/normalizeMessage.ts";
import { buildMediaMessageContent } from "../media/mediaContent.ts";
import { messageNotFoundError } from "../media/mediaTypes.ts";
import type { MediaDescriptor } from "../media/mediaTypes.ts";
import { ReadModelStore } from "../read-model/store.ts";
import { renderQrTerminal } from "../baileys/qr.ts";
import { resolveWaWebVersion } from "../baileys/waVersion.ts";
import { AppError } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type {
  AppConfig,
  DeleteMessageResponse,
  GroupCreateResponse,
  GroupInfoResponse,
  GroupLeaveResponse,
  GroupParticipantAction,
  GroupParticipantsResponse,
  PollResponse,
  ReactResponse,
  ReadResponse,
  SendMediaRequest,
  SendMediaResponse,
  SendMessageResponse,
  SessionRecord,
  SessionStatus,
  TypingResponse
} from "../shared/types.ts";
import { nowIso, nowUnix } from "../shared/utils.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import {
  assertPollOptions,
  buildMessageKeyFromRecord,
  mapChatOpError
} from "./chatOps.ts";
import {
  assertGroupJid,
  assertGroupSubject,
  mapGroupOpError,
  normalizeParticipantInputs,
  participantRejectionMessage,
  serializeGroupSnapshot,
  summarizeParticipantUpdate,
  toBaileysParticipantAction
} from "./groupOps.ts";
import { EventPublisher } from "./eventPublisher.ts";

const CHAT_WITHOUT_LOCAL_HISTORY_NOTE =
  "Aviso: o chat nao tem conversa projetada localmente; o WhatsApp pode descartar o indicador em silencio.";

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

  /**
   * Envio de midia: reusa o caminho do send-texto (mesma checagem de sessao,
   * mesma resolucao de JID, mesmo evento `message.sent`) e monta o conteudo do
   * Baileys pelo pipeline de midia — caption em imagem e video, fileName no
   * documento, --ptt decide voice note, tipo fora da tabela e recusado antes
   * de qualquer transmissao.
   */
  async sendMediaMessage(media: SendMediaRequest, buffer: Uint8Array): Promise<SendMediaResponse> {
    if (!this.socket || this.session.status !== "connected") {
      throw new AppError(
        "SESSION_NOT_CONNECTED",
        409,
        `Sessao '${this.session.id}' nao esta conectada.`
      );
    }

    const jid = await this.resolveRecipientJid(media.to);
    const descriptor: MediaDescriptor = {
      kind: media.kind,
      mimeType: media.mimeType,
      payload: { kind: "buffer", buffer }
    };
    const content = buildMediaMessageContent(descriptor, {
      ...(media.caption ? { caption: media.caption } : {}),
      ...(media.fileName ? { fileName: media.fileName } : {}),
      ...(media.ptt ? { ptt: true } : {})
    });

    try {
      const sent = await this.socket.sendMessage(jid, content);
      const response: SendMediaResponse = {
        ok: true,
        sessionId: this.session.id,
        to: media.to,
        jid,
        kind: media.kind,
        mimeType: media.mimeType,
        caption: media.caption ?? null,
        fileName: media.fileName ?? null,
        ptt: media.ptt === true,
        size: buffer.byteLength,
        messageId: sent?.key.id ?? null,
        timestamp: nowUnix()
      };

      this.publisher.create("message.sent", this.session.id, {
        messageId: response.messageId,
        chatId: jid,
        to: jid,
        kind: media.kind,
        mimeType: media.mimeType,
        ...(media.caption ? { text: media.caption } : {}),
        ...(media.fileName ? { fileName: media.fileName } : {}),
        ptt: response.ptt
      });
      this.readModel.recordSentMediaMessage(
        this.session.id,
        jid,
        media.kind,
        media.caption ?? null,
        response.messageId,
        response.timestamp
      );

      return response;
    } catch (error) {
      this.publisher.create("message.error", this.session.id, {
        to: media.to,
        kind: media.kind,
        error: errorMessage(error)
      });

      throw new AppError(
        "MESSAGE_SEND_FAILED",
        502,
        `Falha ao enviar midia: ${errorMessage(error)}`
      );
    }
  }

  /**
   * Indicador de digitacao (composing) ou gravacao de audio (recording),
   * one-shot: o WhatsApp nao confirma presenca, entao a honestidade vem da
   * resolucao do destino (numero inexistente falha aqui) e do aviso explicito
   * quando o chat nao tem conversa projetada localmente.
   */
  async sendTypingIndicator(chat: string, recording: boolean): Promise<TypingResponse> {
    if (!this.socket || this.session.status !== "connected") {
      throw new AppError(
        "SESSION_NOT_CONNECTED",
        409,
        `Sessao '${this.session.id}' nao esta conectada.`
      );
    }

    const jid = await this.resolveRecipientJid(chat);

    try {
      await this.socket.sendPresenceUpdate(recording ? "recording" : "composing", jid);
    } catch (error) {
      throw mapChatOpError("typing", error, { chat, jid, recording });
    }

    const hasLocalHistory = this.readModel.listMessages(this.session.id, chat, 1).length > 0;

    return {
      ok: true,
      sessionId: this.session.id,
      chat,
      jid,
      recording,
      ...(hasLocalHistory ? {} : { note: CHAT_WITHOUT_LOCAL_HISTORY_NOTE })
    };
  }

  /**
   * Marcar como lida: sem messageId usa a mensagem mais recente projetada do
   * chat (se nenhuma existe, erro explicito — nunca sucesso mentiroso); com
   * messageId, a chave vem do registro local (fromMe/participant corretos).
   */
  async markMessagesRead(chat: string, messageId?: string): Promise<ReadResponse> {
    if (!this.socket || this.session.status !== "connected") {
      throw new AppError(
        "SESSION_NOT_CONNECTED",
        409,
        `Sessao '${this.session.id}' nao esta conectada.`
      );
    }

    const jid = await this.resolveRecipientJid(chat);
    const sessionId = this.session.id;

    let resolvedId: string;
    let key;
    if (messageId) {
      const record = this.readModel.findMessage(sessionId, chat, messageId);
      if (!record) {
        throw messageNotFoundError(chat, messageId);
      }
      key = buildMessageKeyFromRecord(record);
      resolvedId = record.id;
    } else {
      const latest = this.readModel.listMessages(sessionId, chat, 1)[0];
      if (!latest) {
        throw new AppError(
          "READ_NO_RECENT_MESSAGE",
          404,
          `Nenhuma mensagem recente no chat '${chat}' para marcar como lida.`
        );
      }
      key = buildMessageKeyFromRecord(latest);
      resolvedId = latest.id;
    }

    try {
      await this.socket.readMessages([key]);
    } catch (error) {
      throw mapChatOpError("read", error, { chat, jid, messageId: resolvedId });
    }

    return {
      ok: true,
      sessionId,
      chat,
      jid,
      messageIds: [resolvedId]
    };
  }

  /**
   * Reacao a mensagem: a chave vem do registro projetado (mesma referencia que
   * `messages` e o webhook entregam). Emoji vazio remove a reacao — contrato
   * da Baileys, documentado no help da CLI.
   */
  async reactToMessage(chat: string, messageId: string, emoji: string): Promise<ReactResponse> {
    if (!this.socket || this.session.status !== "connected") {
      throw new AppError(
        "SESSION_NOT_CONNECTED",
        409,
        `Sessao '${this.session.id}' nao esta conectada.`
      );
    }

    await this.resolveRecipientJid(chat);
    const record = this.readModel.findMessage(this.session.id, chat, messageId);
    if (!record) {
      throw messageNotFoundError(chat, messageId);
    }

    try {
      await this.socket.sendMessage(record.chatJid, {
        react: { key: buildMessageKeyFromRecord(record), text: emoji }
      });
    } catch (error) {
      throw mapChatOpError("react", error, { chat, messageId, emoji });
    }

    return {
      ok: true,
      sessionId: this.session.id,
      chat,
      jid: record.chatJid,
      messageId,
      emoji,
      removed: emoji === ""
    };
  }

  /**
   * Apagar mensagem: `{ delete }` da Baileys — revoke para todos quando
   * propria, delete para o eu mesmo em mensagem de terceiro (admin no grupo).
   * Recusa do WhatsApp propaga como erro classificado, nunca como sucesso.
   */
  async deleteMessage(chat: string, messageId: string): Promise<DeleteMessageResponse> {
    if (!this.socket || this.session.status !== "connected") {
      throw new AppError(
        "SESSION_NOT_CONNECTED",
        409,
        `Sessao '${this.session.id}' nao esta conectada.`
      );
    }

    await this.resolveRecipientJid(chat);
    const record = this.readModel.findMessage(this.session.id, chat, messageId);
    if (!record) {
      throw messageNotFoundError(chat, messageId);
    }

    try {
      await this.socket.sendMessage(record.chatJid, {
        delete: buildMessageKeyFromRecord(record)
      });
    } catch (error) {
      throw mapChatOpError("delete", error, { chat, messageId });
    }

    return {
      ok: true,
      sessionId: this.session.id,
      chat,
      jid: record.chatJid,
      messageId,
      fromMe: record.fromMe
    };
  }

  /**
   * Enquete (envio apenas — leitura de votos fora de escopo): opcoes
   * validadas localmente ANTES de qualquer rede; selectableCount fica
   * indefinido e a Baileys aplica 0 (escolha unica).
   */
  async sendPollMessage(chat: string, question: string, options: string[]): Promise<PollResponse> {
    if (!this.socket || this.session.status !== "connected") {
      throw new AppError(
        "SESSION_NOT_CONNECTED",
        409,
        `Sessao '${this.session.id}' nao esta conectada.`
      );
    }

    assertPollOptions(options);
    const jid = await this.resolveRecipientJid(chat);
    const timestamp = nowUnix();

    try {
      const sent = await this.socket.sendMessage(jid, {
        poll: { name: question, values: options }
      });
      const messageId = sent?.key.id ?? null;

      this.publisher.create("message.sent", this.session.id, {
        messageId,
        chatId: jid,
        to: jid,
        kind: "poll",
        text: question
      });
      this.readModel.recordSentMediaMessage(
        this.session.id,
        jid,
        "poll",
        question,
        messageId,
        timestamp
      );

      return {
        ok: true,
        sessionId: this.session.id,
        chat,
        jid,
        question,
        options,
        messageId,
        timestamp
      };
    } catch (error) {
      this.publisher.create("message.error", this.session.id, {
        to: chat,
        kind: "poll",
        error: errorMessage(error)
      });

      throw mapChatOpError("poll", error, { chat, jid });
    }
  }

  /**
   * Criar grupo: assunto validado e participantes normalizados localmente
   * ANTES do socket; o criador entra como dono e superadmin automaticamente.
   */
  async createGroup(subject: string, participants: string[]): Promise<GroupCreateResponse> {
    if (!this.socket || this.session.status !== "connected") {
      throw new AppError(
        "SESSION_NOT_CONNECTED",
        409,
        `Sessao '${this.session.id}' nao esta conectada.`
      );
    }

    assertGroupSubject(subject);
    const jids = normalizeParticipantInputs(participants);

    try {
      const metadata = await this.socket.groupCreate(subject.trim(), jids);
      return serializeGroupSnapshot(this.session.id, metadata);
    } catch (error) {
      throw mapGroupOpError("create", error, { subject });
    }
  }

  /**
   * Metadados completos de um grupo (leitura via socket): JID invalido falha
   * localmente; grupo inexistente ou sessao fora do grupo falha com classe
   * mapeada (GROUP_NOT_FOUND / GROUP_NOT_ALLOWED), nunca silencio.
   */
  async groupInfo(groupJid: string): Promise<GroupInfoResponse> {
    if (!this.socket || this.session.status !== "connected") {
      throw new AppError(
        "SESSION_NOT_CONNECTED",
        409,
        `Sessao '${this.session.id}' nao esta conectada.`
      );
    }

    assertGroupJid(groupJid);

    try {
      const metadata = await this.socket.groupMetadata(groupJid);
      return serializeGroupSnapshot(this.session.id, metadata);
    } catch (error) {
      throw mapGroupOpError("info", error, { groupJid });
    }
  }

  /**
   * add/remove/promote/demote: o WhatsApp responde por participante; sucesso
   * so quando TODOS entram com status 200. Recusa de qualquer participante
   * sai como GROUP_PARTICIPANT_REJECTED com o motivo acionavel de cada um.
   */
  async updateGroupParticipants(
    groupJid: string,
    action: GroupParticipantAction,
    participants: string[]
  ): Promise<GroupParticipantsResponse> {
    if (!this.socket || this.session.status !== "connected") {
      throw new AppError(
        "SESSION_NOT_CONNECTED",
        409,
        `Sessao '${this.session.id}' nao esta conectada.`
      );
    }

    assertGroupJid(groupJid);
    const jids = normalizeParticipantInputs(participants);

    try {
      const results = await this.socket.groupParticipantsUpdate(
        groupJid,
        jids,
        toBaileysParticipantAction(action)
      );
      const { updated, failures } = summarizeParticipantUpdate(action, results);

      if (failures.length > 0) {
        throw new AppError("GROUP_PARTICIPANT_REJECTED", 502, participantRejectionMessage(action, failures), {
          action,
          groupJid,
          failures
        });
      }

      return {
        ok: true,
        sessionId: this.session.id,
        jid: groupJid,
        action,
        updated
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw mapGroupOpError(action, error, { groupJid });
    }
  }

  /**
   * Sair do grupo: irreversivel do lado do bot (re-entrada exige convite de
   * admin), entao o JID e validado localmente e a recusa do WhatsApp propaga
   * classificada.
   */
  async leaveGroup(groupJid: string): Promise<GroupLeaveResponse> {
    if (!this.socket || this.session.status !== "connected") {
      throw new AppError(
        "SESSION_NOT_CONNECTED",
        409,
        `Sessao '${this.session.id}' nao esta conectada.`
      );
    }

    assertGroupJid(groupJid);

    try {
      await this.socket.groupLeave(groupJid);
      return {
        ok: true,
        sessionId: this.session.id,
        jid: groupJid
      };
    } catch (error) {
      throw mapGroupOpError("leave", error, { groupJid });
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
    // Sem versao explicita o Baileys anuncia a que foi congelada no release, e
    // o WhatsApp responde 405 assim que ela envelhece — sem QR, sem pareamento.
    const version = await resolveWaWebVersion(this.config, this.logger);
    const sock = makeWASocket({
      ...(version ? { version } : {}),
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
      void this.handleMessagesUpsert(sock, upsert);
    });

    sock.ev.on("contacts.upsert", (contacts = []) => {
      void this.rememberContacts(sock, contacts as unknown as Array<Record<string, unknown>>);
    });

    sock.ev.on("contacts.update", (contacts = []) => {
      void this.rememberContacts(sock, contacts as unknown as Array<Record<string, unknown>>);
    });
  }

  private async rememberContacts(
    sock: WASocket,
    contacts: Array<Record<string, unknown>>
  ): Promise<void> {
    for (const contact of contacts) {
      await rememberLidPairs(sock, extractContactLidPairs(contact), this.logger);
    }
  }

  private async handleMessagesUpsert(
    sock: WASocket,
    upsert: BaileysEventMap["messages.upsert"]
  ): Promise<void> {
    if (upsert.type !== "notify") {
      return;
    }

    const authDir = this.getAuthDir();

    for (const message of upsert.messages) {
      // Guardar antes de normalizar: o numero so vem no envelope desta mensagem,
      // e as proximas dela podem chegar sem ele.
      await rememberLidPairs(sock, extractMessageLidPairs(message), this.logger);

      const normalized = normalizeIncomingMessage(this.session.id, message, authDir, true);
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
