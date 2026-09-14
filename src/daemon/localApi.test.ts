import { afterEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { EventBus } from "./eventBus.ts";
import { startLocalApiServer } from "./localApi.ts";
import type { Logger } from "../shared/logger.ts";
import type { NormalizedEvent } from "../shared/types.ts";

const host = "127.0.0.1";
const token = "test-token";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0, servers.length)) {
    server.stop(true);
  }
});

function createTestServer(eventBus: EventBus) {
  const runtime = {
    runtimeInfo: {
      pid: 1,
      startedAt: new Date().toISOString(),
      host,
      port: 0,
      version: "test"
    }
  } as never;

  const server = startLocalApiServer({
    runtime,
    token,
    eventBus,
    logger: silentLogger
  });

  servers.push(server);
  return server;
}

async function readSingleLine(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });

  expect(response.ok).toBe(true);
  expect(response.body).not.toBeNull();

  const reader = response.body!.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return Buffer.from(value ?? []).toString("utf8").trim();
}

describe("local API event stream", () => {
  it("omits raw by default", async () => {
    const eventBus = new EventBus();
    const server = createTestServer(eventBus);

    const readPromise = readSingleLine(`http://${host}:${server.port}/events/stream?all=true`);
    await Bun.sleep(25);

    const event: NormalizedEvent = {
      id: "1",
      event: "message.received",
      sessionId: "pessoal",
      timestamp: 1,
      text: "oi",
      raw: {
        bytes: Buffer.from("secret")
      }
    };

    eventBus.publish(event);
    const line = await readPromise;

    expect(line).toContain("\"event\":\"message.received\"");
    expect(line).not.toContain("\"raw\"");
  });

  it("includes raw when requested", async () => {
    const eventBus = new EventBus();
    const server = createTestServer(eventBus);

    const readPromise = readSingleLine(`http://${host}:${server.port}/events/stream?all=true&raw=true`);
    await Bun.sleep(25);

    const event: NormalizedEvent = {
      id: "1",
      event: "message.received",
      sessionId: "pessoal",
      timestamp: 1,
      text: "oi",
      raw: {
        bytes: Buffer.from("secret"),
        count: BigInt(7)
      }
    };

    eventBus.publish(event);
    const line = await readPromise;

    expect(line).toContain("\"raw\"");
    expect(line).toContain("\"type\":\"Buffer\"");
    expect(line).toContain("\"type\":\"BigInt\"");
  });
});

describe("local API send-media route", () => {
  const runtimeInfo = {
    pid: 1,
    startedAt: new Date().toISOString(),
    host,
    port: 0,
    version: "test"
  };

  it("parses the x-media headers, forwards bytes to the runtime and answers JSON", async () => {
    const calls: Array<{ sessionId: string; media: unknown; bytes: number[] }> = [];
    const runtime = {
      runtimeInfo,
      sendMedia: async (
        sessionId: string,
        media: { to: string },
        buffer: Uint8Array
      ) => {
        calls.push({ sessionId, media, bytes: Array.from(buffer) });
        return {
          ok: true,
          sessionId,
          to: media.to,
          jid: `${media.to}@s.whatsapp.net`,
          kind: "image",
          mimeType: "image/jpeg",
          caption: null,
          ptt: false,
          size: buffer.byteLength,
          messageId: "3EB0ROUTE",
          timestamp: 1_785_000_000
        };
      }
    } as never;

    const server = startLocalApiServer({
      runtime,
      token,
      eventBus: new EventBus(),
      logger: silentLogger
    });
    servers.push(server);

    const response = await fetch(`http://${host}:${server.port}/sessions/pessoal/send-media`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-media-to": "556784020665",
        "x-media-kind": "image",
        "x-media-mime": "image/jpeg",
        "x-media-caption": encodeURIComponent("Bom dia"),
        "x-media-file-name": encodeURIComponent("relatorio.pdf")
      },
      body: new Uint8Array([1, 2, 3])
    });

    expect(response.ok).toBe(true);
    const body = (await response.json()) as { ok: boolean; messageId: string };
    expect(body.ok).toBe(true);
    expect(body.messageId).toBe("3EB0ROUTE");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe("pessoal");
    expect(calls[0]?.media).toMatchObject({
      to: "556784020665",
      kind: "image",
      mimeType: "image/jpeg",
      caption: "Bom dia",
      fileName: "relatorio.pdf"
    });
    expect(calls[0]?.bytes).toEqual([1, 2, 3]);
  });

  it("missing mandatory headers answers 400 INVALID_REQUEST without touching the runtime", async () => {
    const runtime = { runtimeInfo, sendMedia: async () => ({}) } as never;
    const server = startLocalApiServer({
      runtime,
      token,
      eventBus: new EventBus(),
      logger: silentLogger
    });
    servers.push(server);

    const response = await fetch(`http://${host}:${server.port}/sessions/pessoal/send-media`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-media-to": "556784020665"
      },
      body: new Uint8Array([1])
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });
});

describe("local API chat operation routes", () => {
  const runtimeInfo = {
    pid: 1,
    startedAt: new Date().toISOString(),
    host,
    port: 0,
    version: "test"
  };

  function createRuntimeWithChatOps(recordCalls: (call: {
    method: string;
    args: unknown[];
  }) => unknown) {
    return {
      runtimeInfo,
      typingIndicator: (...args: unknown[]) => Promise.resolve(recordCalls({ method: "typingIndicator", args })),
      markMessagesRead: (...args: unknown[]) => Promise.resolve(recordCalls({ method: "markMessagesRead", args })),
      reactToMessage: (...args: unknown[]) => Promise.resolve(recordCalls({ method: "reactToMessage", args })),
      deleteMessage: (...args: unknown[]) => Promise.resolve(recordCalls({ method: "deleteMessage", args })),
      sendPoll: (...args: unknown[]) => Promise.resolve(recordCalls({ method: "sendPoll", args }))
    } as never;
  }

  function startWith(runtime: never) {
    const server = startLocalApiServer({
      runtime,
      token,
      eventBus: new EventBus(),
      logger: silentLogger
    });
    servers.push(server);
    return server;
  }

  function post(serverPort: number | undefined, path: string, body: unknown) {
    return fetch(`http://${host}:${serverPort}/sessions/pessoal/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  }

  it("typing forwards chat and recording to the runtime", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const server = startWith(
      createRuntimeWithChatOps((call) => {
        calls.push(call);
        return {
          ok: true,
          sessionId: "pessoal",
          chat: "556784020665",
          jid: "556784020665@s.whatsapp.net",
          recording: true
        };
      })
    );

    const response = await post(server.port, "typing", {
      chat: "556784020665",
      recording: true
    });

    expect(response.ok).toBe(true);
    const body = (await response.json()) as { recording: boolean };
    expect(body.recording).toBe(true);
    expect(calls).toEqual([
      {
        method: "typingIndicator",
        args: ["pessoal", "556784020665", true]
      }
    ]);
  });

  it("read forwards chat and the optional message id", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const server = startWith(
      createRuntimeWithChatOps((call) => {
        calls.push(call);
        return { ok: true, sessionId: "pessoal", chat: "x", jid: "y", messageIds: ["3EB0MSG"] };
      })
    );

    await post(server.port, "read", { chat: "556784020665", messageId: "3EB0MSG" });

    expect(calls[0]?.args).toEqual(["pessoal", "556784020665", "3EB0MSG"]);
  });

  it("react accepts the empty emoji, which removes the reaction", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const server = startWith(
      createRuntimeWithChatOps((call) => {
        calls.push(call);
        return {
          ok: true,
          sessionId: "pessoal",
          chat: "x",
          jid: "y",
          messageId: "3EB0MSG",
          emoji: "",
          removed: true
        };
      })
    );

    const response = await post(server.port, "react", {
      chat: "556784020665",
      messageId: "3EB0MSG",
      emoji: ""
    });

    expect(response.ok).toBe(true);
    expect(calls[0]?.args).toEqual(["pessoal", "556784020665", "3EB0MSG", ""]);
  });

  it("react without emoji field answers 400 INVALID_REQUEST", async () => {
    const server = startWith(createRuntimeWithChatOps(() => ({})));

    const response = await post(server.port, "react", {
      chat: "556784020665",
      messageId: "3EB0MSG"
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("delete forwards chat and message id", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const server = startWith(
      createRuntimeWithChatOps((call) => {
        calls.push(call);
        return {
          ok: true,
          sessionId: "pessoal",
          chat: "x",
          jid: "y",
          messageId: "3EB0MSG",
          fromMe: true
        };
      })
    );

    const response = await post(server.port, "delete", {
      chat: "556784020665",
      messageId: "3EB0MSG"
    });

    expect(response.ok).toBe(true);
    expect(calls[0]?.method).toBe("deleteMessage");
    expect(calls[0]?.args).toEqual(["pessoal", "556784020665", "3EB0MSG"]);
  });

  it("poll forwards question and options to the runtime", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const server = startWith(
      createRuntimeWithChatOps((call) => {
        calls.push(call);
        return {
          ok: true,
          sessionId: "pessoal",
          chat: "x",
          jid: "y",
          question: "Qual?",
          options: ["A", "B"],
          messageId: "3EB0POLL",
          timestamp: 1_785_000_000
        };
      })
    );

    const response = await post(server.port, "poll", {
      chat: "556784020665",
      question: "Qual?",
      options: ["A", "B"]
    });

    expect(response.ok).toBe(true);
    expect(calls[0]?.method).toBe("sendPoll");
    expect(calls[0]?.args).toEqual(["pessoal", "556784020665", "Qual?", ["A", "B"]]);
  });

  it("poll with fewer than two options answers 400 before reaching the runtime", async () => {
    let runtimeTouched = false;
    const runtime = {
      runtimeInfo,
      sendPoll: (..._args: unknown[]) => {
        runtimeTouched = true;
        return Promise.resolve({});
      }
    } as never;
    const server = startWith(runtime);

    const response = await post(server.port, "poll", {
      chat: "556784020665",
      question: "Qual?",
      options: ["unica"]
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(runtimeTouched).toBe(false);
  });
});

describe("local API group operation routes", () => {
  const runtimeInfo = {
    pid: 1,
    startedAt: new Date().toISOString(),
    host,
    port: 0,
    version: "test"
  };

  const groupSnapshot = {
    ok: true,
    sessionId: "pessoal",
    jid: "120345678901-234567890@g.us",
    subject: "Grupo de teste",
    owner: null,
    description: null,
    creation: null,
    size: 1,
    participants: [
      { jid: "556784020665@s.whatsapp.net", name: null, isAdmin: true, isSuperAdmin: true }
    ]
  };

  function startWith(runtime: never) {
    const server = startLocalApiServer({
      runtime,
      token,
      eventBus: new EventBus(),
      logger: silentLogger
    });
    servers.push(server);
    return server;
  }

  function postGroups(serverPort: number | undefined, path: string, body: unknown) {
    return fetch(`http://${host}:${serverPort}/sessions/pessoal/groups/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  }

  it("create forwards subject and participants to the runtime", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const runtime = {
      runtimeInfo,
      createGroup: (...args: unknown[]) => {
        calls.push({ method: "createGroup", args });
        return Promise.resolve(groupSnapshot);
      }
    } as never;
    const server = startWith(runtime as never);

    const response = await postGroups(server.port, "", {
      subject: "Familia",
      participants: ["556784020665"]
    });

    expect(response.ok).toBe(true);
    const body = (await response.json()) as { jid: string };
    expect(body.jid).toBe("120345678901-234567890@g.us");
    expect(calls[0]?.args).toEqual(["pessoal", "Familia", ["556784020665"]]);
  });

  it("create without subject answers 400 before touching the runtime", async () => {
    let runtimeTouched = false;
    const runtime = {
      runtimeInfo,
      createGroup: () => {
        runtimeTouched = true;
        return Promise.resolve({});
      }
    } as never;
    const server = startWith(runtime);

    const response = await postGroups(server.port, "", { participants: [] });

    expect(response.status).toBe(400);
    expect(runtimeTouched).toBe(false);
  });

  it("info decodes the group jid from the path and forwards it", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const runtime = {
      runtimeInfo,
      groupInfo: (...args: unknown[]) => {
        calls.push({ method: "groupInfo", args });
        return Promise.resolve(groupSnapshot);
      }
    } as never;
    const server = startWith(runtime);

    const response = await fetch(
      `http://${host}:${server.port}/sessions/pessoal/groups/${encodeURIComponent(
        "120345678901-234567890@g.us"
      )}`,
      { headers: { authorization: `Bearer ${token}` } }
    );

    expect(response.ok).toBe(true);
    expect(calls[0]?.args).toEqual(["pessoal", "120345678901-234567890@g.us"]);
  });

  it("participants forwards action and participants to the runtime", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const runtime = {
      runtimeInfo,
      updateGroupParticipants: (...args: unknown[]) => {
        calls.push({ method: "updateGroupParticipants", args });
        return Promise.resolve({
          ok: true,
          sessionId: "pessoal",
          jid: "120345678901-234567890@g.us",
          action: "promote",
          updated: ["556784020665@s.whatsapp.net"]
        });
      }
    } as never;
    const server = startWith(runtime);

    const response = await postGroups(
      server.port,
      `${encodeURIComponent("120345678901-234567890@g.us")}/participants`,
      { action: "promote", participants: ["556784020665"] }
    );

    expect(response.ok).toBe(true);
    expect(calls[0]?.args).toEqual([
      "pessoal",
      "120345678901-234567890@g.us",
      "promote",
      ["556784020665"]
    ]);
  });

  it("participants rejects an unknown action with 400", async () => {
    let runtimeTouched = false;
    const runtime = {
      runtimeInfo,
      updateGroupParticipants: () => {
        runtimeTouched = true;
        return Promise.resolve({});
      }
    } as never;
    const server = startWith(runtime);

    const response = await postGroups(
      server.port,
      `${encodeURIComponent("120345678901-234567890@g.us")}/participants`,
      { action: "ban", participants: ["556784020665"] }
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(runtimeTouched).toBe(false);
  });

  it("participants rejects an empty participant list with 400", async () => {
    const runtime = { runtimeInfo } as never;
    const server = startWith(runtime);

    const response = await postGroups(
      server.port,
      `${encodeURIComponent("120345678901-234567890@g.us")}/participants`,
      { action: "add", participants: [] }
    );

    expect(response.status).toBe(400);
  });

  it("leave forwards the group jid to the runtime", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const runtime = {
      runtimeInfo,
      leaveGroup: (...args: unknown[]) => {
        calls.push({ method: "leaveGroup", args });
        return Promise.resolve({
          ok: true,
          sessionId: "pessoal",
          jid: "120345678901-234567890@g.us"
        });
      }
    } as never;
    const server = startWith(runtime);

    const response = await postGroups(
      server.port,
      `${encodeURIComponent("120345678901-234567890@g.us")}/leave`,
      {}
    );

    expect(response.ok).toBe(true);
    expect(calls[0]?.args).toEqual(["pessoal", "120345678901-234567890@g.us"]);
  });
});
