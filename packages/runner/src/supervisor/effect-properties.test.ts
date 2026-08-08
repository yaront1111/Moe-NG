import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../canonical.js";
import { upgradeDisposition } from "./drain-disposition.js";
import { admitPostActivationMutation } from "./drain-fence.js";
import { resolveDrainRow } from "./drain-reconciliation.js";
import { resolveDuplicateDelivery } from "./duplicate-delivery.js";
import { activateEffect } from "./effect-activation.js";
import { consumeActivationGrant, validateActivationCommit } from "./effect-grant.js";
import { registerLaunchLock } from "./launch-lock.js";
import { intakeProcessObservation } from "./process-observation.js";
import { reconstructAfterRestart } from "./restart-reconstruction.js";
import {
  SUPERVISOR_ERROR_CODES,
  type SupervisorFailure,
} from "./effect-kernel.js";
import { applyEffectCommand, applyEffectTombstone } from "./effect-lifecycle.js";
import { parseEffectIntent } from "./effect-parse.js";
import { MAX_SUPERVISOR_COUNT, parseMirroredLease } from "./effect-shape.js";
import {
  AT,
  DIGEST,
  makeActivationRequest,
  makeAttempt,
  makeClaim,
  makeGrant,
  makeIntent,
  makeLease,
  makeProof,
  makeSettlement,
  makeTombstone,
  makeUncertainty,
  makeWitness,
  withExtraKey,
  withGetter,
} from "./effect-test-fixtures.js";
import { fenceMirroredLease } from "./lease-mirror.js";

const LEASE_TOKEN = "token-secret-1";
const FENCE = "effect.activate";

function failureOf(outcome: unknown): SupervisorFailure {
  const failure = (outcome as { failure?: SupervisorFailure }).failure;
  if (failure === undefined) {
    throw new Error(`expected a refusal, received ${JSON.stringify(outcome)}`);
  }
  return failure;
}

function settle(target: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "settle",
    target,
    settlement: makeSettlement(),
    uncertainty: target === "UNKNOWN" ? makeUncertainty() : null,
    adoptedAt: AT,
    ...overrides,
  };
}

const active = makeIntent({ state: "ACTIVE" });
const commit = activateEffect(makeActivationRequest());
const activated = commit.kind === "ACTIVATED" ? commit.commit : null;

const REGISTRATION = {
  lockIdentity: "lock-1",
  wrapperIdentity: "wrapper-1",
  processIdentity: "process-1",
  bootstrapCredentialDigest: DIGEST.authority,
  registeredAt: AT,
};

const CANCEL_DISPOSITION = {
  reasons: ["WORK_CANCEL"],
  strongestReason: "WORK_CANCEL",
  terminalTarget: "CANCELLED",
};

function drain(overrides: Record<string, unknown> = {}): unknown {
  return {
    attemptState: "RUNNING",
    effectState: "ACTIVE",
    resourceFact: "ACTIVE",
    activationRequested: false,
    disposition: CANCEL_DISPOSITION,
    reconciliation: null,
    safeHandoff: null,
    ...overrides,
  };
}

function delivery(overrides: Record<string, unknown> = {}): unknown {
  return {
    claim: makeClaim(),
    registration: null,
    lockState: "HELD",
    effectState: "ARMED",
    ...overrides,
  };
}

/**
 * The launch-lock, drain and restart half of the vocabulary, added with those
 * layers. Kept in one function so the sweep below stays a single list: the codes
 * live in one closed array, so their reachability proof has to be one list too.
 */
function runtimeRefusals(): ReadonlyArray<readonly [string, unknown]> {
  const released = drain({
    resourceFact: "PROVEN_RELEASED",
    reconciliation: makeSettlement(),
    disposition: {
      reasons: ["WORK_RELEASE_OR_PAUSE"],
      strongestReason: "WORK_RELEASE_OR_PAUSE",
      terminalTarget: "RELEASED",
    },
  });
  return [
    ["LAUNCH_LOCK_MALFORMED", registerLaunchLock({}, makeClaim(), null)],
    ["LAUNCH_LOCK_CREDENTIAL_REUSED", registerLaunchLock(REGISTRATION, makeClaim(), REGISTRATION)],
    [
      "LAUNCH_LOCK_IDENTITY_CONFLICT",
      registerLaunchLock({ ...REGISTRATION, lockIdentity: "lock-9" }, makeClaim(), null),
    ],
    ["LAUNCH_LOCK_REGISTRATION_ABSENT", resolveDuplicateDelivery(delivery())],
    ["LAUNCH_LOCK_SUSPECT", resolveDuplicateDelivery(delivery({ lockState: "UNKNOWN" }))],
    ["PROCESS_OBSERVATION_MALFORMED", intakeProcessObservation({ kind: "VANISHED" }, null)],
    ["DRAIN_ROW_NOT_ADMITTED", resolveDrainRow("RUNNING")],
    ["DRAIN_RESOURCE_UNRECONCILED", resolveDrainRow(drain({ resourceFact: "PROVEN_RELEASED" }))],
    [
      "DRAIN_DISPOSITION_NOT_MONOTONIC",
      upgradeDisposition(
        { ...CANCEL_DISPOSITION, reasons: ["URGENT_REVOKE", "WORK_CANCEL"] },
        "GOAL_CANCEL",
      ),
    ],
    ["DRAIN_POST_ACTIVATION_MUTATION_REFUSED", admitPostActivationMutation("DRAINING", "step.start")],
    ["RESTART_RECORDS_INCOHERENT", reconstructAfterRestart({})],
    [
      "RESTART_PREMATURE_TERMINAL",
      reconstructAfterRestart({
        intent: makeIntent({ state: "SUCCEEDED" }),
        attempt: null,
        attemptState: "TERMINAL",
        claim: null,
        grant: null,
        tombstone: null,
        registration: null,
        lockState: "RELEASED",
        observation: null,
        reconciliation: null,
        resourceFact: "PROVEN_RELEASED",
        disposition: CANCEL_DISPOSITION,
        safeHandoff: null,
      }),
    ],
    ["RESTART_SAFE_HANDOFF_ABSENT", resolveDrainRow(released)],
  ];
}

/**
 * Every refusal the closed vocabulary declares, driven from a real production
 * surface. A code no surface can produce is a code no test can pin, so the sweep
 * asserts the observed set is the whole list rather than a subset of it.
 */
const REFUSALS: ReadonlyArray<readonly [string, unknown]> = [
  ["EFFECT_INTENT_MALFORMED", applyEffectCommand({}, { kind: "claim" })],
  ["EFFECT_ATTEMPT_MALFORMED", activateEffect(makeActivationRequest({ attempt: {} }))],
  ["EFFECT_CLAIM_MALFORMED", activateEffect(makeActivationRequest({ claim: {} }))],
  ["EFFECT_TOMBSTONE_MALFORMED", applyEffectTombstone(makeIntent({ state: "PENDING" }), {})],
  ["EFFECT_GRANT_MALFORMED", consumeActivationGrant({}, "wrapper-1")],
  ["EFFECT_COMMAND_MALFORMED", applyEffectCommand(makeIntent(), { kind: "detonate" })],
  ["EFFECT_TRANSITION_NOT_ADMITTED", applyEffectCommand(makeIntent(), { kind: "claim" })],
  ["EFFECT_TERMINAL_ABSORBED", applyEffectCommand(makeIntent({ state: "SUCCEEDED" }), { kind: "claim" })],
  ["EFFECT_TOMBSTONE_DOES_NOT_DOMINATE", applyEffectTombstone(active, makeTombstone())],
  ["EFFECT_SETTLEMENT_TARGET_NOT_ADMITTED", applyEffectCommand(active, settle("CANCELLED"))],
  ["EFFECT_SETTLEMENT_EVIDENCE_INVALID", applyEffectCommand(active, settle("SUCCEEDED", { settlement: {} }))],
  [
    "EFFECT_UNCERTAINTY_EVIDENCE_REQUIRED",
    applyEffectCommand(active, settle("UNKNOWN", { uncertainty: null })),
  ],
  [
    "EFFECT_UNCERTAINTY_EVIDENCE_UNEXPECTED",
    applyEffectCommand(active, settle("SUCCEEDED", { uncertainty: makeUncertainty() })),
  ],
  [
    "EFFECT_COUNTER_EXHAUSTED",
    applyEffectCommand(makeIntent({ version: MAX_SUPERVISOR_COUNT }), { kind: "requestCancel" }),
  ],
  ["ACTIVATION_INTENT_NOT_ARMED", activateEffect(makeActivationRequest({ intent: active }))],
  [
    "ACTIVATION_LOCK_IDENTITY_MISMATCH",
    activateEffect(makeActivationRequest({ lockIdentity: "lock-other" })),
  ],
  ["EFFECT_TOMBSTONED", activateEffect(makeActivationRequest({ tombstone: makeTombstone() }))],
  [
    "ATTEMPT_BINDING_MISMATCH",
    activateEffect(makeActivationRequest({ attempt: makeAttempt({ intentId: "other" }) })),
  ],
  [
    "ATTEMPT_NOT_LAUNCH_REQUESTED",
    activateEffect(makeActivationRequest({ attempt: makeAttempt({ state: "RUNNING" }) })),
  ],
  ["ACTIVATION_GRAPH_EPOCH_MISMATCH", activateEffect(makeActivationRequest({ observedGraphEpoch: 12 }))],
  [
    "ACTIVATION_DESIRED_STATE_MISMATCH",
    activateEffect(makeActivationRequest({ desiredState: "CHECKPOINTED" })),
  ],
  [
    "ACTIVATION_DEPENDENCY_WITNESS_STALE",
    activateEffect(
      makeActivationRequest({
        dependencyWitnesses: [makeWitness({ observedDigest: DIGEST.witnessDrifted })],
      }),
    ),
  ],
  [
    "PROVIDER_CAPABILITY_CHANGED",
    activateEffect(makeActivationRequest({ observedRuntimeDigest: DIGEST.runtimeDrifted })),
  ],
  ["ACTIVATION_COMMIT_INCOHERENT", validateActivationCommit(activated?.intent, makeAttempt(), makeGrant())],
  [
    "GRANT_ALREADY_CONSUMED",
    consumeActivationGrant(makeGrant({ state: "CONSUMED", version: 1 }), "wrapper-1"),
  ],
  ["GRANT_WRAPPER_MISMATCH", consumeActivationGrant(makeGrant(), "wrapper-2")],
  ["LEASE_MIRROR_MALFORMED", fenceMirroredLease({}, makeProof(), FENCE, ["ACTIVE"])],
  [
    "LEASE_MIRROR_STALE",
    fenceMirroredLease(makeLease(), makeProof({ leaseToken: "token-secret-2" }), FENCE, [
      "ACTIVE",
    ]),
  ],
  [
    "LEASE_MIRROR_STALE_EPOCH",
    fenceMirroredLease(makeLease(), makeProof({ epoch: 6 }), FENCE, ["ACTIVE"]),
  ],
  [
    "LEASE_MIRROR_SUPERSEDED_AUTHORITY",
    fenceMirroredLease(makeLease({ state: "REVOKED", epoch: 8 }), makeProof({ epoch: 7 }), FENCE, [
      "ACTIVE",
    ]),
  ],
  ...runtimeRefusals(),
];

describe("refusal sweep", () => {
  it("reaches every code in the closed vocabulary exactly once", () => {
    const observed = REFUSALS.map(([, outcome]) => failureOf(outcome).code);
    expect(observed.length).toBe(SUPERVISOR_ERROR_CODES.length);
    expect([...new Set(observed)].sort()).toEqual([...SUPERVISOR_ERROR_CODES].sort());
  });

  it.each(REFUSALS)("%s is the code the surface actually returned", (code, outcome) => {
    expect(failureOf(outcome).code).toBe(code);
  });

  it.each(REFUSALS)("%s leaks neither the lease token nor the expected runtime digest", (_code, outcome) => {
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(LEASE_TOKEN);
    expect(serialized).not.toContain("token-secret-2");
    expect(serialized).not.toContain(DIGEST.runtime);
  });

  it.each(REFUSALS)("%s is deeply frozen", (_code, outcome) => {
    const failure = failureOf(outcome);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.detail)).toBe(true);
  });
});

describe("hostile mirror fixtures", () => {
  const fence = (lease: unknown, proof: unknown = makeProof()): unknown =>
    fenceMirroredLease(lease, proof, "effect.activate", ["ACTIVE"]);

  const hostile: ReadonlyArray<readonly [string, unknown]> = [
    ["extra key", withExtraKey(makeLease(), "shadow", 1)],
    ["accessor property", withGetter(makeLease(), "leaseToken", LEASE_TOKEN)],
    ["negative zero epoch", makeLease({ epoch: -0 })],
    ["counter above the ceiling", makeLease({ version: MAX_SUPERVISOR_COUNT + 1 })],
    ["unknown state vocabulary", makeLease({ state: "PAUSED" })],
    ["unknown kind vocabulary", makeLease({ kind: "PROVIDER_SLOT" })],
  ];

  it.each(hostile)("refuses %s as malformed", (_label, lease) => {
    expect(failureOf(fence(lease)).code).toBe("LEASE_MIRROR_MALFORMED");
  });

  it("refuses an exhausted counter that still parses", () => {
    const lease = makeLease({ version: MAX_SUPERVISOR_COUNT });
    expect(parseMirroredLease(lease)).not.toBeNull();
    expect(failureOf(fence(lease, makeProof({ expectedVersion: MAX_SUPERVISOR_COUNT }))).code).toBe(
      "LEASE_MIRROR_MALFORMED",
    );
  });

  it("answers the parse code first when a record fails both parse and fence", () => {
    const doubled = withExtraKey(makeLease(), "shadow", 1);
    const failure = failureOf(fence(doubled, makeProof({ leaseToken: "token-secret-2" })));
    expect(failure.code).toBe("LEASE_MIRROR_MALFORMED");
    expect(failure.detail.state).toBeNull();
  });

  it("carries no security detail on a malformed refusal", () => {
    const failure = failureOf(fence({}));
    expect(failure.detail).toEqual({ state: null, command: "effect.activate", leg: null });
  });
});

describe("hostile dependency-witness lists", () => {
  function accessorList(): unknown[] {
    const list: unknown[] = [];
    Object.defineProperty(list, "0", {
      get: () => makeWitness(),
      enumerable: true,
      configurable: true,
    });
    return list;
  }

  const hostile: ReadonlyArray<readonly [string, unknown]> = [
    // Array.isArray is true for a subclass, so a lying Symbol.iterator could
    // hand back elements the length check never saw.
    ["a subclassed array", Object.setPrototypeOf([makeWitness()], Object.create(Array.prototype))],
    ["an accessor element", accessorList()],
    ["a list past the cap", new Array(129).fill(makeWitness())],
    ["a record wearing a length", { length: 1, 0: makeWitness() }],
  ];

  it.each(hostile)("refuses %s", (_label, dependencyWitnesses) => {
    const outcome = activateEffect(makeActivationRequest({ dependencyWitnesses }));
    expect(failureOf(outcome).code).toBe("EFFECT_COMMAND_MALFORMED");
  });

  it("still accepts an ordinary list", () => {
    const outcome = activateEffect(
      makeActivationRequest({ dependencyWitnesses: [makeWitness(), makeWitness()] }),
    );
    expect(outcome.kind).toBe("ACTIVATED");
  });
});

describe("counter ceiling is a two-bound rule", () => {
  it("parses a record at the ceiling but refuses to move it", () => {
    const intent = makeIntent({ state: "PENDING", version: MAX_SUPERVISOR_COUNT });
    expect(parseEffectIntent(intent)).not.toBeNull();
    expect(failureOf(applyEffectCommand(intent, { kind: "claim" })).code).toBe(
      "EFFECT_COUNTER_EXHAUSTED",
    );
  });

  it("refuses to activate an attempt parked at the ceiling", () => {
    const outcome = activateEffect(
      makeActivationRequest({ attempt: makeAttempt({ version: MAX_SUPERVISOR_COUNT }) }),
    );
    expect(failureOf(outcome).code).toBe("EFFECT_COUNTER_EXHAUSTED");
  });

  it("rejects a value one past the ceiling at parse time", () => {
    expect(parseEffectIntent(makeIntent({ version: MAX_SUPERVISOR_COUNT + 1 }))).toBeNull();
    expect(parseMirroredLease(makeLease({ epoch: MAX_SUPERVISOR_COUNT + 1 }))).toBeNull();
  });
});

describe("digest replay", () => {
  it("ignores the order the caller built the record in", () => {
    const forward = makeIntent();
    const reversed = Object.fromEntries([...Object.entries(forward)].reverse());
    expect(Object.keys(reversed)).not.toEqual(Object.keys(forward));
    expect(canonicalDigest(reversed)).toBe(canonicalDigest(forward));
  });

  it("reproduces the same activation digest and grant id for equal inputs", () => {
    const first = activateEffect(makeActivationRequest());
    const second = activateEffect(makeActivationRequest());
    if (first.kind !== "ACTIVATED" || second.kind !== "ACTIVATED") {
      throw new Error("expected two activations");
    }
    expect(second.commit.activationDigest).toBe(first.commit.activationDigest);
    expect(second.commit.grant.grantId).toBe(first.commit.grant.grantId);
  });
});

describe("successes are frozen and inputs survive untouched", () => {
  it("freezes every success envelope", () => {
    const transitioned = applyEffectCommand(makeIntent({ state: "PENDING" }), { kind: "claim" });
    const consumed = consumeActivationGrant(makeGrant(), "wrapper-1");
    const fenced = fenceMirroredLease(makeLease(), makeProof(), "effect.activate", ["ACTIVE"]);
    for (const outcome of [transitioned, consumed, fenced, commit]) {
      expect(Object.isFrozen(outcome)).toBe(true);
    }
    if (transitioned.kind === "TRANSITIONED") {
      expect(Object.isFrozen(transitioned.intent)).toBe(true);
    }
    if (activated !== null) {
      expect(Object.isFrozen(activated.intent)).toBe(true);
      expect(Object.isFrozen(activated.attempt)).toBe(true);
    }
  });

  it("leaves every input structurally unchanged", () => {
    const request = makeActivationRequest();
    const before = canonicalDigest(request);
    activateEffect(request);
    applyEffectCommand(request["intent"], { kind: "requestCancel" });
    applyEffectTombstone(request["intent"], makeTombstone());
    expect(canonicalDigest(request)).toBe(before);
  });
});
