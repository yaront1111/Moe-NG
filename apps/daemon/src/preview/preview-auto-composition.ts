import { createHash } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { POLICY_EVALUATOR_VERSION } from "../bootstrap/bootstrap-policy-authority.js";
import { selectEffectiveAutoApprovalPolicy } from "../bootstrap/effective-auto-policy.js";
import { evaluationChain, resolvePolicyWaivers } from "../bootstrap/policy-fact-resolver.js";
import { previewAutoDecisionFor, previewAutoDecline } from "./preview-auto-decision.js";
import type { PreviewAutoDecision } from "./preview-auto-decision.js";
import { PREVIEW_DECIDE_COMMAND_KIND } from "./preview-contracts.js";
import { decodePreviewDecisionRecord } from "./preview-decision-record.js";
import { resolvePreviewRiskFact } from "./preview-risk-fact.js";
import { previewAggregateId } from "./preview-receipt-contracts.js";
import type { PreviewReceiptV1 } from "./preview-receipt-contracts.js";

/**
 * COMPOSING THE PREVIEW GATE'S AUTOMATIC DECISION AGAINST THE DURABLE STORE.
 *
 * Split from `preview-auto-decision.ts` on a real seam, not for a line count: that module is PURE
 * — it takes an evaluation input and answers — so every tier and opt-in arm can be driven without
 * a store at all. Everything here needs one. The pure half stays the thing a reviewer reads to see
 * what the gate DECIDES; this half is what it reads FROM.
 *
 * NOTHING HERE JUDGES, AND NOTHING HERE SELECTS EITHER. It resolves the one tier-bearing fact
 * through the daemon's own resolver and hands the composed input to the pure half. No tier is
 * derived, ranked or compared in this file.
 *
 * WHICH FACT THAT IS MOVED, AND THE OLD ONE WAS UNREACHABLE. It used to be
 * `resolvePolicyFact(..., PREVIEW_DECIDE_COMMAND_KIND)` -- an operator-recorded `readPolicyRisk`
 * classification -- and the ordinary journey writes NO policy-risk record at all, so that lookup
 * answered POLICY_RISK_RECORD_MISSING and this gate reached RISK_TIER_UNCLASSIFIABLE on every
 * real project. It is now the goal's own replay-verified PLANNING-RUN tier, resolved by
 * `preview-risk-fact.ts`, which is where that whole argument and its two extra pins are
 * documented. THE ACTION DID NOT MOVE WITH IT: `preview.decide` is still the evaluated action,
 * still the opt-in lookup key and still the waiver lookup key, and the operator principal is
 * still the configured one -- the run's tier is evidence about the SUBJECT, never authority to
 * approve, so per-action operator control is unchanged.
 *
 * WHICH POLICY IS EFFECTIVE IS NOT THIS MODULE'S QUESTION. It is asked of
 * `selectEffectiveAutoApprovalPolicy` (bootstrap/effective-auto-policy.ts), the ONE seam the
 * automatic release gate reads too. This file used to answer it locally by narrowing the whole
 * historical installed set to slices declaring THIS gate's action and accepting the single
 * survivor — and the release gate answered it by taking the newest. Two gates, two answers, and
 * the preview reading meant a newer opt-in-free policy could not turn automatic approval off,
 * because the older declaring slice was still that filter's only survivor. The shared rule and
 * the reasoning behind it (including the ambiguity refusal this header used to defend, which it
 * preserves) are documented once, at that seam.
 */

const AUTO_DECISION_DOMAIN = "moe.preview-auto-decision.v1";

/** The subject's own digest, minted server-side. `validateEvaluationInput` demands hex64, and
 *  digesting the RECEIPT keeps the evaluation a function of the subject, never of the clock. */
export function previewAutoDecisionDigest(projectId: string, receiptId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([
      AUTO_DECISION_DOMAIN, projectId, receiptId, PREVIEW_DECIDE_COMMAND_KIND,
    ]), "utf8")
    .digest("hex");
}

/** The commandId an automatic decision commits under. DETERMINISTIC, so the store's own decision
 *  key dedupes a retry even before the already-decided gate sees it. */
export function previewAutoCommandId(projectId: string, receiptId: string): string {
  return `preview-auto-${previewAutoDecisionDigest(projectId, receiptId).slice(0, 32)}`;
}

/**
 * Has this preview already been decided? Reads the LAST committed result on the decide edge's own
 * target aggregate (`previewAggregateId(goalId)`), the same fact the affordance surface reads.
 * ONE CHECK SERVES TWO REQUIREMENTS: a recorded human REJECT must not be overturned, and a retried
 * async handler must not commit a second decision. A separate idempotence guard would be a second,
 * drifting answer to one question.
 */
export function previewAlreadyDecided(
  store: SqliteEventStore, projectId: string, goalId: string,
): boolean {
  const state = stateOf(readDurableLedger(store, projectId), previewAggregateId(goalId));
  return state !== undefined
    && decodePreviewDecisionRecord(state as unknown, projectId) !== null;
}

export interface PreviewAutoDecisionRequest {
  /** ISO-8601, bound server-side, never a payload value. */
  readonly decidedAt: string;
  /** The AUTHENTICATED operator principal: the actor AND the approver the risk fact joins on. */
  readonly principalId: string;
  readonly projectId: string;
  readonly receipt: PreviewReceiptV1;
  readonly store: SqliteEventStore;
}

/**
 * Whether the daemon may decide this preview itself, composed against the durable store. THE INPUT
 * SHAPE IS THE DAEMON'S ESTABLISHED ONE: `evaluationChain`, `resolvePolicyWaivers` and
 * `POLICY_EVALUATOR_VERSION`, exactly as `validatePolicy` (bootstrap-policy-services.ts:164-192)
 * composes them, with `resolvePreviewRiskFact` supplying the single tier-bearing fact in place of
 * the `resolvePolicyFact` lookup `validatePolicy` still makes for its own caller-named action.
 */
export function resolvePreviewAutoDecision(
  request: PreviewAutoDecisionRequest,
): PreviewAutoDecision {
  const { decidedAt, principalId, projectId, receipt, store } = request;
  // NEVER ON A REFUSED RECEIPT. A REFUSED receipt carries a code and a NULL url by the receipt
  // decoder's own equivalence, so approving one would approve a preview that never served.
  if (receipt.outcome !== "STARTED") return previewAutoDecline("PREVIEW_AUTO_RECEIPT_NOT_STARTED");
  if (previewAlreadyDecided(store, projectId, receipt.goalId)) {
    return previewAutoDecline("PREVIEW_AUTO_ALREADY_DECIDED");
  }
  const selected = selectEffectiveAutoApprovalPolicy(store, projectId);
  if (selected === null) return previewAutoDecline("PREVIEW_AUTO_POLICY_UNRESOLVED");
  const evaluatedAtEpochMs = Date.parse(decidedAt);
  if (!Number.isSafeInteger(evaluatedAtEpochMs) || evaluatedAtEpochMs < 0) {
    return previewAutoDecline("PREVIEW_AUTO_POLICY_INPUT_INVALID");
  }
  const chain = evaluationChain(selected.slice);
  const waivers = resolvePolicyWaivers(store, {
    authenticatedPrincipal: principalId,
    evaluatedAction: PREVIEW_DECIDE_COMMAND_KIND,
    evaluatedAtEpochMs,
    installedPolicyRevisionRef: selected.ref,
    installedSliceChain: chain,
    projectId,
    scope: [],
  });
  return previewAutoDecisionFor({
    action: PREVIEW_DECIDE_COMMAND_KIND,
    actor: principalId,
    callerRiskHint: null,
    decisionDigest: previewAutoDecisionDigest(projectId, receipt.receiptId),
    evaluatedAtEpochMs,
    evaluatorVersion: POLICY_EVALUATOR_VERSION,
    facts: [resolvePreviewRiskFact(store, projectId, receipt.goalId).fact],
    graphNodeRevisionRefs: [],
    policyRevisionRef: selected.ref,
    requiredFactIds: [],
    scope: [],
    sliceChain: chain,
    waivers: waivers.waivers,
  });
}
