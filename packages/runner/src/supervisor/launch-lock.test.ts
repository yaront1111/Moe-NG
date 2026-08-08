import { describe, expect, it } from "vitest";
import {
  CLAUDE_RECONCILED_OUTCOMES,
  CLAUDE_RECONCILIATION_VERSION,
} from "../providers/claude/claude-cancel-reconcile.js";
import { activateEffect } from "./effect-activation.js";
import { EFFECT_STATES, type SupervisorFailure } from "./effect-kernel.js";
import { AT, DIGEST, makeActivationRequest, makeClaim, makeIntent } from "./effect-test-fixtures.js";
import { DUPLICATE_DELIVERY_KINDS, resolveDuplicateDelivery } from "./duplicate-delivery.js";
import { LAUNCH_LOCK_OBSERVED_STATES, registerLaunchLock } from "./launch-lock.js";
import { intakeProcessObservation } from "./process-observation.js";

/**
 * Design 798: "Duplicate delivery adopts the registered process or exits before
 * provider launch. An uncertain `ARMED`/lock state becomes `SUSPECT` and is
 * never auto-relaunched."
 *
 * The bootstrap credential is only ever handled as a digest here, which is what
 * makes the redaction assertions checkable at all: a plaintext credential could
 * not be searched for in a serialized outcome without first existing in one.
 */
const CREDENTIAL = "aa".repeat(32);
const CREDENTIAL_TWO = "bb".repeat(32);
const RECONCILIATION_DIGEST = "cc".repeat(32);

function makeRegistration(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    lockIdentity: "lock-1",
    wrapperIdentity: "wrapper-1",
    processIdentity: "process-77",
    bootstrapCredentialDigest: CREDENTIAL,
    registeredAt: AT,
    ...overrides,
  };
}

function makeDelivery(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    claim: makeClaim(),
    registration: null,
    lockState: "RELEASED",
    effectState: "ARMED",
    ...overrides,
  };
}

function registered(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  const outcome = registerLaunchLock(makeRegistration(overrides), makeClaim(), null);
  if (outcome.kind !== "REGISTERED") {
    throw new Error(`expected a registration, received ${JSON.stringify(outcome)}`);
  }
  return outcome.registration;
}

function failureOf(outcome: unknown): SupervisorFailure {
  const failure = (outcome as { failure?: SupervisorFailure }).failure;
  if (failure === undefined) {
    throw new Error(`expected a refusal, received ${JSON.stringify(outcome)}`);
  }
  return failure;
}

function codeAndLayer(outcome: unknown): { code: string; layer: string } {
  const failure = failureOf(outcome);
  return { code: failure.code, layer: failure.layer };
}

describe("launch-lock registration", () => {
  it("binds lock, wrapper, process and a credential held only as a digest", () => {
    const outcome = registerLaunchLock(makeRegistration(), makeClaim(), null);
    expect(outcome.kind).toBe("REGISTERED");
    if (outcome.kind !== "REGISTERED") return;
    expect(outcome.registration).toEqual({
      lockIdentity: "lock-1",
      wrapperIdentity: "wrapper-1",
      processIdentity: "process-77",
      bootstrapCredentialDigest: CREDENTIAL,
      registeredAt: AT,
    });
    expect(Object.isFrozen(outcome.registration)).toBe(true);
  });

  it("refuses a second registration presenting the same one-time credential", () => {
    const prior = registered();
    const outcome = registerLaunchLock(makeRegistration(), makeClaim(), prior);
    expect(codeAndLayer(outcome)).toEqual({
      code: "LAUNCH_LOCK_CREDENTIAL_REUSED",
      layer: "LAUNCH_LOCK",
    });
  });

  it("refuses a second registration for the same lock even with a fresh credential", () => {
    const prior = registered();
    const outcome = registerLaunchLock(
      makeRegistration({ bootstrapCredentialDigest: CREDENTIAL_TWO, processIdentity: "process-78" }),
      makeClaim(),
      prior,
    );
    expect(codeAndLayer(outcome)).toEqual({
      code: "LAUNCH_LOCK_IDENTITY_CONFLICT",
      layer: "LAUNCH_LOCK",
    });
  });

  const disagreements: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["lockIdentity", { lockIdentity: "lock-other" }],
    ["wrapperIdentity", { wrapperIdentity: "wrapper-other" }],
  ];

  it.each(disagreements)("refuses a registration whose %s disagrees with the claim", (_f, o) => {
    const outcome = registerLaunchLock(makeRegistration(o), makeClaim(), null);
    expect(codeAndLayer(outcome)).toEqual({
      code: "LAUNCH_LOCK_IDENTITY_CONFLICT",
      layer: "LAUNCH_LOCK",
    });
  });

  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ["a non-record", "lock-1"],
    ["an extra key", { ...(makeRegistration() as object), shadow: 1 }],
    ["a plaintext credential", makeRegistration({ bootstrapCredentialDigest: "hunter2" })],
    ["a non-canonical timestamp", makeRegistration({ registeredAt: "2026-08-08" })],
    ["a missing process identity", makeRegistration({ processIdentity: "" })],
  ];

  it.each(malformed)("refuses %s as malformed", (_label, value) => {
    expect(codeAndLayer(registerLaunchLock(value, makeClaim(), null))).toEqual({
      code: "LAUNCH_LOCK_MALFORMED",
      layer: "LAUNCH_LOCK",
    });
  });

  it("names the kernel layer when the claim itself does not parse", () => {
    expect(codeAndLayer(registerLaunchLock(makeRegistration(), {}, null))).toEqual({
      code: "EFFECT_CLAIM_MALFORMED",
      layer: "KERNEL",
    });
  });

  /**
   * A security property, not a style note: a refusal that echoed the credential
   * it rejected would hand back the secret the lock exists to protect. Swept
   * across every refusing surface rather than checked on the one arm that
   * happened to be written first.
   */
  it("never leaks the credential, a lease token or the quote-bound digest", () => {
    const outcomes: unknown[] = [
      registerLaunchLock(makeRegistration(), makeClaim(), registered()),
      registerLaunchLock(makeRegistration({ lockIdentity: "x" }), makeClaim(), null),
      registerLaunchLock(makeRegistration({ bootstrapCredentialDigest: CREDENTIAL_TWO }), {}, null),
      resolveDuplicateDelivery(makeDelivery({ lockState: "UNKNOWN" })),
      resolveDuplicateDelivery(makeDelivery({ registration: registered(), lockState: "HELD" })),
      intakeProcessObservation({ kind: "VANISHED" }, null),
    ];
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      const serialized = JSON.stringify(outcome);
      for (const secret of [CREDENTIAL, CREDENTIAL_TWO, "token-secret-1", DIGEST.runtime]) {
        expect(serialized).not.toContain(secret);
      }
    }
  });
});

describe("duplicate delivery", () => {
  it("adopts the registered process and carries its exact identity", () => {
    const outcome = resolveDuplicateDelivery(
      makeDelivery({ registration: registered(), lockState: "HELD", effectState: "ACTIVE" }),
    );
    expect(outcome.kind).toBe("ADOPTED");
    if (outcome.kind !== "ADOPTED") return;
    expect(outcome.processIdentity).toBe("process-77");
    expect(outcome.lockIdentity).toBe("lock-1");
    expect(outcome.wrapperIdentity).toBe("wrapper-1");
  });

  it("exits before provider launch when nothing is registered and the lock is released", () => {
    const outcome = resolveDuplicateDelivery(makeDelivery());
    expect(outcome.kind).toBe("EXIT_BEFORE_LAUNCH");
    if (outcome.kind !== "EXIT_BEFORE_LAUNCH") return;
    expect(outcome.launched).toBe(false);
  });

  const suspects: ReadonlyArray<readonly [string, unknown, string, "LAUNCH_LOCK"]> = [
    [
      "a held lock with no registration",
      makeDelivery({ lockState: "HELD" }),
      "LAUNCH_LOCK_REGISTRATION_ABSENT",
      "LAUNCH_LOCK",
    ],
    [
      "an unknown lock state",
      makeDelivery({ lockState: "UNKNOWN" }),
      "LAUNCH_LOCK_SUSPECT",
      "LAUNCH_LOCK",
    ],
    [
      "an uncertain effect state",
      makeDelivery({ effectState: "UNKNOWN", lockState: "HELD", registration: registered() }),
      "LAUNCH_LOCK_SUSPECT",
      "LAUNCH_LOCK",
    ],
    [
      "a registration bound to another lock",
      makeDelivery({
        registration: registered({ lockIdentity: "lock-1" }),
        claim: makeClaim({ lockIdentity: "lock-other" }),
        lockState: "HELD",
      }),
      "LAUNCH_LOCK_IDENTITY_CONFLICT",
      "LAUNCH_LOCK",
    ],
    [
      "a malformed registration",
      makeDelivery({ registration: { lockIdentity: "lock-1" }, lockState: "HELD" }),
      "LAUNCH_LOCK_MALFORMED",
      "LAUNCH_LOCK",
    ],
    [
      "an unknown lock vocabulary",
      makeDelivery({ lockState: "PARTIALLY_HELD" }),
      "LAUNCH_LOCK_MALFORMED",
      "LAUNCH_LOCK",
    ],
  ];

  it.each(suspects)(
    "holds %s as SUSPECT and never relaunches",
    (_label, input, code, layer) => {
      const outcome = resolveDuplicateDelivery(input);
      expect(outcome.kind).toBe("SUSPECT");
      expect(codeAndLayer(outcome)).toEqual({ code, layer });
      expect(JSON.stringify(outcome)).not.toContain("processIdentity");
    },
  );

  it("names the kernel layer when the claim does not parse", () => {
    const outcome = resolveDuplicateDelivery(makeDelivery({ claim: {} }));
    expect(outcome.kind).toBe("SUSPECT");
    expect(codeAndLayer(outcome)).toEqual({ code: "EFFECT_CLAIM_MALFORMED", layer: "KERNEL" });
  });

  /**
   * Epic rail 6: the sweep asserts SET EQUALITY against the exported frozen kind
   * list, not membership. A resolver that grew a fourth arm — a blind relaunch —
   * would satisfy "every observed kind is declared" and still fail here.
   */
  it("produces exactly the declared outcome kinds and no other", () => {
    const cases: unknown[] = [
      makeDelivery({ registration: registered(), lockState: "HELD", effectState: "ACTIVE" }),
      makeDelivery(),
      ...suspects.map(([, input]) => input),
    ];
    expect(cases.length).toBeGreaterThan(0);
    const produced = new Set(cases.map((input) => resolveDuplicateDelivery(input).kind));
    expect([...produced].sort()).toEqual([...DUPLICATE_DELIVERY_KINDS].sort());
    expect(DUPLICATE_DELIVERY_KINDS.length).toBe(3);
  });

  it("declares a frozen lock-state vocabulary with no optimistic default", () => {
    expect([...LAUNCH_LOCK_OBSERVED_STATES].sort()).toEqual(["HELD", "RELEASED", "UNKNOWN"]);
    expect(Object.isFrozen(LAUNCH_LOCK_OBSERVED_STATES)).toBe(true);
  });
});

describe("no uncertain state yields a launch grant", () => {
  /**
   * Asserted against `activateEffect` itself — the production grant surface —
   * rather than against a helper restating the rule, so the property cannot stay
   * green while the real gate loosens.
   */
  const states = EFFECT_STATES.map((state) => ({ state }));

  it("sweeps every declared effect state", () => {
    expect(states.length).toBeGreaterThan(0);
    expect(states.length).toBe(EFFECT_STATES.length);
  });

  it.each(states)("$state grants a launch only when it is ARMED", ({ state }) => {
    const outcome = activateEffect(makeActivationRequest({ intent: makeIntent({ state }) }));
    if (state === "ARMED") {
      expect(outcome.kind).toBe("ACTIVATED");
      return;
    }
    expect(outcome.kind).toBe("REFUSED");
    expect(codeAndLayer(outcome)).toEqual({
      code: "ACTIVATION_INTENT_NOT_ARMED",
      layer: "ACTIVATION",
    });
    expect(JSON.stringify(outcome)).not.toContain("grantId");
  });

  it("carries no grant on a SUSPECT duplicate delivery", () => {
    const outcome = resolveDuplicateDelivery(makeDelivery({ lockState: "UNKNOWN" }));
    expect(JSON.stringify(outcome)).not.toContain("grantId");
    expect("ok" in outcome).toBe(false);
  });
});

describe("process observation intake", () => {
  const reference = {
    reconciliationVersion: CLAUDE_RECONCILIATION_VERSION,
    reconciliationDigest: RECONCILIATION_DIGEST,
    outcomeClass: "CRASHED",
  };

  const observations: ReadonlyArray<readonly [string, unknown, boolean]> = [
    ["EXITED", { kind: "EXITED", code: 0 }, true],
    ["SIGNALLED", { kind: "SIGNALLED", signal: "SIGKILL" }, true],
    ["UNOBSERVED", { kind: "UNOBSERVED" }, false],
  ];

  it("sweeps every declared process-exit shape", () => {
    expect(observations.length).toBe(3);
  });

  it.each(observations)("accepts %s and reports whether death was proven", (_l, exit, proven) => {
    const outcome = intakeProcessObservation(exit, null);
    expect(outcome.kind).toBe("OBSERVED");
    if (outcome.kind !== "OBSERVED") return;
    expect(outcome.observation.processExit).toEqual(exit);
    expect(outcome.observation.proven).toBe(proven);
    expect(outcome.observation.reconciliation).toBeNull();
  });

  const badExits: ReadonlyArray<readonly [string, unknown]> = [
    ["an unknown kind", { kind: "VANISHED" }],
    ["an exit without a code", { kind: "EXITED" }],
    ["a non-integer exit code", { kind: "EXITED", code: 1.5 }],
    ["a signal that is not a ref", { kind: "SIGNALLED", signal: "" }],
    ["an extra key", { kind: "UNOBSERVED", code: 0 }],
    ["a non-record", "EXITED"],
  ];

  it.each(badExits)("refuses %s", (_label, exit) => {
    expect(codeAndLayer(intakeProcessObservation(exit, null))).toEqual({
      code: "PROCESS_OBSERVATION_MALFORMED",
      layer: "LAUNCH_LOCK",
    });
  });

  it("binds the adapter's reconciliation by digest without re-deriving it", () => {
    const outcome = intakeProcessObservation({ kind: "EXITED", code: 137 }, reference);
    expect(outcome.kind).toBe("OBSERVED");
    if (outcome.kind !== "OBSERVED") return;
    expect(outcome.observation.reconciliation).toEqual(reference);
    expect(CLAUDE_RECONCILED_OUTCOMES).toContain(outcome.observation.reconciliation?.outcomeClass);
  });

  const badReferences: ReadonlyArray<readonly [string, unknown]> = [
    ["an outcome the adapter never declares", { ...reference, outcomeClass: "PROBABLY_FINE" }],
    ["a foreign reconciliation version", { ...reference, reconciliationVersion: "other/1" }],
    ["a non-digest reference", { ...reference, reconciliationDigest: "short" }],
  ];

  it.each(badReferences)("refuses %s", (_label, value) => {
    expect(codeAndLayer(intakeProcessObservation({ kind: "UNOBSERVED" }, value))).toEqual({
      code: "PROCESS_OBSERVATION_MALFORMED",
      layer: "LAUNCH_LOCK",
    });
  });
});
