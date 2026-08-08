import { describe, expect, it } from "vitest";

import {
  checkGrantOrdering,
  COMMITTED_ACTIVATION_PAIR,
  createRecorder,
  HONEST_IN_TEN,
  RACE_SEEDS,
  RACE_STEPS,
  runTrace,
  seeded,
  type RaceEvent,
} from "./race-harness.js";
import { RACE_COMMANDS, statePool } from "./race-world.js";

/**
 * The harness checks the supervisor; this file checks the harness. A schedule
 * generator nobody audits is the cheapest place for the whole gate to go
 * vacuous — a seed that is ignored, a step loop that exits early, or a bias that
 * silently never tampers would all leave every downstream assertion green.
 */
describe("the seeded schedule is reproducible and seed-sensitive", () => {
  it("replays one seed to a bit-identical schedule", () => {
    expect(runTrace(11, 120)).toEqual(runTrace(11, 120));
  });

  it("produces a different schedule for a different seed, so the seed is used", () => {
    expect(runTrace(11, 120)).not.toEqual(runTrace(12, 120));
  });

  it("refuses the xorshift fixed point instead of emitting one value forever", () => {
    expect(() => seeded(0)).toThrow(/fixed point/);
  });

  it("executes exactly the requested number of steps, in order", () => {
    const trace = runTrace(RACE_SEEDS[0], 50);
    expect(trace.steps.length).toBe(50);
    expect(trace.steps.map((step) => step.index)).toEqual([...Array(50).keys()]);
  });

  it("draws from the whole command alphabet rather than one arm", () => {
    const drawn = new Set(
      RACE_SEEDS.flatMap((seed) => runTrace(seed, RACE_STEPS).steps.map((step) => step.command)),
    );
    expect([...drawn].sort()).toEqual([...RACE_COMMANDS].sort());
  });
});

describe("the honest/tamper bias is real in both directions", () => {
  const steps = RACE_SEEDS.flatMap((seed) => runTrace(seed, RACE_STEPS).steps);

  it("emits a non-zero count of BOTH honest and tampered commands", () => {
    const honest = steps.filter((step) => step.honest).length;
    // Both bounds matter: a 100/0 bias never drills a refusal and a 0/100 bias
    // never reaches a post-activation cell. Either would pass a "some honest,
    // some tampered" check written as a single inequality.
    expect(honest).toBeGreaterThan(0);
    expect(steps.length - honest).toBeGreaterThan(0);
  });

  it("holds the documented 70/30 proportion within sampling noise", () => {
    const honest = steps.filter((step) => step.honest).length / steps.length;
    expect(HONEST_IN_TEN).toBe(7);
    expect(honest).toBeGreaterThan(0.6);
    expect(honest).toBeLessThan(0.8);
  });
});

describe("the asserted-good state pool is built from real transitions", () => {
  it("seeds exactly the five states the schedule needs to explore", () => {
    expect(statePool().map((world) => world.intent.state)).toEqual([
      "PENDING",
      "CLAIMED",
      "ARMED",
      "ACTIVE",
      "CANCEL_REQUESTED",
    ]);
  });

  it("carries a committed grant on the ACTIVE member and none before it", () => {
    const pool = statePool();
    expect(pool.filter((world) => world.grant !== null).map((world) => world.intent.state)).toEqual(
      ["ACTIVE"],
    );
  });
});

describe("the outcome recorder counts what it observes and drops nothing", () => {
  it("tallies a known sequence to exact per-kind counts", () => {
    const recorder = createRecorder();
    for (const label of ["OK:LIFE:CLAIMED", "OK:LIFE:CLAIMED", "NO:LIFECYCLE:EFFECT_TERMINAL_ABSORBED"]) {
      recorder.record(label);
    }
    expect(recorder.kinds()).toEqual(["NO:LIFECYCLE:EFFECT_TERMINAL_ABSORBED", "OK:LIFE:CLAIMED"]);
    expect(recorder.counts().get("OK:LIFE:CLAIMED")).toBe(2);
    expect(recorder.counts().get("NO:LIFECYCLE:EFFECT_TERMINAL_ABSORBED")).toBe(1);
    expect(recorder.total()).toBe(3);
  });

  it("fails loudly on an undeclared kind rather than dropping it", () => {
    const recorder = createRecorder(["OK:LIFE:CLAIMED"]);
    recorder.record("OK:LIFE:CLAIMED");
    expect(() => recorder.record("OK:LIFE:SMUGGLED")).toThrow(/undeclared outcome kind/);
    expect(recorder.total()).toBe(1);
  });

  it("hands back a copy, so a caller cannot edit the tally it is judged on", () => {
    const recorder = createRecorder();
    recorder.record("OK:LIFE:ARMED");
    (recorder.counts() as Map<string, number>).set("OK:LIFE:ARMED", 99);
    expect(recorder.counts().get("OK:LIFE:ARMED")).toBe(1);
  });
});

/**
 * The grant-ordering check is the harness half of DoD 2, so it gets fed
 * deliberately broken synthetic logs. An invariant that never fires on a known
 * violation is not testing anything, and this one has to survive being the only
 * thing standing between a reordered schedule and a green suite.
 */
describe("the grant-ordering invariant is load-bearing", () => {
  const issued: RaceEvent = {
    index: 4,
    kind: "GRANT_ISSUED",
    grantId: "grant-a",
    pair: COMMITTED_ACTIVATION_PAIR,
  };
  const launch: RaceEvent = { index: 9, kind: "LAUNCH", grantId: "grant-a", pair: null };

  it("passes a log whose launch follows its committed activation", () => {
    expect(checkGrantOrdering([issued, launch])).toEqual([]);
  });

  it("fails the same two events reordered, naming the launch that got ahead", () => {
    const violations = checkGrantOrdering([{ ...launch, index: 1 }, issued]);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("launch precedes any activation of grant-a");
  });

  it("fails a launch of a grant no activation ever minted", () => {
    const violations = checkGrantOrdering([issued, { ...launch, grantId: "grant-forged" }]);
    expect(violations).toEqual(["step 9: launch precedes any activation of grant-forged"]);
  });

  it("fails a grant minted by half an activation pair", () => {
    const half = { ...issued, pair: "ARMED->ACTIVE|LAUNCH_REQUESTED->LAUNCH_REQUESTED" };
    const violations = checkGrantOrdering([half, launch]);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("uncommitted pair");
  });

  it("fails a grant minted with no recorded pair at all", () => {
    const violations = checkGrantOrdering([{ ...issued, pair: null }, launch]);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("uncommitted pair");
  });
});
