import { createHash } from "node:crypto";
import { request as nodeHttpRequest } from "node:http";

import { SqliteEventStore } from "@moe/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { readLatestDocumentWorkDossier } from "../documents/document-work-service.js";
import { MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES } from "../documents/document-source-contract.js";
import { createDocumentIngestPort } from "./document-ingest-route.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { AuthenticationResult, CommandAdapterDeps } from "./http-contract.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";

/**
 * Drives the REAL listener over http, with the REAL ingest wired to an ephemeral store, so the
 * INGESTED frame the operator sees is the one `ingestDocument` produces rather than a hand-shaped
 * fixture. The dossier route is composed over the same store, so the recorded source text can be
 * read back through the transport too.
 */

const PROJECT = "proj-document-ingest";
const CSRF = "document-ingest-csrf";
const OPERATOR_CREDENTIAL = "document-ingest-operator";
const WORK_CREDENTIAL = "document-ingest-work";
const FOREIGN_ADMIN_CREDENTIAL = "document-ingest-foreign-admin";

const MARKDOWN = "# Build the widget\n\nAn operator dropped this PRD in the browser.\n";

function sha256Of(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);

function authentication(credential: string | null): AuthenticationResult {
  if (credential === OPERATOR_CREDENTIAL) {
    return {
      principal: {
        capabilities: [CAPABILITIES.ADMIN, CAPABILITIES.WORK],
        principalId: "operator-local", projectId: PROJECT,
      },
      verdict: "AUTHENTICATED",
    };
  }
  if (credential === WORK_CREDENTIAL) {
    return {
      principal: {
        capabilities: [CAPABILITIES.WORK], principalId: "agent-work-1", projectId: PROJECT,
      },
      verdict: "AUTHENTICATED",
    };
  }
  // An ADMIN principal bound to ANOTHER project: the operator-only capability alone must not
  // let a session cross the project boundary the port is bound to.
  if (credential === FOREIGN_ADMIN_CREDENTIAL) {
    return {
      principal: {
        capabilities: [CAPABILITIES.ADMIN, CAPABILITIES.WORK],
        principalId: "operator-foreign", projectId: "proj-other",
      },
      verdict: "AUTHENTICATED",
    };
  }
  return { verdict: "UNAUTHENTICATED" };
}

const deps: CommandAdapterDeps = {
  authenticator: { authenticate: authentication },
  decisions: {
    decide: (): never => { throw new Error("document ingest must not enter the decision port"); },
  },
  registry: {
    get: (): never => { throw new Error("document ingest must not enter the command registry"); },
  } as unknown as CommandAdapterDeps["registry"],
};

let listener: ControlRoomListener;

beforeAll(async () => {
  const candidate = await startControlRoomListener({
    csrfToken: CSRF,
    deps,
    documentDossiers: {
      readLatest: (projectId: string) => readLatestDocumentWorkDossier(store, projectId),
    },
    documentIngest: createDocumentIngestPort({
      clock: () => "2026-08-22T12:00:00.000Z",
      mintCorrelationId: () => "document-ingest-correlation-1",
      projectId: PROJECT,
      store,
    }),
  });
  if (!candidate.ok) throw new Error(`listener failed: ${candidate.code}`);
  listener = candidate;
});

afterAll(async () => {
  await listener.close();
  store.close();
});

interface Reply {
  readonly body: Record<string, unknown>;
  readonly status: number;
}

async function send(
  endpoint: { readonly origin: string; readonly port: number },
  options: {
    readonly body?: Buffer | string;
    readonly credential?: string | null;
    readonly method?: string;
    readonly origin?: string;
    readonly path?: string;
  } = {},
): Promise<Reply> {
  const payload = options.body ?? JSON.stringify({
    displayPath: "docs/prd.md", mediaType: "text/markdown", text: MARKDOWN,
  });
  const headers: Record<string, string | number> = {
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json",
    host: `127.0.0.1:${endpoint.port}`,
    origin: options.origin ?? endpoint.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  };
  if (options.credential !== null) {
    headers["x-moe-session-credential"] = options.credential ?? OPERATOR_CREDENTIAL;
  }
  return await new Promise<Reply>((resolve, reject) => {
    const request = nodeHttpRequest({
      headers, host: "127.0.0.1", method: options.method ?? "POST",
      path: options.path ?? "/documents/ingest", port: endpoint.port, setHost: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

const HEX64 = /^[0-9a-f]{64}$/u;

describe("POST /documents/ingest", () => {
  it("ingests an operator PRD and records source text the dossier route reads back", async () => {
    const reply = await send(listener);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      advisoryOnly: true, authority: "NONE", ok: true, outcome: "INGESTED",
    });
    expect(reply.body["contentSha256"]).toBe(sha256Of(MARKDOWN));
    expect(reply.body["contentSha256"]).toMatch(HEX64);
    const proposal = reply.body["proposal"] as Record<string, unknown>;
    expect((proposal["sources"] as unknown[]).length).toBe(1);
    expect((proposal["candidates"] as Record<string, unknown>[])[0]?.["title"]).toBe(
      "Build the widget",
    );

    const dossier = await send(listener, { path: "/documents/dossier/read", body: "{}" });
    expect(dossier.status).toBe(200);
    expect(dossier.body["outcome"]).toBe("DOSSIER");
    const source = dossier.body["source"] as Record<string, unknown>;
    expect(source["contentSha256"]).toBe(sha256Of(MARKDOWN));
    expect(source["excerpt"]).toContain("Build the widget");
  });

  it("refuses a WORK-only agent principal that lacks the ADMIN capability", async () => {
    const reply = await send(listener, { credential: WORK_CREDENTIAL });
    expect(reply.status).toBe(200);
    expect(reply.body).toStrictEqual({
      code: "DOCUMENT_INGEST_CAPABILITY_DENIED", layer: "DOCUMENT_INGEST_ROUTE", outcome: "REFUSED",
    });
  });

  it("refuses an ADMIN principal bound to a foreign project", async () => {
    const reply = await send(listener, { credential: FOREIGN_ADMIN_CREDENTIAL });
    expect(reply.status).toBe(200);
    expect(reply.body).toStrictEqual({
      code: "DOCUMENT_INGEST_PROJECT_MISMATCH", layer: "DOCUMENT_INGEST_ROUTE", outcome: "REFUSED",
    });
  });

  it("refuses an unauthenticated ingest before touching the port", async () => {
    const reply = await send(listener, { credential: null });
    expect(reply.status).toBe(401);
    expect(reply.body).toMatchObject({
      error: { code: "AUTHENTICATION_FAILED" }, ok: false, outcome: "REFUSED", stage: "AUTHENTICATE",
    });
  });

  it("refuses a foreign Origin ahead of the ingest", async () => {
    const reply = await send(listener, { origin: "http://attacker.invalid" });
    expect(reply.status).toBe(403);
    expect(reply.body).toStrictEqual({
      code: "LISTENER_ORIGIN_INVALID", layer: "CONTROL_ROOM_LISTENER",
    });
  });

  it("forwards an oversize payload to the ingest, surfacing its coded refusal at 200", async () => {
    const oversize = "a".repeat(MAX_DOCUMENT_INGEST_TEXT_UTF8_BYTES + 1);
    const reply = await send(listener, {
      body: JSON.stringify({ displayPath: "big.md", mediaType: "text/markdown", text: oversize }),
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      code: "DOCUMENT_WORK_INGEST_TEXT_TOO_LARGE", layer: "DAEMON_INGRESS", ok: false,
      outcome: "REFUSED",
    });
  });

  it("forwards a malformed payload to the ingest, surfacing PAYLOAD_INVALID at 200", async () => {
    const reply = await send(listener, {
      body: JSON.stringify({ displayPath: "docs/prd.md", mediaType: "text/markdown" }),
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      code: "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID", layer: "DAEMON_INGRESS", ok: false,
      outcome: "REFUSED",
    });
  });

  it("refuses an unparseable body with the listener's own 400", async () => {
    const reply = await send(listener, { body: Buffer.from([0x7b, 0xff, 0xfe]) });
    expect(reply.status).toBe(400);
    expect(reply.body).toStrictEqual({
      code: "LISTENER_DOCUMENT_INGEST_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER",
    });
  });

  it("accepts the ingest route only as POST", async () => {
    const reply = await send(listener, { method: "GET" });
    expect(reply.status).toBe(400);
    expect(reply.body).toStrictEqual({
      code: "LISTENER_DOCUMENT_INGEST_REQUEST_INVALID", layer: "CONTROL_ROOM_LISTENER",
    });
  });

  it("refuses an absent ingest port with 503 only after successful authentication", async () => {
    const bare = await startControlRoomListener({ csrfToken: CSRF, deps });
    if (!bare.ok) throw new Error(`listener failed: ${bare.code}`);
    try {
      const absent = await send(bare);
      expect(absent.status).toBe(503);
      expect(absent.body).toStrictEqual({
        code: "LISTENER_DOCUMENT_INGEST_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER",
      });
      const unauthenticated = await send(bare, { credential: null });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.body).toMatchObject({ stage: "AUTHENTICATE" });
    } finally {
      await bare.close();
    }
  });
});
