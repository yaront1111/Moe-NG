import {
  CLAUDE_RECONCILIATION_VERSION,
  SUPERVISOR_EFFECT_PROTOCOL_VERSION,
  activateEffect,
  type DrainReason,
  type DrainTerminalTarget,
} from "@moe/runner";

/**
 * Crash seeds for the daemon's restart-reconciliation and continuation suites.
 *
 * Every seed is COMPOSED from `@moe/runner`'s published surface — `activateEffect`
 * mints the intent/attempt/grant triple whose grant id derives from a canonical
 * digest, so no fixture here hand-forges a record the supervisor would reject.
 * Nothing in this module reads a module under test and nothing restates a
 * recovery rule: a builder that re-derived a classification would let a suite
 * agree with itself while the shipped composition drifted away from both.
 *
 * Overrides are `unknown`-typed on purpose, so a hostile seed can put an
 * undeclared key or an out-of-vocabulary value where a parser expects a value.
 */
export type Overrides = Readonly<Record<string, unknown>>;

export const AT = "2026-08-08T00:00:00.000Z";

/** Hand-transcribed from the lease seed below; the suites assert the seed still agrees. */
export const HELD_EPOCH = 7;
export const HELD_TOKEN = "token-secret-1";

const AUTHORITY_DIGEST = "d4".repeat(32);
const INPUT_DIGEST = "a1".repeat(32);
const RUNTIME_DIGEST = "b2".repeat(32);
const WITNESS_DIGEST = "29".repeat(32);
const RECONCILIATION_DIGEST = "f6".repeat(32);
const CREDENTIAL_DIGEST = "aa".repeat(32);

const LEASE = Object.freeze({
  leaseId: "lease-1",
  kind: "ASSIGNMENT",
  ownerSessionRef: "session-1",
  leaseToken: HELD_TOKEN,
  epoch: HELD_EPOCH,
  state: "ACTIVE",
  serverWallDeadline: 1_700_000_090,
  bootId: "boot-1",
  monotonicObservation: 4_242,
  authorityHashRef: AUTHORITY_DIGEST,
  version: 3,
});

function intent(overrides: Overrides = {}): Record<string, unknown> {
  return {
    protocolVersion: SUPERVISOR_EFFECT_PROTOCOL_VERSION,
    intentId: "intent-1",
    aggregateId: "aggregate-1",
    expectedGraphEpoch: 11,
    leaseBinding: LEASE,
    inputBinding: INPUT_DIGEST,
    predecessorCursor: "cursor-42",
    desiredState: "RUNNING",
    idempotencyKey: "idem-1",
    runtimeObservationDigest: RUNTIME_DIGEST,
    state: "ARMED",
    version: 5,
    ...overrides,
  };
}

/** A fence the lease core really advanced: a higher epoch AND the token that advance mints. */
export const ADVANCED_AUTHORITY = Object.freeze({
  leaseToken: "token-secret-2",
  epoch: HELD_EPOCH + 1,
  authorityHashRef: AUTHORITY_DIGEST,
  ownerSessionRef: "session-1",
  expectedVersion: LEASE.version,
});

const activated = activateEffect({
  intent: intent(),
  attempt: { attemptId: "attempt-1", aggregateId: "aggregate-1", intentId: "intent-1", state: "LAUNCH_REQUESTED", version: 2 },
  claim: { claimId: "claim-1", intentId: "intent-1", wrapperIdentity: "wrapper-1", lockIdentity: "lock-1", claimedAt: AT },
  tombstone: null,
  leaseProof: {
    leaseToken: HELD_TOKEN,
    epoch: HELD_EPOCH,
    authorityHashRef: AUTHORITY_DIGEST,
    ownerSessionRef: "session-1",
    expectedVersion: LEASE.version,
  },
  wrapperIdentity: "wrapper-1",
  lockIdentity: "lock-1",
  observedGraphEpoch: 11,
  desiredState: "RUNNING",
  dependencyWitnesses: [
    { witnessId: "witness-1", expectedDigest: WITNESS_DIGEST, observedDigest: WITNESS_DIGEST },
  ],
  observedRuntimeDigest: RUNTIME_DIGEST,
});
if (activated.kind !== "ACTIVATED") {
  throw new Error("the fixture activation must succeed for these seeds to mean anything");
}
/** The activation triple, minted by production code rather than transcribed. */
export const COMMIT = activated.commit;

const DISPOSITION = Object.freeze({
  reasons: ["WORK_CANCEL"] as readonly DrainReason[],
  strongestReason: "WORK_CANCEL" as DrainReason,
  terminalTarget: "CANCELLED" as DrainTerminalTarget,
});

const REGISTRATION = Object.freeze({
  lockIdentity: "lock-1",
  wrapperIdentity: "wrapper-1",
  processIdentity: "process-77",
  bootstrapCredentialDigest: CREDENTIAL_DIGEST,
  registeredAt: AT,
});

export function records(overrides: Overrides = {}): unknown {
  return {
    intent: COMMIT.intent,
    attempt: COMMIT.attempt,
    attemptState: "RUNNING",
    claim: { claimId: "claim-1", intentId: "intent-1", wrapperIdentity: "wrapper-1", lockIdentity: "lock-1", claimedAt: AT },
    grant: COMMIT.grant,
    tombstone: null,
    registration: REGISTRATION,
    lockState: "HELD",
    observation: null,
    reconciliation: null,
    resourceFact: "ACTIVE",
    disposition: DISPOSITION,
    safeHandoff: null,
    ...overrides,
  };
}

/** A terminal attempt whose effect settled with adapter proof and released its resources. */
export const SETTLED: Overrides = Object.freeze({
  intent: { ...intent(), state: "SUCCEEDED" },
  attempt: null,
  attemptState: "TERMINAL",
  grant: null,
  registration: null,
  lockState: "RELEASED",
  reconciliation: {
    reconciliationVersion: CLAUDE_RECONCILIATION_VERSION,
    reconciliationDigest: RECONCILIATION_DIGEST,
    outcomeClass: "PROVEN_RESULT",
  },
  resourceFact: "PROVEN_RELEASED",
});

export function observation(overrides: Overrides = {}): unknown {
  return {
    effectRef: "intent-1",
    processExit: { kind: "UNOBSERVED" },
    effectStatus: "PROVEN_ACTIVE",
    observedEpoch: HELD_EPOCH,
    presenceLooksLive: false,
    journalDigest: null,
    reviewPackageDigest: null,
    ...overrides,
  };
}

export function situation(overrides: Overrides = {}): unknown {
  return { records: records(), observation: observation(), claimedAuthority: null, ...overrides };
}
