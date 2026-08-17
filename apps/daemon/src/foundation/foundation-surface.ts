/**
 * The Foundation ingress surface: the six committed families an external canary
 * or MCP host must drive production authority with, curated in ONE place so the
 * package barrel publishes them without a deep import.
 *
 * EXPLICIT NAMED EXPORTS ONLY. Not one `export *` appears here, and that is a
 * requirement rather than a style: several producer modules re-export their own
 * codec and store helpers (`exactKeys`, `isRecord`, `sha256Hex`, `sameBytes`,
 * `textOf`, `commitPhase`, `loadDurable`, …), and a star would make the daemon's
 * public surface whatever a sibling happens to declare tomorrow. Naming every
 * symbol is what keeps an incidental helper — or a `*-test-fixtures.ts` neighbour
 * such as `goals/goal-closure-test-fixtures.ts` — off the published root.
 *
 * This module DECIDES NOTHING. It adds no authority, mints no code, and changes
 * no behavior; every symbol below is re-exported under the name its producer
 * gave it, so a refusal a consumer sees here is the producing layer's own.
 *
 * TYPE CLOSURE, and where it stops. Every branch a caller must narrow on is
 * published: each entrypoint's result union AND that union's named members. What
 * is NOT restated here are types owned by another workspace package root —
 * `@moe/coordination`'s request/result records, `@moe/runner`'s
 * `PredecessorRelease`, `@moe/store`'s `SqliteEventStore`. Those are already
 * expressible without a deep import from their own public roots, which is the
 * convention `index-surface.test.ts` established for `@moe/runner` and
 * `@moe/scheduler`; copying them would create a second vocabulary that drifts.
 */

// 1 REVIEW. `REVIEW_HANDLERS` is deliberately absent: the barrel already
// publishes the handler table, and re-exporting it here would be a duplicate
// binding at the root. `runReviewCommand` is the executable it was missing.
export { runReviewCommand } from "../review/review-services.js";
export { readReviewLedger } from "../review/review-read-model.js";
export type {
  AcceptanceRecord, DeltaRecord,
} from "../review/review-read-model.js";
export {
  DELTA_CLASSIFICATIONS, REVIEW_COMMAND_KINDS, REVIEW_INGRESS_REFUSAL_CODES,
  REVIEW_PREREQUISITE_REFUSAL_CODES, REVIEW_REFUSED_BY, REVIEW_REQUEST_KEYS,
  REVIEW_SCHEMA_VERSION, decodeReviewRequestBytes,
} from "../review/review-contracts.js";

// 2 RECOVERY. Restart reconciliation plus the continuation command that consumes
// its evidence. Both command kinds are published so a caller can find the durable
// rows without restating a literal that would then drift.
export {
  RESTART_RECONCILIATION_COMMAND_KIND, RESTART_RECONCILIATION_SCHEMA_VERSION,
  RESTART_RECORD_CLASSIFICATIONS, readReconciliationRecords, reconcileOnRestart,
  type InFlightAttempt, type ReconciliationRecord, type RestartReconciliationRequest,
  type RestartReconciliationResult, type RestartRecordClassification, type RestartTruthClass,
} from "../recovery/restart-reconciliation.js";
export {
  CONTINUATION_COMMAND_KIND, CONTINUATION_PAYLOAD_KEYS, runContinuationCommand,
  type ContinuationCommandInput, type ContinuationCommandOutcome,
} from "../recovery/continuation-command.js";

// 3 ATTEMPT. The durable Claude attempt dispatch service and its read model.
// `FoundationAttemptOutcome` is the union both the dispatch and the read answer
// with, so its two members ship beside it or a caller cannot narrow either one.
export {
  createFoundationAttemptService, readFoundationAttemptRecord,
  type FoundationAttemptDeps, type FoundationAttemptOutcome,
  type FoundationAttemptRecordAnswer,
} from "../work/foundation-attempt-service.js";
export {
  DAEMON_FOUNDATION_ATTEMPT, FOUNDATION_ATTEMPT_CODES, FOUNDATION_ATTEMPT_RECORD_VERSION,
  FOUNDATION_ATTEMPT_REQUEST_KEYS, FOUNDATION_ATTEMPT_SCHEMA_VERSION,
  FOUNDATION_DISPATCH_COMMAND_KIND, FOUNDATION_RESERVATION_VERSION,
  RUNNER_WORKSPACE_LAYER, SCHEDULER_GRAPH_LAYER,
  type FoundationAttemptBinding, type FoundationAttemptCode,
  type FoundationAttemptDispatchRequest, type FoundationAttemptLaunchTemplate,
  type FoundationAttemptRefused,
} from "../work/foundation-attempt-contracts.js";

// 4 VERIFICATION. The durable verification receipt service and its read model.
// The refusal union is SOURCE-tagged across five producers, so publishing the
// verdict list without `FoundationVerificationRefusalSource` would leave a caller
// unable to tell which layer refused — exactly the attribution rail 4 requires.
export {
  createFoundationVerificationService, deriveRecipeAggregateId, deriveVerificationAggregateId,
  type FoundationVerificationAnswer, type FoundationVerificationDeps,
} from "../evidence/foundation-verification-service.js";
export {
  FOUNDATION_VERIFICATION_CODES, FOUNDATION_VERIFICATION_COMMAND_KIND,
  FOUNDATION_VERIFICATION_LAYERS, FOUNDATION_VERIFICATION_RECEIPT_VERSION,
  FOUNDATION_VERIFICATION_RECIPE_VERSION, FOUNDATION_VERIFICATION_REFUSAL_SOURCES,
  FOUNDATION_VERIFICATION_REQUEST_KEYS, FOUNDATION_VERIFICATION_SCHEMA_VERSION,
  FOUNDATION_VERIFICATION_VERDICTS,
  type FoundationRecipeOutcome, type FoundationRecipeRegistration,
  type FoundationVerificationCode, type FoundationVerificationLayer,
  type FoundationVerificationOutcome, type FoundationVerificationRefusalSource,
  type FoundationVerificationRefused, type FoundationVerificationRequest,
  type FoundationVerificationVerdict,
} from "../evidence/foundation-verification-contracts.js";

// 5 CLOSURE. Review-qualified goal closure. The refusal carries a code from the
// prerequisite vocabulary and a fixed layer, and two of those codes are raised by
// more than one guard — so the code list and the layer are both published.
export {
  GOAL_CLOSURE_WITNESS_VERSION, qualifyGoalClosure,
  type GoalClosureQualification, type GoalClosureQualified, type GoalClosureRefused,
} from "../goals/goal-qualification.js";
export {
  GOAL_PREREQUISITE_LAYER, GOAL_PREREQUISITE_REFUSAL_CODES,
  type GoalPrerequisiteRefusalCode,
} from "../goals/goal-close-prerequisite.js";

// 6 COORDINATION. The daemon's coordination authority adapter and its eight
// operations. `CoordinationAdapter` names them all; the per-operation request and
// result records are `@moe/coordination`'s own published vocabulary.
export {
  coordinationPresentationDigest, createCoordinationAdapter,
  type CoordinationAdapter, type CoordinationAdapterOptions,
  type CoordinationAuthRefused, type CoordinationPresentationFields,
} from "../coordination/coordination-adapter.js";
