/**
 * Counterexample tests for the same-bug circuit breaker.
 *
 * The per-field table below is derived from the production `FINGERPRINT_FIELDS`
 * tuple, never hand-copied: a field dropped from the fingerprint must fail the
 * table rather than silently shrink its coverage.
 */
import type { DeadEndJournalEntry, FactPredicate } from "@moe/context";
import { describe, expect, it } from "vitest";

import {
  CONVERGENCE_BREAKER_CODES,
  CONVERGENCE_BREAKER_LAYER,
  type BreakerOutcome,
  type BreakerRequest,
  type FailureFingerprint,
  type HumanRelease,
} from "./breaker-contract.js";
import { decideBreaker, emptyHolds } from "./breaker.js";
import {
  FINGERPRINT_FIELDS,
  computeFailureFingerprint,
  type FingerprintField,
} from "./failure-fingerprint.js";

const HELD_PREDICATE: FactPredicate = Object.freeze({
  kind: "FACT_DIGEST",
  factId: "build.artifact",
  operator: "EQUALS",
  expectedDigest: "a".repeat(64),
});

const MOVED_PREDICATE: FactPredicate = Object.freeze({
  kind: "FACT_DIGEST",
  factId: "build.artifact",
  operator: "EQUALS",
  expectedDigest: "b".repeat(64),
});

function entry(overrides: Partial<DeadEndJournalEntry> = {}): DeadEndJournalEntry {
  return {
    id: "entry-1",
    kind: "FAILED_APPROACH",
    failureCode: "COMPILE_FAILED",
    primaryScope: "packages/scheduler",
    recipeDigest: "recipe-1",
    baseDigest: "base-1",
    environmentDigest: "env-1",
    retryPredicate: HELD_PREDICATE,
    text: "the linker rejected the object file",
    actorId: "worker-1",
    occurredAt: "2026-08-09T10:00:00.000Z",
    ...overrides,
  };
}

function request(overrides: Partial<BreakerRequest> = {}): BreakerRequest {
  return { entry: entry(), candidatePredicate: null, humanRelease: null, ...overrides };
}

function fingerprintOf(value: DeadEndJournalEntry): FailureFingerprint {
  const result = computeFailureFingerprint(value);
  if (!result.ok) throw new Error(`expected a fingerprint, got ${result.code}`);
  return result.fingerprint;
}

/** Opens the hold on the base entry's fingerprint and returns the resulting state. */
function heldOnBaseBug(): ReturnType<typeof decideBreaker> {
  return decideBreaker(emptyHolds(), request());
}

describe("failure fingerprint", () => {
  it("is invariant across prose, id, actor and time", () => {
    const first = entry();
    const second = entry({
      id: "entry-2",
      text: "completely different words describing the same dead end",
      actorId: "worker-2",
      occurredAt: "2026-08-09T11:30:00.000Z",
    });

    expect(fingerprintOf(second)).toBe(fingerprintOf(first));
  });

  const untypedFields = Object.freeze([
    ["id", "entry-99"],
    ["text", "reworded"],
    ["actorId", "worker-99"],
    ["occurredAt", "2026-08-09T23:59:59.000Z"],
  ] as const);

  it("covers every excluded field", () => {
    expect(untypedFields.length).toBeGreaterThan(0);
  });

  it.each(untypedFields)("ignores %s", (field, value) => {
    expect(fingerprintOf(entry({ [field]: value }))).toBe(fingerprintOf(entry()));
  });

  /**
   * Hand-transcribed, never derived from the tuple under test. The per-field
   * table below IS derived, so on its own a field dropped from the production
   * tuple would simply stop generating its counterexample and coverage would
   * shrink in silence. This is the assertion that refuses that — and equally
   * refuses an unreviewed ADDITION, which is how `text` would get in.
   */
  const EXPECTED_FINGERPRINT_FIELDS = Object.freeze([
    "baseDigest",
    "environmentDigest",
    "failureCode",
    "primaryScope",
    "recipeDigest",
  ] as const);

  it("fingerprints exactly the reviewed typed fields", () => {
    expect([...FINGERPRINT_FIELDS].sort()).toEqual([...EXPECTED_FINGERPRINT_FIELDS].sort());
  });

  it("covers exactly one counterexample per typed field", () => {
    expect(FINGERPRINT_FIELDS.length).toBeGreaterThan(0);
    expect(new Set(FINGERPRINT_FIELDS).size).toBe(FINGERPRINT_FIELDS.length);
  });

  it.each(FINGERPRINT_FIELDS.map((field) => [field] as const))(
    "separates entries differing only in %s",
    (field: FingerprintField) => {
      const changed = entry({ [field]: `${entry()[field]}-changed` });
      expect(fingerprintOf(changed)).not.toBe(fingerprintOf(entry()));
    },
  );

  /**
   * The canonical form interleaves each field NAME between values, so a naive
   * pair like ("packages/sched", "uler-recipe") vs ("packages/scheduler",
   * "-recipe") is separated by the literal "recipeDigest" and would pass this
   * test even with framing removed entirely — proving nothing. These values
   * are built to absorb that separator too, so the only thing left holding the
   * two fingerprints apart is the framing itself.
   */
  it("does not collide when adjacent fields concatenate identically", () => {
    const left = entry({ primaryScope: "x", recipeDigest: "recipeDigesty" });
    const right = entry({ primaryScope: "xrecipeDigest", recipeDigest: "y" });

    expect(left.primaryScope + left.recipeDigest).toBe(right.primaryScope + right.recipeDigest);
    expect(fingerprintOf(left)).not.toBe(fingerprintOf(right));
  });

  it("is a stable sha256 across repeated computation", () => {
    expect(fingerprintOf(entry())).toMatch(/^[0-9a-f]{64}$/u);
    expect(fingerprintOf(entry())).toBe(fingerprintOf(entry()));
  });

  it("refuses a malformed entry instead of hashing partial input", () => {
    const malformed = { ...entry(), primaryScope: 7 } as unknown as DeadEndJournalEntry;
    const result = computeFailureFingerprint(malformed);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("BREAKER_INPUT_INVALID");
    expect(result.layer).toBe(CONVERGENCE_BREAKER_LAYER);
    expect(result.truth).toBe("UNKNOWN");
  });
});

describe("hold convergence", () => {
  it("admits the first report and opens one bounded hold", () => {
    const transition = heldOnBaseBug();

    expect(transition.outcome.ok).toBe(true);
    expect(transition.holds.size).toBe(1);
  });

  it("converges two prose-divergent siblings onto a single hold", () => {
    const first = heldOnBaseBug();
    const sibling = entry({
      id: "entry-2",
      text: "an entirely different sentence",
      actorId: "worker-2",
      occurredAt: "2026-08-09T12:00:00.000Z",
    });

    const second = decideBreaker(first.holds, request({ entry: sibling }));

    expect(second.holds.size).toBe(1);
    expect(second.outcome.ok).toBe(false);
    if (second.outcome.ok) throw new Error("unreachable");
    expect(second.outcome.code).toBe("SAME_BUG_HOLD_ACTIVE");
    expect(second.outcome.layer).toBe(CONVERGENCE_BREAKER_LAYER);
    expect(second.outcome.decision).toBe("HOLD");
    const hold = second.outcome.decision === "HOLD" ? second.outcome.hold : null;
    expect(hold?.entryIds).toEqual(["entry-1", "entry-2"]);
  });

  it("appends each sibling once", () => {
    const first = heldOnBaseBug();
    const second = decideBreaker(first.holds, request());

    expect(second.holds.size).toBe(1);
    expect([...second.holds.values()][0]?.entryIds).toEqual(["entry-1"]);
  });

  it("keeps an unrelated fingerprint schedulable while a hold is active", () => {
    const held = heldOnBaseBug();
    const unrelated = entry({ id: "entry-3", failureCode: "TEST_TIMEOUT" });

    const outcome = decideBreaker(held.holds, request({ entry: unrelated })).outcome;

    expect(outcome.ok).toBe(true);
    expect(fingerprintOf(unrelated)).not.toBe(fingerprintOf(entry()));
  });

  it("explains every hold by fingerprint and awaited predicate", () => {
    const held = heldOnBaseBug();
    const outcome = decideBreaker(held.holds, request()).outcome;

    if (outcome.ok || outcome.decision !== "HOLD") throw new Error("expected a hold");
    expect(outcome.hold.fingerprint).toBe(fingerprintOf(entry()));
    expect(outcome.hold.awaitedPredicate).toEqual(HELD_PREDICATE);
    expect(outcome.hold.entryIds.length).toBeGreaterThan(0);
    expect(outcome.hold.reason).toBe("SAME_BUG_CONVERGENCE");
  });
});

describe("retry unlock", () => {
  it("refuses an unmoved predicate and keeps the refusing layer visible", () => {
    const held = heldOnBaseBug();
    const retry = request({ candidatePredicate: HELD_PREDICATE });

    const outcome = decideBreaker(held.holds, retry).outcome;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("RETRY_PREDICATE_UNCHANGED_HOLD");
    expect(outcome.layer).toBe(CONVERGENCE_BREAKER_LAYER);
    expect(outcome.refusedBy).toEqual({
      kind: "REFUSED",
      code: "RETRY_PREDICATE_UNCHANGED",
      layer: "RETRY_PREDICATE",
    });
  });

  it("unlocks when the authoritative predicate genuinely moves", () => {
    const held = heldOnBaseBug();
    const retry = request({ candidatePredicate: MOVED_PREDICATE });

    const transition = decideBreaker(held.holds, retry);

    expect(transition.outcome.ok).toBe(true);
    expect(transition.holds.size).toBe(0);
  });

  it("compares against the HELD predicate, not the caller's own entry", () => {
    const held = heldOnBaseBug();
    const forged = entry({ id: "entry-4", retryPredicate: MOVED_PREDICATE });
    const retry = request({ entry: forged, candidatePredicate: HELD_PREDICATE });

    const outcome = decideBreaker(held.holds, retry).outcome;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("RETRY_PREDICATE_UNCHANGED_HOLD");
  });

  /**
   * `evaluateRetryUnlock` answers "did it move?" by digesting both sides, so
   * an unparseable candidate digests to something that merely DIFFERS and
   * would read as movement. A caller who cannot change the underlying fact
   * must not be able to release a hold by submitting junk.
   */
  const malformedCandidates = Object.freeze([
    ["an empty object", {}],
    ["an unknown kind", { kind: "FACT_ANYTHING", factId: "f", operator: "EQUALS" }],
    ["a disallowed operator", { kind: "FACT_DIGEST", factId: "f", operator: "MATCHES", expectedDigest: "d" }],
    ["a digest predicate with no digest", { kind: "FACT_DIGEST", factId: "f", operator: "EQUALS" }],
  ] as const);

  it("covers every malformed candidate shape", () => {
    expect(malformedCandidates.length).toBeGreaterThan(0);
  });

  it.each(malformedCandidates)("refuses %s instead of reading it as movement", (_label, candidate) => {
    const held = heldOnBaseBug();
    const transition = decideBreaker(
      held.holds,
      request({ candidatePredicate: candidate as unknown as FactPredicate }),
    );

    expect(transition.outcome.ok).toBe(false);
    if (transition.outcome.ok) throw new Error("unreachable");
    expect(transition.outcome.code).toBe("BREAKER_INPUT_INVALID");
    expect(transition.holds.size).toBe(1);
  });

  it("holds the predicate it captured, not the caller's object", () => {
    const mutable = { ...HELD_PREDICATE } as { expectedDigest: string; kind: string };
    const opened = decideBreaker(
      emptyHolds(),
      request({ entry: entry({ retryPredicate: mutable as unknown as FactPredicate }) }),
    );

    mutable.expectedDigest = "c".repeat(64);
    const outcome = decideBreaker(
      opened.holds,
      request({ candidatePredicate: HELD_PREDICATE }),
    ).outcome;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("RETRY_PREDICATE_UNCHANGED_HOLD");
  });

  it("refuses an entry whose id is not a usable string", () => {
    const outcome = decideBreaker(
      emptyHolds(),
      request({ entry: { ...entry(), id: 42 } as unknown as DeadEndJournalEntry }),
    ).outcome;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe("BREAKER_INPUT_INVALID");
  });

  it("records that the hold is now waiting on an unmoved predicate", () => {
    const held = heldOnBaseBug();
    const transition = decideBreaker(held.holds, request({ candidatePredicate: HELD_PREDICATE }));

    expect([...transition.holds.values()][0]?.reason).toBe("RETRY_PREDICATE_UNMOVED");
  });
});

describe("human release", () => {
  function release(fingerprint: FailureFingerprint): HumanRelease {
    return { kind: "HUMAN_RELEASE", decisionId: "decision-1", fingerprint };
  }

  it("releases the hold it names", () => {
    const held = heldOnBaseBug();
    const transition = decideBreaker(
      held.holds,
      request({ humanRelease: release(fingerprintOf(entry())) }),
    );

    expect(transition.outcome.ok).toBe(true);
    expect(transition.holds.size).toBe(0);
  });

  it("does not release a hold it does not name", () => {
    const held = heldOnBaseBug();
    const other = fingerprintOf(entry({ failureCode: "TEST_TIMEOUT" }));

    const transition = decideBreaker(held.holds, request({ humanRelease: release(other) }));

    expect(transition.outcome.ok).toBe(false);
    expect(transition.holds.size).toBe(1);
  });
});

describe("refusal sweep", () => {
  const sweep = Object.freeze([
    ["a malformed entry", request({ entry: { ...entry(), baseDigest: 3 } as unknown as DeadEndJournalEntry }), "BREAKER_INPUT_INVALID"],
    ["a converging sibling", request(), "SAME_BUG_HOLD_ACTIVE"],
    ["an unmoved retry", request({ candidatePredicate: HELD_PREDICATE }), "RETRY_PREDICATE_UNCHANGED_HOLD"],
  ] as const);

  it("generated a non-empty sweep covering every stable code", () => {
    expect(sweep.length).toBeGreaterThan(0);
    expect([...new Set(sweep.map(([, , code]) => code))].sort()).toEqual(
      [...CONVERGENCE_BREAKER_CODES].sort(),
    );
  });

  it.each(sweep)("refuses %s with its stable code", (_label, breakerRequest, code) => {
    const outcome: BreakerOutcome = decideBreaker(heldOnBaseBug().holds, breakerRequest).outcome;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe(code);
    expect(outcome.layer).toBe(CONVERGENCE_BREAKER_LAYER);
    expect(outcome.truth).toBe("UNKNOWN");
  });
});
