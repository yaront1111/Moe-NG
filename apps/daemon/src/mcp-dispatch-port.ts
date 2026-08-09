import type { DatabaseSync } from "node:sqlite";

import { createRuntimeError } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { readSubscriptionPage } from "@moe/store/subscriptions/subscription-read-page.js";
import type { StdioDispatchPort } from "@moe/mcp";

import type { AffordancePort } from "./http/affordance-contract.js";
import { handleCommandRequest } from "./http/http-adapter.js";
import type { Authenticator, CommandAdapterDeps } from "./http/http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";

/**
 * The production dispatch port behind the stdio MCP server: the same committed
 * adapter pipeline the HTTP listener serves, with no second authority.
 *
 * Commands run through `handleCommandRequest` verbatim — authenticate,
 * compatibility, bounded decode, registry, authorize, payload shape, durable
 * decision — and the daemon's answer returns as bytes. Queries serve the one
 * read surface that exists (`events.read` over the committed subscription
 * seam); every other query kind refuses with the registry's stable
 * INPUT_INVALID rather than inventing an empty result.
 */

export interface McpDispatchPortConfig {
  /** The daemon's affordance surface, served to agents as work.get_context. */
  readonly affordances?: AffordancePort | undefined;
  /** The transport credential this port presents to the adapter, held in closure. */
  readonly credential: string;
  readonly database: DatabaseSync;
  readonly deps: CommandAdapterDeps;
  readonly store: SqliteEventStore;
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
    dispatchCommandBytes: (bytes: Uint8Array): Uint8Array => bytesOf(
      handleCommandRequest(config.deps, {
        body: bytes,
        credential: config.credential,
        protocolVersion: WIRE_PROTOCOL_VERSION,
      }),
    ),
    dispatchQueryBytes: (bytes: Uint8Array): Uint8Array => {
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
      return bytesOf(readSubscriptionPage(config.store, config.database, {
        projection,
        subscriberId,
        ...(typeof limit === "number" ? { limit } : {}),
      }));
    },
  });
}
