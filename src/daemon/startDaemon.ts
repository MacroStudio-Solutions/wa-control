import { rmSync } from "node:fs";
import { AppError } from "../shared/errors.ts";
import { createLogger } from "../shared/logger.ts";
import { loadAppConfig } from "../config/config.ts";
import { ReadModelStore } from "../read-model/store.ts";
import { readOrCreateLocalToken } from "../config/token.ts";
import { ChatsRepo } from "../storage/chatsRepo.ts";
import { ContactsRepo } from "../storage/contactsRepo.ts";
import { openDatabase } from "../storage/db.ts";
import { EventsRepo } from "../storage/eventsRepo.ts";
import { MessagesRepo } from "../storage/messagesRepo.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import { WebhookDeliveriesRepo } from "../storage/webhookDeliveriesRepo.ts";
import { WebhooksRepo } from "../storage/webhooksRepo.ts";
import { DaemonRuntime } from "./daemonRuntime.ts";
import { EventBus } from "./eventBus.ts";
import { startLocalApiServer } from "./localApi.ts";

async function healthcheck(endpoint: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);

  try {
    const response = await fetch(`${endpoint}/health`, {
      signal: controller.signal
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function startDaemon(): Promise<void> {
  const config = loadAppConfig();
  const logger = createLogger(config);
  const token = readOrCreateLocalToken(config);

  if (await healthcheck(`http://${config.host}:${config.port}`)) {
    throw new AppError(
      "DAEMON_ALREADY_RUNNING",
      409,
      `Daemon ja esta rodando em http://${config.host}:${config.port}.`
    );
  }

  rmSync(config.paths.runtimePath, { force: true });

  const db = openDatabase(config.paths.databasePath);
  const readModel = new ReadModelStore(
    config,
    new ChatsRepo(db),
    new ContactsRepo(db),
    new MessagesRepo(db)
  );
  const runtime = new DaemonRuntime(
    config,
    new EventsRepo(db),
    new WebhooksRepo(db),
    new WebhookDeliveriesRepo(db),
    new EventBus(),
    logger,
    new SessionsRepo(db),
    readModel
  );

  runtime.assertDaemonCanStart();
  await runtime.bootstrap();

  const server = startLocalApiServer({
    runtime,
    token,
    eventBus: runtime.bus,
    logger
  });

  logger.info("daemon iniciado", {
    endpoint: runtime.endpoint,
    pid: process.pid
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("encerrando daemon");
    server.stop(true);
    await runtime.shutdown();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await new Promise<void>(() => undefined);
}
