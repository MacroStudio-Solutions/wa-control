import { AppError, isAppError } from "./shared/errors.ts";
import { LocalApiClient } from "./shared/localApiClient.ts";
import { startDaemon } from "./daemon/startDaemon.ts";
import { readOfflineStatusSnapshot } from "./cli/localStatus.ts";
import { parseCliCommand } from "./cli/router.ts";
import {
  renderChats,
  renderContacts,
  renderEventCatalog,
  renderHelp,
  renderMessages,
  renderOfflineStatus,
  renderSessions,
  renderStatus,
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

  const client = new LocalApiClient();

  switch (command.kind) {
    case "status": {
      try {
        const status = await client.status();
        console.log(command.json ? JSON.stringify(status, null, 2) : renderStatus(status));
      } catch (error) {
        if (
          isAppError(error) &&
          (error.code === "DAEMON_UNAVAILABLE" || error.code === "TOKEN_NOT_FOUND")
        ) {
          const snapshot = readOfflineStatusSnapshot();
          console.log(
            command.json ? JSON.stringify(snapshot, null, 2) : renderOfflineStatus(snapshot)
          );
          return;
        }

        throw error;
      }
      return;
    }

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
  process.exit(1);
});
