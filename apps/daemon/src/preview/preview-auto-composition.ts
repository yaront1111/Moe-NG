import { createHash } from "node:crypto";

import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { POLICY_EVALUATOR_VERSION } from "../bootstrap/bootstrap-policy-authority.js";
import { installedSlices } from "../bootstrap/bootstrap-policy-services.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import {
  evaluationChain, resolvePolicyFact, resolvePolicyWaivers,
} from "../bootstrap/policy-fact-resolver.js";
import { sliceKindOf } from "../http/policy-read.js";
import { previewAutoDecisionFor, previewAutoDecline } from "./preview-auto-decision.js";
import type { PreviewAutoDecision } from "./preview-auto-decision.js";
import { PREVIEW_DECIDE_COMMAND_KIND } from "./preview-contracts.js";
import { decodePreviewDecisionRecord } from "./preview-decision-record.js";
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
 * NOTHING HERE JUDGES. It selects the chain, resolves the one tier-bearing fact through the
 * daemon's own resolver, and hands the composed input to the pure half. No tier is derived,
 * ranked or compared in this file.
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

/** Whether a slice DECLARES a standing opt-in for this gate. An ACTION EQUALITY and nothing
 *  more: no tier is read, ranked or compared here — that stays the engine's. */
function declaresPreviewOptIn(slice: JsonValue): boolean {
  if (slice === null || typeof slice !== "object" || Array.isArray(slice)) return false;
  const optIns = (slice as Readonly<Record<string, JsonValue>>)["autoApprovalOptIns"];
  return Array.isArray(optIns) && optIns.some((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
    && (entry as Readonly<Record<string, JsonValue>>)["action"] === PREVIEW_DECIDE_COMMAND_KIND);
}

/**
 * THE ONE INSTALLED SLICE THAT DECLARES THIS GATE'S OPT-IN, or nothing.
 *
 * SELECTION IS NOT JUDGEMENT — the same move `validatePolicy` makes when its existence check
 * "stopped being the whole judgement and became the SELECTOR". A wire decide names its
 * `policyRevisionRef`; a SERVER-SIDE decision has no caller to name one, so the subject picks the
 * chain: the slice on which this operator declared the preview gate automatic. MEASURED, NOT
 * ASSUMED: the shipped bootstrap sequence installs TWO EVALUATION slices, so "exactly one
 * EVALUATION slice" would make this path unreachable on every real project while every arm over a
 * hand-built world stayed green. TWO DECLARING SLICES IS STILL A REFUSAL: which one governs would
 * depend on key order, and no reading of that is fail-closed.
 */
function evaluationSliceOf(
  store: SqliteEventStore, projectId: string,
): { readonly ref: string; readonly slice: JsonValue } | null {
  const installed = installedSlices(
    stateOf(readDurableLedger(store, projectId), policyAggregateId(projectId)),
  );
  const refs = Object.keys(installed).filter((ref) => {
    const slice = installed[ref];
    return slice !== undefined && sliceKindOf(ref, slice) === "EVALUATION"
      && declaresPreviewOptIn(slice);
  }).sort();
  const ref = refs.length === 1 ? refs[0] : undefined;
  if (ref === undefined) return null;
  const slice = installed[ref];
  return slice === undefined ? null : { ref, slice };
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
 * SHAPE IS THE DAEMON'S ESTABLISHED ONE: `resolvePolicyFact` for the single tier-bearing fact,
 * `evaluationChain`, `resolvePolicyWaivers` and `POLICY_EVALUATOR_VERSION`, exactly as
 * `validatePolicy` (bootstrap-policy-services.ts:164-192) composes them.
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
  const selected = evaluationSliceOf(store, projectId);
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
    facts: [resolvePolicyFact(store, projectId, principalId, PREVIEW_DECIDE_COMMAND_KIND)],
    graphNodeRevisionRefs: [],
    policyRevisionRef: selected.ref,
    requiredFactIds: [],
    scope: [],
    sliceChain: chain,
    waivers: waivers.waivers,
  });
}
