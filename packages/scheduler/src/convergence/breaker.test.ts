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
  MAX_ACTIVE_HOLDS,
  MAX_HOLD_ENTRY_IDS,
  type BreakerOutcome,
  type BreakerRequest,
  type FailureFingerprint,
  type HumanRelease,
} from "./breaker-contract.js";
import { decideBreaker, emptyHolds, retainHolds } from "./breaker.js";
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

/**
 * Hand-pinned, never read off the constant under test: a cap that silently
 * moves must redden this file, not re-derive it.
 */
const HOLD_CAP = 4096;

let capHoldsMemo: ReturnType<typeof emptyHolds> | null = null;

/**
 * Fills the ledger to the cap with distinct fingerprints (only
 * `environmentDigest` varies). Built once and shared: every transition is pure
 * and never mutates its input map.
 */
function holdsAtCap(): ReturnType<typeof emptyHolds> {
  if (capHoldsMemo !== null) return capHoldsMemo;
  let holds = emptyHolds();
  for (let index = 0; index < HOLD_CAP; index += 1) {
    const report = request({
      entry: entry({ id: `entry-cap-${index}`, environmentDigest: `env-cap-${index}` }),
    });
    const transition = decideBreaker(holds, report);
    if (!transition.outcome.ok) throw new Error(`cap fill refused at index ${index}`);
    holds = transition.holds;
  }
  capHoldsMemo = holds;
  return capHoldsMemo;
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

describe("entry id window", () => {
  /** Hand-pinned like HOLD_CAP: a silently moved window must redden this file. */
  const ENTRY_ID_CAP = 64;

  /** entry-1 opens the hold; entry-2 .. entry-65 join it: 65 distinct ids. */
  function windowFilledHolds(): ReturnType<typeof emptyHolds> {
    let holds = heldOnBaseBug().holds;
    for (let index = 2; index <= ENTRY_ID_CAP + 1; index += 1) {
      holds = decideBreaker(holds, request({ entry: entry({ id: `entry-${index}` }) })).holds;
    }
    return holds;
  }

  it("caps the window at the hand-pinned reviewed value", () => {
    expect(MAX_HOLD_ENTRY_IDS).toBe(ENTRY_ID_CAP);
  });

  it("drops the oldest entry id past the cap and keeps the newest", () => {
    const holds = windowFilledHolds();

    const hold = [...holds.values()][0];
    expect(holds.size).toBe(1);
    expect(hold?.entryIds.length).toBe(ENTRY_ID_CAP);
    expect(hold?.entryIds[0]).toBe("entry-2");
    expect(hold?.entryIds.at(-1)).toBe(`entry-${ENTRY_ID_CAP + 1}`);
    expect(hold?.entryIds).not.toContain("entry-1");
  });

  it("re-reporting an id already in the window neither grows nor reorders it", () => {
    const filled = windowFilledHolds();
    const before = [...filled.values()][0]?.entryIds;

    const again = decideBreaker(
      filled,
      request({ entry: entry({ id: `entry-${ENTRY_ID_CAP + 1}` }) }),
    );

    expect([...again.holds.values()][0]?.entryIds).toEqual(before);
    expect(before?.length).toBe(ENTRY_ID_CAP);
  });

  it("re-appends a dropped id as the newest breadcrumb", () => {
    const again = decideBreaker(windowFilledHolds(), request({ entry: entry({ id: "entry-1" }) }));

    const window = [...again.holds.values()][0]?.entryIds;
    expect(window?.length).toBe(ENTRY_ID_CAP);
    expect(window?.[0]).toBe("entry-3");
    expect(window?.at(-1)).toBe("entry-1");
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

describe("predicate key discipline", () => {
  /**
   * Field checks alone are not enough: a predicate can carry every valid field
   * PLUS an extra key. If the hold (or the compared candidate) is built by
   * spreading the caller's object, that key reaches `canonicalSha256`, where an
   * unserializable value (`junk: undefined`) THROWS inside every later unlock
   * attempt — a crash instead of a refusal — and a serializable one perturbs
   * the digest so byte-identical facts read as movement. Exact per-variant key
   * sets refuse both at the door.
   */
  const junkRetryPredicates = Object.freeze([
    ["an extra undefined-valued key", { ...HELD_PREDICATE, junk: undefined }],
    ["an extra serializable key", { ...HELD_PREDICATE, junk: "perturb" }],
  ] as const);

  it("covers every junk-keyed first report", () => {
    expect(junkRetryPredicates.length).toBeGreaterThan(0);
  });

  it.each(junkRetryPredicates)(
    "refuses a first report whose retry predicate carries %s",
    (_label, predicate) => {
      const transition = decideBreaker(
        emptyHolds(),
        request({ entry: entry({ retryPredicate: predicate as unknown as FactPredicate }) }),
      );

      expect(transition.outcome.ok).toBe(false);
      if (transition.outcome.ok) throw new Error("unreachable");
      expect(transition.outcome.code).toBe("BREAKER_INPUT_INVALID");
      expect(transition.holds.size).toBe(0);
    },
  );

  it("keeps a junk-keyed predicate from poisoning later unlocks", () => {
    const junk = { ...HELD_PREDICATE, junk: undefined } as unknown as FactPredicate;
    const opened = decideBreaker(emptyHolds(), request({ entry: entry({ retryPredicate: junk }) }));

    const retry = decideBreaker(opened.holds, request({ candidatePredicate: MOVED_PREDICATE }));

    expect(opened.outcome.ok).toBe(false);
    expect(retry.outcome.ok).toBe(true);
    expect(retry.holds.size).toBe(1);
  });

  const junkCandidates = Object.freeze([
    ["an extra serializable key", { ...HELD_PREDICATE, junk: "perturb" }],
    ["an extra undefined-valued key", { ...MOVED_PREDICATE, junk: undefined }],
  ] as const);

  it("covers every junk-keyed candidate", () => {
    expect(junkCandidates.length).toBeGreaterThan(0);
  });

  it.each(junkCandidates)(
    "refuses a candidate carrying %s instead of reading it as movement",
    (_label, candidate) => {
      const held = heldOnBaseBug();
      const transition = decideBreaker(
        held.holds,
        request({ candidatePredicate: candidate as unknown as FactPredicate }),
      );

      expect(transition.outcome.ok).toBe(false);
      if (transition.outcome.ok) throw new Error("unreachable");
      expect(transition.outcome.code).toBe("BREAKER_INPUT_INVALID");
      expect(transition.holds.size).toBe(1);
    },
  );
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

describe("hold capacity", () => {
  it("caps the ledger at the hand-pinned reviewed value", () => {
    expect(MAX_ACTIVE_HOLDS).toBe(HOLD_CAP);
  });

  it("refuses to open a hold past the cap and leaves the ledger unchanged", () => {
    const atCap = holdsAtCap();
    const overflow = entry({ id: "entry-cap-overflow", environmentDigest: "env-cap-overflow" });

    const transition = decideBreaker(atCap, request({ entry: overflow }));

    expect(atCap.size).toBe(HOLD_CAP);
    expect(transition.outcome.ok).toBe(false);
    if (transition.outcome.ok) throw new Error("unreachable");
    expect(transition.outcome.code).toBe("BREAKER_HOLDS_EXHAUSTED");
    expect(transition.outcome.decision).toBe("REFUSE");
    expect(transition.holds.size).toBe(HOLD_CAP);
    expect(transition.holds.has(fingerprintOf(overflow))).toBe(false);
  });

  it("still converges a sibling onto its existing hold at cap", () => {
    const sibling = entry({ id: "entry-cap-sibling", environmentDigest: "env-cap-0" });

    const transition = decideBreaker(holdsAtCap(), request({ entry: sibling }));

    expect(transition.outcome.ok).toBe(false);
    if (transition.outcome.ok) throw new Error("unreachable");
    expect(transition.outcome.code).toBe("SAME_BUG_HOLD_ACTIVE");
    expect(transition.holds.size).toBe(HOLD_CAP);
  });

  it("still unlocks an existing hold at cap when the predicate moves", () => {
    const retry = request({
      entry: entry({ id: "entry-cap-retry", environmentDigest: "env-cap-0" }),
      candidatePredicate: MOVED_PREDICATE,
    });

    const transition = decideBreaker(holdsAtCap(), retry);

    expect(transition.outcome.ok).toBe(true);
    expect(transition.holds.size).toBe(HOLD_CAP - 1);
  });
});

describe("hold eviction", () => {
  it("retainHolds keeps only vouched fingerprints and re-admits new holds", () => {
    const atCap = holdsAtCap();
    const kept = fingerprintOf(entry({ environmentDigest: "env-cap-0" }));

    const retained = retainHolds(atCap, (fingerprint) => fingerprint === kept);

    expect(retained.size).toBe(1);
    expect(retained.has(kept)).toBe(true);
    expect(atCap.size).toBe(HOLD_CAP);

    const admitted = decideBreaker(
      retained,
      request({ entry: entry({ id: "entry-after-evict", environmentDigest: "env-after-evict" }) }),
    );
    expect(admitted.outcome.ok).toBe(true);
    expect(admitted.holds.size).toBe(2);
  });

  it("retainHolds carries the kept record over unchanged", () => {
    const kept = fingerprintOf(entry());
    const held = heldOnBaseBug();

    const retained = retainHolds(held.holds, (fingerprint) => fingerprint === kept);

    expect(retained.get(kept)).toBe(held.holds.get(kept));
  });
});

describe("refusal sweep", () => {
  const sweep = Object.freeze([
    ["a malformed entry", (): ReturnType<typeof emptyHolds> => heldOnBaseBug().holds, request({ entry: { ...entry(), baseDigest: 3 } as unknown as DeadEndJournalEntry }), "BREAKER_INPUT_INVALID"],
    ["a converging sibling", (): ReturnType<typeof emptyHolds> => heldOnBaseBug().holds, request(), "SAME_BUG_HOLD_ACTIVE"],
    ["an unmoved retry", (): ReturnType<typeof emptyHolds> => heldOnBaseBug().holds, request({ candidatePredicate: HELD_PREDICATE }), "RETRY_PREDICATE_UNCHANGED_HOLD"],
    ["a novel fingerprint at the hold cap", holdsAtCap, request({ entry: entry({ id: "entry-sweep-overflow", environmentDigest: "env-sweep-overflow" }) }), "BREAKER_HOLDS_EXHAUSTED"],
  ] as const);

  it("generated a non-empty sweep covering every stable code", () => {
    expect(sweep.length).toBeGreaterThan(0);
    expect([...new Set(sweep.map(([, , , code]) => code))].sort()).toEqual(
      [...CONVERGENCE_BREAKER_CODES].sort(),
    );
  });

  it.each(sweep)("refuses %s with its stable code", (_label, holds, breakerRequest, code) => {
    const outcome: BreakerOutcome = decideBreaker(holds(), breakerRequest).outcome;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.code).toBe(code);
    expect(outcome.layer).toBe(CONVERGENCE_BREAKER_LAYER);
    expect(outcome.truth).toBe("UNKNOWN");
  });
});
