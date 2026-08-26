import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import type { BootstrapRequest } from "./bootstrap/bootstrap-contracts.js";
import { BOOTSTRAP_SCHEMA_VERSION } from "./bootstrap/bootstrap-contracts.js";
import type { DurableLedger, HandlerContext } from "./bootstrap/bootstrap-ledger.js";
import type { GraphMutationCommandKind } from "./daemon-command-vocabulary.js";

/**
 * The transport-side contract of the five graph MUTATION kinds (task-931f99e8).
 *
 * ONE JOB: turn an AUTHENTICATED envelope plus a caller's INTENT payload into the exact request
 * its durable planning service decodes. Nothing here reduces, folds, projects, reserves or
 * activates; every judgement belongs to the service `daemon-command-graph-edges.js` hands the
 * assembled request to, and that service's code and layer travel out unrestamped.
 *
 * WHY THE ASSEMBLY EXISTS AT ALL. Each service decodes an EXACT request that carries
 * `commandId`, `correlationId`, `decidedAt`, `principalId` and `projectId` beside the caller's
 * intent. Those five are SERVER facts. They are absent from the registry's payload allow-list, so
 * a caller naming one is refused STRUCTURALLY at PAYLOAD_SHAPE, one layer above any handler --
 * and they are re-attached here from the envelope and the authenticated principal. That is the
 * whole of "an ingress authenticates bytes, it does not create authority" on this edge.
 */

/**
 * The graph services build their requests as `BootstrapRequest` records because that is the shape
 * `HandlerContext` carries, but the five kinds are deliberately NOT `BootstrapCommandKind`s --
 * `runBootstrapCommand`'s handler table never answers one, and `decodeBootstrapRequestBytes`
 * refuses one. Only `kind` disagrees with the interface, so the graph request is that interface
 * with its kind widened, and the single widening lives here rather than at five call sites.
 */
export type GraphCommandRequest = Omit<BootstrapRequest, "kind"> & {
  readonly kind: GraphMutationCommandKind;
};

/** The schema version stamped into every assembled graph request. */
export const GRAPH_COMMAND_SCHEMA_VERSION = BOOTSTRAP_SCHEMA_VERSION;

/**
 * The five members every graph service request carries that NO caller may present. Kept as its
 * own roster so the payload allow-lists in `daemon-command-vocabulary.js` can be proved -- member
 * by member -- to be the exact complement of each service's own request key roster.
 */
export const GRAPH_SERVER_OWNED_REQUEST_KEYS = Object.freeze([
  "commandId", "correlationId", "decidedAt", "principalId", "projectId",
] as const);

/**
 * The ONE widening, in one place. `HandlerContext.request` is a `BootstrapRequest` whose `kind`
 * is a `BootstrapCommandKind`, and the five graph kinds are deliberately outside that union — so
 * every field but `kind` already matches and only the kind needs to travel. Doing it here rather
 * than at five call sites means a reader finds exactly one place where a graph kind enters a
 * bootstrap-shaped record, and nothing downstream re-validates a kind against
 * `BOOTSTRAP_COMMAND_KINDS`: `decodeBootstrapRequestBytes` is the only surface that does, and no
 * graph edge calls it.
 */
export function graphHandlerContext(
  store: SqliteEventStore, ledger: DurableLedger, request: GraphCommandRequest,
): HandlerContext {
  return { ledger, request: request as unknown as BootstrapRequest, store };
}

export interface GraphEnvelope {
  readonly commandId: string;
  readonly correlationId: string;
  readonly expectedVersion: number;
  readonly payload: JsonObject;
}

export interface GraphRequestFacts {
  readonly envelope: GraphEnvelope;
  readonly kind: GraphMutationCommandKind;
  /** The AUTHENTICATED principal. Never a payload field. */
  readonly principalId: string;
  readonly projectId: string;
}

/**
 * The decision time, made REPLAY-STABLE.
 *
 * `replayOf` hashes `{kind, payload}` and the graph services' payloads CONTAIN `decidedAt`, so a
 * fresh clock read on a resubmit would change the request bytes and answer an honest replay with
 * `BOOTSTRAP_COMMAND_BYTES_CONFLICT` -- a refusal for a command that succeeded. The decision
 * already committed under this identity therefore supplies its own `decidedAt`, and only a
 * genuinely new command reads the clock. Same bytes in, same bytes hashed, original result out.
 */
export function replayStableDecidedAt(
  store: SqliteEventStore, facts: GraphRequestFacts, clock: () => string,
): string {
  const existing = store.getCommandDecision({
    commandId: facts.envelope.commandId,
    principalId: facts.principalId,
    projectId: facts.projectId,
  });
  return existing === null ? clock() : existing.decidedAt;
}

/**
 * The service request: SERVER facts spread LAST and unconditionally over the caller's intent.
 *
 * `omit` drops the members a kind's service does NOT admit -- `graph.supersede` takes its
 * approval bytes at this edge and its codec compares an EXACT eleven-key request, so the two
 * approval members are removed here rather than defended against downstream. The trimmed payload
 * is a pure function of the caller's bytes, so replay stays byte-exact.
 *
 * The order is the guarantee. Even if the allow-list above were widened by mistake, a caller's
 * `projectId` or `principalId` could not survive this spread -- so the structural refusal at
 * PAYLOAD_SHAPE and this assembly fail closed in the same direction rather than depending on
 * each other.
 */
export function assembleGraphRequest(
  facts: GraphRequestFacts, decidedAt: string, omit: readonly string[] = [],
): GraphCommandRequest {
  const intent: Record<string, unknown> = { ...facts.envelope.payload };
  for (const key of omit) delete intent[key];
  return Object.freeze({
    commandId: facts.envelope.commandId,
    correlationId: facts.envelope.correlationId,
    decidedAt,
    expectedVersion: facts.envelope.expectedVersion,
    kind: facts.kind,
    payload: Object.freeze({
      ...(intent as JsonObject),
      commandId: facts.envelope.commandId,
      correlationId: facts.envelope.correlationId,
      decidedAt,
      principalId: facts.principalId,
      projectId: facts.projectId,
    }),
    principalId: facts.principalId,
    projectId: facts.projectId,
    schemaVersion: GRAPH_COMMAND_SCHEMA_VERSION,
  });
}
