import { createRuntimeError } from "@moe/contracts";
import type { HttpDispatchContext, StdioDispatchPort } from "@moe/mcp";

import type { AffordancePort } from "./http/affordance-contract.js";
import { readEventPage } from "./http/event-stream.js";
import type { SubscriptionPort } from "./http/event-stream-contract.js";
import { handleAsyncCommandRequest } from "./http/http-adapter.js";
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
 * decision — and the daemon's answer returns as bytes. Queries serve the one
 * read surface that exists (`events.read` over the committed subscription
 * seam) through the SAME wire encoder the HTTP listener uses, so an agent and
 * the control room read one frame shape — bigint positions as strings, seam
 * observations attached; every other query kind refuses with the registry's
 * stable INPUT_INVALID rather than inventing an empty result.
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

function authenticatorOf(deps: CommandAdapterDeps): Authenticator {
  return deps.authenticator;
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
      // The agent's "what should I do": the affordance surface — chain standing,
      // daemon-minted offers, and active claims — exactly what the board renders.
      if (envelope["queryKind"] === "work.get_context") {
        if (config.affordances === undefined) return queryRefusal();
        return bytesOf(config.affordances.readSurface());
      }
      // The one query that needs an identity. The shared handler owns the whole
      // sequence — authenticate, compatibility, capability, availability,
      // project — so this branch resolves the credential the way the command
      // path does and adapts the answer to bytes, and decides nothing itself.
      if (envelope["queryKind"] === "graph.get") {
        if (config.graph === undefined) return queryRefusal();
        return bytesOf(answerGraphQuery({
          authenticator: authenticatorOf(config.deps),
          body: envelope["payload"],
          credential: context?.credential ?? config.fallbackCredential ?? null,
          port: config.graph,
          protocolVersion: WIRE_PROTOCOL_VERSION,
        }));
      }
      if (envelope["queryKind"] !== "events.read") return queryRefusal();
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
      const limit = request["limit"];
      return bytesOf(readEventPage(config.subscriptions, {
        projection,
        subscriberId,
        ...(typeof limit === "number" ? { limit } : {}),
      }));
    },
  });
}
