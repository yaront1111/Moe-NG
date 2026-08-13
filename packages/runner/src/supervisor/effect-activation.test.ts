import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../canonical.js";
import {
  activateEffect,
  consumeActivationGrant,
  validateActivationCommit,
  type ActivationOutcome,
  type CommitCheck,
  type GrantOutcome,
} from "./effect-activation.js";
import {
  refuseRuntimeObservationDrift,
  validateRuntimeBinding,
  type RuntimeBindingCheck,
} from "./effect-grant.js";
import { EFFECT_CALLER_CONTRACT } from "./effect-kernel.js";
import { applyEffectCommand } from "./effect-lifecycle.js";
import {
  AT,
  DIGEST,
  makeActivationRequest,
  makeAttempt,
  makeClaim,
  makeGrant,
  makeIntent,
  makeProof,
  makeTombstone,
  makeWitness,
} from "./effect-test-fixtures.js";

type AnyOutcome = ActivationOutcome | GrantOutcome | CommitCheck | RuntimeBindingCheck;

function refusal(outcome: AnyOutcome): { code: string; layer: string; leg: string | null } {
  if (outcome.kind !== "REFUSED") {
    throw new Error(`expected a refusal, received ${outcome.kind}`);
  }
  expect(Object.keys(outcome)).toEqual(["kind", "failure"]);
  return {
    code: outcome.failure.code,
    layer: outcome.failure.layer,
    leg: outcome.failure.detail.leg,
  };
}

function commitOf(outcome: ActivationOutcome) {
  if (outcome.kind !== "ACTIVATED") {
    throw new Error(`expected activation, received ${JSON.stringify(outcome)}`);
  }
  return outcome.commit;
}

/**
 * Integrity and identity before authority before content, digest last. The first
 * failing leg decides the code, so one refused activation never reports two
 * causes and a caller can act on the one it names.
 */
const LEGS: ReadonlyArray<{
  readonly leg: string;
  readonly code: string;
  readonly layer: string;
  readonly override: Record<string, unknown>;
}> = [
  {
    leg: "intentState",
    code: "ACTIVATION_INTENT_NOT_ARMED",
    layer: "ACTIVATION",
    override: { intent: makeIntent({ state: "CLAIMED" }) },
  },
  {
    leg: "lockIdentity",
    code: "ACTIVATION_LOCK_IDENTITY_MISMATCH",
    layer: "ACTIVATION",
    override: { lockIdentity: "lock-other" },
  },
  {
    leg: "tombstoneWitness",
    code: "EFFECT_TOMBSTONED",
    layer: "ACTIVATION",
    override: { tombstone: makeTombstone() },
  },
  {
    leg: "attemptBinding",
    code: "ATTEMPT_BINDING_MISMATCH",
    layer: "ACTIVATION",
    override: { attempt: makeAttempt({ intentId: "intent-other" }) },
  },
  {
    leg: "attemptState",
    code: "ATTEMPT_NOT_LAUNCH_REQUESTED",
    layer: "ACTIVATION",
    override: { attempt: makeAttempt({ state: "RUNNING" }) },
  },
  {
    leg: "graphEpoch",
    code: "ACTIVATION_GRAPH_EPOCH_MISMATCH",
    layer: "ACTIVATION",
    override: { observedGraphEpoch: 12 },
  },
  {
    leg: "leaseFence",
    code: "LEASE_MIRROR_STALE",
    layer: "LEASE_MIRROR",
    override: { leaseProof: makeProof({ leaseToken: "token-secret-2" }) },
  },
  {
    leg: "desiredState",
    code: "ACTIVATION_DESIRED_STATE_MISMATCH",
    layer: "ACTIVATION",
    override: { desiredState: "CHECKPOINTED" },
  },
  {
    leg: "dependencyWitness",
    code: "ACTIVATION_DEPENDENCY_WITNESS_STALE",
    layer: "ACTIVATION",
    override: { dependencyWitnesses: [makeWitness({ observedDigest: DIGEST.witnessDrifted })] },
  },
  {
    leg: "runtimeObservation",
    code: "PROVIDER_CAPABILITY_CHANGED",
    layer: "ACTIVATION",
    override: { observedRuntimeDigest: DIGEST.runtimeDrifted },
  },
];

describe("effect.activate revalidation legs", () => {
  it("checks every leg the design names", () => {
    expect(LEGS.length).toBe(10);
  });

  it.each(LEGS)("refuses at $leg with $code", ({ code, layer, leg, override }) => {
    const request = makeActivationRequest(override);
    const before = canonicalDigest(request);
    const outcome = activateEffect(request);
    const seen = refusal(outcome);
    expect(seen.code).toBe(code);
    expect(seen.layer).toBe(layer);
    expect(seen.leg).toBe(leg);
    expect(canonicalDigest(request)).toBe(before);
  });

  it("reports only the earlier leg when two legs fail at once", () => {
    const outcome = activateEffect(
      makeActivationRequest({
        attempt: makeAttempt({ intentId: "intent-other" }),
        observedGraphEpoch: 12,
      }),
    );
    expect(refusal(outcome).code).toBe("ATTEMPT_BINDING_MISMATCH");
    expect(JSON.stringify(outcome)).not.toContain("ACTIVATION_GRAPH_EPOCH_MISMATCH");
  });

  it("refuses a malformed intent at the kernel layer", () => {
    const outcome = activateEffect(makeActivationRequest({ intent: { state: "ARMED" } }));
    const seen = refusal(outcome);
    expect(seen.code).toBe("EFFECT_INTENT_MALFORMED");
    expect(seen.layer).toBe("KERNEL");
  });

  it("refuses a malformed claim at the kernel layer", () => {
    const outcome = activateEffect(makeActivationRequest({ claim: makeClaim({ claimedAt: "now" }) }));
    expect(refusal(outcome).code).toBe("EFFECT_CLAIM_MALFORMED");
  });

  it("refuses a malformed tombstone rather than ignoring it", () => {
    const outcome = activateEffect(
      makeActivationRequest({ tombstone: makeTombstone({ reason: "" }) }),
    );
    expect(refusal(outcome).code).toBe("EFFECT_TOMBSTONE_MALFORMED");
  });
});

describe("the tombstone-versus-activate race", () => {
  it("takes the tombstone as an input it can actually witness", () => {
    const outcome = activateEffect(makeActivationRequest({ tombstone: makeTombstone() }));
    expect(refusal(outcome).code).toBe("EFFECT_TOMBSTONED");
  });

  it("publishes the caller clause that closes the commit-side race", () => {
    expect(
      EFFECT_CALLER_CONTRACT.some(
        (clause) => clause.includes("EffectTombstone MUST bump") && clause.includes("compare-and-set"),
      ),
    ).toBe(true);
  });
});

describe("cancel and activation interleavings", () => {
  it.each(["CANCEL_REQUESTED", "CANCELLED"] as const)(
    "refuses activation once cancel committed first from %s",
    (state) => {
      const outcome = activateEffect(makeActivationRequest({ intent: makeIntent({ state }) }));
      expect(refusal(outcome).code).toBe("ACTIVATION_INTENT_NOT_ARMED");
      expect("commit" in outcome).toBe(false);
    },
  );

  it("forces a later cancel into drain semantics once activation committed first", () => {
    const commit = commitOf(activateEffect(makeActivationRequest()));
    const cancelled = applyEffectCommand(commit.intent, { kind: "requestCancel" });
    expect(cancelled.kind).toBe("MUST_DRAIN");
  });
});

describe("the activation commit envelope", () => {
  const commit = commitOf(activateEffect(makeActivationRequest()));

  it("pairs the effect and attempt successors", () => {
    expect(commit.intent.state).toBe("ACTIVE");
    expect(commit.intent.version).toBe(makeIntent().version + 1);
    expect(commit.attempt.state).toBe("RUNNING");
    expect(commit.attempt.version).toBe(makeAttempt().version + 1);
  });

  it("issues an unused grant bound to the requesting wrapper", () => {
    expect(commit.grant.state).toBe("UNUSED");
    expect(commit.grant.version).toBe(0);
    expect(commit.grant.wrapperIdentity).toBe("wrapper-1");
    expect(commit.grant.intentId).toBe("intent-1");
  });

  it("derives the grant id from the activation digest, so a replay cannot mint a new one", () => {
    expect(commit.grant.grantId).toBe(
      canonicalDigest({ activationDigest: commit.activationDigest, intentId: "intent-1" }),
    );
    const replay = commitOf(activateEffect(makeActivationRequest()));
    expect(replay.grant.grantId).toBe(commit.grant.grantId);
    expect(replay.activationDigest).toBe(commit.activationDigest);
  });

  it("changes the activation digest when a successor changes", () => {
    const other = commitOf(
      activateEffect(makeActivationRequest({ attempt: makeAttempt({ version: 9 }) })),
    );
    expect(other.activationDigest).not.toBe(commit.activationDigest);
    expect(other.grant.grantId).not.toBe(commit.grant.grantId);
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(commit)).toBe(true);
    expect(Object.isFrozen(commit.grant)).toBe(true);
  });
});

describe("one-use activation grant", () => {
  it("consumes an unused grant", () => {
    const outcome = consumeActivationGrant(makeGrant(), "wrapper-1");
    if (outcome.kind !== "CONSUMED") {
      throw new Error("expected the grant to be consumed");
    }
    expect(outcome.grant.state).toBe("CONSUMED");
    expect(outcome.grant.version).toBe(1);
    expect(outcome.versionDelta).toBe(1);
  });

  it("refuses a second use of the same grant", () => {
    const outcome = consumeActivationGrant(makeGrant({ state: "CONSUMED", version: 1 }), "wrapper-1");
    expect(refusal(outcome).code).toBe("GRANT_ALREADY_CONSUMED");
  });

  it("refuses a different wrapper with its own code", () => {
    const outcome = consumeActivationGrant(makeGrant(), "wrapper-2");
    expect(refusal(outcome).code).toBe("GRANT_WRAPPER_MISMATCH");
  });

  it("refuses a malformed grant", () => {
    const outcome = consumeActivationGrant({ grantId: DIGEST.witness }, "wrapper-1");
    expect(refusal(outcome).code).toBe("EFFECT_GRANT_MALFORMED");
  });

  /**
   * Honest limit, asserted as a success: a pure function handed the same stale
   * UNUSED record twice cannot tell the second call from the first. Replay is
   * refused by the caller's compare-and-set, the store's grant-id uniqueness,
   * and the OS launch lock — never by this function.
   */
  it("cannot detect a replayed stale record and says so by succeeding", () => {
    const stale = makeGrant();
    expect(consumeActivationGrant(stale, "wrapper-1").kind).toBe("CONSUMED");
    expect(consumeActivationGrant(stale, "wrapper-1").kind).toBe("CONSUMED");
  });
});

describe("partial-commit detector", () => {
  const commit = commitOf(activateEffect(makeActivationRequest()));

  it("accepts a coherent triple", () => {
    const checked = validateActivationCommit(commit.intent, commit.attempt, commit.grant);
    expect(checked.kind).toBe("COHERENT");
    if (checked.kind === "COHERENT") {
      expect(checked.activationDigest).toBe(commit.activationDigest);
    }
  });

  it("flags an ACTIVE effect whose attempt never reached RUNNING", () => {
    const checked = validateActivationCommit(
      commit.intent,
      makeAttempt({ state: "LAUNCH_REQUESTED", version: commit.attempt.version }),
      commit.grant,
    );
    expect(refusal(checked).code).toBe("ACTIVATION_COMMIT_INCOHERENT");
  });

  it("flags a grant whose id does not derive from this commit", () => {
    const checked = validateActivationCommit(commit.intent, commit.attempt, makeGrant());
    expect(refusal(checked).code).toBe("ACTIVATION_COMMIT_INCOHERENT");
  });

  it("flags a grant naming another intent", () => {
    const checked = validateActivationCommit(
      commit.intent,
      commit.attempt,
      makeGrant({ grantId: commit.grant.grantId, intentId: "intent-other" }),
    );
    expect(refusal(checked).code).toBe("ACTIVATION_COMMIT_INCOHERENT");
  });

  it("refuses a malformed attempt at the kernel layer", () => {
    const checked = validateActivationCommit(commit.intent, { state: "RUNNING" }, commit.grant);
    const seen = refusal(checked);
    expect(seen.code).toBe("EFFECT_ATTEMPT_MALFORMED");
    expect(seen.layer).toBe("KERNEL");
  });
});

describe("redaction", () => {
  it("never echoes the lease token or the expected runtime digest", () => {
    const fenced = activateEffect(
      makeActivationRequest({ leaseProof: makeProof({ leaseToken: "token-secret-2" }) }),
    );
    const drifted = activateEffect(
      makeActivationRequest({ observedRuntimeDigest: DIGEST.runtimeDrifted }),
    );
    for (const outcome of [fenced, drifted]) {
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain("token-secret-1");
      expect(serialized).not.toContain("token-secret-2");
      expect(serialized).not.toContain(DIGEST.runtime);
    }
  });

  it("keeps the claim timestamp out of the refusal detail", () => {
    const outcome = activateEffect(makeActivationRequest({ lockIdentity: "lock-other" }));
    expect(JSON.stringify(outcome)).not.toContain(AT);
  });
});

/**
 * The wrapper enforces the same runtime binding the activation leg enforces, so
 * the comparison is extracted rather than copied: one helper, two call sites. A
 * second `!==` would drift silently the day either the code or the layer moved.
 */
describe("runtime observation binding", () => {
  it("binds when the observed digest is the committed digest", () => {
    expect(refuseRuntimeObservationDrift(DIGEST.runtime, DIGEST.runtime)).toBeNull();
  });

  it("refuses drift with the activation leg's own code, layer and leg", () => {
    const outcome = refuseRuntimeObservationDrift(DIGEST.runtime, DIGEST.runtimeDrifted);
    if (outcome === null) throw new Error("expected a runtime observation refusal");
    expect(refusal(outcome)).toEqual({
      code: "PROVIDER_CAPABILITY_CHANGED",
      layer: "ACTIVATION",
      leg: "runtimeObservation",
    });
  });

  const NOT_THE_DIGEST: ReadonlyArray<{ readonly label: string; readonly observed: unknown }> = [
    { label: "absent", observed: undefined },
    { label: "null", observed: null },
    { label: "a number", observed: 42 },
    { label: "an array of the digest", observed: [DIGEST.runtime] },
    {
      label: "a value that merely coerces to the digest",
      observed: { toString: () => DIGEST.runtime, valueOf: () => DIGEST.runtime },
    },
    { label: "one character different", observed: `${DIGEST.runtime.slice(0, -1)}f` },
    { label: "the digest with trailing whitespace", observed: `${DIGEST.runtime} ` },
  ];

  it("generates a case for every near-miss the comparison must reject", () => {
    expect(NOT_THE_DIGEST.length).toBe(7);
    expect(NOT_THE_DIGEST.map((entry) => entry.label)).toEqual([
      "absent", "null", "a number", "an array of the digest",
      "a value that merely coerces to the digest", "one character different",
      "the digest with trailing whitespace",
    ]);
  });

  it.each(NOT_THE_DIGEST)("refuses when the observation is $label", ({ observed }) => {
    const outcome = refuseRuntimeObservationDrift(DIGEST.runtime, observed);
    if (outcome === null) throw new Error("expected a runtime observation refusal");
    expect(refusal(outcome).code).toBe("PROVIDER_CAPABILITY_CHANGED");
    expect(refusal(outcome).layer).toBe("ACTIVATION");
  });

  it("refuses an unparseable effect at the kernel before it can compare a digest", () => {
    const seen = refusal(validateRuntimeBinding({ intentId: "intent-1" }, DIGEST.runtime));
    expect(seen.code).toBe("EFFECT_INTENT_MALFORMED");
    expect(seen.layer).toBe("KERNEL");
    expect(seen.leg).toBeNull();
  });

  it("refuses a parseable intent whose committed runtime is not the prepared one", () => {
    const seen = refusal(validateRuntimeBinding(makeIntent(), DIGEST.runtimeDrifted));
    expect(seen.code).toBe("PROVIDER_CAPABILITY_CHANGED");
    expect(seen.layer).toBe("ACTIVATION");
    expect(seen.leg).toBe("runtimeObservation");
  });

  it("returns a frozen BOUND arm when the prepared runtime is the committed one", () => {
    const bound: RuntimeBindingCheck = validateRuntimeBinding(
      makeIntent({ runtimeObservationDigest: DIGEST.runtimeDrifted }),
      DIGEST.runtimeDrifted,
    );
    expect(bound).toEqual({ kind: "BOUND", ok: true });
    expect(Object.isFrozen(bound)).toBe(true);
  });

  it("never echoes either digest operand", () => {
    const outcomes = [
      refuseRuntimeObservationDrift(DIGEST.runtime, DIGEST.runtimeDrifted),
      validateRuntimeBinding(makeIntent(), DIGEST.runtimeDrifted),
    ];
    for (const outcome of outcomes) {
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(DIGEST.runtime);
      expect(serialized).not.toContain(DIGEST.runtimeDrifted);
    }
  });
});
