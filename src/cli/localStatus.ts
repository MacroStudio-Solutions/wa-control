import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { loadAppConfig } from "../config/config.ts";
import { readLocalToken } from "../config/token.ts";
import { openDatabase } from "../storage/db.ts";
import { EventsRepo } from "../storage/eventsRepo.ts";
import { SessionsRepo } from "../storage/sessionsRepo.ts";
import { WebhooksRepo } from "../storage/webhooksRepo.ts";
import type { SessionRecord } from "../shared/types.ts";

const runtimeFileSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string(),
  host: z.string(),
  port: z.number().int().positive()
});

export interface OfflineStatusSnapshot {
  daemon: {
    online: false;
    host: string;
    port: number;
    runtimeFilePresent: boolean;
    stalePid: number | null;
    tokenPresent: boolean;
  };
  sessions: SessionRecord[];
  eventCount: number;
  webhookCount: number;
}

function readRuntimeFile(path: string): z.infer<typeof runtimeFileSchema> | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return runtimeFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readOfflineStatusSnapshot(): OfflineStatusSnapshot {
  const config = loadAppConfig();
  const runtime = readRuntimeFile(config.paths.runtimePath);
  const tokenPresent = Boolean(readLocalToken(config));

  let sessions: SessionRecord[] = [];
  let eventCount = 0;
  let webhookCount = 0;

  if (existsSync(config.paths.databasePath)) {
    const db = openDatabase(config.paths.databasePath);

    try {
      sessions = new SessionsRepo(db).list();
      eventCount = new EventsRepo(db).count();
      webhookCount = new WebhooksRepo(db).count();
    } finally {
      db.close();
    }
  }

  return {
    daemon: {
      online: false,
      host: config.host,
      port: config.port,
      runtimeFilePresent: Boolean(runtime),
      stalePid: runtime && !isPidAlive(runtime.pid) ? runtime.pid : null,
      tokenPresent
    },
    sessions,
    eventCount,
    webhookCount
  };
}
