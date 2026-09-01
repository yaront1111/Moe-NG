import type { ExpectedVersionDecisionLeg } from "@moe/store";

import { refuse } from "../bootstrap/bootstrap-ledger.js";
import type { ServiceRefused } from "../bootstrap/bootstrap-ledger.js";
import {
  currentDocumentSourceRef,
  documentSourceLegOf,
  documentSourceRecordOf,
} from "../documents/document-source-leg.js";
import type { AdmittedDocumentSource } from "../documents/document-source-leg.js";

/**
 * The refusal a goal create raises when the document source it would bind resolves to the goal's
 * OWN aggregate. `legs[0]` is always the goal, and the store refuses a later leg naming an
 * aggregate an earlier leg already names, so this stable code answers first and says why.
 */
export const GOAL_CREATE_SOURCE_AGGREGATE_COLLISION =
  "GOAL_CREATE_SOURCE_AGGREGATE_COLLISION" as const;

/** The narrow durable surface this module needs: one observed version, nothing else. */
export interface GoalDocumentSourceVersionPort {
  readonly getAggregateVersion: (aggregateId: string) => number;
}

/**
 * The server-derived facts a GoalCreated payload carries about its bound document. Every field is
 * computed from the admitted bytes; none is forwarded from a caller.
 */
export interface GoalDocumentBinding {
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly sourceAggregateId: string;
  readonly sourceRef: string;
}

export interface GoalDocumentBindingLegs {
  readonly binding: GoalDocumentBinding;
  readonly legs: readonly ExpectedVersionDecisionLeg[];
}

export type GoalDocumentBindingOutcome =
  | GoalDocumentBindingLegs
  | { readonly refusal: ServiceRefused };

/**
 * Builds the EXTRA legs that bind a PRD document source to a GoalCreated decision, choosing
 * between an append and a read-only fence exactly as `approval-activation.ts:178-180` chooses
 * between the multi-leg and single-leg commit on whether a root already exists.
 *
 * WHY THE CONDITIONAL IS THE WHOLE DESIGN: the document source aggregate is CONTENT-ADDRESSED and
 * its first and only commit is always at expectedVersion 0 (document-ingest.ts says so in its own
 * words). A naive unconditional append would therefore REFUSE the second goal that carries the
 * same PRD — that aggregate is already at version 1 — and it would fail as a store-shaped
 * idempotency conflict, reading like a bug in the store rather than a design error here.
 *
 * - source ABSENT  -> an APPEND leg at expectedVersion 0 carrying the source event.
 * - source PRESENT -> a READ-ONLY FENCE leg: an exactly empty `events` array on a non-primary
 *   leg, which the store documents as granting no receipt authority, pinned at the OBSERVED
 *   version. That proves the source exists and did not move under the decision, so a source
 *   rewritten between observation and commit is refused by the store's own fence.
 *
 * The caller keeps `legs[0]` as the goal and appends these; an absent PRD is not this function's
 * case at all, because a caller without one stays on the single-leg commit.
 */
export function goalDocumentBindingLegs(
  store: GoalDocumentSourceVersionPort,
  projectId: string,
  goalAggregateId: string,
  source: AdmittedDocumentSource,
): GoalDocumentBindingOutcome {
  const record = documentSourceRecordOf(source);
  const sourceRef = currentDocumentSourceRef(record);
  const leg = documentSourceLegOf(projectId, record, sourceRef);
  if (leg.aggregateId === goalAggregateId) {
    return {
      refusal: refuse(null, GOAL_CREATE_SOURCE_AGGREGATE_COLLISION, "DAEMON_PREREQUISITE"),
    };
  }

  const observedVersion = store.getAggregateVersion(leg.aggregateId);
  const extra: ExpectedVersionDecisionLeg = observedVersion === 0
    ? { aggregateId: leg.aggregateId, events: [leg.event], expectedVersion: 0 }
    : { aggregateId: leg.aggregateId, events: [], expectedVersion: observedVersion };

  return Object.freeze({
    binding: Object.freeze({
      byteLength: record.byteLength,
      contentSha256: record.contentSha256,
      sourceAggregateId: leg.aggregateId,
      sourceRef,
    }),
    legs: Object.freeze([Object.freeze(extra)]),
  });
}
