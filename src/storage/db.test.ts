import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { SessionsRepo } from "./sessionsRepo.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("openDatabase", () => {
  it("abre toda conexao com busy_timeout de 5000ms", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-control-db-"));
    tempDirs.push(dir);

    const db = openDatabase(join(dir, "app.sqlite"));
    try {
      const row = db.query("PRAGMA busy_timeout").get() as { timeout: number };
      expect(row.timeout).toBe(5000);
    } finally {
      db.close();
    }
  });

  it("preserva sessoes de um data dir existente ao reabrir o banco", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-control-db-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "app.sqlite");
    const now = new Date().toISOString();

    const first = openDatabase(dbPath);
    new SessionsRepo(first).save({
      id: "pessoal",
      status: "connected",
      createdAt: now,
      updatedAt: now,
      phoneNumber: "556784020665",
      lastError: null,
      active: true,
      lastConnectedAt: now,
      reconnectAttempts: 0,
      qr: null
    });
    first.close();

    const second = openDatabase(dbPath);
    try {
      const restored = new SessionsRepo(second).get("pessoal");
      expect(restored).not.toBeNull();
      expect(restored?.status).toBe("connected");
      expect(restored?.phoneNumber).toBe("556784020665");
    } finally {
      second.close();
    }
  });
});
