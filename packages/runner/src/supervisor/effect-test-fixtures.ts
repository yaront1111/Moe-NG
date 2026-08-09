import { deepFreeze } from "../canonical.js";
import {
  SUPERVISOR_EFFECT_PROTOCOL_VERSION,
  type ActivationGrant,
  type AttemptSlice,
  type DependencyWitness,
  type EffectClaim,
  type EffectIntent,
  type EffectTombstone,
  type SettlementEvidence,
  type UncertaintyEvidence,
} from "./effect-kernel.js";
import type { MirroredLeaseProof, MirroredLeaseRecord } from "./effect-shape.js";

/**
 * Shared builders for the supervisor suites, following the precedent set by the
 * authority suite's own `test-fixtures.ts` in @moe/scheduler. The package
 * boundary guard checks module specifiers for internal scheduler paths, while
 * this prose names only the package and fixture module.
 *
 * Overrides are `unknown`-typed on purpose: a hostile fixture must be able to
 * put a `-0`, a getter, or an extra key where a parser expects a value, and a
 * builder that only accepted well-typed overrides could never express one.
 */
export type Overrides = Readonly<Record<string, unknown>>;

export const AT = "2026-08-08T00:00:00.000Z";
export const LATER = "2026-08-08T01:00:00.000Z";

export const DIGEST = Object.freeze({
  input: "a1".repeat(32),
  runtime: "b2".repeat(32),
  runtimeDrifted: "c3".repeat(32),
  authority: "d4".repeat(32),
  authorityOther: "e5".repeat(32),
  reconciliation: "f6".repeat(32),
  reconciliationOther: "07".repeat(32),
  uncertainty: "18".repeat(32),
  witness: "29".repeat(32),
  witnessDrifted: "3a".repeat(32),
});

const LEASE_BASE = {
  leaseId: "lease-1",
  kind: "ASSIGNMENT",
  ownerSessionRef: "session-1",
  leaseToken: "token-secret-1",
  epoch: 7,
  state: "ACTIVE",
  serverWallDeadline: 1_700_000_090,
  bootId: "boot-1",
  monotonicObservation: 4_242,
  authorityHashRef: DIGEST.authority,
  version: 3,
};

export function makeLease(overrides: Overrides = {}): MirroredLeaseRecord {
  return deepFreeze({ ...LEASE_BASE, ...overrides }) as unknown as MirroredLeaseRecord;
}

export function makeProof(overrides: Overrides = {}): MirroredLeaseProof {
  return deepFreeze({
    leaseToken: LEASE_BASE.leaseToken,
    epoch: LEASE_BASE.epoch,
    authorityHashRef: LEASE_BASE.authorityHashRef,
    ownerSessionRef: LEASE_BASE.ownerSessionRef,
    expectedVersion: LEASE_BASE.version,
    ...overrides,
  }) as unknown as MirroredLeaseProof;
}

export function makeIntent(overrides: Overrides = {}): EffectIntent {
  return deepFreeze({
    protocolVersion: SUPERVISOR_EFFECT_PROTOCOL_VERSION,
    intentId: "intent-1",
    aggregateId: "aggregate-1",
    expectedGraphEpoch: 11,
    leaseBinding: makeLease(),
    inputBinding: DIGEST.input,
    predecessorCursor: "cursor-42",
    desiredState: "RUNNING",
    idempotencyKey: "idem-1",
    runtimeObservationDigest: DIGEST.runtime,
    state: "ARMED",
    version: 5,
    ...overrides,
  }) as unknown as EffectIntent;
}

export function makeAttempt(overrides: Overrides = {}): AttemptSlice {
  return deepFreeze({
    attemptId: "attempt-1",
    aggregateId: "aggregate-1",
    intentId: "intent-1",
    state: "LAUNCH_REQUESTED",
    version: 2,
    ...overrides,
  }) as unknown as AttemptSlice;
}

export function makeClaim(overrides: Overrides = {}): EffectClaim {
  return deepFreeze({
    claimId: "claim-1",
    intentId: "intent-1",
    wrapperIdentity: "wrapper-1",
    lockIdentity: "lock-1",
    claimedAt: AT,
    ...overrides,
  }) as unknown as EffectClaim;
}

export function makeTombstone(overrides: Overrides = {}): EffectTombstone {
  return deepFreeze({
    intentId: "intent-1",
    reason: "GOAL_CANCEL",
    terminalizedAt: AT,
    ...overrides,
  }) as unknown as EffectTombstone;
}

export function makeGrant(overrides: Overrides = {}): ActivationGrant {
  return deepFreeze({
    grantId: DIGEST.witness,
    intentId: "intent-1",
    wrapperIdentity: "wrapper-1",
    state: "UNUSED",
    version: 0,
    ...overrides,
  }) as unknown as ActivationGrant;
}

export function makeSettlement(overrides: Overrides = {}): SettlementEvidence {
  return deepFreeze({
    reconciliationVersion: "moe-claude-reconciliation/1",
    reconciliationDigest: DIGEST.reconciliation,
    outcomeClass: "PROVEN_RESULT",
    ...overrides,
  }) as unknown as SettlementEvidence;
}

export function makeUncertainty(overrides: Overrides = {}): UncertaintyEvidence {
  return deepFreeze({
    uncertaintyReason: "HONEST_UNKNOWN",
    uncertaintyDigest: DIGEST.uncertainty,
    ...overrides,
  }) as unknown as UncertaintyEvidence;
}

export function makeWitness(overrides: Overrides = {}): DependencyWitness {
  return deepFreeze({
    witnessId: "witness-1",
    expectedDigest: DIGEST.witness,
    observedDigest: DIGEST.witness,
    ...overrides,
  }) as unknown as DependencyWitness;
}

/**
 * A well-formed `effect.activate` request. Typed as a plain record rather than
 * `ActivationRequest` so a hostile override can put anything anywhere, which is
 * exactly what the per-leg refusal tests need.
 */
export function makeActivationRequest(overrides: Overrides = {}): Record<string, unknown> {
  return {
    intent: makeIntent(),
    attempt: makeAttempt(),
    claim: makeClaim(),
    tombstone: null,
    leaseProof: makeProof(),
    wrapperIdentity: "wrapper-1",
    lockIdentity: "lock-1",
    observedGraphEpoch: 11,
    desiredState: "RUNNING",
    dependencyWitnesses: [makeWitness()],
    observedRuntimeDigest: DIGEST.runtime,
    ...overrides,
  };
}

/**
 * A spread copies a getter's *value*, so an accessor fixture has to be defined
 * explicitly. This is the shape that would otherwise answer one value to a
 * validation read and another to the read that binds.
 */
export function withGetter<T extends object>(base: T, key: string, value: unknown): T {
  const clone = { ...base } as unknown as Record<string, unknown>;
  Object.defineProperty(clone, key, { get: () => value, enumerable: true, configurable: true });
  return clone as T;
}

export function withExtraKey<T extends object>(base: T, key: string, value: unknown): T {
  return { ...base, [key]: value } as T;
}
