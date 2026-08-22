import { describe, expect, it } from "vitest";
import { CLAUDE_RECONCILIATION_VERSION } from "../providers/claude/claude-cancel-reconcile.js";
import { activateEffect } from "./effect-activation.js";
import type { SupervisorFailure } from "./effect-kernel.js";
import {
  AT,
  makeActivationRequest,
  makeAttempt,
  makeClaim,
  makeGrant,
  makeIntent,
  makeTombstone,
} from "./effect-test-fixtures.js";
import { reconstructAfterRestart, RESTART_POST_STATES } from "./restart-reconstruction.js";

const RECONCILED = Object.freeze({
  reconciliationVersion: CLAUDE_RECONCILIATION_VERSION,
  reconciliationDigest: "e1".repeat(32),
  outcomeClass: "PROVEN_RESULT",
});

const REGISTRATION = Object.freeze({
  lockIdentity: "lock-1",
  wrapperIdentity: "wrapper-1",
  processIdentity: "process-77",
  bootstrapCredentialDigest: "aa".repeat(32),
  registeredAt: AT,
});

function disposition(reason: string, terminalTarget: string): unknown {
  return { reasons: [reason], strongestReason: reason, terminalTarget };
}

const committed = activateEffect(makeActivationRequest());
if (committed.kind !== "ACTIVATED") {
  throw new Error("the fixture activation must succeed for these seeds to mean anything");
}
const COMMIT = committed.commit;

function seed(overrides: Readonly<Record<string, unknown>> = {}): unknown {
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

function failureOf(outcome: unknown): SupervisorFailure {
  const failure = (outcome as { failure?: SupervisorFailure }).failure;
  if (failure === undefined) {
    throw new Error(`expected a refusal, received ${JSON.stringify(outcome)}`);
  }
  return failure;
}

/** `post:<state>` or `refused:<code>` — one label per legal answer. */
function labelOf(outcome: unknown): string {
  const value = outcome as { kind?: string; postState?: string };
  return value.kind === "RECONSTRUCTED"
    ? `post:${String(value.postState)}`
    : `refused:${failureOf(outcome).code}`;
}

/**
 * Hand-written expectations, one per seeded pre-crash record set. Not derived
 * from the reconstruction: a table built from the function under test would
 * still agree with itself after the function started answering two things.
 */
const SEEDS: ReadonlyArray<readonly [string, unknown, string]> = [
  ["a coherent activation commit with a held lock", seed(), "post:ACTIVE_ADOPTED"],
  [
    "a pre-activation intent dominated by a tombstone",
    seed({
      intent: makeIntent({ state: "ARMED" }),
      attempt: null,
      attemptState: "ABSENT",
      grant: null,
      tombstone: makeTombstone(),
      registration: null,
      lockState: "RELEASED",
    }),
    "post:TOMBSTONED",
  ],
  [
    "a consumed grant whose attempt never reached RUNNING",
    seed({
      attempt: makeAttempt({ state: "LAUNCH_REQUESTED" }),
      attemptState: "LAUNCH_REQUESTED",
      grant: makeGrant({ state: "CONSUMED", version: 1 }),
    }),
    "refused:RESTART_RECORDS_INCOHERENT",
  ],
  [
    "a partial activation commit whose grant does not derive",
    seed({ grant: makeGrant() }),
    "refused:RESTART_RECORDS_INCOHERENT",
  ],
  [
    "an attempt state that disagrees with the stored attempt record",
    seed({ attemptState: "DRAINING" }),
    "refused:RESTART_RECORDS_INCOHERENT",
  ],
  [
    "a registered lock whose state cannot be read",
    seed({ lockState: "UNKNOWN" }),
    "post:SUSPECT",
  ],
  [
    "an observation with no registration",
    seed({ registration: null, observation: { kind: "EXITED", code: 0 }, lockState: "RELEASED" }),
    "post:SUSPECT",
  ],
  [
    "a draining attempt with an unreconciled resource",
    seed({ attempt: null, attemptState: "DRAINING", resourceFact: "UNKNOWN" }),
    "post:DRAINING",
  ],
  [
    "a terminal attempt over a still-nonterminal effect",
    seed({ attempt: null, attemptState: "TERMINAL", registration: null, lockState: "RELEASED" }),
    "post:RECONCILE_ONLY",
  ],
  [
    "a terminal attempt whose effect settled with adapter proof",
    seed({
      intent: makeIntent({ state: "SUCCEEDED" }),
      attempt: null,
      attemptState: "TERMINAL",
      grant: null,
      registration: null,
      lockState: "RELEASED",
      reconciliation: RECONCILED,
      resourceFact: "PROVEN_RELEASED",
    }),
    "post:TERMINAL_PROVEN",
  ],
  [
    "a terminal label with no evidence behind it",
    seed({
      intent: makeIntent({ state: "SUCCEEDED" }),
      attempt: null,
      attemptState: "TERMINAL",
      grant: null,
      registration: null,
      lockState: "RELEASED",
      resourceFact: "PROVEN_RELEASED",
    }),
    "refused:RESTART_PREMATURE_TERMINAL",
  ],
  [
    "a RELEASED candidate without its exact safe handoff",
    seed({
      attempt: null,
      attemptState: "DRAINING",
      resourceFact: "PROVEN_RELEASED",
      reconciliation: RECONCILED,
      disposition: disposition("WORK_RELEASE_OR_PAUSE", "RELEASED"),
    }),
    "refused:RESTART_SAFE_HANDOFF_ABSENT",
  ],
  [
    "a RELEASED candidate carrying its exact safe handoff",
    seed({
      attempt: null,
      attemptState: "DRAINING",
      resourceFact: "PROVEN_RELEASED",
      reconciliation: RECONCILED,
      disposition: disposition("WORK_RELEASE_OR_PAUSE", "RELEASED"),
      safeHandoff: "handoff-1",
    }),
    "post:TERMINAL_PROVEN",
  ],
  [
    "a running attempt with neither claim nor registration to identify it",
    seed({ claim: null, grant: null, registration: null, lockState: "RELEASED" }),
    "post:UNKNOWN",
  ],
  [
    "a held lock whose registration belongs to another wrapper",
    seed({ registration: { ...REGISTRATION, wrapperIdentity: "wrapper-other" } }),
    "post:SUSPECT",
  ],
  [
    "a claim written for another effect intent",
    seed({ claim: makeClaim({ intentId: "intent-other" }) }),
    "refused:RESTART_RECORDS_INCOHERENT",
  ],
];

describe("restart reconstruction lands on exactly one legal state", () => {
  it("seeds a non-zero, fully labelled set of pre-crash record shapes", () => {
    expect(SEEDS.length).toBeGreaterThan(0);
    expect(SEEDS.length).toBe(16);
    expect(new Set(SEEDS.map(([label]) => label)).size).toBe(SEEDS.length);
  });

  it.each(SEEDS)("%s reconstructs to its one legal answer", (_label, input, expected) => {
    expect(labelOf(reconstructAfterRestart(input))).toBe(expected);
  });

  it("produces exactly the hand-written answer set and nothing wider", () => {
    const produced = new Set(SEEDS.map(([, input]) => labelOf(reconstructAfterRestart(input))));
    const expected = new Set(SEEDS.map(([, , label]) => label));
    expect(produced.size).toBeGreaterThan(0);
    expect([...produced].sort()).toEqual([...expected].sort());
  });

  it("reaches every declared post state, so none is dead vocabulary", () => {
    const reached = new Set(
      SEEDS.map(([, input]) => reconstructAfterRestart(input))
        .filter((outcome) => outcome.kind === "RECONSTRUCTED")
        .map((outcome) => (outcome.kind === "RECONSTRUCTED" ? outcome.postState : "")),
    );
    expect([...reached].sort()).toEqual([...RESTART_POST_STATES].sort());
  });
});

describe("no seed may produce a premature terminal", () => {
  it("refuses a terminal the records cannot prove, naming the restart layer", () => {
    const outcome = reconstructAfterRestart(
      seed({
        intent: makeIntent({ state: "CANCELLED" }),
        attempt: null,
        attemptState: "TERMINAL",
        grant: null,
        registration: null,
        lockState: "RELEASED",
        resourceFact: "PROVEN_RELEASED",
      }),
    );
    const failure = failureOf(outcome);
    expect(failure.code).toBe("RESTART_PREMATURE_TERMINAL");
    expect(failure.layer).toBe("RESTART");
  });

  it("never labels a terminal while a resource is still unverifiable", () => {
    const outcome = reconstructAfterRestart(
      seed({
        intent: makeIntent({ state: "SUCCEEDED" }),
        attempt: null,
        attemptState: "TERMINAL",
        grant: null,
        registration: null,
        lockState: "RELEASED",
        reconciliation: RECONCILED,
        resourceFact: "UNKNOWN",
      }),
    );
    expect(labelOf(outcome)).toBe("post:UNKNOWN");
  });
});

describe("RELEASED without a handoff is its own refusal, not generic incoherence", () => {
  const releasing = {
    attempt: null,
    attemptState: "DRAINING",
    resourceFact: "PROVEN_RELEASED",
    reconciliation: RECONCILED,
    disposition: disposition("WORK_RELEASE_OR_PAUSE", "RELEASED"),
  };

  it("names RESTART_SAFE_HANDOFF_ABSENT at the RESTART layer", () => {
    const failure = failureOf(reconstructAfterRestart(seed(releasing)));
    expect(failure.code).toBe("RESTART_SAFE_HANDOFF_ABSENT");
    expect(failure.layer).toBe("RESTART");
  });

  it("is distinguishable from the identical fact refused by the drain layer", () => {
    const failure = failureOf(reconstructAfterRestart(seed(releasing)));
    expect(failure.code).not.toBe("RESTART_RECORDS_INCOHERENT");
    expect(failure.layer).not.toBe("DRAIN");
  });
});

/**
 * The restart reader and `resolveDuplicateDelivery` read the same claim and
 * registration. Each clause below is isolated so one identity field decides it;
 * the control at the end proves the bound shape is still adopted, so a refusal
 * above cannot be a broken fixture.
 */
describe("a claim, grant and registration that disagree about identity never adopt", () => {
  it("lands on SUSPECT when the registration names another wrapper", () => {
    const outcome = reconstructAfterRestart(
      seed({ registration: { ...REGISTRATION, wrapperIdentity: "wrapper-other" } }),
    );
    expect(labelOf(outcome)).toBe("post:SUSPECT");
    expect(outcome.kind === "RECONSTRUCTED" && outcome.capacityHeld).toBe(false);
  });

  it("lands on SUSPECT when the registration names another lock", () => {
    const outcome = reconstructAfterRestart(
      seed({ registration: { ...REGISTRATION, lockIdentity: "lock-other" } }),
    );
    expect(labelOf(outcome)).toBe("post:SUSPECT");
  });

  it("refuses a claim bound to another intent as incoherent at the RESTART layer", () => {
    const failure = failureOf(
      reconstructAfterRestart(seed({ claim: makeClaim({ intentId: "intent-other" }) })),
    );
    expect([failure.code, failure.layer]).toEqual(["RESTART_RECORDS_INCOHERENT", "RESTART"]);
    expect(failure.message).toBe("the claim is not bound to this effect intent");
  });

  it("refuses a grant minted to a wrapper other than the claimant", () => {
    // The registration follows the claim so the binding clause stays satisfied
    // and only the grant's wrapper decides.
    const failure = failureOf(
      reconstructAfterRestart(
        seed({
          claim: makeClaim({ wrapperIdentity: "wrapper-other" }),
          registration: { ...REGISTRATION, wrapperIdentity: "wrapper-other" },
        }),
      ),
    );
    expect([failure.code, failure.layer]).toEqual(["RESTART_RECORDS_INCOHERENT", "RESTART"]);
    expect(failure.message).toBe("the grant was issued to a wrapper other than the claimant");
  });

  it("does not let a lock the reader cannot see pre-empt an identity refusal", () => {
    const failure = failureOf(
      reconstructAfterRestart(
        seed({ claim: makeClaim({ intentId: "intent-other" }), lockState: "UNKNOWN" }),
      ),
    );
    expect(failure.code).toBe("RESTART_RECORDS_INCOHERENT");
  });

  it("still adopts the bound shape, so the refusals above are not fixture breakage", () => {
    const outcome = reconstructAfterRestart(seed());
    expect(labelOf(outcome)).toBe("post:ACTIVE_ADOPTED");
    expect(outcome.kind === "RECONSTRUCTED" && outcome.capacityHeld).toBe(true);
  });
});

describe("malformed record sets refuse rather than guess", () => {
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ["a non-record", "RUNNING"],
    ["an extra key", { ...(seed() as object), shadow: 1 }],
    ["an intent that does not parse", seed({ intent: {} })],
    ["an undeclared attempt state", seed({ attemptState: "HOVERING" })],
    ["an undeclared lock state", seed({ lockState: "MAYBE" })],
    ["a claim that does not parse", seed({ claim: { claimId: "claim-1" } })],
  ];

  it.each(malformed)("refuses %s as incoherent", (_label, input) => {
    const failure = failureOf(reconstructAfterRestart(input));
    expect(failure.code).toBe("RESTART_RECORDS_INCOHERENT");
    expect(failure.layer).toBe("RESTART");
  });
});
