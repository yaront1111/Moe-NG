import { deepFreeze } from "../canonical.js";
import { DRAIN_ATTEMPT_STATES } from "./drain-table.js";
import { supervisorFailure, type SupervisorFailure } from "./effect-kernel.js";
import { applyEffectCommand } from "./effect-lifecycle.js";
import { oneOf } from "./effect-shape.js";

/**
 * The authoritative fence of design 568: "Process termination is best-effort;
 * immediate fencing is authoritative, so no post-activation business mutation is
 * accepted even while the attempt truthfully remains `DRAINING`."
 *
 * The admitted list is hand-transcribed from design 312, which enumerates what a
 * fenced attempt may still do: "runner observation, effect/resource
 * reconciliation, safe-boundary recording, budget settlement, and
 * evidence/export; no planner-authored progress, release, retry, submission, or
 * new effect is accepted."
 */
export const DRAIN_ADMITTED_COMMANDS = Object.freeze([
  "runner.observe",
  "effect.reconcile",
  "resource.reconcile",
  "attempt.checkpoint",
  "budget.settle",
  "evidence.record",
] as const);
export type DrainAdmittedCommand = (typeof DRAIN_ADMITTED_COMMANDS)[number];

export type MutationAdmission =
  | { readonly kind: "ADMITTED"; readonly ok: true; readonly command: DrainAdmittedCommand }
  | { readonly kind: "REFUSED"; readonly failure: SupervisorFailure };

/** Fails closed: an unrecognised command or attempt state is refused, never waved through. */
export function admitPostActivationMutation(
  attemptStateValue: unknown,
  commandValue: unknown,
): MutationAdmission {
  const no = (message: string): MutationAdmission =>
    Object.freeze({
      kind: "REFUSED" as const,
      failure: supervisorFailure("DRAIN_POST_ACTIVATION_MUTATION_REFUSED", "DRAIN", message, {
        state: null,
        command: "drain.admitMutation",
        leg: null,
      }),
    });
  if (!oneOf(attemptStateValue, DRAIN_ATTEMPT_STATES)) {
    return no("the attempt state is not one design 336 declares");
  }
  if (!oneOf(commandValue, DRAIN_ADMITTED_COMMANDS)) {
    return no("the fence admits only observation, reconciliation, checkpoint and settlement");
  }
  return deepFreeze({ kind: "ADMITTED" as const, ok: true as const, command: commandValue });
}

/**
 * Consumes the lifecycle's `MUST_DRAIN` arm instead of re-deriving the condition
 * that produces it. `MUST_DRAIN` is a distinct outcome kind, not a refusal, so a
 * caller matching on refusal codes would otherwise retry a cancel that actually
 * needs to drain.
 */
export function lifecycleDemandsDrain(intentValue: unknown, commandValue: unknown): boolean {
  return applyEffectCommand(intentValue, commandValue).kind === "MUST_DRAIN";
}
