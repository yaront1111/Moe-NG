import { createHash } from "node:crypto";

import type { PolicyFactInput } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import type { PolicyEvaluationAuthority } from "../bootstrap/bootstrap-policy-authority-reader.js";
import { readRunPolicyEvaluation } from "../bootstrap/run-policy-selection.js";
import { readCriterionGoal } from "../criterion-evidence/criterion-goal.js";
import { RUN_POLICY_ACTION } from "../planning/run-policy-record.js";
import { PREVIEW_DECIDE_COMMAND_KIND } from "./preview-contracts.js";

/**
 * WHERE GATE 2'S RISK EVIDENCE ACTUALLY COMES FROM, on the journey the product actually runs.
 *
 * THE BUG THIS MODULE CLOSES. The gate used to ask `resolvePolicyFact` for an operator-recorded
 * `readPolicyRisk` classification bound to `preview.decide`. Nothing on the ordinary journey
 * writes one: `approval-activation.ts` Path B activates no graph revision, so
 * `readCurrentActiveGraph` answers ACTIVE_GRAPH_ABSENT, `buildPolicyRiskLeg` refuses
 * POLICY_RISK_SUBJECT_UNAVAILABLE on the resulting null subject, and `withPolicyRiskLeg`
 * (policy-risk-leg.ts:141) SILENTLY DROPS the leg. Measured at HEAD f6e97a6b over a completed
 * `journeyWorld`: ZERO policy-risk aggregates, so the gate reached RISK_TIER_UNCLASSIFIABLE on
 * every real project while the tests stayed green against a hand-inserted record.
 *
 * THE EVIDENCE THAT DOES EXIST, AND WHY THIS IS A THIRD CONSUMER RATHER THAN A NEW MECHANISM.
 * The goal's own planning run carries a REPLAY-VERIFIED tier, written by production planning
 * finalization and read through `readRunPolicyEvaluation`. Two production consumers already read
 * it exactly this way -- `approval-record-facts.ts` for the approval record's `riskTier` fact, and
 * `release-auto-approval.ts` (`subjectTierOf`) which publishes it to Gate 3 as a DAEMON_VERIFIED
 * fact. This module is the third. That reader is WRAPPED, never widened: both existing consumers
 * depend on its current behaviour, so the two extra pins below live here.
 *
 * THE TWO PINS THE READER DOES NOT MAKE, AND WHY EACH IS LOAD-BEARING.
 *  - PRODUCER ACTION. `readRunPolicyEvaluation` accepts any replay-valid row filed at the run's
 *    aggregate. Only a `plan.finalize` row is the planning gate's own verdict on this plan; a row
 *    produced by some other action would be a tier about a different question.
 *  - GRAPH BINDING. The reader verifies project, exact run and a single replay-valid row, but
 *    NEVER compares the evaluation's subject to the goal's. A run whose evaluation names a
 *    different graph -- a stale revision, or a replayed row from another plan of the same run --
 *    would otherwise publish DAEMON_VERIFIED for a subject it never assessed. The goal binding's
 *    `graphContentHash` must be the evaluation's EXACT SINGLE `graphNodeRevisionRefs` member.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It is not approval authority and it moves none.
 * `preview.decide` stays the evaluated action, the opt-in lookup key and the waiver lookup key,
 * and the configured operator principal is untouched -- see `preview-auto-composition.ts`. The
 * run's tier is EVIDENCE ABOUT THE SUBJECT; whether an operator auto-approves `preview.decide` at
 * that tier is a separate question only `autoApprovalOptIns` answers. That separation is what
 * keeps per-action operator control intact: someone who opted in to `plan.approve` but not to
 * `preview.decide` still gets no automatic preview. It also pins no `decision`: the journey's
 * measured row is REQUIRE_HUMAN_APPROVAL, which is the planning gate's verdict about the plan and
 * says nothing about how risky the subject is.
 *
 * UNKNOWN IS THE ONLY SAFE ABSENCE, and that is a structural claim rather than a preference.
 * `assessRisk` (policy-evaluation.ts:67-71) SKIPS a fact whose truth class is not DAEMON_VERIFIED
 * or HUMAN_APPROVED, but for a fact that clears that floor it takes
 * `maxTier(fact.tier, declared.get(fact.factId))` -- so an operator classification CAN hand a
 * strong null-tier fact a tier. A refusal here must therefore carry BOTH `tier: null` AND
 * `truthClass: "UNKNOWN"`; publishing DAEMON_VERIFIED with a null tier would let the overlay
 * classify a subject nobody assessed.
 *
 * NO LAYER IS MINTED HERE. This is a fact resolver, not a refusal surface: no code below reaches
 * a wire, and the refusal an operator sees stays the gate's own PREVIEW_AUTO_NOT_ALLOWED at
 * CORE_REDUCER carrying the engine's RISK_TIER_UNCLASSIFIABLE. The codes exist so a test can pin
 * WHICH pin answered -- five different worlds otherwise produce one identical gate refusal, and an
 * arm meaning to test the graph binding could be failing for an unrelated reason and stay green.
 */

const FACT_ID_DOMAIN = "moe.preview-risk-fact.v1";

/**
 * Six codes, one per mechanism that can withhold the fact. They are deliberately NOT collapsed:
 * `GOAL_UNREADABLE` (no readable goal at all), `RUN_EVALUATION_UNAVAILABLE` (the run's row is
 * absent, ambiguous, corrupt, unverified or foreign -- the selector's own five codes) and
 * `GRAPH_BINDING_MISMATCH` (an honest row about the wrong subject) are different operator
 * problems, and each is the ONLY mechanism that answers its own negative arm.
 */
export const PREVIEW_RISK_FACT_CODES = Object.freeze([
  "PREVIEW_RISK_EVIDENCE_UNREADABLE",
  "PREVIEW_RISK_GOAL_UNREADABLE",
  "PREVIEW_RISK_GRAPH_BINDING_MISMATCH",
  "PREVIEW_RISK_PRODUCER_ACTION_FOREIGN",
  "PREVIEW_RISK_RUN_EVALUATION_UNAVAILABLE",
  "PREVIEW_RISK_RUN_UNBOUND",
  "PREVIEW_RISK_TIER_ABSENT",
] as const);

export type PreviewRiskFactCode = (typeof PREVIEW_RISK_FACT_CODES)[number];

export interface PreviewRiskFactResolved {
  /** `null` exactly when the fact is DAEMON_VERIFIED; otherwise which pin withheld it. */
  readonly code: PreviewRiskFactCode | null;
  readonly fact: PolicyFactInput;
}

/**
 * The fact id a VERIFIED preview risk fact carries, addressed by the run it was drawn from so an
 * operator's `riskClassifications` can RAISE it -- the same operator-facing mechanism Gate 3 uses.
 *
 * IT IS THE PREVIEW GATE'S OWN ID, not `release.run_policy_tier:`. The two gates read one durable
 * row so they can never disagree about the run's tier, but the CLASSIFICATION overlay is an
 * operator judgement per gate, exactly as the opt-ins already are; sharing one id would make
 * raising the release gate silently raise the preview gate too.
 */
export function previewRunRiskFactId(runId: string): string {
  return `preview.run_policy_tier:${runId}`;
}

/** Every withheld fact, with a deterministic id so a repeated evaluation is a function of the
 *  subject rather than of the clock. Both halves fail closed: no tier, and no strong truth. */
function withheld(
  projectId: string, goalId: string, code: PreviewRiskFactCode,
): PreviewRiskFactResolved {
  const identity = JSON.stringify([
    FACT_ID_DOMAIN, projectId, goalId, PREVIEW_DECIDE_COMMAND_KIND,
  ]);
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return Object.freeze({
    code,
    fact: Object.freeze({
      factId: `preview-risk-unclassifiable:sha256:${digest}`,
      tier: null,
      truthClass: "UNKNOWN" as const,
    }),
  });
}

/**
 * THE TWO PINS, PURE, over a verified evaluation and the goal binding's graph digest.
 *
 * SPLIT OUT FOR THE SAME REASON `preview-auto-decision.ts` is split from its composition half: a
 * world where the goal's run aggregate carries ONE adverse row is not constructible -- the
 * journey's own finalize leg already filed the honest one, so anything added makes the selector
 * answer AMBIGUOUS before either pin is reached. Exporting the pins lets each be driven against a
 * REAL production evaluation (built by `evaluateRunPolicy`, read back through the strict reader)
 * with exactly one operand varied, so a deleted pin reds exactly one arm. Nothing is reimplemented
 * anywhere: the tests call THIS function.
 */
export function previewRiskFactFrom(
  evaluation: PolicyEvaluationAuthority,
  graphContentHash: string,
  projectId: string,
  goalId: string,
): PreviewRiskFactResolved {
  if (evaluation.action !== RUN_POLICY_ACTION) {
    return withheld(projectId, goalId, "PREVIEW_RISK_PRODUCER_ACTION_FOREIGN");
  }
  const refs = evaluation.graphNodeRevisionRefs;
  if (refs.length !== 1 || refs[0] !== graphContentHash) {
    return withheld(projectId, goalId, "PREVIEW_RISK_GRAPH_BINDING_MISMATCH");
  }
  // Written as a narrowing rather than a cast: `runScopedLinkage` (run-policy-record.ts:110)
  // yields `runId` and `riskTier` together or yields neither, so this is unreachable through the
  // selector -- but if that invariant ever moved, the fact goes UNKNOWN instead of publishing a
  // null tier as verified, which the classification overlay could then hand a tier.
  if (evaluation.riskTier === null || evaluation.runId === null) {
    return withheld(projectId, goalId, "PREVIEW_RISK_TIER_ABSENT");
  }
  return Object.freeze({
    code: null,
    fact: Object.freeze({
      factId: previewRunRiskFactId(evaluation.runId),
      tier: evaluation.riskTier,
      truthClass: "DAEMON_VERIFIED" as const,
    }),
  });
}

/**
 * Gate 2's single tier-bearing fact, resolved from the goal's own planning run.
 *
 * The goal is read through `readCriterionGoal`, which is the reader that already joins a goal to
 * its planning run and its compiled contract binding, and is what `subjectTierOf` uses for the
 * same purpose on the release side. Nothing here derives, ranks or compares a tier.
 *
 * ALL FIVE SELECTOR REFUSALS FOLD TO ONE CODE, deliberately. `readRunPolicyEvaluation` already
 * distinguishes ABSENT, AMBIGUOUS, ROW_UNREADABLE, RUN_MISMATCH and UNVERIFIED and its own suite
 * pins each; re-spelling that vocabulary here would be a second answer to a question that already
 * has one. What this seam owes its caller is the fail-closed fact, and there is one of those.
 */
export function resolvePreviewRiskFact(
  store: SqliteEventStore, projectId: string, goalId: string,
): PreviewRiskFactResolved {
  try {
    return resolveOrThrow(store, projectId, goalId);
  } catch {
    // A THROW IS AN ABSENCE, NEVER AN ESCAPE. The old `readPolicyRisk` path wrapped every store
    // read itself and could not throw; this one reaches `readRunPolicyEvaluation`, which guards
    // `readEvents` but not the strict reader it then calls. That matters because
    // `preview-start-command.ts:207` calls the gate OUTSIDE the `try` at :209, so a throw here
    // would fail the operator's `preview.start` instead of leaving the gate pending for a human.
    // Containing it makes this function's contract total: it publishes, or it answers UNKNOWN.
    return withheld(projectId, goalId, "PREVIEW_RISK_EVIDENCE_UNREADABLE");
  }
}

function resolveOrThrow(
  store: SqliteEventStore, projectId: string, goalId: string,
): PreviewRiskFactResolved {
  const goal = readCriterionGoal(store, projectId, goalId);
  if (!goal.ok) return withheld(projectId, goalId, "PREVIEW_RISK_GOAL_UNREADABLE");
  const runId = goal.graph.planningRunRef;
  if (runId === undefined || runId === "") {
    return withheld(projectId, goalId, "PREVIEW_RISK_RUN_UNBOUND");
  }
  const selected = readRunPolicyEvaluation(store, { projectId, runId });
  if (!selected.ok) {
    return withheld(projectId, goalId, "PREVIEW_RISK_RUN_EVALUATION_UNAVAILABLE");
  }
  return previewRiskFactFrom(
    selected.evaluation, goal.binding.graphContentHash, projectId, goalId,
  );
}
