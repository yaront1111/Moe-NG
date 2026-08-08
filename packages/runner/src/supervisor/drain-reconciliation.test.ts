import { describe, expect, it } from "vitest";
import { CLAUDE_RECONCILIATION_VERSION } from "../providers/claude/claude-cancel-reconcile.js";
import { upgradeDisposition } from "./drain-disposition.js";
import {
  admitPostActivationMutation,
  lifecycleDemandsDrain,
  DRAIN_ADMITTED_COMMANDS,
} from "./drain-fence.js";
import { resolveDrainRow } from "./drain-reconciliation.js";
import { makeIntent } from "./effect-test-fixtures.js";
import {
  drainRank,
  drainTargetOf,
  DRAIN_PRECEDENCE,
  DRAIN_REASONS,
  DRAIN_TABLE_ROWS,
  DRAIN_TERMINAL_TARGETS,
  type DrainReason,
} from "./drain-table.js";
import type { SupervisorFailure } from "./effect-kernel.js";

const RECONCILED = Object.freeze({
  reconciliationVersion: CLAUDE_RECONCILIATION_VERSION,
  reconciliationDigest: "d1".repeat(32),
  outcomeClass: "CANCELLED_CLEAN",
});

function makeDisposition(reason: DrainReason): unknown {
  return {
    reasons: [reason],
    strongestReason: reason,
    terminalTarget: drainTargetOf(reason),
  };
}

function makeDrain(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    attemptState: "RUNNING",
    effectState: "ACTIVE",
    resourceFact: "ACTIVE",
    activationRequested: false,
    disposition: makeDisposition("WORK_CANCEL"),
    reconciliation: null,
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

function codeAndLayer(outcome: unknown): { code: string; layer: string } {
  const failure = failureOf(outcome);
  return { code: failure.code, layer: failure.layer };
}

/**
 * One input per design row, hand-built. The sweep below asserts this list covers
 * the table by SET EQUALITY on row ids, so a row added to the table without a
 * fixture fails rather than quietly going untested.
 */
const ROW_FIXTURES: ReadonlyArray<readonly [string, unknown]> = [
  ["R1", makeDrain({ attemptState: "ABSENT", effectState: "PENDING", resourceFact: "UNKNOWN" })],
  [
    "R2",
    makeDrain({
      attemptState: "LEASED",
      effectState: "ARMED",
      resourceFact: "PROVEN_RELEASED",
      disposition: makeDisposition("GOAL_CANCEL"),
    }),
  ],
  ["R3", makeDrain({ attemptState: "LAUNCH_REQUESTED", effectState: "ARMED", resourceFact: "UNKNOWN" })],
  [
    "R4",
    makeDrain({
      attemptState: "LAUNCH_REQUESTED",
      effectState: "ARMED",
      resourceFact: "PROVEN_RELEASED",
      activationRequested: true,
    }),
  ],
  ["R5", makeDrain()],
  ["R6", makeDrain({ attemptState: "TERMINAL", effectState: "UNKNOWN" })],
];

describe("design 786/787 table is hand-transcribed data", () => {
  it("carries exactly the six design rows in design order", () => {
    expect(DRAIN_TABLE_ROWS.length).toBeGreaterThan(0);
    expect(DRAIN_TABLE_ROWS.length).toBe(6);
    expect(DRAIN_TABLE_ROWS.map((row) => row.rowId)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]);
    expect(DRAIN_TABLE_ROWS.map((row) => row.designLine)).toEqual([785, 786, 787, 788, 789, 790]);
    expect(Object.isFrozen(DRAIN_TABLE_ROWS)).toBe(true);
  });

  /**
   * The resolver selects with `.find()`, so two rows matching one input would be
   * resolved silently by array order. Nothing else in the suite would notice:
   * every fixture would still land on whichever row happened to come first.
   * This sweeps the whole selector cartesian product and asserts AT MOST ONE row
   * claims each tuple, which is what makes the table's order irrelevant.
   */
  it("gives every selector tuple at most one row, so array order cannot decide", () => {
    const attempts = [...new Set(DRAIN_TABLE_ROWS.flatMap((row) => row.attemptStates))];
    const effects = [...new Set(DRAIN_TABLE_ROWS.flatMap((row) => row.effectStates))];
    const resources = [...new Set(DRAIN_TABLE_ROWS.flatMap((row) => row.resourceFacts))];
    const tuples = attempts.flatMap((attempt) =>
      effects.flatMap((effect) =>
        resources.flatMap((resource) =>
          [true, false].map((activation) => ({ attempt, effect, resource, activation })),
        ),
      ),
    );
    expect(tuples.length).toBeGreaterThan(0);
    expect(tuples.length).toBe(attempts.length * effects.length * resources.length * 2);
    const ambiguous = tuples.filter(
      ({ attempt, effect, resource, activation }) =>
        DRAIN_TABLE_ROWS.filter(
          (row) =>
            row.activationRequested === activation &&
            row.attemptStates.includes(attempt) &&
            row.effectStates.includes(effect) &&
            row.resourceFacts.includes(resource),
        ).length > 1,
    );
    expect(ambiguous).toEqual([]);
  });

  it("holds design 348's precedence as a strict total order", () => {
    expect(DRAIN_PRECEDENCE.length).toBe(DRAIN_REASONS.length);
    expect(DRAIN_PRECEDENCE.map((entry) => entry.rank)).toEqual([70, 60, 50, 40, 30, 20, 10]);
    expect(new Set(DRAIN_PRECEDENCE.map((entry) => entry.rank)).size).toBe(7);
    expect(new Set(DRAIN_PRECEDENCE.map((entry) => entry.reason)).size).toBe(7);
    for (const entry of DRAIN_PRECEDENCE) {
      expect(DRAIN_TERMINAL_TARGETS).toContain(entry.terminalTarget);
    }
  });
});

describe("every design row resolves to its declared disposition", () => {
  it("covers the table by set equality, with a non-zero fixture count", () => {
    expect(ROW_FIXTURES.length).toBeGreaterThan(0);
    expect(ROW_FIXTURES.map(([id]) => id).sort()).toEqual(
      DRAIN_TABLE_ROWS.map((row) => row.rowId).sort(),
    );
  });

  it.each(ROW_FIXTURES)("%s lands on its design disposition", (rowId, input) => {
    const row = DRAIN_TABLE_ROWS.find((candidate) => candidate.rowId === rowId);
    expect(row).toBeDefined();
    const outcome = resolveDrainRow(input);
    expect(outcome.kind).toBe(row?.outcomeKind);
    if (outcome.kind === "REFUSED") return;
    expect(outcome.row.rowId).toBe(rowId);
  });

  it("keeps capacity and the NodeRun hold while a pre-active row drains", () => {
    const outcome = resolveDrainRow(ROW_FIXTURES[2]?.[1]);
    expect(outcome.kind).toBe("DRAINING");
    if (outcome.kind !== "DRAINING") return;
    expect(outcome.capacityHeld).toBe(true);
    expect(outcome.nodeRunHeld).toBe(true);
    expect(outcome.providerSlotReleased).toBe(true);
  });

  /**
   * Proves the design-776 `ACTIVE -> CANCEL_REQUESTED` row added to
   * `ADMITTED_EFFECT_TRANSITIONS` is load-bearing: the drain names its successor
   * by consulting that table rather than inventing the edge.
   */
  it("names the admitted cancel successor for an ACTIVE effect", () => {
    const outcome = resolveDrainRow(makeDrain());
    expect(outcome.kind).toBe("DRAINING");
    if (outcome.kind !== "DRAINING") return;
    expect(outcome.cancelSuccessor).toBe("CANCEL_REQUESTED");
  });
});

describe("unknown resources never collapse into released", () => {
  const uncertain: ReadonlyArray<readonly [string, unknown]> = [
    ["ACTIVE", makeDrain({ attemptState: "LEASED", effectState: "ARMED", resourceFact: "ACTIVE" })],
    ["UNKNOWN", makeDrain({ attemptState: "LEASED", effectState: "ARMED", resourceFact: "UNKNOWN" })],
  ];

  it.each(uncertain)("a pre-active row with a %s resource drains instead of terminalizing", (_l, i) => {
    const outcome = resolveDrainRow(i);
    expect(outcome.kind).toBe("DRAINING");
    if (outcome.kind !== "DRAINING") return;
    expect(outcome.row.rowId).toBe("R3");
  });

  it("refuses to terminalize a running row before adapter reconciliation", () => {
    const outcome = resolveDrainRow(makeDrain({ resourceFact: "PROVEN_RELEASED" }));
    expect(codeAndLayer(outcome)).toEqual({ code: "DRAIN_RESOURCE_UNRECONCILED", layer: "DRAIN" });
  });

  it("terminalizes a running row once resources and adapter proof agree", () => {
    const outcome = resolveDrainRow(
      makeDrain({ resourceFact: "PROVEN_RELEASED", reconciliation: RECONCILED }),
    );
    expect(outcome.kind).toBe("TERMINALIZED");
    if (outcome.kind !== "TERMINALIZED") return;
    expect(outcome.strongestReason).toBe("WORK_CANCEL");
    expect(outcome.terminalTarget).toBe("CANCELLED");
  });
});

describe("disposition strength is monotonic", () => {
  const pairs = DRAIN_REASONS.flatMap((held) => DRAIN_REASONS.map((next) => ({ held, next })));

  it("sweeps every ordered pair of reasons", () => {
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length).toBe(DRAIN_REASONS.length * DRAIN_REASONS.length);
    expect(pairs.length).toBe(49);
  });

  it.each(pairs)("$held then $next never downgrades", ({ held, next }) => {
    const outcome = upgradeDisposition(makeDisposition(held), next);
    expect(outcome.kind).toBe("UPGRADED");
    if (outcome.kind !== "UPGRADED") return;
    const expected = drainRank(held) >= drainRank(next) ? held : next;
    expect(outcome.disposition.strongestReason).toBe(expected);
    expect(drainRank(outcome.disposition.strongestReason)).toBeGreaterThanOrEqual(drainRank(held));
    expect(outcome.disposition.terminalTarget).toBe(drainTargetOf(expected));
    expect(outcome.disposition.reasons).toContain(held);
    expect(outcome.disposition.reasons).toContain(next);
  });

  const downgrades: ReadonlyArray<readonly [string, unknown]> = [
    [
      "a strongest reason weaker than its own reason set",
      { reasons: ["URGENT_REVOKE", "WORK_CANCEL"], strongestReason: "WORK_CANCEL", terminalTarget: "CANCELLED" },
    ],
    [
      "a terminal target that disagrees with its strongest reason",
      { reasons: ["WORK_CANCEL"], strongestReason: "WORK_CANCEL", terminalTarget: "RELEASED" },
    ],
  ];

  it.each(downgrades)("refuses %s", (_label, disposition) => {
    expect(codeAndLayer(upgradeDisposition(disposition, "GOAL_CANCEL"))).toEqual({
      code: "DRAIN_DISPOSITION_NOT_MONOTONIC",
      layer: "DRAIN",
    });
  });

  it("refuses a downgraded disposition through the row resolver too", () => {
    const outcome = resolveDrainRow(makeDrain({ disposition: downgrades[0]?.[1] }));
    expect(codeAndLayer(outcome)).toEqual({
      code: "DRAIN_DISPOSITION_NOT_MONOTONIC",
      layer: "DRAIN",
    });
  });
});

describe("RELEASED requires the exact safe handoff", () => {
  const releasing = {
    resourceFact: "PROVEN_RELEASED",
    reconciliation: RECONCILED,
    disposition: makeDisposition("WORK_RELEASE_OR_PAUSE"),
  };

  it("refuses RELEASED without a handoff, and names the drain layer", () => {
    expect(codeAndLayer(resolveDrainRow(makeDrain(releasing)))).toEqual({
      code: "RESTART_SAFE_HANDOFF_ABSENT",
      layer: "DRAIN",
    });
  });

  it("terminalizes RELEASED once the exact handoff is present", () => {
    const outcome = resolveDrainRow(makeDrain({ ...releasing, safeHandoff: "handoff-1" }));
    expect(outcome.kind).toBe("TERMINALIZED");
    if (outcome.kind !== "TERMINALIZED") return;
    expect(outcome.terminalTarget).toBe("RELEASED");
    expect(outcome.safeHandoff).toBe("handoff-1");
  });
});

describe("fencing is authoritative even while DRAINING", () => {
  it("admits every drain-whitelisted command, with a non-zero sweep", () => {
    expect(DRAIN_ADMITTED_COMMANDS.length).toBeGreaterThan(0);
    for (const command of DRAIN_ADMITTED_COMMANDS) {
      expect(admitPostActivationMutation("DRAINING", command).kind).toBe("ADMITTED");
    }
  });

  const refused: ReadonlyArray<readonly [string, unknown]> = [
    ["a business mutation", "step.start"],
    ["a new effect", "effect.activate"],
    ["an unrecognised command", "totally.unknown"],
    ["a non-string command", 7],
  ];

  it.each(refused)("refuses %s while DRAINING", (_label, command) => {
    expect(codeAndLayer(admitPostActivationMutation("DRAINING", command))).toEqual({
      code: "DRAIN_POST_ACTIVATION_MUTATION_REFUSED",
      layer: "DRAIN",
    });
  });

  it("fails closed on an attempt state it does not recognise", () => {
    expect(codeAndLayer(admitPostActivationMutation("HOVERING", "runner.observe"))).toEqual({
      code: "DRAIN_POST_ACTIVATION_MUTATION_REFUSED",
      layer: "DRAIN",
    });
  });
});

describe("the drain requirement comes from the lifecycle, not a second derivation", () => {
  it("reads MUST_DRAIN off the reducer for an ACTIVE cancel", () => {
    expect(lifecycleDemandsDrain(makeIntent({ state: "ACTIVE" }), { kind: "requestCancel" })).toBe(
      true,
    );
  });

  it("does not claim a drain for a pre-activation cancel", () => {
    expect(lifecycleDemandsDrain(makeIntent({ state: "ARMED" }), { kind: "requestCancel" })).toBe(
      false,
    );
  });
});

describe("no row match means no default", () => {
  const unmatched: ReadonlyArray<readonly [string, unknown]> = [
    ["an absent attempt over an ACTIVE effect", makeDrain({ attemptState: "ABSENT" })],
    ["a terminal effect on a running attempt", makeDrain({ effectState: "SUCCEEDED" })],
    ["an undeclared attempt state", makeDrain({ attemptState: "HOVERING" })],
    ["an undeclared resource fact", makeDrain({ resourceFact: "PROBABLY_GONE" })],
    ["a non-record", "RUNNING"],
    ["an extra key", { ...(makeDrain() as object), shadow: 1 }],
  ];

  it.each(unmatched)("refuses %s rather than falling through", (_label, input) => {
    expect(codeAndLayer(resolveDrainRow(input))).toEqual({
      code: "DRAIN_ROW_NOT_ADMITTED",
      layer: "DRAIN",
    });
  });
});
