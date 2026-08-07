/**
 * DEVELOPMENT_ONLY / NOT_CONFIRMATORY held-out reference models for journeys J3
 * (crash recovery) and J4 (rejection and re-plan), design section 18.2.
 *
 * Pure data and pure functions over `@moe/contracts` vocabularies. No landed
 * reducer, store, or scheduler is imported here; the fault tests inject those.
 * These models describe what an honest restart and an honest re-plan look like,
 * so a run that silently edits history or approves a delta with no changed hash
 * is refused by name rather than scored.
 */

import type { RuntimeTruthClass } from "@moe/contracts";

export const J3J4_MODEL_KIND = "DEVELOPMENT_ONLY/NOT_CONFIRMATORY" as const;

// --- J3: crash recovery (design 18.2 "kill at declared boundaries") ---

/**
 * The declared boundaries this model covers. They are the subset of the design
 * 18.3 fault catalogue that the landed durable-store surface can actually be
 * killed at today; the wider catalogue stays out rather than being claimed.
 */
export const J3_CRASH_BOUNDARIES = Object.freeze([
  "TRANSACTION_BEGIN",
  "TRANSACTION_WRITE",
  "TRANSACTION_COMMIT",
  "EFFECT_ACK",
] as const);

export type J3CrashBoundary = (typeof J3_CRASH_BOUNDARIES)[number];

export const J3_RESTART_CLASSES = Object.freeze([
  "ADOPTED",
  "QUARANTINED",
  "RECONCILIATION",
  "SUSPECT",
] as const);

export type J3RestartClass = (typeof J3_RESTART_CLASSES)[number];

export interface J3RestartRecord {
  readonly acknowledged: boolean;
  readonly boundary: J3CrashBoundary;
  /** The durable ledger shows the whole commit after restart. */
  readonly durableCommitObserved: boolean;
  /** An out-of-process effect may have run; storage cannot say. */
  readonly externalEffectUnknown: boolean;
  readonly truthClass: RuntimeTruthClass;
}

/**
 * Classify one restart record. Whole-or-none durability is the pivot: an
 * unobserved commit is never adopted, and an unknown external effect is never
 * quietly adopted either — it goes to reconciliation with its UNKNOWN intact.
 */
export function classifyRestartRecord(record: J3RestartRecord): J3RestartClass {
  if (record.externalEffectUnknown) {
    return record.durableCommitObserved ? "RECONCILIATION" : "QUARANTINED";
  }
  if (!record.durableCommitObserved) {
    return "QUARANTINED";
  }
  if (!record.acknowledged || record.truthClass === "UNKNOWN") {
    return "SUSPECT";
  }
  return "ADOPTED";
}

export interface J3Continuation {
  /** Refs the continuation binds to, proving it is new work and not a rewrite. */
  readonly bindingRef: string | null;
  /** True when the continuation mutates any already-durable record. */
  readonly editsHistory: boolean;
  /** The safe actions the operator is offered after restart. */
  readonly safeActions: readonly string[];
}

export const J3_REFUSALS = Object.freeze([
  "J3_CONTINUATION_NOT_SINGLE_SAFE_ACTION",
  "J3_CONTINUATION_WITHOUT_BINDING",
  "J3_HISTORY_EDITED",
] as const);

export type J3Refusal = (typeof J3_REFUSALS)[number];

export type J3Verdict =
  | { readonly bindingRef: string; readonly ok: true }
  | { readonly ok: false; readonly refusal: J3Refusal };

/**
 * Healthy continuation is exactly one safe action that creates a traceable
 * binding and never edits history (design 18.2 J3).
 */
export function evaluateJ3Continuation(continuation: J3Continuation): J3Verdict {
  if (continuation.editsHistory) {
    return Object.freeze({ ok: false as const, refusal: "J3_HISTORY_EDITED" as const });
  }
  if (continuation.safeActions.length !== 1) {
    return Object.freeze({
      ok: false as const,
      refusal: "J3_CONTINUATION_NOT_SINGLE_SAFE_ACTION" as const,
    });
  }
  if (continuation.bindingRef === null) {
    return Object.freeze({
      ok: false as const,
      refusal: "J3_CONTINUATION_WITHOUT_BINDING" as const,
    });
  }
  return Object.freeze({ bindingRef: continuation.bindingRef, ok: true as const });
}

// --- J4: rejection and re-plan (design 18.2) ---

/** The visible counter from design 18.2; escalation must be explicit past it. */
export const J4_MAX_ROUNDS = 3 as const;

export interface J4Finding {
  readonly evidenceRef: string | null;
  readonly findingRef: string;
  readonly requiredChangeRef: string;
}

export interface J4DeltaApproval {
  readonly carryForwardNodeRefs: readonly string[];
  readonly changedHashes: readonly string[];
  readonly invalidatedNodeRefs: readonly string[];
}

export interface J4ReplanRound {
  readonly delta: J4DeltaApproval;
  readonly escalated: boolean;
  readonly findings: readonly J4Finding[];
  /** Every prior plan, attempt, receipt and review must still be readable. */
  readonly readableHistoryRefs: readonly string[];
  readonly round: number;
}

export const J4_REFUSALS = Object.freeze([
  "J4_DELTA_WITHOUT_CHANGED_HASHES",
  "J4_FINDING_WITHOUT_EVIDENCE",
  "J4_HISTORY_UNREADABLE",
  "J4_NODE_BOTH_INVALIDATED_AND_CARRIED",
  "J4_ROUND_LIMIT_WITHOUT_ESCALATION",
] as const);

export type J4Refusal = (typeof J4_REFUSALS)[number];

export type J4Verdict =
  | { readonly ok: true; readonly roundsRemaining: number }
  | { readonly ok: false; readonly refusal: J4Refusal };

function j4Refuse(refusal: J4Refusal): J4Verdict {
  return Object.freeze({ ok: false as const, refusal });
}

/**
 * Evaluate one re-plan round. Every refusal names a design 18.2 obligation:
 * findings link evidence, delta approval shows changed hashes and disjoint
 * invalidated/carry-forward sets, the round counter is visible, escalation past
 * it is explicit, and old artifacts stay readable.
 */
export function evaluateJ4Round(round: J4ReplanRound): J4Verdict {
  if (round.findings.length === 0 || round.findings.some((f) => f.evidenceRef === null)) {
    return j4Refuse("J4_FINDING_WITHOUT_EVIDENCE");
  }
  if (round.delta.changedHashes.length === 0) {
    return j4Refuse("J4_DELTA_WITHOUT_CHANGED_HASHES");
  }
  const carried = new Set(round.delta.carryForwardNodeRefs);
  if (round.delta.invalidatedNodeRefs.some((ref) => carried.has(ref))) {
    return j4Refuse("J4_NODE_BOTH_INVALIDATED_AND_CARRIED");
  }
  if (round.readableHistoryRefs.length === 0) {
    return j4Refuse("J4_HISTORY_UNREADABLE");
  }
  if (round.round > J4_MAX_ROUNDS && !round.escalated) {
    return j4Refuse("J4_ROUND_LIMIT_WITHOUT_ESCALATION");
  }
  return Object.freeze({
    ok: true as const,
    roundsRemaining: Math.max(0, J4_MAX_ROUNDS - round.round),
  });
}
