import { POLICY_AUTO_APPROVAL_TIERS, evaluatePolicy } from "@moe/core";
import type { PolicyReasonCode } from "@moe/core";

import type { PreviewDecisionProvenance } from "./preview-decision-record.js";

/**
 * GATE 2 CLOSING ON MACHINE EVIDENCE: whether the daemon may decide `preview.decide` itself, under
 * a standing operator opt-in, with no human in the loop.
 *
 * IT DECIDES NOTHING THE POLICY ENGINE DECIDES. `evaluatePolicy` (@moe/core, bare specifier) is the
 * authority for tier ranking, opt-in matching and the dominance lattice, and none of those is
 * reimplemented. This module owns four things: which subjects are answerable, which installed slice
 * is the chain, composing the evaluation input the daemon's established way, and reading the
 * engine's verdict back into a NAMED provenance.
 *
 * FAIL-CLOSED IS STRUCTURAL, NOT A BRANCH. `assessRisk` grounds a tier only from a fact clearing
 * the strong-truth floor, and `evaluatePolicy` folds `dominant(decision, unclassifiable ?
 * "HOLD_UNKNOWN" : "ALLOW")` with HOLD_UNKNOWN dominating ALLOW, so a tier-free ALLOW is not
 * reachable as a deciding path. `resolvePolicyFact` mints a null-tier UNKNOWN fact on every miss:
 * this module cannot approve what the operator has not durably classified AND opted in.
 *
 * WHY ALLOW ALONE DOES NOT SETTLE IT, AND WHY THE OPT-IN ITSELF IS NOT QUOTED. An automatic
 * approval must be DISTINGUISHABLE from a human one, so it names what it acted under. `assessTier`
 * requires `entry.action === action` before returning ALLOW, so the record's `action` IS the
 * matched opt-in's action; the second gate re-checks the tier against the IMPORTED
 * `POLICY_AUTO_APPROVAL_TIERS`, so this module refuses independently of the engine agreeing. The
 * FOLDED entry is unreachable — `foldSlices` and `tierRank` are private to @moe/core — and
 * re-deriving it is the reimplementation this module must not do.
 *
 * IT WRITES NOTHING. Every refusal is a RETURNED value, never a thrown `DomainRefusal`: a declined
 * automatic decision is the gate staying pending for a human, which is what it did before.
 */

/** This module answered. Deliberately NOT added to `PREVIEW_LAYERS` or `SERVICE_REFUSED_BY`: no
 *  refusal here reaches a wire, so widening either closed roster would advertise a channel that
 *  does not exist. */
export const PREVIEW_AUTO_DECISION_LAYER = "PREVIEW_AUTO_DECISION" as const;
/** CORE answered — the same attribution `bootstrap-policy-services.ts` gives an engine refusal. */
export const PREVIEW_AUTO_POLICY_LAYER = "CORE_REDUCER" as const;

/**
 * Why no automatic decision was taken, mapped to the layer that answered. The layer is DERIVED
 * from the code exactly as `PREVIEW_CODE_LAYERS` derives its own, so no call site can pair a code
 * with a layer the vocabulary disagrees with. This vocabulary widens nothing: the preview WIRE map
 * stays closed at four, because no condition below is one a payload can create and none travels
 * back to a caller.
 */
export const PREVIEW_AUTO_CODE_LAYERS = Object.freeze({
  /** Already decided, human or automatic. Precedence and idempotence are ONE check: first wins. */
  PREVIEW_AUTO_ALREADY_DECIDED: PREVIEW_AUTO_DECISION_LAYER,
  /** CORE: the outcome was not ALLOW. The engine's own `reasonCodes` travel with this. */
  PREVIEW_AUTO_NOT_ALLOWED: PREVIEW_AUTO_POLICY_LAYER,
  /** CORE: the composed input was structurally rejected (INPUT_INVALID). */
  PREVIEW_AUTO_POLICY_INPUT_INVALID: PREVIEW_AUTO_POLICY_LAYER,
  /** No single installed slice declares this gate's opt-in, so there is no chain to evaluate. */
  PREVIEW_AUTO_POLICY_UNRESOLVED: PREVIEW_AUTO_DECISION_LAYER,
  /** The receipt did not reach STARTED, so there is no served preview to approve. */
  PREVIEW_AUTO_RECEIPT_NOT_STARTED: PREVIEW_AUTO_DECISION_LAYER,
  /** ALLOW, but the tier is outside `POLICY_AUTO_APPROVAL_TIERS`. Unreachable while the engine
   *  holds; kept so this module refuses on its own authority rather than on trust. */
  PREVIEW_AUTO_TIER_UNCOVERED: PREVIEW_AUTO_DECISION_LAYER,
} as const);

export const PREVIEW_AUTO_CODES = Object.freeze(
  Object.keys(PREVIEW_AUTO_CODE_LAYERS).sort() as readonly (keyof typeof PREVIEW_AUTO_CODE_LAYERS)[],
);

export type PreviewAutoCode = keyof typeof PREVIEW_AUTO_CODE_LAYERS;
export type PreviewAutoLayer = (typeof PREVIEW_AUTO_CODE_LAYERS)[PreviewAutoCode];

export interface PreviewAutoApproved {
  readonly ok: true;
  /** What the record will NAME. Never minted: both members come from the engine's own record. */
  readonly provenance: PreviewDecisionProvenance;
}

export interface PreviewAutoDeclined {
  readonly code: PreviewAutoCode;
  readonly layer: PreviewAutoLayer;
  readonly ok: false;
  /** The ENGINE's own reason codes when core answered (HUMAN_ONLY_TIER,
   *  AUTO_APPROVAL_NOT_OPTED_IN, ...). Empty when this module answered before core was asked. */
  readonly reasonCodes: readonly PolicyReasonCode[];
}

export type PreviewAutoDecision = PreviewAutoApproved | PreviewAutoDeclined;

/** One declination, with the layer DERIVED from the code. Exported for the composition half, so
 *  there is exactly one place a code and a layer are paired. */
export function previewAutoDecline(
  code: PreviewAutoCode, reasonCodes: readonly PolicyReasonCode[] = [],
): PreviewAutoDeclined {
  return Object.freeze({
    code, layer: PREVIEW_AUTO_CODE_LAYERS[code], ok: false as const,
    reasonCodes: Object.freeze([...reasonCodes]),
  });
}

/** The engine's verdict, read back as a NAMED approval or a declination. PURE. Exported so tier
 *  negatives are driven through the EVALUATION INPUT: `admitGoalBrief` is exact-arity over
 *  `["title","instructions"]`, so a goal's risk class reaches the daemon only as prose. */
export function previewAutoDecisionFor(evaluationInput: unknown): PreviewAutoDecision {
  const evaluated = evaluatePolicy(evaluationInput);
  if (!evaluated.ok) return previewAutoDecline("PREVIEW_AUTO_POLICY_INPUT_INVALID");
  const { record } = evaluated;
  if (record.decision !== "ALLOW") {
    return previewAutoDecline("PREVIEW_AUTO_NOT_ALLOWED", record.reasonCodes);
  }
  // THE SECOND GATE, not redundant with ALLOW by design: it re-asks the ceiling question against
  // the IMPORTED frozen constant, so an upstream widening cannot silently widen this gate and an
  // engine regression that let an R2 subject through would still be refused here.
  const tier = record.riskAssessment.effectiveTier;
  if (tier === null || !POLICY_AUTO_APPROVAL_TIERS.some((one) => one === tier)) {
    return previewAutoDecline("PREVIEW_AUTO_TIER_UNCOVERED", record.reasonCodes);
  }
  return Object.freeze({
    ok: true as const,
    provenance: Object.freeze({ action: record.action, tier }),
  });
}
