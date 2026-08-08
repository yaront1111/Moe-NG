import { describe, expect, it } from "vitest";

import { DUPLICATE_DELIVERY_KINDS } from "./duplicate-delivery.js";
import { activateEffect } from "./effect-activation.js";
import { validateActivationCommit } from "./effect-grant.js";
import { EFFECT_STATES } from "./effect-kernel.js";
import { applyEffectCommand } from "./effect-lifecycle.js";
import { makeActivationRequest, makeAttempt, makeGrant, makeIntent } from "./effect-test-fixtures.js";
import {
  checkGrantOrdering,
  COMMITTED_ACTIVATION_PAIR,
  createRecorder,
  RACE_SEEDS,
  RACE_STEPS,
  runTrace,
  type StepRecord,
} from "./race-harness.js";

/**
 * The closing hardening gate for the external-effect supervisor slice.
 *
 * EXPECTED_OUTCOME_KINDS is transcribed BY HAND from the frozen vocabularies the
 * slice exports and from the refusal paths read in source — never from a harness
 * run. A list derived from the run it judges agrees with itself by construction
 * and would stay green through any behaviour change that was internally
 * consistent (`mem:gotcha-self-derived-universe-cannot-check-itself`).
 *
 * The label grammar is `OK:<family>:<detail>` and `NO:<layer>:<code>`. The layer
 * is part of the refusal label on purpose: the slice deliberately emits
 * RESTART_SAFE_HANDOFF_ABSENT at BOTH the DRAIN and RESTART layers for the same
 * fact, and a label that dropped the layer could not tell which one answered.
 */
const EXPECTED_OUTCOME_KINDS: readonly string[] = [
  "NO:ACTIVATION:ACTIVATION_DEPENDENCY_WITNESS_STALE",
  "NO:ACTIVATION:ACTIVATION_DESIRED_STATE_MISMATCH",
  "NO:ACTIVATION:ACTIVATION_GRAPH_EPOCH_MISMATCH",
  "NO:ACTIVATION:ACTIVATION_INTENT_NOT_ARMED",
  "NO:ACTIVATION:ACTIVATION_LOCK_IDENTITY_MISMATCH",
  "NO:ACTIVATION:ATTEMPT_BINDING_MISMATCH",
  "NO:ACTIVATION:ATTEMPT_NOT_LAUNCH_REQUESTED",
  "NO:ACTIVATION:EFFECT_TOMBSTONED",
  "NO:ACTIVATION:PROVIDER_CAPABILITY_CHANGED",
  "NO:DRAIN:DRAIN_DISPOSITION_NOT_MONOTONIC",
  "NO:DRAIN:DRAIN_RESOURCE_UNRECONCILED",
  "NO:DRAIN:DRAIN_ROW_NOT_ADMITTED",
  "NO:DRAIN:RESTART_SAFE_HANDOFF_ABSENT",
  "NO:GRANT:GRANT_ALREADY_CONSUMED",
  "NO:GRANT:GRANT_WRAPPER_MISMATCH",
  "NO:KERNEL:EFFECT_ATTEMPT_MALFORMED",
  "NO:KERNEL:EFFECT_CLAIM_MALFORMED",
  "NO:KERNEL:EFFECT_COMMAND_MALFORMED",
  "NO:KERNEL:EFFECT_GRANT_MALFORMED",
  "NO:KERNEL:EFFECT_INTENT_MALFORMED",
  "NO:KERNEL:EFFECT_TOMBSTONE_MALFORMED",
  "NO:LAUNCH_LOCK:LAUNCH_LOCK_IDENTITY_CONFLICT",
  "NO:LAUNCH_LOCK:LAUNCH_LOCK_MALFORMED",
  "NO:LAUNCH_LOCK:LAUNCH_LOCK_REGISTRATION_ABSENT",
  "NO:LAUNCH_LOCK:LAUNCH_LOCK_SUSPECT",
  "NO:LEASE_MIRROR:LEASE_MIRROR_MALFORMED",
  "NO:LEASE_MIRROR:LEASE_MIRROR_STALE",
  "NO:LEASE_MIRROR:LEASE_MIRROR_STALE_EPOCH",
  "NO:LEASE_MIRROR:LEASE_MIRROR_SUPERSEDED_AUTHORITY",
  "NO:LIFECYCLE:EFFECT_SETTLEMENT_EVIDENCE_INVALID",
  "NO:LIFECYCLE:EFFECT_SETTLEMENT_TARGET_NOT_ADMITTED",
  "NO:LIFECYCLE:EFFECT_TERMINAL_ABSORBED",
  "NO:LIFECYCLE:EFFECT_TOMBSTONE_DOES_NOT_DOMINATE",
  "NO:LIFECYCLE:EFFECT_TRANSITION_NOT_ADMITTED",
  "NO:LIFECYCLE:EFFECT_UNCERTAINTY_EVIDENCE_REQUIRED",
  "NO:LIFECYCLE:EFFECT_UNCERTAINTY_EVIDENCE_UNEXPECTED",
  "NO:RESTART:DRAIN_RESOURCE_UNRECONCILED",
  "NO:RESTART:DRAIN_ROW_NOT_ADMITTED",
  "NO:RESTART:RESTART_PREMATURE_TERMINAL",
  "NO:RESTART:RESTART_RECORDS_INCOHERENT",
  "NO:RESTART:RESTART_SAFE_HANDOFF_ABSENT",
  "OK:ACT:ACTIVATED",
  "OK:DRAIN:ATOMIC_ACTIVATION",
  "OK:DRAIN:DRAINING",
  "OK:DRAIN:RECONCILE_ONLY",
  "OK:DRAIN:TERMINALIZED",
  "OK:DRAIN:TOMBSTONED",
  "OK:DUP:ADOPTED",
  "OK:DUP:EXIT_BEFORE_LAUNCH",
  "OK:GRANT:CONSUMED",
  "OK:LIFE:ARMED",
  "OK:LIFE:CANCELLED",
  "OK:LIFE:CANCEL_REQUESTED",
  "OK:LIFE:CLAIMED",
  "OK:LIFE:FAILED",
  "OK:LIFE:MUST_DRAIN",
  "OK:LIFE:SUCCEEDED",
  "OK:LIFE:UNKNOWN",
  "OK:RESTART:ACTIVE_ADOPTED",
  "OK:RESTART:DRAINING",
  "OK:RESTART:RECONCILE_ONLY",
  "OK:RESTART:SUSPECT",
  "OK:RESTART:TERMINAL_PROVEN",
  "OK:RESTART:TOMBSTONED",
  "OK:RESTART:UNKNOWN",
  "OK:TOMB:CANCELLED",
];

const TRACES = RACE_SEEDS.map((seed) => ({ seed, trace: runTrace(seed, RACE_STEPS) }));
const ALL_STEPS: readonly StepRecord[] = TRACES.flatMap((entry) => entry.trace.steps);

// Most invariants below are `for (const step of ALL_STEPS)` loops, and a loop
// over nothing passes. A harness that returned a short or empty schedule would
// otherwise leave this whole file green while asserting nothing at all, so the
// schedule length is checked once at import and fails the file outright.
if (ALL_STEPS.length !== RACE_SEEDS.length * RACE_STEPS) {
  throw new Error(
    `expected ${RACE_SEEDS.length * RACE_STEPS} recorded steps, got ${ALL_STEPS.length}`,
  );
}

function tally(): ReadonlyMap<string, number> {
  const recorder = createRecorder();
  for (const step of ALL_STEPS) recorder.record(step.label);
  return recorder.counts();
}

describe("DoD 1 — the seeded schedule observes exactly the declared outcome kinds", () => {
  it("runs at least five seeds of at least two hundred steps each", () => {
    expect(RACE_SEEDS.length).toBeGreaterThanOrEqual(5);
    expect(RACE_STEPS).toBeGreaterThanOrEqual(200);
    for (const { trace } of TRACES) expect(trace.steps.length).toBe(RACE_STEPS);
    expect(ALL_STEPS.length).toBe(RACE_SEEDS.length * RACE_STEPS);
  });

  it("produces an outcome-kind SET equal to the hand-written list", () => {
    const counts = tally();
    const table = [...counts.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([kind, count]) => `${kind} ${count}`)
      .join(", ");
    // Recorded in the test output because DoD 1 requires per-kind counts in the
    // completion evidence: a set that is complete but reaches half its members
    // once is not the same gate as one that reaches them all repeatedly.
    console.log(`per-kind outcome counts (${counts.size} kinds): ${table}`);
    expect([...counts.keys()].sort()).toEqual([...EXPECTED_OUTCOME_KINDS].sort());
  });

  it("reaches every declared kind more than once, so none is a coincidence", () => {
    const counts = tally();
    const thin = [...counts.entries()].filter(([, count]) => count < 2).map(([kind]) => kind);
    expect(thin).toEqual([]);
  });

  it("would refuse an undeclared kind rather than drop it", () => {
    const guarded = createRecorder(EXPECTED_OUTCOME_KINDS);
    expect(() => {
      for (const step of ALL_STEPS) guarded.record(step.label);
    }).not.toThrow();
    expect(guarded.total()).toBe(ALL_STEPS.length);
    expect(() => guarded.record("OK:LIFE:SMUGGLED")).toThrow(/undeclared outcome kind/);
  });
});

describe("DoD 3 — every race step lands in exactly one legal state", () => {
  it("labels every step exactly once with a declared kind", () => {
    for (const step of ALL_STEPS) {
      expect(EXPECTED_OUTCOME_KINDS).toContain(step.label);
      expect(EFFECT_STATES).toContain(step.effectState);
    }
  });

  it("moves the intent version by 0 or 1, and by 1 exactly when the state changes", () => {
    // A NO_OP-shaped answer returns a FRESH object at the SAME version, so the
    // tempting "a new object implies version+1" invariant is wrong and would
    // fail spuriously; the honest pair is delta in {0,1} plus this implication.
    for (const step of ALL_STEPS) {
      expect([0, 1]).toContain(step.versionDelta);
      if (step.stateChanged) expect(step.versionDelta).toBe(1);
    }
  });

  it("never mutates the record it was handed", () => {
    expect(ALL_STEPS.filter((step) => step.inputMutated)).toEqual([]);
  });

  it("never records a harness-detected violation on any schedule", () => {
    expect(ALL_STEPS.filter((step) => step.violation !== null).map((s) => s.violation)).toEqual([]);
  });

  it("never downgrades the strongest drain reason within a schedule", () => {
    for (const { seed, trace } of TRACES) {
      let rank = 0;
      let reasons = 0;
      for (const step of trace.steps) {
        expect([seed, step.index, step.dispositionRank >= rank]).toEqual([seed, step.index, true]);
        expect([seed, step.index, step.reasonCount >= reasons]).toEqual([seed, step.index, true]);
        rank = step.dispositionRank;
        reasons = step.reasonCount;
      }
      // Non-vacuity: a disposition that never moved would satisfy monotonicity.
      expect(trace.steps[trace.steps.length - 1]?.reasonCount).toBeGreaterThan(1);
    }
  });
});

describe("DoD 2 — no external action precedes its committed activation pair", () => {
  it("observes real activations and real launches, so the invariant is not vacuous", () => {
    const events = TRACES.flatMap((entry) => entry.trace.events);
    expect(events.filter((event) => event.kind === "GRANT_ISSUED").length).toBeGreaterThan(0);
    expect(events.filter((event) => event.kind === "LAUNCH").length).toBeGreaterThan(0);
  });

  it("finds no grant spent before the activation that minted it, on any seed", () => {
    for (const { seed, trace } of TRACES) {
      expect([seed, checkGrantOrdering(trace.events)]).toEqual([seed, []]);
    }
  });

  it("mints every grant from a full ARMED->ACTIVE plus LAUNCH_REQUESTED->RUNNING pair", () => {
    const issued = TRACES.flatMap((entry) => entry.trace.events).filter(
      (event) => event.kind === "GRANT_ISSUED",
    );
    expect(issued.length).toBeGreaterThan(0);
    for (const event of issued) expect(event.pair).toBe(COMMITTED_ACTIVATION_PAIR);
  });

  it("resolves every duplicate delivery inside the frozen kind list", () => {
    const kinds = new Set(
      ALL_STEPS.filter((step) => step.command === "duplicateDelivery").map(
        (step) => step.outcomeKind,
      ),
    );
    expect(kinds.size).toBeGreaterThan(0);
    // Set EQUALITY against the exported frozen list: a fourth, optimistic arm
    // could not hide behind "every observed kind is one we declared".
    expect([...kinds].sort()).toEqual([...DUPLICATE_DELIVERY_KINDS].sort());
  });

  /**
   * The alphabet's `activate` command drives `activateEffect`, so it never
   * exercises the OTHER path to an ACTIVE effect: `applyEffectCommand` answers
   * the ARMED->activate arc directly, and that reducer checks no lease, no
   * grant, no tombstone and no runtime closure. Child 1 pins that behaviour, so
   * this block does not change it — it proves the safety net holds anyway, which
   * is what DoD 2 actually claims.
   */
  it("gives a lifecycle-only activation no external-action authority", () => {
    const armed = makeIntent();
    const reduced = applyEffectCommand(armed, { kind: "activate" });
    expect(reduced.kind).toBe("TRANSITIONED");
    if (reduced.kind !== "TRANSITIONED") return;
    expect(reduced.intent.state).toBe("ACTIVE");
    // No grant, no commit, no authority material of any kind on the outcome.
    expect(Object.keys(reduced).sort()).toEqual(["intent", "kind", "ok", "result", "versionDelta"]);
    expect(reduced.result).toBe(null);
  });

  it("refuses the half commit a lifecycle-only activation leaves behind", () => {
    const reduced = applyEffectCommand(makeIntent(), { kind: "activate" });
    if (reduced.kind !== "TRANSITIONED") throw new Error("the reducer must admit ARMED->activate");
    const check = validateActivationCommit(reduced.intent, makeAttempt(), makeGrant());
    expect(check.kind).toBe("REFUSED");
    if (check.kind !== "REFUSED") return;
    expect([check.failure.code, check.failure.layer]).toEqual([
      "ACTIVATION_COMMIT_INCOHERENT",
      "ACTIVATION",
    ]);
  });

  it("still passes the same check for a real committed activation", () => {
    // Without this control the refusal above could be a broken fixture rather
    // than the commit checker doing its job.
    const committed = activateEffect(makeActivationRequest());
    expect(committed.kind).toBe("ACTIVATED");
    if (committed.kind !== "ACTIVATED") return;
    const { intent, attempt, grant } = committed.commit;
    expect(validateActivationCommit(intent, attempt, grant).kind).toBe("COHERENT");
  });

  it("never lets a duplicate delivery produce a fresh launch", () => {
    for (const { seed, trace } of TRACES) {
      const duplicates = new Set(
        trace.steps.filter((step) => step.command === "duplicateDelivery").map((s) => s.index),
      );
      expect(duplicates.size).toBeGreaterThan(0);
      const relaunched = trace.events.filter(
        (event) => event.kind === "LAUNCH" && duplicates.has(event.index),
      );
      expect([seed, relaunched]).toEqual([seed, []]);
    }
  });
});
