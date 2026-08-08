import type { MirroredLeaseRecord } from "./effect-shape.js";

/**
 * Frozen `EffectIntent` protocol vocabularies and record shapes (design 13.1).
 *
 * Everything in this subtree is a pure reducer over caller-supplied records: no
 * clock, no randomness, no process. A timestamp is a validated input, a process
 * fact is an observation someone else made, and an activation is a decision
 * about records — never an action on the world.
 *
 * The CALLER CONTRACT this module cannot enforce is published as
 * `EFFECT_CALLER_CONTRACT` so a consumer can read it as data rather than prose.
 * The clauses are load-bearing: without them the linearization point described
 * by design 13.1 is not actually closed, no matter what these reducers return.
 */
export const SUPERVISOR_EFFECT_PROTOCOL_VERSION = "moe-effect-intent/1" as const;
export const SUPERVISOR_ACTIVATION_VERSION = "moe-effect-activation/1" as const;
export const SUPERVISOR_RESULT_VERSION = "moe-effect-result/1" as const;

export const EFFECT_CALLER_CONTRACT = Object.freeze([
  "The effect, attempt, and grant successors of one activation commit are written in ONE transaction, under compare-and-set on both the intent version and the attempt version read at revalidation.",
  "Committing an EffectTombstone MUST bump the tombstoned intent's version, so a concurrent activation's compare-and-set conflicts; without that bump the tombstone-versus-activate race stays open.",
  "Grant id uniqueness and (aggregate, idempotencyKey) uniqueness are store indexes; this pure module validates shape only and cannot detect a replayed record.",
  "The OS-exclusive launch lock is the physical duplicate-launch backstop; the activation grant is only the logical linearization token.",
] as const);

export const EFFECT_STATES = Object.freeze([
  "PENDING",
  "CLAIMED",
  "ARMED",
  "ACTIVE",
  "CANCEL_REQUESTED",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
  "CANCELLED",
] as const);
export type EffectState = (typeof EFFECT_STATES)[number];

export const TERMINAL_EFFECT_STATES = Object.freeze([
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
  "CANCELLED",
] as const);
export type TerminalEffectState = (typeof TERMINAL_EFFECT_STATES)[number];

export const EFFECT_COMMANDS = Object.freeze([
  "claim",
  "arm",
  "activate",
  "requestCancel",
  "settle",
  "consumeGrant",
] as const);
export type EffectCommand = (typeof EFFECT_COMMANDS)[number];

/** The attempt slice this task owns; the full attempt machine lives in design 336. */
export const ATTEMPT_SLICE_STATES = Object.freeze(["LAUNCH_REQUESTED", "RUNNING"] as const);
export type AttemptSliceState = (typeof ATTEMPT_SLICE_STATES)[number];

export const GRANT_STATES = Object.freeze(["UNUSED", "CONSUMED"] as const);
export type GrantState = (typeof GRANT_STATES)[number];

export const SUPERVISOR_LAYERS = Object.freeze([
  "KERNEL",
  "LIFECYCLE",
  "LEASE_MIRROR",
  "ACTIVATION",
  "GRANT",
  "LAUNCH_LOCK",
  "DRAIN",
  "RESTART",
] as const);
export type SupervisorLayer = (typeof SUPERVISOR_LAYERS)[number];

/**
 * The closed refusal vocabulary. Every code is reachable from a caller-visible
 * surface; a code no refusal can produce is a code no test can pin.
 */
export const SUPERVISOR_ERROR_CODES = Object.freeze([
  "EFFECT_INTENT_MALFORMED",
  "EFFECT_ATTEMPT_MALFORMED",
  "EFFECT_CLAIM_MALFORMED",
  "EFFECT_TOMBSTONE_MALFORMED",
  "EFFECT_GRANT_MALFORMED",
  "EFFECT_COMMAND_MALFORMED",
  "EFFECT_TRANSITION_NOT_ADMITTED",
  "EFFECT_TERMINAL_ABSORBED",
  "EFFECT_TOMBSTONE_DOES_NOT_DOMINATE",
  "EFFECT_SETTLEMENT_TARGET_NOT_ADMITTED",
  "EFFECT_SETTLEMENT_EVIDENCE_INVALID",
  "EFFECT_UNCERTAINTY_EVIDENCE_REQUIRED",
  "EFFECT_UNCERTAINTY_EVIDENCE_UNEXPECTED",
  "EFFECT_COUNTER_EXHAUSTED",
  "ACTIVATION_INTENT_NOT_ARMED",
  "ACTIVATION_LOCK_IDENTITY_MISMATCH",
  "EFFECT_TOMBSTONED",
  "ATTEMPT_BINDING_MISMATCH",
  "ATTEMPT_NOT_LAUNCH_REQUESTED",
  "ACTIVATION_GRAPH_EPOCH_MISMATCH",
  "ACTIVATION_DESIRED_STATE_MISMATCH",
  "ACTIVATION_DEPENDENCY_WITNESS_STALE",
  "PROVIDER_CAPABILITY_CHANGED",
  "ACTIVATION_COMMIT_INCOHERENT",
  "GRANT_ALREADY_CONSUMED",
  "GRANT_WRAPPER_MISMATCH",
  "LEASE_MIRROR_MALFORMED",
  "LEASE_MIRROR_STALE",
  "LEASE_MIRROR_STALE_EPOCH",
  "LEASE_MIRROR_SUPERSEDED_AUTHORITY",
  "LAUNCH_LOCK_MALFORMED",
  "LAUNCH_LOCK_CREDENTIAL_REUSED",
  "LAUNCH_LOCK_REGISTRATION_ABSENT",
  "LAUNCH_LOCK_IDENTITY_CONFLICT",
  "LAUNCH_LOCK_SUSPECT",
  "PROCESS_OBSERVATION_MALFORMED",
  "DRAIN_ROW_NOT_ADMITTED",
  "DRAIN_RESOURCE_UNRECONCILED",
  "DRAIN_DISPOSITION_NOT_MONOTONIC",
  "DRAIN_POST_ACTIVATION_MUTATION_REFUSED",
  "RESTART_RECORDS_INCOHERENT",
  "RESTART_PREMATURE_TERMINAL",
  "RESTART_SAFE_HANDOFF_ABSENT",
] as const);
export type SupervisorErrorCode = (typeof SUPERVISOR_ERROR_CODES)[number];

/**
 * Provider-neutral refusal detail. `state`/`command` name the lifecycle cell that
 * refused; `leg` names the activation check that decided. Absent facts are
 * explicit `null` — `exactOptionalPropertyTypes` is on and an absent key would
 * read as "unknown" rather than "does not apply".
 *
 * REDACTION: no detail and no message may carry a lease token or the expected
 * runtime observation digest. The scheduler redacts those deliberately and this
 * subtree must not re-leak them through a nearer error path.
 */
export interface SupervisorFailureDetail {
  readonly state: string | null;
  readonly command: string | null;
  readonly leg: string | null;
}

/** Deliberately NOT `ClaudeFailure`: the supervisor must serve other providers. */
export interface SupervisorFailure {
  readonly ok: false;
  readonly code: SupervisorErrorCode;
  readonly layer: SupervisorLayer;
  readonly message: string;
  readonly detail: SupervisorFailureDetail;
}

export function supervisorFailure(
  code: SupervisorErrorCode,
  layer: SupervisorLayer,
  message: string,
  detail: Partial<SupervisorFailureDetail> = {},
): SupervisorFailure {
  return Object.freeze({
    ok: false as const,
    code,
    layer,
    message,
    detail: Object.freeze({
      state: detail.state ?? null,
      command: detail.command ?? null,
      leg: detail.leg ?? null,
    }),
  });
}

/** Restamps an inner layer's refusal with the activation leg that consulted it. */
export function withLeg(failure: SupervisorFailure, leg: string): SupervisorFailure {
  return Object.freeze({
    ...failure,
    detail: Object.freeze({ ...failure.detail, leg }),
  });
}

/**
 * Byte-ish facts are base64 text with companion counts, never `Uint8Array`:
 * `deepFreeze` throws on a non-empty typed array and `canonicalJson` would
 * silently digest one as `{"0":n}`.
 */
export interface EffectIntent {
  readonly protocolVersion: typeof SUPERVISOR_EFFECT_PROTOCOL_VERSION;
  readonly intentId: string;
  readonly aggregateId: string;
  readonly expectedGraphEpoch: number;
  readonly leaseBinding: MirroredLeaseRecord;
  readonly inputBinding: string;
  /** Opaque predecessor cursor value; this module never orders or follows it. */
  readonly predecessorCursor: string;
  readonly desiredState: string;
  readonly idempotencyKey: string;
  readonly runtimeObservationDigest: string;
  readonly state: EffectState;
  readonly version: number;
}

export interface AttemptSlice {
  readonly attemptId: string;
  readonly aggregateId: string;
  readonly intentId: string;
  readonly state: AttemptSliceState;
  readonly version: number;
}

/** Binds the wrapper and its exclusive lock to the intent it claimed. */
export interface EffectClaim {
  readonly claimId: string;
  readonly intentId: string;
  readonly wrapperIdentity: string;
  readonly lockIdentity: string;
  readonly claimedAt: string;
}

export interface EffectTombstone {
  readonly intentId: string;
  readonly reason: string;
  readonly terminalizedAt: string;
}

export interface ActivationGrant {
  readonly grantId: string;
  readonly intentId: string;
  readonly wrapperIdentity: string;
  readonly state: GrantState;
  readonly version: number;
}

/**
 * A reference to reconciliation output, not an interpretation of it. The reducer
 * may not invent a completion, so a settlement command carries the evidence that
 * some other layer already produced.
 */
export interface SettlementEvidence {
  readonly reconciliationVersion: string;
  readonly reconciliationDigest: string;
  readonly outcomeClass: string;
}

export interface UncertaintyEvidence {
  readonly uncertaintyReason: string;
  readonly uncertaintyDigest: string;
}

export interface DependencyWitness {
  readonly witnessId: string;
  readonly expectedDigest: string;
  readonly observedDigest: string;
}

/** The stable result adopted by intent id once the effect is terminal. */
export interface EffectResult {
  readonly resultVersion: typeof SUPERVISOR_RESULT_VERSION;
  readonly intentId: string;
  readonly terminalState: TerminalEffectState;
  readonly outcomeClass: string;
  readonly settlementDigest: string;
  readonly adoptedAt: string;
}

export function isTerminalEffectState(state: string): state is TerminalEffectState {
  return (TERMINAL_EFFECT_STATES as readonly string[]).includes(state);
}
