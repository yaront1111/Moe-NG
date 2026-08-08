import { describe, expect, it } from "vitest";

import {
  makeAttempt,
  makeGrant,
  makeIntent,
  makeTombstone,
} from "./effect-test-fixtures.js";
import { RECONCILED, REGISTRATION } from "./race-scenarios.js";
import {
  GONE,
  labelOf,
  RELEASE,
  restartInput,
  SETTLED,
} from "./race-restart-scenarios.js";
import { reconstructAfterRestart, RESTART_POST_STATES } from "./restart-reconstruction.js";

/**
 * Crash points across the slice's transaction boundaries — DoD 3's restart half.
 *
 * Every expectation below is hand-written from the design and read off the
 * record set, never from a reconstruction run: a table built from the function
 * under test still agrees with itself after that function starts answering two
 * things at once.
 *
 * The companion file `supervisor-restart-authority.test.ts` carries the
 * re-proof-of-authority and premature-terminal halves; the split is the 400-line
 * per-file cap, not a change of subject.
 */
type CrashPoint = readonly [string, unknown, string];

const CRASH_POINTS: readonly CrashPoint[] = [
  [
    "before any attempt materialized",
    restartInput({
      ...GONE,
      intent: makeIntent({ state: "PENDING" }),
      attempt: null,
      attemptState: "ABSENT",
      grant: null,
    }),
    "post:TOMBSTONED",
  ],
  [
    "after the claim, before the arm",
    restartInput({
      ...GONE,
      intent: makeIntent({ state: "CLAIMED" }),
      attempt: null,
      attemptState: "ABSENT",
      grant: null,
    }),
    "post:TOMBSTONED",
  ],
  [
    "after the arm, with the lease already released",
    restartInput({
      ...GONE,
      intent: makeIntent(),
      attempt: null,
      attemptState: "LEASED",
      grant: null,
      resourceFact: "PROVEN_RELEASED",
    }),
    "post:TERMINAL_PROVEN",
  ],
  [
    "after the launch request, before the activation committed",
    restartInput({
      ...GONE,
      intent: makeIntent(),
      attempt: makeAttempt(),
      attemptState: "LAUNCH_REQUESTED",
      grant: null,
    }),
    "post:DRAINING",
  ],
  [
    "half a commit: the effect moved but the attempt did not",
    restartInput({ ...GONE, attempt: makeAttempt(), attemptState: "LAUNCH_REQUESTED" }),
    "refused:RESTART_RECORDS_INCOHERENT",
  ],
  [
    "half a commit: the attempt moved but the effect did not",
    restartInput({ ...GONE, intent: makeIntent() }),
    "refused:RESTART_RECORDS_INCOHERENT",
  ],
  [
    "a grant whose id does not derive from these successors",
    restartInput({ ...GONE, grant: makeGrant() }),
    "refused:RESTART_RECORDS_INCOHERENT",
  ],
  ["a whole commit with the lock still held", restartInput(), "post:ACTIVE_ADOPTED"],
  [
    "a whole commit whose lock is proven released",
    restartInput({ lockState: "RELEASED" }),
    "post:UNKNOWN",
  ],
  [
    "a whole commit whose lock cannot be read",
    restartInput({ lockState: "UNKNOWN" }),
    "post:SUSPECT",
  ],
  [
    "a process observation with no registration to identify it",
    restartInput({ ...GONE, observation: { kind: "EXITED", code: 0 } }),
    "post:SUSPECT",
  ],
  [
    "mid-drain, with the resource still unverifiable",
    restartInput({ ...GONE, attempt: null, attemptState: "DRAINING", resourceFact: "UNKNOWN" }),
    "post:DRAINING",
  ],
  [
    "mid-drain, released but with no adapter reconciliation",
    restartInput({
      ...GONE,
      attempt: null,
      attemptState: "DRAINING",
      resourceFact: "PROVEN_RELEASED",
    }),
    "refused:DRAIN_RESOURCE_UNRECONCILED",
  ],
  [
    "mid-drain, releasing without its exact safe handoff",
    restartInput({
      ...GONE,
      attempt: null,
      attemptState: "DRAINING",
      resourceFact: "PROVEN_RELEASED",
      reconciliation: RECONCILED,
      disposition: RELEASE,
    }),
    "refused:RESTART_SAFE_HANDOFF_ABSENT",
  ],
  [
    "after a tombstone dominated a pre-activation intent",
    restartInput({
      ...GONE,
      intent: makeIntent(),
      attempt: null,
      attemptState: "ABSENT",
      grant: null,
      tombstone: makeTombstone(),
    }),
    "post:TOMBSTONED",
  ],
  [
    "a terminal attempt over an effect that never settled",
    restartInput({ ...GONE, attempt: null, attemptState: "TERMINAL", grant: null }),
    "post:RECONCILE_ONLY",
  ],
  [
    "a settled effect with adapter proof behind it",
    restartInput({
      ...GONE,
      ...SETTLED,
      attemptState: "TERMINAL",
      resourceFact: "PROVEN_RELEASED",
      reconciliation: RECONCILED,
    }),
    "post:TERMINAL_PROVEN",
  ],
  [
    "a settled effect with nothing proving it",
    restartInput({
      ...GONE,
      ...SETTLED,
      attemptState: "TERMINAL",
      resourceFact: "PROVEN_RELEASED",
    }),
    "refused:RESTART_PREMATURE_TERMINAL",
  ],
  [
    "a settled effect whose resource is still unverifiable",
    restartInput({
      ...GONE,
      ...SETTLED,
      attemptState: "TERMINAL",
      resourceFact: "UNKNOWN",
      reconciliation: RECONCILED,
    }),
    "post:UNKNOWN",
  ],
];

// A zero-length table would make every `it.each` below disappear and the file
// would report green having asserted nothing. Fail at import instead.
if (CRASH_POINTS.length === 0) {
  throw new Error("the crash-point table is empty; every assertion below would be vacuous");
}

const EXPECTED_ANSWERS: readonly string[] = [
  "post:ACTIVE_ADOPTED",
  "post:DRAINING",
  "post:RECONCILE_ONLY",
  "post:SUSPECT",
  "post:TERMINAL_PROVEN",
  "post:TOMBSTONED",
  "post:UNKNOWN",
  "refused:DRAIN_RESOURCE_UNRECONCILED",
  "refused:RESTART_PREMATURE_TERMINAL",
  "refused:RESTART_RECORDS_INCOHERENT",
  "refused:RESTART_SAFE_HANDOFF_ABSENT",
];

describe("every crash point lands in exactly one legal post state", () => {
  it("seeds a non-zero, uniquely labelled crash-point table", () => {
    expect(CRASH_POINTS.length).toBe(19);
    expect(new Set(CRASH_POINTS.map(([label]) => label)).size).toBe(CRASH_POINTS.length);
  });

  it.each(CRASH_POINTS)("%s reconstructs to its one legal answer", (_label, input, expected) => {
    expect(labelOf(reconstructAfterRestart(input))).toBe(expected);
  });

  it("produces exactly the hand-written answer set and nothing wider", () => {
    const produced = new Set(
      CRASH_POINTS.map(([, input]) => labelOf(reconstructAfterRestart(input))),
    );
    expect(produced.size).toBeGreaterThan(0);
    expect([...produced].sort()).toEqual([...EXPECTED_ANSWERS].sort());
  });

  it("reaches every declared post state, so none is dead vocabulary", () => {
    const reached = CRASH_POINTS.map(([, input]) => reconstructAfterRestart(input))
      .filter((outcome) => outcome.kind === "RECONSTRUCTED")
      .map((outcome) => (outcome.kind === "RECONSTRUCTED" ? outcome.postState : ""));
    expect(reached.length).toBeGreaterThan(0);
    expect([...new Set(reached)].sort()).toEqual([...RESTART_POST_STATES].sort());
  });
});

/**
 * Capacity and NodeRun holds ARE the budget closure at this layer: a
 * reconstruction that dropped them would free a resource the external action is
 * still using, and one that kept them past a proven terminal would leak it.
 */
describe("budget and resource holds survive exactly as long as the evidence does", () => {
  const HELD_BY_POST_STATE: Readonly<Record<string, boolean>> = {
    ACTIVE_ADOPTED: true,
    DRAINING: true,
    RECONCILE_ONLY: false,
    SUSPECT: false,
    TERMINAL_PROVEN: false,
    TOMBSTONED: false,
    UNKNOWN: false,
  };

  it("holds capacity on exactly the post states that still own a resource", () => {
    let checked = 0;
    for (const [label, input] of CRASH_POINTS) {
      const outcome = reconstructAfterRestart(input);
      if (outcome.kind !== "RECONSTRUCTED") continue;
      checked += 1;
      expect([label, outcome.capacityHeld]).toEqual([
        label,
        HELD_BY_POST_STATE[outcome.postState],
      ]);
    }
    // Without this the loop would pass on a table of nothing but refusals.
    expect(checked).toBeGreaterThan(0);
  });

  it("keeps a mid-drain restart DRAINING with its holds intact", () => {
    const outcome = reconstructAfterRestart(
      restartInput({ ...GONE, attempt: null, attemptState: "DRAINING", resourceFact: "UNKNOWN" }),
    );
    expect(outcome.kind === "RECONSTRUCTED" && outcome.postState).toBe("DRAINING");
    expect(outcome.kind === "RECONSTRUCTED" && outcome.capacityHeld).toBe(true);
    expect(outcome.kind === "RECONSTRUCTED" && outcome.terminalTarget).toBe(null);
  });
});

describe("no restart answer leaks a secret it was handed", () => {
  it("never echoes the lease token or the bootstrap credential digest", () => {
    for (const [label, input] of CRASH_POINTS) {
      const serialized = JSON.stringify(reconstructAfterRestart(input));
      expect([label, serialized.includes("token-secret-1")]).toEqual([label, false]);
      expect([label, serialized.includes(REGISTRATION.bootstrapCredentialDigest)]).toEqual([
        label,
        false,
      ]);
    }
  });
});
