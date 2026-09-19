import type { SqliteEventStore } from "@moe/store";
import type { GoalPublishState } from "../repository/publish-ledger.js";
import { readPublicationIntent, readPublicationObservation } from "../repository/publication-effect-ledger.js";
import type { RunGoalPublish } from "./runs-read-contract.js";

/** An unresolved earlier effect stays visible even if a later request is queued behind its hold. */
export function readRunGoalPublication(store: SqliteEventStore, projectId: string, state: GoalPublishState | undefined): RunGoalPublish | null {
  let request = state?.requests[state.requests.length - 1];
  if (state === undefined || request === undefined) return null;
  let unknown = false;
  for (const pending of state.requests) {
    if (state.receipts.has(pending.decisionId)) continue;
    try { unknown = readPublicationIntent(store, projectId, pending.goalId, pending.decisionId) !== null; }
    catch { unknown = true; }
    if (unknown) { request = pending; break; }
  }
  const receipt = state.receipts.get(request.decisionId);
  // Only an unresolved publish is observed. The key is always sent, because the card decodes an exact key set.
  const seen = receipt === undefined ? readPublicationObservation(store, projectId, request.goalId, request.decisionId) : null;
  return Object.freeze({ branch: receipt?.branch ?? request.candidate?.approval.branch ?? null,
    code: unknown ? "PUBLISH_EFFECT_RECONCILIATION_REQUIRED" : receipt?.refusal?.code ?? null,
    decisionId: request.decisionId, observation: seen === null ? null : Object.freeze({ observedSha: seen.observedSha,
      expectedSha: seen.expectedSha, reason: seen.reason, observedAt: seen.observedAt }),
    outcome: unknown ? "UNKNOWN" : receipt?.outcome ?? "PENDING",
    remoteUrl: request.remoteUrl, requestedAt: request.decidedAt,
    sha: receipt?.sha ?? request.candidate?.approval.sha ?? null, url: receipt?.url ?? null });
}
