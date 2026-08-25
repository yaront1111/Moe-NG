/**
 * The daemon's OWN answer to "what is currently true about this goal, its active graph, and the
 * named parent" — the facts an expansion hold is opened against.
 *
 * EVERY MEMBER IS READ, NONE IS DEFAULTED. The caller names a goal, a parent node and a parent
 * run as SUBJECTS; this module resolves the goal's durable `version`, `generation` and
 * `graphEpoch`, the project's one active graph revision, and the parent's membership in it. A
 * missing fact is a refusal, never a zero: `generation ?? 1` would silently open a hold against
 * a generation the goal never reached, and the hold reducer would accept it because the number
 * is well formed.
 *
 * WHY THE GOAL'S EPOCH IS COMPARED TO THE GRAPH'S. `GoalState.graphEpoch` and the active
 * revision's `graphEpoch` are two independently durable facts. Agreeing they are the same epoch
 * is what makes "the current world" a single world; taking either one alone would let a hold be
 * opened across an epoch boundary that had already moved.
 *
 * WHAT IT DELIBERATELY DOES NOT GATE. The parent PLANNING RUN's lifecycle. The run that produced
 * the active graph is normally ACTIVATED — a terminal member of the planning-run roster — so
 * refusing terminal parents would refuse every real expansion. Ownership is what matters and is
 * checked: the run must exist, be the named one, and belong to this goal.
 *
 * It reads durable state only. It opens no hold, mints no binding, and reaches no release
 * authority: safe release is task-e62e3828df234c66969a99b8223487f4's reader, composed by
 * `expansion-request-service.ts`, and is deliberately absent from this module.
 */

import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { planningStateFromDurableRecord } from "./approval-gate.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { stateOf } from "../bootstrap/bootstrap-ledger.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import { expansionRequestRefusal } from "./expansion-request-contracts.js";
import type {
  ExpansionRequestPayload,
  ExpansionRequestRefusal,
} from "./expansion-request-contracts.js";

/** The one goal lifecycle that can carry an active graph an expansion may be requested against. */
const EXECUTING_GOAL_LIFECYCLE = "EXECUTION_ENABLED";
const GOAL_LIFECYCLES: readonly string[] = [
  "DRAFT", "EXECUTION_ENABLED", "CLOSING", "COMPLETED", "CANCELLED",
];
const PLANNING_RUN_LIFECYCLES: readonly string[] = [
  "DRAFT", "READY", "PLANNING", "SUBMISSION_DRAINING", "PLAN_REVIEW", "APPROVED",
  "ACTIVATED", "REJECTED", "CANCELLED",
];

/** Facts derived ONLY from durable bytes plus the authenticated project. */
export interface ExpansionRequestAuthority {
  readonly generation: number;
  readonly goalRef: string;
  readonly goalVersion: number;
  readonly graphContentHash: string;
  readonly graphEpoch: number;
  readonly parentNodeRef: string;
  readonly parentRevisionRef: string;
  readonly parentRunRef: string;
  readonly projectId: string;
  readonly snapshotIdentity: string;
}

export type ExpansionRequestAuthorityResult =
  | { readonly authority: ExpansionRequestAuthority; readonly ok: true }
  | ExpansionRequestRefusal;

export interface ExpansionRequestAuthorityInput {
  readonly ledger: DurableLedger;
  readonly payload: ExpansionRequestPayload;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

function objectOf(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  return value !== undefined && value !== null && typeof value === "object"
    && !Array.isArray(value) ? value as Readonly<Record<string, JsonValue>> : null;
}

function uintOf(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

interface DurableGoal {
  readonly generation: number;
  readonly goalId: string;
  readonly graphEpoch: number;
  readonly lifecycle: string;
  readonly projectId: string;
  readonly version: number;
}

function goalOf(record: JsonValue | undefined): DurableGoal | null {
  const item = objectOf(record);
  if (item === null) return null;
  const generation = uintOf(item["generation"]);
  const graphEpoch = uintOf(item["graphEpoch"]);
  const version = uintOf(item["version"]);
  const goalId = item["goalId"];
  const projectId = item["projectId"];
  const lifecycle = item["lifecycle"];
  if (generation === null || generation < 1 || graphEpoch === null || version === null) return null;
  if (typeof goalId !== "string" || typeof projectId !== "string") return null;
  if (typeof lifecycle !== "string" || !GOAL_LIFECYCLES.includes(lifecycle)) return null;
  return { generation, goalId, graphEpoch, lifecycle, projectId, version };
}

interface DurableParentRun {
  readonly goalRef: string;
  readonly runId: string;
}

function parentRunOf(record: JsonValue | undefined): DurableParentRun | null {
  const item = objectOf(planningStateFromDurableRecord(record));
  if (item === null) return null;
  const goalRef = item["goalRef"];
  const runId = item["runId"];
  const lifecycle = item["lifecycle"];
  if (typeof goalRef !== "string" || typeof runId !== "string") return null;
  if (typeof lifecycle !== "string" || !PLANNING_RUN_LIFECYCLES.includes(lifecycle)) return null;
  return { goalRef, runId };
}

/** The goal leg: presence, shape, project ownership, identity and executing lifecycle. */
function readGoal(
  input: ExpansionRequestAuthorityInput,
): DurableGoal | ExpansionRequestRefusal {
  const record = stateOf(input.ledger, input.payload.goalRef);
  if (record === undefined) return expansionRequestRefusal("EXPANSION_REQUEST_GOAL_ABSENT");
  const goal = goalOf(record);
  if (goal === null) return expansionRequestRefusal("EXPANSION_REQUEST_GOAL_MALFORMED");
  if (goal.projectId !== input.projectId || goal.goalId !== input.payload.goalRef) {
    return expansionRequestRefusal("EXPANSION_REQUEST_GOAL_FOREIGN");
  }
  if (goal.lifecycle !== EXECUTING_GOAL_LIFECYCLE) {
    return expansionRequestRefusal(
      goal.lifecycle === "DRAFT"
        ? "EXPANSION_REQUEST_GOAL_NOT_EXECUTING" : "EXPANSION_REQUEST_GOAL_TERMINAL",
    );
  }
  return goal;
}

/** The parent-run leg: presence, shape and ownership by the SAME goal, never by the caller. */
function readParentRun(
  input: ExpansionRequestAuthorityInput,
): DurableParentRun | ExpansionRequestRefusal {
  const record = stateOf(input.ledger, input.payload.parentRunRef);
  if (record === undefined) return expansionRequestRefusal("EXPANSION_REQUEST_PARENT_RUN_ABSENT");
  const run = parentRunOf(record);
  if (run === null) return expansionRequestRefusal("EXPANSION_REQUEST_PARENT_RUN_MALFORMED");
  if (run.runId !== input.payload.parentRunRef || run.goalRef !== input.payload.goalRef) {
    return expansionRequestRefusal("EXPANSION_REQUEST_PARENT_RUN_FOREIGN");
  }
  return run;
}

function isRefusal(value: unknown): value is ExpansionRequestRefusal {
  return typeof value === "object" && value !== null && "ok" in value
    && (value as { readonly ok: unknown }).ok === false;
}

/**
 * Resolves the ONE current authority an expansion hold may be opened against, or the exact
 * reason there is none. Deeply frozen and detached: no member is a live reference into the
 * ledger, the store, or the caller's payload.
 */
export function readExpansionRequestAuthority(
  input: ExpansionRequestAuthorityInput,
): ExpansionRequestAuthorityResult {
  const goal = readGoal(input);
  if (isRefusal(goal)) return goal;
  const run = readParentRun(input);
  if (isRefusal(run)) return run;

  const graph = readCurrentActiveGraph(input.store, input.projectId);
  if (!graph.ok) {
    return expansionRequestRefusal(
      "EXPANSION_REQUEST_GRAPH_UNAVAILABLE", graph.code, graph.sourceLayer ?? graph.layer,
    );
  }
  if (graph.provenance.goalRef !== input.payload.goalRef) {
    return expansionRequestRefusal("EXPANSION_REQUEST_GRAPH_GOAL_MISMATCH");
  }
  if (graph.graphEpoch !== goal.graphEpoch) {
    return expansionRequestRefusal("EXPANSION_REQUEST_GRAPH_EPOCH_MISMATCH");
  }
  if (!graph.snapshot.nodes.some((node) => node.nodeKey === input.payload.parentNodeRef)) {
    return expansionRequestRefusal("EXPANSION_REQUEST_PARENT_NODE_ABSENT");
  }
  return Object.freeze({
    authority: Object.freeze({
      generation: goal.generation,
      goalRef: goal.goalId,
      goalVersion: goal.version,
      graphContentHash: graph.graphContentHash,
      graphEpoch: graph.graphEpoch,
      parentNodeRef: input.payload.parentNodeRef,
      parentRevisionRef: graph.revisionId,
      parentRunRef: run.runId,
      projectId: goal.projectId,
      snapshotIdentity: graph.snapshotIdentity,
    }),
    ok: true as const,
  });
}
