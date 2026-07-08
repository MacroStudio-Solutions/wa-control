import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { AppPaths } from "../shared/types.ts";

export const APP_NAME = "wa-control";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 43119;

function resolveDataRoot(): string {
  if (process.env.WA_CONTROL_DATA_DIR) {
    return process.env.WA_CONTROL_DATA_DIR;
  }

  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, APP_NAME);
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_NAME);
  }

  if (process.env.XDG_DATA_HOME) {
    return join(process.env.XDG_DATA_HOME, APP_NAME);
  }

  return join(homedir(), ".local", "share", APP_NAME);
}

export function getAppPaths(): AppPaths {
  const rootDir = resolveDataRoot();

  return {
    rootDir,
    configPath: join(rootDir, "config.json"),
    databasePath: join(rootDir, "app.sqlite"),
    runtimePath: join(rootDir, "runtime.json"),
    sessionsDir: join(rootDir, "sessions"),
    tokenPath: join(rootDir, "token")
  };
}

export function ensureAppDirectories(paths: AppPaths): void {
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.sessionsDir, { recursive: true });
}
