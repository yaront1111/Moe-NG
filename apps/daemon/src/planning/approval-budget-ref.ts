import type { SqliteEventStore } from "@moe/store";

import { budgetCommitmentDigest, budgetCommitmentMaterial }
  from "../budget/budget-commitment.js";
import { readApprovalIntentSources } from "./approval-intent-sources.js";
import type { UpstreamRefusal } from "./approval-policy-ref.js";

/**
 * The decide-time budget COMMITMENT for one run, split out of `approval-record-facts.ts` by
 * task-be80cb74 when the roster walk's fourth slot pushed that file past the 250-line cap --
 * the same split `approval-policy-ref.ts` took for the third slot.
 *
 * NOT the activation root digest. The root is minted at ACTIVATION, downstream of the very
 * record it would sign, which is why this slot had no producer before. The COMMITMENT is a
 * different notion (task-61a2e8ad, budget-commitment.ts): it covers the budget material that
 * was durable when the human decided, so it is derivable before activation.
 */
export type ApprovalBudgetRefResult =
  | Readonly<{ ref: string }>
  | Readonly<{ upstream: UpstreamRefusal }>;

/**
 * Composed from the RUN'S OWN durable identity, never from a caller.
 *
 * The approved-run binding comes from `readApprovalIntentSources`, which reads it off the
 * durable ledger and verifies it; the request vocabulary at the seam above is only
 * {projectId, runId}, so nothing here can be presented. The commitment is the SHARED builder's
 * -- the same `budgetCommitmentMaterial` + `budgetCommitmentDigest` pair the activation
 * bind-back verifies against -- never a second material list, which is what makes the seam and
 * the fence agree by construction rather than by review.
 *
 * Every refusal is forwarded with the code and layer of whoever actually said no: the ledger
 * reader, the run binding, or the material builder. "This run is not sealed" and "the budget
 * history is unreadable" send an operator to different repairs, so neither is restamped.
 */
export function deriveApprovalBudgetRef(
  store: SqliteEventStore, projectId: string, runId: string,
): ApprovalBudgetRefResult {
  const sources = readApprovalIntentSources(store, projectId, runId);
  if (!sources.ok) return { upstream: { code: sources.code, layer: sources.layer } };
  if (!sources.binding.ok) {
    return { upstream: { code: sources.binding.code, layer: sources.binding.layer } };
  }
  const material = budgetCommitmentMaterial(store, {
    approvedRun: {
      runBinding: sources.binding.binding,
      verifiedGraphRevisionRef: sources.graphRevisionRef,
    },
    goalRef: sources.goalRef,
    projectId,
  });
  return material.ok
    ? { ref: budgetCommitmentDigest(material.material) }
    : { upstream: { code: material.code, layer: material.layer } };
}
