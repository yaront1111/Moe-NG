import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { readReviewLedger } from "../review/review-ledger.js";

/** Stable daemon vocabulary for evidence required before `goal.close` reaches core. */
export const GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED =
  "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED" as const;

export const GOAL_PREREQUISITE_REFUSAL_CODES = Object.freeze([
  GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED,
] as const);

export type GoalPrerequisiteRefusalCode = (typeof GOAL_PREREQUISITE_REFUSAL_CODES)[number];

function objectValue(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object"
    || Array.isArray(value)) return null;
  return value as JsonObject;
}

function nonEmptyRef(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function approvedNodeScope(event: StoredEvent): readonly string[] | null {
  const decoded = decodeBoundedJsonBytes(event.payload);
  if (!decoded.ok) return null;
  const payload = objectValue(decoded.value);
  const approval = payload === null ? null : objectValue(payload["approval"]);
  if (approval === null || !nonEmptyRef(approval["approvalRef"])) return null;
  if (approval["decision"] !== "APPROVE" || approval["lifecycle"] !== "DECIDED"
    || approval["validity"] !== "CURRENT") return null;
  const scope = approval["approvedNodeScope"];
  if (!Array.isArray(scope) || scope.length === 0 || !scope.every(nonEmptyRef)) return null;
  return scope;
}

function enabledScope(store: SqliteEventStore, goalId: string): readonly string[] | null {
  const events = store.readEvents(goalId).filter((event) =>
    event.aggregateId === goalId && event.eventType === "GoalExecutionEnabled");
  if (events.length !== 1) return null;
  return approvedNodeScope(events[0] as StoredEvent);
}

/**
 * Reads authority only from the durable activation event and each durable review ledger.
 * Any absent, malformed, ambiguous, or unreadable evidence returns false; request references
 * never participate in this decision.
 */
export function hasDurableGoalCloseReviewAcceptance(
  store: SqliteEventStore,
  projectId: string,
  goalId: string,
): boolean {
  try {
    const scope = enabledScope(store, goalId);
    if (scope === null) return false;
    return scope.every((nodeRef) => {
      const review = readReviewLedger(store, projectId, nodeRef);
      return !review.unreadable && review.accepted !== undefined;
    });
  } catch {
    return false;
  }
}
