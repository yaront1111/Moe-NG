import type { JsonObject, JsonValue } from "@moe/contracts";
import type { GraphActivationBinding } from "@moe/core";
import { encodeGraphContent } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { payloadObject, payloadRef } from "../bootstrap/bootstrap-ledger.js";
import { GRAPH_BODY_RECORD_LAYER, readGraphBody } from "./graph-body-record.js";
import type { GraphBodyRefusal } from "./graph-body-record.js";

/**
 * The five-member `GraphActivationBinding`, composed SERVER-SIDE from durable records.
 *
 * `graph-revision-contract.ts:27-33` makes the binding an exact five-member record and
 * `graph-revision-validation.ts:39-48` requires 64-hex on four of them and a goal version >= 1 on
 * the fifth, so there is no such thing as a partially composed binding: a member this module
 * cannot source is a REFUSAL, never a default and never a caller value promoted to authority.
 *
 * THE CALLER'S WITNESS IS ONLY EVER COMPARED. Each member the request states is checked against
 * the value the server derived and a disagreement refuses with a code naming THAT member, before
 * anything durable happens. Omitting a member is not a bypass and grants nothing — the durable
 * value is the server's either way — so a caller that states no expectation simply has none to
 * contradict. Per-member codes exist because an operator repairs a drifted content hash and a
 * stale goal version differently, and one merged code would send them to the wrong field.
 *
 * `graphHash` IS THE RECOMPUTED CONTENT HASH AND NOTHING ELSE (dec-64b2391c, option A). The body
 * is read back out of its durable content-addressed row and re-encoded through the codec, and the
 * digest THAT produces is what binds. The scheduler's structural `snapshotIdentity` is never
 * substituted: it answers a different question, and the equation is the single easiest way to
 * bind an activation to a hash the kernel never accepted.
 */

/**
 * Kept module-private and exported only as the closed TYPE below, exactly as the approval and
 * budget seams do: passing that type straight into `refuse` is what makes `SERVICE_REFUSED_BY`'s
 * spelled literal a COMPILE-TIME agreement rather than an asserted one.
 */
const LAYER = "GRAPH_ACTIVATION_BINDING" as const;

export type GraphActivationBindingLayer = typeof LAYER;

/**
 * Refusals this module originates. Split into "cannot source" and "caller disagrees" on purpose:
 * the first says the durable world is not ready, the second says the request is wrong about it.
 */
export const GRAPH_ACTIVATION_BINDING_CODES = Object.freeze([
  "ACTIVATION_BINDING_CONTENT_DRIFTED",
  "ACTIVATION_BINDING_CONTENT_UNAVAILABLE",
  "ACTIVATION_BINDING_GOAL_VERSION_UNKNOWN",
  "ACTIVATION_BINDING_GRAPH_HASH_MISMATCH",
  "ACTIVATION_BINDING_POLICY_HASH_MISMATCH",
  "ACTIVATION_BINDING_QUALITY_HASH_MISMATCH",
  "ACTIVATION_BINDING_RUN_UNSEALED",
] as const);

export type GraphActivationBindingCode = (typeof GRAPH_ACTIVATION_BINDING_CODES)[number];

export interface GraphActivationBindingRefusal {
  readonly code: GraphActivationBindingCode;
  readonly layer: GraphActivationBindingLayer;
  readonly ok: false;
  /** The underlying code when this module is wrapping the body record's refusal. */
  readonly sourceCode: GraphBodyRefusal["code"] | null;
  readonly sourceLayer: typeof GRAPH_BODY_RECORD_LAYER | null;
}

export interface GraphActivationBindingAccepted {
  readonly binding: GraphActivationBinding;
  readonly ok: true;
  /** Content identity facts the revision aggregate is CREATED from, sourced with the binding. */
  readonly planHash: string;
  readonly submissionRef: string;
}

export type GraphActivationBindingResult =
  | GraphActivationBindingAccepted
  | GraphActivationBindingRefusal;

export interface GraphActivationBindingInput {
  /** The server's digest over the durable budget root, already computed by the budget leg. */
  readonly budgetHash: string;
  /** The caller's activation witness. COMPARED, never bound from. */
  readonly claimed: JsonObject;
  /** The goal's durable state, as the committed ledger reader returns it. */
  readonly goal: JsonValue | undefined;
  /** The server's digest over the approval policy decision that authorised this approval. */
  readonly policyHash: string;
  readonly projectId: string;
  /** The run's durable record, as the committed ledger reader returns it. */
  readonly run: JsonValue;
  readonly store: SqliteEventStore;
}

const HEX_64 = /^[0-9a-f]{64}$/u;

function refuse(
  code: GraphActivationBindingCode,
  sourceLayer: typeof GRAPH_BODY_RECORD_LAYER | null = null,
  sourceCode: GraphBodyRefusal["code"] | null = null,
): GraphActivationBindingRefusal {
  return Object.freeze({
    code,
    layer: LAYER,
    ok: false as const,
    sourceCode,
    sourceLayer,
  });
}

interface SealedRun {
  readonly graphContentHash: string;
  readonly planHash: string;
  readonly qualityHash: string;
  readonly submissionRef: string;
}

/**
 * The run's own sealed identity. `sealedHashes` is written by the core's submission fold
 * (`planning-run-submission.ts:165`) and is the ONLY content authority a proposal has, so a run
 * missing any member of it is UNSEALED rather than partially usable.
 */
function sealedRun(run: JsonValue): SealedRun | null {
  const record = run === null || typeof run !== "object" || Array.isArray(run)
    ? null
    : (run as JsonObject);
  if (record === null) return null;
  const submissionRef = payloadRef(record, "submissionHash");
  const state = payloadObject(record, "state");
  const sealed = state === null ? null : payloadObject(state, "sealedHashes");
  if (sealed === null || submissionRef === null) return null;
  const graphContentHash = payloadRef(sealed, "graphContentHash");
  const planHash = payloadRef(sealed, "planHash");
  const qualityHash = payloadRef(sealed, "qualityHash");
  if (graphContentHash === null || planHash === null || qualityHash === null) return null;
  if (!HEX_64.test(graphContentHash) || !HEX_64.test(planHash) || !HEX_64.test(qualityHash)) {
    return null;
  }
  return Object.freeze({ graphContentHash, planHash, qualityHash, submissionRef });
}

/** The goal's own durable domain version — the `expectedGoalVersion` a binding is valid at. */
function goalFacts(goal: JsonValue | undefined): { readonly version: number } | null {
  if (goal === undefined || goal === null || typeof goal !== "object" || Array.isArray(goal)) {
    return null;
  }
  const version = (goal as JsonObject)["version"];
  if (!Number.isSafeInteger(version) || (version as number) < 1) return null;
  return Object.freeze({ version: version as number });
}

/**
 * RECOMPUTE-EQUALS-SEALED. `readGraphBody` already proves the stored bytes decode to their own
 * declared digest AND that they are filed under the hash we asked for; re-encoding the decoded
 * CONTENT closes the remaining gap by deriving the digest from the fields rather than from the
 * bytes, so a body whose canonical framing has drifted from the codec's cannot bind.
 */
function recomputedGraphHash(
  input: GraphActivationBindingInput,
  sealed: SealedRun,
): { readonly graphHash: string; readonly ok: true } | GraphActivationBindingRefusal {
  const body = readGraphBody(input.store, input.projectId, sealed.graphContentHash);
  if (!body.ok) {
    return refuse("ACTIVATION_BINDING_CONTENT_UNAVAILABLE", GRAPH_BODY_RECORD_LAYER, body.code);
  }
  const encoded = encodeGraphContent(body.content);
  if (!encoded.ok || encoded.value.graphContentHash !== sealed.graphContentHash) {
    return refuse("ACTIVATION_BINDING_CONTENT_DRIFTED");
  }
  return { graphHash: encoded.value.graphContentHash, ok: true as const };
}

/**
 * The comparison table. Every member the caller may state appears here EXACTLY once with the
 * code that names it; a member added to the binding without an entry cannot be compared, which is
 * why the table is keyed by the binding's own field names rather than written out inline.
 */
const CLAIM_CODES = Object.freeze({
  graphHash: "ACTIVATION_BINDING_GRAPH_HASH_MISMATCH",
  policyHash: "ACTIVATION_BINDING_POLICY_HASH_MISMATCH",
  qualityHash: "ACTIVATION_BINDING_QUALITY_HASH_MISMATCH",
} as const satisfies Readonly<Partial<Record<
  keyof GraphActivationBinding, GraphActivationBindingCode
>>>);

/**
 * TWO MEMBERS ARE ABSENT FROM THE TABLE ON PURPOSE, each because another authority already owns
 * its comparison and a second one here would be unfalsifiable. `budgetHash` is compared by the
 * budget seam under BOOTSTRAP_BUDGET_HASH_MISMATCH. `expectedGoalVersion` IS the goal command's
 * `expectedVersion`, so `reduceGoal` answers a wrong one with EXPECTED_VERSION_CONFLICT before
 * this module is reached at all — measured, not assumed: the arm that tried to assert a binding
 * code for it received the core's. Both delegations are pinned by their own test arms.
 */
export const GRAPH_ACTIVATION_CLAIM_KEYS = Object.freeze(
  Object.keys(CLAIM_CODES).sort() as readonly (keyof typeof CLAIM_CODES)[],
);

function claimRefusal(
  claimed: JsonObject,
  binding: GraphActivationBinding,
): GraphActivationBindingRefusal | null {
  for (const key of GRAPH_ACTIVATION_CLAIM_KEYS) {
    const stated = claimed[key];
    if (stated !== undefined && stated !== binding[key]) return refuse(CLAIM_CODES[key]);
  }
  return null;
}

/**
 * Compose the binding, or say which fact was missing or contradicted. Never appends; every path
 * is a read, so a refusal here leaves nothing durable behind.
 */
export function composeGraphActivationBinding(
  input: GraphActivationBindingInput,
): GraphActivationBindingResult {
  const sealed = sealedRun(input.run);
  if (sealed === null) return refuse("ACTIVATION_BINDING_RUN_UNSEALED");
  // NO "goal already active" GUARD HERE, deliberately. `reduceGoal` refuses
  // `goal.activate_initial_graph` on an already-enabled goal with its own ILLEGAL_TRANSITION and
  // runs first, so a guard restating it would be unfalsifiable: deleting it would leave every
  // suite green. The reachable goal fault is a version this module cannot read at all.
  const goal = goalFacts(input.goal);
  if (goal === null) return refuse("ACTIVATION_BINDING_GOAL_VERSION_UNKNOWN");
  const recomputed = recomputedGraphHash(input, sealed);
  if (!recomputed.ok) return recomputed;
  const binding: GraphActivationBinding = Object.freeze({
    budgetHash: input.budgetHash,
    expectedGoalVersion: goal.version,
    graphHash: recomputed.graphHash,
    policyHash: input.policyHash,
    qualityHash: sealed.qualityHash,
  });
  const contradicted = claimRefusal(input.claimed, binding);
  if (contradicted !== null) return contradicted;
  return Object.freeze({
    binding,
    ok: true as const,
    planHash: sealed.planHash,
    submissionRef: sealed.submissionRef,
  });
}
