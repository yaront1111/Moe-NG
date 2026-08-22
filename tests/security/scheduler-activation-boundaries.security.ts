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
  FOUNDATION_DISPATCH_CASES,
  FOUNDATION_DISPATCH_RACES,
  closeFoundationDispatchStores,
} from "./foundation-dispatch-hostile-cases.js";
import {
  ACCEPTED_CONTROL_EXPECTATION,
  ACTIVE_GRAPH_PROJECTION_LAYER,
  BODY_CONTROL_EXPECTATION,
  GRAPH_BODY_RECORD_CODES,
  GRAPH_BODY_RECORD_LAYER,
  PLANNING_GRAPH_CASES,
  PLANNING_GRAPH_RACES,
  closePlanningGraphStores,
  graphBodyProofs,
  planningGraphProofs,
  runAcceptedActiveGraphControl,
  runAcceptedGraphBodyControl,
  runGraphBodyPassthroughControl,
} from "./planning-graph-hostile-cases.js";
import {
  ACTIVATION_ADMISSION_CASES,
  ACTIVATION_ADMISSION_RACES,
  DEV_READY,
  EXPANSION_SUPERSESSION_CASES,
  EXPANSION_SUPERSESSION_RACES,
  GOAL_PREREQUISITE_LAYER,
  SCHEDULER_DECISION_CASES,
  SCHEDULER_DECISION_RACES,
  closeGoalPrerequisiteFixtures,
  goalAcceptedControls,
  goalAfterPrecondition,
  goalPrerequisiteProofs,
  honestUnknownFact,
  honestUnknownMeasurement,
  measuredOutcomes,
  measurementPrior,
  closeHostileStores,
  isAdmitted,
  readinessProbeRecords,
  replayDurableRecord,
  replayVersions,
  runAcceptedGoalCloseControl,
  spawnRefusalCodes,
  verifierLaunchCount,
} from "./scheduler-activation-hostile-cases.js";
import type {
  GoalPrerequisiteProof,
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

const CASES: readonly HostileCase[] = Object.freeze([...ACTIVATION_ADMISSION_CASES, ...EXPANSION_SUPERSESSION_CASES, ...SCHEDULER_DECISION_CASES, ...PLANNING_GRAPH_CASES, ...FOUNDATION_DISPATCH_CASES]);
const RACES: readonly HostileRaceCase[] = Object.freeze([...ACTIVATION_ADMISSION_RACES, ...EXPANSION_SUPERSESSION_RACES, ...SCHEDULER_DECISION_RACES, ...PLANNING_GRAPH_RACES, ...FOUNDATION_DISPATCH_RACES]);

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

/**
 * The goal-closure control's own ceiling. It is wider than `CASE_BOUND_MS` for a measured
 * reason rather than a defensive one: qualifying a node drives activation ingress, the
 * launcher authority, a durable attempt record and a REAL verifier child process, so the
 * control is bounded by process startup rather than by in-memory work. Still five orders of
 * magnitude below `MAX_BOUND_MS`, so a hang is reported as a bound breach, never clamped.
 */
const GOAL_CONTROL_BOUND_MS = Math.min(120_000, MAX_BOUND_MS);

/** Every outcome this slice produced, so the whole-slice invariant sees all of them. */
const collected: unknown[] = [];

afterAll(() => {
  // Handles first: a held SQLite handle kills the vitest worker, and in a
  // `fileParallelism: false` lane that takes every file scheduled after this one with it.
  closeHostileStores();
  // The goal group opens its own bootstrap stores and verification scratch roots; the same
  // ordering applies, and win32 holds a just-exited child's cwd briefly.
  closeGoalPrerequisiteFixtures();
  // The planning-graph arms open their own file-backed stores, including a SECOND
  // connection per race; the same handles-before-roots ordering applies.
  closePlanningGraphStores();
  // The foundation-dispatch arms open their own file-backed stores, including a SECOND
  // connection for the race; the same handles-before-roots ordering applies.
  closeFoundationDispatchStores();
  cleanupHostileRoots();
});

describe("scheduler-activation axis versus the declared-boundary roster", () => {
  it("reads a positive number of scheduler-activation entries off the roster", () => {
    // A silently-zero parse would make every set assertion below pass vacuously.
    expect(ROSTER_AXIS.length).toBeGreaterThan(0);
    // 25 -> 26 on 2026-08-17: GOAL_PREREQUISITE_LAYER (task-a46d4f99). 26 -> 28 on
    // 2026-08-18: ACTIVE_GRAPH_PROJECTION_LAYER and GRAPH_BODY_RECORD_LAYER
    // (task-c5be7926). 28 -> 29 on 2026-08-20: FOUNDATION_DISPATCH_DERIVATION_LAYER
    // (producer task-a9fd91c3, row and arms task-120403f7). Measured off the roster's
    // committed bytes, not off this file's own case tables.
    expect(ROSTER_AXIS).toHaveLength(29);
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

/** The roster key and the two exact codes, restated BY HAND rather than imported: a list
 *  derived from the production vocabulary grows on both sides at once and stays green. */
const GOAL_KEY = "GOAL_PREREQUISITE_LAYER";
const RECEIPT_ABSENT = "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT";
const RECEIPT_AMBIGUOUS = "GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS";

const rawGoalOutcome = (proof: GoalPrerequisiteProof): Record<string, unknown> =>
  proof.outcome as Record<string, unknown>;

/**
 * THE ACCEPTED CONTROL, and it runs BEFORE the properties below read it.
 *
 * Every goal arm on this axis is a refusal, and a boundary that refuses everything explains
 * all of them equally well while holding no rule at all. This is the only case in the file
 * that drives `goal.close` to its accepted terminal state, through the SAME driver, so the
 * refusals mean something and the slice invariant has a real admission to account for.
 */
describe("the accepted goal-closure control", () => {
  it("closes a fully qualified goal through the driver the hostile arms use", async () => {
    await runAcceptedGoalCloseControl();
    const controls = goalAcceptedControls();
    // A silently absent control is the failure this asserts: with none captured, "at least
    // one qualifying close is admitted" would hold vacuously over an empty list.
    expect(controls).toHaveLength(1);
    const control = controls[0] as GoalPrerequisiteProof;
    collected.push(control.projected);

    const accepted = rawGoalOutcome(control);
    expect(accepted["ok"], "a fully qualified close must be ADMITTED").toBe(true);
    expect(accepted["disposition"]).toBe("DECIDED");
    expect(accepted["authority"]).toBe("DURABLE_DECISION");

    // The durable half. A returned acceptance says only that one caller was told yes.
    expect(control.after.decisions).toBe(control.before.decisions + 1);
    expect(control.before.completedEvents).toBe(0);
    expect(control.after.completedEvents).toBe(1);
    // Closing and completion are both applied by the one command, so the version moves by two.
    expect(JSON.parse(control.after.resultBytes)).toMatchObject({
      activeGraphRevisionRef: null,
      lifecycle: "COMPLETED",
      version: 4,
    });
  }, GOAL_CONTROL_BOUND_MS);
});

/**
 * THE GOAL-CLOSURE PREREQUISITE — properties no `{code, layer}` case on this axis can carry.
 *
 * THREE layers can refuse one `goal.close`: the daemon's ingress payload check, this
 * prerequisite composer, and the core reducer behind it. So the code alone is not the
 * property, the projected `layer` alone is not the property either, and neither says whether
 * the refused command committed anything on its way out.
 */
describe("the goal-closure prerequisite boundary", () => {
  it("is rostered on this axis with exactly one BEFORE, one AFTER and one RACE arm", () => {
    expect(ROSTER_AXIS).toContain(GOAL_KEY);
    const arms = armsFor(GOAL_KEY);
    expect(arms.filter((arm) => arm === "BEFORE")).toHaveLength(1);
    expect(arms.filter((arm) => arm === "AFTER")).toHaveLength(1);
    expect(arms.filter((arm) => arm === "RACE")).toHaveLength(1);
  });

  it("captured one outcome per goal command it actually sent, and the count is positive", () => {
    const proofs = goalPrerequisiteProofs();
    // A generated group that silently produced NOTHING would leave every property below
    // quantified over an empty list and passing.
    expect(proofs.length).toBeGreaterThan(0);
    // BEFORE, AFTER, and both sides of the race.
    expect(proofs).toHaveLength(4);
    expect([...proofs].map((proof) => proof.arm).sort()).toEqual([
      "AFTER", "BEFORE", "RACE", "RACE",
    ]);
  });

  it("was answered by this layer itself, read off production's own refusal field", () => {
    expect(GOAL_PREREQUISITE_LAYER).toBe("DAEMON_PREREQUISITE");
    const proofs = goalPrerequisiteProofs();
    expect(proofs.length).toBeGreaterThan(0);
    for (const proof of proofs) {
      // `refusedBy` is what the SERVICE returned. Asserting only the projected `layer` would
      // stay green the moment the ingress check or the core reducer began answering first.
      expect(rawGoalOutcome(proof)["refusedBy"], `${proof.arm}: this layer must answer`)
        .toBe(GOAL_PREREQUISITE_LAYER);
      expect(rawGoalOutcome(proof)["ok"]).toBe(false);
    }
  });

  it("qualified the AFTER arm's closure before its evidence was made ambiguous", () => {
    // THE FIXTURE FIRST. Without this the AFTER arm is only a second initially-invalid
    // fixture, and the property it claims — that a closure which genuinely DID qualify stops
    // qualifying once a second receipt names its node — is never tested at all.
    const precondition = goalAfterPrecondition() as Record<string, unknown> | null;
    // Null means the AFTER case never ran, which is an absent probe rather than a pass.
    expect(precondition).not.toBeNull();
    expect(precondition?.["ok"], "the AFTER arm must start from a qualified closure").toBe(true);
    // Both witnesses derived by production, not declared by the payload.
    expect(precondition?.["closureWitness"]).toBeDefined();
    expect(precondition?.["zeroAuthorityWitness"]).toBeDefined();
  });

  it("carries the exact prerequisite code arranged for each arm", () => {
    const codesFor = (arm: string): readonly unknown[] =>
      goalPrerequisiteProofs()
        .filter((proof) => proof.arm === arm)
        .map((proof) => rawGoalOutcome(proof)["code"]);
    // ABSENT and AMBIGUOUS are opposite durable states — zero receipts and two — demanding
    // opposite repairs, so collapsing them into one expectation would test neither.
    expect(codesFor("BEFORE")).toEqual([RECEIPT_ABSENT]);
    expect(codesFor("AFTER")).toEqual([RECEIPT_AMBIGUOUS]);
    expect(codesFor("RACE")).toEqual([RECEIPT_ABSENT, RECEIPT_ABSENT]);
  });

  it("left zero decision, event, completion and result residue behind every refusal", () => {
    const proofs = goalPrerequisiteProofs();
    expect(proofs.length).toBeGreaterThan(0);
    for (const proof of proofs) {
      // A handler that mutated and THEN refused satisfies every code and layer assertion
      // above. Only the before/after durable snapshot separates the two.
      expect(proof.after, `${proof.arm}: a refused close must commit nothing`)
        .toEqual(proof.before);
      expect(proof.after.completedEvents, `${proof.arm}: no goal may complete`).toBe(0);
    }
  });

  it("surfaced the captured service return itself, never a refusal minted in the fixture", () => {
    const proofs = [...goalPrerequisiteProofs(), ...goalAcceptedControls()];
    expect(proofs).toHaveLength(5);
    for (const proof of proofs) {
      // BY REFERENCE, spelled with `===` rather than left to a matcher's equality mode: a
      // driver answering with a literal — or with a COPY — of the expected refusal satisfies
      // every code, layer and residue assertion above, and fails exactly here.
      expect(
        collected.some((value) => value === proof.projected),
        `${proof.arm}: the suite must see the captured service return itself`,
      ).toBe(true);
    }
  });
});

/**
 * Two properties no `{code, layer}` case can carry: what the DURABLE store held afterwards, and
 * how many members a boundary's refusal vocabulary has. Both are places where a slice reads as
 * complete while a real gap sits behind the refusal it did assert.
 */
describe("evidence a refusal code cannot carry", () => {
  it("answers a diverging replay from the durable record rather than the caller's", () => {
    const { first, presented } = replayVersions();
    // THE FIXTURE FIRST. Equal versions would make "a materially different record" the same
    // record, and the divergence refusal would hold against a ledger that compared nothing.
    expect(presented).not.toBe(first);
    const durable = replayDurableRecord() as {
      readonly ok?: boolean;
      readonly record?: { readonly attempt?: { readonly version?: number } };
    } | null;
    // Null means the case that stashes this never ran — a silently absent probe, not a pass.
    expect(durable).not.toBeNull();
    expect(durable?.ok).toBe(true);
    expect(durable?.record?.attempt?.version).toBe(first);
  });

  it("pins the spawn refusal vocabulary at exactly one member", () => {
    // The compile-time half lives in the case module: a mapped type over the union, so adding
    // a member fails `tsc` there. This is the runtime half — together they catch a second
    // member landing AND this list going stale.
    expect(spawnRefusalCodes()).toEqual(["SPAWN_ARGUMENT_UNQUOTABLE"]);
  });
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

/** The two layer names and the three codes, restated BY HAND. A list derived from the
 *  production vocabulary grows on both sides at once and stays green. */
const PROJECTION_KEY = "ACTIVE_GRAPH_PROJECTION_LAYER";
const BODY_UNAVAILABLE = "ACTIVE_GRAPH_BODY_UNAVAILABLE";
const BODY_ABSENT = "GRAPH_BODY_ABSENT";

const rawProof = (proof: { readonly outcome: unknown }): Record<string, unknown> =>
  proof.outcome as Record<string, unknown>;

/**
 * The planning-graph ACCEPTED controls, from both groups. The whole-slice invariants count
 * admissions off production's returned values, so a control that had silently refused still
 * reddens them rather than being assumed present.
 */
const planningControls = (): readonly { readonly arm: string; readonly outcome: unknown }[] =>
  [...planningGraphProofs(), ...graphBodyProofs()].filter((proof) => proof.arm === "CONTROL");

/**
 * THE ACCEPTED CONTROL for the current-graph read, and it runs BEFORE the properties below.
 *
 * Every planning-graph arm on this axis is a refusal, and a projection that refuses
 * everything explains all of them equally well while holding no rule at all. This is the
 * only case in the file that drives `readCurrentActiveGraph` over the whole lawful path —
 * a revision driven to ACTIVE by the real reducer AND the body its content hash names.
 */
describe("the accepted current-graph control", () => {
  it("answers a fully seeded ACTIVE revision with its identity, hash and structural identity", async () => {
    const accepted = await runAcceptedActiveGraphControl();
    collected.push(accepted);
    const controls = planningGraphProofs().filter((proof) => proof.arm === "CONTROL");
    // A silently absent control would leave "at least one lawful read is admitted" holding
    // vacuously over an empty list.
    expect(controls).toHaveLength(1);

    const read = accepted as Record<string, unknown>;
    expect(read["ok"], "a lawful ACTIVE revision with its body must be ADMITTED").toBe(true);
    expect(read["revisionId"]).toBe(ACCEPTED_CONTROL_EXPECTATION.revisionId);
    expect(read["graphContentHash"]).toBe(ACCEPTED_CONTROL_EXPECTATION.graphContentHash);
    // The structural identity is answered BESIDE the content hash and is never equal to it,
    // so a projection returning the hash twice cannot pass this.
    expect(read["snapshotIdentity"]).toBe(ACCEPTED_CONTROL_EXPECTATION.snapshotIdentity);
    expect(read["snapshotIdentity"]).not.toBe(read["graphContentHash"]);
  }, CASE_BOUND_MS);
});

/**
 * THE PLANNING-GRAPH PROJECTION — properties no `{code, layer}` case on this axis carries.
 *
 * Two layers can answer one `readCurrentActiveGraph`: this projection, and the body record
 * behind it. The projection tags EVERY refusal with its own `layer` because it is what
 * answered the caller, and names the layer that actually refused in `sourceLayer`. A
 * case asserting code and layer alone cannot tell a wrapped refusal from an originated one
 * — both carry the same two fields — so the separation is pinned here.
 */
describe("the planning-graph projection boundary", () => {
  it("is rostered on this axis with exactly one BEFORE, one AFTER and one RACE arm", () => {
    expect(ROSTER_AXIS).toContain(PROJECTION_KEY);
    const arms = armsFor(PROJECTION_KEY);
    expect(arms.filter((arm) => arm === "BEFORE")).toHaveLength(1);
    expect(arms.filter((arm) => arm === "AFTER")).toHaveLength(1);
    expect(arms.filter((arm) => arm === "RACE")).toHaveLength(1);
  });

  it("captured one outcome per read it actually sent, and the count is positive", () => {
    const proofs = planningGraphProofs();
    // A group that silently produced NOTHING would leave every property below quantified
    // over an empty list and passing.
    expect(proofs.length).toBeGreaterThan(0);
    // BEFORE, AFTER, both sides of the race, and the accepted control.
    expect(proofs).toHaveLength(5);
    expect([...proofs].map((proof) => proof.arm).sort()).toEqual([
      "AFTER", "BEFORE", "CONTROL", "RACE", "RACE",
    ]);
  });

  it("answers every refusal under its own layer, read off production's own field", () => {
    expect(ACTIVE_GRAPH_PROJECTION_LAYER).toBe("ACTIVE_GRAPH_PROJECTION");
    const refusals = planningGraphProofs().filter((proof) => proof.arm !== "CONTROL");
    expect(refusals).toHaveLength(4);
    for (const proof of refusals) {
      expect(rawProof(proof)["ok"], `${proof.arm}: a refusal must not be admitted`).toBe(false);
      expect(rawProof(proof)["layer"], `${proof.arm}: this layer answered the caller`)
        .toBe(ACTIVE_GRAPH_PROJECTION_LAYER);
    }
  });

  it("names the body record as the SOURCE of the wrapped refusal, and null when it refused itself", () => {
    expect(GRAPH_BODY_RECORD_LAYER).toBe("GRAPH_BODY_RECORD");
    const refusals = planningGraphProofs().filter((proof) => proof.arm !== "CONTROL");
    const wrapped = refusals.filter((proof) => rawProof(proof)["code"] === BODY_UNAVAILABLE);
    // Exactly one arm is arranged to be answered through the body record. Zero would make
    // the source assertions below vacuous; more would mean another arm drifted into it.
    expect(wrapped).toHaveLength(1);
    for (const proof of wrapped) {
      expect(rawProof(proof)["sourceLayer"]).toBe(GRAPH_BODY_RECORD_LAYER);
      // The underlying code too: "some body problem" is not the property — the body row
      // for that hash is ABSENT, and a decode failure would be a different defect.
      expect(rawProof(proof)["sourceCode"]).toBe(BODY_ABSENT);
    }
    for (const proof of refusals.filter((entry) => !wrapped.includes(entry))) {
      // Originated here: a non-null source on these would mean the projection was blaming
      // a layer that never saw the input.
      expect(rawProof(proof)["sourceLayer"], `${proof.arm}: refused here, not below`).toBeNull();
      expect(rawProof(proof)["sourceCode"], `${proof.arm}: no underlying code`).toBeNull();
    }
  });
});

/** The body record's roster key and its own codes, restated BY HAND. */
const BODY_KEY = "GRAPH_BODY_RECORD_LAYER";

/**
 * THE ACCEPTED AND PASSTHROUGH CONTROLS for the durable body, run before the properties.
 *
 * The accepted one is the only case here that writes bytes through the real writer and
 * reads them back through the real reader: without it, three refusals are equally well
 * explained by a custodian that refuses everything. The passthrough one is the positive
 * control for the OTHER refusal family — without a codec-answered refusal in hand, "every
 * body refusal came from this module's own vocabulary" is a property nothing can break.
 */
describe("the graph-body record's controls", () => {
  it("hands back a lawfully written body, re-validated through the decoder", async () => {
    const accepted = await runAcceptedGraphBodyControl();
    collected.push(accepted);
    const read = accepted as Record<string, unknown>;
    expect(read["ok"], "a body written by the real writer must be readable").toBe(true);
    expect(read["graphContentHash"]).toBe(BODY_CONTROL_EXPECTATION.graphContentHash);
    expect(read["snapshotIdentity"]).toBe(BODY_CONTROL_EXPECTATION.snapshotIdentity);
    // The bytes come back as bytes, not as a re-serialisation: this record stores the
    // codec's own output verbatim and is forbidden from minting a second one.
    expect(read["bytes"]).toBeInstanceOf(Uint8Array);
  }, CASE_BOUND_MS);

  it("passes a CODEC verdict through, naming the codec as the source", async () => {
    const refused = await runGraphBodyPassthroughControl();
    const answer = refused as Record<string, unknown>;
    expect(answer["ok"]).toBe(false);
    // Reported by this record...
    expect(answer["layer"]).toBe(GRAPH_BODY_RECORD_LAYER);
    // ...but refused by the codec, and carrying the CODEC's vocabulary rather than this
    // module's. Both halves matter: a record that relabelled codec failures as its own
    // would satisfy the layer assertion alone.
    expect(answer["sourceLayer"]).not.toBeNull();
    expect(GRAPH_BODY_RECORD_CODES).not.toContain(answer["code"]);
  }, CASE_BOUND_MS);
});

/**
 * THE DURABLE BODY RECORD — the union its refusal code is typed with, made observable.
 *
 * `GraphBodyRefusal.code` is `GraphBodyRecordCode | GraphContentIssueCode`. A case asserting
 * a code and a layer cannot say WHICH family answered, and the two mean different things: an
 * own-family code is a custody failure (absent row, misfiled row, unencoded write), a
 * codec-family one is a content failure passed through. Membership in production's own frozen
 * list is what separates them here.
 */
describe("the durable graph-body boundary", () => {
  it("is rostered on this axis with exactly one BEFORE, one AFTER and one RACE arm", () => {
    expect(ROSTER_AXIS).toContain(BODY_KEY);
    const arms = armsFor(BODY_KEY);
    expect(arms.filter((arm) => arm === "BEFORE")).toHaveLength(1);
    expect(arms.filter((arm) => arm === "AFTER")).toHaveLength(1);
    expect(arms.filter((arm) => arm === "RACE")).toHaveLength(1);
  });

  it("captured one outcome per body call it actually made, and the count is positive", () => {
    const proofs = graphBodyProofs();
    expect(proofs.length).toBeGreaterThan(0);
    // BEFORE, AFTER, both sides of the race, the accepted control and the passthrough one.
    expect(proofs).toHaveLength(6);
    expect([...proofs].map((proof) => proof.arm).sort()).toEqual([
      "AFTER", "BEFORE", "CONTROL", "PASSTHROUGH", "RACE", "RACE",
    ]);
  });

  it("answers every hostile arm from its OWN vocabulary, with no source layer to blame", () => {
    expect(GRAPH_BODY_RECORD_LAYER).toBe("GRAPH_BODY_RECORD");
    const arms = graphBodyProofs()
      .filter((proof) => proof.arm !== "CONTROL" && proof.arm !== "PASSTHROUGH");
    // Four: BEFORE, AFTER and both sides of the race. Zero would make the loop vacuous.
    expect(arms).toHaveLength(4);
    for (const proof of arms) {
      const answer = rawProof(proof);
      expect(answer["ok"], `${proof.arm}: a refusal must not be admitted`).toBe(false);
      expect(answer["layer"], `${proof.arm}: this record answered`).toBe(GRAPH_BODY_RECORD_LAYER);
      // The family, read off production's own frozen list rather than a local spelling.
      expect(GRAPH_BODY_RECORD_CODES, `${proof.arm}: own vocabulary`).toContain(answer["code"]);
      // Originated here, so nothing below is being blamed for it.
      expect(answer["sourceLayer"], `${proof.arm}: refused here`).toBeNull();
    }
    // All three of this record's own codes are exercised, so the family assertion above is
    // not satisfied by one code repeated four times.
    expect([...new Set(arms.map((proof) => rawProof(proof)["code"]))].sort()).toEqual([
      "GRAPH_BODY_ABSENT", "GRAPH_BODY_IDENTITY_MISMATCH", "GRAPH_BODY_NOT_ENCODED",
    ]);
  });
});

describe("the whole slice", () => {
  it("never admits an activation, consumes a grant, or raises a truth class above UNKNOWN", () => {
    // One assertion over every collected outcome rather than one per case, so a case added
    // later cannot quietly escape the invariant. The races that legitimately admit exactly
    // one side are the only exception, and they are counted rather than exempted.
    const admittedTotal = collected.filter((outcome) => isAdmitted(outcome)).length;
    const allowed = RACES.reduce((sum, entry) => sum + entry.maxAdmitted, 0);
    // THE ACCEPTED CONTROL IS AN ADMISSION BY DESIGN, and the number it contributes is READ
    // OFF the value production returned rather than assumed: a control that had silently
    // refused would leave this at `allowed` and pass, which is why the control's own case
    // asserts `ok: true` separately. Hard-coding a `+ 1` here would assume the admission.
    const admittedControls = goalAcceptedControls()
      .filter((proof) => isAdmitted(proof.projected)).length
      + planningControls().filter((proof) => isAdmitted(proof.outcome)).length;
    expect(admittedTotal).toBe(allowed + admittedControls);
  });

  it("collected an outcome from every case, so nothing escaped by not running", () => {
    // Positive, so a control group that generated nothing cannot shrink this to the old total.
    expect(goalAcceptedControls().length).toBeGreaterThan(0);
    expect(planningControls().length).toBeGreaterThan(0);
    expect(collected).toHaveLength(
      CASES.length + RACES.length * 2 + goalAcceptedControls().length + planningControls().length,
    );
  });

  it("refused every verification before a verifier process was ever launched", () => {
    // The ORDERING property, stated observably. Each verification refusal above asserts its
    // code and layer, which a boundary that spawned the process first and refused afterwards
    // would satisfy in full. Only the launcher's own count separates the two.
    expect(verifierLaunchCount()).toBe(0);
  });
});
