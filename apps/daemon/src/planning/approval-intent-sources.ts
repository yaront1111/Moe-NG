import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { payloadObject, payloadRef, readDurableLedger, stateOf }
  from "../bootstrap/bootstrap-ledger.js";
import type { ServiceRefusedBy } from "../bootstrap/bootstrap-ledger.js";
import { verifyApprovedRunBinding } from "./approval-run-binding.js";
import { planningAuthorityAggregateId } from "./planning-authority-persistence.js";

/**
 * THE DURABLE READ half of the `approval.decide_intent` seam (task-6646f888).
 *
 * Split out of `approval-intent.ts` so the two responsibilities stay apart and each source stays
 * under the line cap: this module answers "what does the store already know about this run", and
 * the seam answers "may this principal approve, and can a record be composed". Nothing here
 * decides and nothing here is copied from a request — every value is read back out of a durable
 * record written by a production writer.
 */

const BODIES_EVENT_TYPE = "PlanningAuthorityBodiesSealed";
const decoder = new TextDecoder();

/** A plain own-property read: no getter runs and a hostile prototype contributes nothing. */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable && "value" in descriptor
    ? descriptor.value
    : undefined;
}

/** Every record fact this seam CAN read out of durable state, and where each came from. */
export interface ApprovalIntentSources {
  readonly approvalRef: string;
  readonly approvedNodeScope: readonly string[];
  readonly binding: ReturnType<typeof verifyApprovedRunBinding>;
  readonly criteriaRef: string;
  readonly exactRevisionHash: string;
  readonly goalRef: string;
  readonly graphRevisionRef: string;
  readonly ok: true;
  readonly planQualityAssessmentRef: string;
  readonly runRecord: JsonValue;
}

/**
 * Carries the LAYER as well as the code, so the seam forwards both rather than re-deciding one.
 *
 * `layer` is typed as the closed `ServiceRefusedBy` roster and not as `string`: that is the
 * compile-time agreement check between whatever answered and what `refuse` will accept, so a
 * forwarded layer this daemon does not publish cannot reach an operator unnoticed.
 */
export interface ApprovalIntentRefused {
  readonly code: string;
  readonly layer: ServiceRefusedBy;
  readonly ok: false;
}

export type ApprovalIntentSourceResult = ApprovalIntentSources | ApprovalIntentRefused;

/**
 * `criteriaDigest` from its ONLY durable home. SELECTED BY TYPE, NEVER BY INDEX: the bodies and
 * envelope events land on this same aggregate and their write order is unpinned, so a take-first
 * read names whichever arrived first and would bind the envelope payload's fields while looking
 * correct. Same discipline as `approval-run-binding.ts:112-133`.
 */
function sealedCriteriaDigest(store: SqliteEventStore, runId: string): string | null {
  let events;
  try {
    events = store.readEvents(planningAuthorityAggregateId(runId));
  } catch {
    return null;
  }
  const bodies = events.find((event) => event.eventType === BODIES_EVENT_TYPE);
  if (bodies === undefined) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(bodies.payload));
  } catch {
    return null;
  }
  const digest = own(payload, "criteriaDigest");
  return typeof digest === "string" && digest.length > 0 ? digest : null;
}

const sourceRefusal = (code: string, layer: ServiceRefusedBy): ApprovalIntentRefused =>
  Object.freeze({ code, layer, ok: false as const });

/**
 * The durable facts the record is composed FROM, read out of the run's own committed records.
 *
 * NOTHING HERE IS COPIED FROM THE REQUEST. `goalRef` comes off the run so an approval cannot be
 * redirected at a goal this plan was never proposed for, and `graphRevisionRef` comes off the run
 * so the caller cannot name a revision at all — which is what makes a diverged ref unrepresentable
 * on this seam rather than merely refused.
 *
 * THE ORDER IS LOAD-BEARING, and it is `verifyApprovedRunBinding`'s own (`approval-run-binding.ts:135-142`):
 * an ABSENT run is a missing prerequisite, and a run that never reached PLAN_REVIEW is NOT
 * REVIEWABLE regardless of what its refs look like. Reading the sealed facts first would answer
 * UNSEALED for a merely-proposed run and send an operator after the wrong defect — measured, not
 * assumed: this seam did exactly that until its own suite caught it.
 */
export function readApprovalIntentSources(
  store: SqliteEventStore, projectId: string, runId: string,
): ApprovalIntentSourceResult {
  const record = stateOf(readDurableLedger(store, projectId), runId);
  if (record === undefined || record === null || typeof record !== "object"
    || Array.isArray(record)) {
    return sourceRefusal("BOOTSTRAP_PREREQUISITE_MISSING", "DAEMON_PREREQUISITE");
  }
  const state = payloadObject(record as JsonObject, "state");
  const graphRevisionRef = state === null ? null : payloadRef(state, "graphRevisionRef");
  // The ref handed in came off the RUN, so the comparison inside is the run against itself and the
  // DIVERGED code is unreachable HERE — the caller cannot name a revision at all on this seam.
  // The lifecycle and seal checks are what this call is for, and they answer in their own order.
  const bound = verifyApprovedRunBinding({
    graphRevisionRef: graphRevisionRef ?? "", run: record, runId, store,
  });
  if (!bound.ok) return sourceRefusal(bound.code, bound.layer);
  const submissionHash = payloadRef(record as JsonObject, "submissionHash");
  const goalRef = state === null ? null : payloadRef(state, "goalRef");
  const qualityHash = state === null
    ? null
    : payloadRef(payloadObject(state, "sealedHashes") ?? {}, "qualityHash");
  const criteriaRef = sealedCriteriaDigest(store, runId);
  if (submissionHash === null || goalRef === null || graphRevisionRef === null
    || qualityHash === null || criteriaRef === null) {
    return sourceRefusal("APPROVAL_AUTHORITY_UNSEALED", "APPROVAL_RUN_BINDING");
  }
  return Object.freeze({
    binding: bound,
    // SERVER-MINTED off the run identity. A caller names the run as INTENT and nothing else, so
    // it cannot present an approval ref that cites some other approval.
    approvalRef: `approval:${runId}`,
    // No per-node narrowing: an initial-graph approval approves the sealed revision, and there is
    // no durable per-node selection for it to restate.
    approvedNodeScope: Object.freeze([]),
    criteriaRef,
    exactRevisionHash: submissionHash,
    goalRef,
    graphRevisionRef,
    ok: true as const,
    planQualityAssessmentRef: qualityHash,
    runRecord: record,
  });
}
