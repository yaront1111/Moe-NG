import { deepFreeze } from "../canonical.js";
import {
  dispositionRefusal,
  isMonotonicDisposition,
  parseDrainDisposition,
  upgradeDisposition,
  type DrainDisposition,
} from "../supervisor/drain-disposition.js";
import { drainRank, type DrainReason } from "../supervisor/drain-table.js";
import { exactRecord, isRef } from "../supervisor/effect-shape.js";
import {
  carriedFailure,
  isPredecessorRelease,
  isRecoveryOutcomeKind,
  isResumableClassification,
  recoveryFailure,
  type PredecessorRelease,
  type RecoveryFailure,
  type RecoveryOutcomeKind,
} from "./recovery-contract.js";

/**
 * The safe release boundary: who may overlap whom, who may resume, and how a
 * drain disposition is allowed to move after a crash.
 *
 * DoD 1 turns on the three-valued lattice being genuinely three-valued. A
 * predecessor that is proven released admits its successor; a predecessor known
 * to be ACTIVE blocks it; and a predecessor whose release cannot be established
 * ALSO blocks it, under its own code. Epic rail 4 gives unverifiable evidence no
 * authority, so an unproven boundary is refused rather than assumed — and the
 * two refusals stay distinct because "we cannot tell" and "we know it has not"
 * lead an operator to different next actions.
 *
 * There is NO CLOCK and NO RANDOMNESS in this module: no wall-clock read, no
 * random source, no elapsed-time or retry-count reasoning of any kind. Every
 * fact is caller-supplied. That absence is what makes timer-based ownership
 * theft unwritable here rather than merely untested: there is no quantity in
 * scope that grows while nothing happens.
 */
export type OverlapVerdict =
  | { readonly kind: "ADMITTED"; readonly ok: true; readonly successorRef: string }
  | { readonly kind: "BLOCKED"; readonly failure: RecoveryFailure };

export type ResumeVerdict =
  | {
      readonly kind: "ADMITTED";
      readonly ok: true;
      readonly resumeRef: string;
      readonly safeHandoff: string;
    }
  | { readonly kind: "REFUSED"; readonly failure: RecoveryFailure };

export type DrainAdvance =
  | { readonly kind: "ADVANCED"; readonly ok: true; readonly disposition: DrainDisposition }
  | { readonly kind: "REFUSED"; readonly failure: RecoveryFailure };

const OVERLAP_KEYS = ["predecessorRef", "successorRef", "predecessorRelease", "classification"] as const;
const RESUME_KEYS = ["resumeRef", "predecessorRelease", "safeHandoff", "classification"] as const;

interface OverlapRequest {
  readonly predecessorRef: string;
  readonly successorRef: string;
  readonly predecessorRelease: PredecessorRelease;
  readonly classification: RecoveryOutcomeKind;
}

interface ResumeRequest {
  readonly resumeRef: string;
  readonly predecessorRelease: PredecessorRelease;
  readonly safeHandoff: string | null;
  readonly classification: RecoveryOutcomeKind;
}

function malformed(message: string): RecoveryFailure {
  return recoveryFailure("RECOVERY_BOUNDARY_MALFORMED", "SAFE_BOUNDARY", message);
}

/**
 * The classification gate, consulted BEFORE the release lattice by both
 * admissions. Order is security-significant: QUARANTINED is returned exactly
 * when resources are still held, so its release reads ACTIVE and a lattice-first
 * implementation refuses under `RECOVERY_PREDECESSOR_ACTIVE` — leaving a test
 * that asserts only "refused" green with this gate deleted outright. Returns the
 * refusal or null so neither caller can forget to check it.
 */
function classificationRefusal(kind: RecoveryOutcomeKind): RecoveryFailure | null {
  if (isResumableClassification(kind)) return null;
  return recoveryFailure(
    "RECOVERY_CLASSIFICATION_NOT_RESUMABLE",
    "SAFE_BOUNDARY",
    `a ${kind} crash classification is outside the closed resumable set`,
  );
}

function parseOverlap(value: unknown): OverlapRequest | null {
  const parsed = exactRecord(value, OVERLAP_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["predecessorRef"]) || !isRef(parsed["successorRef"])) return null;
  if (!isPredecessorRelease(parsed["predecessorRelease"])) return null;
  if (!isRecoveryOutcomeKind(parsed["classification"])) return null;
  return parsed as unknown as OverlapRequest;
}

function parseResume(value: unknown): ResumeRequest | null {
  const parsed = exactRecord(value, RESUME_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["resumeRef"])) return null;
  if (!isPredecessorRelease(parsed["predecessorRelease"])) return null;
  if (parsed["safeHandoff"] !== null && !isRef(parsed["safeHandoff"])) return null;
  if (!isRecoveryOutcomeKind(parsed["classification"])) return null;
  return parsed as unknown as ResumeRequest;
}

/**
 * Two gates, in this order: the durable classification must be resumable, and
 * only then is `PROVEN_RELEASED` the ONLY admitting release. Both vocabularies
 * are closed, so a member added later blocks by default rather than falling
 * through to an admission. The classification is required — there is no
 * classification-free shape, because a caller able to omit it could otherwise
 * cross a boundary using nothing but its own asserted release fact.
 */
export function admitSuccessorOverlap(requestValue: unknown): OverlapVerdict {
  const request = parseOverlap(requestValue);
  if (request === null) {
    return Object.freeze({
      kind: "BLOCKED" as const,
      failure: malformed("the overlap request does not name a predecessor release the lattice declares"),
    });
  }
  const notResumable = classificationRefusal(request.classification);
  if (notResumable !== null) {
    return Object.freeze({ kind: "BLOCKED" as const, failure: notResumable });
  }
  if (request.predecessorRelease === "PROVEN_RELEASED") {
    return deepFreeze({
      kind: "ADMITTED" as const,
      ok: true as const,
      successorRef: request.successorRef,
    });
  }
  const blocked = (failure: RecoveryFailure): OverlapVerdict =>
    Object.freeze({ kind: "BLOCKED" as const, failure });
  return request.predecessorRelease === "ACTIVE"
    ? blocked(
        recoveryFailure(
          "RECOVERY_PREDECESSOR_ACTIVE",
          "SAFE_BOUNDARY",
          "the predecessor has not released its safe boundary",
        ),
      )
    : blocked(
        recoveryFailure(
          "RECOVERY_PREDECESSOR_RELEASE_UNKNOWN",
          "SAFE_BOUNDARY",
          "the predecessor release boundary cannot be established from the records",
        ),
      );
}

/**
 * A resume is admissible only from a resumable classification, across a boundary
 * that is BOTH proven released and carrying the exact handoff a successor picks
 * up. A proven release with no handoff is a boundary nobody can resume across,
 * so it refuses rather than resuming from whatever happens to be on disk.
 */
export function admitResume(requestValue: unknown): ResumeVerdict {
  const request = parseResume(requestValue);
  if (request === null) {
    return Object.freeze({
      kind: "REFUSED" as const,
      failure: malformed("the resume request does not parse"),
    });
  }
  const notResumable = classificationRefusal(request.classification);
  if (notResumable !== null) {
    return Object.freeze({ kind: "REFUSED" as const, failure: notResumable });
  }
  if (request.predecessorRelease !== "PROVEN_RELEASED" || request.safeHandoff === null) {
    return Object.freeze({
      kind: "REFUSED" as const,
      failure: recoveryFailure(
        "RECOVERY_RESUME_BOUNDARY_UNPROVEN",
        "SAFE_BOUNDARY",
        "a resume requires a proven release boundary carrying its exact safe handoff",
      ),
    });
  }
  return deepFreeze({
    kind: "ADMITTED" as const,
    ok: true as const,
    resumeRef: request.resumeRef,
    safeHandoff: request.safeHandoff,
  });
}

function refuseAdvance(failure: RecoveryFailure): DrainAdvance {
  return Object.freeze({ kind: "REFUSED" as const, failure });
}

/** The supervisor owns disposition monotonicity; this only names who asked. */
function carriedDrainRefusal(message: string): DrainAdvance {
  return refuseAdvance(carriedFailure(dispositionRefusal(message, "recovery.advanceDrain")));
}

/**
 * Folds an observed post-crash disposition into the held one.
 *
 * The recovery-layer rules are the two a crash makes possible: a record that
 * DROPPED a held reason, and a record whose stored strongest reason was WALKED
 * BACK below the held one. Both are refusals under their own codes, never a
 * silent no-op that returns the held disposition — a caller that could not tell
 * a refusal from "nothing changed" would keep the weaker record.
 *
 * The union itself is delegated to `upgradeDisposition`, which is the single
 * source of drain monotonicity; re-deriving it here would give the system two
 * answers to one question. A disposition that is internally inconsistent for any
 * other reason is refused BY THAT SOURCE, and its code and layer are carried
 * through unchanged so a reader can tell the two layers apart.
 */
export function advanceRecoveryDrain(heldValue: unknown, observedValue: unknown): DrainAdvance {
  const held = parseDrainDisposition(heldValue);
  if (held === null || !isMonotonicDisposition(held)) {
    return carriedDrainRefusal("the held drain disposition is not verifiably monotonic");
  }
  const observed = parseDrainDisposition(observedValue);
  if (observed === null) {
    return carriedDrainRefusal("the observed drain disposition does not parse");
  }
  const dropped = held.reasons.filter((reason) => !observed.reasons.includes(reason));
  if (dropped.length > 0) {
    return refuseAdvance(
      recoveryFailure(
        "RECOVERY_DRAIN_REASON_DROPPED",
        "SAFE_BOUNDARY",
        `the observed disposition no longer carries ${dropped.join(", ")}`,
      ),
    );
  }
  if (drainRank(observed.strongestReason) < drainRank(held.strongestReason)) {
    return refuseAdvance(
      recoveryFailure(
        "RECOVERY_DRAIN_DOWNGRADE_REFUSED",
        "SAFE_BOUNDARY",
        "the observed disposition walked its strongest reason back below the held one",
      ),
    );
  }
  if (!isMonotonicDisposition(observed)) {
    return carriedDrainRefusal("the observed drain disposition is weaker than its own reason set");
  }
  return foldReasons(held, observed.reasons);
}

/** Every observed reason goes through the one union, in the frozen order. */
function foldReasons(held: DrainDisposition, reasons: readonly DrainReason[]): DrainAdvance {
  let current: DrainDisposition = held;
  for (const reason of reasons) {
    const upgraded = upgradeDisposition(current, reason);
    if (upgraded.kind === "REFUSED") {
      return refuseAdvance(carriedFailure(upgraded.failure));
    }
    current = upgraded.disposition;
  }
  return deepFreeze({ kind: "ADVANCED" as const, ok: true as const, disposition: current });
}
