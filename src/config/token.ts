import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { AppConfig } from "../shared/types.ts";

export function readLocalToken(config: AppConfig): string | null {
  if (!existsSync(config.paths.tokenPath)) {
    return null;
  }

  return readFileSync(config.paths.tokenPath, "utf8").trim();
}

export function readOrCreateLocalToken(config: AppConfig): string {
  const existing = readLocalToken(config);
  if (existing) {
    return existing;
  }

  const token = randomBytes(32).toString("hex");
  writeFileSync(config.paths.tokenPath, `${token}\n`, "utf8");

  try {
    chmodSync(config.paths.tokenPath, 0o600);
  } catch {
    // Permission tightening is best-effort for cross-platform compatibility.
  }

  return token;
}
