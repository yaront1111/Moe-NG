/**
 * HOSTILE COVERAGE — the SCHEDULER-ACTIVATION axis of the declared-boundary roster.
 *
 * Satisfies the `scheduler-activation` axis of the coverage ratchet owned by
 * task-3b1cbdf9bd39405bb32230552d3ab242. It is the LAST of the five axes, so completeness
 * is this slice's obligation rather than the ratchet's to discover later.
 *
 * THE SUBSET COMES FROM THE ROSTER, NOT FROM THE TASK DESCRIPTION, which named sixteen
 * constants. The roster tags TWENTY-FOUR onto this axis and re-tagged members in both
 * directions — ACTIVATION_LEDGER_LAYER arrived from the durable-store list and the
 * expansion/supersession/goal/graph family from the integrity list. Reconciling the two
 * lists would produce a gap and an overlap at once, so only the roster counts, and it is
 * PARSED from its committed bytes rather than imported: `BOUNDARY_ROSTER` is not exported,
 * and parsing reddens if the roster re-tags a member instead of drifting silently.
 *
 * ONE SUITE MODULE, deliberately. The lane runs `isolate: true`, so two suite modules can
 * never share collected outcomes — and the whole-slice invariant plus the roster-set
 * assertion both need every case in one place. The case tables live in sibling modules that
 * hold no assertions.
 *
 * THE ARRANGED LAYER IS ASSERTED, NOT JUST DOCUMENTED. Three families here sit in series:
 * ingress/slot/budget on one activation, the core supersession kernel ahead of the
 * scheduler's disposition, and core expansion approval/hold/preparation ahead of the
 * scheduler's binding and evidence. A fixture invalid at the earlier layer is answered
 * there, and the assertion silently stops testing its subject — so every case declares the
 * layer it was ARRANGED to reach and the suite requires the observed layer to equal it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { MAX_BOUND_MS, assertRefusedWith, cleanupHostileRoots } from "./hostile-harness.js";
import {
  ACTIVATION_ADMISSION_CASES,
  ACTIVATION_ADMISSION_RACES,
  DEV_READY,
  EXPANSION_SUPERSESSION_CASES,
  EXPANSION_SUPERSESSION_RACES,
  SCHEDULER_DECISION_CASES,
  SCHEDULER_DECISION_RACES,
  honestUnknownFact,
  honestUnknownMeasurement,
  measuredOutcomes,
  measurementPrior,
  closeHostileStores,
  isAdmitted,
  readinessProbeRecords,
  verifierLaunchCount,
} from "./scheduler-activation-hostile-cases.js";
import type {
  HostileArm,
  HostileCase,
  HostileRaceCase,
} from "./scheduler-activation-hostile-cases.js";

const LANE_ROOT = dirname(fileURLToPath(import.meta.url));
const ROSTER_FILE = join(LANE_ROOT, "boundary-roster.security.ts");

/** Matches one single-line roster entry tagged onto this axis. */
const AXIS_ENTRY =
  /\{\s*constant:\s*"([A-Za-z0-9_]+)",\s*file:\s*"[^"]+",\s*axis:\s*"scheduler-activation"\s*\}/gu;

function rosterAxisConstants(): readonly string[] {
  const source = readFileSync(ROSTER_FILE, "utf8");
  return Object.freeze([...source.matchAll(AXIS_ENTRY)].map((match) => match[1] ?? ""));
}

const ROSTER_AXIS = rosterAxisConstants();

const CASES: readonly HostileCase[] = Object.freeze([...ACTIVATION_ADMISSION_CASES, ...EXPANSION_SUPERSESSION_CASES, ...SCHEDULER_DECISION_CASES]);
const RACES: readonly HostileRaceCase[] = Object.freeze([...ACTIVATION_ADMISSION_RACES, ...EXPANSION_SUPERSESSION_RACES, ...SCHEDULER_DECISION_RACES]);

const COVERED = [
  ...new Set([...CASES.map((entry) => entry.constant), ...RACES.map((entry) => entry.constant)]),
];

const armsFor = (constant: string): readonly HostileArm[] => [
  ...CASES.filter((entry) => entry.constant === constant).map((entry) => entry.arm),
  ...RACES.filter((entry) => entry.constant === constant).map((): HostileArm => "RACE"),
];

/**
 * The explicit ceiling every case in this file runs under, stated here rather than left to the
 * runner's default. `MAX_BOUND_MS` is the point `setTimeout` starts clamping a wider delay down
 * to 1ms, so a bound is only meaningful well below it; this one is five orders of magnitude
 * below and is passed to each `it` as its timeout. The failure mode is a HANG: this lane runs
 * `fileParallelism: false`, so one unbounded wait stalls every file scheduled after it and
 * reports no verdict at all, which is strictly worse than a red.
 */
const CASE_BOUND_MS = Math.min(15_000, MAX_BOUND_MS);

/** Every outcome this slice produced, so the whole-slice invariant sees all of them. */
const collected: unknown[] = [];

afterAll(() => {
  // Handles first: a held SQLite handle kills the vitest worker, and in a
  // `fileParallelism: false` lane that takes every file scheduled after this one with it.
  closeHostileStores();
  cleanupHostileRoots();
});

describe("scheduler-activation axis versus the declared-boundary roster", () => {
  it("reads a positive number of scheduler-activation entries off the roster", () => {
    // A silently-zero parse would make every set assertion below pass vacuously.
    expect(ROSTER_AXIS.length).toBeGreaterThan(0);
    expect(ROSTER_AXIS).toHaveLength(24);
  });

  it("covers every scheduler-activation boundary the roster declares", () => {
    const covered = new Set(COVERED);
    expect(ROSTER_AXIS.filter((constant) => !covered.has(constant))).toEqual([]);
  });

  it("covers no boundary outside the scheduler-activation axis", () => {
    const rostered = new Set(ROSTER_AXIS);
    expect(COVERED.filter((constant) => !rostered.has(constant))).toEqual([]);
  });

  it.each(ROSTER_AXIS.map((constant) => [constant]))(
    "generates a positive, three-armed case count for %s",
    (constant: string) => {
      const arms = armsFor(constant);
      // The count assertion is what makes a boundary that generated NOTHING redden.
      expect(arms.length).toBeGreaterThan(0);
      expect(arms).toContain("BEFORE");
      expect(arms).toContain("AFTER");
      expect(arms).toContain("RACE");
    },
  );
});

describe("hostile before and after arms", () => {
  it.each(CASES.map((entry) => [`${entry.constant} ${entry.arm}: ${entry.name}`, entry]))(
    "%s",
    async (_name: string, entry: HostileCase) => {
      const outcome = await entry.run();
      collected.push(outcome);
      // Both code AND layer, through the shared helper: it rejects a code-only call at
      // compile time and again at runtime, so no slice can drift into the weak form.
      assertRefusedWith(outcome, entry.expected);
      // THE SERIES CHECK. Where several layers can answer one input, this is what proves
      // the fixture reached the layer it was built for rather than being answered earlier.
      expect(entry.expected.layer, `${entry.constant}: arranged layer must answer`).toBe(
        entry.arranged,
      );
    },
    CASE_BOUND_MS,
  );
});

describe("hostile race arms", () => {
  it.each(RACES.map((entry) => [`${entry.constant} RACE: ${entry.name}`, entry]))(
    "%s",
    async (_name: string, entry: HostileRaceCase) => {
      const [left, right] = await entry.run();
      collected.push(left, right);

      // ORDER-INDEPENDENT by construction: the assertion is on the OUTCOME SHAPE, never on
      // which side won. A case that only passed when one side won would be a flake, and the
      // usual "fix" — pinning the order — destroys the property under test.
      const admissions = [isAdmitted(left), isAdmitted(right)].filter(Boolean).length;
      expect(admissions, `${entry.constant}: at most ${entry.maxAdmitted} may be admitted`).toBe(
        entry.maxAdmitted,
      );
      // Per side, not on an aggregate: an aggregate can hide a double-admit, which is the
      // one defect a race case exists to find. Every side that did NOT win must carry the
      // exact code and layer — "one of them refused somehow" is not the property.
      for (const side of [left, right]) {
        if (!isAdmitted(side)) {
          assertRefusedWith(side, entry.expected);
        }
      }

      // THE DURABLE PROOF, on the exclusivity races. A returned refusal says only that one
      // caller was told no; it does not say that only one write landed. Reading the state
      // back is what distinguishes "exactly one admitted" from "two admitted, one lied to".
      if (entry.durableAdmissions !== undefined) {
        expect(
          entry.durableAdmissions(),
          `${entry.constant}: durable state must hold exactly ${entry.maxAdmitted} admission`,
        ).toBe(entry.maxAdmitted);
      }
    },
    CASE_BOUND_MS,
  );
});

/**
 * UNKNOWN IS NEVER ZERO AND NEVER IMPUTED — asserted ONCE over everything the scheduler group
 * produced, rather than per case. A per-case list is what later gets extended with a permissive
 * entry; a property over the collected outcomes covers cases nobody has written yet.
 */
describe("the scheduler group's unknown rule", () => {
  it("collected the outcomes it asserts over, so the property is not vacuous", () => {
    expect(measuredOutcomes().length).toBeGreaterThan(0);
    expect(readinessProbeRecords().length).toBeGreaterThan(0);
  });

  it("never admits an unmeasured observation at zero cost", () => {
    // `record` is production's own field for an ACCEPTED normalization. Every outcome the group
    // recorded came from an unmeasured or forged input, so one carrying a record is a boundary
    // that rendered the unmeasured as a number.
    const accepted = measuredOutcomes().filter(
      (outcome) =>
        typeof outcome === "object"
        && outcome !== null
        && (outcome as Record<string, unknown>)["record"] !== undefined,
    );
    expect(accepted).toEqual([]);
  });

  it("had a real sibling measurement available to impute from", () => {
    // The positive control for the imputation case: with no prior actually normalized, that
    // case would refuse for want of an envelope and prove nothing about imputation at all.
    expect(measurementPrior()).not.toBeNull();
  });

  it("accepts an honestly unmeasured observation but never raises its truth class", () => {
    // The NEGATIVE CONTROL. Without it, every refusal above is equally explained by a boundary
    // that refuses everything — and a boundary that refuses everything holds no rule.
    expect(honestUnknownFact()).toMatchObject({ truthClass: "UNKNOWN", tier: null });
  });

  it("keeps the accepted unmeasured quantity null rather than storing it as zero", () => {
    // Asserted on the VALUE production returned, not on a refusal: rendering `quantity ?? 0`
    // downstream of the input biconditional refuses every hostile case in this file and still
    // hands the caller a measured zero. This is the only assertion here that sees it.
    expect(honestUnknownMeasurement()).toMatchObject({ coverage: "UNKNOWN", quantity: null });
  });

  it("keeps an unknown predicate distinct from a confirmed-false one", () => {
    const probes = readinessProbeRecords();
    const unknown = probes.filter((probe) => probe.confidence === "UNKNOWN");
    const denied = probes.filter((probe) => probe.confidence === "CONFIRMED_FALSE");
    expect(unknown.length).toBeGreaterThan(0);
    expect(denied.length).toBeGreaterThan(0);
    // THE COLLAPSE TEST. Both confidences produce the same reason code at the same layer, so
    // only the withheld partition separates them: an UNKNOWN predicate withholds it, a
    // CONFIRMED_FALSE one does not. An engine that read "nobody knows" as "the caller said no"
    // passes every code-and-layer assertion in this file and fails exactly here.
    expect(unknown.map((probe) => probe.withheld)).toEqual(
      unknown.map(() => "AVAILABILITY_UNKNOWN"),
    );
    expect(denied.map((probe) => probe.withheld)).toEqual(denied.map(() => null));
  });

  it("drops a dispatchable node once its predicate is withdrawn", () => {
    const probes = readinessProbeRecords();
    const ready = probes.filter((probe) => probe.confidence === "CONFIRMED_TRUE");
    // The baseline must genuinely have been dispatchable, or the after-arm refused something
    // that was never admitted and the withdrawal proved nothing.
    expect(ready.length).toBeGreaterThan(0);
    expect(ready.every((probe) => probe.dispatchable.includes(DEV_READY))).toBe(true);
    expect(
      probes
        .filter((probe) => probe.confidence !== "CONFIRMED_TRUE")
        .every((probe) => !probe.dispatchable.includes(DEV_READY)),
    ).toBe(true);
  });
});

describe("the whole slice", () => {
  it("never admits an activation, consumes a grant, or raises a truth class above UNKNOWN", () => {
    // One assertion over every collected outcome rather than one per case, so a case added
    // later cannot quietly escape the invariant. The races that legitimately admit exactly
    // one side are the only exception, and they are counted rather than exempted.
    const admittedTotal = collected.filter((outcome) => isAdmitted(outcome)).length;
    const allowed = RACES.reduce((sum, entry) => sum + entry.maxAdmitted, 0);
    expect(admittedTotal).toBe(allowed);
  });

  it("collected an outcome from every case, so nothing escaped by not running", () => {
    expect(collected).toHaveLength(CASES.length + RACES.length * 2);
  });

  it("refused every verification before a verifier process was ever launched", () => {
    // The ORDERING property, stated observably. Each verification refusal above asserts its
    // code and layer, which a boundary that spawned the process first and refused afterwards
    // would satisfy in full. Only the launcher's own count separates the two.
    expect(verifierLaunchCount()).toBe(0);
  });
});
