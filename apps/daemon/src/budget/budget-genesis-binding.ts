/**
 * The budget binding for a project whose graph is NOT YET ACTIVE — the moment of approval.
 *
 * WHY THIS MODULE EXISTS. The ordinary reader answers "which account, whose, against which graph
 * revision" from the CURRENT ACTIVE graph (`budget-durable-binding.ts:59`). At approval there is
 * no active graph yet, so that read necessarily refuses and the root a project needs before it
 * can spend anything could never be authorized. This is the circle the governor's Option-B
 * ruling breaks: the genesis derivation ADMITS that refusal rather than routing around it.
 *
 * IT IS NOT A SECOND READER. The production reader runs FIRST and its answer is returned
 * unchanged whenever it succeeds, so every post-ACTIVE caller is byte-for-byte unaffected. Only
 * one refusal is ever converted into a derivation, and only on the exact evidence below.
 *
 * THE GATE MATCHES THE CARRIED UPSTREAM CODE, NEVER THE WRAPPER. `readBudgetBinding` raises
 * `BUDGET_PROJECTION_GRAPH_UNAVAILABLE` for a clean empty project AND for a corrupt or ambiguous
 * durable history — active-graph-projection.ts:120-126 documents that those are DIFFERENT
 * answers and exists to keep them apart. Admitting the wrapper alone would bootstrap a budget
 * root over a history nobody can read, which is unrecoverable: the once-only guard at
 * budget-ledger.ts:104-106 makes the resulting binding permanent.
 */

import type { SqliteEventStore } from "@moe/store";

import { ACTIVE_GRAPH_PROJECTION_LAYER } from "../planning/active-graph-projection.js";
import type { ApprovedRunBinding } from "../planning/approval-run-binding.js";
import { readBudgetBinding, readGoalBudgetIdentity } from "./budget-durable-binding.js";
import type { BudgetBindingResult } from "./budget-durable-binding.js";

/**
 * Genesis is epoch 1 BY DEFINITION and the literal is never read from a caller: the first
 * activation a project ever commits is `graphEpoch: 1` (the reducer's own successor), so a
 * genesis root that named any other epoch would be bound to a graph generation that cannot be
 * the one being approved.
 */
export const GENESIS_GRAPH_EPOCH = 1;

/** The one upstream answer that means "clean empty project", as opposed to "unreadable". */
const CLEAN_EMPTY_UPSTREAM_CODE = "ACTIVE_GRAPH_ABSENT";

/**
 * The approved-run identity a genesis derivation binds to.
 *
 * BOTH FIELDS COME FROM ONE VERIFICATION MOMENT, and neither may be assembled from anything
 * else. `verifyApprovedRunBinding` COMPARES the caller's `graphRevisionRef` against the run
 * record's own durable ref and refuses `APPROVAL_GRAPH_REVISION_DIVERGED` when they differ
 * (approval-run-binding.ts:158-160) — so `verifiedGraphRevisionRef` is durable-verified even
 * though the returned binding does not carry it — and `runBinding` is that comparison's receipt.
 * It cannot be constructed without the verification having run, which is what makes a genesis
 * derivation structurally unreachable for a caller that never verified a run.
 *
 * `GoalState.planningRunRef` is NOT an admissible source and is never read here: it is
 * caller-supplied, it may still name the rejected predecessor after a replan, and N runs may
 * coexist in PLAN_REVIEW. Neither is any scan for "the" run — there is no such singular thing.
 */
export interface GenesisApprovedRun {
  readonly runBinding: ApprovedRunBinding;
  readonly verifiedGraphRevisionRef: string;
}

/** True only for the clean-empty-project refusal, carried unrestamped by the strict reader. */
function isCleanEmptyProject(refusal: Extract<BudgetBindingResult, { ok: false }>): boolean {
  return refusal.code === "BUDGET_PROJECTION_GRAPH_UNAVAILABLE"
    && refusal.sourceCode === CLEAN_EMPTY_UPSTREAM_CODE
    && refusal.sourceLayer === ACTIVE_GRAPH_PROJECTION_LAYER;
}

/**
 * The binding, from the production reader when it can answer and from durable genesis facts
 * when — and only when — the project has never activated a graph.
 *
 * Every field is still read from a durable record or fixed by definition: the account and owner
 * off the goal's own `GoalCreated` through the SAME reader the strict path uses, the revision
 * off the verified approved run, the epoch from the genesis literal. Nothing is adopted from a
 * request payload, so task rail 1 holds on this path exactly as it does on the other.
 */
export function readGenesisBudgetBinding(
  store: SqliteEventStore,
  projectId: string,
  goalRef: string,
  approvedRun: GenesisApprovedRun,
): BudgetBindingResult {
  const strict = readBudgetBinding(store, projectId, goalRef);
  // FORWARDED UNTOUCHED, both ways: a successful read is the answer, and a refusal this module
  // does not admit keeps the code and layer of whoever actually said no.
  if (strict.ok || !isCleanEmptyProject(strict)) return strict;
  const identity = readGoalBudgetIdentity(store, projectId, goalRef);
  if (!identity.ok) return identity;
  return Object.freeze({
    binding: Object.freeze({
      budgetAccountRef: identity.identity.budgetAccountRef,
      goalRef,
      graphEpoch: GENESIS_GRAPH_EPOCH,
      graphRevisionRef: approvedRun.verifiedGraphRevisionRef,
      ownerRef: identity.identity.ownerRef,
      projectId,
    }),
    ok: true as const,
  });
}

/**
 * The same derivation as a `BudgetBindingPort`, so a writer can be handed genesis authority for
 * ONE call without learning anything about approvals.
 */
export function genesisBudgetBindingPort(
  approvedRun: GenesisApprovedRun,
): (store: SqliteEventStore, projectId: string, goalRef: string) => BudgetBindingResult {
  return (store, projectId, goalRef) =>
    readGenesisBudgetBinding(store, projectId, goalRef, approvedRun);
}
