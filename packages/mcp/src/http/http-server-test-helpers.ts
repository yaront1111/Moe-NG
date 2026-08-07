import { LAST_EVENT_ID_HEADER } from "./http-resume.js";
import { MCP_PROTOCOL_VERSION_HEADER, createHttpMcpAdapter } from "./http-server.js";
import type { HttpDispatchPort, HttpMcpAdapter } from "./http-server.js";
import { MCP_SESSION_ID_HEADER } from "./http-session.js";
import type { HttpAuthVerdict, HttpSessionPort } from "./http-session.js";

export const BEARER = "bearer-http-DO-NOT-LOG-77d1e2f0";
export const HOST = "127.0.0.1:7391";
export const ENDPOINT = `http://${HOST}/mcp`;
export const ACCEPT = "application/json, text/event-stream";

export function sessionPortFor(credential: string): HttpSessionPort {
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

export interface RequestInit_ {
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

export function build(init: RequestInit_ = {}): Request {
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

export const INITIALIZE_BODY = JSON.stringify({
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "http-parity-client", version: "0.0.0" },
    protocolVersion: "2025-06-18",
  },
});

export function toolCallBody(id: number, name: string, args: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ id, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } });
}

export interface OpenSession {
  readonly adapter: HttpMcpAdapter;
  readonly sessionId: string;
}

export async function openSession(
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
export async function readPayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.startsWith("event:") && !text.startsWith("data:")) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  const line = text.split("\n").find((candidate) => candidate.startsWith("data:"));
  return JSON.parse((line ?? "data:{}").slice("data:".length)) as Record<string, unknown>;
}

export function resultText(payload: Record<string, unknown>): string {
  const result = payload["result"] as { readonly content?: readonly { text?: string }[] } | undefined;
  return result?.content?.[0]?.text ?? "";
}
