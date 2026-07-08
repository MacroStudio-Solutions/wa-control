import type { BaileysEventMap, WAMessage, WASocket } from "@whiskeysockets/baileys";
import type { AppConfig, ChatRecord, ContactRecord, MessageRecord, NormalizedEvent } from "../shared/types.ts";
import {
  buildQueryCandidates,
  classifyChatJid,
  isLidJid,
  projectAddress,
  type ProjectedAddress
} from "../shared/jids.ts";
import { nowIso, nowUnix } from "../shared/utils.ts";
import { ChatsRepo } from "../storage/chatsRepo.ts";
import { ContactsRepo } from "../storage/contactsRepo.ts";
import { MessagesRepo } from "../storage/messagesRepo.ts";

function extractMessageType(message: Record<string, unknown> | undefined): string {
  if (!message) {
    return "unknown";
  }

  for (const [key, value] of Object.entries(message)) {
    if (value) {
      return key;
    }
  }

  return "unknown";
}

function extractMessageText(message: Record<string, unknown> | undefined): string | null {
  if (!message) {
    return null;
  }

  if (typeof message.conversation === "string") {
    return message.conversation;
  }

  if (typeof message.extendedTextMessage === "object" && message.extendedTextMessage) {
    const candidate = (message.extendedTextMessage as Record<string, unknown>).text;
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  for (const key of [
    "imageMessage",
    "videoMessage",
    "documentMessage"
  ]) {
    const entry = message[key];
    if (typeof entry === "object" && entry) {
      const candidate = (entry as Record<string, unknown>).caption;
      if (typeof candidate === "string") {
        return candidate;
      }
    }
  }

  if (typeof message.buttonsResponseMessage === "object" && message.buttonsResponseMessage) {
    const candidate = (message.buttonsResponseMessage as Record<string, unknown>).selectedDisplayText;
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  if (typeof message.listResponseMessage === "object" && message.listResponseMessage) {
    const singleSelectReply = (message.listResponseMessage as Record<string, unknown>).singleSelectReply;
    if (typeof singleSelectReply === "object" && singleSelectReply) {
      const candidate = (singleSelectReply as Record<string, unknown>).selectedRowId;
      if (typeof candidate === "string") {
        return candidate;
      }
    }
  }

  if (typeof message.reactionMessage === "object" && message.reactionMessage) {
    const candidate = (message.reactionMessage as Record<string, unknown>).text;
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return null;
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (value && typeof value === "object" && "toNumber" in value) {
    const maybeToNumber = value.toNumber;
    if (typeof maybeToNumber === "function") {
      return maybeToNumber.call(value) as number;
    }
  }

  if (value && typeof value === "object" && "toString" in value) {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function bestChatName(chat: ChatRecord | null, message: MessageRecord): string | null {
  return chat?.name ?? message.pushName ?? null;
}

function canonicalChatId(rawChatId: string, address: ProjectedAddress): string {
  if (classifyChatJid(rawChatId) === "direct") {
    return address.lookupJid ?? address.jid ?? rawChatId;
  }

  return address.jid ?? rawChatId;
}

function canonicalEntityId(rawId: string, address: ProjectedAddress): string {
  return address.lookupJid ?? address.jid ?? rawId;
}

export class ReadModelStore {
  constructor(
    private readonly config: AppConfig,
    private readonly chatsRepo: ChatsRepo,
    private readonly contactsRepo: ContactsRepo,
    private readonly messagesRepo: MessagesRepo
  ) {}

  bindSocket(sessionId: string, sock: WASocket): void {
    sock.ev.on("messaging-history.set", ({ chats = [], contacts = [], messages = [] }) => {
      for (const chat of chats) {
        this.upsertChat(sessionId, chat as Record<string, unknown>);
      }

      for (const contact of contacts) {
        this.upsertContact(sessionId, contact as unknown as Record<string, unknown>);
      }

      for (const message of messages) {
        this.upsertSocketMessage(sessionId, message, "history");
      }
    });

    sock.ev.on("chats.upsert", (chats = []) => {
      for (const chat of chats) {
        this.upsertChat(sessionId, chat as Record<string, unknown>);
      }
    });

    sock.ev.on("chats.update", (updates = []) => {
      for (const update of updates) {
        this.upsertChat(sessionId, update as Record<string, unknown>);
      }
    });

    sock.ev.on("chats.delete", (chatIds = []) => {
      for (const chatId of chatIds) {
        if (typeof chatId !== "string") {
          continue;
        }

        this.messagesRepo.deleteChat(sessionId, chatId);
        this.chatsRepo.delete(sessionId, chatId);
      }
    });

    sock.ev.on("contacts.upsert", (contacts = []) => {
      for (const contact of contacts) {
        this.upsertContact(sessionId, contact as unknown as Record<string, unknown>);
      }
    });

    sock.ev.on("contacts.update", (contacts = []) => {
      for (const contact of contacts) {
        this.upsertContact(sessionId, contact as unknown as Record<string, unknown>);
      }
    });

    sock.ev.on("messages.upsert", (event) => {
      for (const message of event?.messages ?? []) {
        this.upsertSocketMessage(sessionId, message, event?.type ?? "notify");
      }
    });

    sock.ev.on("messages.update", (updates = []) => {
      this.applyMessageUpdates(sessionId, updates);
    });

    sock.ev.on("messages.delete", (event) => {
      this.applyMessageDeletes(sessionId, event);
    });
  }

  hasMessages(): boolean {
    return this.messagesRepo.count() > 0;
  }

  replayEvents(events: NormalizedEvent[]): void {
    for (const event of events) {
      if (!event.sessionId) {
        continue;
      }

      if (event.event === "message.sent") {
        const chatJid =
          typeof event.chatId === "string"
            ? event.chatId
            : typeof event.to === "string"
              ? event.to
              : null;

        if (!chatJid) {
          continue;
        }

        this.recordSentTextMessage(
          event.sessionId,
          chatJid,
          typeof event.text === "string" ? event.text : "",
          typeof event.messageId === "string" ? event.messageId : null,
          typeof event.timestamp === "number" ? event.timestamp : nowUnix()
        );
        continue;
      }

      if (event.event !== "message.received") {
        continue;
      }

      if (event.raw && typeof event.raw === "object") {
        this.upsertSocketMessage(event.sessionId, event.raw as unknown as WAMessage, "notify");
        continue;
      }

      this.upsertNormalizedIncomingEvent(event);
    }
  }

  listChats(sessionId: string, limit = 50): ChatRecord[] {
    return this.chatsRepo.list(sessionId, limit);
  }

  listContacts(sessionId: string, limit = 100): ContactRecord[] {
    return this.contactsRepo.list(sessionId, limit);
  }

  listMessages(sessionId: string, chat: string, limit = 50): MessageRecord[] {
    const query = buildQueryCandidates(this.getAuthDir(sessionId), chat);
    return this.messagesRepo.list(sessionId, query.exactJids, query.lookupKeys, limit);
  }

  deleteSession(sessionId: string): void {
    this.messagesRepo.deleteSession(sessionId);
    this.contactsRepo.deleteSession(sessionId);
    this.chatsRepo.deleteSession(sessionId);
  }

  recordSentTextMessage(
    sessionId: string,
    chatJid: string,
    text: string,
    messageId: string | null,
    unixSeconds: number
  ): void {
    const authDir = this.getAuthDir(sessionId);
    const chatAddress = projectAddress(authDir, chatJid);
    const id = messageId ?? crypto.randomUUID();
    const timestamp = new Date(unixSeconds * 1000).toISOString();

    const message: MessageRecord = {
      sessionId,
      chatJid: canonicalChatId(chatJid, chatAddress),
      chatLookupKey: chatAddress.lookupKey,
      chatLookupJid: chatAddress.lookupJid,
      chatPhoneNumber: chatAddress.phoneNumber,
      id,
      participantJid: canonicalEntityId(chatJid, chatAddress),
      participantLookupKey: chatAddress.lookupKey,
      participantLookupJid: chatAddress.lookupJid,
      participantPhoneNumber: chatAddress.phoneNumber,
      senderJid: canonicalEntityId(chatJid, chatAddress),
      senderLookupKey: chatAddress.lookupKey,
      senderLookupJid: chatAddress.lookupJid,
      senderPhoneNumber: chatAddress.phoneNumber,
      pushName: null,
      fromMe: true,
      upsertType: "append",
      messageType: "text",
      text,
      status: null,
      unixSeconds,
      timestamp,
      updatedAt: nowIso()
    };

    this.messagesRepo.upsert(message);
    this.syncChatFromMessage(message);
  }

  upsertSocketMessage(sessionId: string, rawMessage: WAMessage, upsertType = "notify"): MessageRecord | null {
    const normalized = this.normalizeSocketMessage(sessionId, rawMessage, upsertType);
    if (!normalized) {
      return null;
    }

    this.messagesRepo.upsert(normalized);
    this.syncChatFromMessage(normalized);
    if (!normalized.fromMe && normalized.pushName) {
      this.contactsRepo.upsert({
        sessionId,
        id: normalized.participantJid,
        lookupKey: normalized.participantLookupKey,
        lookupJid: normalized.participantLookupJid,
        phoneNumber: normalized.participantPhoneNumber,
        lid: isLidJid(normalized.participantJid) ? normalized.participantJid : null,
        name: null,
        notify: normalized.pushName,
        verifiedName: null,
        updatedAt: nowIso()
      });
    }

    return normalized;
  }

  private upsertNormalizedIncomingEvent(event: NormalizedEvent): void {
    const sessionId = event.sessionId;
    if (!sessionId || typeof event.chatId !== "string" || typeof event.messageId !== "string") {
      return;
    }

    const authDir = this.getAuthDir(sessionId);
    const chatAddress = projectAddress(authDir, event.chatId as string);
    const senderAddress = projectAddress(
      authDir,
      typeof event.from === "string" ? event.from : event.chatId as string
    );
    const unixSeconds = typeof event.timestamp === "number" ? event.timestamp : nowUnix();

    const message: MessageRecord = {
      sessionId,
      chatJid: canonicalChatId(event.chatId as string, chatAddress),
      chatLookupKey: chatAddress.lookupKey,
      chatLookupJid: chatAddress.lookupJid,
      chatPhoneNumber: chatAddress.phoneNumber,
      id: event.messageId,
      participantJid: canonicalEntityId(
        typeof event.from === "string" ? event.from : (event.chatId as string),
        senderAddress
      ),
      participantLookupKey: senderAddress.lookupKey,
      participantLookupJid: senderAddress.lookupJid,
      participantPhoneNumber: senderAddress.phoneNumber,
      senderJid: canonicalEntityId(
        typeof event.from === "string" ? event.from : (event.chatId as string),
        senderAddress
      ),
      senderLookupKey: senderAddress.lookupKey,
      senderLookupJid: senderAddress.lookupJid,
      senderPhoneNumber: senderAddress.phoneNumber,
      pushName: null,
      fromMe: false,
      upsertType: "notify",
      messageType: typeof event.type === "string" ? event.type : "unknown",
      text: typeof event.text === "string" ? event.text : null,
      status: null,
      unixSeconds,
      timestamp: new Date(unixSeconds * 1000).toISOString(),
      updatedAt: nowIso()
    };

    this.messagesRepo.upsert(message);
    this.syncChatFromMessage(message);
  }

  private upsertChat(sessionId: string, rawChat: Record<string, unknown>): void {
    const authDir = this.getAuthDir(sessionId);
    const id = typeof rawChat.id === "string" ? rawChat.id : "";
    if (!id) {
      return;
    }

    const current = this.chatsRepo.get(sessionId, id);
    const address = projectAddress(authDir, id, [
      typeof rawChat.lid === "string" ? rawChat.lid : null
    ]);
    const chatId = canonicalChatId(id, address);
    const currentChat = this.chatsRepo.get(sessionId, chatId) ?? current;

    const chat: ChatRecord = {
      sessionId,
      id: chatId,
      lookupKey: address.lookupKey,
      lookupJid: address.lookupJid,
      phoneNumber: address.phoneNumber,
      name:
        (typeof rawChat.name === "string" && rawChat.name) ||
        (typeof rawChat.subject === "string" && rawChat.subject) ||
        (typeof rawChat.formattedTitle === "string" && rawChat.formattedTitle) ||
        currentChat?.name ||
        null,
      type: classifyChatJid(id),
      conversationTimestamp: normalizeTimestamp(rawChat.conversationTimestamp) ?? currentChat?.conversationTimestamp ?? null,
      lastMessageRecvTimestamp:
        normalizeTimestamp(rawChat.lastMessageRecvTimestamp) ?? currentChat?.lastMessageRecvTimestamp ?? null,
      unreadCount:
        typeof rawChat.unreadCount === "number" ? rawChat.unreadCount : currentChat?.unreadCount ?? 0,
      lastMessageId: currentChat?.lastMessageId ?? null,
      lastMessageType: currentChat?.lastMessageType ?? null,
      lastMessageText: currentChat?.lastMessageText ?? null,
      lastMessageTimestamp: currentChat?.lastMessageTimestamp ?? null,
      updatedAt: nowIso()
    };

    this.chatsRepo.upsert(chat);
  }

  private upsertContact(sessionId: string, rawContact: Record<string, unknown>): void {
    const authDir = this.getAuthDir(sessionId);
    const id = typeof rawContact.id === "string" ? rawContact.id : "";
    if (!id) {
      return;
    }

    const lid = typeof rawContact.lid === "string" ? rawContact.lid : isLidJid(id) ? id : null;
    const address = projectAddress(authDir, id, [lid]);
    const contactId = canonicalEntityId(id, address);

    const contact: ContactRecord = {
      sessionId,
      id: contactId,
      lookupKey: address.lookupKey,
      lookupJid: address.lookupJid,
      phoneNumber: address.phoneNumber,
      lid,
      name: typeof rawContact.name === "string" && rawContact.name ? rawContact.name : null,
      notify: typeof rawContact.notify === "string" && rawContact.notify ? rawContact.notify : null,
      verifiedName: typeof rawContact.verifiedName === "string" && rawContact.verifiedName ? rawContact.verifiedName : null,
      updatedAt: nowIso()
    };

    this.contactsRepo.upsert(contact);
  }

  private normalizeSocketMessage(
    sessionId: string,
    rawMessage: WAMessage,
    upsertType: string
  ): MessageRecord | null {
    const authDir = this.getAuthDir(sessionId);
    const chatId = typeof rawMessage.key?.remoteJid === "string" ? rawMessage.key.remoteJid : "";
    const messageId = typeof rawMessage.key?.id === "string" ? rawMessage.key.id : "";
    if (!chatId || !messageId) {
      return null;
    }

    const chatAddress = projectAddress(authDir, chatId, [
      typeof rawMessage.key?.remoteJidAlt === "string" ? rawMessage.key.remoteJidAlt : null
    ]);
    const participantId =
      typeof rawMessage.key?.participant === "string" ? rawMessage.key.participant : chatId;
    const participantAddress = projectAddress(authDir, participantId, [
      typeof rawMessage.key?.participantAlt === "string" ? rawMessage.key.participantAlt : null
    ]);
    const senderAddress = projectAddress(authDir, participantId, [
      typeof rawMessage.key?.participantAlt === "string" ? rawMessage.key.participantAlt : null,
      typeof rawMessage.key?.remoteJidAlt === "string" ? rawMessage.key.remoteJidAlt : null
    ]);
    const unixSeconds = normalizeTimestamp(rawMessage.messageTimestamp);

    return {
      sessionId,
      chatJid: canonicalChatId(chatId, chatAddress),
      chatLookupKey: chatAddress.lookupKey,
      chatLookupJid: chatAddress.lookupJid,
      chatPhoneNumber: chatAddress.phoneNumber,
      id: messageId,
      participantJid: canonicalEntityId(participantId, participantAddress),
      participantLookupKey: participantAddress.lookupKey,
      participantLookupJid: participantAddress.lookupJid,
      participantPhoneNumber: participantAddress.phoneNumber,
      senderJid: canonicalEntityId(participantId, senderAddress),
      senderLookupKey: senderAddress.lookupKey,
      senderLookupJid: senderAddress.lookupJid,
      senderPhoneNumber: senderAddress.phoneNumber,
      pushName: typeof rawMessage.pushName === "string" ? rawMessage.pushName : null,
      fromMe: Boolean(rawMessage.key?.fromMe),
      upsertType,
      messageType: extractMessageType(rawMessage.message as Record<string, unknown> | undefined),
      text: extractMessageText(rawMessage.message as Record<string, unknown> | undefined),
      status:
        rawMessage.status === undefined || rawMessage.status === null
          ? null
          : String(rawMessage.status),
      unixSeconds,
      timestamp: unixSeconds ? new Date(unixSeconds * 1000).toISOString() : nowIso(),
      updatedAt: nowIso()
    };
  }

  private syncChatFromMessage(message: MessageRecord): void {
    const current = this.chatsRepo.get(message.sessionId, message.chatJid);
    const nextConversationTimestamp = Math.max(
      current?.conversationTimestamp ?? 0,
      message.unixSeconds ?? 0
    );
    const nextLastRecvTimestamp = message.fromMe
      ? current?.lastMessageRecvTimestamp ?? null
      : Math.max(current?.lastMessageRecvTimestamp ?? 0, message.unixSeconds ?? 0);

    this.chatsRepo.upsert({
      sessionId: message.sessionId,
      id: message.chatJid,
      lookupKey: message.chatLookupKey,
      lookupJid: message.chatLookupJid,
      phoneNumber: message.chatPhoneNumber,
      name: bestChatName(current, message),
      type: classifyChatJid(message.chatJid),
      conversationTimestamp: nextConversationTimestamp || null,
      lastMessageRecvTimestamp: nextLastRecvTimestamp || null,
      unreadCount: current?.unreadCount ?? 0,
      lastMessageId: message.id,
      lastMessageType: message.messageType,
      lastMessageText: message.text,
      lastMessageTimestamp: message.timestamp,
      updatedAt: nowIso()
    });
  }

  private applyMessageUpdates(sessionId: string, updates: BaileysEventMap["messages.update"] = []): void {
    for (const update of updates) {
      const rawChatJid = typeof update?.key?.remoteJid === "string" ? update.key.remoteJid : "";
      const messageId = typeof update?.key?.id === "string" ? update.key.id : "";
      if (!rawChatJid || !messageId) {
        continue;
      }

      const chatJid = canonicalChatId(rawChatJid, projectAddress(this.getAuthDir(sessionId), rawChatJid, [
        typeof update?.key?.remoteJidAlt === "string" ? update.key.remoteJidAlt : null
      ]));
      const existing = this.messagesRepo.get(sessionId, chatJid, messageId);
      if (!existing) {
        continue;
      }

      const partial = this.normalizeSocketMessage(
        sessionId,
        {
          key: update.key,
          message: update.update?.message,
          messageTimestamp: update.update?.messageTimestamp ?? existing.unixSeconds ?? undefined,
          status: update.update?.status as WAMessage["status"]
        } as WAMessage,
        existing.upsertType
      );

      this.messagesRepo.upsert({
        ...existing,
        ...(partial ?? {}),
        status:
          update.update?.status === undefined || update.update?.status === null
            ? existing.status
            : String(update.update.status),
        updatedAt: nowIso()
      });
    }
  }

  private applyMessageDeletes(sessionId: string, event: BaileysEventMap["messages.delete"]): void {
    if (!event) {
      return;
    }

    if ("all" in event && event.all && "jid" in event && event.jid) {
        const chatJid = canonicalChatId(event.jid, projectAddress(this.getAuthDir(sessionId), event.jid));
        this.messagesRepo.deleteChat(sessionId, chatJid);
        return;
      }

    if (!("keys" in event)) {
      return;
    }

    for (const key of event.keys ?? []) {
      if (!key?.remoteJid || !key?.id) {
        continue;
      }

      const chatJid = canonicalChatId(
        key.remoteJid,
        projectAddress(this.getAuthDir(sessionId), key.remoteJid, [
          typeof key.remoteJidAlt === "string" ? key.remoteJidAlt : null
        ])
      );
      this.messagesRepo.delete(sessionId, chatJid, key.id);
    }
  }

  private getAuthDir(sessionId: string): string {
    return `${this.config.paths.sessionsDir}/${sessionId}/auth`;
  }
}
