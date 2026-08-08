import { drainRank, type DrainReason, DRAIN_REASONS } from "./drain-table.js";
import { resolveDrainRow } from "./drain-reconciliation.js";
import { upgradeDisposition, type DrainDisposition } from "./drain-disposition.js";
import { resolveDuplicateDelivery } from "./duplicate-delivery.js";
import { activateEffect } from "./effect-activation.js";
import { consumeActivationGrant } from "./effect-grant.js";
import type {
  ActivationGrant,
  AttemptSlice,
  EffectClaim,
  EffectIntent,
  EffectState,
  SupervisorFailure,
} from "./effect-kernel.js";
import { applyEffectCommand, applyEffectTombstone } from "./effect-lifecycle.js";
import {
  AT,
  makeActivationRequest,
  makeAttempt,
  makeClaim,
  makeIntent,
  makeSettlement,
  makeTombstone,
  makeUncertainty,
  withExtraKey,
} from "./effect-test-fixtures.js";
import type { LaunchLockObservedState, LaunchLockRegistration } from "./launch-lock.js";
import {
  ACTIVATION_TAMPERS,
  DRAIN_SCENARIOS,
  disposition,
  FABRICATED_GRANT,
  FOREIGN_REGISTRATION,
  REGISTRATION,
  RESTART_SCENARIOS,
  restartInput,
} from "./race-scenarios.js";
import { reconstructAfterRestart } from "./restart-reconstruction.js";

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
  readonly world: World;
  /** Grant id minted by a committed ARMED->ACTIVE + LAUNCH_REQUESTED->RUNNING pair. */
  readonly issued: string | null;
  /** Grant id whose WORLD-HELD authorization was spent — an external action. */
  readonly launched: string | null;
  readonly pair: string | null;
  readonly violation: string | null;
}

/** Layer is part of the label: rail 6 wants which code AND which layer refused. */
function refusalLabel(failure: SupervisorFailure): string {
  return `NO:${failure.layer}:${failure.code}`;
}

function plain(label: string, world: World, violation: string | null = null): StepOutcome {
  return { label, world, issued: null, launched: null, pair: null, violation };
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

type SimpleKind = "claim" | "arm" | "requestCancel";

function lifecycleStep(
  world: World,
  kind: SimpleKind,
  honest: boolean,
  pick: number,
): StepOutcome {
  let intent: unknown = world.intent;
  let command: unknown = { kind };
  if (!honest) {
    if (pick % 3 === 0) intent = {};
    else if (pick % 3 === 1) intent = withExtraKey(world.intent, "shadow", 1);
    else command = { kind: "teleport" };
  }
  const outcome = applyEffectCommand(intent, command);
  if (outcome.kind === "TRANSITIONED") {
    return plain(`OK:LIFE:${outcome.intent.state}`, { ...world, intent: outcome.intent });
  }
  return outcome.kind === "MUST_DRAIN"
    ? plain("OK:LIFE:MUST_DRAIN", world)
    : plain(refusalLabel(outcome.failure), world);
}

const SETTLE_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ACTIVE: ["SUCCEEDED", "FAILED", "UNKNOWN"],
  CANCEL_REQUESTED: ["CANCELLED", "UNKNOWN"],
});

function honestSettle(state: EffectState, pick: number): Record<string, unknown> {
  const targets = SETTLE_TARGETS[state] ?? ["UNKNOWN"];
  const target = targets[pick % targets.length] ?? "UNKNOWN";
  return {
    kind: "settle",
    target,
    settlement: makeSettlement(),
    uncertainty: target === "UNKNOWN" ? makeUncertainty() : null,
    adoptedAt: AT,
  };
}

function settleStep(world: World, honest: boolean, pick: number): StepOutcome {
  const base = honestSettle(world.intent.state, pick);
  const proven = world.intent.state === "CANCEL_REQUESTED" ? "CANCELLED" : "SUCCEEDED";
  let intent: unknown = world.intent;
  let command: unknown = base;
  if (!honest) {
    // Each arm drills exactly one evidence rule so the refusal codes stay distinct.
    if (pick % 6 === 0) intent = {};
    else if (pick % 6 === 1) command = { kind: "teleport" };
    else if (pick % 6 === 2) command = { ...base, target: "CLAIMED" };
    else if (pick % 6 === 3) command = { ...base, settlement: {} };
    else if (pick % 6 === 4) command = { ...base, target: "UNKNOWN", uncertainty: null };
    else command = { ...base, target: proven, uncertainty: makeUncertainty() };
  }
  const outcome = applyEffectCommand(intent, command);
  if (outcome.kind === "TRANSITIONED") {
    return plain(`OK:LIFE:${outcome.intent.state}`, { ...world, intent: outcome.intent });
  }
  return outcome.kind === "MUST_DRAIN"
    ? plain("OK:LIFE:MUST_DRAIN", world)
    : plain(refusalLabel(outcome.failure), world);
}

function activateStep(world: World, honest: boolean, pick: number): StepOutcome {
  if (!honest) {
    const override = ACTIVATION_TAMPERS[pick % ACTIVATION_TAMPERS.length] ?? {};
    const tampered = activateEffect(makeActivationRequest(override));
    return tampered.kind === "ACTIVATED"
      ? plain("OK:ACT:ACTIVATED", world, "a tampered activation committed")
      : plain(refusalLabel(tampered.failure), world);
  }
  const outcome = activateEffect(
    makeActivationRequest({ intent: world.intent, attempt: world.attempt, claim: world.claim }),
  );
  if (outcome.kind !== "ACTIVATED") {
    return plain(refusalLabel(outcome.failure), world);
  }
  const { commit } = outcome;
  return {
    label: "OK:ACT:ACTIVATED",
    world: { ...world, intent: commit.intent, attempt: commit.attempt, grant: commit.grant },
    issued: commit.grant.grantId,
    launched: null,
    pair:
      `${world.intent.state}->${commit.intent.state}` +
      `|${world.attempt.state}->${commit.attempt.state}`,
    violation: null,
  };
}

function consumeStep(world: World, honest: boolean, pick: number): StepOutcome {
  if (!honest) {
    // The third arm hands over a well-formed grant NO activation ever issued.
    // A pure function has no memory, so it consumes it; the store's grant-id
    // uniqueness index and the OS lock are the backstops, not this call. The
    // harness therefore records no launch: the world never authorised one.
    const arms: readonly [unknown, unknown][] = [
      [world.grant ?? FABRICATED_GRANT, "wrapper-attacker"],
      [{}, "wrapper-1"],
      [FABRICATED_GRANT, "wrapper-1"],
    ];
    const [grantValue, wrapper] = arms[pick % arms.length] ?? arms[0]!;
    const tampered = consumeActivationGrant(grantValue, wrapper);
    return tampered.kind === "CONSUMED"
      ? plain("OK:GRANT:CONSUMED", world)
      : plain(refusalLabel(tampered.failure), world);
  }
  const outcome = consumeActivationGrant(world.grant, "wrapper-1");
  if (outcome.kind !== "CONSUMED") {
    return plain(refusalLabel(outcome.failure), world);
  }
  return {
    label: "OK:GRANT:CONSUMED",
    world: { ...world, grant: outcome.grant },
    issued: null,
    launched: outcome.grant.grantId,
    pair: null,
    violation: null,
  };
}

function tombstoneStep(world: World, honest: boolean, pick: number): StepOutcome {
  const intent: unknown = !honest && pick % 3 === 0 ? {} : world.intent;
  const tombstone: unknown = honest
    ? makeTombstone()
    : pick % 3 === 1
      ? {}
      : makeTombstone({ intentId: "intent-other" });
  const outcome = applyEffectTombstone(intent, tombstone);
  if (outcome.kind === "TRANSITIONED") {
    return plain(`OK:TOMB:${outcome.intent.state}`, { ...world, intent: outcome.intent });
  }
  return outcome.kind === "MUST_DRAIN"
    ? plain("OK:LIFE:MUST_DRAIN", world)
    : plain(refusalLabel(outcome.failure), world);
}

function duplicateStep(world: World, honest: boolean, pick: number): StepOutcome {
  const base = {
    claim: world.claim,
    registration: world.registration,
    lockState: world.lockState,
    effectState: world.intent.state,
  };
  const input: unknown = honest
    ? base
    : pick % 3 === 0
      ? { ...base, claim: {} }
      : pick % 3 === 1
        ? {}
        : { ...base, registration: FOREIGN_REGISTRATION };
  const outcome = resolveDuplicateDelivery(input);
  // A duplicate delivery NEVER carries a launch: `launched` stays null on every arm.
  return outcome.kind === "SUSPECT"
    ? plain(refusalLabel(outcome.failure), world)
    : plain(`OK:DUP:${outcome.kind}`, world);
}

/** The live world as a drain row, so the table is asked about a real schedule. */
function liveDrainInput(world: World): unknown {
  return {
    attemptState: world.attempt.state,
    effectState: world.intent.state,
    resourceFact: "ACTIVE",
    activationRequested: false,
    disposition: world.disposition,
    reconciliation: null,
    safeHandoff: null,
  };
}

function drainStep(world: World, honest: boolean, pick: number): StepOutcome {
  const scenario = DRAIN_SCENARIOS[pick % DRAIN_SCENARIOS.length];
  const input = honest || scenario === undefined ? liveDrainInput(world) : scenario.input;
  const outcome = resolveDrainRow(input);
  const label =
    outcome.kind === "REFUSED" ? refusalLabel(outcome.failure) : `OK:DRAIN:${outcome.kind}`;
  // Every drain step also unions one reason into the world disposition, which is
  // what makes the strongest-reason monotonicity invariant observable per step.
  const reason: DrainReason = DRAIN_REASONS[pick % DRAIN_REASONS.length] ?? "SUBMISSION_FINALIZE";
  const upgraded = upgradeDisposition(world.disposition, reason);
  return upgraded.kind === "UPGRADED"
    ? plain(label, { ...world, disposition: upgraded.disposition })
    : plain(label, world, `a monotonic disposition refused an honest upgrade to ${reason}`);
}

function restartStep(world: World, honest: boolean, pick: number): StepOutcome {
  const scenario = RESTART_SCENARIOS[pick % RESTART_SCENARIOS.length];
  const input =
    honest || scenario === undefined
      ? restartInput({
          intent: world.intent,
          attempt: world.attempt,
          attemptState: world.attempt.state,
          claim: world.claim,
          grant: world.grant,
          registration: world.registration,
          lockState: world.lockState,
          disposition: world.disposition,
        })
      : scenario.input;
  const outcome = reconstructAfterRestart(input);
  return outcome.kind === "REFUSED"
    ? plain(refusalLabel(outcome.failure), world)
    : plain(`OK:RESTART:${outcome.postState}`, world);
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
