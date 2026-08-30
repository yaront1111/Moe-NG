/**
 * The curated PUBLIC policy surface, lifted verbatim out of the package root barrel by
 * task-77af2cd3 so `src/index.ts` could drop below the hard 400-line split threshold.
 *
 * BEHAVIOUR-PRESERVING BY CONSTRUCTION. Every name below is the one the root already
 * published, in the same value/type grouping and with the same renames; the ONLY edit was
 * the specifier prefix `./policy/x.js` -> `./x.js`, because this file sits inside
 * `src/policy/`. Nothing formerly private is exported here, and no package subpath was
 * added — `packages/core/package.json` still exposes exactly one entry, `"."`.
 *
 * WHY A CURATED LIST RATHER THAN `export *`. Two of these are RENAMES
 * (`CLASSIFIED_SLICE_KEYS as POLICY_CLASSIFIED_SLICE_KEYS`, `SLICE_KEYS as POLICY_SLICE_KEYS`),
 * so a star re-export would publish the unrenamed names and silently change the root surface
 * that `index-surface.test.ts` pins at 134. The list is the contract, not a convenience.
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
