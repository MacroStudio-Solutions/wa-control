import pkg from "../../package.json" with { type: "json" };
import { AppError } from "../shared/errors.ts";
import { createLogger, type Logger } from "../shared/logger.ts";
import type { AppConfig } from "../shared/types.ts";
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
import { DaemonRuntime, buildRuntimeFileRecord, createDaemonRuntimeInfo } from "./daemonRuntime.ts";
import { acquireRuntimeFile, releaseRuntimeFile } from "./daemonGuard.ts";
import { DETACHED_ENV, firstLineOf, formatStartHeader } from "./daemonLog.ts";
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

async function bootDaemon(
  config: AppConfig,
  logger: Logger,
  token: string,
  onShutdown: () => void
) {
  if (await healthcheck(`http://${config.host}:${config.port}`)) {
    throw new AppError(
      "DAEMON_ALREADY_RUNNING",
      409,
      `Daemon ja esta rodando em http://${config.host}:${config.port}.`
    );
  }

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
    logger,
    onShutdown
  });

  return { db, runtime, server };
}

async function runDaemon(detached: boolean): Promise<void> {
  const config = loadAppConfig();
  const logger = createLogger(config);
  const token = readOrCreateLocalToken(config);

  if (detached) {
    console.error(
      formatStartHeader({
        startedAt: new Date().toISOString(),
        version: pkg.version,
        pid: process.pid,
        port: config.port
      })
    );
  }

  acquireRuntimeFile(config, logger, buildRuntimeFileRecord(createDaemonRuntimeInfo(config)));

  let shutdownRequestedEarly = false;
  let requestShutdown: () => void = () => {
    shutdownRequestedEarly = true;
  };
  let booted: Awaited<ReturnType<typeof bootDaemon>>;

  try {
    booted = await bootDaemon(config, logger, token, () => requestShutdown());
  } catch (error) {
    releaseRuntimeFile(config.paths.runtimePath, process.pid);
    throw error;
  }

  const { db, runtime, server } = booted;

  logger.info("daemon iniciado", {
    endpoint: runtime.endpoint,
    pid: process.pid
  });

  let shuttingDown = false;
  const shutdown = async (origem: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("encerrando daemon: parada graciosa", { origem });

    try {
      server.stop(true);
      await runtime.shutdown();
      db.close();
      process.exit(0);
    } catch (error) {
      logger.error("falha na parada graciosa do daemon", {
        origem,
        message: error instanceof Error ? error.message : "erro inesperado"
      });
      process.exit(1);
    }
  };

  requestShutdown = () => {
    void shutdown("POST /shutdown");
  };

  if (shutdownRequestedEarly) {
    requestShutdown();
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await new Promise<void>(() => undefined);
}

/**
 * Partida destacada (`DETACHED_ENV`): a saida do processo ja e o daemon.log, e
 * uma partida que nao chega a subir deixa nele uma linha estruturada com o pid
 * e o motivo, que o verbo `daemon start --background` le para responder.
 */
export async function startDaemon(): Promise<void> {
  const detached = process.env[DETACHED_ENV] === "1";

  try {
    await runDaemon(detached);
  } catch (error) {
    if (detached) {
      createLogger({ logLevel: "info" }).error("daemon nao iniciou", {
        pid: process.pid,
        motivo: error instanceof Error ? firstLineOf(error.message) : "erro inesperado"
      });
    }

    throw error;
  }
}
