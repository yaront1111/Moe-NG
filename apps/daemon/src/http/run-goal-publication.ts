import type { SqliteEventStore } from "@moe/store";
import type { GoalPublishState } from "../repository/publish-ledger.js";
import { readPublicationIntent, readPublicationObservation } from "../repository/publication-effect-ledger.js";
import { PUBLICATION_GIT_TIMEOUT_MS } from "../repository/git-publication-port.js";
import type { RunGoalPublish } from "./runs-read-contract.js";

/**
 * After recordPublicationIntent (node-publisher.ts:186-189): transmit observe :87, push :91,
 * measureRemoteDefaultBranch :97, then observe :203. 4 git-port calls × timeout + 1× margin.
 */
export const PUBLISH_IN_FLIGHT_BOUND_MS = 4 * PUBLICATION_GIT_TIMEOUT_MS + PUBLICATION_GIT_TIMEOUT_MS;

/** An unresolved earlier effect stays visible even if a later request is queued behind its hold. */
export function readRunGoalPublication(
  store: SqliteEventStore, projectId: string, state: GoalPublishState | undefined, now?: number,
): RunGoalPublish | null {
  let request = state?.requests[state.requests.length - 1];
  if (state === undefined || request === undefined) return null;
  let unknown = false;
  for (const pending of state.requests) {
    if (state.receipts.has(pending.decisionId)) continue;
    try {
      const intent = readPublicationIntent(store, projectId, pending.goalId, pending.decisionId);
      if (intent === null) continue;
      request = pending;
      let observed = null;
      try { observed = readPublicationObservation(store, projectId, pending.goalId, pending.decisionId); }
      catch { unknown = true; break; }
      const intendedAt = Date.parse(intent.intendedAt);
      unknown = now === undefined || !Number.isFinite(now) || observed !== null
        || !Number.isFinite(intendedAt) || now - intendedAt >= PUBLISH_IN_FLIGHT_BOUND_MS;
      break;
    } catch { unknown = true; request = pending; break; }
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
