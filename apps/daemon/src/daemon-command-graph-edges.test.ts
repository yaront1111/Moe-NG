/**
 * The five graph MUTATION edges, driven through the PRODUCTION dispatch `runGraphEdge` over a
 * real file-backed `SqliteEventStore` (task-931f99e8).
 *
 * EVERY ARM DRIVES `runGraphEdge`. Not a harness that reassembles the composition: a test that
 * rebuilt the request itself could not see the assembly dropping a server fact, and the assembly
 * is the whole of this row's "an ingress authenticates bytes, it does not create authority".
 *
 * REPLAY IS ASSERTED BY COUNTS, NOT BY THE RETURNED VALUE. A duplicate event, a second decision
 * row or a second effect is invisible to a test that only compares what came back, so each
 * replay arm pins the aggregate event counts, the decision-row count and the effect id.
 */
import { afterAll, describe, expect, it } from "vitest";

import type { JsonObject } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import {
  GOAL_ID, GRAPH_REVISION_REF, PROJECT_ID, RUN_ID, activationWitness, approvableStore,
  closeStores,
} from "./planning/graph-activation-test-fixtures.js";
import { SEALED_SUBMISSION_HASH, approvalCommand, approvalRecord }
  from "./bootstrap/bootstrap-test-fixtures.js";
import {
  SUCCESSOR_GRAPH_CONTENT_HASH, SUCCESSOR_REVISION_REF, currentPreparationFence,
  supersedableStore,
} from "./planning/graph-supersede-test-fixtures.js";
import { PREPARE_DECIDED_AT, activatedStore }
  from "./planning/supersession-preparation-service.test.js";
import {
  fundingAggregateId, planningFenceAggregateId, preparationAggregateId,
} from "./planning/supersession-preparation-contracts.js";
import { DomainRefusal } from "./daemon-command-dispatch.js";
import { runGraphEdge } from "./daemon-command-graph-edges.js";
import type { GraphEdgeContext } from "./daemon-command-graph-edges.js";
import { GRAPH_MUTATION_COMMAND_KINDS, PAYLOAD_KEYS } from "./daemon-command-vocabulary.js";
import { GRAPH_SERVER_OWNED_REQUEST_KEYS, assembleGraphRequest }
  from "./daemon-command-graph-contracts.js";

const PRINCIPAL = "principal-1";
const PREPARATION = preparationAggregateId(PROJECT_ID, GOAL_ID);
const FUNDING = fundingAggregateId(PROJECT_ID, GOAL_ID);
const FENCE = planningFenceAggregateId(PROJECT_ID, GOAL_ID);

/** The three preparation aggregates, named once so no arm can silently drop a member. */
const PAIR_AGGREGATES = Object.freeze([PREPARATION, FUNDING, FENCE] as const);

afterAll(() => { closeStores(); });

function edgeFor(
  store: SqliteEventStore, kind: GraphEdgeContext["kind"], commandId: string,
  payload: Record<string, unknown>, overrides: Partial<GraphEdgeContext> = {},
): GraphEdgeContext {
  return {
    clock: () => PREPARE_DECIDED_AT,
    envelope: {
      commandId, correlationId: "corr-graph", expectedVersion: 0, payload: payload as JsonObject,
    },
    humanReview: Object.freeze({ principalId: PRINCIPAL }),
    kind,
    principalId: PRINCIPAL,
    projectId: PROJECT_ID,
    store,
    ...overrides,
  };
}

/** The refusal a graph edge throws, with its code, layer and refusing service intact. */
function refusalOf(run: () => unknown): DomainRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainRefusal) return error;
    throw error;
  }
  throw new Error("expected the edge to refuse");
}

function decisionCount(store: SqliteEventStore): number {
  return store.readCommandDecisionsAfter(0n, 1_000).items.length;
}

function eventCounts(store: SqliteEventStore): readonly number[] {
  return PAIR_AGGREGATES.map((aggregateId) => store.readEvents(aggregateId).length);
}

function prepared(store: SqliteEventStore, commandId = "cmd-prepare-1"): ReturnType<
  typeof runGraphEdge
> {
  return runGraphEdge(edgeFor(store, "graph.prepare_supersession", commandId, {
    approvedTargetRevisionRef: GRAPH_REVISION_REF, goalRef: GOAL_ID,
  }));
}

function approvePayload(): Record<string, unknown> {
  return {
    activation: activationWitness(),
    command: approvalCommand(),
    graphRevisionRef: GRAPH_REVISION_REF,
    record: approvalRecord(SEALED_SUBMISSION_HASH),
    runId: RUN_ID,
  };
}

describe("graph mutation ingress registers its served roster exactly (task-931f99e8)", () => {
  it("pins the five served kinds and their exact denominator", () => {
    expect(GRAPH_MUTATION_COMMAND_KINDS).toHaveLength(5);
    expect(new Set(GRAPH_MUTATION_COMMAND_KINDS).size).toBe(5);
    // BOTH DIRECTIONS. Iterating only the roster cannot see a kind that is advertised but not
    // served: PAYLOAD_KEYS is what `createDaemonCommandPorts` builds the registry from.
    for (const kind of GRAPH_MUTATION_COMMAND_KINDS) {
      expect(Object.keys(PAYLOAD_KEYS)).toContain(kind);
    }
    expect(Object.keys(PAYLOAD_KEYS).filter((kind) => kind.startsWith("graph.")))
      .toEqual([...GRAPH_MUTATION_COMMAND_KINDS].sort());
  });

  it("keeps every allow-list disjoint from the five SERVER-owned request members", () => {
    expect(GRAPH_SERVER_OWNED_REQUEST_KEYS).toHaveLength(5);
    for (const kind of GRAPH_MUTATION_COMMAND_KINDS) {
      const allowed = PAYLOAD_KEYS[kind];
      expect(allowed.length).toBeGreaterThan(0);
      for (const owned of GRAPH_SERVER_OWNED_REQUEST_KEYS) {
        expect(allowed).not.toContain(owned);
      }
      // Sorted and exact: the seam compares ORDERED, so an out-of-order list refuses too.
      expect([...allowed]).toEqual([...allowed].sort());
    }
  });
});

describe("a caller-supplied authority fact never survives the assembly (task-931f99e8)", () => {
  const FOREIGN = Object.freeze({
    commandId: "cmd-attacker-chose", correlationId: "corr-attacker-chose",
    decidedAt: "1999-01-01T00:00:00.000Z", principalId: "attacker", projectId: "project-foreign",
  });

  it("overwrites every SERVER-owned member the caller named, member by member", () => {
    const assembled = assembleGraphRequest({
      envelope: {
        commandId: "cmd-real", correlationId: "corr-real", expectedVersion: 0,
        payload: { ...FOREIGN, goalRef: GOAL_ID } as JsonObject,
      },
      kind: "graph.prepare_supersession",
      principalId: PRINCIPAL,
      projectId: PROJECT_ID,
    }, PREPARE_DECIDED_AT);

    // The SECOND fail-closed layer. The allow-list already refuses these keys structurally at
    // PAYLOAD_SHAPE; this proves the assembly would strip them even if that list were widened,
    // so the two layers fail closed independently rather than one guarding the other.
    expect(assembled.payload["commandId"]).toBe("cmd-real");
    expect(assembled.payload["correlationId"]).toBe("corr-real");
    expect(assembled.payload["decidedAt"]).toBe(PREPARE_DECIDED_AT);
    expect(assembled.payload["principalId"]).toBe(PRINCIPAL);
    expect(assembled.payload["projectId"]).toBe(PROJECT_ID);
    expect(assembled.payload["goalRef"]).toBe(GOAL_ID);
  });

  it("still COMMITS under the authenticated identity when the payload names a foreign one", () => {
    const store = activatedStore();
    const before = decisionCount(store);
    const decided = runGraphEdge(edgeFor(store, "graph.prepare_supersession", "cmd-foreign-1", {
      ...FOREIGN, approvedTargetRevisionRef: GRAPH_REVISION_REF, goalRef: GOAL_ID,
    }));
    // A caller-supplied project would make the ledger read one project and write another; the
    // service would answer SUPERSESSION_PREPARATION_TARGET_FOREIGN. It cannot, because the
    // caller's members never reach it.
    expect(decided.disposition).toBe("DECIDED");
    expect(decided.commandId).toBe("cmd-foreign-1");
    expect(decisionCount(store)).toBe(before + 1);
    expect(eventCounts(store)).toEqual([1, 1, 1]);
  });
});

describe("graph.prepare_supersession delegates and replays (task-931f99e8)", () => {
  it("ACCEPTED CONTROL: one decision moves the record, the hold and the fence", () => {
    const store = activatedStore();
    expect(eventCounts(store)).toEqual([0, 0, 0]);
    const before = decisionCount(store);

    const decided = prepared(store);

    expect(decided.disposition).toBe("DECIDED");
    expect(decided.commandId).toBe("cmd-prepare-1");
    expect(decided.resultCode).toBe("EFFECTS_COMMITTED");
    expect(eventCounts(store)).toEqual([1, 1, 1]);
    expect(decisionCount(store)).toBe(before + 1);
  });

  it("REPLAYS the same bytes to the original result with unchanged counts", () => {
    const store = activatedStore();
    const first = prepared(store);
    const counts = eventCounts(store);
    const decisions = decisionCount(store);

    const again = prepared(store);

    expect(again.disposition).toBe("REPLAYED");
    // The EFFECT, not merely the value: a second commit would mint a new decision id.
    expect(again.effectId).toBe(first.effectId);
    expect(again.resultCode).toBe(first.resultCode);
    expect(eventCounts(store)).toEqual(counts);
    expect(decisionCount(store)).toBe(decisions);
  });

  it("REPLAYS even when the clock has moved: decidedAt comes off the committed decision", () => {
    const store = activatedStore();
    const first = prepared(store);
    const later = runGraphEdge(edgeFor(store, "graph.prepare_supersession", "cmd-prepare-1", {
      approvedTargetRevisionRef: GRAPH_REVISION_REF, goalRef: GOAL_ID,
    }, { clock: () => "2027-01-01T00:00:00.000Z" }));

    // A fresh clock read would change the request bytes and answer an honest replay with a
    // BYTES_CONFLICT refusal for a command that succeeded.
    expect(later.disposition).toBe("REPLAYED");
    expect(later.effectId).toBe(first.effectId);
  });

  it("refuses CONFLICTING bytes under the same identity at the LEDGER, wrapping replay's own", () => {
    const store = activatedStore();
    prepared(store);
    const counts = eventCounts(store);
    const decisions = decisionCount(store);

    const refusal = refusalOf(() => runGraphEdge(
      edgeFor(store, "graph.prepare_supersession", "cmd-prepare-1", {
        approvedTargetRevisionRef: "graph-revision-999", goalRef: GOAL_ID,
      }),
    ));

    expect(refusal.code).toBe("SUPERSESSION_PREPARATION_BYTES_CONFLICT");
    expect(refusal.layer).toBe("SUPERSESSION_PREPARATION");
    // The refusing service AND the wrapped surface's own code and layer, verbatim.
    expect(refusal.detail).toBe(
      "SUPERSESSION_PREPARATION_LEDGER (BOOTSTRAP_COMMAND_BYTES_CONFLICT/DAEMON_PREREQUISITE)",
    );
    expect(eventCounts(store)).toEqual(counts);
    expect(decisionCount(store)).toBe(decisions);
  });

  it("forwards the SERVICE's own decode refusal for an incomplete intent", () => {
    const store = activatedStore();
    const before = decisionCount(store);
    const refusal = refusalOf(() => runGraphEdge(
      edgeFor(store, "graph.prepare_supersession", "cmd-prepare-bad", { goalRef: GOAL_ID }),
    ));
    expect(refusal.code).toBe("SUPERSESSION_PREPARATION_REQUEST_INVALID");
    expect(refusal.layer).toBe("SUPERSESSION_PREPARATION");
    expect(refusal.detail).toBe("SUPERSESSION_PREPARATION_SERVICE");
    // ZERO RESIDUE, measured against the seeded world's own baseline rather than against nought:
    // these fixtures arrive with a driven history, so `toBe(0)` would assert the seed, not the arm.
    expect(decisionCount(store)).toBe(before);
    expect(eventCounts(store)).toEqual([0, 0, 0]);
  });
});

describe("graph.release_preparation delegates to the same ledger (task-931f99e8)", () => {
  it("ACCEPTED CONTROL: releases the exact current generation", () => {
    const store = activatedStore();
    prepared(store);
    const released = runGraphEdge(edgeFor(store, "graph.release_preparation", "cmd-release-1", {
      expectedPreparationVersion: 1, generation: 1, goalRef: GOAL_ID,
    }));
    expect(released.disposition).toBe("DECIDED");
    expect(eventCounts(store)).toEqual([2, 2, 2]);
  });

  it("forwards the LEDGER's own stale-generation code, not a transport code", () => {
    const store = activatedStore();
    prepared(store);
    const refusal = refusalOf(() => runGraphEdge(
      edgeFor(store, "graph.release_preparation", "cmd-release-stale", {
        expectedPreparationVersion: 7, generation: 1, goalRef: GOAL_ID,
      }),
    ));
    expect(refusal.code).toBe("SUPERSESSION_RELEASE_GENERATION_STALE");
    expect(refusal.layer).toBe("SUPERSESSION_PREPARATION");
    expect(refusal.detail).toBe("SUPERSESSION_PREPARATION_LEDGER");
  });
});

describe("graph.supersede delegates to the replacement service (task-931f99e8)", () => {
  function supersedePayload(store: SqliteEventStore): Record<string, unknown> {
    const fence = currentPreparationFence(store);
    return {
      command: approvalCommand(),
      expectedPredecessorRevisionRef: GRAPH_REVISION_REF,
      expectedPreparationVersion: fence.expectedPreparationVersion,
      generation: fence.generation,
      goalRef: GOAL_ID,
      record: approvalRecord(SEALED_SUBMISSION_HASH),
      successorGraphContentHash: SUCCESSOR_GRAPH_CONTENT_HASH,
      successorRevisionRef: SUCCESSOR_REVISION_REF,
    };
  }

  it("ACCEPTED CONTROL: the successor replaces the predecessor in one decision", () => {
    const store = supersedableStore();
    const before = decisionCount(store);
    const decided = runGraphEdge(
      edgeFor(store, "graph.supersede", "cmd-supersede-1", supersedePayload(store)),
    );
    expect(decided.disposition).toBe("DECIDED");
    expect(decisionCount(store)).toBe(before + 1);
  });

  it("REPLAYS the same bytes with no second decision row", () => {
    const store = supersedableStore();
    const payload = supersedePayload(store);
    const first = runGraphEdge(edgeFor(store, "graph.supersede", "cmd-supersede-1", payload));
    const decisions = decisionCount(store);

    const again = runGraphEdge(edgeFor(store, "graph.supersede", "cmd-supersede-1", payload));

    expect(again.disposition).toBe("REPLAYED");
    expect(again.effectId).toBe(first.effectId);
    expect(decisionCount(store)).toBe(decisions);
  });

  it("refuses an approval whose ACTOR is not the authenticated principal, at the ingress", () => {
    const store = supersedableStore();
    const before = decisionCount(store);
    const refusal = refusalOf(() => runGraphEdge(edgeFor(
      store, "graph.supersede", "cmd-supersede-foreign",
      { ...supersedePayload(store), record: { ...approvalRecord(SEALED_SUBMISSION_HASH),
        actor: "someone-else" } },
    )));
    expect(refusal.code).toBe("BOOTSTRAP_APPROVAL_ACTOR_UNBOUND");
    expect(refusal.layer).toBe("DAEMON_INGRESS");
    expect(refusal.detail).toBe("DAEMON_GRAPH_INGRESS");
    expect(decisionCount(store)).toBe(before);
  });

  it("forwards the SERVICE's own predecessor code when the request names a stale revision", () => {
    const store = supersedableStore();
    const before = decisionCount(store);
    const refusal = refusalOf(() => runGraphEdge(edgeFor(
      store, "graph.supersede", "cmd-supersede-stale",
      { ...supersedePayload(store), expectedPredecessorRevisionRef: "graph-revision-999" },
    )));
    expect(refusal.code).toBe("GRAPH_SUPERSEDE_PREDECESSOR_MISMATCH");
    expect(decisionCount(store)).toBe(before);
  });
});

describe("graph.approve delegates to the atomic transition service (task-931f99e8)", () => {
  it("ACCEPTED CONTROL: the approved graph becomes the active one", () => {
    const store = approvableStore();
    const before = decisionCount(store);
    const decided = runGraphEdge(
      edgeFor(store, "graph.approve", "cmd-graph-approve-1", approvePayload()),
    );
    expect(decided.disposition).toBe("DECIDED");
    expect(decided.resultCode).toBe("EFFECTS_COMMITTED");
    expect(decisionCount(store)).toBe(before + 1);
  });

  it("REPLAYS the same bytes with no second decision row", () => {
    const store = approvableStore();
    const first = runGraphEdge(
      edgeFor(store, "graph.approve", "cmd-graph-approve-1", approvePayload()),
    );
    const decisions = decisionCount(store);

    const again = runGraphEdge(
      edgeFor(store, "graph.approve", "cmd-graph-approve-1", approvePayload()),
    );

    expect(again.disposition).toBe("REPLAYED");
    expect(again.effectId).toBe(first.effectId);
    expect(decisionCount(store)).toBe(decisions);
  });

  it("refuses an approval record whose actor is not the authenticated principal", () => {
    const store = approvableStore();
    const before = decisionCount(store);
    const refusal = refusalOf(() => runGraphEdge(edgeFor(
      store, "graph.approve", "cmd-graph-approve-foreign",
      { ...approvePayload(), record: { ...approvalRecord(SEALED_SUBMISSION_HASH),
        actor: "someone-else" } },
    )));
    expect(refusal.code).toBe("BOOTSTRAP_APPROVAL_ACTOR_UNBOUND");
    expect(refusal.layer).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses a run the ledger never committed as a MISSING prerequisite, not a hash drift", () => {
    const store = approvableStore();
    const before = decisionCount(store);
    const refusal = refusalOf(() => runGraphEdge(edgeFor(
      store, "graph.approve", "cmd-graph-approve-unknown-run",
      { ...approvePayload(), runId: "run-never" },
    )));
    expect(refusal.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
    expect(refusal.layer).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
  });
});

describe("graph.request_expansion fails closed on its release authority (task-931f99e8)", () => {
  it("refuses with the SERVICE's own unavailable code under the production default", () => {
    const store = activatedStore();
    const before = decisionCount(store);
    const refusal = refusalOf(() => runGraphEdge(
      edgeFor(store, "graph.request_expansion", "cmd-expansion-1", {
        goalRef: GOAL_ID, parentNodeRef: "node-a", parentRunRef: RUN_ID,
        rationale: "the parent needs a sub-plan",
      }),
    ));
    // task-738a12a8's deliberate production-safe default: no durable release reader exists yet,
    // so the request cannot be honoured and nothing is committed.
    expect(refusal.code).toBe("EXPANSION_REQUEST_RELEASE_AUTHORITY_UNAVAILABLE");
    expect(refusal.detail.startsWith("EXPANSION_REQUEST_SERVICE")).toBe(true);
    expect(decisionCount(store)).toBe(before);
  });

  it("forwards the payload codec's own refusal for an incomplete intent", () => {
    const store = activatedStore();
    const before = decisionCount(store);
    const refusal = refusalOf(() => runGraphEdge(
      edgeFor(store, "graph.request_expansion", "cmd-expansion-bad", { goalRef: GOAL_ID }),
    ));
    expect(refusal.code).toBe("EXPANSION_REQUEST_PAYLOAD_MALFORMED");
    expect(refusal.layer).toBe("REQUEST");
    expect(decisionCount(store)).toBe(before);
  });
});
