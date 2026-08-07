/**
 * Host/origin, body-bound, and pre-transport authentication tests for the official
 * Streamable HTTP adapter. Plain Request values exercise the production SDK path.
 */
import { MAX_JSON_BODY_BYTES } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import {
  CONFORMANCE_COMMAND_ARGS,
  CONFORMANCE_COMMAND_LABEL,
  CONFORMANCE_COMMAND_RESPONSE_TEXT,
  createRecordingPort,
} from "../dispatch-conformance.js";
import { createHttpMcpAdapter } from "./http-server.js";
import { MCP_SESSION_ID_HEADER } from "./http-session.js";
import {
  ACCEPT,
  BEARER,
  ENDPOINT,
  HOST,
  INITIALIZE_BODY,
  build,
  openSession,
  readPayload,
  resultText,
  sessionPortFor,
  toolCallBody,
} from "./http-server-test-helpers.js";

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
