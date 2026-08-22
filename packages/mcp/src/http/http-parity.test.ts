/**
 * Parity gate: the Streamable HTTP adapter must be semantically indistinguishable from the
 * stdio adapter at the byte level.
 *
 * This is deliberately an EXECUTABLE gate rather than prose. The shared, transport-agnostic
 * conformance suite is registered against HTTP with the very same fake port the stdio side
 * uses, so the call-sequence obligation and the whole error-code mapping table are re-proved
 * here. On top of that, identical inputs are pushed through BOTH transports in the same process
 * and the results, the errors, and — most importantly — the envelope bytes each port actually
 * received are byte-compared. That last comparison is what guards the envelope construction
 * this adapter duplicates from the stdio adapter: drift fails a test instead of shipping.
 */
import { MAX_JSON_BODY_BYTES, createRuntimeError } from "@moe/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  CONFORMANCE_COMMAND_ARGS,
  CONFORMANCE_COMMAND_LABEL,
  CONFORMANCE_COMMAND_RESPONSE_TEXT,
  CONFORMANCE_QUERY_ARGS,
  CONFORMANCE_QUERY_LABEL,
  CONFORMANCE_QUERY_RESPONSE_TEXT,
  createRecordingPort,
  registerDispatchConformanceSuite,
} from "../dispatch-conformance.js";
import type {
  ConformanceDispatchPort,
  ConformanceOutcome,
  RecordingDispatchPort,
} from "../dispatch-conformance.js";
import { createStdioMcpServer } from "../stdio/stdio-server.js";
import {
  MCP_TOOL_ALLOWLIST_UNKNOWN_KIND,
  STDIO_TOOL_ENTRIES,
  toolLabelForKind,
} from "../stdio/stdio-tool-schemas.js";
import { createHttpMcpAdapter } from "./http-server.js";
import { MCP_SESSION_ID_HEADER } from "./http-session.js";
import type { HttpAuthVerdict, HttpSessionPort } from "./http-session.js";

/**
 * ONE credential for both transports. The stdio adapter holds a bootstrap credential in
 * closure while the HTTP adapter takes a per-request bearer; feeding both the same string is
 * what makes the resulting envelope bytes comparable at all.
 */
const PARITY_CREDENTIAL = "parity-credential-DO-NOT-LOG-5b1c9e";
const HOST = "127.0.0.1:7391";
const ENDPOINT = `http://${HOST}/mcp`;

const SESSION_PORT: HttpSessionPort = {
  bindSession(): void {},
  closeSession(): void {},
  validateBearer(presented: string): HttpAuthVerdict {
    return presented === PARITY_CREDENTIAL
      ? { ok: true, principalRef: "principal-parity", sessionRef: "session-parity" }
      : { code: "AUTHENTICATION_FAILED", ok: false };
  },
};

function httpRequest(body: string, sessionId?: string): Request {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${PARITY_CREDENTIAL}`,
    "content-type": "application/json",
    host: HOST,
  });
  if (sessionId !== undefined) headers.set(MCP_SESSION_ID_HEADER, sessionId);
  return new Request(ENDPOINT, { body, headers, method: "POST" });
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

function toolCallBody(name: string, args: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    id: 2,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: args, name },
  });
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

function toOutcome(payload: Record<string, unknown>): ConformanceOutcome {
  const error = payload["error"] as { code: number; data?: unknown } | undefined;
  if (error !== undefined) return { data: error.data, kind: "error", mcpCode: error.code };
  const result = payload["result"] as { content?: readonly { text?: string }[] } | undefined;
  return { kind: "ok", text: result?.content?.[0]?.text ?? "" };
}

async function throughHttp(
  port: ConformanceDispatchPort,
  toolLabel: string,
  args: Readonly<Record<string, unknown>>,
  enableJsonResponse = true,
): Promise<ConformanceOutcome> {
  const adapter = createHttpMcpAdapter({
    dispatchPort: port,
    enableJsonResponse,
    sessionPort: SESSION_PORT,
  });
  try {
    const initialized = await adapter.handleRequest(httpRequest(INITIALIZE_BODY));
    const sessionId = initialized.headers.get(MCP_SESSION_ID_HEADER) ?? "";
    await initialized.text();
    const response = await adapter.handleRequest(
      httpRequest(toolCallBody(toolLabel, args), sessionId),
    );
    return toOutcome(await readPayload(response));
  } finally {
    await adapter.close();
  }
}

async function throughStdio(
  port: ConformanceDispatchPort,
  toolLabel: string,
  args: Readonly<Record<string, unknown>>,
): Promise<ConformanceOutcome> {
  const server = createStdioMcpServer({ credential: PARITY_CREDENTIAL, port });
  const client = new Client({ name: "stdio-parity-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ arguments: { ...args }, name: toolLabel });
    const blocks = result.content as readonly { text?: string }[] | undefined;
    return { kind: "ok", text: blocks?.[0]?.text ?? "" };
  } catch (error) {
    if (error instanceof McpError) {
      return { data: error.data, kind: "error", mcpCode: error.code };
    }
    throw error;
  } finally {
    await client.close();
    await server.close();
  }
}

registerDispatchConformanceSuite({
  invoke: async (port, toolLabel, args) => throughHttp(port, toolLabel, args),
  transportName: "streamable http (web standard transport)",
});

interface BothTransports {
  readonly http: ConformanceOutcome;
  readonly httpPort: RecordingDispatchPort;
  readonly stdio: ConformanceOutcome;
  readonly stdioPort: RecordingDispatchPort;
}

async function throughBoth(
  toolLabel: string,
  args: Readonly<Record<string, unknown>>,
): Promise<BothTransports> {
  const httpPort = createRecordingPort();
  const stdioPort = createRecordingPort();
  return {
    http: await throughHttp(httpPort, toolLabel, args),
    httpPort,
    stdio: await throughStdio(stdioPort, toolLabel, args),
    stdioPort,
  };
}

describe("stdio and http produce identical bytes", () => {
  it("dispatches byte-identical command envelopes from identical arguments", async () => {
    const both = await throughBoth(CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS);
    expect(both.httpPort.dispatched).toHaveLength(1);
    expect([...(both.httpPort.dispatched[0] ?? [])]).toEqual([
      ...(both.stdioPort.dispatched[0] ?? []),
    ]);
  });

  it("dispatches byte-identical query envelopes from identical arguments", async () => {
    const both = await throughBoth(CONFORMANCE_QUERY_LABEL, CONFORMANCE_QUERY_ARGS);
    expect([...(both.httpPort.dispatched[0] ?? [])]).toEqual([
      ...(both.stdioPort.dispatched[0] ?? []),
    ]);
  });

  it("calls the port in the identical order on both transports", async () => {
    const both = await throughBoth(CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS);
    expect(both.httpPort.calls).toEqual(both.stdioPort.calls);
  });

  it("returns identical result bytes on both transports", async () => {
    const both = await throughBoth(CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS);
    expect(both.http).toEqual(both.stdio);
    expect(both.http.kind === "ok" ? both.http.text : "").toBe(CONFORMANCE_COMMAND_RESPONSE_TEXT);
  });

  it("returns identical error objects on both transports for an unmapped tool", async () => {
    const both = await throughBoth("goal_create_not_a_tool", CONFORMANCE_COMMAND_ARGS);
    expect(both.http.kind).toBe("error");
    expect(both.http).toEqual(both.stdio);
  });

  it("returns identical error objects on both transports for oversized arguments", async () => {
    const both = await throughBoth(CONFORMANCE_COMMAND_LABEL, {
      ...CONFORMANCE_COMMAND_ARGS,
      payload: { title: "x".repeat(300_000) },
    });
    expect(both.http.kind).toBe("error");
    expect(both.http).toEqual(both.stdio);
    const data = both.http.kind === "error" ? (both.http.data as { code?: string }) : {};
    expect(data.code).toBe("INPUT_LIMIT_EXCEEDED");
  });

  it("preserves the recovery affordance of an authentication refusal on both transports", async () => {
    const authError = createRuntimeError({ code: "AUTHENTICATION_FAILED" });
    const httpPort = createRecordingPort({ authError });
    const stdioPort = createRecordingPort({ authError });
    const http = await throughHttp(httpPort, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS);
    const stdio = await throughStdio(stdioPort, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS);
    expect(http).toEqual(stdio);
    expect(httpPort.dispatched).toEqual([]);
    const data = http.kind === "error" ? (http.data as { recoveryCommands?: string[] }) : {};
    expect(data.recoveryCommands).toEqual(["session.open"]);
  });
});

describe("daemon bytes survive the http path in both response modes", () => {
  it("returns golden command bytes verbatim in JSON mode", async () => {
    const outcome = await throughHttp(
      createRecordingPort(),
      CONFORMANCE_COMMAND_LABEL,
      CONFORMANCE_COMMAND_ARGS,
    );
    expect(outcome.kind === "ok" ? outcome.text : "").toBe(CONFORMANCE_COMMAND_RESPONSE_TEXT);
  });

  it("returns golden query bytes verbatim from the single SSE data line", async () => {
    const outcome = await throughHttp(
      createRecordingPort(),
      CONFORMANCE_QUERY_LABEL,
      CONFORMANCE_QUERY_ARGS,
      false,
    );
    expect(outcome.kind === "ok" ? outcome.text : "").toBe(CONFORMANCE_QUERY_RESPONSE_TEXT);
  });
});

describe("the body bound holds through the whole http stack", () => {
  async function sizedToolCall(totalBytes: number): Promise<Response> {
    const port = createRecordingPort();
    const adapter = createHttpMcpAdapter({ dispatchPort: port, sessionPort: SESSION_PORT });
    const initialized = await adapter.handleRequest(httpRequest(INITIALIZE_BODY));
    const sessionId = initialized.headers.get(MCP_SESSION_ID_HEADER) ?? "";
    await initialized.text();
    const base = toolCallBody(CONFORMANCE_QUERY_LABEL, { ...CONFORMANCE_QUERY_ARGS, pad: "" });
    const padded = toolCallBody(CONFORMANCE_QUERY_LABEL, {
      ...CONFORMANCE_QUERY_ARGS,
      pad: "p".repeat(totalBytes - base.length),
    });
    expect(new TextEncoder().encode(padded).byteLength).toBe(totalBytes);
    const response = await adapter.handleRequest(httpRequest(padded, sessionId));
    await adapter.close();
    return response;
  }

  it("does not refuse a request body of exactly the maximum size for being too large", async () => {
    const response = await sizedToolCall(MAX_JSON_BODY_BYTES);
    expect(response.status).not.toBe(413);
    await response.text();
  });

  it("refuses a request body one byte over the maximum", async () => {
    const response = await sizedToolCall(MAX_JSON_BODY_BYTES + 1);
    expect(response.status).toBe(413);
    const error = (await readPayload(response))["error"] as { data?: { code?: string } };
    expect(error.data?.code).toBe("INPUT_LIMIT_EXCEEDED");
  });
});

const LIST_BODY = JSON.stringify({ id: 3, jsonrpc: "2.0", method: "tools/list", params: {} });

async function listedOverHttp(allowlist?: readonly string[]): Promise<readonly string[]> {
  const adapter = createHttpMcpAdapter({
    dispatchPort: createRecordingPort(),
    enableJsonResponse: true,
    sessionPort: SESSION_PORT,
    ...(allowlist === undefined ? {} : { toolAllowlist: allowlist }),
  });
  try {
    const initialized = await adapter.handleRequest(httpRequest(INITIALIZE_BODY));
    const sessionId = initialized.headers.get(MCP_SESSION_ID_HEADER) ?? "";
    await initialized.text();
    const payload = await readPayload(
      await adapter.handleRequest(httpRequest(LIST_BODY, sessionId)),
    );
    const result = payload["result"] as { tools?: readonly { name: string }[] } | undefined;
    return (result?.tools ?? []).map((tool) => tool.name);
  } finally {
    await adapter.close();
  }
}

async function listedOverStdio(allowlist?: readonly string[]): Promise<readonly string[]> {
  const server = createStdioMcpServer({
    credential: PARITY_CREDENTIAL,
    port: createRecordingPort(),
    ...(allowlist === undefined ? {} : { toolAllowlist: allowlist }),
  });
  const client = new Client({ name: "parity-list-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("tool allowlist parity", () => {
  const WIRED = Object.freeze(["project.register", "goal.create", "events.read"]);

  it("advertises the same allowlisted names on HTTP as on stdio", async () => {
    const [overHttp, overStdio] = await Promise.all([
      listedOverHttp(WIRED),
      listedOverStdio(WIRED),
    ]);

    expect(overHttp).toEqual(WIRED.map(toolLabelForKind));
    expect(overHttp).toEqual(overStdio);
  });

  it("advertises the full generated set on both transports without an allowlist", async () => {
    const [overHttp, overStdio] = await Promise.all([listedOverHttp(), listedOverStdio()]);
    const generated = STDIO_TOOL_ENTRIES.map((entry) => entry.tool.name);

    expect(overHttp).toEqual(generated);
    expect(overStdio).toEqual(generated);
    expect(overHttp.length).toBeGreaterThan(WIRED.length);
  });

  it("refuses an unknown allowlisted kind at adapter construction, with the stable code", () => {
    let message = "";
    let created = false;
    try {
      createHttpMcpAdapter({
        dispatchPort: createRecordingPort(),
        sessionPort: SESSION_PORT,
        toolAllowlist: ["goal.create", "http.not_a_kind"],
      });
      created = true;
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(created).toBe(false);
    expect(message).toContain(MCP_TOOL_ALLOWLIST_UNKNOWN_KIND);
    expect(message).toContain("http.not_a_kind");
  });
});
