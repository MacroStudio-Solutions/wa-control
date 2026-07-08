import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { DEFAULT_HOST, DEFAULT_PORT, ensureAppDirectories, getAppPaths } from "./paths.ts";
import type { AppConfig } from "../shared/types.ts";

const fileSchema = z.object({
  host: z.string().default(DEFAULT_HOST),
  port: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info")
});

export function loadAppConfig(): AppConfig {
  const paths = getAppPaths();
  ensureAppDirectories(paths);

  const rawConfig = existsSync(paths.configPath)
    ? JSON.parse(readFileSync(paths.configPath, "utf8"))
    : {};

  const parsed = fileSchema.parse({
    ...rawConfig,
    host: process.env.WA_CONTROL_HOST ?? rawConfig.host,
    port: process.env.WA_CONTROL_PORT ?? rawConfig.port,
    logLevel: process.env.WA_CONTROL_LOG_LEVEL ?? rawConfig.logLevel
  });

  const config: AppConfig = {
    ...parsed,
    paths
  };

  writeFileSync(paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return config;
}
