import type { AppConfig } from "./types.ts";

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
} as const;

type Level = keyof typeof LEVELS;

export interface Logger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export function createLogger(config: Pick<AppConfig, "logLevel">): Logger {
  const threshold = LEVELS[config.logLevel];

  function write(level: Level, message: string, details?: unknown) {
    if (LEVELS[level] < threshold) {
      return;
    }

    const stamp = new Date().toISOString();
    const payload =
      details === undefined ? "" : ` ${JSON.stringify(details, null, 0)}`;

    console.error(`[${stamp}] ${level.toUpperCase()} ${message}${payload}`);
  }

  return {
    debug: (message, details) => write("debug", message, details),
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details)
  };
}
