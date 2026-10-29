import { AppError, exitCodeForError, isAppError } from "./shared/errors.ts";
import { LocalApiClient } from "./shared/localApiClient.ts";
import { loadAppConfig } from "./config/config.ts";
import {
  DEFAULT_STOP_WAIT_MS,
  startDaemonInBackground,
  stopDaemon
} from "./daemon/daemonControl.ts";
import { startDaemon } from "./daemon/startDaemon.ts";
import {
  assertConcreteDestination,
  assertDirectoryWritable,
  destinationPathFor,
  resolveDownloadTarget
} from "./cli/downloadTarget.ts";
import { STATUS_PROBE_TIMEOUT_MS, collectStatusReport } from "./cli/localStatus.ts";
import { parseCliCommand } from "./cli/router.ts";
import { resolveSendMediaSource } from "./cli/sendMediaSource.ts";
import {
  renderChats,
  renderContacts,
  renderDelete,
  renderEventCatalog,
  renderGroupCreate,
  renderGroupInfo,
  renderGroupLeave,
  renderGroupParticipants,
  renderHelp,
  renderMessages,
  renderOfflineStatus,
  renderPoll,
  renderReact,
  renderRead,
  renderSessions,
  renderStartBackground,
  renderStatus,
  renderStopDaemon,
  renderTyping,
  renderWebhookDeliveries,
  renderWebhooks
} from "./cli/render.ts";

async function pipeResponseBody(response: Response): Promise<void> {
  const body = response.body;

  if (!body) {
    return;
  }

  const reader = body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    await Bun.write(Bun.stdout, value);
  }
}

async function run(): Promise<void> {
  const command = parseCliCommand(process.argv.slice(2));

  if (command.kind === "help") {
    console.log(renderHelp());
    return;
  }

  if (command.kind === "daemon.start") {
    await startDaemon();
    return;
  }

  if (command.kind === "daemon.start.background") {
    const result = await startDaemonInBackground(loadAppConfig());

    if (command.json) {
      // o objeto do contrato do servidor gerenciado e a resposta, inclusive a
      // recusa: sai com 0 para quem le a saida nao perder o motivo por um codigo
      console.log(JSON.stringify(result));
      return;
    }

    console.log(renderStartBackground(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command.kind === "daemon.stop") {
    const result = await stopDaemon(loadAppConfig(), {
      waitMs: command.waitMs ?? DEFAULT_STOP_WAIT_MS
    });

    console.log(command.json ? JSON.stringify(result) : renderStopDaemon(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command.kind === "status") {
    const report = await collectStatusReport(
      new LocalApiClient({ requestTimeoutMs: STATUS_PROBE_TIMEOUT_MS })
    );

    if (command.json) {
      console.log(JSON.stringify(report));
    } else {
      console.log(report.running ? renderStatus(report) : renderOfflineStatus(report));
    }
    return;
  }

  const client = new LocalApiClient();

  switch (command.kind) {
    case "sessions": {
      const sessions = await client.sessions();
      console.log(command.json ? JSON.stringify(sessions, null, 2) : renderSessions(sessions));
      return;
    }

    case "chats": {
      const chats = await client.chats(command.sessionId, command.limit);
      console.log(command.json ? JSON.stringify(chats, null, 2) : renderChats(chats));
      return;
    }

    case "contacts": {
      const contacts = await client.contacts(command.sessionId, command.limit);
      console.log(command.json ? JSON.stringify(contacts, null, 2) : renderContacts(contacts));
      return;
    }

    case "messages": {
      const messages = await client.messages(command.sessionId, command.chat, command.limit);
      console.log(command.json ? JSON.stringify(messages, null, 2) : renderMessages(messages));
      return;
    }

    case "connect": {
      const result = await client.connect(command.sessionId);
      if (command.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.qrTerminal) {
        console.log(result.qrTerminal);
      }
      console.log(`Sessao '${result.session.id}' preparada. ${result.note ?? ""}`.trim());
      return;
    }

    case "qr": {
      const result = await client.qr(command.sessionId);
      if (command.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (command.base64) {
        console.log(result.base64);
        return;
      }

      console.log(result.ascii);
      console.log(`Sessao '${result.sessionId}' aguardando leitura do QR.`);
      return;
    }

    case "disconnect": {
      const result = await client.disconnect(command.sessionId);
      console.log(`Sessao '${result.session.id}' desconectada.`);
      return;
    }

    case "session.remove": {
      if (!command.yes) {
        throw new AppError(
          "CONFIRMATION_REQUIRED",
          400,
          "Use `--yes` para remover a sessao e apagar os dados locais."
        );
      }

      await client.remove(command.sessionId);
      console.log(`Sessao '${command.sessionId}' removida.`);
      return;
    }

    case "send": {
      const result = await client.send(command.sessionId, {
        to: command.to,
        text: command.text
      });
      console.log(`Mensagem enviada para ${result.jid}${result.messageId ? ` (${result.messageId})` : ""}.`);
      return;
    }

    case "send-media": {
      // Classificacao ANTES de qualquer rede: arquivo, tipo, caption, filename
      // e ptt validados aqui; o daemon so ve a requisicao quando tudo confere.
      const source = resolveSendMediaSource(command.file, {
        ...(command.type ? { typeOverride: command.type } : {}),
        ...(command.caption ? { caption: command.caption } : {}),
        ...(command.filename ? { fileName: command.filename } : {}),
        ...(command.ptt ? { ptt: true } : {})
      });
      const result = await client.sendMedia(
        command.sessionId,
        {
          to: command.to,
          kind: source.kind,
          mimeType: source.mimeType,
          ...(command.caption ? { caption: command.caption } : {}),
          fileName: source.fileName,
          ...(command.ptt ? { ptt: true } : {})
        },
        source.buffer
      );

      if (command.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const pttNote = result.ptt ? " (voice note)" : "";
      const captionNote = result.caption ? `, caption "${result.caption}"` : "";
      const fileNameNote = result.fileName ? `, arquivo "${result.fileName}"` : "";
      console.log(
        `Midia enviada para ${result.jid}: ${result.kind} (${result.mimeType})${pttNote}, ${result.size} bytes${captionNote}${fileNameNote}${result.messageId ? ` (${result.messageId})` : ""}.`
      );
      return;
    }

    case "download-media": {
      // Destino validado ANTES do fetch: falha aqui nao gera requisicao ao
      // daemon nem escrita parcial.
      const target = resolveDownloadTarget(command.out, command.messageId);
      assertDirectoryWritable(target.directory);
      assertConcreteDestination(target);

      const media = await client.downloadMedia(
        command.sessionId,
        command.chat,
        command.messageId
      );
      const destination = destinationPathFor(target, media.mimeType, media.messageId);
      await Bun.write(destination, media.buffer);

      if (command.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              kind: media.kind,
              mimeType: media.mimeType,
              size: media.size,
              path: destination,
              messageId: media.messageId,
              chatJid: media.chatJid,
              fileName: media.fileName
            },
            null,
            2
          )
        );
        return;
      }

      console.log(
        `Midia baixada: ${media.kind} (${media.mimeType}), ${media.size} bytes -> ${destination}`
      );
      return;
    }

    case "typing": {
      const result = await client.typing(command.sessionId, {
        chat: command.chat,
        ...(command.recording ? { recording: true } : {})
      });

      if (command.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(renderTyping(result));
      return;
    }

    case "read": {
      const result = await client.markRead(command.sessionId, {
        chat: command.chat,
        ...(command.messageId ? { messageId: command.messageId } : {})
      });

      if (command.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(renderRead(result));
      return;
    }

    case "react": {
      const result = await client.react(command.sessionId, {
        chat: command.chat,
        messageId: command.messageId,
        emoji: command.emoji
      });

      if (command.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(renderReact(result));
      return;
    }

    case "delete": {
      const result = await client.deleteMessage(command.sessionId, {
        chat: command.chat,
        messageId: command.messageId
      });

      if (command.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(renderDelete(result));
      return;
    }

    case "poll": {
      const result = await client.sendPoll(command.sessionId, {
        chat: command.chat,
        question: command.question,
        options: command.options
      });

      if (command.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(renderPoll(result));
      return;
    }

    case "group.create": {
      const result = await client.createGroup(command.sessionId, {
        subject: command.subject,
        ...(command.participants.length > 0 ? { participants: command.participants } : {})
      });

      if (command.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(renderGroupCreate(result));
      return;
    }

    case "group.info": {
      const result = await client.groupInfo(command.sessionId, command.groupJid);

      if (command.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(renderGroupInfo(result));
      return;
    }

    case "group.participants": {
      const result = await client.updateGroupParticipants(command.sessionId, {
        groupJid: command.groupJid,
        action: command.action,
        participants: command.participants
      });

      if (command.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(renderGroupParticipants(result));
      return;
    }

    case "group.leave": {
      const result = await client.leaveGroup(command.sessionId, command.groupJid);

      if (command.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(renderGroupLeave(result));
      return;
    }

    case "listen": {
      const response = await client.stream(command.sessionId, command.all, command.raw);
      await pipeResponseBody(response);
      return;
    }

    case "webhook.add": {
      const webhook = await client.addWebhook({
        sessionId: command.sessionId,
        url: command.url,
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
        ...(command.maxAttempts !== undefined ? { maxAttempts: command.maxAttempts } : {}),
        ...(command.events !== undefined ? { events: command.events } : {})
      });
      console.log(
        `Webhook '${webhook.id}' cadastrado para a sessao '${webhook.sessionId}' (${webhook.eventsLabel}).`
      );
      return;
    }

    case "webhook.list": {
      const webhooks = await client.listWebhooks(command.sessionId);
      console.log(
        command.json ? JSON.stringify(webhooks, null, 2) : renderWebhooks(webhooks)
      );
      return;
    }

    case "webhook.set-events": {
      const webhook = await client.setWebhookEvents(command.id, command.events);
      console.log(`Webhook '${webhook.id}' agora assina: ${webhook.eventsLabel}.`);
      return;
    }

    case "webhook.toggle-event": {
      const webhook = await client.toggleWebhookEvent(
        command.id,
        command.event,
        command.enabled
      );
      console.log(`Webhook '${webhook.id}' agora assina: ${webhook.eventsLabel}.`);
      return;
    }

    case "webhook.set-enabled": {
      const webhook = await client.setWebhookEnabled(command.id, command.enabled);
      console.log(
        `Webhook '${webhook.id}' ${webhook.enabled ? "habilitado" : "desabilitado"}.`
      );
      return;
    }

    case "events": {
      const catalog = await client.eventCatalog();
      console.log(
        command.json ? JSON.stringify(catalog, null, 2) : renderEventCatalog(catalog)
      );
      return;
    }

    case "webhook.remove": {
      await client.removeWebhook(command.id);
      console.log(`Webhook '${command.id}' removido.`);
      return;
    }

    case "webhook.deliveries": {
      const deliveries = await client.listWebhookDeliveries(command.sessionId);
      console.log(
        command.json
          ? JSON.stringify(deliveries, null, 2)
          : renderWebhookDeliveries(deliveries)
      );
      return;
    }
  }
}

run().catch((error) => {
  const message = isAppError(error) ? error.message : error instanceof Error ? error.message : "Erro inesperado";
  console.error(message);
  process.exit(exitCodeForError(error));
});
