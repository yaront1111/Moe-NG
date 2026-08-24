/**
 * Session lifecycle, transport parity, cancellation/disconnect, close-latch, idle-reaping,
 * and typed-resumption tests for the official Streamable HTTP adapter.
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
  CONFORMANCE_COMMAND_RESPONSE_TEXT,
  createRecordingPort,
} from "../dispatch-conformance.js";
import {
  MCP_RESUME_UNSUPPORTED,
  refuseResumption,
} from "./http-resume.js";
import { HTTP_LISTED_TOOLS, createHttpMcpAdapter } from "./http-server.js";
import type { HttpDispatchContext, HttpDispatchPort } from "./http-server.js";
import { MCP_SESSION_ID_HEADER } from "./http-session.js";
import type { HttpAuthVerdict, HttpSessionPort } from "./http-session.js";
import {
  BEARER,
  INITIALIZE_BODY,
  build,
  openSession,
  readPayload,
  resultText,
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

interface DeferredPort extends HttpDispatchPort {
  /** Ordered dispatch log, one entry per call that REACHED this port. */
  readonly calls: readonly string[];
  readonly captured: readonly AbortSignal[];
  release(): void;
}

/** Holds every dispatch open until `release()`, so a call can be caught genuinely in flight. */
function createDeferredPort(): DeferredPort {
  const calls: string[] = [];
  const captured: AbortSignal[] = [];
  const releases: (() => void)[] = [];
  const dispatch = (label: string) => (
    _bytes: Uint8Array,
    context: HttpDispatchContext,
  ): Promise<Uint8Array> => {
    calls.push(label);
    if (context.signal !== undefined) captured.push(context.signal);
    return new Promise((resolve) => {
      releases.push(() => {
        resolve(CONFORMANCE_COMMAND_RESPONSE_BYTES);
      });
    });
  };
  return {
    authenticate: () => ({ ok: true as const }),
    calls,
    captured,
    dispatchCommandBytes: dispatch("dispatchCommandBytes"),
    dispatchQueryBytes: dispatch("dispatchQueryBytes"),
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

describe("http adapter — session close settles JSON-mode POSTs", () => {
  it("settles an in-flight tools/call with SESSION_EXPIRED when the session is DELETEd", async () => {
    const port = createDeferredPort();
    const { adapter, sessionId } = await openSession(port);
    // Deliberately NOT awaited: in JSON response mode (the default) the SDK parks this whole
    // Promise<Response> behind its stream mapping until the tool completes, and the deferred
    // port holds the tool open.
    const inFlight = adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId }),
    );
    await settle();
    expect(port.captured).toHaveLength(1);

    const deleted = await adapter.handleRequest(build({ method: "DELETE", sessionId }));
    expect(deleted.status).toBe(200);

    // Before the close latch existed this await NEVER settled: the SDK's close() deletes its
    // stream mapping without resolving the parked response, and the close-abort makes the
    // handler's completion path return early. The latch turns the close into the same 404 a
    // request arriving after the DELETE receives.
    const response = await inFlight;
    expect(response.status).toBe(404);
    const error = (await readPayload(response))["error"] as {
      code?: number;
      data?: { code?: string };
    };
    expect(error.code).toBe(-32001);
    expect(error.data?.code).toBe("SESSION_EXPIRED");
    port.release();
    await adapter.close();
  });

  it("settles an in-flight tools/call when the adapter itself closes", async () => {
    const port = createDeferredPort();
    const { adapter, sessionId } = await openSession(port);
    const inFlight = adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId }),
    );
    await settle();
    expect(port.captured).toHaveLength(1);

    // The shutdown sweep releases each session's latch right after closing its transport.
    await adapter.close();

    const response = await inFlight;
    expect(response.status).toBe(404);
    const error = (await readPayload(response))["error"] as { data?: { code?: string } };
    expect(error.data?.code).toBe("SESSION_EXPIRED");
    port.release();
  });
});

describe("http adapter — duplicate in-flight request ids", () => {
  /**
   * The SDK maps each pending request to its response stream by bare `message.id`, so a second
   * POST reusing an id still in flight OVERWRITES the first call's mapping: the first call's
   * result is delivered as the second POST's HTTP body, the second call's own result is dropped,
   * and the first POST pends until the session closes. The adapter must therefore refuse a
   * duplicate in-flight id BEFORE the SDK transport ever sees the message.
   */
  it("refuses a POST reusing an in-flight request id and keeps the first call's own result", async () => {
    const port = createDeferredPort();
    const { adapter, sessionId } = await openSession(port);
    const inFlight = adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId }),
    );
    await settle();
    expect(port.calls).toEqual(["dispatchCommandBytes"]);

    const duplicate = adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId }),
    );
    await settle();
    // The refusal precedes dispatch: the duplicate id never reaches the daemon port.
    expect(port.calls).toEqual(["dispatchCommandBytes"]);

    const refused = await duplicate;
    expect(refused.status).toBe(400);
    const error = (await readPayload(refused))["error"] as {
      code?: number;
      data?: { code?: string };
    };
    expect(error.code).toBe(-32602);
    expect(error.data?.code).toBe("INPUT_INVALID");

    // The first call still settles with ITS OWN result — not the pend-until-close that the
    // overwritten mapping used to leave behind.
    port.release();
    const response = await inFlight;
    expect(response.status).toBe(200);
    const payload = await readPayload(response);
    expect(payload["id"]).toBe(2);
    expect(resultText(payload)).toBe(CONFORMANCE_COMMAND_RESPONSE_TEXT);

    // The id was RELEASED when the first call settled: the same id serves a fresh call.
    const reused = adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId }),
    );
    await settle();
    expect(port.calls).toEqual(["dispatchCommandBytes", "dispatchCommandBytes"]);
    port.release();
    const reusedResponse = await reused;
    expect(reusedResponse.status).toBe(200);
    expect(resultText(await readPayload(reusedResponse))).toBe(CONFORMANCE_COMMAND_RESPONSE_TEXT);
    await adapter.close();
  });
});

describe("http adapter — idle session reaping", () => {
  const IDLE_TTL_MS = 60_000;

  it("releases a session idle past the TTL at the next initialize, leaving fresh ones alone", async () => {
    const observed: string[] = [];
    let clock = 1_000_000;
    const port = createRecordingPort();
    const adapter = createHttpMcpAdapter({
      dispatchPort: port,
      now: (): number => clock,
      sessionIdleTtlMs: IDLE_TTL_MS,
      sessionPort: recordingSessionPort(observed),
    });
    const staleId = await openSessionOn(adapter);
    clock += 30_000;
    const freshId = await openSessionOn(adapter);
    clock += 45_000;
    // Stale is now 75s idle and fresh 45s: only stale is past the 60s TTL. The whole ordered
    // trace pins the release BEFORE the new bind — the sweep runs before the pair is minted —
    // and pins that the fresh session was not swept along with the stale one.
    const mintedId = await openSessionOn(adapter);
    expect(observed).toEqual([
      `bind:${staleId}`,
      `bind:${freshId}`,
      `close:${staleId}`,
      `bind:${mintedId}`,
    ]);

    // The reaped session is unroutable with the same 404 a DELETE leaves behind ...
    const late = await adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId: staleId }),
    );
    expect(late.status).toBe(404);
    // ... while the surviving session still serves a call.
    const alive = await adapter.handleRequest(
      build({ body: toolCallBody(3, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId: freshId }),
    );
    expect(resultText(await readPayload(alive))).toBe(CONFORMANCE_COMMAND_RESPONSE_TEXT);
    await adapter.close();
  });

  it("keeps a session alive when routed activity resets its idle clock", async () => {
    const observed: string[] = [];
    let clock = 1_000_000;
    const port = createRecordingPort();
    const adapter = createHttpMcpAdapter({
      dispatchPort: port,
      now: (): number => clock,
      sessionIdleTtlMs: IDLE_TTL_MS,
      sessionPort: recordingSessionPort(observed),
    });
    const activeId = await openSessionOn(adapter);
    clock += 45_000;
    const touched = await adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId: activeId }),
    );
    expect(touched.status).toBe(200);
    await touched.text();
    clock += 45_000;
    // 90s since the bind but only 45s since the routed call: the bind-time stamp alone would
    // read as idle past the TTL, so the absence of a close here is what proves the touch.
    const mintedId = await openSessionOn(adapter);
    expect(observed).toEqual([`bind:${activeId}`, `bind:${mintedId}`]);
    await adapter.close();
  });

  it("settles an in-flight tools/call on a session the reap sweeps away", async () => {
    const observed: string[] = [];
    let clock = 1_000_000;
    const port = createDeferredPort();
    const adapter = createHttpMcpAdapter({
      dispatchPort: port,
      now: (): number => clock,
      sessionIdleTtlMs: IDLE_TTL_MS,
      sessionPort: recordingSessionPort(observed),
    });
    const staleId = await openSessionOn(adapter);
    const inFlight = adapter.handleRequest(
      build({ body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId: staleId }),
    );
    await settle();
    expect(port.captured).toHaveLength(1);

    clock += IDLE_TTL_MS + 1;
    await openSessionOn(adapter);

    // The reap runs the same sweep shutdown uses, so the reaped session's latch settled the
    // response parked behind the still-open tool call.
    const response = await inFlight;
    expect(response.status).toBe(404);
    const error = (await readPayload(response))["error"] as { data?: { code?: string } };
    expect(error.data?.code).toBe("SESSION_EXPIRED");
    port.release();
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
