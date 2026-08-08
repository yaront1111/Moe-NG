import { CLAUDE_RECONCILIATION_VERSION } from "../providers/claude/claude-cancel-reconcile.js";
import { activateEffect } from "../supervisor/effect-activation.js";
import {
  AT,
  makeActivationRequest,
  makeClaim,
  makeIntent,
  makeProof,
} from "../supervisor/effect-test-fixtures.js";

/**
 * Shared crash seeds for the recovery suites, following the precedent set by the
 * supervisor's own test-fixture module.
 *
 * Nothing here reads from a module under test. The builders compose the
 * supervisor's committed fixtures and the provider's reconciliation version, so
 * a broken recovery export fails by NAME inside an `it()` rather than aborting
 * collection at import time with a single anonymous error.
 *
 * Overrides are `unknown`-typed on purpose: a hostile fixture must be able to
 * put an undeclared key or an out-of-vocabulary value where a parser expects a
 * value, and a builder accepting only well-typed overrides could never say one.
 */
export type Overrides = Readonly<Record<string, unknown>>;

/** Hand-transcribed from the fixture lease; a suite asserts the fixture still agrees. */
export const HELD_EPOCH = 7;
export const HELD_TOKEN = "token-secret-1";

export const RECONCILED = Object.freeze({
  reconciliationVersion: CLAUDE_RECONCILIATION_VERSION,
  reconciliationDigest: "e1".repeat(32),
  outcomeClass: "PROVEN_RESULT",
});

export const REGISTRATION = Object.freeze({
  lockIdentity: "lock-1",
  wrapperIdentity: "wrapper-1",
  processIdentity: "process-77",
  bootstrapCredentialDigest: "aa".repeat(32),
  registeredAt: AT,
});

const activated = activateEffect(makeActivationRequest());
if (activated.kind !== "ACTIVATED") {
  throw new Error("the fixture activation must succeed for these seeds to mean anything");
}
export const COMMIT = activated.commit;

export function disposition(reason: string, terminalTarget: string): unknown {
  return { reasons: [reason], strongestReason: reason, terminalTarget };
}

export function records(overrides: Overrides = {}): unknown {
  return {
    intent: COMMIT.intent,
    attempt: COMMIT.attempt,
    attemptState: "RUNNING",
    claim: makeClaim(),
    grant: COMMIT.grant,
    tombstone: null,
    registration: REGISTRATION,
    lockState: "HELD",
    observation: null,
    reconciliation: null,
    resourceFact: "ACTIVE",
    disposition: disposition("WORK_CANCEL", "CANCELLED"),
    safeHandoff: null,
    ...overrides,
  };
}

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

/** A fence the lease core really advanced: a new epoch AND the new token it minted. */
export const ADVANCED = makeProof({ epoch: HELD_EPOCH + 1, leaseToken: "token-secret-2" });

/** A terminal attempt whose effect settled with adapter proof. */
export const SETTLED: Overrides = Object.freeze({
  intent: makeIntent({ state: "SUCCEEDED" }),
  attempt: null,
  attemptState: "TERMINAL",
  grant: null,
  registration: null,
  lockState: "RELEASED",
  reconciliation: RECONCILED,
  resourceFact: "PROVEN_RELEASED",
});

export function situation(overrides: Overrides = {}): unknown {
  return {
    records: records(),
    observation: observation(),
    claimedAuthority: null,
    ...overrides,
  };
}
