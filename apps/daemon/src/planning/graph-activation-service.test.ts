/**
 * The accepted control for the atomic active-graph transition (task-eacea969), plus the replay
 * and conflict semantics its DoD 3 names.
 *
 * WHY THE ACCEPTED CONTROL IS THE ARM MOST WORTH DISTRUSTING. It is trivial to make one green by
 * seeding a graph revision by hand and asserting it is there. Every fact this file reads back is
 * therefore produced by a PRODUCTION writer: the run and its sealed body by the shipped bootstrap
 * sequence, the revision by `reduceGraphRevision` inside the service, and the read by
 * `readCurrentActiveGraph` — the same projection any consumer will use. Nothing in the fixture
 * commits a graph-revision event.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_ID,
  GRAPH_REVISION_REF,
  PROJECT_ID,
  SEALED_GRAPH_CONTENT_HASH,
  decisionCount,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import { activateApprovedGraph } from "./graph-activation-service.js";
import {
  activationWitness,
  approvableStore,
  closeStores,
  contextFor,
  inputFor,
  requestFor,
} from "./graph-activation-test-fixtures.js";
import { readGraphBody } from "./graph-body-record.js";

const decoder = new TextDecoder();

afterEach(() => {
  closeStores();
});

const REVISION_AGGREGATE = `graph-revision:${PROJECT_ID}:${GRAPH_REVISION_REF}`;

/** The four lifecycle events an initial activation writes, in the order the reducer emits them. */
const INITIAL_ACTIVATION_EVENT_TYPES = Object.freeze([
  "GraphRevisionCreated",
  "GraphRevisionSubmitted",
  "GraphRevisionApproved",
  "GraphRevisionActivated",
] as const);

describe("activateApprovedGraph commits one ACTIVE revision at epoch 1 (task-eacea969)", () => {
  it("ACCEPTED CONTROL: the projection answers with the run's own sealed content at epoch 1", () => {
    const store = approvableStore();
    // Nothing has ever written this aggregate: the service is about to be its whole history.
    expect(store.readEvents(REVISION_AGGREGATE)).toHaveLength(0);
    expect(readCurrentActiveGraph(store, PROJECT_ID).ok).toBe(false);

    const request = requestFor("cmd-activate-1");
    const outcome = activateApprovedGraph(contextFor(store, request), inputFor(store));

    expect(outcome.ok, outcome.ok ? "" : `${outcome.code}/${outcome.refusedBy}`).toBe(true);
    if (!outcome.ok) throw new Error("expected an accepted activation");
    expect(outcome.authority).toBe("DURABLE_DECISION");
    expect(outcome.disposition).toBe("DECIDED");

    // THE CONSUMER'S OWN READ, not a re-derivation. Until this row it could never answer for a
    // project whose graph was written by a command rather than by a fixture.
    const active = readCurrentActiveGraph(store, PROJECT_ID);
    expect(active.ok, active.ok ? "" : `${active.code}/${active.sourceCode ?? "-"}`).toBe(true);
    if (!active.ok) throw new Error("expected an active graph");
    expect(active.graphEpoch).toBe(1);
    expect(active.revisionId).toBe(GRAPH_REVISION_REF);
    expect(active.graphContentHash).toBe(SEALED_GRAPH_CONTENT_HASH);
    expect(active.provenance.goalRef).toBe(GOAL_ID);
  });

  it("writes exactly the four lifecycle events, on one aggregate, in reducer order", () => {
    const store = approvableStore();

    expect(activateApprovedGraph(contextFor(store, requestFor("cmd-activate-1")), inputFor(store))
      .ok).toBe(true);

    const events = store.readEvents(REVISION_AGGREGATE);
    expect(events.map((event) => event.eventType))
      .toStrictEqual([...INITIAL_ACTIVATION_EVENT_TYPES]);
    expect(store.getAggregateVersion(REVISION_AGGREGATE)).toBe(4);
    // The GOAL is the primary leg and its own activation event rides the same decision.
    expect(store.readEvents(GOAL_ID).filter((row) => row.eventType === "GoalExecutionEnabled"))
      .toHaveLength(1);
    expect(decisionCount(store)).toBeGreaterThan(0);
  });

  it("binds the RECOMPUTED content hash and never the structural snapshotIdentity", () => {
    const store = approvableStore();

    expect(activateApprovedGraph(contextFor(store, requestFor("cmd-activate-1")), inputFor(store))
      .ok).toBe(true);

    const body = readGraphBody(store, PROJECT_ID, SEALED_GRAPH_CONTENT_HASH);
    if (!body.ok) throw new Error(`fixture body unreadable: ${body.code}`);
    const activated = store.readEvents(REVISION_AGGREGATE)
      .find((event) => event.eventType === "GraphRevisionActivated");
    if (activated === undefined) throw new Error("no activation event");
    const witness = (JSON.parse(decoder.decode(activated.payload)) as {
      witness: Record<string, unknown>;
    }).witness;
    expect(witness["graphHash"]).toBe(SEALED_GRAPH_CONTENT_HASH);
    expect(witness["graphEpoch"]).toBe(1);
    // dec-64b2391c option A, asserted rather than argued: the two are both 64-hex on one object,
    // which is exactly why a name-grep cannot catch the substitution.
    expect(body.snapshotIdentity).not.toBe(SEALED_GRAPH_CONTENT_HASH);
    expect(witness["graphHash"]).not.toBe(body.snapshotIdentity);
  });

  it("records the whole server-composed binding on the goal's durable event", () => {
    const store = approvableStore();

    expect(activateApprovedGraph(contextFor(store, requestFor("cmd-activate-1")), inputFor(store))
      .ok).toBe(true);

    const [enabled] = store.readEvents(GOAL_ID)
      .filter((row) => row.eventType === "GoalExecutionEnabled");
    if (enabled === undefined) throw new Error("no goal activation event");
    const payload = JSON.parse(decoder.decode(enabled.payload)) as {
      activation: Record<string, unknown>;
    };
    const binding = payload.activation["graphActivationBinding"] as Record<string, unknown>;
    expect(Object.keys(binding).sort()).toStrictEqual([
      "budgetHash", "expectedGoalVersion", "graphHash", "policyHash", "qualityHash",
    ]);
    expect(binding["graphHash"]).toBe(SEALED_GRAPH_CONTENT_HASH);
    expect(binding["expectedGoalVersion"]).toBe(1);
    for (const key of ["budgetHash", "policyHash", "qualityHash"]) {
      expect(binding[key], key).toMatch(/^[0-9a-f]{64}$/u);
    }
    // The request stated none of them, so none of them can have been passed through.
    for (const key of Object.keys(binding)) {
      if (key !== "expectedGoalVersion") expect(activationWitness()).not.toHaveProperty(key);
    }
  });
});

describe("replay and conflict leave the durable record exactly where it was", () => {
  it("SAME BYTES replay: the original decision, and NO new event or decision row", () => {
    const store = approvableStore();
    const request = requestFor("cmd-activate-1");
    const first = activateApprovedGraph(contextFor(store, request), inputFor(store));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected an accepted activation");
    const horizonAfterFirst = store.readEventHorizon();
    const decisionsAfterFirst = decisionCount(store);

    const replayed = activateApprovedGraph(contextFor(store, request), inputFor(store));

    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error("expected a replayed activation");
    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.decision.decisionId).toBe(first.decision.decisionId);
    // COUNTS, not just the returned value: a second event is invisible to a return-value check.
    expect(store.readEventHorizon()).toBe(horizonAfterFirst);
    expect(decisionCount(store)).toBe(decisionsAfterFirst);
    expect(store.getAggregateVersion(REVISION_AGGREGATE)).toBe(4);
  });

  it("CHANGED BYTES under one decision identity refuse rather than echo the first decision", () => {
    const store = approvableStore();
    const request = requestFor("cmd-activate-1");
    expect(activateApprovedGraph(contextFor(store, request), inputFor(store)).ok).toBe(true);
    const horizon = store.readEventHorizon();

    const drifted = activateApprovedGraph(
      contextFor(store, requestFor("cmd-activate-1", { drifted: true })),
      inputFor(store),
    );

    expect(drifted.ok).toBe(false);
    if (drifted.ok) throw new Error("expected a refusal");
    expect(drifted.code).toBe("BOOTSTRAP_COMMAND_BYTES_CONFLICT");
    expect(drifted.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(store.readEventHorizon()).toBe(horizon);
  });

  it("CONCURRENT activation: the loser fails on a fence and writes nothing", () => {
    const store = approvableStore();
    // Both contexts are built BEFORE either commits, so both hold the same pre-activation fences.
    const first = contextFor(store, requestFor("cmd-activate-1"));
    const second = contextFor(store, requestFor("cmd-activate-2"));
    const firstInput = inputFor(store);
    const secondInput = inputFor(store);

    const winner = activateApprovedGraph(first, firstInput);
    const loser = activateApprovedGraph(second, secondInput);

    expect(winner.ok).toBe(true);
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("expected the second activation to lose");
    // The revision aggregate is the second leg's fence and the goal is the first's; whichever
    // answers, the loser must not have advanced either.
    expect(store.getAggregateVersion(REVISION_AGGREGATE)).toBe(4);
    expect(store.readEvents(GOAL_ID).filter((row) => row.eventType === "GoalExecutionEnabled"))
      .toHaveLength(1);
    expect(readCurrentActiveGraph(store, PROJECT_ID).ok).toBe(true);
  });
});
