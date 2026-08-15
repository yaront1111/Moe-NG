import { createEffortCollector } from "../performance/effort-collector.js";
import {
  EFFORT_COLLECTOR_LAYER,
  UNATTRIBUTED,
  effortRefusal,
} from "../performance/effort-records.js";
import type {
  BaselineDecisionKind,
  EffortRecord,
  EffortRefusal,
} from "../performance/effort-records.js";
import type { RecordedDecision } from "../performance/effort-collector.js";

/**
 * The live dispatch path's effort edge — the symmetric seam to `live-event-feed.ts`.
 *
 * That module wired `wire-timing.ts` into the live POLL path; this one wires
 * `effort-collector.ts` into the live DISPATCH path, and it inherits the same
 * discipline: SHAPING ONLY, NEVER INFERENCE. An identity the dispatch seam did not
 * state is recorded as {@link UNATTRIBUTED} rather than guessed at from the most recent
 * command; nothing is derived by subtraction; and an observation this build cannot
 * obtain is refused with a stable code from the effort vocabulary rather than dropped,
 * because a dropped observation looks exactly like a human who did nothing.
 *
 * ONE ADMISSION DOOR. The demanded decision word is handed to `shapeEffortObservation`
 * verbatim and membership is judged there. This module deliberately does NOT pre-filter
 * it: a second admission path is how two callers start disagreeing about what a missing
 * source means, and it would also move the refusal out of the guard the live test is
 * written to hold.
 *
 * WHAT IS NOT RECORDED HERE, AND WHY. Focus/away intervals and recovery burdens are part
 * of this vocabulary, but a dispatch offers no observed moment for either: the seam sees
 * one instant, not the opening and closing of an operator's attention, and the daemon's
 * answer is evidence about the daemon rather than about what a human then had to do.
 * Synthesising them from the dispatch outcome would be inference wearing the costume of
 * bookkeeping — the exact failure `effort-records.ts` rule 1 and task rail 3 forbid — so
 * they are left to a surface that can actually watch them.
 *
 * OBSERVATIONAL ONLY. Nothing here scores, totals or judges, and a recording failure may
 * never fail the dispatch it observed.
 */

/**
 * What each dispatchable command demands of the human, typed to the imported vocabulary
 * so a drifted word cannot land silently. The words themselves belong to
 * `effort-records.ts`; this table only says which command demands which.
 */
const NAMEABLE_DEMANDS: Readonly<Record<string, BaselineDecisionKind>> = Object.freeze({
  "approval.decide": "APPROVE",
  "goal.create": "CREATE",
  "integration.accept_output": "ACCEPT",
  "plan.approve": "APPROVE",
  "planning.create_draft": "CREATE",
  "project.register": "CREATE",
});

/**
 * Commands that demand a decision this vocabulary cannot name. `review.submit` really
 * does demand one of the operator, and the effort domain can name only accept, approve
 * and create — so the word observed is stated as it was observed and admission refuses
 * it. Folding SUBMIT into APPROVE here would put our guess where their answer belongs,
 * and would make two different demands indistinguishable at every later consumer.
 */
const UNNAMEABLE_DEMANDS: Readonly<Record<string, string>> = Object.freeze({
  "review.submit": "SUBMIT",
});

/** Commands the board offers that demand no decision: dispatching one is a free act. */
const FREE_INTERACTION_COMMANDS: readonly string[] = Object.freeze([
  "policy.install",
  "policy.validate",
  "provider.probe",
  "session.close",
  "session.open",
  "session.renew",
]);

/** What the control room watched: an operator handing a board card back to the daemon. */
const DISPATCH_EVIDENCE = "AFFORDANCE_DISPATCHED";

/** A refusal, kept with the identities it was refused for, so a consumer can say which. */
export interface LiveEffortRefusal {
  readonly commandId: string;
  readonly commandKind: string;
  readonly refusal: EffortRefusal;
}

export interface DispatchEffortInput {
  /** The daemon's own offer, untouched. Its `commandId` is the only attribution used. */
  readonly affordance: Readonly<Record<string, unknown>>;
  readonly aggregateId: string | null;
  readonly commandKind: string;
}

/**
 * One live attachment is one operator's session — `live-app.tsx` states that the live
 * attachment is a single daemon workspace — so the account of what that operator had to
 * do is held once, here, rather than rebuilt per render and lost on every repaint.
 */
const collector = createEffortCollector();
const refusals: LiveEffortRefusal[] = [];

/** The card surface the previous dispatch was observed on; null until one has been. */
let lastSurface: string | null = null;

/**
 * Composed from the two identities the dispatch seam stated. An unscoped card states no
 * target, so its surface is the command kind alone — never a placeholder standing in for
 * an aggregate nobody named.
 */
function cardSurface(commandKind: string, aggregateId: string | null): string {
  return aggregateId === null ? commandKind : `${commandKind}@${aggregateId}`;
}

/**
 * Attribution is never derived. A dispatch whose offer stated no command identity is
 * recorded as UNATTRIBUTED, because assigning it to the most recent command would be
 * indistinguishable from a measurement one layer later.
 */
function attribution(affordance: Readonly<Record<string, unknown>>): string {
  const stated = affordance["commandId"];
  return typeof stated === "string" && stated !== "" ? stated : UNATTRIBUTED;
}

function admit(value: unknown, commandId: string, commandKind: string): void {
  const admitted = collector.record(value);
  if (!admitted.known) {
    refusals.push(Object.freeze({ commandId, commandKind, refusal: admitted }));
  }
}

/**
 * A switch is between two DIFFERENT surfaces. An operator who dispatched twice from the
 * same card did not switch attention, and recording one would manufacture a refusal for
 * an event that never happened.
 */
function admitSwitch(
  commandId: string, commandKind: string, observedAt: number, surface: string,
): void {
  const from = lastSurface;
  lastSurface = surface;
  if (from === null || from === surface) return;
  admit({
    commandId,
    fromSurface: from,
    observedAt,
    source: "CONTROL_ROOM_DOM",
    toSurface: surface,
    type: "ATTENTION_SWITCH",
  }, commandId, commandKind);
}

/**
 * Own properties only. A command kind that collides with an inherited member —
 * `constructor`, `toString` — would otherwise read back a function from the prototype
 * and be refused as a malformed reading, when the truth is that neither table states
 * anything about it. The reason code has to stay the one the fact deserves.
 */
function statedDemand(commandKind: string): string | undefined {
  if (Object.hasOwn(NAMEABLE_DEMANDS, commandKind)) return NAMEABLE_DEMANDS[commandKind];
  if (Object.hasOwn(UNNAMEABLE_DEMANDS, commandKind)) return UNNAMEABLE_DEMANDS[commandKind];
  return undefined;
}

/**
 * The demand itself. A kind in neither table states nothing about what it demanded, so
 * the field is left absent and admission answers EFFORT_OBSERVATION_ABSENT — "no such
 * observation exists" — rather than the malformed-reading code, which would claim
 * something arrived when nothing did.
 */
function admitDemand(commandId: string, observedAt: number, commandKind: string): void {
  if (FREE_INTERACTION_COMMANDS.includes(commandKind)) {
    admit({
      commandId,
      interaction: commandKind,
      observedAt,
      source: "CONTROL_ROOM_INPUT",
      type: "FREE_INTERACTION",
    }, commandId, commandKind);
    return;
  }
  admit({
    commandId,
    demandedKind: statedDemand(commandKind),
    observedAt,
    source: "CONTROL_ROOM_INPUT",
    type: "DEMANDED_DECISION",
  }, commandId, commandKind);
}

/**
 * The one call the live dispatch seam makes. It returns nothing and throws nothing: an
 * observation may not acquire the power to break the thing it observes, so a failure
 * inside this domain is recorded as a refusal at the layer that was being called and the
 * dispatch continues exactly as it did before this edge existed.
 */
export function recordDispatchEffort(input: DispatchEffortInput): void {
  let commandId = UNATTRIBUTED;
  try {
    commandId = attribution(input.affordance);
    const observedAt = Date.now();
    const surface = cardSurface(input.commandKind, input.aggregateId);
    admitSwitch(commandId, input.commandKind, observedAt, surface);
    admit({
      commandId,
      evidence: DISPATCH_EVIDENCE,
      observedAt,
      source: "CONTROL_ROOM_DOM",
      surface,
      type: "SCROLL_FOCUS_EVIDENCE",
    }, commandId, input.commandKind);
    admitDemand(commandId, observedAt, input.commandKind);
  } catch {
    // The observation never reached admission, so there is none: ABSENT, at the layer
    // whose call failed. This module mints no code and no layer of its own.
    refusals.push(Object.freeze({
      commandId,
      commandKind: input.commandKind,
      refusal: effortRefusal("EFFORT_OBSERVATION_ABSENT", EFFORT_COLLECTOR_LAYER),
    }));
  }
}

export function liveEffortDecisions(): readonly RecordedDecision[] {
  return collector.decisions();
}

export function liveEffortObservations(): readonly EffortRecord[] {
  return collector.observations();
}

export function liveEffortRefusals(): readonly LiveEffortRefusal[] {
  return Object.freeze([...refusals]);
}
