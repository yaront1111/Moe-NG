/**
 * The ACCEPTED CONTROL for the atomic replacement supersession (task-9e52f850), plus the replay and
 * concurrency semantics DoD 2 and DoD 3 name.
 *
 * WHY THE ACCEPTED CONTROL IS THE ARM MOST WORTH DISTRUSTING. It is trivial to make one green by
 * seeding two graph revisions and a preparation record by hand. Every fact read back here is
 * produced by a PRODUCTION writer: the predecessor by `activateApprovedGraph` (task-eacea969), the
 * preparation pair by `commitPreparation` (task-32c1ba45), the successor's sealed bytes by the
 * shipped journey producer through `putGraphBody`, and the answers by `readCurrentActiveGraph` and
 * `foldPreparationHistory` — the same readers any consumer will use.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SUPERSESSION_DISPOSITION_KINDS, reduceGraphRevision } from "@moe/core";
import type { GraphRevisionCommand } from "@moe/core";
import { buildSupersessionDispositions } from "@moe/scheduler";
import type { GraphRevisionContent } from "@moe/scheduler";
import { MAX_DECISION_LEGS } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";

import { readCurrentBudgetLedger } from "../budget/budget-current-projection.js";
import { stateOf } from "../bootstrap/bootstrap-ledger.js";
import { decisionCount } from "../bootstrap/bootstrap-test-fixtures.js";
import { graphRevisionAggregateId, readCurrentActiveGraph } from "./active-graph-projection.js";
import { activeGraphSlotAggregateId } from "./active-graph-slot.js";
import { readGraphBody } from "./graph-body-record.js";
import { activateApprovedGraph } from "./graph-activation-service.js";
import {
  approvableStore, closeStores, contextFor, inputFor, requestFor,
} from "./graph-activation-test-fixtures.js";
import { readSupersedeFacts } from "./graph-supersede-facts.js";
import { deriveCoveredSupersessionDispositions } from "./graph-supersede-dispositions.js";
import { buildSupersessionRevisionLegs } from "./graph-supersede-legs.js";
import { supersedeActiveGraph } from "./graph-supersede-service.js";
import type { GraphSupersedeResult } from "./graph-supersede-service.js";
import {
  GOAL_ID, GRAPH_REVISION_REF, PROJECT_ID, SUCCESSOR_GRAPH_CONTENT_HASH,
  SUCCESSOR_NODE_KEY, SUCCESSOR_REVISION_REF,
  currentPreparationFence, sealChangedSuccessorBody, sealRequalifiedSuccessorBody,
  sealPolicyBoundSuccessorBody,
  successorBoundApproval, successorSupersedeInput, supersedableStore, supersedeContext,
  supersedeRequest,
} from "./graph-supersede-test-fixtures.js";
import {
  fundingAggregateId, planningFenceAggregateId, preparationAggregateId,
} from "./supersession-preparation-contracts.js";
import {
  PREPARATION_EVENT_TYPES, foldPreparationHistory, lineageFactsFor,
} from "./supersession-preparation-history.js";
import { commitPreparation, releasePreparation } from "./supersession-preparation-ledger.js";

afterEach(() => {
  closeStores();
});

const PREDECESSOR = `graph-revision:${PROJECT_ID}:${GRAPH_REVISION_REF}`;
const SUCCESSOR = `graph-revision:${PROJECT_ID}:${SUCCESSOR_REVISION_REF}`;
const PREPARATION = preparationAggregateId(PROJECT_ID, GOAL_ID);
const FUNDING = fundingAggregateId(PROJECT_ID, GOAL_ID);
const FENCE = planningFenceAggregateId(PROJECT_ID, GOAL_ID);
const ACTIVE_SLOT = activeGraphSlotAggregateId(PROJECT_ID);

/**
 * The SEVEN aggregates one supersession decision moves, named once as an immutable constant so no arm
 * can silently drop a member. An exact count, not `length > 0`: a one-member roster satisfies that.
 */
const SUPERSESSION_AGGREGATES = Object.freeze([
  GOAL_ID, PREDECESSOR, SUCCESSOR, PREPARATION, FUNDING, FENCE, ACTIVE_SLOT,
] as const);

/** The four lifecycle events a successor's whole history is, in the order the reducer emits them. */
const SUCCESSOR_EVENT_TYPES = Object.freeze([
  "GraphRevisionCreated", "GraphRevisionSubmitted", "GraphRevisionApproved",
  "GraphRevisionActivated",
] as const);

function accept(result: GraphSupersedeResult): Extract<GraphSupersedeResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected an accepted supersession, got ${result.code}/${result.refusedBy}`);
  }
  return result;
}

function counts(store: { readEvents: (id: string) => readonly unknown[] }): readonly number[] {
  return SUPERSESSION_AGGREGATES.map((aggregateId) => store.readEvents(aggregateId).length);
}

function currentSupersedeFacts(
  store: ReturnType<typeof supersedableStore>,
  successorGraphContentHash = SUCCESSOR_GRAPH_CONTENT_HASH,
) {
  const context = supersedeContext(store, "cmd-supersede-1");
  const request = supersedeRequest(store, {
    successorGraphContentHash,
  }) as unknown as Parameters<typeof readSupersedeFacts>[1];
  return readSupersedeFacts(store, request, stateOf(context.ledger, GOAL_ID));
}

interface CoverageOutcome {
  readonly code: string | null;
  readonly coverage: "COMPLETE" | "REFUSED";
  readonly decisionCountUnchanged: boolean | null;
  readonly eventHorizonUnchanged: boolean | null;
  readonly layer: string | null;
  readonly refusedBy: string | null;
  readonly sourceCode: string | null;
  readonly sourceLayer: string | null;
}

const COVERAGE_ENCODER = new TextEncoder();

function writeForeignRevisionLineage(store: SqliteEventStore): void {
  const revisionId = "graph-revision-underivable";
  const command = {
    commandId: "cmd-create-underivable-lineage",
    expectedVersion: 0,
    goalRef: GOAL_ID,
    graphContentHash: "a".repeat(64),
    kind: "graph_revision.create",
    planHash: "b".repeat(64),
    revisionId,
  } as unknown as GraphRevisionCommand;
  const reduced = reduceGraphRevision(undefined, command);
  if (!reduced.ok) throw new Error(`foreign lineage reducer refused: ${reduced.error.code}`);
  const aggregateId = graphRevisionAggregateId(PROJECT_ID, revisionId);
  const committed = store.commit({
    aggregateId,
    commandBytes: COVERAGE_ENCODER.encode(JSON.stringify(command)),
    commandId: command.commandId,
    committedAt: "2026-08-26T00:00:00.000Z",
    events: reduced.events.map((event, index) => ({
      eventId: `${command.commandId}-${index}`,
      eventType: event.kind,
      payload: COVERAGE_ENCODER.encode(JSON.stringify(event)),
    })),
    expectedVersion: 0,
  });
  if (committed.disposition !== "COMMITTED" || committed.currentVersion !== 1) {
    throw new Error("foreign lineage production writer did not commit exactly once");
  }
}

function completeCoverageOutcome(): CoverageOutcome {
  const store = supersedableStore();
  const facts = currentSupersedeFacts(store);
  if (!facts.ok) {
    return { code: facts.code, coverage: "REFUSED", layer: facts.layer,
      decisionCountUnchanged: null, eventHorizonUnchanged: null,
      refusedBy: facts.refusedBy, sourceCode: facts.sourceCode, sourceLayer: facts.sourceLayer };
  }
  accept(supersedeActiveGraph(
    supersedeContext(store, "cmd-supersede-1"), successorSupersedeInput(store),
  ));
  return { code: null, coverage: facts.dispositionCoverage,
    decisionCountUnchanged: null, eventHorizonUnchanged: null,
    layer: null, refusedBy: null, sourceCode: null, sourceLayer: null };
}

function storeWithUnderivableLineage() {
  const store = approvableStore();
  const activated = activateApprovedGraph(
    contextFor(store, requestFor("cmd-activate-coverage-refusal")), inputFor(store),
  );
  if (!activated.ok) throw new Error(`fixture activation refused: ${activated.code}`);
  writeForeignRevisionLineage(store);
  return store;
}

function refusedCoverageOutcome(): CoverageOutcome {
  const store = storeWithUnderivableLineage();
  const eventHorizon = store.readEventHorizon();
  const decisions = decisionCount(store);
  const prepared = commitPreparation(contextFor(store, requestFor("cmd-prepare-coverage-refusal", {
    approvedTargetRevisionRef: GRAPH_REVISION_REF,
    commandId: "cmd-prepare-coverage-refusal",
    correlationId: "corr-prepare-coverage-refusal",
    decidedAt: "2026-08-26T00:00:00.000Z",
    goalRef: GOAL_ID,
    principalId: "principal-1",
    projectId: PROJECT_ID,
  })));
  if (!prepared.ok) {
    return { code: prepared.code, coverage: "REFUSED", layer: prepared.layer,
      decisionCountUnchanged: decisionCount(store) === decisions,
      eventHorizonUnchanged: store.readEventHorizon() === eventHorizon,
      refusedBy: prepared.refusedBy, sourceCode: prepared.sourceCode,
      sourceLayer: prepared.sourceLayer };
  }
  sealPolicyBoundSuccessorBody(store);
  const supersedeHorizon = store.readEventHorizon();
  const supersedeDecisions = decisionCount(store);
  const result = supersedeActiveGraph(
    supersedeContext(store, "cmd-supersede-coverage-refusal"), successorSupersedeInput(store),
  );
  return result.ok
    ? { code: null, coverage: "COMPLETE", decisionCountUnchanged: false,
      eventHorizonUnchanged: false, layer: null, refusedBy: null,
      sourceCode: null, sourceLayer: null }
    : { code: result.code, coverage: "REFUSED", layer: result.layer,
      decisionCountUnchanged: decisionCount(store) === supersedeDecisions,
      eventHorizonUnchanged: store.readEventHorizon() === supersedeHorizon,
      refusedBy: result.refusedBy, sourceCode: result.sourceCode,
      sourceLayer: result.sourceLayer };
}

const SUPERSEDE_COVERAGE_CASES = Object.freeze([
  {
    expected: { code: null, coverage: "COMPLETE", decisionCountUnchanged: null,
      eventHorizonUnchanged: null, layer: null, refusedBy: null,
      sourceCode: null, sourceLayer: null },
    name: "two derivable authority lineages are COMPLETE",
    run: completeCoverageOutcome,
  },
  {
    expected: {
      code: "GRAPH_SUPERSEDE_DISPOSITION_INCOMPLETE", coverage: "REFUSED",
      decisionCountUnchanged: true, eventHorizonUnchanged: true,
      layer: "GRAPH_SUPERSEDE", refusedBy: "GRAPH_SUPERSEDE_SERVICE",
      sourceCode: null, sourceLayer: null,
    },
    name: "a durable lineage absent from both authority maps refuses",
    run: refusedCoverageOutcome,
  },
] as const);

interface ProductionWriterWorld {
  readonly authorityRelation: "DIFFERENT" | "EQUAL" | null;
  readonly predecessorAuthorityHash: string;
  readonly predecessorContentHash: string;
  readonly store: SqliteEventStore;
  readonly successorAuthorityHash: string;
  readonly successorGraphContentHash: string;
}

function productionWriterWorld(
  store: SqliteEventStore, successorGraphContentHash: string,
  authorityRelation: ProductionWriterWorld["authorityRelation"],
): ProductionWriterWorld {
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  if (!active.ok) throw new Error(`fixture active graph refused: ${active.code}`);
  const successor = readGraphBody(store, PROJECT_ID, successorGraphContentHash);
  if (!successor.ok) throw new Error(`fixture successor body refused: ${successor.code}`);
  const predecessorAuthorityHash = active.content.nodeAuthority.authorities[0]?.nodeAuthorityHash;
  const successorAuthorityHash = successor.content.nodeAuthority.authorities[0]?.nodeAuthorityHash;
  if (predecessorAuthorityHash === undefined || successorAuthorityHash === undefined) {
    throw new Error("fixture authority roster was empty");
  }
  return Object.freeze({
    authorityRelation, predecessorAuthorityHash,
    predecessorContentHash: active.graphContentHash, store, successorAuthorityHash,
    successorGraphContentHash,
  });
}

const PRODUCTION_WRITER_CASES = Object.freeze([
  Object.freeze({
    expected: [{ kind: "REMOVE", nodeKey: "node-a" }, { kind: "ADD", nodeKey: "node-b" }],
    name: "different node keys emit REMOVE and ADD",
    open: () => productionWriterWorld(
      supersedableStore(), SUCCESSOR_GRAPH_CONTENT_HASH, null,
    ),
  }),
  Object.freeze({
    expected: [{ kind: "CHANGE", nodeKey: "node-a" }],
    name: "same key with changed node authority emits CHANGE",
    open: () => {
      const store = supersedableStore();
      return productionWriterWorld(store, sealChangedSuccessorBody(store), "DIFFERENT");
    },
  }),
  Object.freeze({
    expected: [{ kind: "REQUALIFY", nodeKey: "node-a" }],
    name: "same authority under a changed graph identity emits REQUALIFY",
    open: () => {
      const store = supersedableStore();
      return productionWriterWorld(store, sealRequalifiedSuccessorBody(store), "EQUAL");
    },
  }),
] as const);

function testAuthorities(
  nodeKeys: readonly string[],
): GraphRevisionContent["nodeAuthority"]["authorities"] {
  return nodeKeys.map((nodeKey, index) => Object.freeze({
    nodeAuthorityHash: index.toString(16).padStart(64, "0"), nodeKey,
  }));
}

const BASE_AUTHORITIES = testAuthorities(["node-a"]);
const OVERSIZED_LINEAGES = Object.freeze(
  Array.from({ length: 129 }, (_, index) => `node-${index}`),
);
const COVERAGE_STRUCTURE_CASES = Object.freeze([
  { fenced: [], name: "an empty fenced roster", predecessor: BASE_AUTHORITIES,
    successor: BASE_AUTHORITIES },
  { fenced: ["node-a", "node-a"], name: "a duplicate fenced lineage",
    predecessor: BASE_AUTHORITIES, successor: BASE_AUTHORITIES },
  { fenced: [""], name: "an empty fenced lineage", predecessor: testAuthorities([""]),
    successor: testAuthorities([""]) },
  { fenced: ["node-a"], name: "an empty authority union", predecessor: [], successor: [] },
  { fenced: OVERSIZED_LINEAGES, name: "a roster beyond the kernel ceiling",
    predecessor: testAuthorities(OVERSIZED_LINEAGES),
    successor: testAuthorities(OVERSIZED_LINEAGES) },
  { fenced: ["node-a", "foreign-lineage"], name: "an uncovered durable lineage",
    predecessor: BASE_AUTHORITIES, successor: BASE_AUTHORITIES },
] as const);

describe("the supersession decision's aggregate roster is pinned (task-9e52f850)", () => {
  it("names exactly seven distinct aggregates within the store leg limit", () => {
    expect(SUPERSESSION_AGGREGATES).toHaveLength(7);
    expect(new Set(SUPERSESSION_AGGREGATES).size).toBe(7);
    expect(SUPERSESSION_AGGREGATES.length).toBeLessThanOrEqual(MAX_DECISION_LEGS);
    expect(SUCCESSOR_EVENT_TYPES).toHaveLength(4);
  });
});

describe("supersede-time disposition coverage is complete or refuses exactly", () => {
  it("returns null for every malformed or uncovered production-wrapper shape", () => {
    // The wrapper is an internal null sentinel. The table below pins its structure guards; the
    // production-surface code/layer/refusedBy mapping is pinned by SUPERSEDE_COVERAGE_CASES.
    expect(COVERAGE_STRUCTURE_CASES.length).toBeGreaterThan(0);
    expect(COVERAGE_STRUCTURE_CASES).toHaveLength(6);
    let executed = 0;
    for (const scenario of COVERAGE_STRUCTURE_CASES) {
      expect(deriveCoveredSupersessionDispositions(
        scenario.fenced, scenario.predecessor, scenario.successor,
      ), scenario.name).toBeNull();
      executed += 1;
    }
    expect(executed).toBe(COVERAGE_STRUCTURE_CASES.length);
  });

  it("keeps a successor-only ADD legal while covering every fenced predecessor", () => {
    const dispositions = deriveCoveredSupersessionDispositions(
      ["node-a"], BASE_AUTHORITIES, testAuthorities(["node-a", "node-b"]),
    );
    expect(dispositions?.map(({ kind, nodeKey }) => ({ kind, nodeKey }))).toStrictEqual([
      { kind: "REQUALIFY", nodeKey: "node-a" },
      { kind: "ADD", nodeKey: "node-b" },
    ]);
  });

  it("executes the exact COMPLETE/refusal coverage cases", () => {
    expect(SUPERSEDE_COVERAGE_CASES.length).toBeGreaterThan(0);
    expect(SUPERSEDE_COVERAGE_CASES).toHaveLength(2);
  });

  it.each(SUPERSEDE_COVERAGE_CASES)("$name", ({ expected, run }) => {
    expect(run()).toEqual(expected);
  });

  it("observes the exact four-kind set through production writers", () => {
    expect(PRODUCTION_WRITER_CASES.length).toBeGreaterThan(0);
    expect(PRODUCTION_WRITER_CASES).toHaveLength(3);
    const observed = new Set<string>();
    let executed = 0;

    for (const scenario of PRODUCTION_WRITER_CASES) {
      const world = scenario.open();
      if (world.authorityRelation === "DIFFERENT") {
        expect(world.successorAuthorityHash, scenario.name)
          .not.toBe(world.predecessorAuthorityHash);
      } else if (world.authorityRelation === "EQUAL") {
        expect(world.successorGraphContentHash, scenario.name)
          .not.toBe(world.predecessorContentHash);
        expect(world.successorAuthorityHash, scenario.name)
          .toBe(world.predecessorAuthorityHash);
      }
      const facts = currentSupersedeFacts(world.store, world.successorGraphContentHash);
      expect(facts.ok, facts.ok ? scenario.name : `${facts.code}/${facts.refusedBy}`).toBe(true);
      if (!facts.ok) throw new Error(`production writer case refused: ${facts.code}`);
      const actual = facts.dispositions.map(({ kind, nodeKey }) => ({ kind, nodeKey }));
      expect(actual, scenario.name).toStrictEqual(scenario.expected);
      for (const disposition of facts.dispositions) observed.add(disposition.kind);
      executed += 1;
    }

    expect(executed).toBe(PRODUCTION_WRITER_CASES.length);
    expect(executed).toBe(3);
    expect(observed).toEqual(new Set(["ADD", "REMOVE", "REQUALIFY", "CHANGE"]));
    expect(observed.has("CARRY")).toBe(false);
    // Equal authority hashes have one production meaning today: REQUALIFY. No durable discriminator
    // exists from which a production writer could truthfully mint REEXECUTE.
    expect(observed.has("REEXECUTE")).toBe(false);
  });

  it("refuses a structurally valid CARRY without safe-carry evidence at GRAPH_REVISION", () => {
    const store = supersedableStore();
    const facts = currentSupersedeFacts(store);
    if (!facts.ok) throw new Error(`fixture supersede facts refused: ${facts.code}`);
    const authorityHash = facts.active.content.nodeAuthority.authorities[0]?.nodeAuthorityHash;
    if (authorityHash === undefined) throw new Error("fixture predecessor authority was empty");
    const approval = successorBoundApproval(store);
    const eventHorizon = store.readEventHorizon();
    const decisions = decisionCount(store);

    const refused = buildSupersessionRevisionLegs({
      actorKind: approval.actorKind,
      approvalRef: approval.approvalRef,
      commandId: "cmd-carry-without-evidence",
      dispositions: [{
        kind: "CARRY", nodeKey: "node-a", predecessorAuthorityHash: authorityHash,
        safeCarry: null, successorAuthorityHash: authorityHash,
      }],
      expectedGoalVersion: facts.goal.version,
      goalRef: GOAL_ID,
      predecessorRevisionId: facts.active.revisionId,
      projectId: PROJECT_ID,
      store,
      successorGraphContentHash: SUCCESSOR_GRAPH_CONTENT_HASH,
      successorRevisionId: SUCCESSOR_REVISION_REF,
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unsafe CARRY unexpectedly produced revision legs");
    expect({
      code: refused.code, layer: refused.layer, ok: refused.ok,
      refusedBy: refused.refusedBy, sourceCode: refused.sourceCode,
      sourceLayer: refused.sourceLayer,
    }).toStrictEqual({
      code: "SUPERSESSION_CONSEQUENCE_CHANGED", layer: "GRAPH_REVISION", ok: false,
      refusedBy: "GRAPH_REVISION", sourceCode: null, sourceLayer: null,
    });
    expect(refused.error?.code).toBe("SUPERSESSION_CONSEQUENCE_CHANGED");
    expect(store.readEventHorizon()).toBe(eventHorizon);
    expect(decisionCount(store)).toBe(decisions);
  });
});

describe("supersedeActiveGraph moves predecessor, successor and pair in ONE decision", () => {
  it("ACCEPTED CONTROL: the projection answers with the successor at predecessor epoch + 1", () => {
    const store = supersedableStore();
    const before = readCurrentActiveGraph(store, PROJECT_ID);
    if (!before.ok) throw new Error("fixture has no active graph");
    expect(before.revisionId).toBe(GRAPH_REVISION_REF);
    expect(before.graphEpoch).toBe(1);
    expect(store.readEvents(SUCCESSOR)).toHaveLength(0);
    const decisionsBefore = decisionCount(store);

    const outcome = accept(supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1"), successorSupersedeInput(store),
    ));

    expect(outcome.disposition).toBe("DECIDED");
    expect(outcome.predecessorRevisionId).toBe(GRAPH_REVISION_REF);
    expect(outcome.successorRevisionId).toBe(SUCCESSOR_REVISION_REF);
    // EPOCH + 1 RELATIVE TO THE PREDECESSOR, asserted as arithmetic on the predecessor's own epoch.
    expect(outcome.successorGraphEpoch).toBe(before.graphEpoch + 1);
    expect(decisionCount(store)).toBe(decisionsBefore + 1);

    // THE CONSUMER'S OWN READ, not a re-derivation.
    const after = readCurrentActiveGraph(store, PROJECT_ID);
    if (!after.ok) throw new Error(`expected an active successor: ${after.code}`);
    expect(after.revisionId).toBe(SUCCESSOR_REVISION_REF);
    expect(after.graphEpoch).toBe(2);
    expect(after.graphContentHash).toBe(SUCCESSOR_GRAPH_CONTENT_HASH);
    expect(after.content.snapshot.nodes.map((node) => node.nodeKey))
      .toStrictEqual([SUCCESSOR_NODE_KEY]);
  });

  it("writes the successor's whole history and the predecessor's supersession together", () => {
    const store = supersedableStore();
    expect(counts(store)).toEqual([2, 4, 0, 1, 1, 1, 1]);

    accept(supersedeActiveGraph(supersedeContext(store, "cmd-supersede-1"), successorSupersedeInput(store)));

    expect(counts(store)).toEqual([3, 5, 4, 2, 2, 2, 2]);
    expect(store.readEvents(SUCCESSOR).map((event) => event.eventType))
      .toStrictEqual([...SUCCESSOR_EVENT_TYPES]);
    expect(store.readEvents(PREDECESSOR).at(-1)?.eventType).toBe("GraphRevisionSuperseded");
    expect(store.readEvents(GOAL_ID).at(-1)?.eventType).toBe("GoalGraphEpochAdvanced");
  });

  it("marks the paired preparation records CONSUMED, not released, in the same decision", () => {
    const store = supersedableStore();

    const outcome = accept(supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1"), successorSupersedeInput(store),
    ));

    expect(outcome.consumed.funding.lifecycle).toBe("CONSUMED");
    expect(outcome.consumed.fence.lifecycle).toBe("CONSUMED");
    // A consumed hold was SPENT: refunding it would hand back authority already used.
    expect(outcome.consumed.funding.refunded).toBe(0);
    expect(store.readEvents(PREPARATION).at(-1)?.eventType).toBe(PREPARATION_EVENT_TYPES.CONSUMED);
    expect(store.readEvents(FUNDING).at(-1)?.eventType)
      .toBe(PREPARATION_EVENT_TYPES.FUNDING_CONSUMED);
    expect(store.readEvents(FENCE).at(-1)?.eventType)
      .toBe(PREPARATION_EVENT_TYPES.FENCE_CONSUMED);
    const history = foldPreparationHistory(store, PREPARATION);
    if (!history.ok) throw new Error(`fold refused: ${history.code}`);
    expect(history.current).toBeNull();
  });

  it("derives the dispositions from the two contents: node-a REMOVE, node-b ADD", () => {
    const store = supersedableStore();
    const answer = currentSupersedeFacts(store);
    expect(answer.ok, answer.ok ? "" : `${answer.code}/${answer.refusedBy}`).toBe(true);
    if (!answer.ok) throw new Error("expected complete supersede facts");
    expect(answer.dispositionCoverage).toBe("COMPLETE");
    const dispositions = answer.dispositions;
    expect(dispositions.map(({ kind, nodeKey }) => ({ kind, nodeKey }))).toStrictEqual([
      { kind: "REMOVE", nodeKey: "node-a" },
      { kind: "ADD", nodeKey: "node-b" },
    ]);
    expect(dispositions).toHaveLength(2);
    for (const disposition of dispositions) expect(disposition.kind).not.toBe("CARRY");

    accept(supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1"), successorSupersedeInput(store),
    ));

    const superseded = store.readEvents(PREDECESSOR).at(-1);
    if (superseded === undefined) throw new Error("no supersession event");
    const payload = JSON.parse(new TextDecoder().decode(superseded.payload)) as {
      authorityHash: string;
      successor: { graphContentHash: string; graphEpoch: number; revisionId: string };
    };
    expect(payload.successor.revisionId).toBe(SUCCESSOR_REVISION_REF);
    expect(payload.successor.graphEpoch).toBe(2);
    // RECOMPUTED CONTENT HASH, never the structural snapshotIdentity (dec-64b2391c option A).
    expect(payload.successor.graphContentHash).toBe(SUCCESSOR_GRAPH_CONTENT_HASH);
    expect(payload.authorityHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("leaves the released path with nothing to release once the pair is consumed", () => {
    const store = supersedableStore();
    const fence = currentPreparationFence(store);
    accept(supersedeActiveGraph(supersedeContext(store, "cmd-supersede-1"), successorSupersedeInput(store)));

    const released = releasePreparation(supersedeContext(store, "cmd-release-1", {
      commandId: "cmd-release-1", correlationId: "corr-release",
      decidedAt: "2026-08-26T00:20:00.000Z",
      expectedPreparationVersion: fence.expectedPreparationVersion + 1,
      generation: fence.generation, goalRef: GOAL_ID, principalId: "principal-1",
      projectId: PROJECT_ID,
    }));

    expect(released.ok).toBe(false);
    if (released.ok) throw new Error("expected the release to refuse");
    expect(released.code).toBe("SUPERSESSION_RELEASE_GENERATION_ABSENT");
    expect(released.refusedBy).toBe("SUPERSESSION_PREPARATION_LEDGER");
  });

});

describe("the scheduler disposition-set fences remain closed", () => {
  it("pins the exact six-kind vocabulary and refuses a missing kind at the set layer", () => {
    expect(SUPERSESSION_DISPOSITION_KINDS).toStrictEqual([
      "ADD", "CARRY", "REQUALIFY", "REEXECUTE", "CHANGE", "REMOVE",
    ]);
    expect(SUPERSESSION_DISPOSITION_KINDS).toHaveLength(6);
    expect(buildSupersessionDispositions(lineageFactsFor(["node-a"]))).toEqual({
      code: "PLANNING_DISPOSITION_UNKNOWN",
      layer: "SCHEDULER_SUPERSESSION_SET",
      ok: false,
    });
  });

  it("refuses duplicate kinds at the scheduler set layer before completeness", () => {
    expect(buildSupersessionDispositions(lineageFactsFor(["node-a", "node-b"]))).toEqual({
      code: "INPUT_INVALID",
      layer: "SCHEDULER_SUPERSESSION_SET",
      ok: false,
    });
  });
});

describe("the consequences a committed supersession leaves behind, measured not assumed", () => {
  it("PINS the stale budget binding a supersession creates, so the gap cannot go silent", () => {
    // Every committed budget-ledger record carries the graphRevisionRef and graphEpoch it was
    // authorized at, and `budget-current-projection.ts:113` refuses when they disagree with the
    // CURRENT binding — which this move has just advanced. Nothing in this tree re-authorizes a
    // budget root at a new epoch, so the goal's budget projection is unreadable afterwards and a
    // SECOND preparation is unreachable. Not a defect this row introduces and not one it owns:
    // pinned here so the day budget re-authorization lands, this arm goes red and someone revisits.
    const store = supersedableStore();
    expect(readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID).ok).toBe(true);

    accept(supersedeActiveGraph(supersedeContext(store, "cmd-supersede-1"), successorSupersedeInput(store)));

    const budget = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
    expect(budget.ok).toBe(false);
    if (budget.ok) throw new Error("expected the budget projection to refuse");
    expect(budget.code).toBe("BUDGET_PROJECTION_STALE_BINDING");
  });
});

describe("replay and concurrency leave the durable record exactly where it was", () => {
  it("SAME BYTES replay: the original decision, and NO new event or decision row", () => {
    const store = supersedableStore();
    const payload = supersedeRequest(store, { commandId: "cmd-supersede-1" });
    const first = accept(supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1", payload), successorSupersedeInput(store),
    ));
    const horizonAfterFirst = store.readEventHorizon();
    const decisionsAfterFirst = decisionCount(store);

    const replayed = accept(supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1", payload), successorSupersedeInput(store),
    ));

    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.decision.decisionId).toBe(first.decision.decisionId);
    expect(replayed.successorGraphEpoch).toBe(2);
    expect(replayed.consumed.funding.lifecycle).toBe("CONSUMED");
    // COUNTS, not just the returned value: a second event is invisible to a return-value check.
    expect(store.readEventHorizon()).toBe(horizonAfterFirst);
    expect(decisionCount(store)).toBe(decisionsAfterFirst);
    expect(counts(store)).toEqual([3, 5, 4, 2, 2, 2, 2]);
  });

  it("CHANGED BYTES under one decision identity refuse and consume nothing further", () => {
    const store = supersedableStore();
    const payload = supersedeRequest(store, { commandId: "cmd-supersede-1" });
    accept(supersedeActiveGraph(
      supersedeContext(store, "cmd-supersede-1", payload), successorSupersedeInput(store),
    ));
    const horizon = store.readEventHorizon();

    const drifted = supersedeActiveGraph(supersedeContext(store, "cmd-supersede-1", {
      ...payload, correlationId: "corr-drifted",
    }), successorSupersedeInput(store));

    expect(drifted.ok).toBe(false);
    if (drifted.ok) throw new Error("expected a refusal");
    expect(drifted.code).toBe("GRAPH_SUPERSEDE_BYTES_CONFLICT");
    expect(drifted.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    expect(drifted.sourceCode).toBe("BOOTSTRAP_COMMAND_BYTES_CONFLICT");
    expect(drifted.sourceLayer).toBe("DAEMON_PREREQUISITE");
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("CONCURRENT supersession: the loser refuses, consumes nothing and advances no epoch", () => {
    const store = supersedableStore();
    // Both contexts are built BEFORE either commits, so both hold the same pre-supersession
    // ledger snapshot and both name `graph-revision-1` as the predecessor they expect.
    const first = supersedeContext(store, "cmd-supersede-1");
    const second = supersedeContext(store, "cmd-supersede-2");

    const winner = accept(supersedeActiveGraph(first, successorSupersedeInput(store)));
    const loser = supersedeActiveGraph(second, successorSupersedeInput(store));

    expect(winner.successorGraphEpoch).toBe(2);
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("expected the second supersession to lose");
    // The READ-SIDE fence answers first and that is the honest code: by the time the loser is
    // decided, `readCurrentActiveGraph` already names the winner's successor, so the predecessor
    // the loser expects is no longer active. The store's expected-version fence remains the
    // authority that would decide a genuine cross-process race, and it is unreachable from a
    // single-process fixture precisely because this read answers earlier.
    expect(loser.code).toBe("GRAPH_SUPERSEDE_PREDECESSOR_MISMATCH");
    expect(loser.refusedBy).toBe("GRAPH_SUPERSEDE_SERVICE");
    const active = readCurrentActiveGraph(store, PROJECT_ID);
    if (!active.ok) throw new Error("expected the winner's successor to be active");
    expect(active.graphEpoch).toBe(2);
    expect(active.revisionId).toBe(SUCCESSOR_REVISION_REF);
    expect(counts(store)).toEqual([3, 5, 4, 2, 2, 2, 2]);
  });
});
