import type { DrainDisposition } from "./drain-disposition.js";
import { drainTargetOf, type DrainReason } from "./drain-table.js";
import {
  AT,
  DIGEST,
  makeAttempt,
  makeGrant,
  makeIntent,
  makeLease,
  makeProof,
  makeTombstone,
  makeWitness,
  type Overrides,
} from "./effect-test-fixtures.js";
import type { LaunchLockRegistration } from "./launch-lock.js";

/**
 * Hand-written input pools for the seeded race harness.
 *
 * The wide-dial surfaces (`resolveDrainRow`, `reconstructAfterRestart`) take a
 * seven-field record whose cross product is in the hundreds. A uniform random
 * walk over that space reaches the narrow rows — R4's activation cell, the
 * RELEASED-without-handoff refusal — perhaps once in a whole run, so an
 * outcome-kind set equality built on it would be decided by seed luck rather
 * than by the production code. These pools are therefore STRATIFIED: one entry
 * per row and per refusal, chosen by the seeded PRNG, so every declared answer
 * is reached many times and a missing one is a real regression.
 *
 * No pool member carries an expected label. Expectations live in the test files
 * and are written by hand, so nothing here can quietly agree with the
 * implementation it feeds.
 */
export const RECONCILED = Object.freeze({
  reconciliationVersion: "moe-claude-reconciliation/1",
  reconciliationDigest: DIGEST.reconciliation,
  outcomeClass: "PROVEN_RESULT",
});

export const REGISTRATION: LaunchLockRegistration = Object.freeze({
  lockIdentity: "lock-1",
  wrapperIdentity: "wrapper-1",
  processIdentity: "process-77",
  bootstrapCredentialDigest: "aa".repeat(32),
  registeredAt: AT,
});

/** A registration bound to somebody else's lock — the identity-conflict arm. */
export const FOREIGN_REGISTRATION: LaunchLockRegistration = Object.freeze({
  ...REGISTRATION,
  lockIdentity: "lock-other",
});

/** Target mapping comes from the production precedence table, never a copy. */
export function disposition(reason: DrainReason): DrainDisposition {
  const terminalTarget = drainTargetOf(reason);
  if (terminalTarget === null) {
    throw new Error(`the precedence table declares no terminal target for ${reason}`);
  }
  return { reasons: [reason], strongestReason: reason, terminalTarget };
}

const CANCEL = disposition("WORK_CANCEL");
const RELEASE = disposition("WORK_RELEASE_OR_PAUSE");

/** Shape-valid but self-inconsistent: its strongest reason is not in its own set. */
const DOWNGRADED: DrainDisposition = Object.freeze({
  reasons: ["WORK_CANCEL"] as readonly DrainReason[],
  strongestReason: "URGENT_REVOKE",
  terminalTarget: "CANCELLED",
});

export interface Scenario {
  readonly id: string;
  readonly input: unknown;
}

function drainInput(overrides: Overrides = {}): unknown {
  return {
    attemptState: "ABSENT",
    effectState: "ARMED",
    resourceFact: "ACTIVE",
    activationRequested: false,
    disposition: CANCEL,
    reconciliation: null,
    safeHandoff: null,
    ...overrides,
  };
}

const RELEASED = { attemptState: "LEASED", resourceFact: "PROVEN_RELEASED" } as const;
const LIVE_RUN = { attemptState: "RUNNING", effectState: "ACTIVE" } as const;

/** One entry per design-786/787 row and per drain-layer refusal. */
export const DRAIN_SCENARIOS: readonly Scenario[] = Object.freeze([
  { id: "R1-no-attempt", input: drainInput() },
  { id: "R2-terminalize", input: drainInput(RELEASED) },
  { id: "R2-release-without-handoff", input: drainInput({ ...RELEASED, disposition: RELEASE }) },
  {
    id: "R2-release-with-handoff",
    input: drainInput({ ...RELEASED, disposition: RELEASE, safeHandoff: "handoff-1" }),
  },
  {
    id: "R3-pre-launch-draining",
    input: drainInput({
      attemptState: "LAUNCH_REQUESTED",
      effectState: "CLAIMED",
      resourceFact: "UNKNOWN",
    }),
  },
  {
    id: "R4-atomic-activation",
    input: drainInput({ attemptState: "LAUNCH_REQUESTED", activationRequested: true }),
  },
  { id: "R5-running-draining", input: drainInput(LIVE_RUN) },
  {
    id: "R5-released-unreconciled",
    input: drainInput({ ...LIVE_RUN, resourceFact: "PROVEN_RELEASED" }),
  },
  {
    id: "R5-released-reconciled",
    input: drainInput({
      ...LIVE_RUN,
      resourceFact: "PROVEN_RELEASED",
      reconciliation: RECONCILED,
    }),
  },
  {
    id: "R6-terminal-attempt",
    input: drainInput({ attemptState: "TERMINAL", effectState: "CANCEL_REQUESTED" }),
  },
  { id: "no-admitted-row", input: drainInput({ attemptState: "RUNNING", effectState: "PENDING" }) },
  { id: "downgraded-disposition", input: drainInput({ disposition: DOWNGRADED }) },
]);

/**
 * `effect.activate` leg drills. Each override targets exactly one leg, applied to
 * an otherwise-committing ARMED request so the leg under test is the one that
 * decides — a tampered request over a non-ARMED intent would be short-circuited
 * by `ACTIVATION_INTENT_NOT_ARMED` and drill nothing.
 */
export const ACTIVATION_TAMPERS: readonly Overrides[] = Object.freeze([
  { intent: {} },
  { attempt: {} },
  { tombstone: { intentId: "intent-1" } },
  { wrapperIdentity: 5 },
  { wrapperIdentity: "wrapper-attacker" },
  { tombstone: makeTombstone() },
  { attempt: makeAttempt({ intentId: "intent-other" }) },
  { attempt: makeAttempt({ state: "RUNNING" }) },
  { observedGraphEpoch: 99 },
  { leaseProof: makeProof({ leaseToken: "token-stale" }) },
  { leaseProof: makeProof({ epoch: 6 }) },
  { leaseProof: {} },
  {
    intent: makeIntent({ leaseBinding: makeLease({ state: "REVOKED" }) }),
    leaseProof: makeProof({ epoch: 6 }),
  },
  { desiredState: "PAUSED" },
  { dependencyWitnesses: [makeWitness({ observedDigest: DIGEST.witnessDrifted })] },
  { observedRuntimeDigest: DIGEST.runtimeDrifted },
]);

/** A well-formed grant no activation ever issued. */
export const FABRICATED_GRANT = makeGrant();
