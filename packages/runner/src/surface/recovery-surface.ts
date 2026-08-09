/**
 * The crash-recovery seam, curated rather than blanket re-exported.
 *
 * A consumer holding only these names can classify a crash, admit or refuse a
 * successor overlap and a resume, and advance a drain disposition. The refusal
 * factories (`recoveryFailure`, `carriedFailure`) and the shape guards stay
 * internal: a consumer READS refusals, it never mints them, and a published
 * factory would let a caller manufacture a refusal that no layer actually made.
 *
 * The three supervisor names at the bottom are not scope creep — they are the
 * type closure of what this seam returns. `CrashClassification`'s ADOPTED and
 * SUSPECT arms carry a `RestartPostState`, and `DrainAdvance`'s ADVANCED arm
 * carries a `DrainDisposition` whose fields are drain-table vocabulary. Without
 * them a consumer can hold the verdict but cannot name what is inside it.
 *
 * `recovery-test-fixtures.ts` is never published.
 */
export { classifyCrash, type CrashClassification } from "../recovery/crash-classification.js";
export {
  PREDECESSOR_RELEASES,
  RECOVERY_CONTRACT_VERSION,
  RECOVERY_EFFECT_STATUSES,
  RECOVERY_ERROR_CODES,
  RECOVERY_LAYERS,
  RECOVERY_OUTCOME_KINDS,
  type CrashObservation,
  type PredecessorRelease,
  type RecoveryEffectStatus,
  type RecoveryErrorCode,
  type RecoveryFailure,
  type RecoveryLayer,
  type RecoveryOutcomeKind,
} from "../recovery/recovery-contract.js";
export {
  admitResume,
  admitSuccessorOverlap,
  advanceRecoveryDrain,
  type DrainAdvance,
  type OverlapVerdict,
  type ResumeVerdict,
} from "../recovery/safe-boundary.js";

export { type DrainDisposition } from "../supervisor/drain-disposition.js";
export {
  DRAIN_REASONS,
  DRAIN_TERMINAL_TARGETS,
  type DrainReason,
  type DrainTerminalTarget,
} from "../supervisor/drain-table.js";
export {
  RESTART_POST_STATES,
  type RestartPostState,
} from "../supervisor/restart-reconstruction.js";
