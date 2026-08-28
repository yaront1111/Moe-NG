/**
 * The immutable vocabulary of ONE replacement graph supersession (task-9e52f850).
 *
 * WHY THE REQUEST IS SO SMALL, AND WHY IT IS AN EXACT KEY SET. A supersession is a statement about
 * facts the SERVER already holds durably: which graph is active, which preparation generation is
 * current, what the successor's sealed bytes are. The request may therefore IDENTIFY targets and
 * FENCE versions and do nothing else. `GRAPH_SUPERSEDE_REQUEST_KEYS` is exact, so a caller who
 * adds `graphEpoch`, `lifecycle`, `funding`, `dispositions`, `carryAuthority`, `activation`,
 * `planningDisposition` or `graphContentBytes` is refused AT THE DOOR rather than having the field
 * quietly ignored — "ignored" and "adopted" are one edit apart, and the second is a caller writing
 * its own authority. `GRAPH_SUPERSEDE_FORBIDDEN_KEYS` names those eight categories so the matrix
 * that sweeps them has a pinned denominator instead of an inline literal.
 *
 * `successorGraphContentHash` IS A LOOKUP KEY, NOT CONTENT. It can only ever name bytes already
 * durably sealed in the content-addressed body store; naming bytes that are not there is a
 * refusal, and no request can carry bytes at all.
 *
 * FOUR AUTHORITIES CAN REFUSE and every refusal says which one did, because an operator repairs a
 * kernel rejection, a goal-lifecycle rejection, a store fence and a daemon precondition in four
 * different places. This module's OWN codes travel under `GRAPH_SUPERSEDE`; a lower reader's code
 * and layer ride out under `sourceCode`/`sourceLayer` rather than being restamped as ours.
 */
import type { RuntimeError } from "@moe/contracts";

/**
 * MODULE-PRIVATE on purpose; only the TYPE is exported. A column-zero `export const *_LAYER`
 * enrols the constant in `tests/security/boundary-roster.security.ts` and owes it a hostile trio,
 * which a pure vocabulary earns no more than the preparation family's layer did.
 */
const LAYER = "GRAPH_SUPERSEDE" as const;
export type GraphSupersedeLayer = typeof LAYER;

export const GRAPH_SUPERSEDE_CODES = Object.freeze([
  "GRAPH_SUPERSEDE_REQUEST_INVALID", "GRAPH_SUPERSEDE_TARGET_FOREIGN",
  "GRAPH_SUPERSEDE_CURRENT_GRAPH_UNAVAILABLE", "GRAPH_SUPERSEDE_PREDECESSOR_MISMATCH",
  "GRAPH_SUPERSEDE_SUCCESSOR_INVALID", "GRAPH_SUPERSEDE_SUCCESSOR_ALREADY_RECORDED",
  "GRAPH_SUPERSEDE_SUCCESSOR_CONTENT_UNSEALED", "GRAPH_SUPERSEDE_PREPARATION_UNVERIFIABLE",
  "GRAPH_SUPERSEDE_PREPARATION_ABSENT", "GRAPH_SUPERSEDE_PREPARATION_STALE",
  "GRAPH_SUPERSEDE_PREPARATION_DRIFT",
  "GRAPH_SUPERSEDE_FUNDING_UNAVAILABLE", "GRAPH_SUPERSEDE_GOAL_UNREADABLE",
  "GRAPH_SUPERSEDE_BYTES_CONFLICT", "GRAPH_SUPERSEDE_CONCURRENT_ACTIVATION",
  // RESERVED AND PINNED; emitted once task-08efb6f0 makes COMPLETE disposition coverage reachable.
  // Wiring it against today's derivation would refuse EVERY supersession: `lineageFactsFor`
  // hardcodes ADD, so the scheduler set can never answer COMPLETE (see the row's step-1 comment).
  "GRAPH_SUPERSEDE_DISPOSITION_INCOMPLETE",
  "GRAPH_SUPERSEDE_PREPARATION_EXPIRED",
  "GRAPH_SUPERSEDE_APPROVAL_REVISION_MISMATCH",
  "GRAPH_SUPERSEDE_APPROVAL_SCOPE_MISMATCH",
  "GRAPH_SUPERSEDE_APPROVAL_BUDGET_MISMATCH",
  "GRAPH_SUPERSEDE_APPROVAL_CRITERIA_MISMATCH",
  "GRAPH_SUPERSEDE_APPROVAL_QUALITY_MISMATCH",
  "GRAPH_SUPERSEDE_APPROVAL_POLICY_MISMATCH",
  "GRAPH_SUPERSEDE_APPROVAL_POLICY_DECISION_MISMATCH",
  "GRAPH_SUPERSEDE_APPROVED_CRITERIA_UNREADABLE",
] as const);
export type GraphSupersedeCode = (typeof GRAPH_SUPERSEDE_CODES)[number];

/** Which authority answered. A delegated refusal still names the aggregate that spoke. */
export const GRAPH_SUPERSEDE_AUTHORITIES = Object.freeze([
  "GRAPH_SUPERSEDE_SERVICE", "GRAPH_REVISION", "GOAL", "DURABLE_STORE",
] as const);
export type GraphSupersedeAuthority = (typeof GRAPH_SUPERSEDE_AUTHORITIES)[number];

export const GRAPH_SUPERSEDE_REQUEST_KEYS = Object.freeze([
  "commandId", "correlationId", "decidedAt", "expectedPredecessorRevisionRef",
  "expectedPreparationVersion", "generation", "goalRef", "principalId", "projectId",
  "successorGraphContentHash", "successorRevisionRef",
] as const);

/**
 * DoD 1's eight categories, named once. Each is a fact the SERVER owns; a request stating one is
 * refused structurally by the exact key set above rather than defended against downstream.
 */
export const GRAPH_SUPERSEDE_FORBIDDEN_KEYS = Object.freeze([
  "activation", "carryAuthority", "dispositions", "funding", "graphContentBytes",
  "graphEpoch", "lifecycle", "planningDisposition",
] as const);

/**
 * The kernel needs a NON-EMPTY supported set, and it is consulted by exactly one code path:
 * `evaluateCarryForward`, which runs only for a `CARRY` disposition. This module never emits
 * CARRY — no durable safe-carry evidence reader exists in this tree, so an unchanged node is
 * REQUALIFY, which grants no carry-forward authority. The set is therefore a SERVER DECLARATION
 * that confers nothing, and it is a constant here precisely so no request can state it.
 */
export const GRAPH_SUPERSEDE_CANONICALIZER_VERSIONS = Object.freeze(["moe-canonical/1"] as const);

export interface GraphSupersedeRequest {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedPredecessorRevisionRef: string;
  readonly expectedPreparationVersion: number;
  readonly generation: number;
  readonly goalRef: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly successorGraphContentHash: string;
  readonly successorRevisionRef: string;
}

export interface GraphSupersedeRefusal {
  /** This module's own code, or — when a named aggregate refused — that aggregate's own. */
  readonly code: string;
  /** The core's `RuntimeError` when a REDUCER refused; `null` when the daemon or store did. */
  readonly error: RuntimeError | null;
  readonly layer: string;
  readonly ok: false;
  readonly refusedBy: GraphSupersedeAuthority;
  /** The underlying reader's code/layer when this vocabulary is wrapping one. */
  readonly sourceCode: string | null;
  readonly sourceLayer: string | null;
}

export interface UpstreamFace { readonly code: string; readonly layer: string }

export function refuseSupersede(
  code: GraphSupersedeCode,
  source: UpstreamFace | null = null,
  refusedBy: GraphSupersedeAuthority = "GRAPH_SUPERSEDE_SERVICE",
): GraphSupersedeRefusal {
  return Object.freeze({
    code, error: null, layer: LAYER, ok: false as const, refusedBy,
    sourceCode: source === null ? null : source.code,
    sourceLayer: source === null ? null : source.layer,
  });
}

/** A core rejection, forwarded under the aggregate that produced it rather than restamped. */
export function refuseFromAggregate(
  error: RuntimeError, layer: string, refusedBy: Exclude<GraphSupersedeAuthority, "DURABLE_STORE">,
): GraphSupersedeRefusal {
  return Object.freeze({
    code: error.code, error, layer, ok: false as const, refusedBy,
    sourceCode: null, sourceLayer: null,
  });
}

function exactRecord(
  value: unknown, keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const present = Object.keys(record);
  if (present.length !== keys.length || keys.some((key) => !present.includes(key))) return null;
  return record;
}

const HEX_64 = /^[0-9a-f]{64}$/u;

function isRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export type SupersedeRequestResult =
  | GraphSupersedeRefusal
  | { readonly ok: true; readonly request: GraphSupersedeRequest };

/**
 * Decode, or refuse. Every string member is a ref, the two fences are safe integers with their own
 * floors, and the successor content hash must be 64-hex before it is ever used as a lookup key.
 */
export function decodeSupersedeRequest(value: unknown): SupersedeRequestResult {
  const record = exactRecord(value, GRAPH_SUPERSEDE_REQUEST_KEYS);
  if (record === null) return refuseSupersede("GRAPH_SUPERSEDE_REQUEST_INVALID");
  const refs = GRAPH_SUPERSEDE_REQUEST_KEYS
    .filter((key) => key !== "expectedPreparationVersion" && key !== "generation");
  const version = record["expectedPreparationVersion"];
  const generation = record["generation"];
  // `decidedAt` MUST be a readable instant, not merely a non-empty string (task-7eddd612). The
  // preparation window compares `Date.parse(decidedAt)` against the generation's deadline, and
  // `NaN > deadline` is FALSE — so an unparseable stamp would sail past a closed window instead of
  // being caught by it. The decoder refuses it here, before any current fact is read.
  if (refs.some((key) => !isRef(record[key]))
    || Number.isNaN(Date.parse(record["decidedAt"] as string))
    || !HEX_64.test(record["successorGraphContentHash"] as string)
    || !Number.isSafeInteger(generation) || (generation as number) <= 0
    || !Number.isSafeInteger(version) || (version as number) < 0) {
    return refuseSupersede("GRAPH_SUPERSEDE_REQUEST_INVALID");
  }
  return Object.freeze({
    ok: true as const,
    request: Object.freeze({ ...record }) as unknown as GraphSupersedeRequest,
  });
}
