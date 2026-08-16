import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

/** Stable daemon vocabulary for evidence required before `goal.close` reaches core. */
export const GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED =
  "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED" as const;
export const GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT =
  "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT" as const;
export const GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS =
  "GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS" as const;
export const GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE =
  "GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE" as const;
export const GOAL_CLOSE_VERIFICATION_NOT_PASSED =
  "GOAL_CLOSE_VERIFICATION_NOT_PASSED" as const;
export const GOAL_CLOSE_RESULT_DIGEST_MISMATCH =
  "GOAL_CLOSE_RESULT_DIGEST_MISMATCH" as const;
export const GOAL_CLOSE_REVIEW_PACKAGE_STALE =
  "GOAL_CLOSE_REVIEW_PACKAGE_STALE" as const;
export const GOAL_CLOSE_AUTHORITY_REMAINS =
  "GOAL_CLOSE_AUTHORITY_REMAINS" as const;

/**
 * Appended, never reordered: `goal-services.test.ts` restates this list by hand, so a code
 * inserted in the middle reddens there rather than drifting silently.
 *
 * ABSENT and AMBIGUOUS stay SEPARATE for the reason `foundation-verification-contracts.ts:44-59`
 * keeps RECEIPT_UNCOMMITTED apart from RECEIPT_AMBIGUOUS: zero rows and two rows are opposite
 * durable states demanding opposite repairs, and one code for both tells a reviewer nothing.
 *
 * Every member refuses at the EXISTING `DAEMON_PREREQUISITE` layer, already listed in
 * `bootstrap-ledger.ts`'s `SERVICE_REFUSED_BY`; this slice adds no layer.
 */
export const GOAL_PREREQUISITE_REFUSAL_CODES = Object.freeze([
  GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED,
  GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT,
  GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS,
  GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE,
  GOAL_CLOSE_VERIFICATION_NOT_PASSED,
  GOAL_CLOSE_RESULT_DIGEST_MISMATCH,
  GOAL_CLOSE_REVIEW_PACKAGE_STALE,
  GOAL_CLOSE_AUTHORITY_REMAINS,
] as const);

/** The one layer every code above refuses at, named once so no call site can drift. */
export const GOAL_PREREQUISITE_LAYER = "DAEMON_PREREQUISITE" as const;

export type GoalPrerequisiteRefusalCode = (typeof GOAL_PREREQUISITE_REFUSAL_CODES)[number];

function objectValue(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object"
    || Array.isArray(value)) return null;
  return value as JsonObject;
}

function nonEmptyRef(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The durable approval this closure answers for: which approval, over which nodes. */
export interface ApprovedNodeScope {
  readonly approvalRef: string;
  readonly scope: readonly string[];
}

function approvedNodeScope(event: StoredEvent): ApprovedNodeScope | null {
  const decoded = decodeBoundedJsonBytes(event.payload);
  if (!decoded.ok) return null;
  const payload = objectValue(decoded.value);
  const approval = payload === null ? null : objectValue(payload["approval"]);
  if (approval === null || !nonEmptyRef(approval["approvalRef"])) return null;
  if (approval["decision"] !== "APPROVE" || approval["lifecycle"] !== "DECIDED"
    || approval["validity"] !== "CURRENT") return null;
  const scope = approval["approvedNodeScope"];
  if (!Array.isArray(scope) || scope.length === 0 || !scope.every(nonEmptyRef)) return null;
  return { approvalRef: approval["approvalRef"], scope };
}

/**
 * The ONE durable reader for the approved node scope, exported so the closure composer reuses
 * it rather than growing a second copy that could drift from this one. It answers null for
 * absent, ambiguous, unreadable and non-current approvals alike: each is a reason the approved
 * closure is unknown, and an unknown closure confers nothing.
 */
export function readApprovedNodeScope(
  store: SqliteEventStore,
  goalId: string,
): ApprovedNodeScope | null {
  try {
    const events = store.readEvents(goalId).filter((event) =>
      event.aggregateId === goalId && event.eventType === "GoalExecutionEnabled");
    if (events.length !== 1) return null;
    return approvedNodeScope(events[0] as StoredEvent);
  } catch {
    return null;
  }
}

