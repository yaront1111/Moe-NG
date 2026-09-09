import { createServer } from "node:http";
import type { Server } from "node:http";

import { createHttpMcpAdapter } from "@moe/mcp";
import type { HttpMcpAdapter } from "@moe/mcp";

import type { AffordancePort } from "../http/affordance-contract.js";
import type { SubscriptionPort } from "../http/event-stream-contract.js";
import type { CommandAdapterDeps, CommandAuthorityPlanePort } from "../http/http-contract.js";
import { createMcpDispatchPort } from "../mcp-dispatch-port.js";
import { wiredMcpToolKinds } from "../mcp-tool-allowlist.js";
import type { GoalSourceReadPort } from "../documents/document-source-full-read.js";
import type { GraphQueryPort } from "../planning/graph-query.js";
import type { DesignReadPort } from "../mcp-design-read-query.js";
import type { ProductContractReadPort } from "../product-contract/product-contract-read-port.js";
import { MCP_HTTP_BODY_TOO_LARGE } from "./mcp-http-body-bound.js";
import { webRequestFrom, writeWebResponse } from "./mcp-http-node-bridge.js";
import { createMcpHttpSessionPort } from "./mcp-http-session-port.js";

/**
 * The production consumer of `@moe/mcp`'s official Streamable HTTP adapter.
 *
 * NO SECOND AUTHORITY IS CREATED HERE. The dispatch port is the value `createMcpDispatchPort`
 * already returns — the same one the stdio entry uses — so commands run through
 * `handleCommandRequest` verbatim and both transports funnel into one durable pipeline.
 * `HttpDispatchPort` accepts an optional AbortSignal and tolerates an async result, both
 * supersets of the stdio shape, so that value is assignable unchanged and no second envelope
 * vocabulary exists. Credential screening is the session port's single call into the daemon's
 * own `Authenticator`.
 *
 * This host owns exactly one thing the adapter cannot: a socket. There is one MCP endpoint, no
 * routing table, no custom WebSocket, and no alternate lifecycle.
 */

export interface McpHttpHostOptions {
  readonly affordances?: AffordancePort | undefined;
  /** The goal's approved Product Contract reader; absent means product_contract.read refuses. */
  readonly contract?: ProductContractReadPort | undefined;
  /** The goal's design-revision reader; absent means design.read refuses. THIS host is the
   *  seats' only MCP endpoint (`orchestrator/agent-wrapper-main.ts`), so leaving it unset is
   *  what would make the design step unstaffable while the tool still appeared on the roster. */
  readonly design?: DesignReadPort | undefined;
  /** The goal-scoped full-PRD reader; absent means documents.source_read refuses. */
  readonly documents?: GoalSourceReadPort | undefined;
  /** The current-active-graph reader; absent means graph.get refuses. */
  readonly graph?: GraphQueryPort | undefined;
  /** The `/1` command plane; its authenticator also screens every MCP session. */
  readonly deps: CommandAdapterDeps;
  /** The `/2` command plane. Absent means a V2 dispatch refuses; it never falls back to `deps`. */
  readonly v2Deps?: CommandAdapterDeps | undefined;
  /** Read per dispatch to choose between `deps` and `v2Deps`. Absent means V1. */
  readonly commandAuthorityPlane?: CommandAuthorityPlanePort | undefined;
  /** JSON bodies instead of SSE frames. Deterministic; the parity fixtures use it. */
  readonly enableJsonResponse?: boolean;
  readonly host?: string;
  readonly port?: number;
  /** The daemon's committed subscription seam, handed through to the dispatch port. */
  readonly subscriptions: SubscriptionPort;
}

export type McpHttpStartResult =
  | { readonly ok: false; readonly code: McpHttpHostRefusalCode }
  | { readonly ok: true; readonly origin: string; readonly port: number };

/** Closed refusal vocabulary for the host's own lifecycle. No other code is selectable. */
export const MCP_HTTP_HOST_REFUSAL_CODES = Object.freeze([
  "MCP_HTTP_HOST_ALREADY_STARTED",
  "MCP_HTTP_HOST_BIND_FAILED",
  "MCP_HTTP_HOST_NON_LOOPBACK_BIND",
] as const);

export type McpHttpHostRefusalCode = (typeof MCP_HTTP_HOST_REFUSAL_CODES)[number];

export interface McpHttpHost {
  /** The in-process path: exactly the code the listener feeds, without a socket. */
  handleRequest(request: Request): Promise<Response>;
  start(): Promise<McpHttpStartResult>;
  stop(): Promise<void>;
}

/** Loopback is the whole allowlist, matching the control-room listener and the adapter screen. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export const MCP_HTTP_PORT_ENV = "MOE_MCP_HTTP_PORT" as const;
export const MCP_HTTP_HOST_ENV = "MOE_MCP_HTTP_HOST" as const;

/**
 * The bind port from the environment. Lives with the host rather than with the entry because
 * an entry is executed and never imported — it has no `.js` bridge, so nothing can import this
 * from there, and config parsing with a refusal path has to be reachable by a test.
 *
 * Absent or empty means an ephemeral port. Anything else must be a valid port number: a typo is
 * refused BY VARIABLE NAME rather than coerced to 0, because a daemon that quietly comes up on
 * a random port when the operator named a specific one is worse than one that fails to start.
 * The message never contains the offending value.
 */
export function readHttpPort(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[MCP_HTTP_PORT_ENV];
  if (raw === undefined || raw === "") return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${MCP_HTTP_PORT_ENV}_INVALID`);
  }
  return port;
}

function originOf(host: string, port: number): string {
  // IPv6 literals need brackets in an origin, or the URL parses as host "::1" port undefined.
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}:${String(port)}`;
}

function refuse(code: McpHttpHostRefusalCode): McpHttpStartResult {
  return Object.freeze({ code, ok: false as const });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    // THE RESTART-CRITICAL CALL, and the reason is narrower than the folklore. Since Node 19,
    // `close()` already reaps IDLE keep-alive sockets, so a plain request/response cycle does
    // not need this. An ACTIVE connection is different: `close()` waits for it, and this
    // adapter's default transport mode is SSE — a stream that stays open by design. Without
    // this call, stopping a host with a live event stream never resolves. Drill D4 is killed
    // by the SSE case and by nothing weaker.
    server.closeAllConnections?.();
    server.close(() => { resolve(); });
  });
}

export function createMcpHttpHost(options: McpHttpHostOptions): McpHttpHost {
  const host = options.host ?? "127.0.0.1";

  let server: Server | null = null;
  let adapter: HttpMcpAdapter | null = null;
  let origin = originOf(host, options.port ?? 0);

  /**
   * The adapter is LIFECYCLE-SCOPED, not host-scoped, and that is a decision rather than an
   * accident. `stop()` must close it — it owns live transports and sessions — but the daemon
   * must also restart, so a host that closed its only adapter would come back up unable to
   * serve. Building it on demand means stop closes exactly one adapter and the next start gets
   * a fresh one, with durable state untouched because none of it lives here.
   */
  const adapterOf = (): HttpMcpAdapter => {
    adapter ??= createHttpMcpAdapter({
      dispatchPort: createMcpDispatchPort({
        affordances: options.affordances,
        commandAuthorityPlane: options.commandAuthorityPlane,
        contract: options.contract,
        deps: options.deps,
        design: options.design,
        documents: options.documents,
        graph: options.graph,
        subscriptions: options.subscriptions,
        v2Deps: options.v2Deps,
      }),
      ...(options.enableJsonResponse === undefined
        ? {}
        : { enableJsonResponse: options.enableJsonResponse }),
      sessionPort: createMcpHttpSessionPort(options.deps.authenticator),
      serverName: "moe-next",
      // Same roster as the stdio entry, from the same derivation.
      toolAllowlist: wiredMcpToolKinds(),
    });
    return adapter;
  };

  const handleRequest = (request: Request): Promise<Response> => adapterOf().handleRequest(request);

  /**
   * Lifecycle transitions are SERIALISED, and this is a correctness fix rather than tidiness.
   * `start` assigns `server` only after awaiting `listen`, so a bare `server !== null` check is
   * check-then-act: two concurrent `start()` calls both observe null, both bind a socket, and
   * the first listener is orphaned by the second's assignment — leaked, unreachable and never
   * closed. Sequential `await start()` in a test never sees it. Chaining every transition makes
   * the second caller observe the first's committed result, so it refuses instead of binding.
   */
  let lifecycle: Promise<unknown> = Promise.resolve();
  function serialise<T>(operation: () => Promise<T>): Promise<T> {
    const next = lifecycle.then(operation, operation);
    lifecycle = next.then(() => undefined, () => undefined);
    return next;
  }

  const doStart = async (): Promise<McpHttpStartResult> => {
    // Single ownership, checked before any side effect: a second start must never bind twice.
    if (server !== null) return refuse("MCP_HTTP_HOST_ALREADY_STARTED");
    // Refuses to START, not warns. An MCP endpoint reachable off-host on a machine also running
    // agent processes is an exposure, not a convenience.
    if (!LOOPBACK_HOSTS.has(host)) return refuse("MCP_HTTP_HOST_NON_LOOPBACK_BIND");

    let bound: Server | null = null;
    try {
      bound = createServer((incoming, outgoing) => {
        // THE DISCONNECT LIFELINE, wired here because only the host holds the node pair. The
        // response 'close' event is the one signal that fires when the peer terminates the
        // connection prematurely — since Node 16 the request's own 'close' means "message
        // complete", which for a bodiless SSE GET is immediately — and `writableFinished`
        // separates that termination from a normally finished exchange, where aborting would
        // be noise. The bridge threads the signal into the Request and cancels its own reader
        // on the same event, so both the adapter and the pump observe the drop.
        const lifeline = new AbortController();
        outgoing.on("close", () => {
          if (!outgoing.writableFinished) lifeline.abort();
        });
        void (async (): Promise<void> => {
          const response = await handleRequest(
            await webRequestFrom(incoming, origin, lifeline.signal),
          );
          await writeWebResponse(response, outgoing);
        })().catch((error: unknown) => {
          // A throw must still answer and must still leave the listener closable; it may never
          // surface as a hung socket. Nothing from the error reaches the client. An over-cap
          // body is a client fault (413), every other throw is an internal one (500).
          const tooLarge = error instanceof Error && error.message === MCP_HTTP_BODY_TOO_LARGE;
          if (!outgoing.headersSent) outgoing.statusCode = tooLarge ? 413 : 500;
          outgoing.end();
        });
      });

      const listener = bound;
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(options.port ?? 0, host, resolve);
      });

      const address = listener.address();
      if (address === null || typeof address === "string") {
        await closeServer(listener);
        return refuse("MCP_HTTP_HOST_BIND_FAILED");
      }
      origin = originOf(host, address.port);
      server = listener;
      return Object.freeze({ ok: true as const, origin, port: address.port });
    } catch {
      // Closed on the failure path too: a half-bound server left behind surfaces later as EBUSY
      // on Windows rather than as the real error.
      if (bound !== null) await closeServer(bound);
      return refuse("MCP_HTTP_HOST_BIND_FAILED");
    }
  };

  const doStop = async (): Promise<void> => {
    // Idempotent and exactly-once: both fields are cleared BEFORE any await, so a concurrent or
    // repeated stop cannot close the same server or adapter twice, and a stop with nothing
    // bound is a no-op rather than a throw.
    const bound = server;
    const open = adapter;
    server = null;
    adapter = null;
    // Listener first, then adapter: closing the adapter while a socket can still deliver a
    // request would race a live transport against its own teardown.
    if (bound !== null) await closeServer(bound);
    if (open !== null) await open.close();
  };

  return Object.freeze({
    handleRequest,
    start: (): Promise<McpHttpStartResult> => serialise(doStart),
    stop: (): Promise<void> => serialise(doStop),
  });
}
