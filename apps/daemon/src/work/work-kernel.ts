/**
 * Frozen vocabulary for the daemon work command family (design line 992).
 *
 * This module declares names and shapes only; it holds no behaviour and no
 * mutable module-level state. Every refusal raised anywhere in `work/` is
 * built by `workFailure` here, so the reason vocabulary stays closed and a
 * handler cannot invent a local code.
 *
 * AUTHORITY LABELING — deliberately NOT the graph-preview envelope. That
 * surface is `advisoryOnly: true, authority: "NONE"` because it grants
 * nothing. `work.claim` confers real authority, so a granted result names the
 * authority it produced and a refusal carries `authority: "NONE"` with no
 * successor field present at all. Per epic rail 4, a leg whose evidence is
 * missing or unverifiable stays UNKNOWN and never gains authority: it is
 * refused, never granted with a hedged label.
 */

/** Cloned per the repo convention: no package root exports `deepFreeze`. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export const WORK_SCHEMA_VERSION = "moe-work-request/1";

export const WORK_COMMANDS = Object.freeze([
  "claim",
  "renew",
  "release",
  "resume",
  "cancel",
  "get_context",
] as const);
export type WorkCommand = (typeof WORK_COMMANDS)[number];

/**
 * The four legs of an atomic claim, in composition order. A claim publishes
 * all four successors or none of them.
 */
export const CLAIM_LEGS = Object.freeze([
  "lease",
  "providerSlot",
  "budgetReservation",
  "effectIntent",
] as const);
export type ClaimLeg = (typeof CLAIM_LEGS)[number];

/**
 * The ceiling is checked BEFORE `reserveProviderSlot`, so it is its own leg
 * rather than a `providerSlot` refusal: the scheduler does no counting and
 * would accept the fifth slot (see `work-claim.ts`).
 */
export const SLOT_CEILING_LEG = "slotCeiling";

export const WORK_LEGS = Object.freeze([...CLAIM_LEGS, SLOT_CEILING_LEG] as const);
export type WorkLeg = ClaimLeg | typeof SLOT_CEILING_LEG;

/**
 * Which boundary refused. Epic rail 6 requires a failure-path test to pin the
 * refusing layer, because more than one layer can refuse the same request and
 * a test asserting only "it refused" detaches the moment the other layer
 * starts answering first.
 */
export const WORK_LAYERS = Object.freeze(["INGRESS", "AUTHORITY"] as const);
export type WorkLayer = (typeof WORK_LAYERS)[number];

/**
 * Closed stable-reason vocabulary. `work-vocabulary.test.ts` asserts the
 * observed set equals this declared set, so an unreachable code fails the
 * suite rather than lingering as dead vocabulary.
 */
export const WORK_ERROR_CODES = Object.freeze([
  "WORK_REQUEST_INVALID",
  "WORK_PAYLOAD_MALFORMED",
  "WORK_LEASE_NOT_CURRENT",
  "WORK_STALE_TOKEN",
  "WORK_STALE_EPOCH",
  "WORK_AUTHORITY_SUPERSEDED",
  "WORK_SLOT_RESOURCE_INACTIVE",
  "WORK_SLOT_EXHAUSTED",
  "WORK_BUDGET_REFUSED",
  "WORK_INTENT_REFUSED",
  "WORK_STATE_CONFLICT",
] as const);
export type WorkErrorCode = (typeof WORK_ERROR_CODES)[number];

/** Authority conferred by a successful result; `NONE` for every refusal. */
export const WORK_AUTHORITY_LABELS = Object.freeze([
  "NONE",
  "CLAIM_GRANTED",
  "CLAIM_RENEWED",
  "CLAIM_RELEASED",
  "CLAIM_RESUMED",
  "CLAIM_CANCELLED",
] as const);
export type WorkAuthorityLabel = (typeof WORK_AUTHORITY_LABELS)[number];

export interface WorkFailure {
  readonly ok: false;
  readonly code: WorkErrorCode;
  /** `null` for an ingress refusal, which precedes any leg. */
  readonly leg: WorkLeg | null;
  readonly layer: WorkLayer;
  readonly message: string;
  /**
   * The upstream reason code this failure was derived from, preserved verbatim
   * so a caller can trace a scheduler or supervisor refusal back to its
   * origin. `null` when this boundary refused on its own authority.
   */
  readonly upstreamCode: string | null;
}

export function workFailure(
  code: WorkErrorCode,
  leg: WorkLeg | null,
  layer: WorkLayer,
  message: string,
  upstreamCode: string | null = null,
): WorkFailure {
  return deepFreeze({ code, layer, leg, message, ok: false, upstreamCode });
}

/** The four successor records a granted claim publishes together. */
export interface ClaimSuccessors {
  readonly lease: unknown;
  readonly providerSlot: unknown;
  readonly budgetReservation: unknown;
  readonly effectIntent: unknown;
}

export interface WorkInputRejected {
  readonly ok: false;
  readonly outcome: "INPUT_REJECTED";
  readonly authority: "NONE";
  /** The decoder's own result, preserved with its stable code untouched. */
  readonly error: unknown;
}

export interface WorkRefused {
  readonly ok: false;
  readonly outcome: "REQUEST_INVALID" | "WORK_REFUSED";
  readonly authority: "NONE";
  readonly failure: WorkFailure;
}

export interface WorkGranted {
  readonly ok: true;
  readonly outcome: "WORK_GRANTED";
  readonly authority: Exclude<WorkAuthorityLabel, "NONE">;
  readonly command: WorkCommand;
  readonly successors: ClaimSuccessors;
}

export interface WorkApplied {
  readonly ok: true;
  readonly outcome: "WORK_APPLIED";
  readonly authority: Exclude<WorkAuthorityLabel, "NONE">;
  readonly command: WorkCommand;
  readonly successor: unknown;
}

/** `get_context` is read-only and confers nothing, hence `authority: "NONE"`. */
export interface WorkContextView {
  readonly ok: true;
  readonly outcome: "CONTEXT_VIEW";
  readonly authority: "NONE";
  readonly command: "get_context";
  readonly view: unknown;
}

export type WorkResult =
  | WorkInputRejected
  | WorkRefused
  | WorkGranted
  | WorkApplied
  | WorkContextView;

export function inputRejected(error: unknown): WorkInputRejected {
  return Object.freeze({
    authority: "NONE",
    error: deepFreeze(error),
    ok: false,
    outcome: "INPUT_REJECTED",
  } as const);
}

/**
 * The single refusal constructor. It cannot carry a successor: the returned
 * object has no successor key at all, which is how DoD 1's "unobservable" is
 * asserted structurally rather than as a null-valued field.
 */
export function refused(
  failure: WorkFailure,
  outcome: "REQUEST_INVALID" | "WORK_REFUSED" = "WORK_REFUSED",
): WorkRefused {
  return Object.freeze({ authority: "NONE", failure, ok: false, outcome } as const);
}

export function granted(
  command: WorkCommand,
  authority: Exclude<WorkAuthorityLabel, "NONE">,
  successors: ClaimSuccessors,
): WorkGranted {
  return deepFreeze({
    authority,
    command,
    ok: true,
    outcome: "WORK_GRANTED",
    successors,
  } as const);
}

export function applied(
  command: WorkCommand,
  authority: Exclude<WorkAuthorityLabel, "NONE">,
  successor: unknown,
): WorkApplied {
  return deepFreeze({
    authority,
    command,
    ok: true,
    outcome: "WORK_APPLIED",
    successor,
  } as const);
}

export function contextView(view: unknown): WorkContextView {
  return deepFreeze({
    authority: "NONE",
    command: "get_context",
    ok: true,
    outcome: "CONTEXT_VIEW",
    view,
  } as const);
}
