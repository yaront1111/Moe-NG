/**
 * The evidence seam, curated rather than blanket re-exported.
 *
 * A consumer holding only these names can build and seal-verify a verification
 * recipe, rematerialize a candidate tree from that recipe's declared closure,
 * judge whether an observed verifier execution is admissible, canonicalize the
 * obligations a receipt may discharge, and build the receipt itself.
 *
 * The rejection helpers (`evidenceFailure`, `evidencePathRejection`,
 * `evidenceRefRejection`) and the bounded-text guards stay internal for the same
 * reason the recovery factories do. `isEvidenceFailure` is the one predicate
 * that is genuinely load-bearing on the surface: `canonicalObligations` returns
 * `readonly DischargedObligation[] | EvidenceFailure`, and an array carries no
 * `.ok` to narrow on, so that union is unusable without it.
 *
 * `receiptDigestInput` is published alongside `recipeSealMatches` so a stored
 * receipt can be re-verified without reconstructing its bound field list by hand.
 */
export {
  rematerializeCandidate,
  type CandidateTreeEntry,
  type CandidateTreePort,
  type RematerializeCandidateInput,
  type RematerializeCandidateResult,
} from "../evidence/candidate-rematerialization.js";
export {
  EVIDENCE_OBLIGATION_KINDS,
  EVIDENCE_RECEIPT_VERSION,
  EVIDENCE_REFUSAL_LAYERS,
  MAX_EVIDENCE_ARGV_ENTRIES,
  MAX_EVIDENCE_DECLARED_ENTRIES,
  MAX_EVIDENCE_OBLIGATIONS,
  MAX_EVIDENCE_TEXT_CHARS,
  RUNNER_EVIDENCE_ERROR_CODES,
  VERIFICATION_RECIPE_VERSION,
  isEvidenceFailure,
  type BuildVerificationRecipeInput,
  type BuildVerificationRecipeResult,
  type DeclaredInput,
  type DischargedObligation,
  type EvidenceFailure,
  type EvidenceObligationKind,
  type EvidenceRefusalLayer,
  type ObligationSupport,
  type RunnerEvidenceErrorCode,
  type VerificationRecipe,
  type VerificationRecipeBody,
  type VerifierIdentity,
} from "../evidence/evidence-contract.js";
export {
  buildEvidenceReceipt,
  receiptDigestInput,
  type BuildEvidenceReceiptInput,
  type BuildEvidenceReceiptResult,
  type EvidenceReceipt,
  type EvidenceReceiptBody,
  type ReceiptTimestamps,
} from "../evidence/evidence-receipt.js";
export {
  canonicalObligations,
  type ObligationContext,
} from "../evidence/receipt-obligations.js";
export { buildVerificationRecipe, recipeSealMatches } from "../evidence/verification-recipe.js";
export {
  EXECUTION_DISPOSITIONS,
  observedExecutionRejection,
  type ExecutionDisposition,
  type ObservedOutput,
  type ObservedVerifierExecution,
} from "../evidence/verifier-execution.js";
