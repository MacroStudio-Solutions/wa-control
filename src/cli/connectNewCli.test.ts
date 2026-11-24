import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionRecord } from "../shared/types.ts";
import {
	cleanupProcessHarness,
	createTestEnvironment,
	runCli,
	type TestEnvironment
} from "../test-support/processHarness.ts";

const TOKEN = "token-do-teste";

afterEach(cleanupProcessHarness);

const startedServers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
	for (const server of startedServers.splice(0, startedServers.length)) {
		server.stop(true);
	}
});

function writeToken(environment: TestEnvironment): void {
	writeFileSync(join(environment.dataDir, "token"), TOKEN, "utf8");
}

function sessionRecord(id: string): SessionRecord {
	const now = new Date().toISOString();

	return {
		id,
		status: "connected",
		createdAt: now,
		updatedAt: now,
		phoneNumber: "+55 67 99123-4567",
		lastError: null,
		active: true,
		lastConnectedAt: now,
		reconnectAttempts: 0,
		qr: null
	};
}

function startFakeDaemon(
	environment: TestEnvironment,
	sessions: SessionRecord[],
	connectedNames: string[]
): void {
	startedServers.push(
		Bun.serve({
			hostname: "127.0.0.1",
			port: environment.port,
			fetch: async (request) => {
				if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
					return Response.json(
						{ error: { code: "UNAUTHORIZED", message: "token invalido" } },
						{ status: 401 }
					);
				}

				const url = new URL(request.url);

				if (request.method === "GET" && url.pathname === "/sessions") {
					return Response.json(sessions);
				}

				const connect = url.pathname.match(/^\/sessions\/([^/]+)\/connect$/);
				if (request.method === "POST" && connect) {
					const sessionId = decodeURIComponent(connect[1] as string);
					connectedNames.push(sessionId);
					return Response.json({
						ok: true,
						session: sessionRecord(sessionId),
						note: "Leia o QR para concluir o pareamento."
					});
				}

				return Response.json(
					{ error: { code: "NOT_FOUND", message: "rota ausente" } },
					{ status: 404 }
				);
			}
		})
	);
}

describe("wa connect-new", () => {
	it("cria a primeira sessao com o nome principal, sem shell", async () => {
		const environment = await createTestEnvironment();
		writeToken(environment);
		const connectedNames: string[] = [];
		startFakeDaemon(environment, [], connectedNames);

		const result = await runCli(["connect-new"], environment);

		expect(result.exitCode).toBe(0);
		expect(connectedNames).toEqual(["principal"]);
		expect(result.stdout).toContain("Sessao 'principal' preparada");
	});

	it("conecta com o proximo nome livre dentre as sessoes existentes", async () => {
		const environment = await createTestEnvironment();
		writeToken(environment);
		const connectedNames: string[] = [];
		startFakeDaemon(
			environment,
			["principal", "session-2"].map(sessionRecord),
			connectedNames
		);

		const result = await runCli(["connect-new"], environment);

		expect(result.exitCode).toBe(0);
		expect(connectedNames).toEqual(["session-3"]);
	});

	it("responde o erro em portugues, tipado, na saida padrao com --json", async () => {
		const environment = await createTestEnvironment();
		writeToken(environment);
		// Sem daemon na porta: a recusa tem de vir como envelope {ok:false} em
		// uma unica linha de stdout, que e o que a tela do Studio le e mostra.

		const result = await runCli(["connect-new", "--json"], environment);

		expect(result.exitCode).toBe(1);

		const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
		expect(lines).toHaveLength(1);

		const envelope = JSON.parse(lines[0] as string) as {
			ok: boolean;
			error: { code: string; message: string };
		};
		expect(envelope.ok).toBe(false);
		expect(typeof envelope.error.code).toBe("string");
		expect(envelope.error.message).toContain("Daemon local nao esta rodando");
	});
});
