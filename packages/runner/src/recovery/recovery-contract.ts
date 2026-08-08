import { isDigest, isRef, oneOf } from "../supervisor/effect-shape.js";
import type { SupervisorErrorCode, SupervisorFailure, SupervisorLayer } from "../supervisor/effect-kernel.js";
import type { ClaudeProcessExit } from "../providers/claude/claude-cancel-reconcile.js";

/**
 * The closed crash-recovery vocabulary, as frozen data.
 *
 * Everything this subtree decides is a decision about RECORDS plus one
 * caller-supplied OBSERVATION. There is no clock, no randomness and no process
 * here: a crash is by definition something you learn about afterwards, so the
 * only honest inputs are what somebody durably wrote and what somebody else
 * observed. That absence is load-bearing — without a clock, "it has been quiet
 * for a while, so I may take over" is not expressible, which is how DoD 3's
 * timer-based ownership theft stays unwritable rather than merely untested.
 *
 * `RECOVERY_OUTCOME_KINDS` has FIVE members and deliberately no `RESUMED` arm.
 * "Nothing silently resumes" is enforced by the vocabulary rather than by a
 * check, because a check can be bypassed by a new branch and a missing arm
 * cannot be returned at all.
 */
export const RECOVERY_CONTRACT_VERSION = "moe-crash-recovery/1" as const;

export const RECOVERY_OUTCOME_KINDS = Object.freeze([
  "ADOPTED",
  "ABSENT",
  "SUSPECT",
  "QUARANTINED",
  "RECONCILIATION_COMMAND",
] as const);
export type RecoveryOutcomeKind = (typeof RECOVERY_OUTCOME_KINDS)[number];

/** Which surface answered. Delegated refusals keep the supervisor's own layer. */
export const RECOVERY_LAYERS = Object.freeze(["SAFE_BOUNDARY", "CLASSIFICATION"] as const);
export type RecoveryLayer = (typeof RECOVERY_LAYERS)[number];

/**
 * Closed refusal vocabulary. `RECOVERY_PREDECESSOR_ACTIVE` and
 * `RECOVERY_PREDECESSOR_RELEASE_UNKNOWN` are separate on purpose: "we know it
 * has not released" and "we cannot tell whether it released" are different
 * facts, and collapsing them would let an operator read an unverifiable
 * boundary as a verified one.
 */
export const RECOVERY_ERROR_CODES = Object.freeze([
  "RECOVERY_BOUNDARY_MALFORMED",
  "RECOVERY_PREDECESSOR_ACTIVE",
  "RECOVERY_PREDECESSOR_RELEASE_UNKNOWN",
  "RECOVERY_RESUME_BOUNDARY_UNPROVEN",
  "RECOVERY_DRAIN_REASON_DROPPED",
  "RECOVERY_DRAIN_DOWNGRADE_REFUSED",
  "RECOVERY_OBSERVATION_MALFORMED",
  "RECOVERY_STALE_OBSERVATION_REFUSED",
  "RECOVERY_OWNERSHIP_TRANSFER_UNPROVEN",
] as const);
export type RecoveryErrorCode = (typeof RECOVERY_ERROR_CODES)[number];

/**
 * The predecessor's safe release boundary, as a three-valued lattice. String
 * identical to the supervisor's `RESOURCE_FACTS` so the two vocabularies can be
 * drift-checked against each other, but a distinct type: a resource fact
 * describes one held resource, while this describes whether a predecessor's
 * whole boundary was proven.
 */
export const PREDECESSOR_RELEASES = Object.freeze([
  "PROVEN_RELEASED",
  "ACTIVE",
  "UNKNOWN",
] as const);
export type PredecessorRelease = (typeof PREDECESSOR_RELEASES)[number];

/**
 * A caller-supplied classification of the external effect. `UNESTABLISHED` is a
 * first-class member and never collapses into `PROVEN_ABSENT`: epic rail 4
 * leaves unverifiable evidence with no authority, so an effect nobody could
 * establish is SUSPECT rather than optimistically adopted.
 */
export const RECOVERY_EFFECT_STATUSES = Object.freeze([
  "PROVEN_ABSENT",
  "PROVEN_ACTIVE",
  "UNESTABLISHED",
] as const);
export type RecoveryEffectStatus = (typeof RECOVERY_EFFECT_STATUSES)[number];

/**
 * What somebody observed after the crash, and nothing else.
 *
 * `presenceLooksLive` is deliberately named for what it is — an appearance, not
 * a proof. It can never advance authority on its own; only an epoch or token
 * advance carried by the durable lease records can.
 *
 * `journalDigest` and `reviewPackageDigest` are OPAQUE content-addressed
 * references to records owned by other modules. This subtree validates their
 * shape and carries them; it never interprets their contents, so no seam is
 * invented here that those modules would later have to undo.
 */
export interface CrashObservation {
  readonly effectRef: string;
  readonly processExit: ClaudeProcessExit;
  readonly effectStatus: RecoveryEffectStatus;
  readonly observedEpoch: number;
  readonly presenceLooksLive: boolean;
  readonly journalDigest: string | null;
  readonly reviewPackageDigest: string | null;
}

export const CRASH_OBSERVATION_KEYS = [
  "effectRef",
  "processExit",
  "effectStatus",
  "observedEpoch",
  "presenceLooksLive",
  "journalDigest",
  "reviewPackageDigest",
] as const;

/**
 * A refusal that names both the code and the surface that produced it. The
 * union types are the point: a refusal delegated to the supervisor keeps the
 * supervisor's own code AND its own layer, so a test can pin which of two
 * layers answered rather than merely that something said no.
 */
export interface RecoveryFailure {
  readonly ok: false;
  readonly code: RecoveryErrorCode | SupervisorErrorCode;
  readonly layer: RecoveryLayer | SupervisorLayer;
  readonly message: string;
}

export function recoveryFailure(
  code: RecoveryErrorCode,
  layer: RecoveryLayer,
  message: string,
): RecoveryFailure {
  return Object.freeze({ ok: false as const, code, layer, message });
}

/**
 * Carries a supervisor refusal through unchanged. Restamping the layer here
 * would erase the evidence of who actually refused, which is exactly what epic
 * rail 6 asks a test to be able to distinguish.
 */
export function carriedFailure(failure: SupervisorFailure): RecoveryFailure {
  return Object.freeze({
    ok: false as const,
    code: failure.code,
    layer: failure.layer,
    message: failure.message,
  });
}

/** Opaque effect identity: shape only, never dereferenced by this subtree. */
export function isEffectRef(value: unknown): value is string {
  return isRef(value);
}

/** Opaque 64-hex content address for a journal record owned elsewhere. */
export function isJournalDigest(value: unknown): value is string {
  return isDigest(value);
}

/** Opaque 64-hex content address for a review package owned elsewhere. */
export function isReviewPackageDigest(value: unknown): value is string {
  return isDigest(value);
}

export function isPredecessorRelease(value: unknown): value is PredecessorRelease {
  return oneOf(value, PREDECESSOR_RELEASES);
}

export function isRecoveryEffectStatus(value: unknown): value is RecoveryEffectStatus {
  return oneOf(value, RECOVERY_EFFECT_STATUSES);
}
