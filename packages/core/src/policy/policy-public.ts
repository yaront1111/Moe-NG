/**
 * The curated PUBLIC policy surface, lifted verbatim out of the package root barrel by
 * task-77af2cd3 so `src/index.ts` could drop below the hard 400-line split threshold.
 *
 * THE INITIAL EXTRACTION WAS BEHAVIOUR-PRESERVING BY CONSTRUCTION. Its names moved with the
 * same value/type grouping and renames; the only edit was `./policy/x.js` -> `./x.js`, because
 * this file sits inside `src/policy/`. Later reviewed rows may append curated named exports
 * here, as task-e241a79a does for the two approval validators below. No package subpath was
 * added — `packages/core/package.json` still exposes exactly one entry, `"."`.
 *
 * WHY A CURATED LIST RATHER THAN `export *`. Two of these are RENAMES
 * (`CLASSIFIED_SLICE_KEYS as POLICY_CLASSIFIED_SLICE_KEYS`, `SLICE_KEYS as POLICY_SLICE_KEYS`),
 * so a star re-export would publish the unrenamed names and silently change the exact root
 * surface pinned by `index-surface.test.ts`. The list is the contract, not a convenience.
 *
 * Mirrors the `./identity/index.ts` precedent, including its exact one-line LF `.js` bridge:
 * `runtime-entrypoint.test.ts:16-18` records that vitest resolves `./foo.js` back to `foo.ts`
 * while Node does not, so the bridge is a required consequence of this file existing.
 */
export { evaluatePolicy } from "./policy-evaluation.js";
export {
  CLASSIFIED_SLICE_KEYS as POLICY_CLASSIFIED_SLICE_KEYS, SLICE_KEYS as POLICY_SLICE_KEYS,
} from "./policy-validation.js";
export {
  POLICY_SLICE_DIGEST_CODES,
  POLICY_SLICE_DIGEST_LAYERS,
  POLICY_SLICE_DIGEST_VERSION,
  derivePolicySliceDigest,
} from "./policy-slice-digest.js";
export type {
  PolicySliceDigestAcceptedResult,
  PolicySliceDigestCode,
  PolicySliceDigestLayer,
  PolicySliceDigestRefusal,
  PolicySliceDigestResult,
} from "./policy-slice-digest.js";
export {
  CORE_DECISION_REASON_OBLIGATION,
  CORE_STEP_UP_OBLIGATION,
  POLICY_AUTO_APPROVAL_TIERS,
  POLICY_OBLIGATION_KINDS,
  POLICY_OUTCOMES,
  POLICY_OUTCOME_DOMINANCE,
  POLICY_REASON_CODES,
  POLICY_RISK_TIERS,
  POLICY_RULE_EFFECTS,
} from "./policy-contract.js";
export type {
  PolicyAutoApprovalOptIn,
  PolicyAutoApprovalTier,
  PolicyDecisionRecord,
  PolicyEvaluationAcceptedResult,
  PolicyEvaluationInput,
  PolicyEvaluationRejectedResult,
  PolicyEvaluationResult,
  PolicyFactInput,
  PolicyObligation,
  PolicyObligationKind,
  PolicyOutcome,
  PolicyReasonCode,
  PolicyRecordedFact,
  PolicyRiskAssessment,
  PolicyRiskTier,
  PolicyRule,
  PolicyRuleEffect,
  PolicySlice,
  PolicyWaiver,
} from "./policy-contract.js";

export {
  applyApprovalCommand,
  applyApprovalInvalidation,
  evaluateCarryForward,
} from "./approval-invalidation.js";
export {
  validateApprovalDependencyChanges,
  validateApprovalRecord,
} from "./approval-validation.js";
export {
  APPROVAL_ACTOR_KINDS,
  APPROVAL_COMMAND_KINDS,
  CARRY_FORWARD_REASON_CODES,
} from "./approval-contract.js";
export type {
  ApprovalAcceptedResult,
  ApprovalActorKind,
  ApprovalCommand,
  ApprovalCommandKind,
  ApprovalDecideCommand,
  ApprovalDecision,
  ApprovalDecisionRecord,
  ApprovalDependencyChanges,
  ApprovalImpactSet,
  ApprovalInvalidationInput,
  ApprovalLifecycle,
  ApprovalRejectedResult,
  ApprovalResult,
  ApprovalSuccessorLink,
  ApprovalValidity,
  ApprovalWithdrawCommand,
  CarryForwardInput,
  CarryForwardReasonCode,
  CarryForwardVerdict,
} from "./approval-contract.js";
