/**
 * Session, authentication, and binding matrix for the Streamable HTTP adapter.
 *
 * SCOPE NOTE: these tests drive `http-session.ts` DIRECTLY rather than through the SDK
 * transport. The screening gate runs BEFORE `transport.handleRequest`, so a direct drive
 * exercises exactly the production path and can assert the port call counts that prove
 * "no verdict caching". End-to-end proof that the gate is actually wired ahead of the
 * transport — and the zero-dispatch obligation — lives in `http-server.test.ts`, which
 * owns a recording dispatch port.
 */
import { describe, expect, it } from "vitest";

import {
  MCP_SESSION_ID_HEADER,
  bindDaemonSession,
  closeDaemonSession,
  createHttpSessionRegistry,
  screenRequest,
} from "./http-session.js";
import type {
  HttpAuthAccepted,
  HttpAuthVerdict,
  HttpSessionPort,
  HttpSessionRegistry,
} from "./http-session.js";

const BEARER_A = "bearer-A-DO-NOT-LOG-3f9c1e77aa";
const BEARER_B = "bearer-B-DO-NOT-LOG-812de40cbb";
const ENDPOINT = "http://127.0.0.1:7391/mcp";

const VERDICT_A: HttpAuthAccepted = Object.freeze({
  ok: true as const,
  principalRef: "principal-a",
  sessionRef: "session-a",
});

const VERDICT_B: HttpAuthAccepted = Object.freeze({
  ok: true as const,
  principalRef: "principal-b",
  sessionRef: "session-b",
});

interface RecordingSessionPort extends HttpSessionPort {
  readonly calls: readonly string[];
}

/** Validate-only fake. `verdicts` is consulted per call, so rotation is expressible. */
function createRecordingSessionPort(
  verdicts: Readonly<Record<string, HttpAuthVerdict>>,
): RecordingSessionPort {
  const calls: string[] = [];
  return {
    bindSession(mcpSessionId: string): void {
      calls.push(`bindSession:${mcpSessionId}`);
    },
    calls,
    closeSession(mcpSessionId: string): void {
      calls.push(`closeSession:${mcpSessionId}`);
    },
    validateBearer(credential: string): HttpAuthVerdict {
      calls.push("validateBearer");
      return verdicts[credential] ?? { code: "AUTHENTICATION_FAILED", ok: false };
    },
  };
}

interface Attachment {
  readonly label: string;
}

function request(init: {
  readonly authorization?: string;
  readonly query?: string;
  readonly sessionId?: string;
}): Request {
  const headers = new Headers();
  if (init.authorization !== undefined) headers.set("authorization", init.authorization);
  if (init.sessionId !== undefined) headers.set(MCP_SESSION_ID_HEADER, init.sessionId);
  return new Request(`${ENDPOINT}${init.query ?? ""}`, { headers, method: "POST" });
}

function registryWith(
  sessionId: string,
  verdict: HttpAuthAccepted,
): HttpSessionRegistry<Attachment> {
  const registry = createHttpSessionRegistry<Attachment>();
  registry.bind(sessionId, verdict, { label: "attached" });
  return registry;
}

async function screen(
  port: HttpSessionPort,
  req: Request,
  registry: HttpSessionRegistry<Attachment> = createHttpSessionRegistry<Attachment>(),
): Promise<Awaited<ReturnType<typeof screenRequest<Attachment>>>> {
  return screenRequest<Attachment>({ port, registry, request: req });
}

describe("http session screening — bearer presence and shape", () => {
  it("refuses a request with no Authorization header without consulting the port", async () => {
    const port = createRecordingSessionPort({});
    const outcome = await screen(port, request({}));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.error.code).toBe("AUTHENTICATION_FAILED");
    expect(port.calls).toEqual([]);
  });

  it.each([
    ["basic scheme", `Basic ${BEARER_A}`],
    ["scheme only", "Bearer"],
    ["no separator", `Bearer${BEARER_A}`],
    ["empty token", "Bearer "],
    ["extra token", `Bearer ${BEARER_A} ${BEARER_B}`],
  ])("refuses a malformed Authorization header (%s) without consulting the port", async (
    _name,
    header,
  ) => {
    const port = createRecordingSessionPort({ [BEARER_A]: VERDICT_A });
    const outcome = await screen(port, request({ authorization: header }));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.error.code).toBe("AUTHENTICATION_FAILED");
    expect(port.calls).toEqual([]);
  });
});

describe("http session screening — port verdicts", () => {
  it("refuses an expired verdict with the registry-bound SESSION_EXPIRED error", async () => {
    const port = createRecordingSessionPort({
      [BEARER_A]: { code: "SESSION_EXPIRED", ok: false },
    });
    const outcome = await screen(port, request({ authorization: `Bearer ${BEARER_A}` }));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.error.code).toBe("SESSION_EXPIRED");
      expect(outcome.error.transport.mcpCode).toBe(-32001);
      expect(outcome.error.recoveryCommands).toEqual(["session.renew", "session.rotate"]);
    }
    expect(port.calls).toEqual(["validateBearer"]);
  });

  it("refuses a revoked verdict with SESSION_REPLAYED", async () => {
    const port = createRecordingSessionPort({
      [BEARER_A]: { code: "SESSION_REPLAYED", ok: false },
    });
    const outcome = await screen(port, request({ authorization: `Bearer ${BEARER_A}` }));
    expect(outcome.kind === "refused" ? outcome.error.code : "").toBe("SESSION_REPLAYED");
  });

  it("fails closed to AUTHENTICATION_FAILED when the port returns a code outside the vocabulary", async () => {
    const port = createRecordingSessionPort({
      [BEARER_A]: { code: "STORAGE_DEGRADED", ok: false } as unknown as HttpAuthVerdict,
    });
    const outcome = await screen(port, request({ authorization: `Bearer ${BEARER_A}` }));
    expect(outcome.kind === "refused" ? outcome.error.code : "").toBe("AUTHENTICATION_FAILED");
  });

  it("accepts a valid bearer with no session header and reports no bound entry", async () => {
    const port = createRecordingSessionPort({ [BEARER_A]: VERDICT_A });
    const outcome = await screen(port, request({ authorization: `Bearer ${BEARER_A}` }));
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind === "accepted") {
      expect(outcome.sessionId).toBeNull();
      expect(outcome.entry).toBeUndefined();
      expect(outcome.verdict).toEqual(VERDICT_A);
    }
  });

  it("hands the validated credential back so no caller re-parses the header", async () => {
    const port = createRecordingSessionPort({ [BEARER_A]: VERDICT_A });
    const outcome = await screen(port, request({ authorization: `Bearer ${BEARER_A}` }));
    expect(outcome.kind === "accepted" ? outcome.credential : "").toBe(BEARER_A);
  });
});

describe("http session screening — Mcp-Session-Id binding", () => {
  it("reports an unknown Mcp-Session-Id as unknown-session, never as accepted", async () => {
    const port = createRecordingSessionPort({ [BEARER_A]: VERDICT_A });
    const outcome = await screen(
      port,
      request({ authorization: `Bearer ${BEARER_A}`, sessionId: "mcp-session-absent" }),
    );
    expect(outcome.kind).toBe("unknown-session");
    if (outcome.kind === "unknown-session") expect(outcome.sessionId).toBe("mcp-session-absent");
  });

  it("refuses bearer A presented with a session bound to bearer B", async () => {
    const port = createRecordingSessionPort({ [BEARER_A]: VERDICT_A, [BEARER_B]: VERDICT_B });
    const registry = registryWith("mcp-session-b", VERDICT_B);
    const outcome = await screen(
      port,
      request({ authorization: `Bearer ${BEARER_A}`, sessionId: "mcp-session-b" }),
      registry,
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.error.code).toBe("SESSION_REPLAYED");
    expect(registry.get("mcp-session-b")?.verdict).toEqual(VERDICT_B);
  });

  it("routes a matching bearer to the attachment bound to its session", async () => {
    const port = createRecordingSessionPort({ [BEARER_B]: VERDICT_B });
    const registry = registryWith("mcp-session-b", VERDICT_B);
    const outcome = await screen(
      port,
      request({ authorization: `Bearer ${BEARER_B}`, sessionId: "mcp-session-b" }),
      registry,
    );
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind === "accepted") expect(outcome.entry?.attachment.label).toBe("attached");
  });

  it("refuses when only the principal differs, not just the session reference", async () => {
    const port = createRecordingSessionPort({
      [BEARER_A]: { ok: true, principalRef: "principal-other", sessionRef: "session-b" },
    });
    const registry = registryWith("mcp-session-b", VERDICT_B);
    const outcome = await screen(
      port,
      request({ authorization: `Bearer ${BEARER_A}`, sessionId: "mcp-session-b" }),
      registry,
    );
    expect(outcome.kind === "refused" ? outcome.error.code : "").toBe("SESSION_REPLAYED");
  });
});

describe("http session screening — rotation revocation and revalidation", () => {
  it("revalidates on every request and never caches a verdict", async () => {
    const port = createRecordingSessionPort({ [BEARER_A]: VERDICT_A });
    const registry = registryWith("mcp-session-a", VERDICT_A);
    for (let index = 0; index < 3; index += 1) {
      const outcome = await screen(
        port,
        request({ authorization: `Bearer ${BEARER_A}`, sessionId: "mcp-session-a" }),
        registry,
      );
      expect(outcome.kind).toBe("accepted");
    }
    expect(port.calls).toEqual(["validateBearer", "validateBearer", "validateBearer"]);
  });

  it("refuses the old credential on the very next request after rotation while the binding survives", async () => {
    const rotated: Record<string, HttpAuthVerdict> = {
      [BEARER_A]: VERDICT_A,
      [BEARER_B]: { code: "AUTHENTICATION_FAILED", ok: false },
    };
    const port = createRecordingSessionPort(rotated);
    const registry = registryWith("mcp-session-a", VERDICT_A);

    const before = await screen(
      port,
      request({ authorization: `Bearer ${BEARER_A}`, sessionId: "mcp-session-a" }),
      registry,
    );
    expect(before.kind).toBe("accepted");

    // The daemon rotates: the OLD credential dies, the NEW one carries the SAME session.
    rotated[BEARER_A] = { code: "SESSION_EXPIRED", ok: false };
    rotated[BEARER_B] = { ok: true, principalRef: "principal-a", sessionRef: "session-a" };

    const oldCredential = await screen(
      port,
      request({ authorization: `Bearer ${BEARER_A}`, sessionId: "mcp-session-a" }),
      registry,
    );
    expect(oldCredential.kind === "refused" ? oldCredential.error.code : "").toBe("SESSION_EXPIRED");

    const newCredential = await screen(
      port,
      request({ authorization: `Bearer ${BEARER_B}`, sessionId: "mcp-session-a" }),
      registry,
    );
    expect(newCredential.kind).toBe("accepted");
    expect(registry.get("mcp-session-a")?.attachment.label).toBe("attached");
  });
});

describe("http session screening — credentials never ride in the URL", () => {
  it.each([
    ["token", "?token=leaked-value"],
    ["access_token", "?access_token=leaked-value"],
    ["sessionCredential", "?sessionCredential=leaked-value"],
    ["api-key", "?api-key=leaked-value"],
    ["bearer", "?bearer=leaked-value"],
    ["benign param", "?page=2"],
  ])("refuses a request carrying a query parameter (%s) before consulting the port", async (
    _name,
    query,
  ) => {
    const port = createRecordingSessionPort({ [BEARER_A]: VERDICT_A });
    const outcome = await screen(
      port,
      request({ authorization: `Bearer ${BEARER_A}`, query }),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.error.code).toBe("INPUT_INVALID");
      expect(JSON.stringify(outcome.error)).not.toContain("leaked-value");
    }
    expect(port.calls).toEqual([]);
  });
});

describe("http session screening — redaction", () => {
  it("never echoes the presented credential on any refusal path", async () => {
    const port = createRecordingSessionPort({
      [BEARER_A]: { code: "SESSION_EXPIRED", ok: false },
    });
    const registry = registryWith("mcp-session-b", VERDICT_B);
    const outcomes = await Promise.all([
      screen(port, request({})),
      screen(port, request({ authorization: `Basic ${BEARER_A}` })),
      screen(port, request({ authorization: `Bearer ${BEARER_A}` })),
      screen(port, request({ authorization: `Bearer ${BEARER_A}`, query: `?token=${BEARER_A}` })),
      screen(
        port,
        request({ authorization: `Bearer ${BEARER_B}`, sessionId: "mcp-session-b" }),
        registry,
      ),
    ]);
    for (const outcome of outcomes) {
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(BEARER_A);
      expect(serialized).not.toContain(BEARER_B);
    }
  });
});

describe("http session lifecycle", () => {
  it("binds the daemon session through the port before the entry becomes routable", async () => {
    const port = createRecordingSessionPort({ [BEARER_A]: VERDICT_A });
    const registry = createHttpSessionRegistry<Attachment>();
    await bindDaemonSession(registry, port, "mcp-session-new", VERDICT_A, { label: "fresh" });
    expect(port.calls).toEqual(["bindSession:mcp-session-new"]);
    expect(registry.get("mcp-session-new")?.verdict).toEqual(VERDICT_A);
  });

  it("leaves no routable entry when the port refuses to bind", async () => {
    const port: HttpSessionPort = {
      bindSession(): never {
        throw new Error("daemon refused the bind");
      },
      closeSession(): void {},
      validateBearer(): HttpAuthVerdict {
        return VERDICT_A;
      },
    };
    const registry = createHttpSessionRegistry<Attachment>();
    await expect(
      bindDaemonSession(registry, port, "mcp-session-new", VERDICT_A, { label: "fresh" }),
    ).rejects.toThrow();
    expect(registry.get("mcp-session-new")).toBeUndefined();
  });

  it("reaps the entry and notifies the port on close", async () => {
    const port = createRecordingSessionPort({ [BEARER_A]: VERDICT_A });
    const registry = registryWith("mcp-session-a", VERDICT_A);
    await closeDaemonSession(registry, port, "mcp-session-a");
    expect(registry.get("mcp-session-a")).toBeUndefined();
    expect(port.calls).toEqual(["closeSession:mcp-session-a"]);
  });

  it("makes a reaped session unroutable on the next request", async () => {
    const port = createRecordingSessionPort({ [BEARER_A]: VERDICT_A });
    const registry = registryWith("mcp-session-a", VERDICT_A);
    await closeDaemonSession(registry, port, "mcp-session-a");
    const outcome = await screen(
      port,
      request({ authorization: `Bearer ${BEARER_A}`, sessionId: "mcp-session-a" }),
      registry,
    );
    expect(outcome.kind).toBe("unknown-session");
  });
});
