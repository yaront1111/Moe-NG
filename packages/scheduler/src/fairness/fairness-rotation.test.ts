import { describe, expect, it } from "vitest";

import { MAX_AUTHORITY_COUNT } from "../authority/authority-kernel.js";
import type {
  FairnessContractIssue,
  FairnessContractRefusal,
  FairnessContractResult,
} from "./fairness-contract.js";
import type { FairnessRing, FairnessRingQueueEntry } from "./fairness-ring.js";
import {
  FAIRNESS_DIMENSION_CEILING,
  FAIRNESS_SERVICE_COST,
  resourceRotationOrder,
  rotateOnce,
} from "./fairness-rotation.js";
import type { FairnessRotationOutcome } from "./fairness-rotation.js";

const DIMENSION = "dim.alpha";

function resource(resourceId: string, weight: number): unknown {
  return { resourceId, weight };
}

function entry(workItemId: string, resourceId: string, deficitCounter = 0): unknown {
  return { workItemId, resourceId, deficitCounter };
}

function ringOf(
  resources: readonly unknown[],
  entries: readonly unknown[],
  dimensionId: string = DIMENSION,
): unknown {
  return { ringId: "ring.main", dimensionId, resources, entries };
}

function item(
  workItemId: string,
  resourceId: string,
  overrides: { readonly dimensionId?: string; readonly state?: string } = {},
): unknown {
  return {
    workItemId,
    dimensionId: overrides.dimensionId ?? DIMENSION,
    priority: "P2",
    resourceId,
    dispatchability: {
      state: overrides.state ?? "DISPATCHABLE",
      observationRef: `obs.${workItemId}`,
    },
  };
}

function capacity(resourceId: string, capacityUnits: number, inFlightUnits = 0): unknown {
  return { resourceId, capacityUnits, inFlightUnits };
}

function request(parts: {
  readonly ring: unknown;
  readonly workItems: readonly unknown[];
  readonly capacities: readonly unknown[];
  readonly forcedHead?: unknown;
  readonly capRevision?: unknown;
}): unknown {
  return {
    ring: parts.ring,
    workItems: parts.workItems,
    capacities: parts.capacities,
    forcedHead: parts.forcedHead ?? null,
    capRevision: parts.capRevision ?? null,
  };
}

/** The single issue of a refusal, asserting the refusal shape on the way. */
function soleIssue(result: FairnessContractResult<unknown>): FairnessContractIssue {
  expect(result.ok).toBe(false);
  const refusal = result as FairnessContractRefusal;
  expect(refusal.issues).toHaveLength(1);
  return refusal.issues[0] as FairnessContractIssue;
}

function unwrap<T>(result: FairnessContractResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected an accepted value, got ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

function accepted(result: FairnessContractResult<FairnessRotationOutcome>): FairnessRotationOutcome {
  return unwrap(result);
}

interface DrivenRotation {
  readonly dispositions: readonly string[];
  readonly picks: readonly string[];
  readonly resources: readonly string[];
  readonly ring: FairnessRing;
}

/**
 * Feeds each outcome's ring back in, exactly as a consumer would. It asserts
 * nothing itself: every property is asserted against `rotateOnce` by the caller.
 */
function drive(
  initialRing: unknown,
  workItems: readonly unknown[],
  capacities: readonly unknown[],
  selections: number,
): DrivenRotation {
  const dispositions: string[] = [];
  const picks: string[] = [];
  const resources: string[] = [];
  let ring: unknown = initialRing;
  for (let index = 0; index < selections; index += 1) {
    const outcome = accepted(rotateOnce(request({ ring, workItems, capacities })));
    dispositions.push(outcome.disposition);
    if (outcome.selection !== null) {
      picks.push(outcome.selection.workItemId);
      resources.push(outcome.selection.resourceId);
    }
    ring = outcome.ring;
  }
  return { dispositions, picks, resources, ring: ring as FairnessRing };
}

/** Weights 3 and 1: one full round serves four items, three of them on `res.a`. */
const WEIGHTED_RESOURCES = [resource("res.a", 3), resource("res.b", 1)];
const WEIGHTED_ROUND = 3 + 1;
const WEIGHTED_ITEMS = [
  item("wi.a1", "res.a"), item("wi.a2", "res.a"), item("wi.a3", "res.a"),
  item("wi.a4", "res.a"), item("wi.b1", "res.b"), item("wi.b2", "res.b"),
];
const WEIGHTED_CAPACITIES = [capacity("res.a", 64), capacity("res.b", 64)];

describe("rotation determinism", () => {
  const interleaved = [
    entry("wi.a1", "res.a"), entry("wi.b1", "res.b"),
    entry("wi.a2", "res.a"), entry("wi.b2", "res.b"),
  ];
  // Same per-resource FIFO queues, but res.b appears FIRST. That inversion is
  // the point: a grouping that still led with res.a would select identically
  // under an array-position-derived order too, and the case would prove nothing.
  const grouped = [
    entry("wi.b1", "res.b"), entry("wi.b2", "res.b"),
    entry("wi.a1", "res.a"), entry("wi.a2", "res.a"),
  ];

  it("selects the same sequence on repeated identical runs", () => {
    const first = drive(ringOf(WEIGHTED_RESOURCES, interleaved), WEIGHTED_ITEMS, WEIGHTED_CAPACITIES, 4);
    const second = drive(ringOf(WEIGHTED_RESOURCES, interleaved), WEIGHTED_ITEMS, WEIGHTED_CAPACITIES, 4);
    expect(first.picks).toEqual(second.picks);
    expect(first.picks).toHaveLength(4);
  });

  it("selects the same sequence when entries are re-serialized into a different interleaving", () => {
    // Same per-resource FIFO queues, different flat array order. `entries` carries
    // no implied traversal order BETWEEN queues (fairness-ring.ts:54-58), so a
    // rotation keyed on array position would diverge here and nowhere else.
    expect(JSON.stringify(interleaved)).not.toEqual(JSON.stringify(grouped));
    const fromInterleaved = drive(
      ringOf(WEIGHTED_RESOURCES, interleaved), WEIGHTED_ITEMS, WEIGHTED_CAPACITIES, 4);
    const fromGrouped = drive(
      ringOf(WEIGHTED_RESOURCES, grouped), WEIGHTED_ITEMS, WEIGHTED_CAPACITIES, 4);
    expect(fromInterleaved.picks).toEqual(fromGrouped.picks);
  });

  it("derives rotation order from resourceId, not from declaration order", () => {
    const ascending = ringOf([resource("res.a", 1), resource("res.b", 1)], []);
    const descending = ringOf([resource("res.b", 1), resource("res.a", 1)], []);
    expect(unwrap(resourceRotationOrder(ascending))).toEqual(["res.a", "res.b"]);
    expect(unwrap(resourceRotationOrder(descending))).toEqual(["res.a", "res.b"]);
  });
});

describe("rotation work conservation", () => {
  it("serves a lower-weight queue while the highest-weight resource is empty", () => {
    // `res.a` carries the largest share and NO entries. A textbook deficit loop
    // spends its turn there and idles; this must not.
    const ring = ringOf(
      [resource("res.a", 5), resource("res.b", 1)],
      [entry("wi.b1", "res.b"), entry("wi.b2", "res.b"), entry("wi.b3", "res.b")],
    );
    const items = [item("wi.b1", "res.b"), item("wi.b2", "res.b"), item("wi.b3", "res.b")];
    const driven = drive(ring, items, WEIGHTED_CAPACITIES, 3);
    expect(driven.dispositions).toEqual(["SELECTED", "SELECTED", "SELECTED"]);
    expect(driven.picks).toEqual(["wi.b1", "wi.b2", "wi.b3"]);
  });

  it("keeps serving other resources when one head is not dispatchable", () => {
    const ring = ringOf(
      [resource("res.a", 1), resource("res.b", 1)],
      [entry("wi.a1", "res.a"), entry("wi.b1", "res.b")],
    );
    const items = [item("wi.a1", "res.a", { state: "NOT_DISPATCHABLE" }), item("wi.b1", "res.b")];
    const outcome = accepted(rotateOnce(request({ ring, workItems: items, capacities: WEIGHTED_CAPACITIES })));
    expect(outcome.disposition).toBe("SELECTED");
    expect(outcome.selection?.workItemId).toBe("wi.b1");
  });

  it("idles only when no queue has a servable head", () => {
    const outcome = accepted(rotateOnce(request({
      ring: ringOf([resource("res.a", 1)], []),
      workItems: [],
      capacities: [capacity("res.a", 4)],
    })));
    expect(outcome.disposition).toBe("IDLE_NO_SERVABLE_HEAD");
    expect(outcome.selection).toBeNull();
  });
});

describe("rotation capacity bounds", () => {
  it("never selects from a resource whose in-flight units reached its capacity", () => {
    const ring = ringOf(
      [resource("res.a", 3), resource("res.b", 1)],
      [entry("wi.a1", "res.a"), entry("wi.a2", "res.a"), entry("wi.b1", "res.b"),
        entry("wi.b2", "res.b")],
    );
    const driven = drive(ring, WEIGHTED_ITEMS,
      [capacity("res.a", 2, 2), capacity("res.b", 8)], 2);
    expect(driven.resources).toEqual(["res.b", "res.b"]);
    expect(driven.picks).toEqual(["wi.b1", "wi.b2"]);
  });

  it("idles at the per-dimension ceiling even while per-resource capacity remains", () => {
    const half = FAIRNESS_DIMENSION_CEILING / 2;
    const outcome = accepted(rotateOnce(request({
      ring: ringOf([resource("res.a", 1), resource("res.b", 1)], [entry("wi.a1", "res.a")]),
      workItems: [item("wi.a1", "res.a")],
      capacities: [capacity("res.a", half + 8, half), capacity("res.b", half + 8, half)],
    })));
    expect(outcome.disposition).toBe("IDLE_CAPACITY_BOUND");
    expect(outcome.selection).toBeNull();
  });

  it("refuses a capacity record whose in-flight units exceed its capacity", () => {
    const issue = soleIssue(rotateOnce(request({
      ring: ringOf([resource("res.a", 1)], [entry("wi.a1", "res.a")]),
      workItems: [item("wi.a1", "res.a")],
      capacities: [capacity("res.a", 1, 2)],
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED");
    expect(issue.layer).toBe("RESOURCE");
  });

  it("refuses a capacity record for a resource the ring does not declare", () => {
    // A verdict, not an absence — so REFUSED where a missing record is UNKNOWN.
    // Its inFlightUnits would otherwise be summed into the per-dimension
    // ceiling, letting an unverifiable input decide whether the ring dispatches.
    const result = rotateOnce(request({
      ring: ringOf([resource("res.a", 1)], [entry("wi.a1", "res.a")]),
      workItems: [item("wi.a1", "res.a")],
      capacities: [capacity("res.a", 4), capacity("res.ghost", 9_999, 9_999)],
    }));
    const issue = soleIssue(result);
    expect((result as FairnessContractRefusal).disposition).toBe("REFUSED");
    expect(issue.code).toBe("FAIRNESS_CONTRACT_UNDECLARED_RESOURCE");
    expect(issue.layer).toBe("RESOURCE");
  });

  it("returns UNKNOWN naming the missing capacity record for a declared resource", () => {
    const result = rotateOnce(request({
      ring: ringOf([resource("res.a", 1), resource("res.b", 1)], [entry("wi.a1", "res.a")]),
      workItems: [item("wi.a1", "res.a")],
      capacities: [capacity("res.a", 4)],
    }));
    const issue = soleIssue(result);
    expect((result as FairnessContractRefusal).disposition).toBe("UNKNOWN");
    expect(issue.code).toBe("FAIRNESS_CONTRACT_UNDECLARED_RESOURCE");
    expect(issue.layer).toBe("RESOURCE");
    expect(issue.missingInput).toBe("capacities[res.b]");
  });
});

describe("rotation starvation bound", () => {
  it("serves the lowest-weight resource within one weighted round", () => {
    // The bound is arithmetic, not eventual: one round serves sum(weights)
    // items, and every non-empty queue is served at least once inside it.
    const ring = ringOf(WEIGHTED_RESOURCES, [
      entry("wi.a1", "res.a"), entry("wi.a2", "res.a"), entry("wi.a3", "res.a"),
      entry("wi.a4", "res.a"), entry("wi.b1", "res.b"),
    ]);
    const driven = drive(ring, WEIGHTED_ITEMS, WEIGHTED_CAPACITIES, WEIGHTED_ROUND);
    expect(driven.resources).toHaveLength(WEIGHTED_ROUND);
    expect(driven.resources.indexOf("res.b")).toBeGreaterThanOrEqual(0);
    expect(driven.resources.indexOf("res.b")).toBeLessThan(WEIGHTED_ROUND);
  });

  it("serves each resource exactly its weight over one round", () => {
    const ring = ringOf(WEIGHTED_RESOURCES, [
      entry("wi.a1", "res.a"), entry("wi.a2", "res.a"), entry("wi.a3", "res.a"),
      entry("wi.a4", "res.a"), entry("wi.b1", "res.b"), entry("wi.b2", "res.b"),
    ]);
    const driven = drive(ring, WEIGHTED_ITEMS, WEIGHTED_CAPACITIES, WEIGHTED_ROUND);
    expect(driven.resources.filter((each) => each === "res.a")).toHaveLength(3);
    expect(driven.resources.filter((each) => each === "res.b")).toHaveLength(1);
  });

  it("refuses a zero-weight resource that holds queued entries", () => {
    // A zero-weight queue can never accrue service credit, so it would starve
    // without bound. Refusing is the only fail-closed answer.
    const issue = soleIssue(rotateOnce(request({
      ring: ringOf([resource("res.a", 0)], [entry("wi.a1", "res.a")]),
      workItems: [item("wi.a1", "res.a")],
      capacities: [capacity("res.a", 4)],
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_INVALID_COUNTER");
    expect(issue.layer).toBe("RESOURCE");
  });
});

describe("rotation forced heads", () => {
  const ring = ringOf(WEIGHTED_RESOURCES, [entry("wi.a1", "res.a"), entry("wi.b1", "res.b")]);

  it("selects the forced head ahead of the derived rotation order", () => {
    const outcome = accepted(rotateOnce(request({
      ring, workItems: WEIGHTED_ITEMS, capacities: WEIGHTED_CAPACITIES, forcedHead: "wi.b1",
    })));
    expect(outcome.selection?.workItemId).toBe("wi.b1");
  });

  it("refuses a forced head that names a work item absent from the ring", () => {
    const issue = soleIssue(rotateOnce(request({
      ring, workItems: WEIGHTED_ITEMS, capacities: WEIGHTED_CAPACITIES, forcedHead: "wi.a4",
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_INVALID_IDENTITY");
    expect(issue.layer).toBe("RING");
  });

  it("refuses a forced head whose resource is at capacity rather than silently skipping it", () => {
    const issue = soleIssue(rotateOnce(request({
      ring, workItems: WEIGHTED_ITEMS, forcedHead: "wi.b1",
      capacities: [capacity("res.a", 8), capacity("res.b", 1, 1)],
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED");
    expect(issue.layer).toBe("RING");
  });

  it("refuses a forced head whose work item is not dispatchable", () => {
    const issue = soleIssue(rotateOnce(request({
      ring, capacities: WEIGHTED_CAPACITIES, forcedHead: "wi.b1",
      workItems: [item("wi.a1", "res.a"), item("wi.b1", "res.b", { state: "NOT_DISPATCHABLE" })],
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_DISPATCHABILITY_UNOBSERVED");
    expect(issue.layer).toBe("RING");
  });

  it("refuses a forced head at the per-dimension ceiling rather than raising the cap", () => {
    // Forcing changes ORDER. If it could also admit work past the ceiling it
    // would have become a cap-raising mechanism, which is a second authority.
    const half = FAIRNESS_DIMENSION_CEILING / 2;
    const issue = soleIssue(rotateOnce(request({
      ring, workItems: WEIGHTED_ITEMS, forcedHead: "wi.b1",
      capacities: [capacity("res.a", half + 8, half), capacity("res.b", half + 8, half)],
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED");
    expect(issue.layer).toBe("RING");
  });

  it("spends the forced head's credit instead of carrying it to the next head", () => {
    const forced = ringOf(WEIGHTED_RESOURCES, [
      entry("wi.b1", "res.b", 5), entry("wi.b2", "res.b", 0),
    ]);
    const outcome = accepted(rotateOnce(request({
      ring: forced, workItems: WEIGHTED_ITEMS, capacities: WEIGHTED_CAPACITIES, forcedHead: "wi.b1",
    })));
    const remaining = outcome.ring.entries.find(
      (each: FairnessRingQueueEntry) => each.workItemId === "wi.b2");
    expect(remaining?.deficitCounter).toBe(0);
  });
});

describe("rotation cap revisions", () => {
  const ring = ringOf(WEIGHTED_RESOURCES, [entry("wi.a1", "res.a")]);
  const items = [item("wi.a1", "res.a")];

  function revision(parts: {
    readonly dimensionId?: string;
    readonly toCapUnits?: number;
    readonly drained?: readonly string[];
  }): unknown {
    return {
      revisionRef: "rev.1",
      dimensionId: parts.dimensionId ?? DIMENSION,
      fromCapUnits: 64,
      toCapUnits: parts.toCapUnits ?? 64,
      drainedWorkItemIds: parts.drained ?? [],
      migrations: [],
    };
  }

  it("accepts a revision scoped to the ring's own dimension", () => {
    const outcome = accepted(rotateOnce(request({
      ring, workItems: items, capacities: WEIGHTED_CAPACITIES, capRevision: revision({}),
    })));
    expect(outcome.selection?.workItemId).toBe("wi.a1");
  });

  it("refuses a revision scoped to a different dimension", () => {
    const issue = soleIssue(rotateOnce(request({
      ring, workItems: items, capacities: WEIGHTED_CAPACITIES,
      capRevision: revision({ dimensionId: "dim.beta" }),
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_DIMENSION_MISMATCH");
    expect(issue.layer).toBe("CAP_REVISION");
  });

  it("refuses when a revision drains a work item that is still queued", () => {
    const issue = soleIssue(rotateOnce(request({
      ring, workItems: items, capacities: WEIGHTED_CAPACITIES,
      capRevision: revision({ drained: ["wi.a1"] }),
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_MIGRATION_TARGET_DRAINED");
    expect(issue.layer).toBe("CAP_REVISION");
  });

  it("refuses when in-flight units already exceed the revised cap", () => {
    const issue = soleIssue(rotateOnce(request({
      ring, workItems: items, capRevision: revision({ toCapUnits: 3 }),
      capacities: [capacity("res.a", 16, 4), capacity("res.b", 16, 0)],
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED");
    expect(issue.layer).toBe("CAP_REVISION");
  });

  it("refuses a structurally invalid revision at the cap-revision layer", () => {
    const issue = soleIssue(rotateOnce(request({
      ring, workItems: items, capacities: WEIGHTED_CAPACITIES,
      capRevision: { ...(revision({}) as Record<string, unknown>), toCapUnits: -1 },
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_INVALID_COUNTER");
    expect(issue.layer).toBe("CAP_REVISION");
  });
});

describe("rotation identity and arithmetic", () => {
  it("refuses a work item set scoped to a different dimension than the ring", () => {
    const issue = soleIssue(rotateOnce(request({
      ring: ringOf(WEIGHTED_RESOURCES, [entry("wi.a1", "res.a")]),
      workItems: [item("wi.a1", "res.a", { dimensionId: "dim.beta" })],
      capacities: WEIGHTED_CAPACITIES,
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_DIMENSION_MISMATCH");
    expect(issue.layer).toBe("WORK_ITEM");
  });

  it("refuses a queue entry naming a work item absent from the validated set", () => {
    const issue = soleIssue(rotateOnce(request({
      ring: ringOf(WEIGHTED_RESOURCES, [entry("wi.a1", "res.a")]),
      workItems: [item("wi.b1", "res.b")],
      capacities: WEIGHTED_CAPACITIES,
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_INVALID_IDENTITY");
    expect(issue.layer).toBe("RING");
  });

  it("refuses a queue entry that places a work item on a resource it does not name", () => {
    const issue = soleIssue(rotateOnce(request({
      ring: ringOf(WEIGHTED_RESOURCES, [entry("wi.a1", "res.b")]),
      workItems: [item("wi.a1", "res.a")],
      capacities: WEIGHTED_CAPACITIES,
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_UNDECLARED_RESOURCE");
    expect(issue.layer).toBe("RING");
  });

  it("refuses when carrying a residual deficit onto the next head would leave the safe range", () => {
    const issue = soleIssue(rotateOnce(request({
      ring: ringOf([resource("res.a", 1)], [
        entry("wi.a1", "res.a", MAX_AUTHORITY_COUNT),
        entry("wi.a2", "res.a", MAX_AUTHORITY_COUNT),
      ]),
      workItems: [item("wi.a1", "res.a"), item("wi.a2", "res.a")],
      capacities: [capacity("res.a", 8)],
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_INVALID_COUNTER");
    expect(issue.layer).toBe("RING");
  });

  it("refuses when advancing a round would push a deficit past the safe range", () => {
    const issue = soleIssue(rotateOnce(request({
      ring: ringOf(WEIGHTED_RESOURCES, [
        entry("wi.a1", "res.a", MAX_AUTHORITY_COUNT), entry("wi.b1", "res.b", 0),
      ]),
      workItems: [item("wi.a1", "res.a"), item("wi.b1", "res.b")],
      capacities: [capacity("res.a", 1, 1), capacity("res.b", 8)],
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_INVALID_COUNTER");
    expect(issue.layer).toBe("RING");
  });

  it("refuses a malformed request record before reading any field", () => {
    const issue = soleIssue(rotateOnce({ ring: null }));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_MALFORMED_INPUT");
    expect(issue.layer).toBe("RING");
  });

  it("costs exactly one service unit per selection", () => {
    expect(FAIRNESS_SERVICE_COST).toBe(1);
    const outcome = accepted(rotateOnce(request({
      ring: ringOf([resource("res.a", 4)], [entry("wi.a1", "res.a"), entry("wi.a2", "res.a")]),
      workItems: [item("wi.a1", "res.a"), item("wi.a2", "res.a")],
      capacities: [capacity("res.a", 8)],
    })));
    const next = outcome.ring.entries.find(
      (each: FairnessRingQueueEntry) => each.workItemId === "wi.a2");
    expect(outcome.roundsAdvanced).toBe(1);
    expect(next?.deficitCounter).toBe(4 - FAIRNESS_SERVICE_COST);
  });
});

/**
 * Every hostile identifier is swept through each field that carries one, and the
 * REFUSING LAYER differs per field, so each expectation names one exact layer
 * rather than a set: `ringId` and `workItemId` refuse under RING, while a
 * declared `resourceId` refuses under RESOURCE because validateRing reads the
 * resource declarations before the entries (fairness-ring.ts:222-225). The
 * generated count is pinned by hand — 8 identifiers across 3 fields — so a sweep
 * that silently produced no case cannot pass.
 */
const HOSTILE_IDENTIFIERS: readonly string[] = [
  "", " leading.space", "-leading.dash", ".leading.dot", "has space", "new\nline",
  "nul byte", "‮rtl.override",
];
const HOSTILE_FIELDS = [
  ["ringId", "RING"], ["resourceId", "RESOURCE"], ["workItemId", "RING"],
] as const;

describe("rotation hostile identifiers", () => {
  const cases = HOSTILE_FIELDS.flatMap(
    ([field, layer]) => HOSTILE_IDENTIFIERS.map(
      (hostile) => [field, layer, hostile] as const));

  it("generated the full hostile sweep", () => {
    expect(HOSTILE_IDENTIFIERS.length).toBe(8);
    expect(HOSTILE_FIELDS.length).toBe(3);
    expect(cases.length).toBe(24);
  });

  it.each(cases)("refuses a hostile %s under the %s layer", (field, layer, hostile) => {
    const issue = soleIssue(rotateOnce(request({
      ring: {
        ringId: field === "ringId" ? hostile : "ring.main",
        dimensionId: DIMENSION,
        resources: [resource(field === "resourceId" ? hostile : "res.a", 1)],
        entries: [entry(
          field === "workItemId" ? hostile : "wi.a1",
          field === "resourceId" ? hostile : "res.a",
        )],
      },
      workItems: [item("wi.a1", "res.a")],
      capacities: [capacity("res.a", 4)],
    })));
    expect(issue.code).toBe("FAIRNESS_CONTRACT_INVALID_IDENTITY");
    expect(issue.layer).toBe(layer);
  });
});
