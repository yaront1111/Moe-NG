import { DRAIN_REASONS, type DrainReason } from "./drain-table.js";
import { resolveDrainRow } from "./drain-reconciliation.js";
import { upgradeDisposition } from "./drain-disposition.js";
import { resolveDuplicateDelivery } from "./duplicate-delivery.js";
import { activateEffect } from "./effect-activation.js";
import { consumeActivationGrant } from "./effect-grant.js";
import type { EffectState, SupervisorFailure } from "./effect-kernel.js";
import {
  applyEffectCommand,
  applyEffectTombstone,
  type LifecycleOutcome,
} from "./effect-lifecycle.js";
import {
  AT,
  makeActivationRequest,
  makeSettlement,
  makeTombstone,
  makeUncertainty,
  withExtraKey,
} from "./effect-test-fixtures.js";
import {
  ACTIVATION_TAMPERS,
  DRAIN_SCENARIOS,
  FABRICATED_GRANT,
  FOREIGN_REGISTRATION,
} from "./race-scenarios.js";
import { RESTART_SCENARIOS, restartInput } from "./race-restart-scenarios.js";
import type { StepOutcome, World } from "./race-world.js";
import { reconstructAfterRestart } from "./restart-reconstruction.js";

/**
 * One handler per command of the race alphabet. Each drives a PRODUCTION
 * surface and reports that surface's own outcome `kind` verbatim, so a test can
 * compare the observed kinds against a frozen exported vocabulary instead of
 * against a label this file invented.
 */

/** Layer is part of the label: rail 6 wants which code AND which layer refused. */
function refusalLabel(failure: SupervisorFailure): string {
  return `NO:${failure.layer}:${failure.code}`;
}

function plain(
  label: string,
  kind: string,
  world: World,
  violation: string | null = null,
): StepOutcome {
  return { label, outcomeKind: kind, world, issued: null, launched: null, pair: null, violation };
}

/** Shared by every lifecycle-shaped surface so one outcome mapping serves them all. */
function fromLifecycle(
  outcome: LifecycleOutcome,
  world: World,
  family: "LIFE" | "TOMB",
): StepOutcome {
  if (outcome.kind === "TRANSITIONED") {
    return plain(`OK:${family}:${outcome.intent.state}`, outcome.kind, {
      ...world,
      intent: outcome.intent,
    });
  }
  return outcome.kind === "MUST_DRAIN"
    ? plain("OK:LIFE:MUST_DRAIN", outcome.kind, world)
    : plain(refusalLabel(outcome.failure), outcome.kind, world);
}

export type SimpleKind = "claim" | "arm" | "requestCancel";

export function lifecycleStep(
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
  return fromLifecycle(applyEffectCommand(intent, command), world, "LIFE");
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

export function settleStep(world: World, honest: boolean, pick: number): StepOutcome {
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
  return fromLifecycle(applyEffectCommand(intent, command), world, "LIFE");
}

export function activateStep(world: World, honest: boolean, pick: number): StepOutcome {
  if (!honest) {
    const override = ACTIVATION_TAMPERS[pick % ACTIVATION_TAMPERS.length] ?? {};
    const tampered = activateEffect(makeActivationRequest(override));
    return tampered.kind === "ACTIVATED"
      ? plain("OK:ACT:ACTIVATED", "ACTIVATED", world, "a tampered activation committed")
      : plain(refusalLabel(tampered.failure), "REFUSED", world);
  }
  const outcome = activateEffect(
    makeActivationRequest({ intent: world.intent, attempt: world.attempt, claim: world.claim }),
  );
  if (outcome.kind !== "ACTIVATED") {
    return plain(refusalLabel(outcome.failure), "REFUSED", world);
  }
  const { commit } = outcome;
  return {
    label: "OK:ACT:ACTIVATED",
    outcomeKind: "ACTIVATED",
    world: { ...world, intent: commit.intent, attempt: commit.attempt, grant: commit.grant },
    issued: commit.grant.grantId,
    launched: null,
    pair:
      `${world.intent.state}->${commit.intent.state}` +
      `|${world.attempt.state}->${commit.attempt.state}`,
    violation: null,
  };
}

export function consumeStep(world: World, honest: boolean, pick: number): StepOutcome {
  if (!honest) {
    // The third arm hands over a well-formed grant NO activation ever issued. A
    // pure function has no memory, so it consumes it; grant-id uniqueness in the
    // store and the OS launch lock are the backstops, not this call. The harness
    // therefore records no launch — the world never authorised one.
    const arms: readonly (readonly [unknown, unknown])[] = [
      [world.grant ?? FABRICATED_GRANT, "wrapper-attacker"],
      [{}, "wrapper-1"],
      [FABRICATED_GRANT, "wrapper-1"],
    ];
    const arm = arms[pick % arms.length] ?? arms[0];
    const tampered = consumeActivationGrant(arm?.[0], arm?.[1]);
    return tampered.kind === "CONSUMED"
      ? plain("OK:GRANT:CONSUMED", "CONSUMED", world)
      : plain(refusalLabel(tampered.failure), "REFUSED", world);
  }
  const outcome = consumeActivationGrant(world.grant, "wrapper-1");
  if (outcome.kind !== "CONSUMED") {
    return plain(refusalLabel(outcome.failure), "REFUSED", world);
  }
  return {
    label: "OK:GRANT:CONSUMED",
    outcomeKind: "CONSUMED",
    world: { ...world, grant: outcome.grant },
    issued: null,
    launched: outcome.grant.grantId,
    pair: null,
    violation: null,
  };
}

export function tombstoneStep(world: World, honest: boolean, pick: number): StepOutcome {
  const intent: unknown = !honest && pick % 3 === 0 ? {} : world.intent;
  const tombstone: unknown = honest
    ? makeTombstone()
    : pick % 3 === 1
      ? {}
      : makeTombstone({ intentId: "intent-other" });
  return fromLifecycle(applyEffectTombstone(intent, tombstone), world, "TOMB");
}

export function duplicateStep(world: World, honest: boolean, pick: number): StepOutcome {
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
    ? plain(refusalLabel(outcome.failure), outcome.kind, world)
    : plain(`OK:DUP:${outcome.kind}`, outcome.kind, world);
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

export function drainStep(world: World, honest: boolean, pick: number): StepOutcome {
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
    ? plain(label, outcome.kind, { ...world, disposition: upgraded.disposition })
    : plain(label, outcome.kind, world, `an honest upgrade to ${reason} was refused`);
}

export function restartStep(world: World, honest: boolean, pick: number): StepOutcome {
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
    ? plain(refusalLabel(outcome.failure), outcome.kind, world)
    : plain(`OK:RESTART:${outcome.postState}`, outcome.kind, world);
}
