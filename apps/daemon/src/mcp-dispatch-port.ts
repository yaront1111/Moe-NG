import { createRuntimeError } from "@moe/contracts";
import type { HttpDispatchContext, StdioDispatchPort } from "@moe/mcp";

import type { AffordancePort } from "./http/affordance-contract.js";
import {
  eventStreamAccessUnavailable, eventStreamSubscriberMismatch,
} from "./http/event-stream-access.js";
import type { EventStreamAccessRefused } from "./http/event-stream-access.js";
import { readEventPage } from "./http/event-stream.js";
import type { SubscriptionPort } from "./http/event-stream-contract.js";
import { authenticateHttpRequest, handleAsyncCommandRequest } from "./http/http-adapter.js";
import { answerGraphPreviewQuery } from "./planning/graph-preview-query.js";
import { answerGraphQuery } from "./planning/graph-query.js";
import type { Authenticator, CommandAdapterDeps } from "./http/http-contract.js";
import type { GraphQueryPort } from "./planning/graph-query.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";

/**
 * The production dispatch port behind both MCP servers: the same committed adapter pipeline
 * the HTTP listener and stdio entry serve, with no second authority.
 *
 * Commands run through `handleAsyncCommandRequest` verbatim — authenticate,
 * compatibility, bounded decode, registry, authorize, payload shape, durable
 * decision — and the daemon's answer returns as bytes. Queries serve the
 * committed subscription seam (`events.read`) through the SAME wire encoder the HTTP listener
 * uses, so an agent and the control room read one frame shape — bigint
 * positions as strings, seam observations attached; every other query kind
 * refuses with the registry's stable INPUT_INVALID rather than inventing an
 * empty result.
 *
 * The query half routes through ONE frozen handler table, never a chain of literal
 * comparisons, so the served set is enumerable from production as `servedMcpQueryKinds()`
 * and can be compared against the advertised roster in both directions. A kind added to the
 * table without being advertised — or advertised without being added — reddens the parity
 * suite instead of drifting silently.
 */

export interface McpDispatchPortConfig {
  /** The daemon's affordance surface, served to agents as work.get_context. */
  readonly affordances?: AffordancePort | undefined;
  /** Stdio has one identity per process; HTTP always supplies its authenticated request bearer. */
  readonly fallbackCredential?: string | undefined;
  /** The current-active-graph reader; absent means graph.get refuses. */
  readonly graph?: GraphQueryPort | undefined;
  readonly deps: CommandAdapterDeps;
  /** The daemon's committed subscription seam — the provider's, folded on read. */
  readonly subscriptions: SubscriptionPort;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesOf(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function queryRefusal(): Uint8Array {
  return bytesOf({ error: createRuntimeError({ code: "INPUT_INVALID" }), ok: false });
}

function eventStreamRefusal(refusal: EventStreamAccessRefused): Uint8Array {
  return bytesOf({ code: refusal.code, layer: refusal.layer, outcome: "REFUSED" });
}

function authenticatorOf(deps: CommandAdapterDeps): Authenticator {
  return deps.authenticator;
}

/**
 * One query kind's whole answer. The signature is the SEAM: every kind this daemon serves is a
 * key in the table below, so the served set is READABLE (`servedMcpQueryKinds`) instead of
 * being buried in a chain of literal comparisons no test could enumerate.
 */
type QueryHandler = (
  envelope: Record<string, unknown>,
  context: HttpDispatchContext | undefined,
  config: McpDispatchPortConfig,
) => Uint8Array;

// The agent's "what should I do": the affordance surface — chain standing,
// daemon-minted offers, and active claims — exactly what the board renders.
const answerWorkContext: QueryHandler = (_envelope, _context, config) => {
  if (config.affordances === undefined) return queryRefusal();
  return bytesOf(config.affordances.readSurface());
};

// The one query that needs an identity. The shared handler owns the whole
// sequence — authenticate, compatibility, capability, availability,
// project — so this handler resolves the credential the way the command
// path does and adapts the answer to bytes, and decides nothing itself.
const answerGraphGet: QueryHandler = (envelope, context, config) => {
  if (config.graph === undefined) return queryRefusal();
  return bytesOf(answerGraphQuery({
    authenticator: authenticatorOf(config.deps),
    body: envelope["payload"],
    credential: context?.credential ?? config.fallbackCredential ?? null,
    port: config.graph,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }));
};

// Preview sits beside graph.get on the SAME gate and resolves its
// credential the same way — but it is zero-authority, so it needs no
// `config.graph`: a daemon composed without graph support still serves it.
const answerGraphPreview: QueryHandler = (envelope, context, config) => bytesOf(
  answerGraphPreviewQuery({
    authenticator: authenticatorOf(config.deps),
    body: envelope["payload"],
    credential: context?.credential ?? config.fallbackCredential ?? null,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  }),
);

const answerEventsRead: QueryHandler = (envelope, context, config) => {
  const authenticated = authenticateHttpRequest(
    authenticatorOf(config.deps),
    context?.credential ?? config.fallbackCredential ?? null,
    WIRE_PROTOCOL_VERSION,
  );
  if (!authenticated.ok) return bytesOf(authenticated);
  const authority = config.deps.eventStreamAccess?.authorize(authenticated.principal)
    ?? eventStreamAccessUnavailable();
  if (!authority.ok) return eventStreamRefusal(authority);
  const payload = envelope["payload"];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return queryRefusal();
  }
  const request = payload as Record<string, unknown>;
  const projection = request["projection"];
  const subscriberId = request["subscriberId"];
  if (typeof projection !== "string" || typeof subscriberId !== "string") {
    return queryRefusal();
  }
  if (subscriberId !== authority.subscriberId) {
    return eventStreamRefusal(eventStreamSubscriberMismatch());
  }
  const limit = request["limit"];
  return bytesOf(readEventPage(config.subscriptions, {
    projection,
    subscriberId: authority.subscriberId,
    ...(typeof limit === "number" ? { limit } : {}),
  }));
};

/** Every query kind this port serves, and the only place that set is decided. */
const QUERY_HANDLERS: Readonly<Record<string, QueryHandler>> = Object.freeze({
  "events.read": answerEventsRead,
  "graph.get": answerGraphGet,
  "graph.preview": answerGraphPreview,
  "work.get_context": answerWorkContext,
});

const SERVED_QUERY_KINDS: readonly string[] = Object.freeze(
  [...Object.keys(QUERY_HANDLERS)].sort(),
);

/**
 * The served query roster, read off the dispatch table itself. `mcp-tool-allowlist.ts` keeps
 * the ADVERTISED roster by hand and never imports this: two independent enumerations are what
 * lets `mcp-tool-allowlist.test.ts` prove set-equality in BOTH directions. One frozen value,
 * so two reads are identity-stable.
 */
export function servedMcpQueryKinds(): readonly string[] {
  return SERVED_QUERY_KINDS;
}

export function createMcpDispatchPort(config: McpDispatchPortConfig): StdioDispatchPort {
  return Object.freeze({
    authenticate: (credential: string, _toolKind: string) => {
      const verdict = authenticatorOf(config.deps).authenticate(credential);
      if (verdict.verdict !== "AUTHENTICATED") {
        return Object.freeze({
          error: createRuntimeError({ code: "AUTHENTICATION_FAILED" }),
          ok: false as const,
        });
      }
      return Object.freeze({ ok: true as const });
    },
    dispatchCommandBytes: async (
      bytes: Uint8Array,
      context?: HttpDispatchContext,
    ): Promise<Uint8Array> => bytesOf(
      await handleAsyncCommandRequest(config.deps, {
        body: bytes,
        credential: context?.credential ?? config.fallbackCredential ?? null,
        protocolVersion: WIRE_PROTOCOL_VERSION,
      }),
    ),
    // THE CONTEXT PARAMETER IS ADDITIVE, exactly as `dispatchCommandBytes`
    // already carries one: `StdioDispatchPort` declares
    // `dispatchQueryBytes(bytes)`, and an implementation taking one more
    // OPTIONAL parameter still satisfies it, so no @moe/mcp change is needed.
    // Without it no principal — and therefore no project — is reachable in the
    // query path, which `work.get_context` and `events.read` never needed and
    // `graph.get` cannot do without.
    dispatchQueryBytes: (bytes: Uint8Array, context?: HttpDispatchContext): Uint8Array => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoder.decode(bytes)) as unknown;
      } catch {
        return queryRefusal();
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return queryRefusal();
      }
      const envelope = parsed as Record<string, unknown>;
      const kind = envelope["queryKind"];
      // `Object.hasOwn` is load-bearing, not defensive noise: `queryKind` is attacker-
      // controlled wire input and a plain object literal inherits from Object.prototype,
      // so a bare `QUERY_HANDLERS[kind]` resolves "toString"/"constructor"/"valueOf" to
      // real functions and would CALL one as a handler, returning a non-Uint8Array.
      const handler = typeof kind === "string" && Object.hasOwn(QUERY_HANDLERS, kind)
        ? QUERY_HANDLERS[kind]
        : undefined;
      return handler === undefined ? queryRefusal() : handler(envelope, context, config);
    },
  });
}
