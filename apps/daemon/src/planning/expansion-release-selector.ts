/**
 * THE SERVER'S OWN ANSWER to "which released Foundation attempt is this expansion parent's"
 * (task-671cdd10), and the only production path that may hand task-e62e3828's release reader
 * an `attemptRef`.
 *
 * NO CALLER MAY NAME THE ATTEMPT. The query carries four subjects — goal, parent node,
 * parent run, project — and the attempt is DISCOVERED from the durable prelaunch context
 * manifest the server sealed before that attempt launched. An `attemptRef`, a release or a
 * decision trace in the query is refused outright rather than ignored.
 *
 * NOTHING IS RE-DERIVED HERE. Goal, PlanningRun, active graph and node membership come from
 * `readExpansionRequestAuthority`; the approved run from the GoalExecutionEnabled-backed
 * `readApprovedPlan`; the activation binding from `readFoundationActivationByAttempt`; and
 * safe-boundary, terminal-effect, resource, decision-trace, handoff and release-consistency all
 * stay inside `readCurrentExpansionRelease`, called VERBATIM. This module owns exactly one
 * judgement the others cannot make: that the candidate set has exactly one member.
 *
 * ONE HORIZON BRACKETS THE WHOLE COMPOSITION — component-level currentness proves each reader
 * saw a fixed world, not that they all saw the SAME one — and it writes nothing at all: no
 * hold, no PlanningRun, no transaction, no row of any kind.
 */

import type { SqliteEventStore } from "@moe/store";

import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { readCurrentExpansionRelease } from "../work/expansion-release-authority.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import type { ActiveGraphAccepted } from "./active-graph-projection.js";
import {
  admitExpansionReleaseSelectorQuery, carryExpansionReleaseRefusal, deepFreezeSelection,
  refuseExpansionReleaseSelection,
} from "./expansion-release-selector-contracts.js";
import type {
  ExpansionReleaseSelectorOutcome, ExpansionReleaseSelectorQuery,
  ExpansionReleaseSelectorRefused,
} from "./expansion-release-selector-contracts.js";
import { scanExpansionReleaseCandidates } from "./expansion-release-selector-scan.js";
import { readApprovedPlan } from "./planning-authority-reader.js";
import type { ApprovedPlanRead } from "./planning-authority-reader.js";
import { readExpansionRequestAuthority } from "./expansion-request-current-authority.js";
import type { ExpansionRequestAuthority } from "./expansion-request-current-authority.js";
import type {
  ExpansionReleaseAuthorityAnswer, ExpansionReleaseAuthorityReader,
} from "./expansion-request-service.js";

/** `ok === false`, never `"ok" in value`: the ACCEPTED graph and plan both carry `ok: true`,
 *  so a presence test answers "refused" for every success and hands the caller an upstream
 *  projection wearing this module's success shape. */
const isRefused = (
  value: { readonly ok: boolean },
): value is ExpansionReleaseSelectorRefused => !value.ok;

/** The store's own health, before anything reads a row. A store answering for another
 *  project would let this project's query be satisfied by a foreign world. */
function projectHealthy(
  store: SqliteEventStore, projectId: string,
): ExpansionReleaseSelectorRefused | null {
  try {
    if (store.getHealth().projectId !== projectId) {
      return refuseExpansionReleaseSelection(
        "EXPANSION_RELEASE_SELECTOR_STORE_PROJECT_MISMATCH");
    }
  } catch {
    return refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_STORE_UNAVAILABLE");
  }
  return null;
}

/**
 * This module's OWN read of the active graph, deliberately separate from the one
 * `readExpansionRequestAuthority` performs internally. TWO READS ARE THE POINT: the authority
 * leg establishes that the parent belongs to a current graph, this one that the SAME graph is
 * still current when the approved plan's binding is judged against it. A graph that moved
 * between them is a BINDING fault, not an authority fault, and must not be reported as "the
 * parent is unavailable".
 */
function currentGraph(
  store: SqliteEventStore, authority: ExpansionRequestAuthority,
): ActiveGraphAccepted | ExpansionReleaseSelectorRefused {
  const graph = readCurrentActiveGraph(store, authority.projectId);
  if (!graph.ok) {
    return carryExpansionReleaseRefusal(
      "EXPANSION_RELEASE_SELECTOR_GRAPH_BINDING_MISMATCH",
      { code: graph.code, layer: graph.sourceLayer ?? graph.layer });
  }
  const agrees = graph.revisionId === authority.parentRevisionRef
    && graph.graphContentHash === authority.graphContentHash
    && graph.graphEpoch === authority.graphEpoch
    && graph.provenance.goalRef === authority.goalRef;
  return agrees
    ? graph
    : refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_GRAPH_BINDING_MISMATCH");
}

/** The approved plan, required to name THIS run and THIS graph. `runId` is the join the whole
 *  selector rests on: a plan for another run would authorise an attempt this parent never made. */
function approvedPlan(
  store: SqliteEventStore, query: ExpansionReleaseSelectorQuery, graph: ActiveGraphAccepted,
): ApprovedPlanRead | ExpansionReleaseSelectorRefused {
  const plan = readApprovedPlan(store, query.projectId, query.goalRef);
  if (!plan.ok) {
    return carryExpansionReleaseRefusal(
      "EXPANSION_RELEASE_SELECTOR_APPROVED_RUN_UNAVAILABLE", plan);
  }
  if (plan.runId !== query.parentRunRef) {
    return refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_PARENT_RUN_MISMATCH");
  }
  // ONLY the revision ref. `plan.planHash` and `graph.planHash` are two independent facts —
  // the sealed plan's hash and the graph revision's — and requiring them equal would refuse
  // every real world rather than catching a splice.
  if (plan.graphRevisionRef !== graph.revisionId) {
    return refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_GRAPH_BINDING_MISMATCH");
  }
  return plan;
}

/** The activation the located attempt claims, required to be this project's and this
 *  session's. The locator proved the manifest says so; only the activation ledger can
 *  prove the durable binding agrees. */
function boundActivation(
  store: SqliteEventStore, projectId: string,
  candidate: { readonly attemptRef: string; readonly sessionId: string },
): ExpansionReleaseSelectorRefused | null {
  const activation = readFoundationActivationByAttempt(store, projectId, candidate.attemptRef);
  if (activation.status !== "BOUND") {
    return carryExpansionReleaseRefusal(
      "EXPANSION_RELEASE_SELECTOR_ACTIVATION_UNAVAILABLE", activation);
  }
  if (activation.attemptId !== candidate.attemptRef || activation.projectId !== projectId
    || activation.ownerSessionRef !== candidate.sessionId) {
    return refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_ACTIVATION_MISMATCH");
  }
  return null;
}

/**
 * The one released attempt behind `query`, or the refusal that grants nothing. `store` is the
 * only seam: no argument names an attempt, a release, a trace or a horizon, because each would
 * be asserted by the caller rather than proven here.
 */
export function readExpansionReleaseSelection(
  store: SqliteEventStore, query: unknown,
): ExpansionReleaseSelectorOutcome {
  // WRAPPED because it INSPECTS an `unknown`: `Array.isArray`, `Reflect.ownKeys` and
  // `getOwnPropertyDescriptor` all THROW on a revoked or trapping proxy. Escaping as an
  // exception grants no authority but names no reason code, and rail 4 requires the reason.
  let admitted: ExpansionReleaseSelectorQuery | null;
  try { admitted = admitExpansionReleaseSelectorQuery(query); } catch { admitted = null; }
  if (admitted === null) {
    return refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_REQUEST_INVALID");
  }
  const unhealthy = projectHealthy(store, admitted.projectId);
  if (unhealthy !== null) return unhealthy;
  let horizon: bigint;
  try { horizon = store.readEventHorizon(); } catch {
    return refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_STORE_UNAVAILABLE");
  }
  if (typeof horizon !== "bigint" || horizon < 0n) {
    return refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_LOCATOR_SCAN_INCOMPLETE");
  }
  const parent = readExpansionRequestAuthority({
    ledger: readDurableLedger(store, admitted.projectId),
    payload: {
      goalRef: admitted.goalRef, parentNodeRef: admitted.parentNodeRef,
      parentRunRef: admitted.parentRunRef,
    },
    projectId: admitted.projectId, store,
  });
  if (!parent.ok) {
    return carryExpansionReleaseRefusal(
      "EXPANSION_RELEASE_SELECTOR_PARENT_AUTHORITY_UNAVAILABLE",
      { code: parent.code, layer: parent.sourceLayer ?? parent.layer });
  }
  const graph = currentGraph(store, parent.authority);
  if (isRefused(graph)) return graph;
  const plan = approvedPlan(store, admitted, graph);
  if (isRefused(plan)) return plan;
  return selectRelease(store, admitted, {
    expectation: {
      approvedPlanHash: plan.planHash,
      goalRef: admitted.goalRef, graphContentHash: graph.graphContentHash,
      graphEpoch: graph.graphEpoch, graphRevisionRef: graph.revisionId,
      parentNodeRef: admitted.parentNodeRef, parentRunRef: admitted.parentRunRef,
      planHash: graph.planHash, projectId: admitted.projectId,
    },
    horizon,
  });
}

/** The candidate half, split out to keep the entry under the function-size rail. */
function selectRelease(
  store: SqliteEventStore, query: ExpansionReleaseSelectorQuery,
  bounds: {
    readonly expectation: Parameters<typeof scanExpansionReleaseCandidates>[1];
    readonly horizon: bigint;
  },
): ExpansionReleaseSelectorOutcome {
  const scan = scanExpansionReleaseCandidates(store, bounds.expectation, bounds.horizon);
  if (!scan.ok) return scan;
  const [candidate] = scan.candidates;
  if (candidate === undefined) {
    return refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_ATTEMPT_ABSENT");
  }
  // A SECOND MATCH IS NOT A TIE TO BREAK. Two sealed launches under one parent are two
  // retries, and no ordering rule can say which release the parent's hold is about.
  if (scan.candidates.length > 1) {
    return refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_ATTEMPT_AMBIGUOUS");
  }
  const mismatched = boundActivation(store, query.projectId, candidate);
  if (mismatched !== null) return mismatched;
  const release = readCurrentExpansionRelease(store, {
    attemptRef: candidate.attemptRef, projectId: query.projectId,
  });
  if (release.status !== "BOUND") {
    return carryExpansionReleaseRefusal(
      "EXPANSION_RELEASE_SELECTOR_RELEASE_UNAVAILABLE", release);
  }
  // THE LAST READ BEFORE THE ANSWER. A composition assembled across a ledger that moved
  // under it vouches for a world that no longer stands.
  let settled: bigint;
  try { settled = store.readEventHorizon(); } catch {
    return refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_STORE_UNAVAILABLE");
  }
  if (settled !== bounds.horizon) {
    return refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_CURRENTNESS_MOVED");
  }
  return deepFreezeSelection({
    attemptRef: candidate.attemptRef, ok: true as const,
    release: release.release, workerHandoff: release.workerHandoff,
  });
}

/**
 * The store-bound port the expansion-request service already expects. It exists so the
 * consumer binds ONE store once and can never reach a seam that takes an `attemptRef`.
 */
export function createExpansionReleaseAuthorityReader(
  store: SqliteEventStore,
): ExpansionReleaseAuthorityReader {
  return (request): ExpansionReleaseAuthorityAnswer => {
    const selected = readExpansionReleaseSelection(store, {
      goalRef: request.goalRef, parentNodeRef: request.parentNodeRef,
      parentRunRef: request.parentRunRef, projectId: request.projectId,
    });
    return selected.ok
      ? { ok: true as const, release: selected.release, workerHandoff: selected.workerHandoff }
      : { code: selected.code, layer: selected.layer, ok: false as const };
  };
}
