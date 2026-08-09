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
 *
 * The verifier process wrapper is the one name here that performs an external
 * effect, so its seam is wider on purpose. `runVerifierProcess` needs a
 * `ProcessLauncher`, and `createNodeProcessLauncher` is the only production one,
 * so publishing the function without the factory would publish something no
 * consumer could call. `hermeticVerifierEnvironment` is exported because the
 * daemon owns the base environment and must be able to see exactly what its
 * child will inherit before handing it over. The code and layer lists ship as
 * values because a consumer routing on a refusal needs the closed vocabulary,
 * not a type it can only read at compile time, and `MAX_VERIFIER_OUTPUT_BYTES`
 * because a truncated capture is only interpretable against its bound. The type
 * closure — down to `VerifierStreamCapture`, `VerifierClock` and
 * `LaunchedProcess` — is complete so a consumer can narrow a result and supply
 * a launcher and clock without redeclaring a single shape.
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
export {
  MAX_VERIFIER_OUTPUT_BYTES,
  MAX_VERIFIER_RUN_MS,
  VERIFIER_PROCESS_ERROR_CODES,
  VERIFIER_PROCESS_LAYERS,
  VERIFIER_REAP_GRACE_MS,
  hermeticVerifierEnvironment,
  type VerifierActivation,
  type VerifierCapture,
  type VerifierClock,
  type VerifierProcessErrorCode,
  type VerifierProcessFailure,
  type VerifierProcessLayer,
  type VerifierProcessRefusal,
  type VerifierStreamCapture,
} from "../evidence/verifier-process-contract.js";
export {
  createNodeProcessLauncher,
  runVerifierProcess,
  type LaunchedProcess,
  type ProcessLauncher,
  type RunVerifierProcessInput,
  type RunVerifierProcessOk,
  type RunVerifierProcessRefused,
  type RunVerifierProcessResult,
  type VerifierExitObservation,
  type VerifierLaunchSpec,
} from "../evidence/verifier-process.js";
