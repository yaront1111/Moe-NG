import { drainRank } from "./drain-table.js";
import type { DrainDisposition } from "./drain-disposition.js";
import { activateEffect } from "./effect-activation.js";
import type {
  ActivationGrant,
  AttemptSlice,
  EffectClaim,
  EffectIntent,
} from "./effect-kernel.js";
import { applyEffectCommand } from "./effect-lifecycle.js";
import { makeActivationRequest, makeAttempt, makeClaim, makeIntent } from "./effect-test-fixtures.js";
import type { LaunchLockObservedState, LaunchLockRegistration } from "./launch-lock.js";
import { disposition, REGISTRATION } from "./race-scenarios.js";
import {
  activateStep,
  consumeStep,
  drainStep,
  duplicateStep,
  lifecycleStep,
  restartStep,
  settleStep,
  tombstoneStep,
} from "./race-steps.js";

/** The ten-command alphabet the hardening gate drives the slice through. */
export const RACE_COMMANDS = Object.freeze([
  "claim",
  "arm",
  "activate",
  "requestCancel",
  "settle",
  "consumeGrant",
  "tombstone",
  "duplicateDelivery",
  "restart",
  "drain",
] as const);
export type RaceCommand = (typeof RACE_COMMANDS)[number];

export interface World {
  readonly intent: EffectIntent;
  readonly attempt: AttemptSlice;
  readonly claim: EffectClaim;
  /** Set ONLY by a committed activation, so a launch has provable provenance. */
  readonly grant: ActivationGrant | null;
  readonly registration: LaunchLockRegistration | null;
  readonly lockState: LaunchLockObservedState;
  readonly disposition: DrainDisposition;
}

export interface StepOutcome {
  readonly label: string;
  /** The production surface's own outcome `kind`, reported verbatim. */
  readonly outcomeKind: string;
  readonly world: World;
  /** Grant id minted by a committed ARMED->ACTIVE + LAUNCH_REQUESTED->RUNNING pair. */
  readonly issued: string | null;
  /** Grant id whose WORLD-HELD authorization was spent — an external action. */
  readonly launched: string | null;
  readonly pair: string | null;
  readonly violation: string | null;
}

function transitionOrThrow(intent: EffectIntent, command: unknown): EffectIntent {
  const outcome = applyEffectCommand(intent, command);
  if (outcome.kind !== "TRANSITIONED") {
    throw new Error(`the asserted-good state pool seed refused: ${JSON.stringify(outcome)}`);
  }
  return outcome.intent;
}

/**
 * Five members, each produced by an asserted-good command sequence rather than
 * hand-built. A uniform walk over a machine with absorbing terminals never
 * reaches the deep cells, so every invariant asserted about them would pass
 * vacuously; seeding from real transitions also means a reducer change breaks
 * the pool loudly instead of quietly shrinking coverage.
 */
export function statePool(): readonly World[] {
  const pending = makeIntent({ state: "PENDING", version: 0 });
  const claimed = transitionOrThrow(pending, { kind: "claim" });
  const armed = transitionOrThrow(claimed, { kind: "arm" });
  const cancelRequested = transitionOrThrow(armed, { kind: "requestCancel" });
  const committed = activateEffect(makeActivationRequest({ intent: armed }));
  if (committed.kind !== "ACTIVATED") {
    throw new Error(`the state pool activation seed refused: ${JSON.stringify(committed)}`);
  }
  const base = {
    claim: makeClaim(),
    registration: REGISTRATION,
    lockState: "HELD" as const,
    disposition: disposition("SUBMISSION_FINALIZE"),
  };
  const idle = { attempt: makeAttempt(), grant: null };
  return Object.freeze([
    { ...base, ...idle, intent: pending },
    { ...base, ...idle, intent: claimed },
    { ...base, ...idle, intent: armed },
    {
      ...base,
      intent: committed.commit.intent,
      attempt: committed.commit.attempt,
      grant: committed.commit.grant,
    },
    { ...base, ...idle, intent: cancelRequested },
  ]);
}

export function applyCommand(
  world: World,
  command: RaceCommand,
  honest: boolean,
  pick: number,
): StepOutcome {
  switch (command) {
    case "claim":
    case "arm":
    case "requestCancel":
      return lifecycleStep(world, command, honest, pick);
    case "settle":
      return settleStep(world, honest, pick);
    case "activate":
      return activateStep(world, honest, pick);
    case "consumeGrant":
      return consumeStep(world, honest, pick);
    case "tombstone":
      return tombstoneStep(world, honest, pick);
    case "duplicateDelivery":
      return duplicateStep(world, honest, pick);
    case "drain":
      return drainStep(world, honest, pick);
    case "restart":
      return restartStep(world, honest, pick);
  }
}

/** Exported so the invariant tests rank dispositions with the production table. */
export function dispositionRank(value: DrainDisposition): number {
  return drainRank(value.strongestReason);
}
