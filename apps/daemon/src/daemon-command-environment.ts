import type { SqliteEventStore } from "@moe/store";

import { DomainRefusal } from "./daemon-command-dispatch.js";
import type { DurableDecision } from "./http/http-contract.js";
import { environmentRefusal } from "./environment/environment-contracts.js";
import type { EnvironmentRefusal } from "./environment/environment-contracts.js";
import {
  ENVIRONMENT_COMMAND_KIND_SET, ENVIRONMENT_COMMAND_KIND_UNSET,
  setEnvironmentVariable, unsetEnvironmentVariable,
} from "./environment/environment-store.js";
import type {
  EnvironmentCredentialSource, EnvironmentReadResult,
} from "./environment/environment-store.js";

/**
 * The command edge for the two OPERATOR-ONLY environment-variable writes.
 *
 * WHY THIS EDGE EXISTS AT ALL, rather than the registry's shared `requestOf` path. `requestOf`
 * encodes the WHOLE envelope -- `payload` included -- into the request bytes every bootstrap
 * service persists beside its decision. `environment.set_variable`'s payload holds a production
 * secret, so taking that path would write the plaintext into durable command bytes on the very
 * first dispatch. This edge is disjoint from `requestOf` for exactly the same reason
 * `preview.decide` and the five graph mutations are: an exact request shape the shared assembler
 * cannot express. `daemon-command-families.ts` states the same rule from the roster side.
 *
 * WHAT THIS EDGE MAY DO. Translate, and nothing else. It does NOT validate a name, a size, a
 * scope or a key -- `environment-store.ts` owns all four checks and their fixed order, so a
 * second opinion here would give a doubly-invalid request a whichever-ran-first answer. It does
 * NOT catch and re-wrap the store's refusals either: each one already carries the code AND the
 * layer of whichever surface answered, and restamping them would report NAME trouble as an edge
 * fault. The one thing it adds is a TYPE reading of the wire, below.
 *
 * WHAT IT MAY NEVER DO: interpolate, log, echo or re-serialize the submitted value. Refusal
 * details are the store's own fixed prose, keyed by code and never built from input, so no
 * refusal this edge throws can carry a secret. `daemon-command-environment.test.ts` holds the
 * canary that proves it over the real dispatch path.
 */

export type EnvironmentEdgeKind =
  | typeof ENVIRONMENT_COMMAND_KIND_SET
  | typeof ENVIRONMENT_COMMAND_KIND_UNSET;

/**
 * The two fields this edge reads and NO others. Deliberately narrower than
 * `RuntimeCommandEnvelope`: a correlation id, an expected version or a principal reaching this
 * module would be one more field a value could be copied into on its way to a log line.
 */
export interface EnvironmentEdgeEnvelope {
  readonly commandId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EnvironmentEdgeContext {
  readonly credential: EnvironmentCredentialSource;
  readonly envelope: EnvironmentEdgeEnvelope;
  readonly kind: EnvironmentEdgeKind;
  readonly now: () => string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

/** One result code per kind: an accepted write IS the state it names. */
export const ENVIRONMENT_EDGE_RESULT_CODES = Object.freeze({
  [ENVIRONMENT_COMMAND_KIND_SET]: "ENVIRONMENT_VARIABLE_SET",
  [ENVIRONMENT_COMMAND_KIND_UNSET]: "ENVIRONMENT_VARIABLE_UNSET",
} as const satisfies Readonly<Record<EnvironmentEdgeKind, string>>);

/**
 * The wire is JSON, so a field the type says is a string can arrive as null, a number or an
 * object. Each wrong-typed field refuses at the layer that OWNS that field, reusing the store's
 * closed four-code roster rather than minting a fifth: `environment-store.ts` already documents
 * ENV_VALUE_TOO_LARGE as the VALUE layer's answer for a non-string value, and this keeps the
 * command edge and the store agreeing on what a malformed request is called.
 */
function readString(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function refuse(refusal: EnvironmentRefusal): never {
  // The store's own code, layer and FIXED detail, forwarded unrestamped. The detail is a
  // constant keyed by code (`ENVIRONMENT_REFUSAL_DETAILS`), never built from the request, so
  // nothing the caller submitted can ride out on this path.
  throw new DomainRefusal(refusal.code, refusal.layer, refusal.detail);
}

function answer(
  context: EnvironmentEdgeContext,
  result: EnvironmentReadResult,
): DurableDecision {
  if (!result.ok) refuse(result);
  return Object.freeze({
    commandId: context.envelope.commandId,
    // Always DECIDED, never REPLAYED, and that is a measured fact rather than a simplification:
    // see the retry note on `runEnvironmentEdge`. A replay this edge could report would have to
    // be minted here, and an edge that decides for itself that a write "already happened" is an
    // idempotency authority reimplemented outside the store that owns one.
    disposition: "DECIDED" as const,
    // The variable table is not an effect: the write IS the decision, and there is no
    // downstream activation for a caller to bind to.
    effectId: null,
    resultCode: ENVIRONMENT_EDGE_RESULT_CODES[context.kind],
  });
}

/**
 * Serves both kinds. The envelope's `commandId` is handed to the store so a RETRIED command
 * cannot append a second event -- the store's optional `commandId` exists for this caller and
 * nothing else.
 *
 * WHAT A RETRY ACTUALLY DOES, measured rather than assumed. The store keys a receipt by command
 * id and compares REQUEST DIGESTS, and an environment write's digest can never repeat: the set
 * event carries a freshly-nonced seal and both events carry a fresh `eventId`. So a resubmitted
 * command id raises the store's own `CommandIdConflictError` (409/503 `COMMAND_ID_CONFLICT` at
 * DURABLE_STORE, whose message names the command id and nothing else) INSTEAD of replaying. The
 * property that matters holds either way and is the one asserted: the aggregate does not
 * advance twice, so a retried set never double-writes. The error travels unwrapped, because it
 * is the store's fact about the store and carries no value.
 */
export function runEnvironmentEdge(context: EnvironmentEdgeContext): DurableDecision {
  const { envelope, kind, store } = context;
  const environment = readString(envelope.payload, "environment");
  if (environment === null) refuse(environmentRefusal("ENV_ENVIRONMENT_UNKNOWN"));
  const name = readString(envelope.payload, "name");
  if (name === null) refuse(environmentRefusal("ENV_NAME_INVALID"));

  const config = {
    credential: context.credential,
    now: context.now,
    projectId: context.projectId,
    store,
  };
  if (kind === ENVIRONMENT_COMMAND_KIND_UNSET) {
    return answer(context, unsetEnvironmentVariable(config, {
      commandId: envelope.commandId, environment, name,
    }));
  }
  const value = readString(envelope.payload, "value");
  if (value === null) refuse(environmentRefusal("ENV_VALUE_TOO_LARGE"));
  return answer(context, setEnvironmentVariable(config, {
    commandId: envelope.commandId, environment, name, value,
  }));
}
