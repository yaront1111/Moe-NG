/**
 * The exhaustive provider-observation -> effect-settlement mapping.
 *
 * The 120 cases below are GENERATED from the frozen vocabularies published on
 * the package root, never transcribed: a member added upstream widens this sweep
 * instead of silently escaping it. The counts are asserted because a sweep that
 * produces zero cases passes every arm while testing nothing.
 *
 * Each case pins the EXACT outcome — the terminal state the reducer reached, the
 * `MUST_DRAIN` path, or the refusal code AND the layer that answered — because
 * more than one layer can refuse here (this module, then the lifecycle reducer)
 * and a test pinning only "it refused" stays green once the wrong one answers.
 */
import { expect, it } from "vitest";

import {
  CLAUDE_RECONCILED_OUTCOMES,
  PROVIDER_INFRASTRUCTURE_OUTCOMES,
  PROVIDER_TELEMETRY_CONTRACT_VERSION,
  PROVIDER_TERMINAL_OUTCOMES,
  applyEffectCommand,
} from "@moe/runner";

import { canonicalDigest } from "../canonical.js";
import {
  AT,
  DIGEST,
  makeIntent,
  withExtraKey,
  withGetter,
  type Overrides,
} from "./effect-test-fixtures.js";
import {
  settleEffectFromProviderObservation,
  type ProviderSettlementOutcome,
} from "./provider-effect-settlement.js";
import {
  PROVIDER_EFFECT_SETTLEMENT_LAYER,
  PROVIDER_EFFECT_SETTLEMENT_VERSION,
  PROVIDER_RUN_OBSERVATION_KEYS,
  PROVIDER_SETTLEMENT_ADMITTED_ROWS,
  PROVIDER_SETTLEMENT_CODES,
  type ProviderRunObservation,
} from "./provider-settlement-contracts.js";

/** The two intent states DoD 2 names; every other state is covered separately. */
const SETTLEABLE_STATES = ["ACTIVE", "CANCEL_REQUESTED"] as const;

interface Cell {
  readonly from: (typeof SETTLEABLE_STATES)[number];
  readonly terminal: (typeof PROVIDER_TERMINAL_OUTCOMES)[number];
  readonly infrastructure: (typeof PROVIDER_INFRASTRUCTURE_OUTCOMES)[number];
}

const CASES: readonly Cell[] = SETTLEABLE_STATES.flatMap((from) =>
  PROVIDER_TERMINAL_OUTCOMES.flatMap((terminal) =>
    PROVIDER_INFRASTRUCTURE_OUTCOMES.map((infrastructure) => ({ from, terminal, infrastructure })),
  ),
);

const cellKey = (cell: Cell): string => `${cell.from}|${cell.terminal}|${cell.infrastructure}`;

/**
 * The FOUR admitted cells, hand-written from DoD 2 rather than derived from the
 * production table — a expectation computed by the same rule it checks would
 * assert only that the rule equals itself.
 */
const EXPECTED_BY_CELL: ReadonlyMap<string, string> = new Map([
  ["ACTIVE|COMPLETED|NONE", "TERMINAL:SUCCEEDED"],
  ["ACTIVE|ERROR_DURING_EXECUTION|NONE", "TERMINAL:FAILED"],
  ["ACTIVE|CANCELLED|NONE", "MUST_DRAIN"],
  ["CANCEL_REQUESTED|CANCELLED|NONE", "TERMINAL:CANCELLED"],
]);
/** Everything a provider did not prove stays honestly UNKNOWN. */
const UNPROVEN = "TERMINAL:UNKNOWN";

function observation(overrides: Overrides = {}): unknown {
  return {
    sourceVersion: PROVIDER_TELEMETRY_CONTRACT_VERSION,
    sourceDigest: DIGEST.reconciliation,
    runRef: {
      provider: "claude",
      runRef: "run-1",
      effectIntentId: "intent-1",
      attemptRef: "attempt-1",
      epoch: 11,
    },
    terminal: "COMPLETED",
    infrastructure: "NONE",
    upstreamRefusal: null,
    completedAt: { known: true, value: AT },
    ...overrides,
  };
}

/**
 * Collapses an outcome to one comparable label. The refusal arms carry both the
 * code and the layer so a cell answered by a different layer cannot pass as the
 * cell it was written for.
 */
function label(outcome: ProviderSettlementOutcome): string {
  switch (outcome.kind) {
    case "TRANSITIONED":
      return `TERMINAL:${outcome.intent.state}`;
    case "MUST_DRAIN":
      return "MUST_DRAIN";
    case "REFUSED":
      return `REFUSED:${outcome.failure.code}:${outcome.failure.layer}`;
    default:
      return `PROVIDER_SETTLEMENT_REFUSED:${outcome.failure.code}:${outcome.failure.layer}`;
  }
}

it("sweeps the whole published cross product, and generates a positive case count", () => {
  // Read off the frozen vocabularies, so an added member fails loudly here
  // rather than being skipped by a stale transcription below.
  expect(PROVIDER_TERMINAL_OUTCOMES.length).toBe(6);
  expect(PROVIDER_INFRASTRUCTURE_OUTCOMES.length).toBe(10);
  expect(CASES.length).toBeGreaterThan(0);
  expect(CASES.length).toBe(120);
  expect(new Set(CASES.map(cellKey)).size).toBe(120);
});

it.each(CASES.map((cell) => [cellKey(cell), cell] as const))(
  "maps %s to exactly one settlement outcome",
  (key, cell) => {
    const outcome = settleEffectFromProviderObservation(
      makeIntent({ state: cell.from }),
      observation({ terminal: cell.terminal, infrastructure: cell.infrastructure }),
    );
    expect(label(outcome)).toBe(EXPECTED_BY_CELL.get(key) ?? UNPROVEN);
  },
);

/* ---- the four admitted cells, each named, plus the fail-closed default ---- */

const settle = (from: string, overrides: Overrides = {}): ProviderSettlementOutcome =>
  settleEffectFromProviderObservation(makeIntent({ state: from }), observation(overrides));

/**
 * Hand-written mirrors of the two digest preimages this module documents. They
 * are transcribed from the contract, never produced by calling the derivation
 * under test — an expectation computed by the production helper would assert
 * only that the helper equals itself.
 */
const RUN_REF_PREIMAGE = {
  provider: "claude",
  runRef: "run-1",
  effectIntentId: "intent-1",
  attemptRef: "attempt-1",
  epoch: 11,
};

function expectedSettlement(
  terminal: string,
  infrastructure: string,
  outcomeClass: string,
  completedAt: string = AT,
): Record<string, unknown> {
  return {
    reconciliationVersion: PROVIDER_EFFECT_SETTLEMENT_VERSION,
    reconciliationDigest: canonicalDigest({
      settlementVersion: PROVIDER_EFFECT_SETTLEMENT_VERSION,
      sourceVersion: PROVIDER_TELEMETRY_CONTRACT_VERSION,
      sourceDigest: DIGEST.reconciliation,
      runRef: RUN_REF_PREIMAGE,
      terminal,
      infrastructure,
      completedAt,
    }),
    outcomeClass,
  };
}

function expectedUncertainty(
  from: string,
  terminal: string,
  infrastructure: string,
): Record<string, unknown> {
  return {
    uncertaintyReason: "HONEST_UNKNOWN",
    uncertaintyDigest: canonicalDigest({
      settlementVersion: PROVIDER_EFFECT_SETTLEMENT_VERSION,
      unprovenFrom: from,
      terminal,
      infrastructure,
      runRef: RUN_REF_PREIMAGE,
      sourceDigest: DIGEST.reconciliation,
    }),
  };
}

it("admits an infrastructure-clean proven completion on an ACTIVE intent as SUCCEEDED", () => {
  const outcome = settle("ACTIVE", { terminal: "COMPLETED", infrastructure: "NONE" });
  expect(outcome.kind).toBe("TRANSITIONED");
  if (outcome.kind !== "TRANSITIONED") return;
  expect(outcome.intent.state).toBe("SUCCEEDED");
  expect(outcome.result?.outcomeClass).toBe("PROVEN_RESULT");
});

it("admits an infrastructure-clean proven error on an ACTIVE intent as FAILED", () => {
  const outcome = settle("ACTIVE", { terminal: "ERROR_DURING_EXECUTION", infrastructure: "NONE" });
  expect(outcome.kind).toBe("TRANSITIONED");
  if (outcome.kind !== "TRANSITIONED") return;
  expect(outcome.intent.state).toBe("FAILED");
  expect(outcome.result?.outcomeClass).toBe("CRASHED");
});

it("reaches CANCELLED from a clean cancellation ONLY through a CANCEL_REQUESTED intent", () => {
  const requested = settle("CANCEL_REQUESTED", { terminal: "CANCELLED", infrastructure: "NONE" });
  expect(requested.kind).toBe("TRANSITIONED");
  if (requested.kind !== "TRANSITIONED") return;
  expect(requested.intent.state).toBe("CANCELLED");
  expect(requested.result?.outcomeClass).toBe("CANCELLED_CLEAN");
});

/**
 * MUST_DRAIN is a third outcome KIND, not a refusal: the reducer's own header
 * says a caller matching on refusal codes would retry a rejected command. So the
 * assertion is on `drainRequired` and an UNMOVED version, not on a code.
 */
it("returns the production MUST_DRAIN path for a cancellation observed on an ACTIVE intent", () => {
  const outcome = settle("ACTIVE", { terminal: "CANCELLED", infrastructure: "NONE" });
  expect(outcome.kind).toBe("MUST_DRAIN");
  if (outcome.kind !== "MUST_DRAIN") return;
  expect(outcome.drainRequired).toBe(true);
  expect(outcome.versionDelta).toBe(0);
  expect(outcome.intent.state).toBe("ACTIVE");
  expect(outcome.intent.version).toBe(makeIntent().version);
  expect(outcome).toEqual(applyEffectCommand(makeIntent({ state: "ACTIVE" }), { kind: "requestCancel" }));
});

/**
 * The cell a future reader is most likely to "fix". `MAX_TURNS_EXHAUSTED` and
 * `REFUSED` are genuine terminal provider facts, but neither is a completion or
 * an error, so neither may buy SUCCEEDED or FAILED even with clean infrastructure.
 */
it.each([
  ["ACTIVE", "MAX_TURNS_EXHAUSTED"],
  ["ACTIVE", "REFUSED"],
  ["CANCEL_REQUESTED", "MAX_TURNS_EXHAUSTED"],
  ["CANCEL_REQUESTED", "REFUSED"],
] as const)("keeps %s + clean %s honestly UNKNOWN, never SUCCEEDED or FAILED", (from, terminal) => {
  const outcome = settle(from, { terminal, infrastructure: "NONE" });
  expect(outcome.kind).toBe("TRANSITIONED");
  if (outcome.kind !== "TRANSITIONED") return;
  expect(outcome.intent.state).toBe("UNKNOWN");
  expect(outcome.result?.terminalState).toBe("UNKNOWN");
  expect(outcome.result?.outcomeClass).toBe("HONEST_UNKNOWN");
});

/**
 * An UNKNOWN settlement carries the uncertainty evidence the reducer demands.
 * The reducer refuses `EFFECT_UNCERTAINTY_EVIDENCE_REQUIRED` without it (positive
 * control below), so a TRANSITIONED UNKNOWN proves it was supplied; the digest
 * equality proves WHICH evidence, since a null uncertainty digests differently.
 */
it("settles an unproven cell as UNKNOWN carrying the uncertainty evidence the reducer demands", () => {
  const outcome = settle("ACTIVE", { terminal: "COMPLETED", infrastructure: "CAPTURE_TRUNCATED" });
  expect(outcome.kind).toBe("TRANSITIONED");
  if (outcome.kind !== "TRANSITIONED") return;
  const settlement = expectedSettlement("COMPLETED", "CAPTURE_TRUNCATED", "HONEST_UNKNOWN");
  const uncertainty = expectedUncertainty("ACTIVE", "COMPLETED", "CAPTURE_TRUNCATED");
  expect(outcome.result?.settlementDigest).toBe(canonicalDigest({ settlement, uncertainty }));
  expect(outcome.result?.settlementDigest).not.toBe(
    canonicalDigest({ settlement, uncertainty: null }),
  );
});

it("is checked against a reducer that really does demand uncertainty evidence", () => {
  // Positive control for the test above: without it, "TRANSITIONED to UNKNOWN"
  // would prove nothing about the evidence that reached the reducer.
  const refused = applyEffectCommand(makeIntent({ state: "ACTIVE" }), {
    kind: "settle",
    target: "UNKNOWN",
    settlement: expectedSettlement("COMPLETED", "CAPTURE_TRUNCATED", "HONEST_UNKNOWN"),
    uncertainty: null,
    adoptedAt: AT,
  });
  expect(refused.kind).toBe("REFUSED");
  if (refused.kind !== "REFUSED") return;
  expect(refused.failure.code).toBe("EFFECT_UNCERTAINTY_EVIDENCE_REQUIRED");
  expect(refused.failure.layer).toBe("LIFECYCLE");
});

/* ---- the input contract, the binding, and the hostile arms ---- */

/**
 * TYPE-LEVEL, and therefore enforced by `pnpm --filter @moe/runner typecheck`
 * rather than by vitest: this package's test script runs without `--typecheck`,
 * so `expectTypeOf` would be a no-op here. Each alias resolves to `never` — and
 * the assignment stops compiling — the moment the observation grows a field that
 * would let a caller SUPPLY the authority this module exists to derive.
 */
type Forbids<K extends string> = K extends keyof ProviderRunObservation ? never : true;
const FORBIDS_TARGET: Forbids<"target"> = true;
const FORBIDS_OUTCOME_CLASS: Forbids<"outcomeClass"> = true;
const FORBIDS_UNCERTAINTY: Forbids<"uncertainty"> = true;
const FORBIDS_ADOPTED_AT: Forbids<"adoptedAt"> = true;
const FORBIDS_RESULT: Forbids<"result"> = true;
const FORBIDS_TERMINAL_STATE: Forbids<"terminalState"> = true;
const FORBIDS_INTENT: Forbids<"intent"> = true;

const refusal = (outcome: ProviderSettlementOutcome): string => label(outcome);

it("admits an exact key set that cannot express a caller-chosen settlement", () => {
  expect([...PROVIDER_RUN_OBSERVATION_KEYS].sort()).toEqual([
    "completedAt",
    "infrastructure",
    "runRef",
    "sourceDigest",
    "sourceVersion",
    "terminal",
    "upstreamRefusal",
  ]);
  expect([
    FORBIDS_TARGET, FORBIDS_OUTCOME_CLASS, FORBIDS_UNCERTAINTY, FORBIDS_ADOPTED_AT,
    FORBIDS_RESULT, FORBIDS_TERMINAL_STATE, FORBIDS_INTENT,
  ]).toEqual([true, true, true, true, true, true, true]);
});

it.each(["target", "outcomeClass", "uncertainty", "adoptedAt", "result", "terminalState", "intent"])(
  "refuses an observation carrying the substitute authority key %s",
  (key) => {
    const outcome = settleEffectFromProviderObservation(
      makeIntent({ state: "ACTIVE" }),
      withExtraKey(observation() as object, key, "SUCCEEDED"),
    );
    expect(refusal(outcome)).toBe(
      `PROVIDER_SETTLEMENT_REFUSED:PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED:${PROVIDER_EFFECT_SETTLEMENT_LAYER}`,
    );
  },
);

it("refuses a well-formed run reference that names a foreign intent", () => {
  const outcome = settleEffectFromProviderObservation(
    makeIntent({ state: "ACTIVE" }),
    observation({
      runRef: {
        provider: "claude", runRef: "run-1", effectIntentId: "intent-999",
        attemptRef: "attempt-1", epoch: 11,
      },
    }),
  );
  expect(refusal(outcome)).toBe(
    `PROVIDER_SETTLEMENT_REFUSED:PROVIDER_SETTLEMENT_EFFECT_BINDING_MISMATCH:${PROVIDER_EFFECT_SETTLEMENT_LAYER}`,
  );
});

/**
 * Two DISTINCT refusals, deliberately not folded: `null` means nothing was ever
 * recorded, and the `{known: false}` arm means the provider recorded that it does
 * not know. A third arm covers text that is present and readable but is not an
 * instant, which is a malformed record rather than an absent fact.
 */
it.each([
  [null, "PROVIDER_SETTLEMENT_COMPLETION_INSTANT_ABSENT"],
  [
    { known: false, code: "TELEMETRY_RESULT_ABSENT", layer: "TELEMETRY_RESULT" },
    "PROVIDER_SETTLEMENT_COMPLETION_INSTANT_UNKNOWN",
  ],
  [{ known: true, value: "yesterday" }, "PROVIDER_SETTLEMENT_COMPLETION_INSTANT_MALFORMED"],
] as const)("tells the completion-instant arms apart (%o -> %s)", (completedAt, code) => {
  const outcome = settleEffectFromProviderObservation(
    makeIntent({ state: "ACTIVE" }),
    observation({ completedAt }),
  );
  expect(refusal(outcome)).toBe(
    `PROVIDER_SETTLEMENT_REFUSED:${code}:${PROVIDER_EFFECT_SETTLEMENT_LAYER}`,
  );
});

it.each([
  ["sourceVersion", "moe-provider-telemetry/99", "PROVIDER_SETTLEMENT_SOURCE_VERSION_UNSUPPORTED"],
  ["sourceDigest", "not-a-digest", "PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED"],
  ["terminal", "COMPLETED_MAYBE", "PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED"],
  ["infrastructure", "MOSTLY_FINE", "PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED"],
  ["runRef", { provider: "codex", runRef: "run-1", effectIntentId: "intent-1", attemptRef: "a", epoch: 11 }, "PROVIDER_SETTLEMENT_RUN_REF_MALFORMED"],
  [
    "upstreamRefusal",
    { ok: false, code: "TELEMETRY_RESULT_ABSENT", layer: "TELEMETRY_RESULT", message: "no result" },
    "PROVIDER_SETTLEMENT_UPSTREAM_REFUSED",
  ],
] as const)("refuses a %s the source evidence cannot support", (key, value, code) => {
  const outcome = settleEffectFromProviderObservation(
    makeIntent({ state: "ACTIVE" }),
    observation({ [key]: value }),
  );
  expect(refusal(outcome)).toBe(
    `PROVIDER_SETTLEMENT_REFUSED:${code}:${PROVIDER_EFFECT_SETTLEMENT_LAYER}`,
  );
});

it.each([
  ["an accessor-supplied terminal", withGetter(observation() as object, "terminal", "COMPLETED")],
  ["an accessor-supplied run reference", withGetter(observation() as object, "runRef", null)],
  ["an own __proto__ key", withExtraKey(observation() as object, "__proto__", { terminal: "x" })],
  ["a proxy", new Proxy(observation() as object, {})],
  ["a non-record", "COMPLETED"],
  ["a null observation", null],
])("refuses %s before any fact reaches the derivation", (_name, hostile) => {
  const outcome = settleEffectFromProviderObservation(makeIntent({ state: "ACTIVE" }), hostile);
  expect(refusal(outcome)).toBe(
    `PROVIDER_SETTLEMENT_REFUSED:PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED:${PROVIDER_EFFECT_SETTLEMENT_LAYER}`,
  );
});

/**
 * A FROZEN well-formed observation is admitted, not refused: freezing is what a
 * careful caller does, and refusing it would make the seam unusable. What this
 * pins is that the function derives from a value it never mutates — a derivation
 * that wrote back into its input would throw on a frozen record.
 */
it("admits a frozen observation and answers exactly as it does for a mutable one", () => {
  const frozen = Object.freeze(observation() as object);
  expect(settleEffectFromProviderObservation(makeIntent({ state: "ACTIVE" }), frozen)).toEqual(
    settleEffectFromProviderObservation(makeIntent({ state: "ACTIVE" }), observation()),
  );
});

it("refuses a malformed intent with its own code before reading the observation", () => {
  const outcome = settleEffectFromProviderObservation(
    withExtraKey(makeIntent() as object, "extra", 1),
    observation(),
  );
  expect(refusal(outcome)).toBe(
    `PROVIDER_SETTLEMENT_REFUSED:PROVIDER_SETTLEMENT_INTENT_MALFORMED:${PROVIDER_EFFECT_SETTLEMENT_LAYER}`,
  );
});

/**
 * DoD 3: a refusal the REDUCER made keeps the reducer's own code AND layer. Both
 * fields are asserted — a code-only assertion would stay green if this module
 * started restamping the layer with its own.
 */
it("surfaces the reducer's terminal absorption unchanged, code and layer", () => {
  const outcome = settleEffectFromProviderObservation(
    makeIntent({ state: "SUCCEEDED" }),
    observation(),
  );
  expect(outcome.kind).toBe("REFUSED");
  if (outcome.kind !== "REFUSED") return;
  expect(outcome.failure.code).toBe("EFFECT_TERMINAL_ABSORBED");
  expect(outcome.failure.layer).toBe("LIFECYCLE");
});

it("surfaces the reducer's unadmitted-arc refusal for a pre-activation intent", () => {
  const outcome = settleEffectFromProviderObservation(makeIntent({ state: "ARMED" }), observation());
  expect(refusal(outcome)).toBe("REFUSED:EFFECT_TRANSITION_NOT_ADMITTED:LIFECYCLE");
});

/* ---- the accepted control, and the counterexample this task closes ---- */

/**
 * THE ACCEPTED CONTROL. A suite made only of refusals is blind to a wrong
 * ACCEPTED value, so every `EffectResult` field is named. The expected digest is
 * derived independently, from the observation this test seeded, through the
 * shared canonical primitive — never by calling the derivation under test.
 */
it("returns the reducer's exact frozen result for an infrastructure-clean completion", () => {
  const outcome = settle("ACTIVE", { terminal: "COMPLETED", infrastructure: "NONE" });
  expect(outcome.kind).toBe("TRANSITIONED");
  if (outcome.kind !== "TRANSITIONED") return;
  expect(outcome.result).toEqual({
    resultVersion: "moe-effect-result/1",
    intentId: "intent-1",
    terminalState: "SUCCEEDED",
    outcomeClass: "PROVEN_RESULT",
    settlementDigest: canonicalDigest({
      settlement: expectedSettlement("COMPLETED", "NONE", "PROVEN_RESULT"),
      uncertainty: null,
    }),
    adoptedAt: AT,
  });
  // The successor intent is the reducer's own: one version step, every other
  // field carried through untouched.
  expect(outcome.intent).toEqual({
    ...(makeIntent({ state: "ACTIVE" }) as unknown as Record<string, unknown>),
    state: "SUCCEEDED",
    version: makeIntent().version + 1,
  });
  expect(outcome.versionDelta).toBe(1);
  expect(Object.isFrozen(outcome.result)).toBe(true);
  expect(Object.isFrozen(outcome.intent)).toBe(true);
});

/**
 * THE COUNTEREXAMPLE. Measured at HEAD before this module existed: the public
 * `applyEffectCommand` transitions ACTIVE -> SUCCEEDED when a caller pairs
 * `target: "SUCCEEDED"` with `outcomeClass: "HONEST_UNKNOWN"`. Nothing routed
 * through this function can reach that pairing, because the caller supplies no
 * target at all. The assertion pins the SPECIFIC outcome the table declares as
 * well as the negative, so it cannot pass because an unrelated guard answered.
 */
it("can never turn provider-unknown evidence on an ACTIVE intent into SUCCEEDED", () => {
  const outcome = settle("ACTIVE", { terminal: "UNKNOWN", infrastructure: "UNKNOWN" });
  expect(label(outcome)).toBe(UNPROVEN);
  expect(outcome.kind).toBe("TRANSITIONED");
  if (outcome.kind !== "TRANSITIONED") return;
  expect(outcome.intent.state).not.toBe("SUCCEEDED");
  expect(outcome.result?.terminalState).toBe("UNKNOWN");
  expect(outcome.result?.outcomeClass).toBe("HONEST_UNKNOWN");
  expect(outcome.result?.settlementDigest).toBe(
    canonicalDigest({
      settlement: expectedSettlement("UNKNOWN", "UNKNOWN", "HONEST_UNKNOWN"),
      uncertainty: expectedUncertainty("ACTIVE", "UNKNOWN", "UNKNOWN"),
    }),
  );
});

it("reaches SUCCEEDED and FAILED from exactly one generated cell each", () => {
  const reached = (wanted: string): readonly string[] =>
    CASES.filter(
      (cell) =>
        label(
          settleEffectFromProviderObservation(
            makeIntent({ state: cell.from }),
            observation({ terminal: cell.terminal, infrastructure: cell.infrastructure }),
          ),
        ) === wanted,
    ).map(cellKey);
  expect(reached("TERMINAL:SUCCEEDED")).toEqual(["ACTIVE|COMPLETED|NONE"]);
  expect(reached("TERMINAL:FAILED")).toEqual(["ACTIVE|ERROR_DURING_EXECUTION|NONE"]);
  expect(reached("TERMINAL:CANCELLED")).toEqual(["CANCEL_REQUESTED|CANCELLED|NONE"]);
  expect(reached("MUST_DRAIN")).toEqual(["ACTIVE|CANCELLED|NONE"]);
  expect(reached(UNPROVEN).length).toBe(116);
});

/**
 * The run epoch is EVIDENCE, not a second binding: `ProviderRunRef.epoch` and
 * `EffectIntent.expectedGraphEpoch` are counters from different domains, and
 * equating them would invent an authority this module has no basis for. What is
 * pinned instead is that the epoch reaches the digest — an observation from
 * another epoch settles to a DIFFERENT settlement digest, so it can never be
 * swapped in silently under an identical receipt.
 */
it("binds the observed run epoch into the settlement digest rather than ignoring it", () => {
  const drifted = settleEffectFromProviderObservation(
    makeIntent({ state: "ACTIVE" }),
    observation({
      runRef: {
        provider: "claude", runRef: "run-1", effectIntentId: "intent-1",
        attemptRef: "attempt-1", epoch: 12,
      },
    }),
  );
  const base = settle("ACTIVE");
  expect(drifted.kind).toBe("TRANSITIONED");
  expect(base.kind).toBe("TRANSITIONED");
  if (drifted.kind !== "TRANSITIONED" || base.kind !== "TRANSITIONED") return;
  expect(drifted.result?.settlementDigest).not.toBe(base.result?.settlementDigest);
});

/**
 * The reducer's counter ceiling reaches the caller with the reducer's own code
 * and layer. An intent AT the ceiling still parses, so this is a live arm rather
 * than an unreachable one, and it is a second witness that this module carries
 * reducer refusals rather than restamping them.
 */
it("surfaces the reducer's exhausted counter unchanged, code and layer", () => {
  const outcome = settleEffectFromProviderObservation(
    makeIntent({ state: "ACTIVE", version: Number.MAX_SAFE_INTEGER - 1_000_000 }),
    observation(),
  );
  expect(refusal(outcome)).toBe("REFUSED:EFFECT_COUNTER_EXHAUSTED:LIFECYCLE");
});

it("publishes the settlement tables frozen, so no consumer can widen the mapping", () => {
  expect(Object.isFrozen(PROVIDER_SETTLEMENT_ADMITTED_ROWS)).toBe(true);
  expect(PROVIDER_SETTLEMENT_ADMITTED_ROWS.every((row) => Object.isFrozen(row))).toBe(true);
  expect(Object.isFrozen(PROVIDER_RUN_OBSERVATION_KEYS)).toBe(true);
  expect(Object.isFrozen(PROVIDER_SETTLEMENT_CODES)).toBe(true);
  expect(PROVIDER_SETTLEMENT_ADMITTED_ROWS.length).toBe(4);
});

it("publishes a closed refusal vocabulary every arm above draws from", () => {
  expect(PROVIDER_SETTLEMENT_CODES.length).toBeGreaterThan(0);
  expect([...PROVIDER_SETTLEMENT_CODES].sort()).toEqual([
    "PROVIDER_SETTLEMENT_COMPLETION_INSTANT_ABSENT",
    "PROVIDER_SETTLEMENT_COMPLETION_INSTANT_MALFORMED",
    "PROVIDER_SETTLEMENT_COMPLETION_INSTANT_UNKNOWN",
    "PROVIDER_SETTLEMENT_EFFECT_BINDING_MISMATCH",
    "PROVIDER_SETTLEMENT_INTENT_MALFORMED",
    "PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED",
    "PROVIDER_SETTLEMENT_RUN_REF_MALFORMED",
    "PROVIDER_SETTLEMENT_SOURCE_VERSION_UNSUPPORTED",
    "PROVIDER_SETTLEMENT_UPSTREAM_REFUSED",
  ]);
});

it("spends only outcome classes the provider reconciliation vocabulary already publishes", () => {
  // Pins REUSE: a locally minted outcome-class literal would fail here rather
  // than quietly forking a second vocabulary for the same field.
  const classes = [
    settle("ACTIVE", { terminal: "COMPLETED", infrastructure: "NONE" }),
    settle("ACTIVE", { terminal: "ERROR_DURING_EXECUTION", infrastructure: "NONE" }),
    settle("CANCEL_REQUESTED", { terminal: "CANCELLED", infrastructure: "NONE" }),
    settle("ACTIVE", { terminal: "UNKNOWN", infrastructure: "UNKNOWN" }),
  ].map((outcome) => (outcome.kind === "TRANSITIONED" ? outcome.result?.outcomeClass : null));
  expect(classes).toEqual(["PROVEN_RESULT", "CRASHED", "CANCELLED_CLEAN", "HONEST_UNKNOWN"]);
  for (const outcomeClass of classes) {
    expect(CLAUDE_RECONCILED_OUTCOMES).toContain(outcomeClass);
  }
});
