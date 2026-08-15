/**
 * Session lifecycle, transport parity, cancellation/disconnect, and typed-resumption
 * tests for the official Streamable HTTP adapter.
 *
 * The disconnect cases assert the SDK's actual semantics: cancelling an SSE body does not
 * abort dispatch. The result is lost and the adapter fabricates nothing.
 */
import { describe, expect, it } from "vitest";

import { STDIO_TOOL_ENTRIES } from "../stdio/stdio-tool-schemas.js";
import {
  CONFORMANCE_COMMAND_ARGS,
  CONFORMANCE_COMMAND_LABEL,
  CONFORMANCE_COMMAND_RESPONSE_BYTES,
  createRecordingPort,
} from "../dispatch-conformance.js";
import {
  MCP_RESUME_UNSUPPORTED,
  refuseResumption,
} from "./http-resume.js";
import { HTTP_LISTED_TOOLS, createHttpMcpAdapter } from "./http-server.js";
import type { HttpDispatchPort } from "./http-server.js";
import { MCP_SESSION_ID_HEADER } from "./http-session.js";
import type { HttpAuthVerdict, HttpSessionPort } from "./http-session.js";
import {
  BEARER,
  INITIALIZE_BODY,
  build,
  openSession,
  readPayload,
  toolCallBody,
} from "./http-server-test-helpers.js";

/**
 * Records every daemon-side lifecycle call in one ordered trace, so a test can assert WHICH
 * sessions were bound and released and in what order — not merely that close() did not throw.
 */
function recordingSessionPort(observed: string[]): HttpSessionPort {
  return {
    bindSession(id: string): void {
      observed.push(`bind:${id}`);
    },
    closeSession(id: string): void {
      observed.push(`close:${id}`);
    },
    validateBearer(): HttpAuthVerdict {
      return { ok: true, principalRef: "principal-http", sessionRef: "session-http" };
    },
  };
}

/** Opens one more session on an EXISTING adapter, so a single registry holds several. */
async function openSessionOn(adapter: { handleRequest(request: Request): Promise<Response> }): Promise<string> {
  const response = await adapter.handleRequest(build({ body: INITIALIZE_BODY }));
  const sessionId = response.headers.get(MCP_SESSION_ID_HEADER);
  await response.text();
  if (sessionId === null) throw new Error(`initialize did not mint a session: ${response.status}`);
  return sessionId;
}

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

  /**
   * The DELETE case at the top of this file is the ONLY one that asserts a release, and it
   * issues a DELETE first — by the time close() runs there is nothing left to release, so the
   * shutdown path is never exercised by it. Every other `await adapter.close()` in this file is
   * pure teardown and asserts nothing. The two cases below drive close() with a session still
   * OPEN, which is the path that was missing its daemon-side release.
   */
  it("releases the daemon binding of a session still open when the adapter closes", async () => {
    const observed: string[] = [];
    const port = createRecordingPort();
    const adapter = createHttpMcpAdapter({
      dispatchPort: port,
      sessionPort: recordingSessionPort(observed),
    });
    const initialized = await adapter.handleRequest(build({ body: INITIALIZE_BODY }));
    const sessionId = initialized.headers.get(MCP_SESSION_ID_HEADER) ?? "";
    await initialized.text();
    expect(observed).toEqual([`bind:${sessionId}`]);

    // NO DELETE. The adapter's own shutdown is the only thing that may release this binding.
    await adapter.close();

    // Order matters as much as presence: `bind` then `close`, the same discipline the DELETE
    // path asserts. Asserting the whole trace also catches a release for a session never bound.
    expect(observed).toEqual([`bind:${sessionId}`, `close:${sessionId}`]);
  });

  it("releases each session exactly once across a DELETE and a shutdown", async () => {
    const observed: string[] = [];
    const port = createRecordingPort();
    const adapter = createHttpMcpAdapter({
      dispatchPort: port,
      sessionPort: recordingSessionPort(observed),
    });
    const firstId = await openSessionOn(adapter);
    const secondId = await openSessionOn(adapter);
    expect(firstId).not.toBe(secondId);

    const deleted = await adapter.handleRequest(build({ method: "DELETE", sessionId: firstId }));
    expect(deleted.status).toBe(200);
    expect(observed).toEqual([`bind:${firstId}`, `bind:${secondId}`, `close:${firstId}`]);

    await adapter.close();

    // Exactly-once, asserted as the whole ordered trace rather than as a membership check: a
    // shutdown that re-released the already-reaped first session is a DIFFERENT defect, not a
    // stricter fix, and a `toContain` pair would pass for it.
    expect(observed).toEqual([
      `bind:${firstId}`,
      `bind:${secondId}`,
      `close:${firstId}`,
      `close:${secondId}`,
    ]);
    expect(observed.filter((event) => event === `close:${firstId}`)).toHaveLength(1);
    expect(observed.filter((event) => event === `close:${secondId}`)).toHaveLength(1);
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
