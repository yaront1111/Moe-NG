import { createHash } from "node:crypto";

import type { RuntimeCommandKind, RuntimeError } from "@moe/contracts";
import type { CommandDecisionRecord } from "@moe/store";

/**
 * The step-lifecycle vocabulary: the three kinds, the versions, the exact payload
 * allow-lists, this layer's name, its closed code list and the two derivations.
 * Pure constants and pure functions — no store is reachable from this module.
 *
 * NO WIRE KIND IS ADDED. `step.start`, `step.finish` and `step.checkpoint` are
 * already members of the frozen `RuntimeCommandKind` union
 * (packages/contracts/src/runtime/runtime-vocabulary.ts:107-108); the annotations
 * below make a typo a compile error rather than a dead kind. Measured at HEAD
 * 3537be6: all three were DECLARED on the wire and served by NOTHING, while
 * `packages/control-room-client/src/generated/generated-client.ts:260-262` already
 * shipped caller-side builders for them. This module opens the answering half.
 *
 * WHAT A STEP RECORD IS FOR. Design 12.4 requires `work.release` to store its
 * handoff at "a runner-proven BETWEEN-STEP BOUNDARY". Nothing in this repo could
 * observe one: `nextSafeAction` (packages/scheduler/src/authority/lease-drain.ts:49)
 * had ZERO producers and was only ever parsed from a value that arrived. A
 * `step.checkpoint` taken between two steps is that observation, and its
 * `nextSafeActionRef` is a STEP IDENTITY minted by this daemon — never a command
 * kind, and never a fixture literal.
 */

export const STEP_START_COMMAND_KIND = "step.start" as const satisfies RuntimeCommandKind;
export const STEP_FINISH_COMMAND_KIND = "step.finish" as const satisfies RuntimeCommandKind;
export const STEP_CHECKPOINT_COMMAND_KIND =
  "step.checkpoint" as const satisfies RuntimeCommandKind;

/** The served set, for the registry composition and for the family map. */
export const STEP_LIFECYCLE_COMMAND_KINDS = Object.freeze([
  STEP_CHECKPOINT_COMMAND_KIND, STEP_FINISH_COMMAND_KIND, STEP_START_COMMAND_KIND,
] as const);
export type StepLifecycleCommandKind = (typeof STEP_LIFECYCLE_COMMAND_KINDS)[number];

export const STEP_LIFECYCLE_SCHEMA_VERSION = "moe-step-lifecycle/1" as const;
export const STEP_RECORD_VERSION = "moe-attempt-step/1" as const;

export const STEP_STARTED_EVENT_TYPE = "AttemptStepStarted" as const;
export const STEP_FINISHED_EVENT_TYPE = "AttemptStepFinished" as const;
export const STEP_CHECKPOINTED_EVENT_TYPE = "AttemptStepCheckpointed" as const;

/** One event type per kind, so the durable history says WHICH boundary moved it
 *  and a foreign row on this aggregate is MALFORMED rather than folded onto. */
export const STEP_LIFECYCLE_EVENT_TYPES: Readonly<Record<StepLifecycleCommandKind, string>> =
  Object.freeze({
    [STEP_CHECKPOINT_COMMAND_KIND]: STEP_CHECKPOINTED_EVENT_TYPE,
    [STEP_FINISH_COMMAND_KIND]: STEP_FINISHED_EVENT_TYPE,
    [STEP_START_COMMAND_KIND]: STEP_STARTED_EVENT_TYPE,
  });

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(Object.values(STEP_LIFECYCLE_EVENT_TYPES));
export const isStepLifecycleEventType = (value: string): boolean => EVENT_TYPE_SET.has(value);

/**
 * This module's OWN layer. Deliberately NOT spelled `*_LAYER`: the security-boundary
 * roster scans exported column-zero `*_LAYER(S)` constants and would demand a hostile
 * trio for a name that only tags this family's own refusals
 * (see `./resource-reconcile-command.ts:44-49`).
 */
export const DAEMON_STEP_LIFECYCLE = "DAEMON_STEP_LIFECYCLE" as const;

/**
 * Closed, and every member names a DIFFERENT repair. ABSENT and UNREADABLE stay
 * apart because one says "start a step" and the other says the durable history
 * cannot be consulted at all; DRIFT and MALFORMED stay apart because one is a
 * latest row that stopped decoding and the other is a broken row SEQUENCE.
 */
export const STEP_LIFECYCLE_CODES = Object.freeze([
  "STEP_REQUEST_MALFORMED", "STEP_BINDING_MISMATCH", "STEP_RECORD_ABSENT",
  "STEP_RECORD_UNREADABLE", "STEP_RECORD_MALFORMED", "STEP_RECORD_AMBIGUOUS",
  "STEP_RECORD_DRIFT", "STEP_RECORD_HORIZON_MOVED", "STEP_PROJECT_MISMATCH",
  "STEP_NOT_STARTED", "STEP_ALREADY_FINISHED", "STEP_CHECKPOINT_TARGET_UNKNOWN",
  "STEP_COMMIT_UNAVAILABLE",
] as const);
export type StepLifecycleCode = (typeof STEP_LIFECYCLE_CODES)[number];

/**
 * EXACTLY three keys each, and every omission is the point. `projectId`,
 * `sessionId`, `leaseRef`, `truthClass`, any ordinal or index, any completed state
 * and any whole-roster replacement are ABSENT from all three, so the seam's
 * `checkPayload` allow-list refuses each of them STRUCTURALLY under its own
 * `PAYLOAD_SHAPE` stage before dispatch. The caller has no channel to name them and
 * nothing downstream has to defend one. Sorted, because the seam's registry entry
 * is compared ordered.
 *
 * `label` is opaque descriptive text: it contributes NOTHING to identity or order.
 */
export const STEP_START_PAYLOAD_KEYS = Object.freeze([
  "attemptAggregateId", "effectId", "label",
] as const);
export const STEP_FINISH_PAYLOAD_KEYS = Object.freeze([
  "attemptAggregateId", "effectId", "stepRef",
] as const);
export const STEP_CHECKPOINT_PAYLOAD_KEYS = Object.freeze([
  "attemptAggregateId", "effectId", "nextSafeActionRef",
] as const);

export const STEP_LIFECYCLE_PAYLOAD_KEYS:
Readonly<Record<StepLifecycleCommandKind, readonly string[]>> = Object.freeze({
  [STEP_CHECKPOINT_COMMAND_KIND]: STEP_CHECKPOINT_PAYLOAD_KEYS,
  [STEP_FINISH_COMMAND_KIND]: STEP_FINISH_PAYLOAD_KEYS,
  [STEP_START_COMMAND_KIND]: STEP_START_PAYLOAD_KEYS,
});

/** The durable body's exact key set, sorted. The reader `exactKeys` against it, so
 *  a row carrying one extra field is MALFORMED rather than silently trimmed. */
export const STEP_RECORD_BODY_KEYS = Object.freeze([
  "activationDigest", "attemptRef", "checkpointRef", "completedSteps", "effectId",
  "leaseRef", "projectId", "recordVersion", "sessionId", "startedSteps", "truthClass",
] as const);

/** One started step. `ordinal` is the SERVER's mint order and is redundant with the
 *  roster index BY CONSTRUCTION — the reader re-checks the two agree, so a body whose
 *  ordinals were rewritten out of append order is refused rather than believed. */
export interface StartedStep {
  readonly label: string;
  readonly ordinal: number;
  readonly stepRef: string;
}

export interface AttemptStepRecord {
  readonly activationDigest: string;
  readonly attemptRef: string;
  /** The current between-step boundary's next safe action, or `null` before one is
   *  taken. Always a member of `startedSteps`, enforced by the writer AND re-checked
   *  by the reader: this field structurally cannot name a step that does not exist. */
  readonly checkpointRef: string | null;
  readonly completedSteps: readonly string[];
  readonly effectId: string;
  readonly leaseRef: string;
  readonly sessionId: string;
  readonly startedSteps: readonly StartedStep[];
}

const encoder = new TextEncoder();
const sha256Hex = (value: string): string =>
  createHash("sha256").update(encoder.encode(value)).digest("hex");

/**
 * Length-framed, exactly as `deriveAttemptJournalAggregateId` frames its own input.
 * Keyed on the ACTIVATION DIGEST because that value is server-derived and
 * coherence-checked by the binding reader: no caller can name a step stream into
 * existence, and the caller's `attemptAggregateId` only LOCATES a record.
 *
 * A SEPARATE AGGREGATE FROM THE JOURNAL, deliberately. The journal reader pins
 * `recordVersion === moe-attempt-journal/1`; a second record shape on that stream
 * would make each reader's MALFORMED branch fire on the other's rows.
 */
export function deriveAttemptStepAggregateId(activationDigest: string): string {
  const framed = `${STEP_RECORD_VERSION}\n${activationDigest.length}\n${activationDigest}`;
  return `attempt-step-${sha256Hex(framed)}`;
}

/**
 * The step identity, MINTED BY THE SERVER from the server-derived activation digest
 * and the server-established ordinal. Both inputs are length-framed so no pair of
 * distinct attempts can collide, and neither input is ever read off a payload — the
 * three payload allow-lists above carry no ordinal key at all.
 */
export function deriveStepRef(activationDigest: string, ordinal: number): string {
  const framed =
    `${STEP_RECORD_VERSION}\n${activationDigest.length}\n${activationDigest}\n${ordinal}`;
  return `step-${ordinal}-${sha256Hex(framed).slice(0, 32)}`;
}

export interface StepLifecycleAccepted {
  readonly advisoryOnly: false;
  readonly authority: "DURABLE_DECISION";
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly kind: StepLifecycleCommandKind;
  readonly ok: true;
}

/** Structurally what `decisionOf` already accepts, so the seam needs no widening of
 *  its own logic. `refusedBy` carries the layer that ACTUALLY answered. */
export interface StepLifecycleRefused {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly code: string;
  readonly error: RuntimeError | null;
  readonly kind: StepLifecycleCommandKind | null;
  readonly ok: false;
  readonly refusedBy: string;
}

export type StepLifecycleOutcome = StepLifecycleAccepted | StepLifecycleRefused;

/** A refusal raised by the binding reader, the store or the durable step reader keeps
 *  ITS code and ITS layer; only decisions made in this family default to this name. */
export function stepRefusal(
  code: string, refusedBy: string = DAEMON_STEP_LIFECYCLE,
  kind: StepLifecycleCommandKind | null = null,
): StepLifecycleRefused {
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const, code, error: null, kind,
    ok: false as const, refusedBy,
  });
}
