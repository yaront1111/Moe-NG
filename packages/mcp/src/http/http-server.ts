import { randomUUID } from "node:crypto";

import { MAX_JSON_BODY_BYTES, createRuntimeError } from "@moe/contracts";
import type { RuntimeError } from "@moe/contracts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import {
  bindDaemonSession,
  closeDaemonSession,
  createHttpSessionRegistry,
  screenRequest,
} from "./http-session.js";
import type { HttpAuthAccepted, HttpSessionPort, HttpSessionRegistry } from "./http-session.js";
import { refuseResumption } from "./http-resume.js";
import { closeAllDaemonSessions } from "./http-shutdown.js";
import { createHttpMcpServer } from "./http-tool-bridge.js";
import type { HttpDispatchPort } from "./http-tool-bridge.js";

/**
 * Official MCP Streamable HTTP adapter over the same generated surface the stdio adapter
 * serves. It is built on the web-standard transport (`Request -> Promise<Response>`), so any
 * `node:http` listener is a thin outermost shell over exactly this code and tests exercise the
 * production path without a socket.
 *
 * The request pipeline is ordered so that every refusal precedes dispatch: loopback screening,
 * then session and credential screening, then resumption screening, then the body bound, and
 * only then the SDK transport. There is one endpoint and no transport-only command; the tool
 * set is the generated one and nothing else.
 *
 * CREDENTIAL HANDLING. The per-request bearer reaches the tool handler through the SDK's
 * `authInfo` and is stamped into the envelope. It is never logged, never placed in a URL, and
 * never echoed in a response: refusals are built from the frozen runtime registry, whose
 * details are a closed allowlist of safe scalars, so a credential cannot ride out on an error.
 */

export const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

/** Loopback is the whole allowlist: this endpoint is not meant to be reachable off-host. */
export const LOOPBACK_HOSTNAMES: readonly string[] = Object.freeze([
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
]);

export { HTTP_LISTED_TOOLS } from "./http-tool-bridge.js";
export type {
  HttpAuthOutcome,
  HttpDispatchContext,
  HttpDispatchPort,
} from "./http-tool-bridge.js";

export interface HttpAdapterOptions {
  readonly dispatchPort: HttpDispatchPort;
  /** JSON bodies instead of SSE frames. Deterministic, so parity fixtures use it. */
  readonly enableJsonResponse?: boolean;
  readonly serverName?: string;
  readonly sessionIdFactory?: () => string;
  readonly sessionPort: HttpSessionPort;
}

export interface HttpMcpAdapter {
  close(): Promise<void>;
  handleRequest(request: Request): Promise<Response>;
}

interface SessionAttachment {
  readonly server: Server;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

interface OpenedSession extends SessionAttachment {
  /** True when the daemon refused to bind, so this pair must never serve a request. */
  bindFailed(): boolean;
}

/**
 * Renders a refusal as a JSON-RPC error. `status` overrides the registry's HTTP status only for
 * transport-routing facts the registry does not model — an unroutable session id (404) and an
 * undefined method (405) — never for an authority decision.
 */
function errorResponse(error: RuntimeError, status?: number): Response {
  return new Response(
    JSON.stringify({
      error: { code: error.transport.mcpCode, data: error, message: error.code },
      id: null,
      jsonrpc: "2.0",
    }),
    {
      headers: { "content-type": "application/json" },
      status: status ?? error.transport.httpStatus,
    },
  );
}

function refusalResponse(code: "CAPABILITY_DENIED" | "INPUT_INVALID", status?: number): Response {
  return errorResponse(createRuntimeError({ code }), status);
}

const LOOPBACK_AUTHORITY_PATTERN = /^(127\.0\.0\.1|localhost|\[::1\])(?::([0-9]+))?$/i;

function isLoopbackAuthority(value: string): boolean {
  const match = LOOPBACK_AUTHORITY_PATTERN.exec(value);
  if (match === null) return false;
  const port = match[2];
  return port === undefined || Number(port) <= 65_535;
}

/**
 * Strict Host and Origin screening, owned by this adapter rather than delegated. The SDK's
 * equivalent defaults to OFF, its options are deprecated, and it cannot express "any loopback
 * port". Refusing here also guarantees the refusal precedes every dispatch.
 */
function loopbackRefusal(request: Request): Response | undefined {
  const host = request.headers.get("host");
  if (host === null || !isLoopbackAuthority(host)) return refusalResponse("CAPABILITY_DENIED");
  const origin = request.headers.get("origin");
  if (origin === null) return undefined;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return refusalResponse("CAPABILITY_DENIED");
  }
  return isLoopbackAuthority(originHost) ? undefined : refusalResponse("CAPABILITY_DENIED");
}

function limitRefusal(): Response {
  return errorResponse(
    createRuntimeError({
      code: "INPUT_LIMIT_EXCEEDED",
      details: { limitBytes: MAX_JSON_BODY_BYTES, limitName: "httpJsonBody" },
    }),
  );
}

type BoundedBody =
  | { readonly ok: false; readonly response: Response }
  | { readonly ok: true; readonly value: unknown };

/**
 * Reads at most `MAX_JSON_BODY_BYTES` and cancels the stream the moment the cap is passed, so a
 * hostile body is never fully buffered. Buffering first and measuring afterwards would let a
 * chunked request with no `Content-Length` consume memory the bound is supposed to deny.
 */
async function readCappedBytes(request: Request): Promise<Uint8Array | undefined> {
  const stream = request.body;
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done === true) break;
    total += value.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The SDK parses the body with no size bound at all, so the adapter reads it first under a hard
 * cap and hands the parsed value over via `parsedBody`; the transport then never re-reads it.
 * A declared over-large `Content-Length` is refused before a single byte is read.
 */
async function readBoundedBody(request: Request): Promise<BoundedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_JSON_BODY_BYTES) {
    return { ok: false, response: limitRefusal() };
  }
  const bytes = await readCappedBytes(request);
  if (bytes === undefined) return { ok: false, response: limitRefusal() };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, response: refusalResponse("INPUT_INVALID") };
  }
}

function isInitializePayload(value: unknown): boolean {
  const messages = Array.isArray(value) ? value : [value];
  return messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { method?: unknown }).method === "initialize",
  );
}

async function openSessionTransport(
  options: HttpAdapterOptions,
  registry: HttpSessionRegistry<SessionAttachment>,
  request: Request,
  verdict: HttpAuthAccepted,
): Promise<OpenedSession> {
  const server = createHttpMcpServer(options.dispatchPort, options.serverName ?? "moe-runtime");
  const origin = request.headers.get("origin");
  let failed = false;
  // Defence in depth behind this adapter's own loopback screen: the session is PINNED to the
  // exact Host, and to the Origin when the client sent one, that it was initialised with.
  const transport: WebStandardStreamableHTTPServerTransport =
    new WebStandardStreamableHTTPServerTransport({
      allowedHosts: [request.headers.get("host") ?? ""],
      ...(origin === null ? {} : { allowedOrigins: [origin] }),
      enableDnsRebindingProtection: true,
      enableJsonResponse: options.enableJsonResponse ?? true,
      keepAliveMs: 0,
      onsessionclosed: async (id): Promise<void> => {
        await closeDaemonSession(registry, options.sessionPort, id);
      },
      // Swallowing the failure here is deliberate. The SDK wraps this callback in a catch that
      // renders `String(error)` into the response body, which would leak whatever the daemon
      // boundary said — host, port, connection string. The failure is recorded instead and the
      // caller discards the SDK's response in favour of a stable one. Nothing is registered on
      // this path, so the session is unroutable regardless.
      onsessioninitialized: async (id): Promise<void> => {
        try {
          await bindDaemonSession(registry, options.sessionPort, id, verdict, {
            server,
            transport,
          });
        } catch {
          failed = true;
        }
      },
      sessionIdGenerator: options.sessionIdFactory ?? ((): string => randomUUID()),
    });
  await server.connect(transport);
  return {
    bindFailed: (): boolean => failed,
    server,
    transport,
  };
}

/**
 * Builds the adapter. `handleRequest` is the single MCP endpoint: there is no second route, no
 * transport-only command, and no path that reaches a tool without passing this screen.
 */
export function createHttpMcpAdapter(options: HttpAdapterOptions): HttpMcpAdapter {
  const registry = createHttpSessionRegistry<SessionAttachment>();

  async function handleRequest(request: Request): Promise<Response> {
    const rebinding = loopbackRefusal(request);
    if (rebinding !== undefined) return rebinding;

    const screened = await screenRequest({ port: options.sessionPort, registry, request });
    if (screened.kind === "refused") return errorResponse(screened.error);
    if (screened.kind === "unknown-session") {
      return errorResponse(createRuntimeError({ code: "SESSION_EXPIRED" }), 404);
    }

    // Must dominate every handleRequest call below: the SDK ignores this header entirely when
    // no event store is configured, which would hand a resuming client a silent gap.
    const resumption = refuseResumption(request);
    if (resumption !== undefined) return resumption;

    if (!["DELETE", "GET", "POST"].includes(request.method)) {
      return refusalResponse("INPUT_INVALID", 405);
    }

    const authInfo = {
      clientId: screened.verdict.principalRef,
      extra: { sessionRef: screened.verdict.sessionRef },
      scopes: [],
      token: screened.credential,
    };

    if (request.method !== "POST") {
      if (screened.entry === undefined) return refusalResponse("INPUT_INVALID");
      return screened.entry.attachment.transport.handleRequest(request, { authInfo });
    }

    const body = await readBoundedBody(request);
    if (!body.ok) return body.response;

    if (screened.entry !== undefined) {
      return screened.entry.attachment.transport.handleRequest(request, {
        authInfo,
        parsedBody: body.value,
      });
    }
    if (!isInitializePayload(body.value)) return refusalResponse("INPUT_INVALID");
    const opened = await openSessionTransport(options, registry, request, screened.verdict);
    const response = await opened.transport.handleRequest(request, {
      authInfo,
      parsedBody: body.value,
    });
    if (!opened.bindFailed()) return response;
    // Nothing was registered, so tear the pair down rather than leaking a connected but
    // unroutable server, discard the SDK's response, and refuse with a stable error.
    await response.body?.cancel();
    await opened.transport.close();
    await opened.server.close();
    return errorResponse(createRuntimeError({ code: "UNKNOWN_ERROR" }));
  }

  return {
    // Delegated to http-shutdown.ts: a registry delete is this adapter's own bookkeeping and
    // tells the daemon nothing, and one failing session must not abandon the rest.
    async close(): Promise<void> {
      await closeAllDaemonSessions(registry, options.sessionPort, registry.entries());
    },
    handleRequest,
  };
}
