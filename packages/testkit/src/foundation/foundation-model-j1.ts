/**
 * DEVELOPMENT_ONLY / NOT_CONFIRMATORY held-out reference model for journey J1
 * ("small Tuesday bug", design section 18.2).
 *
 * This is an executable specification of the linear happy path, NOT the
 * production runtime and NOT confirmatory evidence. It is held out: it lives in
 * the testkit, no production module may import it, and it adds no dependency
 * beyond `@moe/contracts`. Landed reducers reach it only through ports injected
 * by the fault tests, so this file can never widen the production surface.
 *
 * The model exists to make one defect class unrepresentable: a J1 specification
 * that a no-op attempt can satisfy IS the false-green defect. It therefore
 * anchors CORE-I4 (proof before acceptance), CORE-I14 (agent text cannot
 * satisfy a gate) and CORE-S1 by refusing, not by scoring.
 */

import type { RuntimeCommandKind, RuntimeTruthClass } from "@moe/contracts";

export const J1_MODEL_KIND = "DEVELOPMENT_ONLY/NOT_CONFIRMATORY" as const;

/**
 * Design 18.2 fixes the per-goal happy path at exactly three human actions.
 * The first two are runtime command kinds; the third is the final acceptance
 * decision, which has no landed command kind of its own yet.
 */
export const J1_GOAL_COMMAND: RuntimeCommandKind = "goal.create";
export const J1_APPROVAL_COMMAND: RuntimeCommandKind = "graph.approve";
export const J1_ACCEPTANCE_ACTION = "acceptance.final" as const;

export type J1HumanAction =
  | typeof J1_GOAL_COMMAND
  | typeof J1_APPROVAL_COMMAND
  | typeof J1_ACCEPTANCE_ACTION;

export const J1_REQUIRED_HUMAN_ACTIONS: readonly J1HumanAction[] = Object.freeze([
  J1_GOAL_COMMAND,
  J1_APPROVAL_COMMAND,
  J1_ACCEPTANCE_ACTION,
]);

/** Truth classes that may close a gate. Agent narration is deliberately absent. */
const GATING_TRUTH_CLASSES: readonly RuntimeTruthClass[] = Object.freeze([
  "DAEMON_VERIFIED",
  "HUMAN_APPROVED",
  "OBSERVED",
]);

export interface J1WorkReceipt {
  readonly receiptRef: string;
  readonly truthClass: RuntimeTruthClass;
}

/** One execution attempt as the control plane observed it, never as it narrated it. */
export interface J1AttemptTrace {
  /** The agent's own green self-claim. Recorded, never trusted. */
  readonly agentClaimsGreen: boolean;
  readonly artifactRefs: readonly string[];
  readonly attemptRef: string;
  readonly changedPaths: readonly string[];
  readonly receipts: readonly J1WorkReceipt[];
}

export interface J1Trace {
  readonly acceptanceProofRef: string | null;
  readonly attempt: J1AttemptTrace;
  readonly humanActions: readonly J1HumanAction[];
}

export const J1_REFUSALS = Object.freeze([
  "J1_ACCEPTANCE_WITHOUT_PROOF",
  "J1_AGENT_TEXT_AS_GATE",
  "J1_HUMAN_ACTIONS_NOT_EXACTLY_THREE",
  "J1_ZERO_WORK_FALSE_GREEN",
] as const);

export type J1Refusal = (typeof J1_REFUSALS)[number];

export type J1Verdict =
  | { readonly acceptedRef: string; readonly ok: true }
  | { readonly ok: false; readonly refusal: J1Refusal };

function refuse(refusal: J1Refusal): J1Verdict {
  return Object.freeze({ ok: false as const, refusal });
}

/**
 * True when the attempt produced nothing an independent party could inspect:
 * no changed path, no artifact, no receipt. A green self-claim over that state
 * is the zero-work false green.
 */
export function isZeroWorkAttempt(attempt: J1AttemptTrace): boolean {
  return attempt.changedPaths.length === 0
    && attempt.artifactRefs.length === 0
    && attempt.receipts.length === 0;
}

/** A receipt only closes a gate when something other than the agent observed it. */
export function hasGatingReceipt(attempt: J1AttemptTrace): boolean {
  return attempt.receipts.some((receipt) => GATING_TRUTH_CLASSES.includes(receipt.truthClass));
}

function humanActionsExact(actions: readonly J1HumanAction[]): boolean {
  return actions.length === J1_REQUIRED_HUMAN_ACTIONS.length
    && J1_REQUIRED_HUMAN_ACTIONS.every((required, index) => actions[index] === required);
}

/**
 * Evaluate one J1 journey trace.
 *
 * Refusal order is part of the specification: the zero-work check runs first so
 * that a no-op trace is named as a false green rather than being absorbed by a
 * downstream missing-proof complaint.
 */
export function evaluateJ1Journey(trace: J1Trace): J1Verdict {
  if (isZeroWorkAttempt(trace.attempt)) {
    return refuse("J1_ZERO_WORK_FALSE_GREEN");
  }
  if (!humanActionsExact(trace.humanActions)) {
    return refuse("J1_HUMAN_ACTIONS_NOT_EXACTLY_THREE");
  }
  if (!hasGatingReceipt(trace.attempt)) {
    return refuse("J1_AGENT_TEXT_AS_GATE");
  }
  if (trace.acceptanceProofRef === null) {
    return refuse("J1_ACCEPTANCE_WITHOUT_PROOF");
  }
  return Object.freeze({ acceptedRef: trace.acceptanceProofRef, ok: true as const });
}

/**
 * The linear command sequence J1 must be able to drive through landed
 * reducers. Consumed by the fault tests, which supply the reducers; this module
 * never imports them. Every member is a member of the landed runtime command
 * vocabulary, so the type annotation is itself an assertion.
 */
export const J1_LINEAR_COMMAND_SEQUENCE: readonly RuntimeCommandKind[] = Object.freeze([
  "project.register",
  "project.activate",
  "goal.create",
  "plan.propose",
  "graph.approve",
]);

/**
 * `goal.activate_initial_graph` is a landed GOAL aggregate command that is NOT
 * a member of `RUNTIME_COMMAND_KINDS`. It is recorded here as a plain string
 * rather than smuggled into the sequence above, because typing it as a runtime
 * command kind would be a false claim about the landed vocabulary.
 */
export const J1_AGGREGATE_ONLY_ACTIVATION = "goal.activate_initial_graph" as const;
