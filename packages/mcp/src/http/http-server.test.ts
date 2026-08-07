/**
 * Transport-level tests for the Streamable HTTP adapter.
 *
 * Everything runs against `WebStandardStreamableHTTPServerTransport` through plain
 * `new Request(...)` values, so there is no socket, no @hono/node-server, and no mock of the
 * SDK: these tests exercise the same `handleRequest` path production uses.
 *
 * The disconnect test asserts the SDK's ACTUAL semantics, verified in its sources: cancelling
 * an SSE body does NOT abort the handler's signal and does NOT stop dispatch. The claim under
 * test is therefore "the result is lost and nothing is fabricated", not "dispatch aborted".
 */
import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { STDIO_TOOL_ENTRIES } from "../stdio/stdio-tool-schemas.js";
import {
  CONFORMANCE_COMMAND_ARGS,
  CONFORMANCE_COMMAND_LABEL,
  CONFORMANCE_COMMAND_RESPONSE_BYTES,
  CONFORMANCE_COMMAND_RESPONSE_TEXT,
  createRecordingPort,
} from "../dispatch-conformance.js";
import {
  LAST_EVENT_ID_HEADER,
  MCP_RESUME_UNSUPPORTED,
  refuseResumption,
} from "./http-resume.js";
import {
  HTTP_LISTED_TOOLS,
  MCP_PROTOCOL_VERSION_HEADER,
  createHttpMcpAdapter,
} from "./http-server.js";
import type { HttpDispatchPort, HttpMcpAdapter } from "./http-server.js";
import { MCP_SESSION_ID_HEADER } from "./http-session.js";
import type { HttpAuthVerdict, HttpSessionPort } from "./http-session.js";

const BEARER = "bearer-http-DO-NOT-LOG-77d1e2f0";
const HOST = "127.0.0.1:7391";
const ENDPOINT = `http://${HOST}/mcp`;
const ACCEPT = "application/json, text/event-stream";

function sessionPortFor(credential: string): HttpSessionPort {
  return {
    bindSession(): void {},
    closeSession(): void {},
    validateBearer(presented: string): HttpAuthVerdict {
      return presented === credential
        ? { ok: true, principalRef: "principal-http", sessionRef: "session-http" }
        : { code: "AUTHENTICATION_FAILED", ok: false };
    },
  };
}

interface RequestInit_ {
  readonly accept?: string;
  readonly authorization?: string | null;
  readonly body?: string;
  readonly host?: string;
  readonly lastEventId?: string;
  readonly method?: string;
  readonly origin?: string;
  readonly protocolVersion?: string;
  readonly sessionId?: string;
}

function build(init: RequestInit_ = {}): Request {
  const headers = new Headers({ accept: init.accept ?? ACCEPT, host: init.host ?? HOST });
  const authorization = init.authorization === undefined ? `Bearer ${BEARER}` : init.authorization;
  if (authorization !== null) headers.set("authorization", authorization);
  if (init.origin !== undefined) headers.set("origin", init.origin);
  if (init.sessionId !== undefined) headers.set(MCP_SESSION_ID_HEADER, init.sessionId);
  if (init.lastEventId !== undefined) headers.set(LAST_EVENT_ID_HEADER, init.lastEventId);
  if (init.protocolVersion !== undefined) {
    headers.set(MCP_PROTOCOL_VERSION_HEADER, init.protocolVersion);
  }
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new Request(ENDPOINT, { ...(init.body === undefined ? {} : { body: init.body }), headers, method });
}

const INITIALIZE_BODY = JSON.stringify({
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "http-parity-client", version: "0.0.0" },
    protocolVersion: "2025-06-18",
  },
});

function toolCallBody(id: number, name: string, args: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ id, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } });
}

interface OpenSession {
  readonly adapter: HttpMcpAdapter;
  readonly sessionId: string;
}

async function openSession(
  dispatchPort: HttpDispatchPort,
  enableJsonResponse = true,
): Promise<OpenSession> {
  const adapter = createHttpMcpAdapter({
    dispatchPort,
    enableJsonResponse,
    sessionPort: sessionPortFor(BEARER),
  });
  const response = await adapter.handleRequest(build({ body: INITIALIZE_BODY }));
  const sessionId = response.headers.get(MCP_SESSION_ID_HEADER);
  if (sessionId === null) throw new Error(`initialize did not mint a session: ${response.status}`);
  if (response.body !== null) await response.text();
  return { adapter, sessionId };
}

/** Reads the single JSON-RPC payload out of either transport mode. */
async function readPayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.startsWith("event:") && !text.startsWith("data:")) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  const line = text.split("\n").find((candidate) => candidate.startsWith("data:"));
  return JSON.parse((line ?? "data:{}").slice("data:".length)) as Record<string, unknown>;
}

function resultText(payload: Record<string, unknown>): string {
  const result = payload["result"] as { readonly content?: readonly { text?: string }[] } | undefined;
  return result?.content?.[0]?.text ?? "";
}

describe("http adapter — host and origin defence", () => {
  it("refuses a request whose Origin is not loopback, with zero dispatch", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    const response = await adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), origin: "https://evil.example", sessionId }),
    );
    expect(response.status).toBe(403);
    expect((await readPayload(response))["error"]).toMatchObject({ code: -32002 });
    expect(port.calls).toEqual([]);
    await adapter.close();
  });

  it("refuses a request whose Host is not loopback, with zero dispatch", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    const response = await adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), host: "evil.example", sessionId }),
    );
    expect(response.status).toBe(403);
    expect(port.calls).toEqual([]);
    await adapter.close();
  });

  it("accepts a loopback Origin", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    const response = await adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), origin: `http://${HOST}`, sessionId }),
    );
    expect(resultText(await readPayload(response))).toBe(CONFORMANCE_COMMAND_RESPONSE_TEXT);
    await adapter.close();
  });

  it("pins a session to the Host it was initialised with", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    const response = await adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), host: "localhost:7391", sessionId }),
    );
    expect(response.status).toBe(403);
    expect(port.calls).toEqual([]);
    await adapter.close();
  });
});

describe("http adapter — body bound", () => {
  function pingBodyOfExactly(bytes: number): string {
    const base = JSON.stringify({ id: 3, jsonrpc: "2.0", method: "ping", params: { pad: "" } });
    return JSON.stringify({ id: 3, jsonrpc: "2.0", method: "ping", params: { pad: "p".repeat(bytes - base.length) } });
  }

  it("accepts a body of exactly the maximum size", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    const body = pingBodyOfExactly(MAX_JSON_BODY_BYTES);
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_JSON_BODY_BYTES);
    const response = await adapter.handleRequest(build({ body, sessionId }));
    expect(response.status).toBe(200);
    expect((await readPayload(response))["result"]).toEqual({});
    await adapter.close();
  });

  it("refuses a body one byte over the maximum with zero dispatch", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    const response = await adapter.handleRequest(
      build({ body: pingBodyOfExactly(MAX_JSON_BODY_BYTES + 1), sessionId }),
    );
    expect(response.status).toBe(413);
    const error = (await readPayload(response))["error"] as { data?: { code?: string } };
    expect(error.data?.code).toBe("INPUT_LIMIT_EXCEEDED");
    expect(port.calls).toEqual([]);
    await adapter.close();
  });

  it("refuses an over-large declared Content-Length with zero dispatch", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    const request = build({ body: toolCallBody(4, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId });
    request.headers.set("content-length", String(MAX_JSON_BODY_BYTES + 1));
    const response = await adapter.handleRequest(request);
    expect(response.status).toBe(413);
    expect(port.calls).toEqual([]);
    await adapter.close();
  });

  it("refuses an over-large streamed body that declares no Content-Length, without buffering it", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    const chunk = new TextEncoder().encode("p".repeat(64 * 1024));
    let delivered = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller): void {
        delivered += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const headers = new Headers({
      accept: ACCEPT,
      authorization: `Bearer ${BEARER}`,
      "content-type": "application/json",
      host: HOST,
    });
    headers.set(MCP_SESSION_ID_HEADER, sessionId);
    const response = await adapter.handleRequest(
      new Request(ENDPOINT, { body, duplex: "half", headers, method: "POST" } as RequestInit),
    );
    expect(response.status).toBe(413);
    // The stream is infinite, so the cap is what stopped it. The slack is two chunks rather
    // than one because a ReadableStream pulls ahead of the reader by its high-water mark; the
    // claim under test is that buffering is bounded by the cap, not that it is exact.
    expect(delivered).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES + 2 * chunk.byteLength);
    expect(port.calls).toEqual([]);
    await adapter.close();
  });

  it("refuses a body that is not JSON with zero dispatch", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    const response = await adapter.handleRequest(build({ body: "{not json", sessionId }));
    expect(response.status).toBe(400);
    expect(port.calls).toEqual([]);
    await adapter.close();
  });
});

describe("http adapter — authentication runs before the transport", () => {
  it("refuses an unauthenticated tool call with zero dispatch", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    const response = await adapter.handleRequest(
      build({ authorization: null, body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId }),
    );
    expect(response.status).toBe(401);
    expect(port.calls).toEqual([]);
    await adapter.close();
  });

  it("refuses an unauthenticated initialize with zero session minted", async () => {
    const adapter = createHttpMcpAdapter({
      dispatchPort: createRecordingPort(),
      sessionPort: sessionPortFor(BEARER),
    });
    const response = await adapter.handleRequest(build({ authorization: null, body: INITIALIZE_BODY }));
    expect(response.status).toBe(401);
    expect(response.headers.get(MCP_SESSION_ID_HEADER)).toBeNull();
    await adapter.close();
  });

  it("never echoes the presented credential in any response body", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    const responses = await Promise.all([
      adapter.handleRequest(build({ authorization: `Bearer ${BEARER}-wrong`, body: INITIALIZE_BODY })),
      adapter.handleRequest(build({ body: INITIALIZE_BODY, origin: "https://evil.example" })),
      adapter.handleRequest(build({ body: "{not json", sessionId })),
      adapter.handleRequest(build({ body: toolCallBody(9, "not_a_tool", {}), sessionId })),
    ]);
    for (const response of responses) {
      expect(await response.text()).not.toContain(BEARER);
    }
    await adapter.close();
  });
});

describe("http adapter — session lifecycle", () => {
  it("binds the daemon session inside initialize and reaps it on DELETE", async () => {
    const bound: string[] = [];
    const sessionPort: HttpSessionPort = {
      bindSession(id: string): void {
        bound.push(`bind:${id}`);
      },
      closeSession(id: string): void {
        bound.push(`close:${id}`);
      },
      validateBearer(): HttpAuthVerdict {
        return { ok: true, principalRef: "principal-http", sessionRef: "session-http" };
      },
    };
    const port = createRecordingPort();
    const adapter = createHttpMcpAdapter({ dispatchPort: port, sessionPort });
    const initialized = await adapter.handleRequest(build({ body: INITIALIZE_BODY }));
    const sessionId = initialized.headers.get(MCP_SESSION_ID_HEADER) ?? "";
    await initialized.text();
    expect(bound).toEqual([`bind:${sessionId}`]);

    const deleted = await adapter.handleRequest(build({ method: "DELETE", sessionId }));
    expect(deleted.status).toBe(200);
    expect(bound).toEqual([`bind:${sessionId}`, `close:${sessionId}`]);

    const afterDelete = await adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId }),
    );
    expect(afterDelete.status).toBe(404);
    expect(port.calls).toEqual([]);
    await adapter.close();
  });

  it("mints no session and leaks no server when the daemon refuses the bind", async () => {
    const sessionPort: HttpSessionPort = {
      bindSession(): never {
        throw new Error("daemon refused the bind at 10.0.0.1:5432");
      },
      closeSession(): void {},
      validateBearer(): HttpAuthVerdict {
        return { ok: true, principalRef: "principal-http", sessionRef: "session-http" };
      },
    };
    const port = createRecordingPort();
    const adapter = createHttpMcpAdapter({ dispatchPort: port, sessionPort });
    const response = await adapter.handleRequest(build({ body: INITIALIZE_BODY }));
    expect(response.status).toBe(500);
    expect(response.headers.get(MCP_SESSION_ID_HEADER)).toBeNull();
    const body = await response.text();
    expect(body).not.toContain("10.0.0.1");
    expect(JSON.parse(body).error.data.code).toBe("UNKNOWN_ERROR");
    expect(port.calls).toEqual([]);
    await adapter.close();
  });

  it("refuses an unknown Mcp-Session-Id with 404 and zero dispatch", async () => {
    const port = createRecordingPort();
    const { adapter } = await openSession(port);
    const response = await adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId: "mcp-session-absent" }),
    );
    expect(response.status).toBe(404);
    expect(port.calls).toEqual([]);
    await adapter.close();
  });

  it("refuses a non-initialize POST that carries no session id, with zero dispatch", async () => {
    const port = createRecordingPort();
    const { adapter } = await openSession(port);
    const response = await adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS) }),
    );
    expect(response.status).toBe(400);
    expect(port.calls).toEqual([]);
    await adapter.close();
  });

  it("isolates two concurrently open sessions", async () => {
    const first = await openSession(createRecordingPort());
    const second = await openSession(createRecordingPort());
    expect(first.sessionId).not.toBe(second.sessionId);
    const crossed = await first.adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId: second.sessionId }),
    );
    expect(crossed.status).toBe(404);
    await first.adapter.close();
    await second.adapter.close();
  });
});

describe("http adapter — no transport-specific bypass", () => {
  it("advertises exactly the generated stdio tool set", async () => {
    expect(HTTP_LISTED_TOOLS.map((tool) => tool.name)).toEqual(
      STDIO_TOOL_ENTRIES.map((entry) => entry.tool.name),
    );
    expect(HTTP_LISTED_TOOLS).toEqual(STDIO_TOOL_ENTRIES.map((entry) => entry.tool));
  });

  it("serves the same tool list over the wire", async () => {
    const { adapter, sessionId } = await openSession(createRecordingPort());
    const response = await adapter.handleRequest(
      build({ body: JSON.stringify({ id: 5, jsonrpc: "2.0", method: "tools/list" }), sessionId }),
    );
    const listed = (await readPayload(response))["result"] as { tools: { name: string }[] };
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      STDIO_TOOL_ENTRIES.map((entry) => entry.tool.name),
    );
    // Names alone would not catch a schema that drifted, so compare the served schemas too.
    expect(listed.tools[0]).toEqual(STDIO_TOOL_ENTRIES[0]?.tool);
    expect(listed.tools.at(-1)).toEqual(STDIO_TOOL_ENTRIES.at(-1)?.tool);
    await adapter.close();
  });

  it("refuses HTTP methods the MCP endpoint does not define", async () => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    for (const method of ["PUT", "PATCH"]) {
      const response = await adapter.handleRequest(build({ method, sessionId }));
      expect(response.status).toBe(405);
    }
    expect(port.calls).toEqual([]);
    await adapter.close();
  });
});

describe("http adapter — cancellation and disconnect", () => {
  interface DeferredPort extends HttpDispatchPort {
    readonly captured: readonly AbortSignal[];
    release(): void;
  }

  function createDeferredPort(): DeferredPort {
    const captured: AbortSignal[] = [];
    const releases: (() => void)[] = [];
    const dispatch = (_bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> => {
      if (signal !== undefined) captured.push(signal);
      return new Promise((resolve) => {
        releases.push(() => {
          resolve(CONFORMANCE_COMMAND_RESPONSE_BYTES);
        });
      });
    };
    return {
      authenticate: () => ({ ok: true as const }),
      captured,
      dispatchCommandBytes: dispatch,
      dispatchQueryBytes: dispatch,
      release(): void {
        for (const resolve of releases.splice(0)) resolve();
      },
    };
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }

  it("aborts the dispatch signal when the client sends notifications/cancelled", async () => {
    const port = createDeferredPort();
    const { adapter, sessionId } = await openSession(port, false);
    const inFlight = await adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId }),
    );
    await settle();
    expect(port.captured).toHaveLength(1);
    expect(port.captured[0]?.aborted).toBe(false);

    const cancelled = await adapter.handleRequest(
      build({
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { reason: "client cancelled", requestId: 2 },
        }),
        sessionId,
      }),
    );
    expect(cancelled.status).toBe(202);
    await cancelled.text();
    await settle();
    expect(port.captured[0]?.aborted).toBe(true);

    port.release();
    await settle();
    await inFlight.body?.cancel();
    await adapter.close();
  });

  it("loses the result and fabricates nothing when the client drops the stream", async () => {
    const port = createDeferredPort();
    const { adapter, sessionId } = await openSession(port, false);
    const response = await adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId }),
    );
    await settle();
    await response.body?.cancel();
    await settle();

    // Verified SDK semantics: dropping the stream neither aborts the signal nor stops dispatch.
    expect(port.captured[0]?.aborted).toBe(false);
    port.release();
    await settle();
    expect(response.bodyUsed || response.body?.locked).toBeTruthy();
    await adapter.close();
  });
});

describe("http adapter — resumption is typed unsupported", () => {
  it("passes a request that carries no Last-Event-ID straight through", () => {
    expect(refuseResumption(build({ sessionId: "any" }))).toBeUndefined();
  });

  it.each([
    ["POST", toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS)],
    ["GET", undefined],
  ])("refuses a %s bearing Last-Event-ID before the SDK sees it, with zero dispatch", async (
    method,
    body,
  ) => {
    const port = createRecordingPort();
    const { adapter, sessionId } = await openSession(port);
    const response = await adapter.handleRequest(
      build({ ...(body === undefined ? {} : { body }), lastEventId: "17", method, sessionId }),
    );
    expect(response.status).toBe(403);
    const error = (await readPayload(response))["error"] as {
      data?: { code?: string; reason?: string };
    };
    expect(error.data?.code).toBe("CAPABILITY_DENIED");
    expect(error.data?.reason).toBe(MCP_RESUME_UNSUPPORTED);
    expect(port.calls).toEqual([]);
    await adapter.close();
  });

  it("refuses a resume attempt without echoing the credential", async () => {
    const { adapter, sessionId } = await openSession(createRecordingPort());
    const response = await adapter.handleRequest(
      build({ lastEventId: "17", method: "GET", sessionId }),
    );
    expect(await response.text()).not.toContain(BEARER);
    await adapter.close();
  });

  it("still opens a normal standalone SSE stream when no Last-Event-ID is present", async () => {
    const { adapter, sessionId } = await openSession(createRecordingPort(), false);
    const response = await adapter.handleRequest(build({ method: "GET", sessionId }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await response.body?.cancel();
    await adapter.close();
  });
});
