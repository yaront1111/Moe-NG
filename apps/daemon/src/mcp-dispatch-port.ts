import { createRuntimeError } from "@moe/contracts";
import type { HttpDispatchContext, StdioDispatchPort } from "@moe/mcp";

import type { AffordancePort } from "./http/affordance-contract.js";
import type { GoalSourceReadPort } from "./documents/document-source-full-read.js";
import type { ProductContractReadPort } from "./product-contract/product-contract-read-port.js";
import {
  eventStreamAccessUnavailable, eventStreamSubscriberMismatch,
} from "./http/event-stream-access.js";
import type { EventStreamAccessRefused } from "./http/event-stream-access.js";
import { readEventPage } from "./http/event-stream.js";
import type { SubscriptionPort } from "./http/event-stream-contract.js";
import { authenticateHttpRequest, handleAsyncCommandRequest } from "./http/http-adapter.js";
import { answerGraphPreviewQuery } from "./planning/graph-preview-query.js";
import { answerGraphQuery } from "./planning/graph-query.js";
import type {
  Authenticator, CommandAdapterDeps, CommandAuthorityPlanePort, HttpPortRefused,
} from "./http/http-contract.js";
import type { GraphQueryPort } from "./planning/graph-query.js";
import { COMMAND_AUTHORITY_PLANES, WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { DAEMON_COMMAND_SEAM } from "./http/http-async-contract.js";
import { answerWorkContextQuery } from "./mcp-work-context-query.js";

/**
 * The production dispatch port behind both MCP servers: the same committed adapter pipeline
 * the HTTP listener and stdio entry serve, with no second authority.
 *
 * Commands run through `handleAsyncCommandRequest` verbatim — authenticate,
 * compatibility, bounded decode, registry, authorize, payload shape, durable
 * decision — and the daemon's answer returns as bytes. WHICH command plane
 * answers is decided PER DISPATCH from the durable cutover marker, the MCP
 * mirror of the listener's per-request `/bootstrap` read: the `/1` deps until
 * `cutover.activate` commits, the `/2` deps from that instant on, in the same
 * process and through the same port, with nothing memoised at construction.
 * An agent session that outlives the activation is therefore not left behind
 * on a retired plane answering V1_AUTHORITY_RETIRED to every command. Queries serve the
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
  /** The goal's approved Product Contract reader; absent means product_contract.read refuses. */
  readonly contract?: ProductContractReadPort | undefined;
  /** The goal-scoped full-PRD reader; absent means documents.source_read refuses. */
  readonly documents?: GoalSourceReadPort | undefined;
  /** Stdio has one identity per process; HTTP always supplies its authenticated request bearer. */
  readonly fallbackCredential?: string | undefined;
  /** The current-active-graph reader; absent means graph.get refuses. */
  readonly graph?: GraphQueryPort | undefined;
  /** The `/1` command plane. Its authenticator and event-stream authority serve every query. */
  readonly deps: CommandAdapterDeps;
  /**
   * The separately composed `/2` command plane, on the listener's own rule
   * (`StartListenerOptions.v2Deps`): absence is an explicit unavailable plane
   * that REFUSES a V2 dispatch, never a fallback to `deps`.
   */
  readonly v2Deps?: CommandAdapterDeps | undefined;
  /**
   * The plane a command is dispatched on, read on EVERY dispatch. Absent means
   * V1, the plane `/command` serves on a daemon that composes no plane reader.
   * An answer outside the plane roster throws COMMAND_AUTHORITY_PLANE_INVALID,
   * exactly as `composeBootstrapBody` does; it is never coerced to V1.
   */
  readonly commandAuthorityPlane?: CommandAuthorityPlanePort | undefined;
  /** The daemon's committed subscription seam — the provider's, folded on read. */
  readonly subscriptions: SubscriptionPort;
}

/**
 * The plane reads V2 and no `/2` deps were composed. Mirrors LISTENER_V2_COMMAND_UNAVAILABLE
 * and is answered on the command SEAM's layer, as the adapter's own wiring refusals are: a
 * fact about how this host was composed, never a port's answer.
 */
export const MCP_V2_COMMAND_UNAVAILABLE = "MCP_V2_COMMAND_UNAVAILABLE" as const;
const V2_UNAVAILABLE_STATUS = 503;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesOf(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

type CommandPlaneResolution =
  | { readonly deps: CommandAdapterDeps; readonly ok: true }
  | { readonly ok: false; readonly refusal: HttpPortRefused };

/**
 * The plane for THIS dispatch. Read fresh every time: a port that captured the
 * answer at construction would pin an agent session to whichever plane was
 * authoritative when its process started, which is the exact defect this closes.
 */
function resolveCommandPlane(config: McpDispatchPortConfig): CommandPlaneResolution {
  const plane: unknown = config.commandAuthorityPlane === undefined
    ? "V1" : config.commandAuthorityPlane.readPlane();
  if (typeof plane !== "string"
    || !(COMMAND_AUTHORITY_PLANES as readonly string[]).includes(plane)) {
    throw new Error("COMMAND_AUTHORITY_PLANE_INVALID");
  }
  if (plane === "V1") return { deps: config.deps, ok: true };
  if (config.v2Deps === undefined) {
    return {
      ok: false,
      refusal: Object.freeze({
        httpStatus: V2_UNAVAILABLE_STATUS,
        ok: false as const,
        outcome: "PORT_REFUSED" as const,
        refusal: Object.freeze({
          code: MCP_V2_COMMAND_UNAVAILABLE,
          detail: "the durable cutover marker names the /2 plane and this MCP host composed none",
          httpStatus: V2_UNAVAILABLE_STATUS,
          layer: DAEMON_COMMAND_SEAM,
        }),
        stage: "DISPATCH" as const,
      }),
    };
  }
  return { deps: config.v2Deps, ok: true };
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
// daemon-minted offers, and active claims — exactly what the board renders. A payload naming
// one `workItemId` narrows the answer to that step; the decision lives in
// `answerWorkContextQuery` so this handler stays a delegate and the port owns only the clock,
// the refusal mapping and the bytes.
const answerWorkContext: QueryHandler = (envelope, _context, config) => {
  if (config.affordances === undefined) return queryRefusal();
  const answer = answerWorkContextQuery(
    envelope["payload"], config.affordances.readSurface(), new Date().toISOString(),
  );
  // INPUT_INVALID is the ONLY answer without an `outcome`: a product refusal carries
  // `outcome: "REFUSED"`, so key absence — not the code alone — is what selects the
  // port's generic envelope.
  return "outcome" in answer ? bytesOf(answer) : queryRefusal();
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

// The planning agent's PRD read: goal-scoped and identity-bearing, resolved the
// way the command path resolves its credential. The port re-proves every byte
// against the goal's own binding, so this handler decides nothing itself.
const answerDocumentsSourceRead: QueryHandler = (envelope, context, config) => {
  if (config.documents === undefined) return queryRefusal();
  const authenticated = authenticateHttpRequest(
    authenticatorOf(config.deps),
    context?.credential ?? config.fallbackCredential ?? null,
    WIRE_PROTOCOL_VERSION,
  );
  if (!authenticated.ok) return bytesOf(authenticated);
  const payload = envelope["payload"];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return queryRefusal();
  }
  const request = payload as Record<string, unknown>;
  const keys = Object.keys(request);
  if (typeof request["goalRef"] !== "string") return queryRefusal();
  // The whole text with `{goalRef}` alone (the original shape), or ONE PAGE with
  // `{goalRef, offset, limit}`. Measured 2026-09-03: a real planning seat cannot
  // carry a ~121 KB answer in one tool result, so a page is what it reads.
  const paged = keys.length === 3 && "offset" in request && "limit" in request;
  if (!paged && keys.length !== 1) return queryRefusal();
  const answer = config.documents.read(request["goalRef"]);
  if (!paged || !answer.ok) return bytesOf(answer);
  const offset = request["offset"];
  const limit = request["limit"];
  if (!Number.isSafeInteger(offset) || (offset as number) < 0
    || !Number.isSafeInteger(limit) || (limit as number) < 1
    || (limit as number) > SOURCE_PAGE_MAX_CHARS) return queryRefusal();
  const totalLength = answer.text.length;
  const start = Math.min(offset as number, totalLength);
  const end = Math.min(start + (limit as number), totalLength);
  return bytesOf({
    ...answer,
    limit,
    nextOffset: end < totalLength ? end : null,
    offset: start,
    text: answer.text.slice(start, end),
    totalLength,
  });
};

/** The largest PRD page a seat may ask for, in UTF-16 code units. */
const SOURCE_PAGE_MAX_CHARS = 32_768;

// The planning seat's read of the goal's APPROVED contract: the Gate 1 triple and the
// revision's requirements and criteria — resolved from durable state, never from the seat.
const answerProductContractRead: QueryHandler = (envelope, context, config) => {
  if (config.contract === undefined) return queryRefusal();
  const authenticated = authenticateHttpRequest(
    authenticatorOf(config.deps),
    context?.credential ?? config.fallbackCredential ?? null,
    WIRE_PROTOCOL_VERSION,
  );
  if (!authenticated.ok) return bytesOf(authenticated);
  const payload = envelope["payload"];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return queryRefusal();
  }
  const request = payload as Record<string, unknown>;
  if (Object.keys(request).length !== 1 || typeof request["goalRef"] !== "string") {
    return queryRefusal();
  }
  return bytesOf(config.contract.read(request["goalRef"]));
};

/** Every query kind this port serves, and the only place that set is decided. */
const QUERY_HANDLERS: Readonly<Record<string, QueryHandler>> = Object.freeze({
  "documents.source_read": answerDocumentsSourceRead,
  "events.read": answerEventsRead,
  "graph.get": answerGraphGet,
  "graph.preview": answerGraphPreview,
  "product_contract.read": answerProductContractRead,
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
    ): Promise<Uint8Array> => {
      // The plane is a SERVER fact read before the bytes are looked at, so no
      // envelope field can select it; the MCP adapter has already authenticated
      // the caller by the time this runs (the port's own call-sequence contract).
      const plane = resolveCommandPlane(config);
      if (!plane.ok) return bytesOf(plane.refusal);
      return bytesOf(await handleAsyncCommandRequest(plane.deps, {
        body: bytes,
        credential: context?.credential ?? config.fallbackCredential ?? null,
        protocolVersion: WIRE_PROTOCOL_VERSION,
      }, context === undefined ? "MCP_STDIO" : "MCP_HTTP"));
    },
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
