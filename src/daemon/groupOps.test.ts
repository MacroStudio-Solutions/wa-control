import { describe, expect, it } from "bun:test";
import type { GroupMetadata } from "@whiskeysockets/baileys";
import {
  assertGroupJid,
  assertGroupSubject,
  explainParticipantStatus,
  mapGroupOpError,
  normalizeParticipantInputs,
  serializeGroupSnapshot,
  summarizeParticipantUpdate
} from "./groupOps.ts";

function boomLike(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), {
    output: { statusCode, payload: { message } }
  });
}

function groupMetadata(patch: Partial<GroupMetadata> = {}): GroupMetadata {
  return {
    id: "120345678901-234567890@g.us",
    owner: "5511999999999:11@s.whatsapp.net",
    subject: "Grupo de teste",
    subjectOwner: "5511999999999:11@s.whatsapp.net",
    subjectTime: 1_785_000_000,
    creation: 1_784_000_000,
    desc: "descricao",
    participants: [
      {
        id: "5511999999999:11@s.whatsapp.net",
        notify: "Dono",
        admin: "superadmin"
      },
      {
        id: "556784020665@s.whatsapp.net",
        name: "Priscila",
        admin: null
      }
    ]
  } as GroupMetadata;
}

describe("assertGroupSubject", () => {
  it("accepts a non-empty subject", () => {
    expect(() => assertGroupSubject("Familia")).not.toThrow();
  });

  it("rejects a blank subject before any network contact", () => {
    expect(() => assertGroupSubject("")).toThrow(/assunto/);
    expect(() => assertGroupSubject("   ")).toThrow(/assunto/);
  });
});

describe("normalizeParticipantInputs", () => {
  it("converts bare numbers to WhatsApp jids, ignoring formatting", () => {
    expect(normalizeParticipantInputs(["556784020665"])).toEqual([
      "556784020665@s.whatsapp.net"
    ]);
    expect(normalizeParticipantInputs(["+55 (67) 8402-0665"])).toEqual([
      "556784020665@s.whatsapp.net"
    ]);
  });

  it("keeps a jid that is already complete", () => {
    expect(normalizeParticipantInputs(["556784020665:11@s.whatsapp.net"])).toEqual([
      "556784020665:11@s.whatsapp.net"
    ]);
  });

  it("rejects an empty list before any network contact", () => {
    expect(() => normalizeParticipantInputs([])).toThrow(/ao menos um/);
  });

  it("rejects entries without at least 8 digits", () => {
    expect(() => normalizeParticipantInputs(["123"])).toThrow(/Participante invalido/);
    expect(() => normalizeParticipantInputs(["556784020665", "  "])).toThrow(
      /Participante invalido/
    );
  });
});

describe("assertGroupJid", () => {
  it("accepts a group jid", () => {
    expect(() => assertGroupJid("120345678901-234567890@g.us")).not.toThrow();
  });

  it("rejects an input without @ with an actionable hint", () => {
    expect(() => assertGroupJid("120345678901-234567890")).toThrow(/@g\.us/);
    expect(() => assertGroupJid("")).toThrow(/@g\.us/);
  });
});

describe("mapGroupOpError", () => {
  it("maps each operation to its own fallback error class at 502", () => {
    const generic = new Error("Connection Closed");

    expect(mapGroupOpError("create", generic).code).toBe("GROUP_CREATE_FAILED");
    expect(mapGroupOpError("info", generic).code).toBe("GROUP_INFO_FAILED");
    expect(mapGroupOpError("add", generic).code).toBe("GROUP_ADD_FAILED");
    expect(mapGroupOpError("remove", generic).code).toBe("GROUP_REMOVE_FAILED");
    expect(mapGroupOpError("promote", generic).code).toBe("GROUP_PROMOTE_FAILED");
    expect(mapGroupOpError("demote", generic).code).toBe("GROUP_DEMOTE_FAILED");
    expect(mapGroupOpError("leave", generic).code).toBe("GROUP_LEAVE_FAILED");
    expect(mapGroupOpError("leave", generic).status).toBe(502);
  });

  it("maps item-not-found (404) to GROUP_NOT_FOUND with a jid hint", () => {
    const error = mapGroupOpError("info", boomLike(404, "item-not-found"), {
      groupJid: "9999-0000@g.us"
    });

    expect(error.code).toBe("GROUP_NOT_FOUND");
    expect(error.message).toContain("9999-0000@g.us");
    expect(error.message).toContain("@g.us");
    expect(error.details).toMatchObject({ waStatusCode: 404 });
  });

  it("maps forbidden (403) to GROUP_NOT_ALLOWED with the admin hint for moderation ops", () => {
    const error = mapGroupOpError(
      "promote",
      boomLike(403, "forbidden (notInGroup)"),
      { groupJid: "120345678901-234567890@g.us" }
    );

    expect(error.code).toBe("GROUP_NOT_ALLOWED");
    expect(error.message).toContain("promover a admin");
    expect(error.message).toContain("admin");
  });

  it("maps forbidden for info to the participation hint", () => {
    const error = mapGroupOpError("info", boomLike(403, "forbidden (notInGroup)"), {
      groupJid: "120345678901-234567890@g.us"
    });

    expect(error.code).toBe("GROUP_NOT_ALLOWED");
    expect(error.message).toContain("participar");
  });

  it("keeps the Baileys message as the cause in the fallback text", () => {
    const error = mapGroupOpError("leave", new Error("Connection Closed"));

    expect(error.message).toContain("sair do grupo");
    expect(error.message).toContain("Connection Closed");
  });

  it("survives non-error throwables", () => {
    const error = mapGroupOpError("create", "boom");

    expect(error.message).toContain("Erro desconhecido na Baileys");
  });
});

describe("explainParticipantStatus", () => {
  it("names the already-present conflict for add with 409", () => {
    const reason = explainParticipantStatus("add", "409");

    expect(reason).toContain("ja participa");
  });

  it("names the privacy refusal for add with 403 and suggests the invite", () => {
    const reason = explainParticipantStatus("add", "403");

    expect(reason).toContain("privacidade");
    expect(reason).toContain("convid");
  });

  it("names the missing admin permission for moderation ops with 403", () => {
    const reason = explainParticipantStatus("promote", "403");

    expect(reason).toContain("admin");
  });

  it("names the recent-removal block for add with 408", () => {
    const reason = explainParticipantStatus("add", "408");

    expect(reason).toContain("convite");
  });

  it("reports the WhatsApp server failure for 500", () => {
    expect(explainParticipantStatus("remove", "500")).toContain("servidor");
  });

  it("stays honest about unknown statuses", () => {
    expect(explainParticipantStatus("demote", "599")).toContain("599");
  });
});

describe("summarizeParticipantUpdate", () => {
  it("splits successes from failures with actionable reasons", () => {
    const summary = summarizeParticipantUpdate("add", [
      { status: "200", jid: "556784020665@s.whatsapp.net" },
      { status: "409", jid: "5511999999999@s.whatsapp.net" },
      { status: "403", jid: undefined }
    ]);

    expect(summary.updated).toEqual(["556784020665@s.whatsapp.net"]);
    expect(summary.failures).toHaveLength(2);
    expect(summary.failures[0]).toMatchObject({
      jid: "5511999999999@s.whatsapp.net",
      status: "409"
    });
    expect(summary.failures[0]?.reason).toContain("ja participa");
    expect(summary.failures[1]?.jid).toBeNull();
    expect(summary.failures[1]?.status).toBe("403");
  });

  it("returns no failures when every participant succeeded", () => {
    const summary = summarizeParticipantUpdate("promote", [
      { status: "200", jid: "556784020665@s.whatsapp.net" }
    ]);

    expect(summary.updated).toEqual(["556784020665@s.whatsapp.net"]);
    expect(summary.failures).toEqual([]);
  });
});

describe("serializeGroupSnapshot", () => {
  it("maps the Baileys metadata into the flat CLI response shape", () => {
    const response = serializeGroupSnapshot("pessoal", groupMetadata());

    expect(response).toMatchObject({
      ok: true,
      sessionId: "pessoal",
      jid: "120345678901-234567890@g.us",
      subject: "Grupo de teste",
      owner: "5511999999999:11@s.whatsapp.net",
      description: "descricao",
      creation: 1_784_000_000,
      size: 2
    });
    expect(response.participants).toEqual([
      {
        jid: "5511999999999:11@s.whatsapp.net",
        name: "Dono",
        isAdmin: true,
        isSuperAdmin: true
      },
      {
        jid: "556784020665@s.whatsapp.net",
        name: "Priscila",
        isAdmin: false,
        isSuperAdmin: false
      }
    ]);
  });

  it("tolerates absent optional metadata", () => {
    const metadata = groupMetadata();
    delete (metadata as Partial<GroupMetadata>).desc;
    delete (metadata as Partial<GroupMetadata>).creation;
    metadata.owner = undefined;
    metadata.participants = [];

    const response = serializeGroupSnapshot("pessoal", metadata);

    expect(response.owner).toBeNull();
    expect(response.description).toBeNull();
    expect(response.creation).toBeNull();
    expect(response.size).toBe(0);
    expect(response.participants).toEqual([]);
  });
});
