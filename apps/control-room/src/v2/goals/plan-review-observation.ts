import type { ApprovalAuthorization } from "./plan-approval.js";

/** Offer IDs are minted on every poll. Only this run's offered ledger version refreshes its review reads. */
export function planReviewObservationKey(authorization: ApprovalAuthorization, runId: string): string | null {
  if (authorization.status !== "AUTHORIZED" || authorization.grant.runId !== runId
    || authorization.grant.affordance["targetAggregateId"] !== runId) return null;
  const version = authorization.grant.affordance["expectedVersion"];
  return JSON.stringify([runId, typeof version === "number" && Number.isSafeInteger(version) ? version : null]);
}
