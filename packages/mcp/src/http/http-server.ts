import { randomUUID } from "node:crypto";

import { createRuntimeError } from "@moe/contracts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import {
  bindDaemonSession,
  closeDaemonSession,
  createHttpSessionRegistry,
  screenRequest,
} from "./http-session.js";
import type { HttpAuthAccepted, HttpSessionPort, HttpSessionRegistry } from "./http-session.js";
import {
  errorResponse,
  isInitializePayload,
  loopbackRefusal,
  readBoundedBody,
  refusalResponse,
  screenRequestIds,
} from "./http-request-screen.js";
import { refuseResumption } from "./http-resume.js";
import { closeAllDaemonSessions } from "./http-shutdown.js";
import { createHttpMcpServer, httpListedTools } from "./http-tool-bridge.js";
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
 *
 * SESSION LIFETIME. A session ends three ways: the client DELETEs it, the adapter closes, or
 * it sits idle past `sessionIdleTtlMs` and the next initialize reaps it — a lazy sweep rather
 * than a timer, so nothing ticks in the background and tests stay deterministic. All three
 * paths run the same three-act release, and each carries the session's close latch, which
 * settles any JSON-mode POST still in flight with the same 404 a request arriving after the
 * close would get.
 */

export const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

export { LOOPBACK_HOSTNAMES } from "./http-request-screen.js";
export { HTTP_LISTED_TOOLS } from "./http-tool-bridge.js";
export type {
  HttpAuthOutcome,
  HttpDispatchContext,
  HttpDispatchPort,
} from "./http-tool-bridge.js";

/** Default for `sessionIdleTtlMs`: how long an untouched session survives, in milliseconds. */
export const HTTP_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

export interface HttpAdapterOptions {
  readonly dispatchPort: HttpDispatchPort;
  /** JSON bodies instead of SSE frames. Deterministic, so parity fixtures use it. */
  readonly enableJsonResponse?: boolean;
  /** Clock for idle bookkeeping, epoch milliseconds. Injectable so reaping is testable. */
  readonly now?: () => number;
  readonly serverName?: string;
  readonly sessionIdFactory?: () => string;
  /** Milliseconds a session may sit idle before the next initialize reaps it. */
  readonly sessionIdleTtlMs?: number;
  readonly sessionPort: HttpSessionPort;
  /** Runtime KIND strings this adapter may advertise; absent means the full set. */
  readonly toolAllowlist?: readonly string[];
}

export interface HttpMcpAdapter {
  close(): Promise<void>;
  handleRequest(request: Request): Promise<Response>;
}

/**
 * One-shot signal that its session has closed. WHY IT EXISTS: in JSON response mode the SDK
 * parks each POST's `Promise<Response>` behind a `resolveJson` resolver in its stream mapping,
 * and the SDK's `close()` deletes that mapping WITHOUT settling the resolver while the abort it
 * raises makes the handler's completion path return early — so a session closed mid-call would
 * leave that HTTP response pending forever. The SDK `Server` owns `transport.onclose`, so the
 * close cannot be observed there without stealing the SDK's own hook; this latch is the
 * adapter-owned close signal instead, fired by the DELETE callback and by every sweep teardown.
 *
 * WHY SUBSCRIBERS AND NOT A SHARED PROMISE. A `Promise<void>` latch is never settled while the
 * session lives, so every `.then` chained onto it per request is retained until the close,
 * along with the Response each completed request had already produced: a long-lived session
 * accumulates one closure and one dead Response per call it ever served, and the eventual
 * release drains them all at once. A waiter that can deregister the moment its own request
 * settles holds nothing for a completed call.
 */
interface SessionCloseLatch {
  /** Idempotent: releasing an already-released latch is a no-op. */
  release(): void;
  /**
   * Runs `onClose` once when the session closes, or at once if it already has, and returns the
   * deregistration. A request that settles normally MUST deregister, or the latch retains it.
   */
  subscribe(onClose: () => void): () => void;
}

function createSessionCloseLatch(): SessionCloseLatch {
  const waiters = new Set<() => void>();
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      // Snapshot-then-clear, so a waiter that subscribes or deregisters while the release runs
      // cannot disturb the iteration, and nothing stays referenced after the release returns.
      const settling = [...waiters];
      waiters.clear();
      for (const onClose of settling) onClose();
    },
    subscribe(onClose: () => void): () => void {
      if (released) {
        onClose();
        return (): void => {};
      }
      waiters.add(onClose);
      return (): void => {
        waiters.delete(onClose);
      };
    },
  };
}

interface SessionAttachment {
  /**
   * JSON-RPC request ids this session is still serving. WHY: the SDK maps each pending request
   * to its response stream by bare `message.id`, so a second POST reusing an in-flight id would
   * OVERWRITE the first call's mapping — the first call's result would be delivered as the
   * second POST's body while the first response pends until the session closes. The adapter
   * refuses the duplicate before the SDK ever sees it; ids leave this set when their POST's
   * `handleRequest` promise settles.
   */
  readonly inflightRequestIds: Set<number | string>;
  /** Settles in-flight JSON-mode responses when this session closes. */
  readonly latch: SessionCloseLatch;
  readonly server: Server;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

interface OpenedSession extends SessionAttachment {
  /** True when the daemon refused to bind, so this pair must never serve a request. */
  bindFailed(): boolean;
}

async function openSessionTransport(
  options: HttpAdapterOptions,
  registry: HttpSessionRegistry<SessionAttachment>,
  request: Request,
  verdict: HttpAuthAccepted,
  listedTools: ReturnType<typeof httpListedTools>,
  now: () => number,
): Promise<OpenedSession> {
  const server = createHttpMcpServer(
    options.dispatchPort, options.serverName ?? "moe-runtime", listedTools,
  );
  const latch = createSessionCloseLatch();
  const inflightRequestIds = new Set<number | string>();
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
      // Released BEFORE the daemon is told: the latch is what settles a JSON-mode POST still
      // racing this session, and it must fire even if the daemon release below throws.
      onsessionclosed: async (id): Promise<void> => {
        latch.release();
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
            inflightRequestIds,
            latch,
            server,
            transport,
          }, now());
        } catch {
          failed = true;
        }
      },
      sessionIdGenerator: options.sessionIdFactory ?? ((): string => randomUUID()),
    });
  await server.connect(transport);
  return {
    bindFailed: (): boolean => failed,
    inflightRequestIds,
    latch,
    server,
    transport,
  };
}

/**
 * Builds the adapter. `handleRequest` is the single MCP endpoint: there is no second route, no
 * transport-only command, and no path that reaches a tool without passing this screen.
 */
export function createHttpMcpAdapter(options: HttpAdapterOptions): HttpMcpAdapter {
  // Resolved eagerly so an unknown or empty allowlist refuses at construction, not on
  // the first request a client makes.
  const listedTools = httpListedTools(options.toolAllowlist);
  const registry = createHttpSessionRegistry<SessionAttachment>();
  const now = options.now ?? Date.now;
  const idleTtlMs = options.sessionIdleTtlMs ?? HTTP_SESSION_IDLE_TTL_MS;

  /**
   * Lazy idle reap, run before each new session is minted: without it a client that vanishes
   * without a DELETE strands its SDK server and transport pair in the registry forever. The
   * release is the SAME sweep shutdown uses — daemon binding, transport, latch, server, with
   * per-entry containment — so a reaped session's latch settles any POST still in flight.
   */
  async function reapIdleSessions(): Promise<void> {
    const idle = registry.entries().filter(
      (entry) => entry.lastActivityAt !== undefined && now() - entry.lastActivityAt > idleTtlMs,
    );
    if (idle.length === 0) return;
    try {
      await closeAllDaemonSessions(registry, options.sessionPort, idle);
    } catch {
      // Deliberately NOT propagated, unlike close(): the sweep has already unregistered every
      // idle entry and given each its full per-entry teardown attempt, and the only requester
      // on this path is an UNRELATED client's initialize — refusing it would convert a
      // background release fault into a foreground refusal for a session that had no part in
      // the fault.
    }
  }

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
      registry.touch(screened.entry.sessionId, now());
      return screened.entry.attachment.transport.handleRequest(request, { authInfo });
    }

    const body = await readBoundedBody(request);
    if (!body.ok) return body.response;

    if (screened.entry !== undefined) {
      // Re-screened AFTER the body read: the entry was captured before an await the session's
      // DELETE can interleave with, and the SDK runs `onsessionclosed` BEFORE its `close()` —
      // in that window the registry entry is already gone while the transport still accepts
      // messages, so a dispatch here would EXECUTE a call whose client is simultaneously told
      // the session expired. Same 404 as a request that arrives after the close.
      if (registry.get(screened.entry.sessionId) === undefined) {
        return errorResponse(createRuntimeError({ code: "SESSION_EXPIRED" }), 404);
      }
      registry.touch(screened.entry.sessionId, now());
      const { inflightRequestIds, latch, transport } = screened.entry.attachment;
      // Screened BEFORE dispatch like every other refusal, and against BOTH conflicts a
      // correlatable id can have: one already in flight from an EARLIER POST on this session,
      // and one repeated inside THIS body. Either way the SDK's per-id stream mapping would be
      // overwritten and the two responses cross-wired — see SessionAttachment.inflightRequestIds.
      // The screen is pure, so this is still the last point at which nothing has been
      // registered: a refusal below leaves the session exactly as it found it.
      const screenedIds = screenRequestIds(body.value, inflightRequestIds);
      if (!screenedIds.ok) return refusalResponse("INPUT_INVALID");
      const { accepted } = screenedIds;
      for (const id of accepted) inflightRequestIds.add(id);
      // Raced against the close latch because in JSON response mode the SDK's own promise can
      // otherwise hang forever — see SessionCloseLatch. The latch leg loses to every normal
      // completion and turns a mid-call close into exactly the 404 this adapter serves a
      // request that arrives after the close. Raced by hand rather than via `Promise.race`
      // so the latch leg can be DEREGISTERED once the SDK settles: a completed call must not
      // stay parked on the session until its close.
      return new Promise<Response>((resolve, reject) => {
        let closedBeforeDispatch = false;
        const unsubscribe = latch.subscribe(() => {
          closedBeforeDispatch = true;
          resolve(errorResponse(createRuntimeError({ code: "SESSION_EXPIRED" }), 404));
        });
        // Ids release when the POST settles; on a mid-call close the SDK promise never
        // settles, and the ids die with the unregistered attachment instead.
        const settleRequest = (): void => {
          unsubscribe();
          for (const id of accepted) inflightRequestIds.delete(id);
        };
        // Belt behind the registry re-check above: a latch that has ALREADY released runs its
        // subscriber synchronously, so the resolve above just refused this call — dispatching
        // it into the closing session would execute it anyway.
        if (closedBeforeDispatch) {
          settleRequest();
          return;
        }
        transport
          .handleRequest(request, { authInfo, parsedBody: body.value })
          .then(resolve, reject)
          .finally(settleRequest);
      });
    }
    if (!isInitializePayload(body.value)) return refusalResponse("INPUT_INVALID");
    await reapIdleSessions();
    const opened = await openSessionTransport(
      options, registry, request, screened.verdict, listedTools, now,
    );
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
