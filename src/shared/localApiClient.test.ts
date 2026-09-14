import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type AddressInfo } from "node:net";
import { AppError, exitCodeForError, isAppError } from "./errors.ts";
import {
	DEFAULT_TIMEOUTS,
	isConnectionRefusal,
	LocalApiClient,
	type LocalApiClientTimeouts
} from "./localApiClient.ts";
import type { MessageRecord } from "./types.ts";

const ENV_KEYS = ["WA_CONTROL_DATA_DIR", "WA_CONTROL_HOST", "WA_CONTROL_PORT"] as const;
const savedEnv = new Map<string, string | undefined>(
	ENV_KEYS.map((key) => [key, process.env[key]])
);

const openServers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const server of openServers.splice(0)) {
		server.stop(true);
	}

	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}

	for (const [key, value] of savedEnv) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

function makeClient(port: number, timeouts: LocalApiClientTimeouts = {}): LocalApiClient {
	const dir = mkdtempSync(join(tmpdir(), "wa-control-client-"));
	tempDirs.push(dir);
	writeFileSync(join(dir, "token"), "test-token\n", "utf8");

	process.env.WA_CONTROL_DATA_DIR = dir;
	process.env.WA_CONTROL_HOST = "127.0.0.1";
	process.env.WA_CONTROL_PORT = String(port);

	return new LocalApiClient(timeouts);
}

interface SendEntry {
	to: string;
	text: string;
}

interface SendMediaEntry {
	to: string | null;
	kind: string | null;
	mimeType: string | null;
	caption: string | null;
	ptt: string | null;
	body: Uint8Array;
}

interface FakeDaemonOptions {
	sendLatencyMs?: number;
	messagesLatencyMs?: number;
	sendMediaLatencyMs?: number;
	history?: () => MessageRecord[];
}

function startFakeDaemon(options: FakeDaemonOptions = {}) {
	const received: SendEntry[] = [];
	const receivedMedia: SendMediaEntry[] = [];

	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);

			if (url.pathname.endsWith("/send") && request.method === "POST") {
				const body = (await request.json()) as SendEntry;
				received.push(body);

				if (options.sendLatencyMs) {
					await Bun.sleep(options.sendLatencyMs);
				}

				return Response.json({
					ok: true,
					sessionId: "principal",
					to: body.to,
					jid: `${body.to}@s.whatsapp.net`,
					text: body.text,
					messageId: "3EB0TEST",
					timestamp: 1_785_000_000
				});
			}

			if (url.pathname.endsWith("/send-media") && request.method === "POST") {
				const body = new Uint8Array(await request.arrayBuffer());
				receivedMedia.push({
					to: request.headers.get("x-media-to"),
					kind: request.headers.get("x-media-kind"),
					mimeType: request.headers.get("x-media-mime"),
					caption: request.headers.get("x-media-caption"),
					ptt: request.headers.get("x-media-ptt"),
					body
				});

				if (options.sendMediaLatencyMs) {
					await Bun.sleep(options.sendMediaLatencyMs);
				}

				return Response.json({
					ok: true,
					sessionId: "principal",
					to: receivedMedia[0]?.to,
					jid: `${receivedMedia[0]?.to}@s.whatsapp.net`,
					kind: receivedMedia[0]?.kind,
					mimeType: receivedMedia[0]?.mimeType,
					caption: null,
					ptt: false,
					size: body.byteLength,
					messageId: "3EB0MEDIA",
					timestamp: 1_785_000_000
				});
			}

			if (url.pathname.endsWith("/messages")) {
				if (options.messagesLatencyMs) {
					await Bun.sleep(options.messagesLatencyMs);
				}

				return Response.json(options.history ? options.history() : []);
			}

			return new Response("not found", { status: 404 });
		}
	});

	openServers.push(server);
	return { server, received, receivedMedia };
}

function isPortRefused(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port });
		let settled = false;

		const done = (refused: boolean) => {
			if (settled) {
				return;
			}

			settled = true;
			socket.destroy();
			resolve(refused);
		};

		socket.on("connect", () => done(false));
		socket.on("error", () => done(true));
		setTimeout(() => done(true), 1_500);
	});
}

/**
 * No Bun, o callback de `server.close()` dispara antes do unbind real da
 * porta: uma conexao imediata ainda e aceita. Sonda ate a recusa efetiva para
 * entregar uma porta de verdade fechada.
 */
async function freePort(): Promise<number> {
	const server = createServer();

	const port = await new Promise<number>((resolve, reject) => {
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			resolve((server.address() as AddressInfo).port);
		});
	});

	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});

	for (let attempt = 0; attempt < 20; attempt++) {
		if (await isPortRefused(port)) {
			return port;
		}

		await Bun.sleep(50);
	}

	throw new Error("porta nao ficou livre apos close");
}

function makeMessageRecord(id: string, text: string): MessageRecord {
	const now = new Date().toISOString();

	return {
		sessionId: "principal",
		chatJid: "556799999999@s.whatsapp.net",
		chatLookupKey: null,
		chatLookupJid: null,
		chatPhoneNumber: "556799999999",
		id,
		participantJid: "556799999999@s.whatsapp.net",
		participantLookupKey: null,
		participantLookupJid: null,
		participantPhoneNumber: "556799999999",
		senderJid: "556799999999@s.whatsapp.net",
		senderLookupKey: null,
		senderLookupJid: null,
		senderPhoneNumber: "556799999999",
		pushName: null,
		fromMe: true,
		upsertType: "notify",
		messageType: "text",
		text,
		rawMessageType: null,
		status: null,
		unixSeconds: 1_785_000_000,
		timestamp: now,
		updatedAt: now
	};
}

async function captureError(action: () => Promise<unknown>): Promise<AppError> {
	try {
		await action();
	} catch (error) {
		if (isAppError(error)) {
			return error;
		}

		throw error;
	}

	throw new Error("esperava que a operacao falhasse");
}

describe("LocalApiClient.send — classificacao honesta de erro", () => {
	it("envia com sucesso e retorna a resposta do daemon", async () => {
		const daemon = startFakeDaemon();
		const client = makeClient(daemon.server.port!!);

		const result = await client.send("principal", { to: "556799999999", text: "ola" });

		expect(result.ok).toBe(true);
		expect(result.jid).toBe("556799999999@s.whatsapp.net");
		expect(daemon.received).toHaveLength(1);
		expect(daemon.received[0]?.text).toBe("ola");
	});

	it("daemon parado (recusa de conexao) vira DAEMON_UNAVAILABLE imediato mesmo com timeout de send alto", async () => {
		const port = await freePort();
		const client = makeClient(port, { sendTimeoutMs: 8_000, probeTimeoutMs: 300 });
		const started = Date.now();

		const error = await captureError(() =>
			client.send("principal", { to: "556799999999", text: "ola" })
		);

		expect(error.code).toBe("DAEMON_UNAVAILABLE");
		expect(error.message).toContain("Daemon local nao esta rodando");
		expect(Date.now() - started).toBeLessThan(8_000);
	});

	it("timeout do send apos conexao aceita vira SEND_RESULT_UNCERTAIN com orientacao de verificar o historico", async () => {
		const daemon = startFakeDaemon({ sendLatencyMs: 500 });
		const client = makeClient(daemon.server.port!, { sendTimeoutMs: 100, probeTimeoutMs: 300 });

		const error = await captureError(() =>
			client.send("principal", { to: "556799999999", text: "ola" })
		);

		expect(error.code).toBe("SEND_RESULT_UNCERTAIN");
		expect(error.status).toBe(504);
		expect(error.message).toContain("Resultado incerto");
		expect(error.message).toContain("wa messages principal 556799999999");
		expect(daemon.received).toHaveLength(1);
	});

	it("apos erro incerto, o fluxo confere o historico antes de qualquer reenvio", async () => {
		const daemon = startFakeDaemon({
			sendLatencyMs: 500,
			history: () => [makeMessageRecord("3EB0TEST", "ola")]
		});
		const client = makeClient(daemon.server.port!, { sendTimeoutMs: 100 });

		const error = await captureError(() =>
			client.send("principal", { to: "556799999999", text: "ola" })
		);
		expect(error.code).toBe("SEND_RESULT_UNCERTAIN");

		const history = await client.messages("principal", "556799999999");
		const sent = history.find((message) => message.id === "3EB0TEST" && message.text === "ola");

		expect(sent).toBeDefined();
		expect(daemon.received).toHaveLength(1);
	});

	it("leituras mantem a classificacao atual: timeout vira DAEMON_UNAVAILABLE, nunca resultado incerto", async () => {
		const daemon = startFakeDaemon({ messagesLatencyMs: 500 });
		const client = makeClient(daemon.server.port!, { requestTimeoutMs: 80, probeTimeoutMs: 300 });

		const error = await captureError(() => client.messages("principal", "556799999999"));

		expect(error.code).toBe("DAEMON_UNAVAILABLE");
		expect(error.message).toContain("Daemon local nao esta rodando");
	});

	it("timeout por operacao: send usa timeout proprio maior que o global de leituras", () => {
		expect(DEFAULT_TIMEOUTS.sendTimeoutMs).toBeGreaterThan(DEFAULT_TIMEOUTS.requestTimeoutMs);
	});
});

describe("LocalApiClient.sendMedia — midia herda a semantica 0/1/2", () => {
	it("envia os bytes e os metadados em headers, e devolve a resposta do daemon", async () => {
		const daemon = startFakeDaemon();
		const client = makeClient(daemon.server.port!!);

		const result = await client.sendMedia(
			"principal",
			{
				to: "556799999999",
				kind: "image",
				mimeType: "image/jpeg",
				caption: "Bom dia"
			},
			new Uint8Array([1, 2, 3, 4])
		);

		expect(result.ok).toBe(true);
		expect(result.kind).toBe("image");
		expect(result.messageId).toBe("3EB0MEDIA");
		expect(result.size).toBe(4);
		expect(daemon.receivedMedia).toHaveLength(1);

		const entry = daemon.receivedMedia[0]!;
		expect(entry.to).toBe("556799999999");
		expect(entry.kind).toBe("image");
		expect(entry.mimeType).toBe("image/jpeg");
		expect(entry.caption).toBe(encodeURIComponent("Bom dia"));
		expect(entry.ptt).toBeNull();
		expect(Array.from(entry.body)).toEqual([1, 2, 3, 4]);
	});

	it("ptt viaja como header quando marcado", async () => {
		const daemon = startFakeDaemon();
		const client = makeClient(daemon.server.port!);

		await client.sendMedia(
			"principal",
			{ to: "556799999999", kind: "audio", mimeType: "audio/ogg; codecs=opus", ptt: true },
			new Uint8Array([5])
		);

		expect(daemon.receivedMedia[0]?.ptt).toBe("1");
	});

	it("daemon parado (recusa) vira DAEMON_UNAVAILABLE imediato, mesmo com timeout de midia alto", async () => {
		const port = await freePort();
		const client = makeClient(port, { mediaTimeoutMs: 10_000, probeTimeoutMs: 300 });
		const started = Date.now();

		const error = await captureError(() =>
			client.sendMedia(
				"principal",
				{ to: "556799999999", kind: "image", mimeType: "image/jpeg" },
				new Uint8Array([1])
			)
		);

		expect(error.code).toBe("DAEMON_UNAVAILABLE");
		expect(error.message).toContain("Daemon local nao esta rodando");
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("timeout de midia apos conexao aceita vira SEND_RESULT_UNCERTAIN com orientacao de conferir messages", async () => {
		const daemon = startFakeDaemon({ sendMediaLatencyMs: 500 });
		const client = makeClient(daemon.server.port!, { mediaTimeoutMs: 100, probeTimeoutMs: 300 });

		const error = await captureError(() =>
			client.sendMedia(
				"principal",
				{ to: "556799999999", kind: "audio", mimeType: "audio/mpeg" },
				new Uint8Array([1, 2])
			)
		);

		expect(error.code).toBe("SEND_RESULT_UNCERTAIN");
		expect(error.status).toBe(504);
		expect(error.message).toContain("Resultado incerto");
		expect(error.message).toContain("wa messages principal 556799999999");
		expect(error.message).toContain("nao duplicar");
		expect(daemon.receivedMedia).toHaveLength(1);
	});

	it("timeout de midia e proprios: 60s, maiores que os 15s do send-texto", () => {
		expect(DEFAULT_TIMEOUTS.mediaTimeoutMs).toBe(60_000);
		expect(DEFAULT_TIMEOUTS.mediaTimeoutMs).toBeGreaterThan(DEFAULT_TIMEOUTS.sendTimeoutMs);
	});
});

describe("isConnectionRefusal", () => {
	it("reconhece recusa por code ou mensagem em qualquer nivel da cadeia de cause", () => {
		const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:43119"), {
			code: "ECONNREFUSED"
		});
		const wrapped = Object.assign(new TypeError("fetch failed"), { cause: inner });
		const bunStyle = new TypeError("Unable to connect");

		expect(isConnectionRefusal(wrapped)).toBe(true);
		expect(isConnectionRefusal(bunStyle)).toBe(true);
	});

	it("nao classifica timeout nem reset como recusa", () => {
		expect(isConnectionRefusal(new Error("Request timed out"))).toBe(false);
		expect(isConnectionRefusal(new Error("socket hang up"))).toBe(false);
	});
});

describe("exitCodeForError", () => {
	it("mapeia resultado incerto para 2 e todo o resto para 1", () => {
		expect(exitCodeForError(new AppError("SEND_RESULT_UNCERTAIN", 504, "x"))).toBe(2);
		expect(exitCodeForError(new AppError("DAEMON_UNAVAILABLE", 503, "x"))).toBe(1);
		expect(exitCodeForError(new AppError("HTTP_ERROR", 500, "x"))).toBe(1);
		expect(exitCodeForError(new Error("qualquer falha"))).toBe(1);
	});
});
